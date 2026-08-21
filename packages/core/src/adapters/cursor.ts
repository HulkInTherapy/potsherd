/**
 * L0 adapter — Cursor's agent transcripts.
 *
 *   ~/.cursor/projects/<project-slug>/agent-transcripts/<uuid>/<uuid>.jsonl
 *   ~/.cursor/projects/<project-slug>/agent-transcripts/<uuid>/subagents/<uuid>.jsonl
 *
 * This is the thinnest transcript of any harness potsherd reads. Characterised
 * against the four real files on the author's machine (857 records, 2026-05-03
 * → 2026-05-08); see `docs/formats/cursor.md` for the full write-up. In short:
 *
 *   - **no `type` field.** Every record is exactly `{"role", "message"}` —
 *     two keys, 857/857. The discriminator is `role` (`user` | `assistant`).
 *   - **no ids.** No `uuid`, no `parentUuid`, no `sessionId`, and `tool_use`
 *     blocks carry no `id`. The only ordering information in the entire format
 *     is **line order**, so that is what `seq` counts.
 *   - **no tool results.** Zero `tool_result` blocks exist. The transcript
 *     records what the agent *asked for*, never what it got, so
 *     `Exchange.toolCalls[].result` is always `undefined` for cursor.
 *   - **timestamps only on user prompts**, as free text inside the prompt
 *     (`<timestamp>Friday, May 8, 2026, 6:05 AM (UTC+5:30)</timestamp>`), at
 *     minute precision. Assistant records are undated. Subagent transcripts
 *     have no timestamp at all, so their times come from file mtime.
 *   - **no title, no model, no git branch, no entrypoint.** Those live in
 *     VS Code's `workspaceStorage`/`globalStorage` sqlite, outside `~/.cursor`.
 *     `plans/00-README.md` names five read-only inputs and VS Code's private
 *     state is not one of them (`plans/04-DECISIONS.md`, 2026-08-21, "cursor
 *     adapter reads ~/.cursor only"). Those fields are therefore left
 *     **undefined**, and {@link CURSOR_DOCTOR_NOTE} says so out loud. An
 *     honest gap beats a silent guess.
 *
 * The one field this adapter recovers that the scout thought unknowable is
 * `project`: absolute paths appear in tool inputs, and a candidate directory
 * is accepted only when {@link cursorSlug} of it equals the project directory
 * name. That is a *check against the slug*, not a guess from it — see
 * {@link recoverCwd}.
 *
 * No model calls, no network (`03` §1). This file is potsherd's own.
 */

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
} from './types.js';
import { cursorDir, cursorProjectsDir } from '../paths.js';
import { formatDoctorLine } from '../doctor-line.js';
import { readJsonlLines, parseJsonLine } from '../parser/jsonl.js';
import { exchangeId } from '../parser/claude.js';
import { filesFromToolInput, isRecord, stringifyToolInput, uniq } from '../parser/content.js';

/** Directory name under `<cursor>/projects/<slug>/` holding the transcripts. */
export const TRANSCRIPTS_DIR = 'agent-transcripts';
/** Directory name whose presence marks a transcript as a subagent's. */
export const SIDECHAIN_DIR = 'subagents';

/**
 * The one line `doctor` prints under the cursor row. Every clause is a
 * verified absence, not a caveat: see the module header.
 */
export const CURSOR_DOCTOR_NOTE =
  'cursor: no timestamps on assistant turns (session times come from file mtime), ' +
  'no tool results recorded at all, and title/model/git-branch are unavailable — ' +
  "they live in VS Code's workspaceStorage, which potsherd does not read.";

/**
 * `cursorDir()` (overridable by `POTSHERD_CURSOR_DIR`) and
 * `cursorProjectsDir()` moved to `paths.ts` beside `claudeDir()` in T1.5, so
 * `doctor --privacy` enumerates every readable path from one module (F9).
 * Re-exported here because this is where a reader of the adapter looks.
 */
export { cursorDir, cursorProjectsDir } from '../paths.js';

/**
 * Cursor's project-directory slug: leading separators dropped, then every `/`
 * **and `_`** replaced by `-`. Verified both ways on this machine —
 * `/Users/zebra/maths_practice` → `Users-zebra-maths-practice` and
 * `/Users/zebra/Infant-State-Recognition-System` → itself with `/` swapped.
 *
 * The map is **not injective**: `/a/b_c` and `/a/b-c` slug identically, which
 * is why {@link recoverCwd} treats a slug match as corroboration of a path
 * found in the transcript rather than as a reconstruction of one.
 */
export function cursorSlug(cwd: string): string {
  return cwd.replace(/^[/\\]+/, '').replace(/[/\\_]/g, '-');
}

/** A project directory that is not a path slug at all. */
export type ProjectSlugKind = 'path' | 'window-id' | 'empty-window';

/**
 * Three shapes live under `projects/`, and only the first is a cwd:
 *   - a lossy path slug (`Users-zebra-maths-practice`);
 *   - a **millisecond epoch integer** (`1769488977462`) — a Cursor window that
 *     had no folder open, keyed by when the window was created;
 *   - the literal `empty-window`.
 * Discovery walks all three; only `path` ones can ever yield a `project`.
 */
export function classifyProjectSlug(slug: string): ProjectSlugKind {
  if (slug === 'empty-window') return 'empty-window';
  if (/^\d{10,}$/.test(slug)) return 'window-id';
  return 'path';
}

// ---------------------------------------------------------------- discover

/**
 * Walk `<cursor>/projects/*​/agent-transcripts/`. Cheap by contract: `readdir`
 * plus `stat`, never a parse.
 *
 * Everything here is defensive on purpose. The tree contains directories that
 * are not projects (`empty-window`, bare window ids), projects with no
 * `agent-transcripts/` at all, session directories that are empty, and a
 * zero-byte `.agent-data-cleanup-<date>` marker file proving Cursor prunes
 * this tree behind the user's back. None of those may throw.
 */
export function discover(dirOverride?: string): SessionSource[] {
  const root = cursorProjectsDir(dirOverride);
  const out: SessionSource[] = [];

  for (const slug of readdirSafe(root, 'dir')) {
    const transcripts = path.join(root, slug, TRANSCRIPTS_DIR);
    for (const sessionId of readdirSafe(transcripts, 'dir')) {
      const sessionDir = path.join(transcripts, sessionId);

      for (const file of readdirSafe(sessionDir, 'file')) {
        if (!file.endsWith('.jsonl')) continue;
        const source = statSource(path.join(sessionDir, file), slug, {
          sessionId: basenameId(file),
          isSidechain: false,
        });
        if (source) out.push(source);
      }

      const sidechains = path.join(sessionDir, SIDECHAIN_DIR);
      for (const file of readdirSafe(sidechains, 'file')) {
        if (!file.endsWith('.jsonl')) continue;
        const source = statSource(path.join(sidechains, file), slug, {
          sessionId: basenameId(file),
          isSidechain: true,
          parentSessionId: sessionId,
        });
        if (source) out.push(source);
      }
    }
  }

  // Deterministic order: the store and `doctor` both diff runs against each
  // other, and readdir order is filesystem-dependent.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function basenameId(file: string): string {
  return file.slice(0, -'.jsonl'.length);
}

function readdirSafe(dir: string, want: 'dir' | 'file'): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing, or not a directory, or unreadable. Never fatal.
  }
  const names: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // `.agent-data-cleanup-<date>`, `.DS_Store`
    if (want === 'dir' ? e.isDirectory() : e.isFile()) names.push(e.name);
  }
  return names.sort();
}

function statSource(
  file: string,
  projectSlug: string,
  rest: { sessionId: string; isSidechain: boolean; parentSessionId?: string },
): SessionSource | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  return {
    sessionId: rest.sessionId,
    harness: 'cursor',
    path: file,
    projectSlug,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    isSidechain: rest.isSidechain,
    ...(rest.parentSessionId ? { parentSessionId: rest.parentSessionId } : {}),
    status: 'live',
  };
}

// ------------------------------------------------------------------- parse

interface CursorBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

interface OpenExchange {
  seq: number;
  ts: string | undefined;
  userText: string;
  assistantTexts: string[];
  toolCalls: ExchangeToolCall[];
  files: string[];
}

/**
 * Parse one cursor transcript.
 *
 * **Ordering.** There is no timestamp on an assistant record and no id on
 * anything, so line order is the only ordering signal the format has. An
 * exchange opens on a genuine human `role:"user"` record and stays open until
 * the next one; every assistant record in between belongs to it. Runs reach 42
 * consecutive assistant records in the real files, and parallel tool calls
 * batch into a single record, so grouping on user boundaries is the only
 * grouping that reconstructs a turn.
 *
 * **The trailing line.** None of the four real files ends with a newline, so
 * `readJsonlLines` reports the final record as `terminated: false` — the same
 * signal it uses for a half-written line in a session still being appended to.
 * The two are told apart the only way they can be: a final unterminated line
 * that parses as JSON is a complete record and is consumed; one that does not
 * is left for the next run, with `endOffset` rewound to its first byte.
 */
export async function parse(source: SessionSource, options: ParseOptions = {}): Promise<ParseResult> {
  const sessionId = options.sessionId ?? source.sessionId;
  const projectSlug = options.projectSlug ?? source.projectSlug;
  const isSidechain = source.isSidechain;

  const unknownTypes: Record<string, number> = {};
  const bump = (key: string) => {
    unknownTypes[key] = (unknownTypes[key] ?? 0) + 1;
  };

  const exchanges: Exchange[] = [];
  const cwdCandidates: string[] = [];
  let malformedLines = 0;
  let endOffset = options.fromOffset ?? 0;
  let seq = options.fromSeq ?? 0;
  let userPrompts = 0;
  let assistantTurns = 0;
  let toolCallCount = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  let open: OpenExchange | undefined;

  const flush = () => {
    if (!open) return;
    exchanges.push({
      id: exchangeId(sessionId, open.seq),
      sessionId,
      seq: open.seq,
      // Every exchange needs a ts. A prompt with no `<timestamp>` (all of the
      // subagent ones) inherits the last one seen, and if there was none, the
      // session's mtime-derived start. Never invented, always explained.
      ts: open.ts ?? lastTs ?? firstTs ?? isoFromMs(source.mtimeMs),
      userText: open.userText,
      assistantText: open.assistantTexts.join('\n\n'),
      toolCalls: open.toolCalls,
      filesTouched: uniq(open.files),
      isSidechain,
      // No `parentUuid`: cursor records carry no ids of any kind, so an
      // exchange cannot name its parent. Left off rather than faked.
      redacted: false, // L2 redacts between here and the index.
    });
    open = undefined;
  };

  const openFor = (ts: string | undefined, userText: string) => {
    flush();
    seq += 1;
    open = { seq, ts, userText, assistantTexts: [], toolCalls: [], files: [] };
  };

  for await (const line of readJsonlLines(source.path, { start: options.fromOffset ?? 0 })) {
    const record = parseJsonLine(line.text);

    if (!line.terminated) {
      // The last line of the file, with no newline after it. For cursor that
      // is the normal case, not a symptom — but it is also exactly what a
      // half-written record looks like. Whole JSON means a whole record.
      if (record === undefined) {
        if (line.text.trim()) malformedLines += 1;
        break; // endOffset stays at this line's first byte: re-read next run.
      }
    }

    endOffset = line.end;

    if (record === undefined) {
      if (line.text.trim()) malformedLines += 1;
      continue;
    }
    if (!isRecord(record)) {
      bump('(not an object)');
      continue;
    }

    const role = record.role;
    const message = record.message;
    const content = isRecord(message) ? message.content : undefined;
    if (typeof role !== 'string') {
      bump('(no role)');
      continue;
    }
    if (!Array.isArray(content)) {
      bump(`role:${role} (no message.content)`);
      continue;
    }

    if (role === 'user') {
      const text = joinText(content, bump, role);
      const prompt = readPrompt(text);
      if (prompt.injected && open) {
        // A system-injected continuation ("Briefly inform the user about the
        // task result…"). It is not a human prompt and must not open a new
        // exchange: the assistant text that follows it still answers the
        // human turn already open. Counted so `doctor` can show it.
        bump('user:injected-continuation');
        continue;
      }
      if (prompt.ts) {
        if (!firstTs) firstTs = prompt.ts;
        lastTs = prompt.ts;
      }
      openFor(prompt.ts, prompt.text);
      userPrompts += 1;
      continue;
    }

    if (role !== 'assistant') {
      bump(`role:${role}`);
      continue;
    }

    assistantTurns += 1;
    // An assistant record before any user record (not seen in the four real
    // files, but a resumed parse starts mid-conversation). Open a headless
    // exchange rather than drop the text.
    if (!open) openFor(lastTs, '');

    for (const raw of content) {
      if (!isRecord(raw)) {
        bump('block:(not an object)');
        continue;
      }
      const block = raw as CursorBlock;
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text) open!.assistantTexts.push(block.text);
        continue;
      }
      if (block.type === 'tool_use') {
        toolCallCount += 1;
        open!.toolCalls.push({
          name: toolName(block.name),
          input: stringifyToolInput(block.input),
          // `result` is deliberately absent: cursor persists no tool output.
          // See CURSOR_DOCTOR_NOTE. `isError` is unknowable for the same reason.
        });
        for (const f of filesFromCursorInput(block.input)) open!.files.push(f);
        for (const p of absolutePaths(block.input)) cwdCandidates.push(p);
        continue;
      }
      bump(`block:${typeof block.type === 'string' ? block.type : String(block.type)}`);
    }
  }

  flush();

  const mtimeIso = isoFromMs(source.mtimeMs);
  // `startedAt`: the first prompt's own timestamp when the file has one,
  // otherwise the file's mtime — the subagent transcripts carry no timestamp
  // anywhere, so mtime is the only time signal they have.
  const startedAt = firstTs ?? mtimeIso;
  // `endedAt`: always mtime. The last user timestamp is not the end of the
  // session (an undated assistant run follows it), and mtime is the moment
  // Cursor last wrote the file. `max` guards a clock-skewed prompt stamp.
  const endedAt = mtimeIso >= (lastTs ?? '') ? mtimeIso : lastTs!;

  const session: SessionRecord = {
    id: sessionId,
    harness: 'cursor',
    sourcePath: source.path,
    // `project` is a *recovered* cwd: an absolute directory seen in this
    // session's own tool inputs whose cursorSlug() equals the project
    // directory name. Empty when nothing corroborates — window-id and
    // empty-window projects never have a cwd, and neither is invented.
    project: recoverCwd(projectSlug, cwdCandidates) ?? '',
    projectSlug,
    startedAt,
    endedAt,
    // title / gitBranch / entrypoint / model / agentName: **not knowable from
    // ~/.cursor**. Cursor keeps all four in VS Code's workspaceStorage and
    // globalStorage sqlite, which potsherd does not read. Left undefined.
    isSidechain,
    ...(source.parentSessionId ? { parentSessionId: source.parentSessionId } : {}),
    counts: {
      userPrompts,
      assistantTurns,
      toolCalls: toolCallCount,
      bytes: source.bytes,
    },
    status: source.status ?? 'live',
  };

  return { session, exchanges, unknownTypes, endOffset, malformedLines };
}

// ------------------------------------------------------------ prompt shapes

const TIMESTAMP_RE = /<timestamp>([^<]*)<\/timestamp>/;
const OPEN_QUERY = '<user_query>';
const CLOSE_QUERY = '</user_query>';

export interface CursorPrompt {
  /** The human text, with cursor's structural wrappers removed. */
  text: string;
  /** ISO time from the `<timestamp>` preamble, if the record had one. */
  ts?: string;
  /** True for cursor's own continuation prompts, which no human typed. */
  injected: boolean;
}

/**
 * Split a `role:"user"` record's text into (time, human text, is-it-human).
 *
 * All 109 user records in the corpus wrap their body in `<user_query>`, so the
 * tag alone proves nothing. **The discriminator is the character right after
 * the opening tag**: a genuine prompt is followed by a newline (105/109), a
 * system-injected continuation by text (4/109 — two fixed literals, one after
 * each `Subagent` call and one after each background task).
 *
 * Structural preambles sit *before* the first `<user_query>`: `<timestamp>`,
 * `[Image]` markers, `<image_files>` (note Cursor's own typo, "provdied") and
 * `<uploaded_documents>`. Tags *inside* the query are user-pasted content —
 * Python tracebacks contributed `<module>` — so only the region before the
 * first `<user_query>` is ever treated as structure.
 */
export function readPrompt(text: string): CursorPrompt {
  const open = text.indexOf(OPEN_QUERY);
  const preamble = open >= 0 ? text.slice(0, open) : text;
  const stamp = preamble.match(TIMESTAMP_RE);
  const ts = stamp ? parseCursorTimestamp(stamp[1]!) : undefined;

  if (open < 0) {
    // No wrapper at all — keep the whole record minus a leading timestamp.
    return { text: text.replace(TIMESTAMP_RE, '').trim(), injected: false, ...(ts ? { ts } : {}) };
  }

  const bodyStart = open + OPEN_QUERY.length;
  const injected = text[bodyStart] !== '\n';
  // Last closing tag, not the first: a pasted transcript can contain one.
  const close = text.lastIndexOf(CLOSE_QUERY);
  const body = close > bodyStart ? text.slice(bodyStart, close) : text.slice(bodyStart);
  return { text: body.trim(), injected, ...(ts ? { ts } : {}) };
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const CURSOR_TS_RE = new RegExp(
  '^(?:[A-Za-z]+,\\s*)?' + //            optional weekday
    '([A-Za-z]+)\\s+(\\d{1,2}),\\s*' + // month, day
    '(\\d{4}),\\s*' + //                 year
    '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*' + // h:mm[:ss]
    '([AaPp])\\.?[Mm]\\.?' + //          AM/PM
    '(?:\\s*\\(\\s*UTC(?:\\s*([+-]\\d{1,2})(?::?(\\d{2}))?)?\\s*\\))?\\s*$',
);

/**
 * `Friday, May 8, 2026, 6:05 AM (UTC+5:30)` → `2026-05-08T00:35:00.000Z`.
 *
 * Hand-rolled on purpose. **`new Date()` silently drops the offset**: V8 treats
 * `(UTC+5:30)` as a trailing comment and parses the rest in the *host's* zone,
 * so the same transcript would index at 00:35Z on the author's machine and
 * 06:05Z in a UTC CI container. That is a five-and-a-half-hour lie in every
 * `--since` filter, so the offset is read explicitly here.
 *
 * Precision is whatever cursor wrote: minutes. Returns `undefined` rather than
 * an invalid date if the shape is not recognised.
 */
export function parseCursorTimestamp(raw: string): string | undefined {
  const m = raw.trim().match(CURSOR_TS_RE);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return undefined;
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  const meridiem = m[7]!.toLowerCase();
  if (hour === 12) hour = 0;
  if (meridiem === 'p') hour += 12;
  if (day < 1 || day > 31 || minute > 59 || second > 59 || hour > 23) return undefined;

  // No offset means the zone is genuinely unknown; UTC is the honest default
  // and is what an absent offset means everywhere else in the codebase.
  const offsetHours = m[8] ? Number(m[8]) : 0;
  const offsetMinutes = m[9] ? Number(m[9]) : 0;
  const sign = m[8]?.startsWith('-') ? -1 : 1;
  const offset = offsetHours * 60 + sign * offsetMinutes;

  const ms = Date.UTC(year, month, day, hour, minute, second) - offset * 60_000;
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

// -------------------------------------------------------------- tool inputs

/**
 * `tool_use.name` is usually clean, but one record in the corpus leaked an
 * argument into it: `"Grep path\n/Users/…"`. Everything after the first
 * newline is dropped so the tool histogram in `doctor` and `stats` is not
 * polluted by a one-off; the full text survives in `toolCalls[].input`.
 */
export function toolName(name: unknown): string {
  if (typeof name !== 'string') return 'unknown';
  const first = name.split('\n')[0]!.trim();
  return first || 'unknown';
}

/** Extra keys cursor uses that the shared `filesFromToolInput` does not know. */
const CURSOR_FILE_KEYS = ['target_notebook', 'paths'] as const;

/** `*** Add File: /a/b.md`, `*** Update File: …`, `*** Delete File: …`. */
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm;

/**
 * Files a cursor tool call touched.
 *
 * Two cursor-only wrinkles on top of the shared extractor:
 *  - `tool_use.input` is **polymorphic** — an object 838× but a raw string
 *    120×, every one of them an `ApplyPatch` V4A patch up to 15 kB. Reaching
 *    for `input.path` on those yields `undefined` at best.
 *  - directory-valued keys (`target_directory`, `working_directory`,
 *    `target_directories`) are deliberately excluded: `filesTouched` is files.
 */
export function filesFromCursorInput(input: unknown): string[] {
  if (typeof input === 'string') {
    const out: string[] = [];
    for (const m of input.matchAll(PATCH_FILE_RE)) {
      const file = m[1]!.trim();
      if (file) out.push(file);
    }
    return uniq(out);
  }
  if (!isRecord(input)) return [];
  const out = filesFromToolInput(input);
  for (const key of CURSOR_FILE_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim()) out.push(item);
    }
  }
  return uniq(out);
}

/** Every absolute path anywhere in a tool input, for {@link recoverCwd}. */
function absolutePaths(input: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (value.startsWith('/') && !value.includes('\n')) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  if (typeof input === 'string') {
    for (const m of input.matchAll(PATCH_FILE_RE)) {
      const file = m[1]!.trim();
      if (file.startsWith('/')) out.push(file);
    }
    return out;
  }
  visit(input, 0);
  return out;
}

/**
 * Recover the session's working directory from `~/.cursor` alone.
 *
 * The project directory name is a lossy slug — `_` and `/` both became `-`, so
 * it cannot be inverted. But the transcript is full of absolute paths, and a
 * candidate directory that *slugs to exactly this project's name* is
 * corroborated by two independent facts. Both real projects resolve:
 * `Users-zebra-maths-practice` → `/Users/zebra/maths_practice` (the underscore
 * case, unreachable by inversion) and
 * `Users-zebra-Infant-State-Recognition-System` → the literal-hyphen case.
 *
 * This is corroboration, not proof: a sibling `/a/b_c` would satisfy the same
 * slug as `/a/b-c`. It is still strictly better than inventing a path, and it
 * returns `undefined` — never a guess — when nothing in the file agrees.
 */
export function recoverCwd(projectSlug: string, candidates: readonly string[]): string | undefined {
  if (classifyProjectSlug(projectSlug) !== 'path') return undefined;
  const hits = new Map<string, number>();
  for (const candidate of candidates) {
    let dir = candidate;
    for (let depth = 0; depth < 32 && dir !== '/' && dir !== '.'; depth += 1) {
      if (cursorSlug(dir) === projectSlug) {
        hits.set(dir, (hits.get(dir) ?? 0) + 1);
        break; // ancestors of a match cannot also match
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [dir, count] of [...hits].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

// --------------------------------------------------------------- small bits

function joinText(content: readonly unknown[], bump: (k: string) => void, role: string): string {
  const parts: string[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) {
      bump('block:(not an object)');
      continue;
    }
    if (raw.type === 'text') {
      if (typeof raw.text === 'string') parts.push(raw.text);
      continue;
    }
    bump(`${role}/block:${typeof raw.type === 'string' ? raw.type : String(raw.type)}`);
  }
  return parts.join('\n');
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The `doctor` line for cursor. The caveats live in {@link CURSOR_DOCTOR_NOTE},
 * which `doctor` prints under the block: they are verified absences, not a
 * health warning about this machine.
 */
export function doctorLine(dirOverride?: string): string {
  const dir = cursorProjectsDir(dirOverride);
  let found: SessionSource[] = [];
  try {
    found = discover(dirOverride);
  } catch {
    found = [];
  }
  const exists = fs.existsSync(dir);
  const sidechains = found.filter((f) => f.isSidechain).length;
  const sessions = found.length - sidechains;
  const parts = [`${sessions} session${sessions === 1 ? '' : 's'}`];
  if (sidechains > 0) parts.push(`${sidechains} sidechains`);
  parts.push('no titles, no tool results');
  return formatDoctorLine({
    harness: 'cursor',
    status: exists || found.length > 0 ? 'ready' : 'absent',
    dir,
    note: exists || found.length > 0 ? parts.join(' \u00b7 ') : 'Cursor not installed',
  });
}

export const cursorAdapter: Adapter = {
  harness: 'cursor',
  displayName: 'Cursor',
  sourceDir: () => cursorDir(),
  discover: () => discover(),
  parse,
};
