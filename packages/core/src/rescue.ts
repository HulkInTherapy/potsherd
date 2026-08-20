import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveDir, claudeDir, claudePaths, potsherdDir } from './paths.js';
import { scanClaudeDisk, SIDECHAIN_DIR } from './claude/scan.js';
import { readHistory } from './claude/history.js';
import { readSessionsIndexes } from './claude/sessions-index.js';
import { open as openDb, type Db } from './db.js';
import { withLockAsync } from './lock.js';

/**
 * `potsherd rescue` — the second command, and the one that stops the bleeding.
 *
 * Three things happen, in this order, and none of them touches ~/.claude:
 *   1. every transcript, sidechain, sessions-index.json and memory/*.md is
 *      copied byte-exact into ~/.potsherd/archive/claude/<slug>/..., skipping
 *      anything whose content hash already matches.
 *   2. every session id in history.jsonl with no transcript on disk becomes a
 *      `ghost`: its prompts, project, timestamps, and (when sessions-index.json
 *      survived) its title and message count.
 *   3. a rescue_log row records what happened.
 *
 * The archive copy is byte-exact and unredacted on purpose: it is the user's
 * own file on the user's own disk. Redaction (phase 1) applies to the index,
 * which is the thing that can leave the machine via a model call.
 *
 * The `cleanupPeriodDays` consent prompt is deliberately NOT here — it is the
 * caller's job (the CLI), so that no library path can ever write to ~/.claude.
 */

export interface RescueOptions {
  claudeDir?: string;
  /** Overrides ~/.potsherd for tests and for `--dest`. */
  root?: string;
  dryRun?: boolean;
  quiet?: boolean;
  /** Skip the archive-copy pass; only rebuild ghosts. */
  ghostsOnly?: boolean;
  onProgress?: (p: RescueProgress) => void;
  now?: Date;
}

export interface RescueProgress {
  phase: 'copy' | 'ghosts';
  done: number;
  total: number;
  label?: string;
}

export interface RescueResult {
  ranAt: string;
  dryRun: boolean;
  claudeDir: string;
  archiveDir: string;

  filesConsidered: number;
  filesCopied: number;
  filesSkipped: number;
  filesFailed: { path: string; error: string }[];
  bytesCopied: number;
  bytesArchived: number;

  sessionsArchived: number;
  /**
   * Session transcripts in the archive after this run, new and unchanged
   * together. The receipt needs it: `sessions archived 0` on a second run is
   * true but reads as an empty archive without the total beside it.
   */
  sessionsInArchive: number;
  sidechainsArchived: number;
  memoryFilesArchived: number;
  sessionIndexesArchived: number;
  /** True when this run took a fresh copy of history.jsonl. */
  historyArchived: boolean;

  ghostsBuilt: number;
  ghostsUpdated: number;
  ghostPrompts: number;
  promptsRecovered: number;
  ghostsWithTitles: number;

  durationMs: number;
  warnings: string[];
}

const HARNESS = 'claude';

export async function rescue(opts: RescueOptions = {}): Promise<RescueResult> {
  const root = opts.root ?? potsherdDir();
  return withLockAsync('rescue', () => rescueUnlocked(opts, root), { root, wait: 10_000 });
}

async function rescueUnlocked(opts: RescueOptions, root: string): Promise<RescueResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const src = claudeDir(opts.claudeDir);
  const cp = claudePaths(src);
  const dest = path.join(archiveDir(root), HARNESS);

  const result: RescueResult = {
    ranAt: now.toISOString(),
    dryRun: Boolean(opts.dryRun),
    claudeDir: src,
    archiveDir: dest,
    filesConsidered: 0,
    filesCopied: 0,
    filesSkipped: 0,
    filesFailed: [],
    bytesCopied: 0,
    bytesArchived: 0,
    sessionsArchived: 0,
    sessionsInArchive: 0,
    sidechainsArchived: 0,
    memoryFilesArchived: 0,
    sessionIndexesArchived: 0,
    historyArchived: false,
    ghostsBuilt: 0,
    ghostsUpdated: 0,
    ghostPrompts: 0,
    promptsRecovered: 0,
    ghostsWithTitles: 0,
    durationMs: 0,
    warnings: [],
  };

  // rescue needs the session *ids* (which are filenames) and nothing that
  // lives inside the transcripts, so the scan reads no file contents at all.
  // Opening 234 files and reading 128 KB out of each was most of the
  // SessionStart hook's wall time and bought this command nothing.
  const disk = scanClaudeDisk(src, { titles: false, content: false });
  if (!disk.exists) {
    result.warnings.push(`no projects directory at ${cp.projects}`);
  }

  const db = opts.dryRun ? openDb({ root, file: ':memory:' }) : openDb({ root });
  try {
    if (!opts.ghostsOnly) {
      copyPass(db, disk.projectsDir, cp.history, dest, result, opts);
    }
    await ghostPass(db, src, disk, result, opts);

    if (!opts.dryRun) {
      db.prepare(
        `INSERT INTO rescue_log (ran_at, harness, sessions_copied, files_copied, files_skipped,
           ghosts_built, prompts_recovered, bytes, duration_ms, settings_changed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        result.ranAt,
        HARNESS,
        result.sessionsArchived,
        result.filesCopied,
        result.filesSkipped,
        result.ghostsBuilt,
        result.promptsRecovered,
        result.bytesCopied,
        Date.now() - started,
        null,
      );
    }
  } finally {
    db.close();
  }

  result.durationMs = Date.now() - started;
  return result;
}

/** Everything under projects/ that is worth keeping, copied with dedupe by hash. */
function copyPass(
  db: Db,
  projectsDir: string,
  historyPath: string,
  dest: string,
  result: RescueResult,
  opts: RescueOptions,
): void {
  const files = collectSourceFiles(projectsDir);

  // history.jsonl is archived too, and it matters more than any single
  // transcript: it is the only surviving record of the 299 sessions the sweep
  // already took, and nothing else can rebuild them if it is ever rotated.
  if (fs.existsSync(historyPath)) {
    files.unshift({ abs: historyPath, rel: 'history.jsonl', kind: 'history' });
  }
  if (files.length === 0) return;
  const known = new Map<string, { sha256: string; bytes: number; source_mtime: number }>();
  for (const row of db
    .prepare('SELECT source_path, sha256, bytes, source_mtime FROM archive_files')
    .all() as { source_path: string; sha256: string; bytes: number; source_mtime: number }[]) {
    known.set(row.source_path, row);
  }

  const upsert = db.prepare(
    `INSERT INTO archive_files (source_path, archive_path, sha256, bytes, source_mtime, copied_at, harness)
     VALUES (@source_path, @archive_path, @sha256, @bytes, @source_mtime, @copied_at, @harness)
     ON CONFLICT(source_path) DO UPDATE SET
       archive_path = excluded.archive_path, sha256 = excluded.sha256, bytes = excluded.bytes,
       source_mtime = excluded.source_mtime, copied_at = excluded.copied_at`,
  );

  let done = 0;
  for (const f of files) {
    result.filesConsidered++;
    done++;
    opts.onProgress?.({ phase: 'copy', done, total: files.length, label: path.basename(f.rel) });

    const target = path.join(dest, f.rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(f.abs);
    } catch (err) {
      result.filesFailed.push({ path: f.abs, error: (err as Error).message });
      continue;
    }
    result.bytesArchived += stat.size;

    // Fast path: same size and mtime as the last copy we recorded, and the
    // archive copy is still there. Hashing 345 MB on every SessionStart hook
    // would blow the one-second budget; this makes the no-change path a stat.
    const prev = known.get(f.abs);
    if (
      prev &&
      prev.bytes === stat.size &&
      prev.source_mtime === Math.floor(stat.mtimeMs) &&
      fs.existsSync(target)
    ) {
      result.filesSkipped++;
      countKind(result, f.kind, false);
      continue;
    }

    let sha: string;
    try {
      sha = sha256File(f.abs);
    } catch (err) {
      result.filesFailed.push({ path: f.abs, error: (err as Error).message });
      continue;
    }

    if (fs.existsSync(target) && safeSize(target) === stat.size && sha256File(target) === sha) {
      result.filesSkipped++;
      countKind(result, f.kind, false);
      if (!opts.dryRun) {
        upsert.run({
          source_path: f.abs,
          archive_path: target,
          sha256: sha,
          bytes: stat.size,
          source_mtime: Math.floor(stat.mtimeMs),
          copied_at: result.ranAt,
          harness: HARNESS,
        });
      }
      continue;
    }

    if (!opts.dryRun) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        // Copy to a temp name and rename, so a killed rescue never leaves a
        // half-written archive file that a later run would trust.
        const tmp = `${target}.potsherd-tmp`;
        fs.copyFileSync(f.abs, tmp);
        fs.chmodSync(tmp, 0o600);
        fs.utimesSync(tmp, stat.atime, stat.mtime);
        fs.renameSync(tmp, target);
        upsert.run({
          source_path: f.abs,
          archive_path: target,
          sha256: sha,
          bytes: stat.size,
          source_mtime: Math.floor(stat.mtimeMs),
          copied_at: result.ranAt,
          harness: HARNESS,
        });
      } catch (err) {
        result.filesFailed.push({ path: f.abs, error: (err as Error).message });
        continue;
      }
    }
    result.filesCopied++;
    result.bytesCopied += stat.size;
    countKind(result, f.kind, true);
  }
}

type SourceKind = 'session' | 'sidechain' | 'memory' | 'index' | 'history' | 'other';

interface SourceFile {
  abs: string;
  rel: string;
  kind: SourceKind;
}

function collectSourceFiles(projectsDir: string): SourceFile[] {
  const out: SourceFile[] = [];
  const slugs = readdirSafe(projectsDir, true);
  for (const slugEntry of slugs) {
    if (!slugEntry.isDirectory()) continue;
    const slug = slugEntry.name;
    const dir = path.join(projectsDir, slug);
    for (const e of readdirSafe(dir, true)) {
      if (e.isFile()) {
        if (e.name.endsWith('.jsonl')) {
          out.push({ abs: path.join(dir, e.name), rel: path.join(slug, e.name), kind: 'session' });
        } else if (e.name === 'sessions-index.json') {
          out.push({ abs: path.join(dir, e.name), rel: path.join(slug, e.name), kind: 'index' });
        }
      } else if (e.isDirectory()) {
        if (e.name === 'memory') {
          for (const m of readdirSafe(path.join(dir, 'memory'))) {
            out.push({
              abs: path.join(dir, 'memory', m),
              rel: path.join(slug, 'memory', m),
              kind: 'memory',
            });
          }
        } else {
          // Both observed sidechain layouts: <slug>/<session>/subagents/… and
          // <slug>/subagents/…. Archiving one and not the other would leave
          // half the subagent transcripts to the sweep.
          const nested = e.name === SIDECHAIN_DIR;
          const subDir = nested ? path.join(dir, e.name) : path.join(dir, e.name, SIDECHAIN_DIR);
          const relDir = nested ? path.join(slug, e.name) : path.join(slug, e.name, SIDECHAIN_DIR);
          for (const s of readdirSafe(subDir)) {
            if (!s.endsWith('.jsonl')) continue;
            out.push({
              abs: path.join(subDir, s),
              rel: path.join(relDir, s),
              kind: 'sidechain',
            });
          }
        }
      }
    }
  }
  return out;
}

function countKind(result: RescueResult, kind: SourceKind, copied: boolean): void {
  // Totals are counted whether or not this run had to copy the file: a
  // transcript that was already byte-identical is still in the archive.
  if (kind === 'session') result.sessionsInArchive++;
  if (!copied) return;
  if (kind === 'session') result.sessionsArchived++;
  else if (kind === 'sidechain') result.sidechainsArchived++;
  else if (kind === 'memory') result.memoryFilesArchived++;
  else if (kind === 'index') result.sessionIndexesArchived++;
  else if (kind === 'history') result.historyArchived = true;
}

/**
 * A fingerprint of every input the ghost rebuild reads. If it is unchanged
 * since the last rescue, no ghost can have changed either, and the whole pass
 * — streaming history.jsonl and re-writing several thousand ghost_prompts rows
 * — can be skipped. The guard hook runs this at every Claude Code startup, so
 * the unchanged case is the common case.
 *
 * The inputs are exactly the three things `ghostPass` consults:
 *   - history.jsonl's size and mtime (its content is the prompts)
 *   - which session ids have a transcript on disk (a deletion makes a ghost)
 *   - every sessions-index.json's size and mtime (they carry ghost titles)
 * Anything that could change a ghost changes this string. A stale fingerprint
 * can therefore only ever cost work, never correctness.
 */
function ghostFingerprint(
  historyPath: string,
  disk: { sessions: { sessionId: string }[]; projects?: { dir: string; hasSessionsIndex: boolean }[] },
): string | null {
  let hs: fs.Stats;
  try {
    hs = fs.statSync(historyPath);
  } catch {
    return null; // no history.jsonl: always take the slow path, and warn.
  }
  const parts = [`history:${hs.size}:${Math.floor(hs.mtimeMs)}`];
  const ids = disk.sessions.map((s) => s.sessionId).sort();
  parts.push(`sessions:${ids.length}:${crypto.createHash('sha256').update(ids.join('\n')).digest('hex')}`);
  for (const proj of (disk.projects ?? []).filter((p) => p.hasSessionsIndex)) {
    const p = path.join(proj.dir, 'sessions-index.json');
    try {
      const st = fs.statSync(p);
      parts.push(`index:${p}:${st.size}:${Math.floor(st.mtimeMs)}`);
    } catch {
      parts.push(`index:${p}:gone`);
    }
  }
  return crypto.createHash('sha256').update(parts.sort().join('\n')).digest('hex');
}

const GHOST_FINGERPRINT_KEY = 'claude:ghosts';

/** What the ghosts already in the database add up to, without rebuilding them. */
function ghostTotals(db: Db): {
  ghosts: number;
  prompts: number;
  promptRows: number;
  withTitles: number;
} {
  const g = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(prompt_count), 0) AS prompts,
              COALESCE(SUM(title IS NOT NULL), 0) AS titled FROM ghosts`,
    )
    .get() as { n: number; prompts: number; titled: number };
  const rows = db.prepare('SELECT COUNT(*) AS n FROM ghost_prompts').get() as { n: number };
  return { ghosts: g.n, prompts: g.prompts, promptRows: rows.n, withTitles: g.titled };
}

/** Rebuild every deleted session from the prompts that outlived it. */
async function ghostPass(
  db: Db,
  src: string,
  disk: { sessions: { sessionId: string }[]; projects?: { dir: string; hasSessionsIndex: boolean }[] },
  result: RescueResult,
  opts: RescueOptions,
): Promise<void> {
  // The fast path. It reports the same totals the slow path would, read out of
  // the database, so the receipt says "3 in the archive, none new" rather than
  // pretending this run found nothing.
  const fingerprint = opts.dryRun ? null : ghostFingerprint(claudePaths(src).history, disk);
  if (fingerprint) {
    const seen = db
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(GHOST_FINGERPRINT_KEY) as { value: string } | undefined;
    const totals = ghostTotals(db);
    if (seen?.value === fingerprint && totals.ghosts > 0) {
      result.ghostsUpdated = totals.ghosts;
      result.promptsRecovered = totals.prompts;
      result.ghostPrompts = totals.promptRows;
      result.ghostsWithTitles = totals.withTitles;
      return;
    }
  }

  const history = await readHistory(src, { withPrompts: true });
  if (!history.exists) {
    result.warnings.push('no history.jsonl — nothing to rebuild ghosts from');
    return;
  }
  const index = readSessionsIndexes(src);
  const onDisk = new Set(disk.sessions.map((s) => s.sessionId));

  const existing = new Map<string, number>();
  for (const row of db.prepare('SELECT session_id, prompt_count FROM ghosts').all() as {
    session_id: string;
    prompt_count: number;
  }[]) {
    existing.set(row.session_id, row.prompt_count);
  }

  const upsertGhost = db.prepare(
    `INSERT INTO ghosts (session_id, harness, project, first_ts, last_ts, prompt_count,
        first_prompt, title, message_count, git_branch, source)
     VALUES (@session_id, @harness, @project, @first_ts, @last_ts, @prompt_count,
        @first_prompt, @title, @message_count, @git_branch, @source)
     ON CONFLICT(session_id) DO UPDATE SET
       project = excluded.project, first_ts = excluded.first_ts, last_ts = excluded.last_ts,
       prompt_count = excluded.prompt_count, first_prompt = excluded.first_prompt,
       title = COALESCE(excluded.title, ghosts.title),
       message_count = COALESCE(excluded.message_count, ghosts.message_count),
       git_branch = COALESCE(excluded.git_branch, ghosts.git_branch),
       source = excluded.source`,
  );
  const clearPrompts = db.prepare('DELETE FROM ghost_prompts WHERE session_id = ?');
  const insertPrompt = db.prepare(
    `INSERT INTO ghost_prompts (id, session_id, seq, ts, text, redacted)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );

  const ghosts = [...history.sessions.values()].filter((s) => !onDisk.has(s.sessionId));
  let done = 0;

  const run = db.transaction(() => {
    for (const g of ghosts) {
      done++;
      if (done % 25 === 0) {
        opts.onProgress?.({ phase: 'ghosts', done, total: ghosts.length });
      }
      const idx = index.entries.get(g.sessionId);
      const source = idx ? 'both' : 'history';
      const title = idx?.summary ?? null;
      const row = {
        session_id: g.sessionId,
        harness: HARNESS,
        project: g.project || idx?.projectPath || null,
        first_ts: g.firstTs ? new Date(g.firstTs).toISOString() : null,
        last_ts: g.lastTs ? new Date(g.lastTs).toISOString() : null,
        prompt_count: g.promptCount,
        first_prompt: g.firstPrompt || idx?.firstPrompt || null,
        title,
        message_count: idx?.messageCount ?? null,
        git_branch: idx?.gitBranch ?? null,
        source,
      };
      const had = existing.has(g.sessionId);
      if (!opts.dryRun) {
        upsertGhost.run(row);
        clearPrompts.run(g.sessionId);
        let seq = 0;
        for (const p of g.prompts) {
          insertPrompt.run(
            `${g.sessionId}:${seq}`,
            g.sessionId,
            seq,
            p.ts ? new Date(p.ts).toISOString() : null,
            p.text,
          );
          seq++;
        }
      }
      if (had) result.ghostsUpdated++;
      else result.ghostsBuilt++;
      if (title) result.ghostsWithTitles++;
      result.ghostPrompts += g.prompts.length;
      result.promptsRecovered += g.promptCount;
    }
  });
  run();

  // Ghosts that exist only in sessions-index.json (deleted before history.jsonl
  // ever saw them, or written by a harness version that did not log prompts).
  if (!opts.dryRun) {
    const orphanRun = db.transaction(() => {
      for (const [id, e] of index.entries) {
        if (onDisk.has(id) || history.sessions.has(id) || e.isSidechain) continue;
        upsertGhost.run({
          session_id: id,
          harness: HARNESS,
          project: e.projectPath ?? null,
          first_ts: e.created ?? null,
          last_ts: e.modified ?? null,
          prompt_count: 0,
          first_prompt: e.firstPrompt ?? null,
          title: e.summary ?? null,
          message_count: e.messageCount ?? null,
          git_branch: e.gitBranch ?? null,
          source: 'sessions-index',
        });
        if (existing.has(id)) result.ghostsUpdated++;
        else result.ghostsBuilt++;
        if (e.summary) result.ghostsWithTitles++;
      }
    });
    orphanRun();

    if (fingerprint) {
      db.prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(GHOST_FINGERPRINT_KEY, fingerprint, result.ranAt);
    }
  }
}

export function sha256File(p: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

function readdirSafe(dir: string): string[];
function readdirSafe(dir: string, withTypes: true): fs.Dirent[];
function readdirSafe(dir: string, withTypes?: true): string[] | fs.Dirent[] {
  try {
    return withTypes ? fs.readdirSync(dir, { withFileTypes: true }) : fs.readdirSync(dir);
  } catch {
    return [];
  }
}
