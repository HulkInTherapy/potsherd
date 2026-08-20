import { claudeDir, claudePaths, tildify } from './paths.js';
import { scanClaudeDisk, type DiskScan, type ScannedFile } from './claude/scan.js';
import { readHistory, type HistoryScan } from './claude/history.js';
import { readSessionsIndexes, type SessionIndexScan } from './claude/sessions-index.js';
import { readCleanupStatus, CLAUDE_DEFAULT_CLEANUP_DAYS, type CleanupStatus } from './claude/settings.js';
import { readArchiveState, type ArchiveState } from './archive-state.js';

/**
 * `potsherd audit` — the first command, and the only one most people will ever
 * run. It reads. It never writes. It takes under two seconds on 345 MB.
 *
 * The four headline numbers, and exactly how each is defined (the readme
 * repeats these definitions verbatim, and `scripts/verify-audit.py` recomputes
 * them without potsherd so nobody has to trust potsherd to check potsherd):
 *
 *   sessions ever started  distinct session ids seen in ANY of history.jsonl,
 *                          the transcripts on disk, or sessions-index.json.
 *   still on disk          of those, the ones with a transcript file today.
 *   deleted                ever - on disk.
 *   prompts lost           lines in history.jsonl whose sessionId is deleted.
 *
 * Using the union rather than history alone matters: SDK-driven sessions
 * (`entrypoint: sdk-ts`) never write to history.jsonl, so a history-only count
 * silently omits them. Both figures are in `--json`.
 */

const DAY_MS = 86_400_000;

export interface WipedProject {
  project: string;
  name: string;
  sessions: number;
  prompts: number;
  lastTs: number | null;
}

export interface DoomedSession {
  id: string;
  title: string | null;
  project: string;
  daysLeft: number;
  bytes: number;
  mtime: string;
}

export interface AuditReport {
  measuredAt: string;
  claudeDir: string;
  claudeDirExists: boolean;

  sessionsEver: number;
  onDisk: number;
  deleted: number;
  promptsLost: number;
  promptsSurviving: number;

  /** History-only view, for cross-checking against the published one-liner. */
  historySessions: number;
  historyOnDisk: number;
  historyPrompts: number;
  historyFirstTs: string | null;
  historyLastTs: string | null;

  projectsWiped: WipedProject[];
  projectsWithSessions: number;
  projectDirs: number;

  /** Every session on disk, soonest deletion first. `--json` and `--sweep`. */
  nextSweep: DoomedSession[];
  /** The headline count: how many the sweep takes within a week. */
  nextSweepWithin7Days: number;
  nextSweepWithinOneDay: number;
  cleanupPeriodDays: number | null;
  cleanupPeriodEffective: number;
  cleanupPeriodSource: string;
  cleanupEditable: boolean;
  cleanupReason?: string;

  onDiskFiles: number;
  sidechainFiles: number;
  bytes: number;
  sdkSessions: number;
  titledSessions: number;
  memoryFiles: number;
  sessionsIndexFiles: number;

  /**
   * What potsherd has already rescued, read from ~/.potsherd read-only. Null
   * before the first rescue. `audit` still writes nothing: it opens the
   * database only if the file is already there, and only for reading.
   */
  archive: ArchiveState | null;

  /** Every record `type` seen in the head/tail windows, with counts. */
  recordTypes: Record<string, number>;

  /** Everything the run read, for `doctor --privacy` and the honesty contract. */
  pathsRead: string[];
  timings: { scanMs: number; historyMs: number; totalMs: number };
  warnings: string[];
}

export interface AuditInput {
  disk: DiskScan;
  history: HistoryScan;
  index: SessionIndexScan;
  cleanup: CleanupStatus;
  archive: ArchiveState | null;
  claudeDir: string;
  now: Date;
}

export interface AuditOptions {
  /** Overrides ~/.potsherd when looking for what has already been rescued. */
  potsherdDir?: string;
}

export async function collectAudit(
  dir?: string,
  now = new Date(),
  opts: AuditOptions = {},
): Promise<AuditInput> {
  const root = claudeDir(dir);
  const disk = scanClaudeDisk(root, { titles: true });
  const history = await readHistory(root);
  const index = readSessionsIndexes(root);
  const cleanup = readCleanupStatus(root);
  const archive = readArchiveState(opts.potsherdDir);
  return { disk, history, index, cleanup, archive, claudeDir: root, now };
}

export async function audit(
  dir?: string,
  now = new Date(),
  opts: AuditOptions = {},
): Promise<AuditReport> {
  const started = Date.now();
  const input = await collectAudit(dir, now, opts);
  const report = computeAudit(input);
  report.timings.totalMs = Date.now() - started;
  return report;
}

export function computeAudit(input: AuditInput): AuditReport {
  const { disk, history, index, cleanup, archive, claudeDir: root, now } = input;
  const cp = claudePaths(root);
  const warnings: string[] = [];

  const onDiskIds = new Set(disk.sessions.map((s) => s.sessionId));
  const everIds = new Set<string>(onDiskIds);
  for (const id of history.sessions.keys()) everIds.add(id);
  for (const [id, e] of index.entries) if (!e.isSidechain) everIds.add(id);

  const deletedIds = new Set<string>();
  for (const id of everIds) if (!onDiskIds.has(id)) deletedIds.add(id);

  let promptsLost = 0;
  let promptsSurviving = 0;
  for (const [id, sess] of history.sessions) {
    if (deletedIds.has(id)) promptsLost += sess.promptCount;
    else promptsSurviving += sess.promptCount;
  }

  // A project is "wiped entirely" when every session it ever had is gone.
  const byProject = new Map<string, { total: number; alive: number; prompts: number; lastTs: number | null }>();
  const projectOfSession = new Map<string, string>();
  for (const [id, sess] of history.sessions) {
    const proj = sess.project || 'unknown';
    projectOfSession.set(id, proj);
    const agg = byProject.get(proj) ?? { total: 0, alive: 0, prompts: 0, lastTs: null };
    agg.total++;
    if (onDiskIds.has(id)) agg.alive++;
    else agg.prompts += sess.promptCount;
    if (sess.lastTs && (agg.lastTs === null || sess.lastTs > agg.lastTs)) agg.lastTs = sess.lastTs;
    byProject.set(proj, agg);
  }
  for (const s of disk.sessions) {
    const proj = s.project;
    const agg = byProject.get(proj) ?? { total: 0, alive: 0, prompts: 0, lastTs: null };
    if (!projectOfSession.has(s.sessionId)) agg.total++;
    agg.alive++;
    byProject.set(proj, agg);
  }

  const projectsWiped = rollUpWipedProjects(byProject);

  // Days until the sweep takes each surviving transcript. Claude Code compares
  // the file's mtime, not its creation date, so a resumed session resets it.
  const period = cleanup.effective;
  const nextSweep: DoomedSession[] = disk.sessions
    .map((s) => ({
      id: s.sessionId,
      title: s.title,
      project: s.project,
      daysLeft: period - Math.floor((now.getTime() - s.mtime.getTime()) / DAY_MS),
      bytes: s.bytes,
      mtime: s.mtime.toISOString(),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  if (!disk.exists) warnings.push(`no projects directory at ${cp.projects}`);
  if (!history.exists) warnings.push(`no history.jsonl at ${cp.history} — ghosts cannot be rebuilt`);
  if (history.malformed > 0) {
    const n = history.malformed;
    warnings.push(`${n} malformed ${n === 1 ? 'line' : 'lines'} in history.jsonl (skipped)`);
  }
  for (const bad of index.malformed) warnings.push(`unreadable sessions-index.json: ${bad}`);
  for (const s of [...disk.sessions, ...disk.sidechains]) {
    if (s.error) warnings.push(`unreadable transcript ${s.sourcePath}: ${s.error}`);
  }

  const recordTypes: Record<string, number> = {};
  for (const s of [...disk.sessions, ...disk.sidechains]) {
    for (const [type, n] of Object.entries(s.typesSeen)) {
      recordTypes[type] = (recordTypes[type] ?? 0) + n;
    }
  }

  const pathsRead = [
    cp.projects,
    cp.history,
    ...index.files,
    cleanup.files.user.path,
    cleanup.files.local.path,
    cleanup.files.managed.path,
  ];

  return {
    measuredAt: now.toISOString(),
    claudeDir: root,
    claudeDirExists: disk.exists || history.exists,

    sessionsEver: everIds.size,
    onDisk: onDiskIds.size,
    deleted: deletedIds.size,
    promptsLost,
    promptsSurviving,

    historySessions: history.sessions.size,
    historyOnDisk: [...history.sessions.keys()].filter((id) => onDiskIds.has(id)).length,
    historyPrompts: promptsLost + promptsSurviving,
    historyFirstTs: history.firstTs ? new Date(history.firstTs).toISOString() : null,
    historyLastTs: history.lastTs ? new Date(history.lastTs).toISOString() : null,

    projectsWiped,
    projectsWithSessions: countProjectsWithSessions(disk),
    projectDirs: disk.projects.length,

    nextSweep,
    nextSweepWithin7Days: nextSweep.filter((s) => s.daysLeft <= 7).length,
    nextSweepWithinOneDay: nextSweep.filter((s) => s.daysLeft <= 1).length,
    cleanupPeriodDays: cleanup.declared,
    cleanupPeriodEffective: cleanup.effective,
    cleanupPeriodSource: cleanup.source,
    cleanupEditable: cleanup.editable,
    ...(cleanup.reason ? { cleanupReason: cleanup.reason } : {}),

    onDiskFiles: disk.sessions.length,
    sidechainFiles: disk.sidechains.length,
    bytes: disk.totalBytes,
    sdkSessions: disk.sessions.filter((s) => s.entrypoint === 'sdk-ts').length,
    titledSessions: disk.sessions.filter((s) => Boolean(s.title)).length,
    memoryFiles: disk.projects.reduce((a, p) => a + p.memoryFiles, 0),
    sessionsIndexFiles: index.files.length,

    archive,
    recordTypes,
    pathsRead,
    timings: { scanMs: disk.scanMs, historyMs: history.scanMs, totalMs: 0 },
    warnings,
  };
}

/**
 * "Projects wiped entirely" means a directory you ran an agent in where every
 * session is now gone. Two corrections keep that claim honest:
 *
 *   - a subdirectory of a project that still has a surviving session is not a
 *     wiped project; it is part of a live one. Dropped.
 *   - a wiped subdirectory of a wiped project is the same loss counted twice.
 *     Rolled up into its nearest wiped ancestor.
 *
 * Without these the count inflates with every `cd` into a subfolder, which is
 * exactly the kind of number this tool must never print.
 */
function rollUpWipedProjects(
  byProject: Map<string, { total: number; alive: number; prompts: number; lastTs: number | null }>,
): WipedProject[] {
  const alive: string[] = [];
  const wiped: string[] = [];
  for (const [project, agg] of byProject) {
    if (agg.total === 0) continue;
    (agg.alive > 0 ? alive : wiped).push(project);
  }
  const isUnder = (child: string, parent: string) =>
    child !== parent && child.startsWith(parent.endsWith('/') ? parent : parent + '/');

  // A directory that holds several other project directories is a container,
  // not a project that contains them: $HOME, ~/Downloads, ~/src. Running one
  // session in $HOME must not make every project on the machine "part of" it.
  const all = [...alive, ...wiped];
  const isContainer = (p: string) => all.filter((o) => isUnder(o, p)).length >= 2;
  const shields = alive.filter((a) => !isContainer(a));
  const parents = wiped.filter((w) => !isContainer(w));

  const merged = new Map<string, WipedProject>();
  for (const project of wiped) {
    if (shields.some((a) => isUnder(project, a))) continue;
    // Nearest wiped ancestor, if any: the longest wiped path this sits under.
    let owner = project;
    for (const other of parents) {
      if (isUnder(project, other) && other.length > (owner === project ? 0 : owner.length)) {
        owner = other;
      }
    }
    const agg = byProject.get(project)!;
    const existing = merged.get(owner);
    if (existing) {
      existing.sessions += agg.total;
      existing.prompts += agg.prompts;
      if (agg.lastTs && (existing.lastTs === null || agg.lastTs > existing.lastTs)) {
        existing.lastTs = agg.lastTs;
      }
    } else {
      merged.set(owner, {
        project: owner,
        name: basename(owner),
        sessions: agg.total,
        prompts: agg.prompts,
        lastTs: agg.lastTs,
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name),
  );
}

function countProjectsWithSessions(disk: DiskScan): number {
  const slugs = new Set<string>();
  for (const s of disk.sessions) slugs.add(s.projectSlug);
  return slugs.size;
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export { CLAUDE_DEFAULT_CLEANUP_DAYS, tildify, type ScannedFile };
