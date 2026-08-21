import fs from 'node:fs';
import path from 'node:path';

import type {
  Adapter,
  Exchange,
  ExchangeToolCall,
  ParseOptions,
  ParseResult,
  SessionRecord,
  SessionSource,
  SessionStatus,
} from './types.js';
import { parseCodexTranscript } from '../parser/codex.js';
import { parseJsonLine, readJsonlLines } from '../parser/jsonl.js';
import { isRecord, uniq } from '../parser/content.js';
import { codexDir, codexPaths, tildify } from '../paths.js';
import { formatDoctorLine } from '../doctor-line.js';
import {
  MIN_CODEX_VERSION,
  parseCodexCliVersion,
  versionMeetsMinimum,
} from '../codex/version.js';

/**
 * The Codex CLI / Codex Desktop adapter (L0).
 *
 * ```
 * $CODEX_HOME (default ~/.codex)
 * ├── sessions/<YYYY>/<MM>/<DD>/rollout-<local-ts>-<uuid>.jsonl   the transcripts
 * ├── archived_sessions/…/rollout-…jsonl                          same shape, archived
 * └── session_index.jsonl   {"id","thread_name","updated_at"}     the ONLY title source
 * ```
 *
 * This file is potsherd's own. The line-level parse it drives lives in
 * `../parser/codex.ts` (ported from obra/episodic-memory, MIT); everything
 * here — discovery, `CODEX_HOME`, titles, entrypoint normalisation, binary
 * elision and the `doctor` line — is potsherd's.
 *
 * ## Trap 1 — two parallel streams, one conversation
 *
 * A rollout interleaves `type:"response_item"` records (the model-facing
 * transcript) with `type:"event_msg"` records (the UI event log). **They
 * describe the same turns.** In the real 85-record session on this machine the
 * same assistant turn appears as `event_msg/agent_message` *and*
 * `response_item/message role=assistant`; the same reasoning appears as
 * `event_msg/agent_reasoning` *and* `response_item/reasoning`; the same prompt
 * appears as `event_msg/user_message` *and* `response_item/message role=user`.
 * A parser that walks every record and appends on both counts every turn
 * twice.
 *
 * **`response_item` is authoritative** and is the only stream content is built
 * from. Why that one and not the prettier `event_msg` view:
 *
 * 1. it is the complete one. tool calls and their outputs (`custom_tool_call`
 *    / `custom_tool_call_output`) exist *only* as `response_item`; `event_msg`
 *    has just `patch_apply_end`, which covers file edits and nothing else.
 * 2. it is the joinable one. `call_id` pairs a call to its output inside the
 *    `response_item` stream. `patch_apply_end.call_id` is `exec-<uuid>`, a
 *    different id namespace that matches no `custom_tool_call`.
 * 3. it is the one the model saw, so it is the one a citation should quote.
 *
 * `event_msg` is used for exactly one thing: `event_msg/user_message` is the
 * ground truth for *"a human typed this"*. `response_item/message role=user`
 * also carries injected `<environment_context>` / `<recommended_plugins>`
 * blocks the user never wrote, and the only reliable way to tell them apart is
 * that injected text never gets an `event_msg`. On the real session that test
 * turns 3 `role:"user"` records into 2 human prompts.
 *
 * ## Trap 2 — tool arguments are JavaScript, not JSON
 *
 * This Codex build emits `custom_tool_call` with `name:"exec"` and an `input`
 * that is **JavaScript source** — `const r = await tools.exec_command({…})`,
 * `const patch = "*** Begin Patch\n*** Add File: …"` — not a JSON arguments
 * object. `JSON.parse` on it fails (the parser's `safeParseJson` returns the
 * string unchanged, which is correct) and the generic key-walk that fills
 * `filesTouched` finds nothing, because there is no object to walk. So
 * {@link filesFromCodexToolInput} reads the one file-naming construct that is
 * a stable format rather than free-form JS: the `apply_patch` envelope's
 * `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:`
 * markers. Everything else in the source stays untouched text.
 *
 * ## Trap 3 — a 1.9 MB line with embedded base64 images
 *
 * One `custom_tool_call_output` in the real session is 1,917,792 bytes — 90%
 * of the file — because its `output[]` array holds 15 `input_image` parts with
 * `data:image/png;base64,…` payloads of 109–198 KB each. Two things protect
 * the pipeline, and both matter:
 *
 * - the line is read by a streaming byte-exact reader (`parser/jsonl.ts`), not
 *   `readFileSync().split('\n')`, so file size never bounds memory;
 * - `stringifyToolOutput` keeps only `output[]` parts that carry a `text`
 *   field, so `input_image` parts are dropped and that record contributes 60
 *   bytes of "Script completed…" to the `Exchange`. But when a record has
 *   *no* text part it falls through to `JSON.stringify(output)` and the whole
 *   base64 blob would land in an `Exchange` — and from there in sqlite, the
 *   redactor and the embedder. {@link elideBinary} closes that hole
 *   unconditionally: every `data:…;base64,…` run becomes
 *   `‹elided:image/png:109362 bytes›`, and any value still over
 *   {@link DEFAULT_MAX_VALUE_BYTES} is cut with `‹elided:oversize:N bytes›`.
 *   The counts come back on {@link CodexParseResult.codex} so `doctor` can say
 *   it happened rather than silently losing bytes.
 *
 * Two more things the format gets wrong that callers should know: the
 * **filename timestamp is local wall-clock while every timestamp inside the
 * file is UTC `Z`** (never sort across the two), and `session_index.jsonl`'s
 * `updated_at` is stale — the transcript's last record wins for recency.
 */

// ---------------------------------------------------------------- paths

/**
 * `codexDir()` (honouring `CODEX_HOME`) and `codexPaths()` now live in
 * `paths.ts` beside `claudeDir()`, so `doctor --privacy` can enumerate every
 * path potsherd reads from one module (finding F9). They are re-exported here
 * because this is where a reader of the codex adapter looks for them.
 */
export { codexDir, codexPaths } from '../paths.js';

/**
 * `rollout-<ts>-<uuid>.jsonl` and nothing else. `$CODEX_HOME` also holds
 * `transcription-history.jsonl` (voice dictation) and vendored plugin
 * fixtures; matching `*.jsonl` would index both as sessions.
 */
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `sessions/YYYY/MM/DD/` is three levels; the cap only stops symlink loops. */
const MAX_WALK_DEPTH = 8;

/** `rollout-2026-07-21T19-35-33-<uuid>.jsonl` → the last uuid in the name. */
export function sessionIdFromRolloutPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const matches = base.match(UUID);
  return matches?.[matches.length - 1] ?? base;
}

// ---------------------------------------------------------------- discover

export interface CodexDiscoverOptions {
  /** Root to scan instead of `CODEX_HOME` / `~/.codex`. Tests use this. */
  codexHome?: string;
}

/**
 * A `readdir` + `stat` walk of `sessions/` and `archived_sessions/`. No file
 * is opened: `sessionId` is the filename's uuid (the scout confirmed it equals
 * `session_meta.payload.session_id`) and {@link parse} corrects it from the
 * header anyway.
 *
 * Codex has no per-project directory — sessions are filed by date — so
 * `projectSlug` is empty here and {@link parse} derives it from the `cwd`
 * inside the file.
 */
export function discover(options: CodexDiscoverOptions = {}): SessionSource[] {
  const paths = codexPaths(codexDir(options.codexHome));
  const out: SessionSource[] = [];
  walk(paths.sessions, 'live', 0, out);
  walk(paths.archived, 'archived', 0, out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function walk(dir: string, status: SessionStatus, depth: number, out: SessionSource[]): void {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable: not an error, the harness may not be installed
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, status, depth + 1, out);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!ROLLOUT_FILE.test(entry.name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      sessionId: sessionIdFromRolloutPath(full),
      harness: 'codex',
      path: full,
      projectSlug: '',
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      isSidechain: false,
      status,
    });
  }
}

// ---------------------------------------------------------------- session_index.jsonl

export interface CodexIndexEntry {
  id: string;
  /** Codex's own title for the thread. The rollout does not carry one. */
  threadName?: string;
  /** Stale by minutes-to-hours; never use it for recency (scout, C1). */
  updatedAt?: string;
}

/**
 * `session_index.jsonl` is flat — three fields, no envelope, structurally
 * unlike a rollout. A malformed line is skipped, never fatal.
 */
export function readSessionIndex(options: CodexDiscoverOptions = {}): Map<string, CodexIndexEntry> {
  const file = codexPaths(codexDir(options.codexHome)).sessionIndex;
  const out = new Map<string, CodexIndexEntry>();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseJsonLine(line);
    if (!isRecord(parsed) || typeof parsed['id'] !== 'string') continue;
    const id = parsed['id'];
    const threadName = parsed['thread_name'];
    const updatedAt = parsed['updated_at'];
    out.set(id, {
      id,
      ...(typeof threadName === 'string' && threadName.trim() ? { threadName } : {}),
      ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    });
  }
  return out;
}

/** Re-read only when the file changed; `index` calls `parse()` in a loop. */
const indexCache = new Map<string, { mtimeMs: number; entries: Map<string, CodexIndexEntry> }>();

function sessionIndexCached(codexHome: string | undefined): Map<string, CodexIndexEntry> {
  const file = codexPaths(codexDir(codexHome)).sessionIndex;
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* missing: cache the empty result under -1 */
  }
  const hit = indexCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.entries;
  const entries = readSessionIndex({ ...(codexHome ? { codexHome } : {}) });
  indexCache.set(file, { mtimeMs, entries });
  return entries;
}

/** Tests and long-lived processes that want the cache dropped. */
export function clearSessionIndexCache(): void {
  indexCache.clear();
}

// ---------------------------------------------------------------- header

export interface CodexHeader {
  sessionId?: string;
  cwd?: string;
  /** `Codex Desktop`, `codex_cli`, … */
  originator?: string;
  /** `vscode`, `cli`, … */
  source?: string;
  cliVersion?: string;
  modelProvider?: string;
  startedAt?: string;
}

/**
 * Read line 1 only. It is a `session_meta` record and it is big (~57 KB here:
 * a 17 KB system prompt plus ~39 KB of tool schemas), so it is streamed and
 * the stream is abandoned after one line rather than slurping the file.
 *
 * Returns `undefined` when line 1 is not a `session_meta` — that is the signal
 * for "this is a rollout shape I do not know", which `doctor` reports.
 */
export async function readCodexHeader(filePath: string): Promise<CodexHeader | undefined> {
  for await (const line of readJsonlLines(filePath)) {
    if (!line.terminated) return undefined;
    const parsed = parseJsonLine(line.text);
    if (!isRecord(parsed) || parsed['type'] !== 'session_meta') return undefined;
    const payload = parsed['payload'];
    if (!isRecord(payload)) return undefined;
    const str = (key: string): string | undefined =>
      typeof payload[key] === 'string' ? (payload[key] as string) : undefined;
    const timestamp = typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined;
    const header: CodexHeader = {
      ...(str('session_id') ?? str('id') ? { sessionId: str('session_id') ?? str('id') } : {}),
      ...(str('cwd') ? { cwd: str('cwd') } : {}),
      ...(str('originator') ? { originator: str('originator') } : {}),
      ...(str('source') ? { source: str('source') } : {}),
      ...(str('cli_version') ? { cliVersion: str('cli_version') } : {}),
      ...(str('model_provider') ? { modelProvider: str('model_provider') } : {}),
      ...(str('timestamp') ?? timestamp ? { startedAt: str('timestamp') ?? timestamp } : {}),
    };
    return header;
  }
  return undefined;
}

/**
 * `03` §2 wants `entrypoint` from a small vocabulary (`cli | sdk-ts | vscode |
 * desktop …`); codex spreads the same fact over `originator` ("Codex Desktop")
 * and `source` ("vscode"). `originator` names the app and wins; `source` is
 * the fallback. An unrecognised value is passed through lowercased rather than
 * dropped, so a new Codex surface shows up in `ls` instead of vanishing.
 */
export function codexEntrypoint(header: Pick<CodexHeader, 'originator' | 'source'>): string | undefined {
  for (const raw of [header.originator, header.source]) {
    if (!raw || !raw.trim()) continue;
    const v = raw.trim().toLowerCase();
    if (v.includes('desktop')) return 'desktop';
    if (v.includes('vscode') || v.includes('vs code')) return 'vscode';
    if (v.includes('cli')) return 'cli';
    if (v.includes('exec')) return 'exec';
    return v.replace(/\s+/g, '-');
  }
  return undefined;
}

// ---------------------------------------------------------------- binary elision

/**
 * `data:image/png;base64,…`. The 64-char floor keeps the pattern off short
 * inline SVG/ico data URIs that a user may legitimately have discussed.
 */
const DATA_URI = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)?(?:;[a-zA-Z0-9.+=-]+)*;base64,[A-Za-z0-9+/=\s]{64,}/g;

/** Beyond this a tool input/result is cut. 32 KiB is ~8k tokens of context. */
export const DEFAULT_MAX_VALUE_BYTES = 32 * 1024;
/** Prompts and answers are the product, so they get a far looser cap. */
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;

/** What {@link parse} had to throw away, so `doctor` can say it out loud. */
export interface CodexElisions {
  /** `data:…;base64,…` runs replaced by a marker. */
  binaryParts: number;
  /** Values cut for length. */
  truncatedValues: number;
  /** Characters dropped by both, combined. */
  charsElided: number;
}

function elideBinary(text: string, tally: CodexElisions): string {
  if (!text.includes('base64,')) return text;
  return text.replace(DATA_URI, (match, mime: string | undefined) => {
    tally.binaryParts += 1;
    tally.charsElided += match.length;
    return `\u2039elided:${mime ?? 'application/octet-stream'}:${match.length} bytes\u203a`;
  });
}

function cap(text: string, max: number, tally: CodexElisions): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  tally.truncatedValues += 1;
  tally.charsElided += dropped;
  return `${text.slice(0, max)}\n\u2039elided:oversize:${dropped} bytes\u203a`;
}

/**
 * `*** Add File: <path>` and friends inside an `apply_patch` envelope. The
 * envelope lives inside a JavaScript string literal, so the newlines around it
 * may be real (`\n`) or escaped (`\` `n`) depending on how the model wrote the
 * source — the terminator class covers both, plus the closing quote.
 */
const PATCH_FILE = /\*\*\* (?:Add|Update|Delete) File: ([^\n"\\]+)/g;
const PATCH_MOVE = /\*\*\* Move to: ([^\n"\\]+)/g;

/** Files named by a codex `exec` tool call. See "Trap 2" above. */
export function filesFromCodexToolInput(input: string): string[] {
  if (!input.includes('*** ')) return [];
  const out: string[] = [];
  for (const re of [PATCH_FILE, PATCH_MOVE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const file = m[1]?.trim();
      if (file) out.push(file);
    }
  }
  return out;
}

// ---------------------------------------------------------------- parse

export interface CodexParseOptions extends ParseOptions {
  /** Root to resolve `session_index.jsonl` against. Tests use this. */
  codexHome?: string;
  /** Title override; otherwise `session_index.jsonl`'s `thread_name`. */
  title?: string;
  /** Not in the JSONL at all — codex keeps it in `state_5.sqlite`. */
  gitBranch?: string;
  /** Default {@link DEFAULT_MAX_VALUE_BYTES}. */
  maxValueBytes?: number;
  /** Default {@link DEFAULT_MAX_MESSAGE_BYTES}. */
  maxMessageBytes?: number;
}

export interface CodexParseResult extends ParseResult {
  codex: {
    /** `session_meta.payload.cli_version`, e.g. `0.145.0-alpha.27`. */
    cliVersion?: string;
    /** False when `cli_version` is below {@link MIN_CODEX_VERSION}. */
    versionSupported: boolean;
    /** True when line 1 was not a readable `session_meta`. */
    headerUnreadable: boolean;
    /** True when `session_index.jsonl` had a `thread_name` for this id. */
    titled: boolean;
    elisions: CodexElisions;
  };
}

/**
 * Parse one discovered rollout into `SessionRecord` + `Exchange[]`.
 *
 * The line-level work is `parseCodexTranscript` (see the module comment for
 * why only `response_item` builds exchanges). This wrapper adds the four facts
 * that are not inside the transcript — title, session id on an incremental
 * resume, a normalised entrypoint, and the archived/live status — and scrubs
 * binary payloads out of the result.
 */
export async function parse(
  source: SessionSource,
  options: CodexParseOptions = {},
): Promise<CodexParseResult> {
  const header = await readCodexHeader(source.path);
  const id = options.sessionId ?? header?.sessionId ?? source.sessionId;
  const entries = sessionIndexCached(options.codexHome);
  const indexed = entries.get(id);
  const title = options.title ?? indexed?.threadName;

  const result = await parseCodexTranscript(source.path, {
    ...(options.fromOffset !== undefined ? { fromOffset: options.fromOffset } : {}),
    ...(options.fromSeq !== undefined ? { fromSeq: options.fromSeq } : {}),
    // The header is the file's own record, so passing it satisfies "parse() is
    // allowed to correct the id" while still working from a byte offset, where
    // the parser would never see `session_meta` again.
    sessionId: id,
    ...(options.projectSlug ?? source.projectSlug
      ? { projectSlug: options.projectSlug ?? source.projectSlug }
      : {}),
    ...(title ? { title } : {}),
    ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
    status: source.status ?? 'live',
    bytes: source.bytes,
  });

  const tally: CodexElisions = { binaryParts: 0, truncatedValues: 0, charsElided: 0 };
  const maxValue = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  const maxMessage = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

  const exchanges: Exchange[] = result.exchanges.map((exchange) => {
    const toolCalls: ExchangeToolCall[] = exchange.toolCalls.map((call) => {
      const input = cap(elideBinary(call.input, tally), maxValue, tally);
      const next: ExchangeToolCall = { ...call, input };
      if (call.result !== undefined) {
        next.result = cap(elideBinary(call.result, tally), maxValue, tally);
      }
      return next;
    });
    const extraFiles = exchange.toolCalls.flatMap((call) => filesFromCodexToolInput(call.input));
    return {
      ...exchange,
      userText: cap(elideBinary(exchange.userText, tally), maxMessage, tally),
      assistantText: cap(elideBinary(exchange.assistantText, tally), maxMessage, tally),
      toolCalls,
      filesTouched: uniq([...exchange.filesTouched, ...extraFiles]),
    };
  });

  const entrypoint = header ? codexEntrypoint(header) : undefined;
  const session: SessionRecord = {
    ...result.session,
    id,
    ...(header?.cwd ? { project: header.cwd, projectSlug: pickSlug(result.session, header.cwd) } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    status: source.status ?? result.session.status,
  };
  if (title) session.title = title;

  const cliVersion = header?.cliVersion;
  const semver = cliVersion ? parseCodexCliVersion(cliVersion) : undefined;

  return {
    ...result,
    session,
    exchanges,
    codex: {
      ...(cliVersion ? { cliVersion } : {}),
      // Unknown version == not yet proven unsupported; only a version we can
      // read AND that is below the floor counts as unsupported.
      versionSupported: semver ? versionMeetsMinimum(semver) : true,
      headerUnreadable: header === undefined,
      titled: Boolean(indexed?.threadName),
      elisions: tally,
    },
  };
}

/** The explicit slug wins; otherwise the cwd's basename, as the parser does. */
function pickSlug(session: SessionRecord, cwd: string): string {
  if (session.projectSlug && session.projectSlug !== 'unknown') return session.projectSlug;
  return path.basename(cwd) || 'unknown';
}

// ---------------------------------------------------------------- adapter

export const codexAdapter: Adapter = {
  harness: 'codex',
  displayName: 'Codex CLI',
  sourceDir: () => codexPaths().sessions,
  discover: () => discover(),
  parse: (source, options) => parse(source, options ?? {}),
};

// ---------------------------------------------------------------- doctor

export interface CodexDoctorReport {
  harness: 'codex';
  displayName: string;
  sourceDir: string;
  /** `$CODEX_HOME` exists at all. */
  present: boolean;
  sessions: number;
  archived: number;
  bytes: number;
  /** Discovered sessions with a `thread_name` in `session_index.jsonl`. */
  titled: number;
  /** `cli_version` string → how many sessions carried it. */
  versions: Record<string, number>;
  /** Versions below {@link MIN_CODEX_VERSION}: parseable, but codex-driven
   *  verbs (`card`, `ask`) cannot run against them. */
  unsupportedVersions: string[];
  /** Rollouts whose line 1 was not a readable `session_meta`. */
  unreadable: string[];
}

/**
 * Cheap health check: discovery plus line 1 of every rollout. It never runs a
 * full parse, so `doctor` stays instant on a 2 MB transcript.
 */
export async function codexDoctor(options: CodexDiscoverOptions = {}): Promise<CodexDoctorReport> {
  const paths = codexPaths(codexDir(options.codexHome));
  const sources = discover(options);
  const entries = readSessionIndex(options);

  const versions: Record<string, number> = {};
  const unsupported = new Set<string>();
  const unreadable: string[] = [];
  let titled = 0;
  let bytes = 0;
  let archived = 0;

  for (const source of sources) {
    bytes += source.bytes;
    if (source.status === 'archived') archived += 1;
    const header = await readCodexHeader(source.path);
    if (!header) {
      unreadable.push(source.path);
      continue;
    }
    const id = header.sessionId ?? source.sessionId;
    if (entries.get(id)?.threadName) titled += 1;
    const raw = header.cliVersion;
    if (raw) {
      versions[raw] = (versions[raw] ?? 0) + 1;
      const semver = parseCodexCliVersion(raw);
      if (semver && !versionMeetsMinimum(semver)) unsupported.add(raw);
    }
  }

  return {
    harness: 'codex',
    displayName: 'Codex CLI',
    sourceDir: paths.sessions,
    present: fs.existsSync(paths.root),
    sessions: sources.length,
    archived,
    bytes,
    titled,
    versions,
    unsupportedVersions: [...unsupported].sort(),
    unreadable,
  };
}

/**
 * One line for `potsherd doctor`: what the adapter found, and any version it
 * could not parse. Plain ASCII plus `·`; the caller colours it.
 */
export function renderCodexDoctorLine(report: CodexDoctorReport): string {
  if (!report.present) {
    return `codex     not installed        ${tildify(report.sourceDir)}`;
  }
  if (report.sessions === 0) {
    return `codex     0 sessions           ${tildify(report.sourceDir)}`;
  }
  const parts = [
    `${report.sessions} session${report.sessions === 1 ? '' : 's'}`,
    formatBytes(report.bytes),
    `${report.titled} titled`,
  ];
  if (report.archived > 0) parts.push(`${report.archived} archived`);
  const versions = Object.keys(report.versions).sort();
  if (versions.length > 0) parts.push(`cli ${versions.join(', ')}`);
  if (report.unsupportedVersions.length > 0) {
    parts.push(`${report.unsupportedVersions.join(', ')} < ${MIN_CODEX_VERSION}, unsupported`);
  }
  if (report.unreadable.length > 0) {
    parts.push(`${report.unreadable.length} unreadable header${report.unreadable.length === 1 ? '' : 's'}`);
  }
  return `codex     ${parts.join(' \u00b7 ')}   ${tildify(report.sourceDir)}`;
}

/**
 * The same facts as {@link renderCodexDoctorLine}, in the shared column shape
 * `doctor` prints the other three harnesses in.
 */
export function doctorLine(report: CodexDoctorReport): string {
  if (!report.present) {
    return formatDoctorLine({
      harness: 'codex',
      status: 'absent',
      dir: report.sourceDir,
      note: 'Codex CLI not installed',
    });
  }
  const parts = [`${report.sessions} session${report.sessions === 1 ? '' : 's'}`];
  if (report.sessions > 0) parts.push(formatBytes(report.bytes));
  if (report.titled > 0) parts.push(`${report.titled} titled`);
  if (report.archived > 0) parts.push(`${report.archived} archived`);
  const versions = Object.keys(report.versions).sort();
  if (versions.length > 0) parts.push(`cli ${versions.join(', ')}`);
  if (report.unsupportedVersions.length > 0) {
    parts.push(`${report.unsupportedVersions.join(', ')} < ${MIN_CODEX_VERSION}`);
  }
  if (report.unreadable.length > 0) parts.push(`${report.unreadable.length} unreadable`);
  return formatDoctorLine({
    harness: 'codex',
    status: 'ready',
    dir: report.sourceDir,
    note: parts.join(' \u00b7 '),
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
