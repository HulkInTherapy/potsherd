import fs from 'node:fs';
import path from 'node:path';
import { claudePaths } from '../paths.js';

/**
 * A metadata-only scan of `~/.claude/projects`. It answers "what is on disk and
 * when will it be deleted" without parsing a single full transcript: for each
 * `.jsonl` it reads the first 64 KB and the last 64 KB and nothing in between.
 *
 * That is what keeps `potsherd audit` under two seconds on 345 MB. The full
 * parse into exchanges is phase 1's job (`adapters/claude.ts`).
 */

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
/** When the tail holds no `ai-title`, look further back before giving up. */
const TAIL_ESCALATED_BYTES = 1024 * 1024;
/** Subagent transcripts live under a directory with this name, at either depth. */
export const SIDECHAIN_DIR = 'subagents';

export interface ScannedFile {
  /** Session id from the filename (top level) or the enclosing dir (sidechain). */
  sessionId: string;
  /** Sidechain files also carry their own `agent-<id>` name. */
  fileId: string;
  sourcePath: string;
  projectSlug: string;
  /** cwd from the first record that carries one; falls back to the slug. */
  project: string;
  projectFromRecord: boolean;
  bytes: number;
  mtime: Date;
  firstTs: string | null;
  lastTs: string | null;
  title: string | null;
  entrypoint: string | null;
  version: string | null;
  gitBranch: string | null;
  isSidechain: boolean;
  agentName: string | null;
  /** Record `type` values seen in the head/tail windows, with counts. */
  typesSeen: Record<string, number>;
  /** Set when the file could not be read at all. */
  error?: string;
}

export interface ProjectDir {
  slug: string;
  dir: string;
  hasSessionsIndex: boolean;
  hasMemory: boolean;
  memoryFiles: number;
}

export interface DiskScan {
  projectsDir: string;
  exists: boolean;
  projects: ProjectDir[];
  sessions: ScannedFile[];
  sidechains: ScannedFile[];
  totalBytes: number;
  scanMs: number;
}

export interface ScanOptions {
  /** Escalate the tail window looking for a late `ai-title`. `audit` only. */
  titles?: boolean;
  /**
   * Read anything out of the files at all. `rescue` needs only the session ids,
   * which are filenames, and the paths — so it opens nothing. On a 345 MB
   * corpus that is 234 file opens and up to 128 KB read from each of them, and
   * it was the single largest cost in the SessionStart hook's budget.
   */
  content?: boolean;
}

export function scanClaudeDisk(dir?: string, opts: ScanOptions = {}): DiskScan {
  const started = Date.now();
  const cp = claudePaths(dir);
  const projectsDir = cp.projects;
  const out: DiskScan = {
    projectsDir,
    exists: fs.existsSync(projectsDir),
    projects: [],
    sessions: [],
    sidechains: [],
    totalBytes: 0,
    scanMs: 0,
  };
  if (!out.exists) {
    out.scanMs = Date.now() - started;
    return out;
  }

  for (const entry of readdirSafe(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const projDir = path.join(projectsDir, slug);
    const memoryDir = path.join(projDir, 'memory');
    const memoryFiles = fs.existsSync(memoryDir)
      ? readdirSafe(memoryDir).filter((f) => f.endsWith('.md')).length
      : 0;
    out.projects.push({
      slug,
      dir: projDir,
      hasSessionsIndex: fs.existsSync(path.join(projDir, 'sessions-index.json')),
      hasMemory: memoryFiles > 0,
      memoryFiles,
    });

    for (const child of readdirSafe(projDir, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith('.jsonl')) {
        const f = scanFile(path.join(projDir, child.name), slug, {
          sessionId: child.name.slice(0, -'.jsonl'.length),
          isSidechain: false,
          titles: opts.titles !== false,
          content: opts.content !== false,
        });
        out.sessions.push(f);
        out.totalBytes += f.bytes;
      } else if (child.isDirectory()) {
        // Two layouts have been seen for subagent transcripts:
        //   <slug>/<session-uuid>/subagents/agent-*.jsonl   (this corpus)
        //   <slug>/subagents/agent-*.jsonl                  (plans/phases T0.1)
        // Both are sidechains. Missing the second would count every subagent
        // transcript as a session and inflate "still on disk", so both are
        // recognised here and both are excluded from `sessions`.
        const nested = child.name === SIDECHAIN_DIR;
        const subDir = nested ? path.join(projDir, child.name) : path.join(projDir, child.name, SIDECHAIN_DIR);
        if (!fs.existsSync(subDir)) continue;
        for (const sub of readdirSafe(subDir)) {
          if (!sub.endsWith('.jsonl')) continue;
          const fileId = sub.slice(0, -'.jsonl'.length);
          const f = scanFile(path.join(subDir, sub), slug, {
            // With no enclosing session directory the parent session is
            // whatever the records say; the filename is only an agent name.
            sessionId: nested ? fileId : child.name,
            fileId,
            isSidechain: true,
            titles: false,
            content: opts.content !== false,
          });
          out.sidechains.push(f);
          out.totalBytes += f.bytes;
        }
      }
    }
  }

  out.sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  out.scanMs = Date.now() - started;
  return out;
}

export function scanFile(
  file: string,
  slug: string,
  opts: {
    sessionId: string;
    fileId?: string;
    isSidechain: boolean;
    titles: boolean;
    /** When false, stat the file and read none of it. */
    content?: boolean;
  },
): ScannedFile {
  const rec: ScannedFile = {
    sessionId: opts.sessionId,
    fileId: opts.fileId ?? opts.sessionId,
    sourcePath: file,
    projectSlug: slug,
    project: slugToPathGuess(slug),
    projectFromRecord: false,
    bytes: 0,
    mtime: new Date(0),
    firstTs: null,
    lastTs: null,
    title: null,
    entrypoint: null,
    version: null,
    gitBranch: null,
    isSidechain: opts.isSidechain,
    agentName: null,
    typesSeen: {},
  };

  let fd: number | undefined;
  try {
    const st = fs.statSync(file);
    rec.bytes = st.size;
    rec.mtime = st.mtime;
    if (opts.content === false) return rec;
    fd = fs.openSync(file, 'r');

    const headText = readAt(fd, 0, Math.min(HEAD_BYTES, st.size));
    applyRecords(rec, splitLines(headText, { dropLast: st.size > HEAD_BYTES }));

    if (st.size > HEAD_BYTES) {
      let tailSize = Math.min(TAIL_BYTES, st.size);
      let tailText = readAt(fd, st.size - tailSize, tailSize);
      applyRecords(rec, splitLines(tailText, { dropFirst: true }));
      if (opts.titles && !rec.title && st.size > TAIL_BYTES) {
        tailSize = Math.min(TAIL_ESCALATED_BYTES, st.size);
        tailText = readAt(fd, st.size - tailSize, tailSize);
        applyRecords(rec, splitLines(tailText, { dropFirst: true }));
      }
    }
  } catch (err) {
    rec.error = (err as Error).message;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
  return rec;
}

function readAt(fd: number, position: number, length: number): string {
  if (length <= 0) return '';
  const buf = Buffer.allocUnsafe(length);
  const read = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, read).toString('utf8');
}

function splitLines(text: string, o: { dropFirst?: boolean; dropLast?: boolean }): string[] {
  const lines = text.split('\n');
  if (o.dropFirst) lines.shift();   // a window boundary cut this line in half
  if (o.dropLast) lines.pop();
  return lines;
}

/**
 * Fold whatever records we happened to see into the summary. Deliberately
 * tolerant: unknown types are counted, malformed lines are ignored, and the
 * later window wins for `lastTs`/`title` because it is nearer the end.
 */
function applyRecords(rec: ScannedFile, lines: string[]): void {
  for (const line of lines) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof r['type'] === 'string' ? (r['type'] as string) : 'unknown';
    rec.typesSeen[type] = (rec.typesSeen[type] ?? 0) + 1;

    const ts = typeof r['timestamp'] === 'string' ? (r['timestamp'] as string) : null;
    if (ts) {
      if (!rec.firstTs || ts < rec.firstTs) rec.firstTs = ts;
      if (!rec.lastTs || ts > rec.lastTs) rec.lastTs = ts;
    }
    if (type === 'ai-title' && typeof r['aiTitle'] === 'string') {
      rec.title = r['aiTitle'] as string;
    }
    if (type === 'agent-name' && typeof r['agentName'] === 'string') {
      rec.agentName = r['agentName'] as string;
    }
    if (!rec.projectFromRecord && typeof r['cwd'] === 'string' && r['cwd']) {
      rec.project = r['cwd'] as string;
      rec.projectFromRecord = true;
    }
    if (!rec.entrypoint && typeof r['entrypoint'] === 'string') {
      rec.entrypoint = r['entrypoint'] as string;
    }
    if (!rec.version && typeof r['version'] === 'string') rec.version = r['version'] as string;
    if (!rec.gitBranch && typeof r['gitBranch'] === 'string') {
      rec.gitBranch = r['gitBranch'] as string;
    }
    if (r['isSidechain'] === true) rec.isSidechain = true;
  }
}

/**
 * `-Users-zebra-Veyu-Outreach-Engine` is ambiguous: the separator and the
 * hyphens inside a real directory name are the same character. This is only a
 * display fallback for files whose records carry no `cwd`.
 */
export function slugToPathGuess(slug: string): string {
  if (!slug.startsWith('-')) return slug;
  return '/' + slug.slice(1).replace(/-/g, '/');
}

function readdirSafe(dir: string): string[];
function readdirSafe(dir: string, o: { withFileTypes: true }): fs.Dirent[];
function readdirSafe(dir: string, o?: { withFileTypes: true }): string[] | fs.Dirent[] {
  try {
    return o ? fs.readdirSync(dir, o) : fs.readdirSync(dir);
  } catch {
    return [];
  }
}
