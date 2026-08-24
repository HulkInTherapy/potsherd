/**
 * L0 adapter — GitHub Copilot CLI session state.
 *
 *   ~/.copilot/session-state/<session-id>/state.json
 *   ~/.copilot/session-state/<session-id>.json
 *   ~/.copilot/session-state/<session-id>.jsonl
 *
 * ## PROVENANCE — **verified 24 aug 2026, and WRONG**
 *
 * Phase 10 installed Copilot CLI 1.0.80 and ran a real session against this
 * adapter. Two things came out of it, and the second is why the label changed
 * rather than being dropped.
 *
 * The path was never wrong. `08 §3` recorded the anomaly that the Copilot CLI
 * "has run here and has still written no `session-state/`" — and the reason is
 * that every run on that machine had been `server mode (stdio)`, which creates
 * nothing. One `copilot -p` created the directory first try.
 *
 * The FORMAT is wrong. That directory holds `workspace.yaml`, `checkpoints/`
 * and `rewind-file-snapshots/`, and none of `STATE_FILES`. The conversation is
 * in `~/.copilot/session-store.db`. So potsherd reports **0 sessions on a
 * working install**, which is worse than the old label admitted: an adapter
 * that returns nothing is not unverified, it is broken, and the difference
 * matters to somebody deciding whether to trust the number.
 *
 * Not fixed here on purpose: one session is a sample of one, and shaping a
 * parser to it is how a documented format gets broken. `tests/adapters/` holds
 * a tripwire that fails the moment somebody implements the sqlite read path,
 * so the fix cannot land without its evidence.
 *
 * **Nothing here was measured against a real Copilot transcript.** `~/.copilot`
 * exists on the reference machine and Copilot CLI has demonstrably *run* on it
 * — `~/.copilot/logs/` holds process logs from 2026-08 showing the CLI starting
 * in stdio server mode — but there is **no `session-state/` directory at all**,
 * so not one transcript was available to parse.
 * `plans/research/formats.md` marks its copilot section **unmeasured**: "only
 * logs here, nothing has been parsed."
 *
 * That gap is itself worth stating: a harness can be installed, can have run,
 * and can still leave this adapter nothing to read. {@link doctorLine}
 * distinguishes that case ("installed, no sessions") from a missing install,
 * because they call for completely different things from the user.
 *
 * So, as with gemini and opencode and phase 5's four MCP clients: written from
 * documentation, exercised against synthetic fixtures, structurally defensive,
 * and labelled `unverified` in the header, the doctor line and the doctor note.
 *
 * ## the shapes accepted
 *
 * Three layouts are read, because the documentation does not pin one:
 *
 *   1. a per-session **directory** holding `state.json` (also accepted:
 *      `session.json`, `messages.json`, `history.json`, `state.jsonl`);
 *   2. a flat `<id>.json` file;
 *   3. a flat `<id>.jsonl` file, one record per line.
 *
 * and within a document, both an array of turns and an object wrapping one
 * under `messages` / `history` / `turns` / `events` / `state`. Metadata is read
 * off the wrapper when present — `sessionId`, `cwd`, `model`, `gitBranch`,
 * `startTime`, `lastUpdated`, `title` — and **invented when absent**, never.
 *
 * A turn is `{role, content}` where content is a string or an array of blocks.
 * Block types understood are `text`, `tool_call`/`function_call`/`tool_use`
 * and `tool_result`/`function_response`; every other block type is counted as
 * `block:<type>` and every unhandled role as `role:<r>`, so `doctor` shows the
 * exact shape of the gap (`03 §2`: counted, not fatal).
 *
 * ## the cursor ruling applies here too
 *
 * Copilot also keeps chat state inside VS Code
 * (`workspaceStorage/…/chatSessions/`). That is **not** read.
 * `plans/00-README.md` names the read-only inputs and VS Code's private state
 * is not among them; `plans/04-DECISIONS.md` (2026-08-21) settled the same
 * question for cursor by holding the adapter to `~/.cursor` only. This adapter
 * reads `~/.copilot` and nothing else, and {@link COPILOT_DOCTOR_NOTE} says so
 * rather than leaving the user to wonder why their IDE chats are missing.
 *
 * No model calls, no network (`03 §1`). This file is potsherd's own.
 */

import fs from 'node:fs';
import path from 'node:path';

import type {
  Adapter,
  Exchange,
  ExchangeToolCall,
  FormatProvenance,
  ParseOptions,
  ParseResult,
  SessionRecord,
  SessionSource,
  SessionStatus,
} from './types.js';
import { copilotDir, copilotSessionStateDir } from '../paths.js';
import { formatDoctorLine } from '../doctor-line.js';
import {
  filesFromToolInput,
  isRecord,
  safeParseJson,
  stringifyToolInput,
  stringifyToolOutput,
  uniq,
} from '../parser/content.js';
import { exchangeId } from '../parser/claude.js';

export { copilotDir, copilotSessionStateDir } from '../paths.js';

export const DISPLAY_NAME = 'Copilot CLI';

/** File names checked inside a per-session directory, most likely first. */
const STATE_FILES = [
  'state.json',
  'session.json',
  'messages.json',
  'history.json',
  'state.jsonl',
  'messages.jsonl',
] as const;

/**
 * T6.6 D6 — the provenance, as a boolean rather than as prose.
 *
 * `COPILOT_DOCTOR_NOTE` says this in a sentence, and `doctorLine()` says it in a
 * word — but the rendered line is clipped to the terminal's width, and when
 * the tool is **absent** it does not carry the word at all. Absent is this
 * adapter's state on every machine that does not have the tool. `doctor
 * --json` is the documented API, and an API cannot ask a caller to grep a
 * width-dependent sentence for an adjective. So the fact is a field.
 */
export const COPILOT_FORMAT_UNVERIFIED = true;

export const COPILOT_DOCTOR_NOTE =
  'copilot: format WRONG, measured — a real Copilot CLI 1.0.80 session was run against this ' +
  'adapter on 24 aug 2026. The directory it looks in is right and its contents are not: ' +
  'session-state/<id>/ holds workspace.yaml, checkpoints/ and rewind-file-snapshots/ and none ' +
  'of the files this adapter reads, so potsherd finds 0 sessions on a working install. The ' +
  'turns are in ~/.copilot/session-store.db, table turns(session_id, turn_index, user_message, ' +
  'assistant_response), which this adapter does not open. This is not "unverified"; it is ' +
  "verified and broken. potsherd reads ~/.copilot only: Copilot's VS Code chats live in " +
  'workspaceStorage, which is not one of the read-only inputs potsherd is allowed.';

/**
 * The split label as fields. See {@link FormatProvenance} for why a boolean
 * could not hold this any more, and `T10.12-LABELS.md` §5 for the run: one
 * `copilot -p` under a relocated HOME created `session-state/<uuid>/` on the
 * first attempt, unauthenticated, and it held none of the six files
 * {@link STATE_FILES} looks for.
 *
 * `unverified` stays `true` on that file's own instruction — the sqlite store
 * holding the turns has still never been opened by this adapter — but "nobody
 * looked" is no longer what it means, and {@link verified} says what a reader
 * would otherwise have to infer: the *path* was never the defect.
 */
export const COPILOT_FORMAT_PROVENANCE: FormatProvenance = {
  measured: 'Copilot CLI 1.0.80, 24 aug 2026',
  verified: ['session-state/<id>/ is the right directory and is created on first CLI run'],
  wrong: [
    'none of STATE_FILES is written there — the directory holds workspace.yaml, checkpoints/ and rewind-file-snapshots/',
    'the turns are in ~/.copilot/session-store.db, table turns(session_id, turn_index, user_message, assistant_response), which this adapter does not open',
  ],
  unverified: COPILOT_FORMAT_UNVERIFIED,
  note: COPILOT_DOCTOR_NOTE,
};

/** Keys a wrapper object may carry the turn array under. */
const HISTORY_KEYS = ['messages', 'history', 'turns', 'events', 'state'] as const;

/** `role` values understood as a human prompt. */
const USER_ROLES = new Set(['user', 'human', 'prompt']);
/** `role` values understood as a model turn. */
const ASSISTANT_ROLES = new Set(['assistant', 'model', 'agent', 'copilot']);
/** `role` values understood as tool output coming back. */
const TOOL_ROLES = new Set(['tool', 'function', 'tool_result', 'toolresult']);

export function sourceDir(override?: string): string {
  return copilotSessionStateDir(override);
}

/**
 * Walk `<copilot>/session-state/`. A `readdir` + `stat` only: nothing is
 * opened here, per the {@link SessionSource} contract.
 *
 * Both layouts are handled in one pass — a directory contributes its state
 * file, a flat `.json`/`.jsonl` contributes itself. A per-session directory
 * with no recognisable state file is **counted by `doctor` as unreadable**
 * rather than skipped silently, because a session potsherd can see but cannot
 * open is exactly the thing this project exists to stop happening quietly.
 */
export function discover(override?: string): SessionSource[] {
  return scan(override).sources;
}

export interface CopilotScan {
  sources: SessionSource[];
  /** Session directories that exist but hold no file this adapter recognises. */
  unreadable: string[];
}

export function scan(override?: string): CopilotScan {
  const root = sourceDir(override);
  const sources: SessionSource[] = [];
  const unreadable: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { sources, unreadable }; // copilot not installed, or no sessions
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const state = stateFileIn(full);
      if (!state) {
        unreadable.push(full);
        continue;
      }
      const src = sourceFor(state, entry.name);
      if (src) sources.push(src);
      else unreadable.push(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.json' && ext !== '.jsonl') continue;
    const src = sourceFor(full, path.basename(entry.name, ext));
    if (src) sources.push(src);
  }

  sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  unreadable.sort();
  return { sources, unreadable };
}

/** The first recognised state file inside a per-session directory. */
export function stateFileIn(dir: string): string | undefined {
  for (const name of STATE_FILES) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

function sourceFor(file: string, sessionId: string): SessionSource | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  return {
    sessionId,
    harness: 'copilot',
    path: file,
    // Copilot's session-state directory is flat — it is keyed by session, not
    // by project — so there is no harness slug to report. Left empty rather
    // than filled with something that is not one.
    projectSlug: '',
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    isSidechain: false,
    status: 'live',
  };
}

export interface CopilotParseOptions extends ParseOptions {
  status?: SessionStatus;
  bytes?: number;
  mtimeMs?: number;
}

export async function parse(
  source: SessionSource | string,
  options: CopilotParseOptions = {},
): Promise<ParseResult> {
  const src: SessionSource | undefined = typeof source === 'string' ? undefined : source;
  const absolute = path.resolve(typeof source === 'string' ? source : source.path);

  const unknownTypes: Record<string, number> = {};
  let malformedLines = 0;

  let raw = '';
  try {
    raw = fs.readFileSync(absolute, 'utf8');
  } catch {
    raw = '';
  }
  // One document (or one whole jsonl file) per session, so there is no partial
  // read to resume: `fromOffset` is accepted and deliberately ignored, as it is
  // for pi and gemini, and exchange ids stay a pure function of
  // `(sessionId, seq)` so a re-parse is an upsert rather than a duplicate.
  const endOffset = Buffer.byteLength(raw, 'utf8');

  const { turns, meta, malformed } = readDocument(absolute, raw);
  malformedLines += malformed;

  const sessionId =
    options.sessionId ??
    (meta && typeof meta['sessionId'] === 'string' && meta['sessionId'].trim()
      ? (meta['sessionId'] as string)
      : (src?.sessionId ?? sessionIdFromPath(absolute)));

  const mtimeMs = options.mtimeMs ?? src?.mtimeMs ?? statMtime(absolute);
  const fileTime = mtimeMs ? new Date(mtimeMs).toISOString() : '';

  const counts = { userPrompts: 0, assistantTurns: 0, toolCalls: 0 };
  const built = buildExchanges(turns, sessionId, fileTime, counts, unknownTypes);

  const str = (...keys: string[]): string | undefined => {
    if (!meta) return undefined;
    for (const key of keys) {
      const v = meta[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
  };

  const startedAt = str('startTime', 'startedAt', 'createdAt') ?? built.firstTs ?? fileTime;
  const endedAt = str('lastUpdated', 'updatedAt', 'endedAt') ?? built.lastTs ?? fileTime;
  const cwd = str('cwd', 'workingDirectory', 'projectRoot', 'directory');
  const title = str('title', 'name', 'summary');
  const model = str('model', 'modelId') ?? built.model;
  const gitBranch = str('gitBranch', 'branch');

  const session: SessionRecord = {
    id: sessionId,
    harness: 'copilot',
    sourcePath: absolute,
    project: cwd ?? '',
    // `??` is wrong here: `discover()` deliberately sets `projectSlug` to the
    // empty string because copilot's session-state directory is keyed by
    // session, not by project — and an empty string is not nullish, so `??`
    // would let it beat a slug we can actually derive from the cwd.
    projectSlug: options.projectSlug || src?.projectSlug || (cwd ? path.basename(cwd) : ''),
    startedAt,
    endedAt: endedAt < startedAt ? startedAt : endedAt,
    ...(title ? { title } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    entrypoint: 'cli',
    ...(model ? { model } : {}),
    isSidechain: false,
    counts: {
      userPrompts: counts.userPrompts,
      assistantTurns: counts.assistantTurns,
      toolCalls: counts.toolCalls,
      bytes: options.bytes ?? src?.bytes ?? endOffset,
    },
    status: options.status ?? src?.status ?? 'live',
  };

  return { session, exchanges: built.exchanges, unknownTypes, endOffset, malformedLines };
}

/** `.../<id>/state.json` -> `<id>`; `.../<id>.json` -> `<id>`. */
export function sessionIdFromPath(file: string): string {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  if ((STATE_FILES as readonly string[]).includes(path.basename(file))) {
    return path.basename(path.dirname(file));
  }
  return base;
}

/**
 * Read either a JSON document or a JSONL stream into turns plus optional
 * metadata. A `.jsonl` file's records are the turns; a metadata record (one
 * with no `role` but a `sessionId` or `cwd`) becomes the wrapper, which is how
 * a header line is handled without assuming there is one.
 */
function readDocument(
  file: string,
  raw: string,
): { turns: unknown[]; meta?: Record<string, unknown>; malformed: number } {
  if (!raw.trim()) return { turns: [], malformed: 0 };

  if (path.extname(file).toLowerCase() === '.jsonl') {
    const turns: unknown[] = [];
    let meta: Record<string, unknown> | undefined;
    let malformed = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parsed = safeParseJson(line.trim());
      if (typeof parsed === 'string') {
        // `safeParseJson` returns its own input on failure (see
        // `parser/content.ts`), and a bare JSON string is not a record, so
        // either way this line is not a turn.
        malformed += 1;
        continue;
      }
      if (!isRecord(parsed)) {
        malformed += 1;
        continue;
      }
      if (parsed['role'] === undefined && (parsed['sessionId'] || parsed['cwd'] || parsed['model'])) {
        meta ??= parsed;
        continue;
      }
      turns.push(parsed);
    }
    return { turns, ...(meta ? { meta } : {}), malformed };
  }

  const doc = safeParseJson(raw.trim());
  if (typeof doc === 'string' || doc === undefined) return { turns: [], malformed: 1 };
  if (Array.isArray(doc)) return { turns: doc, malformed: 0 };
  if (!isRecord(doc)) return { turns: [], malformed: 1 };
  for (const key of HISTORY_KEYS) {
    const v = doc[key];
    if (Array.isArray(v)) return { turns: v, meta: doc, malformed: 0 };
    // `state` may itself be an object wrapping the turns.
    if (key === 'state' && isRecord(v)) {
      for (const inner of HISTORY_KEYS) {
        const iv = v[inner];
        if (Array.isArray(iv)) return { turns: iv, meta: { ...doc, ...v }, malformed: 0 };
      }
    }
  }
  return { turns: [], meta: doc, malformed: 0 };
}

/**
 * Turns -> `Exchange[]`. An exchange opens on a user turn and absorbs every
 * assistant turn and tool result until the next one. A turn arriving before
 * any user turn opens an exchange with an empty user side rather than being
 * dropped.
 */
function buildExchanges(
  turns: readonly unknown[],
  sessionId: string,
  fileTime: string,
  counts: { userPrompts: number; assistantTurns: number; toolCalls: number },
  unknownTypes: Record<string, number>,
): { exchanges: Exchange[]; firstTs?: string; lastTs?: string; model?: string } {
  const out: Exchange[] = [];
  let seq = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let model: string | undefined;

  let current: {
    seq: number;
    ts: string;
    userTexts: string[];
    assistantTexts: string[];
    toolCalls: ExchangeToolCall[];
    byId: Map<string, number>;
    files: string[];
  } | null = null;

  const finalize = (): void => {
    if (!current) return;
    const b = current;
    current = null;
    if (!b.userTexts.length && !b.assistantTexts.length && !b.toolCalls.length) return;
    out.push({
      id: exchangeId(sessionId, b.seq),
      sessionId,
      seq: b.seq,
      ts: b.ts || fileTime,
      userText: b.userTexts.join('\n\n'),
      assistantText: b.assistantTexts.join('\n\n'),
      toolCalls: b.toolCalls,
      filesTouched: uniq(b.files),
      isSidechain: false,
      redacted: false,
    });
  };

  const open = (ts: string) => {
    seq += 1;
    current = {
      seq,
      ts,
      userTexts: [],
      assistantTexts: [],
      toolCalls: [],
      byId: new Map(),
      files: [],
    };
    return current;
  };

  for (const turn of turns) {
    if (!isRecord(turn)) {
      unknownTypes['(not an object)'] = (unknownTypes['(not an object)'] ?? 0) + 1;
      continue;
    }
    const role = String(turn['role'] ?? turn['type'] ?? '').toLowerCase();
    const ts = isoOf(turn['timestamp'] ?? turn['time'] ?? turn['createdAt'] ?? turn['ts']) ?? '';
    if (ts) {
      firstTs ??= ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    if (typeof turn['model'] === 'string' && turn['model']) model = turn['model'];

    const blocks = blocksOf(turn);

    if (USER_ROLES.has(role) && !onlyToolResults(blocks)) {
      finalize();
      counts.userPrompts += 1;
      const b = open(ts);
      absorb(b, blocks, counts, unknownTypes, /* asUser */ true);
      continue;
    }

    const b = current ?? open(ts);
    if (ASSISTANT_ROLES.has(role)) {
      counts.assistantTurns += 1;
    } else if (!USER_ROLES.has(role) && !TOOL_ROLES.has(role)) {
      // Counted, never dropped; its text still lands on the assistant side.
      const key = `role:${role || '(no role)'}`;
      unknownTypes[key] = (unknownTypes[key] ?? 0) + 1;
    }
    absorb(b, blocks, counts, unknownTypes, /* asUser */ false);
  }

  finalize();
  return {
    exchanges: out,
    ...(firstTs ? { firstTs } : {}),
    ...(lastTs ? { lastTs } : {}),
    ...(model ? { model } : {}),
  };
}

interface Builder {
  userTexts: string[];
  assistantTexts: string[];
  toolCalls: ExchangeToolCall[];
  byId: Map<string, number>;
  files: string[];
}

function absorb(
  b: Builder,
  blocks: readonly Record<string, unknown>[],
  counts: { toolCalls: number },
  unknownTypes: Record<string, number>,
  asUser: boolean,
): void {
  for (const block of blocks) {
    const type = String(block['type'] ?? '').toLowerCase();

    if (type === 'text' || (!type && typeof block['text'] === 'string')) {
      const text = typeof block['text'] === 'string' ? block['text'] : '';
      if (!text) continue;
      if (asUser) b.userTexts.push(text);
      else if (text.trim()) b.assistantTexts.push(text);
      continue;
    }

    if (type === 'tool_call' || type === 'tool-call' || type === 'function_call' || type === 'tool_use') {
      const fn = isRecord(block['function']) ? block['function'] : {};
      const name = String(block['name'] ?? fn['name'] ?? block['tool'] ?? 'unknown');
      const rawArgs = block['arguments'] ?? fn['arguments'] ?? block['input'] ?? block['args'];
      // OpenAI-style tool calls put arguments in a JSON *string*; parse it so
      // `filesFromToolInput` sees an object rather than a blob of text.
      const args = typeof rawArgs === 'string' ? safeParseJson(rawArgs) : rawArgs;
      b.toolCalls.push({ name, input: stringifyToolInput(args) });
      counts.toolCalls += 1;
      const id = block['id'] ?? block['tool_call_id'] ?? block['toolCallId'];
      if (typeof id === 'string' && id) b.byId.set(id, b.toolCalls.length - 1);
      else b.byId.set(`name:${name}`, b.toolCalls.length - 1);
      for (const f of filesFromToolInput(args)) b.files.push(f);
      continue;
    }

    if (
      type === 'tool_result' ||
      type === 'tool-result' ||
      type === 'function_response' ||
      type === 'tool_response'
    ) {
      const name = String(block['name'] ?? block['tool'] ?? 'unknown');
      const id = block['tool_call_id'] ?? block['toolCallId'] ?? block['id'];
      const result = stringifyToolOutput(
        block['content'] ?? block['output'] ?? block['result'] ?? block['response'],
      );
      const isError = block['is_error'] === true || block['isError'] === true || undefined;
      const key = typeof id === 'string' && id ? id : `name:${name}`;
      const at = b.byId.get(key);
      if (at !== undefined) {
        const call = b.toolCalls[at];
        if (call) {
          if (result !== undefined) call.result = result;
          if (isError) call.isError = true;
        }
        b.byId.delete(key);
        continue;
      }
      // Orphan result: the call is outside this file, or the state was
      // truncated. Kept as a call of its own rather than discarded.
      b.toolCalls.push({
        name,
        input: '',
        ...(result !== undefined ? { result } : {}),
        ...(isError ? { isError: true } : {}),
      });
      counts.toolCalls += 1;
      continue;
    }

    const key = `block:${type || '(no type)'}`;
    unknownTypes[key] = (unknownTypes[key] ?? 0) + 1;
  }
}

/** A turn's content blocks, tolerating a bare-string content. */
function blocksOf(turn: Record<string, unknown>): Record<string, unknown>[] {
  const content = turn['content'] ?? turn['parts'] ?? turn['blocks'];
  const out: Record<string, unknown>[] = [];
  if (typeof content === 'string') out.push({ type: 'text', text: content });
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === 'string') out.push({ type: 'text', text: c });
      else if (isRecord(c)) out.push(c);
    }
  } else if (isRecord(content)) {
    out.push(content);
  }
  // A turn may also carry `tool_calls` beside its content, OpenAI-style.
  const calls = turn['tool_calls'] ?? turn['toolCalls'];
  if (Array.isArray(calls)) {
    for (const c of calls) if (isRecord(c)) out.push({ type: 'tool_call', ...c });
  }
  return out;
}

/**
 * True when every block is tool output. Such a `user` turn is the harness
 * feeding a result back, not a human prompt, so counting it as one would put
 * machine text into `counts.userPrompts` — the same trap Claude Code's
 * `tool_result` sets (`03 §2`).
 */
function onlyToolResults(blocks: readonly Record<string, unknown>[]): boolean {
  if (blocks.length === 0) return false;
  return blocks.every((b) => {
    const t = String(b['type'] ?? '').toLowerCase();
    return t === 'tool_result' || t === 'tool-result' || t === 'function_response' || t === 'tool_response';
  });
}

/** ISO text or epoch ms/seconds; anything else is `undefined`, never `Invalid Date`. */
export function isoOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+$/.test(value.trim())) return isoOf(Number(value.trim()));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function statMtime(absolute: string): number {
  try {
    return fs.statSync(absolute).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The `doctor` line for copilot. Three states said plainly, because "0
 * sessions" alone cannot distinguish them — and on the machine this adapter
 * was written on, the middle one is the true answer: Copilot CLI is installed
 * and has run, and `session-state/` does not exist.
 *
 *   absent   ~/.copilot does not exist — Copilot CLI is not installed
 *   empty    installed, but no session-state/ or no sessions in it
 *   ready    parsed
 */
export function doctorLine(override?: string): string {
  const dir = sourceDir(override);
  const root = copilotDir(override);
  let found: CopilotScan = { sources: [], unreadable: [] };
  try {
    found = scan(override);
  } catch {
    found = { sources: [], unreadable: [] };
  }
  const installed = fs.existsSync(root);
  const stateExists = fs.existsSync(dir);

  let status: string;
  let note: string;
  if (found.sources.length > 0) {
    const parts = [`${found.sources.length} session${found.sources.length === 1 ? '' : 's'}`];
    if (found.unreadable.length) {
      parts.push(`${found.unreadable.length} unreadable`);
    }
    // Self-sufficient on purpose. This line used to end "see doctor --json",
    // and `doctor --json` carries a bare `unverified: true` that reads as
    // *nobody looked* — so the one surface it sent a reader to was the one
    // that contradicted it. It names the defect itself now.
    parts.push('format known wrong at 1.0.80 — turns are in session-store.db');
    status = 'ready';
    note = parts.join(' · ');
  } else if (installed || stateExists) {
    status = 'empty';
    note = stateExists
      ? 'Copilot CLI installed · the turns are in session-store.db, which this adapter does not read'
      : 'Copilot CLI installed, but it has written no session-state/ · run it once outside server mode';
  } else {
    status = 'absent';
    note = 'Copilot CLI not installed';
  }
  return formatDoctorLine({ harness: 'copilot', status, dir, note });
}

/** The adapter, as `doctor` / `index` / `stats` consume it. */
export const copilotAdapter: Adapter = {
  harness: 'copilot',
  displayName: DISPLAY_NAME,
  sourceDir: () => sourceDir(),
  discover: () => discover(),
  parse: (src, opts) => parse(src, opts ?? {}),
};

export default copilotAdapter;
