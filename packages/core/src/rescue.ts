import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveDir, claudeDir, claudePaths, potsherdDir } from './paths.js';
import { scanClaudeDisk, SIDECHAIN_DIR } from './claude/scan.js';
import { readHistory } from './claude/history.js';
import { readSessionsIndexes } from './claude/sessions-index.js';
import { open as openDb, type Db } from './db.js';
import { fallbackTitle } from './recall.js';
import { stripBoilerplate } from './search/snippet.js';
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
 * The stopping rule for "does this prompt name the session?".
 *
 * 166 of the 299 ghosts on the reference machine — 56% — rendered as
 * `/resume`, `/model`, `/mcp` or `clear`. The first line `history.jsonl` holds
 * for a session is very often not a question at all but a command typed *at*
 * the harness rather than *to* it, and `05 §3` puts `ls` on the screenshot the
 * whole product is shared on. So this is the rule that decides whether that
 * screen reads as an archive or as garbage.
 *
 * A prompt names its session when it is
 *   - not a slash command,
 *   - at least `MIN_TITLE_CHARS` code points long, and
 *   - not one of the few words that are punctuation for a conversation rather
 *     than part of one.
 *
 * The list is the one `plans/phases/phase-8-hardening.md §8.2` names, and
 * nothing more. It is a *stopping rule*, not a filter widened until a count
 * came out at zero: a stoplist tuned to its own measurement is a constant
 * fitted to its own test. What stopped it is that the phase file wrote it down.
 */
const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  'clear',
  'continue',
  'ok',
  'yes',
  'hi',
  'y',
  'n',
]);

const MIN_TITLE_CHARS = 8;

/**
 * How much of a prompt becomes a title.
 *
 * 60 **code points** — never 60 bytes, and never 60 UTF-16 units. The design
 * system is built out of `·`, `…`, `→` and `★` and the corpus is not ASCII, so
 * a byte count is the wrong count (`09 §13.13`); `Array.from` is the only cut
 * in JavaScript that cannot leave half a surrogate pair behind, which
 * `String.slice` will happily do to an emoji. 60 is also deliberately low
 * enough that `recall.ts`'s own 120-unit display cut can never re-cut what is
 * stored here: 60 code points is at most 120 UTF-16 units.
 */
export const GHOST_TITLE_MAX_CHARS = 60;

/** Whitespace is not information in a title, and a prompt may be many lines. */
function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Cut to `max` code points. Never splits a surrogate pair. */
export function cutToCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/** Whether this prompt names the session it opened. See `TITLE_STOPWORDS`. */
export function isSubstantivePrompt(text: string | null | undefined): boolean {
  const clean = titleText(text);
  if (!clean) return false;
  if (clean.startsWith('/')) return false;
  if (Array.from(clean).length < MIN_TITLE_CHARS) return false;
  return !TITLE_STOPWORDS.has(clean.toLowerCase());
}

/**
 * What a prompt contributes to a title: its own words, with the harness's
 * furniture taken off the front.
 *
 * A pasted screenshot arrives as `[Image: source: …/clipboard-2026-06-20.png]`
 * on its own line, followed by what the person actually typed. Both halves are
 * one prompt, so a rule that reads the raw string sees a long non-slash
 * candidate, accepts it, and cuts a 60-character title that is entirely
 * placeholder and half of a home directory — `why is the pay button grey here`
 * pushed off the end.
 *
 * Rejecting such a prompt would be wrong too: it *does* name its session. So
 * the furniture is removed and the words are kept. `stripBoilerplate` is the
 * same function `find` uses to decide what may be quoted as evidence, which is
 * the right authority — a string too empty to quote is too empty to name, and
 * a string with words left is worth both.
 *
 * This also disposes of most of the home paths that reached the title column,
 * because the path was *inside* the placeholder.
 */
function titleText(text: string | null | undefined): string {
  return collapse(stripBoilerplate(text ?? ''));
}

/** The first prompt in `texts` that names its session, collapsed. Or null. */
export function firstSubstantivePrompt(
  texts: Iterable<string | null | undefined>,
): string | null {
  for (const t of texts) if (isSubstantivePrompt(t)) return titleText(t);
  return null;
}

/**
 * The name a ghost is listed under, and it is never null.
 *
 * Three sources in order of how much they know:
 *   1. `sessions-index.json`'s `summary` — the harness's own name for the
 *      session, written from the whole of it. Stored verbatim: it is already a
 *      title and cutting it would only lose words.
 *   2. the first substantive prompt, cut to `GHOST_TITLE_MAX_CHARS`. A prompt
 *      is not a title, which is why this one is cut and the summary is not.
 *   3. `<project>-<id8>`. A uuid-shaped name is a poor label; a slash command
 *      is a *wrong* one, because a dozen ghosts called `/model` are less
 *      distinguishable than a dozen uuids and they also claim to say something.
 *
 * Stored in `ghosts.title` rather than resolved per-surface so that `ls`,
 * `find`, `show` and `graft` cannot disagree — `browse.ts`'s existing
 * `COALESCE(g.title, g.first_prompt)` then resolves to (1)/(2)/(3) with no
 * edit of its own.
 */
function ghostTitle(
  summary: string | null,
  substantive: string | null,
  project: string | null,
  sessionId: string,
): string {
  if (summary) return summary;
  if (substantive) return cutToCodePoints(substantive, GHOST_TITLE_MAX_CHARS);
  return fallbackTitle(project, sessionId, HARNESS);
}

/**
 * Whether a stored title is one somebody *wrote*, as opposed to the
 * `<project>-<id8>` fallback this file synthesised.
 *
 * The receipt's "N with titles" has to mean the same thing on both paths, and
 * the fast path never sees the prompts — so the question is asked of the
 * stored row instead, by re-deriving the fallback and comparing. That keeps
 * one definition rather than a column that could drift from it.
 */
function isWrittenTitle(
  title: string | null,
  project: string | null,
  sessionId: string,
): boolean {
  const clean = collapse(title);
  return clean !== '' && clean !== fallbackTitle(project, sessionId, HARNESS);
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
 *
 * …and one thing that is not an input at all: `GHOST_ALGO_VERSION`. The
 * fingerprint's whole job is "would a rebuild produce a different row", and
 * after phase 8.2 the same three inputs produce a *different* row than they
 * did at v1.0.0. Without the version an upgraded potsherd would keep serving
 * the `/resume` titles it already stored, for ever, because nothing under
 * ~/.claude had changed. Bump it whenever the derivation changes.
 *
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
  const parts = [`algo:${String(GHOST_ALGO_VERSION)}`, `history:${hs.size}:${Math.floor(hs.mtimeMs)}`];
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

/** 1 = v1.0.0 (the literal first history.jsonl line); 2 = phase 8.2 titles. */
const GHOST_ALGO_VERSION = 2;

const GHOST_FINGERPRINT_KEY = 'claude:ghosts';

/** What the ghosts already in the database add up to, without rebuilding them. */
function ghostTotals(db: Db): {
  ghosts: number;
  prompts: number;
  promptRows: number;
  withTitles: number;
} {
  const g = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(prompt_count), 0) AS prompts FROM ghosts')
    .get() as { n: number; prompts: number };
  const rows = db.prepare('SELECT COUNT(*) AS n FROM ghost_prompts').get() as { n: number };
  // `title` is never null after phase 8.2, so counting non-nulls would count
  // every ghost. What the receipt means by "with titles" is a name somebody
  // wrote, so the fallback is subtracted here the same way the slow path
  // declines to count it.
  const named = db
    .prepare('SELECT session_id, project, title FROM ghosts')
    .all() as { session_id: string; project: string | null; title: string | null }[];
  let titled = 0;
  for (const r of named) {
    if (isWrittenTitle(r.title, r.project, r.session_id)) titled++;
  }
  return { ghosts: g.n, prompts: g.prompts, promptRows: rows.n, withTitles: titled };
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

  // `title` and `first_prompt` are *derived*, not accumulated: both are
  // recomputed from the surviving prompts on every rebuild and written over
  // whatever was there. That is the whole of the idempotency story — the
  // derivation is a pure, total function of (summary, prompts, project, id),
  // so re-running cannot change a good title, and a bad one left by an older
  // build cannot survive the first run of a newer one. Preserving the old
  // value instead (`COALESCE(excluded.title, ghosts.title)`, which is what
  // this did at v1.0.0) would make the 166 `/resume` rows permanent.
  const upsertGhost = db.prepare(
    `INSERT INTO ghosts (session_id, harness, project, first_ts, last_ts, prompt_count,
        first_prompt, title, message_count, git_branch, source)
     VALUES (@session_id, @harness, @project, @first_ts, @last_ts, @prompt_count,
        @first_prompt, @title, @message_count, @git_branch, @source)
     ON CONFLICT(session_id) DO UPDATE SET
       project = excluded.project, first_ts = excluded.first_ts, last_ts = excluded.last_ts,
       prompt_count = excluded.prompt_count, first_prompt = excluded.first_prompt,
       title = excluded.title,
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
      const summary = collapse(idx?.summary) || null;
      const project = g.project || idx?.projectPath || null;
      // In the order the user typed them, then whatever the index remembered:
      // sessions-index.json outlives the transcript but not always
      // history.jsonl, so either one can be the last thing standing.
      const substantive = firstSubstantivePrompt([
        ...g.prompts.map((p) => p.text),
        g.firstPrompt,
        idx?.firstPrompt,
      ]);
      const title = ghostTitle(summary, substantive, project, g.sessionId);
      const row = {
        session_id: g.sessionId,
        harness: HARNESS,
        project,
        first_ts: g.firstTs ? new Date(g.firstTs).toISOString() : null,
        last_ts: g.lastTs ? new Date(g.lastTs).toISOString() : null,
        prompt_count: g.promptCount,
        // The *substantive* prompt, or nothing. The verbatim prompt stream,
        // slash commands and all, is `ghost_prompts` — which is what `show`
        // renders and what `ghost_prompts_fts` searches — so nothing is lost
        // by keeping the denormalised copy free of `/resume`. Null here means
        // "this session typed nothing that names it", which is exactly when
        // `title` is the `<project>-<id8>` fallback.
        first_prompt: substantive,
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
      if (summary || substantive) result.ghostsWithTitles++;
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
        const summary = collapse(e.summary) || null;
        const project = e.projectPath ?? null;
        const substantive = firstSubstantivePrompt([e.firstPrompt]);
        upsertGhost.run({
          session_id: id,
          harness: HARNESS,
          project,
          first_ts: e.created ?? null,
          last_ts: e.modified ?? null,
          prompt_count: 0,
          first_prompt: substantive,
          title: ghostTitle(summary, substantive, project, id),
          message_count: e.messageCount ?? null,
          git_branch: e.gitBranch ?? null,
          source: 'sessions-index',
        });
        if (existing.has(id)) result.ghostsUpdated++;
        else result.ghostsBuilt++;
        if (summary || substantive) result.ghostsWithTitles++;
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
