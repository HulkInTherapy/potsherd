import fs from 'node:fs';
import path from 'node:path';
import { archiveDir, claudeDir, claudePaths, potsherdDir } from '../paths.js';
import { SIDECHAIN_DIR } from '../claude/scan.js';
import { formatDoctorLine } from '../doctor-line.js';
import { parseClaudeTranscript, exchangeId } from '../parser/claude.js';
import { readJsonlLines, parseJsonLine } from '../parser/jsonl.js';
import { isRecord, uniq } from '../parser/content.js';
import type {
  Adapter,
  Exchange,
  ParseOptions,
  ParseResult,
  SessionSource,
  SessionStatus,
} from './types.js';

/**
 * The Claude Code adapter (L0).
 *
 * `discover()` is a directory walk; `parse()` wraps `parser/claude.ts`, which
 * already does the record-level work (human-prompt rule, tool_use_id pairing,
 * last-`ai-title`-wins, sidechain session ids). This file owns the three
 * things the parser cannot know from a single file:
 *
 *   1. **Where the transcripts are.** Three layouts, all real on this machine:
 *      `projects/<slug>/<session>.jsonl`,
 *      `projects/<slug>/<session>/subagents/agent-*.jsonl` (197 of 197 here),
 *      and `projects/<slug>/subagents/agent-*.jsonl` (the flatter layout the
 *      phase-0 scanner already handles). A subagent transcript is *never* a
 *      session of its own; counting one as a session inflates "still on disk".
 *   2. **The archive fallback.** When a path is gone from `~/.claude` but a
 *      byte-exact copy survives under `~/.potsherd/archive/claude/`, potsherd
 *      indexes the copy and marks the session `archived`. That is the whole
 *      point of `rescue`: the sweep takes the file, the index keeps the
 *      session.
 *   3. **Doctor's parse coverage.** Unknown record types are counted, never
 *      fatal, and reported per `(harness, version, type)` — the transcript
 *      `version` is a per-file fact the parser does not surface.
 *
 * READ-ONLY: nothing here opens a file for writing. `~/.claude` is an input.
 */

/** `~/.claude/projects` — the directory this adapter reads. */
export function sourceDir(claudeConfigDir?: string): string {
  return claudePaths(claudeDir(claudeConfigDir)).projects;
}

/** `~/.potsherd/archive/claude` — the fallback read when the source is gone. */
export function archiveSourceDir(root?: string): string {
  return path.join(archiveDir(root ?? potsherdDir()), 'claude');
}

export interface DiscoverOptions {
  /** Override `~/.claude` (tests, `--claude-dir`, `CLAUDE_CONFIG_DIR`). */
  claudeDir?: string;
  /** Override `~/.potsherd`, whose `archive/claude/` is the fallback. */
  potsherdDir?: string;
  /** Skip the archive fallback entirely. `audit` wants live files only. */
  archive?: boolean;
}

/**
 * A discovered claude transcript. A structural superset of {@link SessionSource}:
 * `path` is always the file that will actually be read, so for an archived
 * session it is the copy under `~/.potsherd`, and `originalPath` records where
 * the harness used to keep it (the store's `sessions.source_path` /
 * `archived_path` pair, `03` §3).
 */
export interface ClaudeSessionSource extends SessionSource {
  harness: 'claude';
  /** Path relative to `projects/`, e.g. `-Users-me-app/<uuid>.jsonl`. */
  rel: string;
  /** Set only when `status === 'archived'`: the vanished `~/.claude` path. */
  originalPath?: string;
}

/**
 * Every transcript claude code has left on this machine, live copies first and
 * archived copies for the ones the sweep already took.
 *
 * Cheap on purpose (`readdir` + `stat`, no file is opened): `doctor`, `index`
 * and `stats` all call it, and the incremental index decides what to re-read
 * from `bytes` + `mtimeMs` alone.
 */
export function discover(options: DiscoverOptions = {}): ClaudeSessionSource[] {
  const live = walkProjects(sourceDir(options.claudeDir), 'live');
  const byRel = new Map<string, ClaudeSessionSource>();
  for (const found of live) byRel.set(found.rel, found);

  if (options.archive !== false) {
    const archiveRoot = archiveSourceDir(options.potsherdDir);
    for (const found of walkProjects(archiveRoot, 'archived')) {
      // A live file always wins: it is the same bytes plus whatever the
      // session has appended since the last rescue.
      if (byRel.has(found.rel)) continue;
      found.originalPath = path.join(sourceDir(options.claudeDir), found.rel);
      byRel.set(found.rel, found);
    }
  }

  return [...byRel.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * One transcript, fully parsed.
 *
 * `session.id` for a sidechain is `${parentSessionId}:${basename}` — derived by
 * the parser, never re-derived here. The `sessionId` *field inside* a subagent
 * transcript holds the **parent's** id, so using it raw would collide every
 * sidechain with its parent on the sessions primary key.
 */
export async function parse(
  source: SessionSource,
  options: ParseOptions = {},
): Promise<ClaudeParseResult> {
  const raw = await parseClaudeTranscript(source.path, {
    ...options,
    // Only ever assert `true`: a top-level transcript that happens to carry a
    // record with `isSidechain:true` is still a session, and forcing `false`
    // would throw away the flag for a subagent file the path did not reveal.
    ...(source.isSidechain ? { isSidechain: true } : {}),
    ...(source.parentSessionId ? { parentSessionId: source.parentSessionId } : {}),
    projectSlug: options.projectSlug ?? source.projectSlug,
    status: source.status ?? 'live',
    bytes: source.bytes || undefined,
  });

  const folded = foldContinuations(raw.exchanges, options.fromSeq ?? 0);
  const version = await readTranscriptVersion(source.path);

  return {
    ...raw,
    exchanges: folded.exchanges,
    ...(version ? { version } : {}),
    continuationsFolded: folded.folded,
    orphanContinuations: folded.orphans,
  };
}

export interface ClaudeParseResult extends ParseResult {
  /** `version` off the first record that carries one — doctor groups by it. */
  version?: string;
  /** Payload-only `type:"user"` records folded back into their prompt. */
  continuationsFolded: number;
  /** Ditto, but with no prompt ahead of them in this batch, so dropped. */
  orphanContinuations: number;
}

/**
 * The `doctor` line for claude. Counts come from `discover()`, so what doctor
 * says and what `index` would read can never disagree.
 *
 * `claude      ready     ~/.claude/projects            30 sessions · 197 sidechains`
 */
export function doctorLine(options: DiscoverOptions = {}): string {
  const dir = sourceDir(options.claudeDir);
  let found: ClaudeSessionSource[] = [];
  try {
    found = discover(options);
  } catch {
    found = [];
  }
  const exists = fs.existsSync(dir);
  const sidechains = found.filter((f) => f.isSidechain).length;
  const archived = found.filter((f) => f.status === 'archived').length;
  const sessions = found.length - sidechains;
  const parts = [`${sessions} session${sessions === 1 ? '' : 's'}`];
  if (sidechains > 0) parts.push(`${sidechains} sidechains`);
  if (archived > 0) parts.push(`${archived} from the archive`);
  return formatDoctorLine({
    harness: 'claude',
    status: exists || found.length > 0 ? 'ready' : 'absent',
    dir,
    note: exists || found.length > 0 ? parts.join(' \u00b7 ') : 'Claude Code not installed',
  });
}

export const claudeAdapter: Adapter = {
  harness: 'claude',
  displayName: 'Claude Code',
  sourceDir: () => sourceDir(),
  discover: () => discover(),
  parse: (source, options) => parse(source, options),
};

// --------------------------------------------------------------- discovery

type Walked = ClaudeSessionSource;

/**
 * Walk one `projects/`-shaped tree. `~/.claude/projects` and
 * `~/.potsherd/archive/claude` have the identical layout — rescue copies the
 * tree verbatim — so one walker serves both.
 */
function walkProjects(projectsDir: string, status: SessionStatus): Walked[] {
  const out: Walked[] = [];
  for (const slugEntry of readdirSafe(projectsDir, true)) {
    if (!slugEntry.isDirectory()) continue;
    const slug = slugEntry.name;
    const dir = path.join(projectsDir, slug);

    for (const entry of readdirSafe(dir, true)) {
      if (entry.isFile()) {
        if (!entry.name.endsWith('.jsonl')) continue;
        push(out, {
          file: path.join(dir, entry.name),
          rel: path.join(slug, entry.name),
          slug,
          sessionId: basename(entry.name),
          isSidechain: false,
          status,
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name === 'memory') continue; // auto-memory notes, not transcripts

      // Two subagent layouts, both real:
      //   <slug>/subagents/agent-*.jsonl              (flat)
      //   <slug>/<session-uuid>/subagents/agent-*.jsonl (nested)
      // In the flat layout the path names no parent, so the session id stays a
      // best guess here and `parse()` corrects it from the records — which is
      // exactly what `SessionSource.sessionId` is documented to allow.
      const flat = entry.name === SIDECHAIN_DIR;
      const subDir = flat ? path.join(dir, entry.name) : path.join(dir, entry.name, SIDECHAIN_DIR);
      const relDir = flat ? path.join(slug, entry.name) : path.join(slug, entry.name, SIDECHAIN_DIR);
      for (const name of readdirSafe(subDir)) {
        if (!name.endsWith('.jsonl')) continue;
        push(out, {
          file: path.join(subDir, name),
          rel: path.join(relDir, name),
          slug,
          sessionId: flat ? basename(name) : `${entry.name}:${basename(name)}`,
          isSidechain: true,
          ...(flat ? {} : { parentSessionId: entry.name }),
          status,
        });
      }
    }
  }
  return out;
}

function push(
  out: Walked[],
  spec: {
    file: string;
    rel: string;
    slug: string;
    sessionId: string;
    isSidechain: boolean;
    parentSessionId?: string;
    status: SessionStatus;
  },
): void {
  const st = statSafe(spec.file);
  if (!st) return; // raced with the sweep between readdir and stat
  out.push({
    sessionId: spec.sessionId,
    harness: 'claude',
    path: spec.file,
    rel: spec.rel,
    projectSlug: spec.slug,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    isSidechain: spec.isSidechain,
    ...(spec.parentSessionId ? { parentSessionId: spec.parentSessionId } : {}),
    status: spec.status,
  });
}

// ------------------------------------------------------------ post-parsing

/**
 * Fold payload-only `type:"user"` records back into the prompt they belong to.
 *
 * `formats.md`'s human-prompt rule has three clauses: `type:"user"`, a
 * `promptId`, **and** content that is a string or holds a `text` item with no
 * `tool_result` item. T1.2 found `parser/claude.ts` implementing only the first
 * two and the `tool_result` half of the third, so the *images* a tool returned
 * — written as their own `type:"user"` record carrying the originating
 * prompt's `promptId` and a content array of nothing but `image` blocks, 11 of
 * them in this corpus — passed the test, opened a new exchange and left it with
 * an empty `userText`. Worse, where the split segment made no tool call the
 * parser's own `finalize()` guard discarded it, and its assistant text was lost
 * before this adapter could ever see it. That is finding F1; T1.5 fixed the
 * clause in `parser/claude.ts`, so on a full parse this pass now folds nothing.
 *
 * It stays because it is still reachable, and cheap: an **incremental** run
 * resumes at a byte offset that can fall between a prompt and its answer, and
 * `pi` and `cursor` transcripts can open a turn the same way. An exchange with
 * no user text is not a prompt — its assistant text, tool calls and files
 * belong to the exchange before it. Seqs are renumbered contiguously afterwards
 * so `exchanges.at(-1).seq` remains a valid `fromSeq` for the next run.
 */
function foldContinuations(
  exchanges: Exchange[],
  fromSeq: number,
): { exchanges: Exchange[]; folded: number; orphans: number } {
  const kept: Exchange[] = [];
  let folded = 0;
  let orphans = 0;

  for (const exchange of exchanges) {
    const previous = kept[kept.length - 1];
    if (exchange.userText.trim()) {
      kept.push(exchange);
      continue;
    }
    if (!previous) {
      // Nothing to fold into: the batch begins mid-turn (an incremental run
      // that resumed at exactly this offset). Counted, never fatal.
      orphans += 1;
      continue;
    }
    folded += 1;
    previous.assistantText = [previous.assistantText, exchange.assistantText]
      .filter((t) => t.trim())
      .join('\n\n');
    previous.toolCalls = [...previous.toolCalls, ...exchange.toolCalls];
    previous.filesTouched = uniq([...previous.filesTouched, ...exchange.filesTouched]);
  }

  let seq = fromSeq;
  for (const exchange of kept) {
    seq += 1;
    exchange.seq = seq;
    exchange.id = exchangeId(exchange.sessionId, seq);
  }

  return { exchanges: kept, folded, orphans };
}

/**
 * The `version` field off the first record that carries one. Claude writes it
 * on every message-bearing record but not on the bookkeeping records that open
 * a transcript, so the search is capped rather than first-line-only.
 */
const VERSION_SCAN_LINES = 200;

export async function readTranscriptVersion(filePath: string): Promise<string | undefined> {
  let seen = 0;
  try {
    for await (const line of readJsonlLines(filePath)) {
      if (seen >= VERSION_SCAN_LINES) break;
      seen += 1;
      const parsed = parseJsonLine(line.text);
      if (!isRecord(parsed)) continue;
      if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
    }
  } catch {
    return undefined; // unreadable file: the parse itself will report it
  }
  return undefined;
}

// ------------------------------------------------------- doctor: coverage

/**
 * Record types that are documented in `plans/research/formats.md`, carry
 * nothing an exchange needs, and are skipped deliberately. They still show up
 * in `unknownTypes` (the parser reports every type it did not consume), but
 * `doctor` should not cry wolf over them — only a type absent from this list
 * is genuinely new and worth a look.
 */
export const IGNORED_RECORD_TYPES: readonly string[] = [
  'last-prompt',
  'mode',
  'permission-mode',
  'queue-operation',
  'atis-latch',
  'file-history-snapshot',
  'file-history-delta',
  'frame-link',
];

const IGNORED = new Set(IGNORED_RECORD_TYPES);

/** True for a record type no version of `formats.md` has described yet. */
export function isNovelRecordType(type: string): boolean {
  return !IGNORED.has(type);
}

export interface RecordTypeStat {
  harness: 'claude';
  /** Transcript `version`, or `unknown` for a file that carried none. */
  version: string;
  type: string;
  /** Records of this type seen. */
  count: number;
  /** Transcripts it appeared in. */
  files: number;
  /** False for a type `formats.md` already documents as safely ignorable. */
  novel: boolean;
}

/**
 * Aggregate `unknownTypes` across a run into the `(harness, version, type)`
 * rows `doctor` prints. Sorted novel-first, then by volume, so a format change
 * in a new claude code build is the first line a user reads.
 */
export function recordTypeStats(results: Iterable<ClaudeParseResult>): RecordTypeStat[] {
  const rows = new Map<string, RecordTypeStat>();
  for (const result of results) {
    const version = result.version ?? 'unknown';
    for (const [type, count] of Object.entries(result.unknownTypes)) {
      const key = `${version} ${type}`;
      const row = rows.get(key);
      if (row) {
        row.count += count;
        row.files += 1;
      } else {
        rows.set(key, {
          harness: 'claude',
          version,
          type,
          count,
          files: 1,
          novel: isNovelRecordType(type),
        });
      }
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      Number(b.novel) - Number(a.novel) ||
      b.count - a.count ||
      (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) ||
      (a.type < b.type ? -1 : 1),
  );
}

// ------------------------------------------------------------------ helpers

function basename(fileName: string): string {
  return fileName.slice(0, -'.jsonl'.length);
}

function statSafe(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function readdirSafe(dir: string): string[];
function readdirSafe(dir: string, withFileTypes: true): fs.Dirent[];
function readdirSafe(dir: string, withFileTypes?: true): string[] | fs.Dirent[] {
  try {
    return withFileTypes ? fs.readdirSync(dir, { withFileTypes: true }) : fs.readdirSync(dir);
  } catch {
    return [];
  }
}
