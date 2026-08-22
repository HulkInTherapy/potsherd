/**
 * L0 adapter — Gemini CLI chat checkpoints.
 *
 *   ~/.gemini/tmp/<project-hash>/chats/<name>.json
 *
 * ## PROVENANCE — `unverified — documentation only`
 *
 * **Nothing in this file was measured against a real Gemini CLI transcript.**
 * `~/.gemini` exists on the reference machine but holds no `tmp/` directory
 * and no chat checkpoints at all — only Google Antigravity's own state
 * (`antigravity/conversations/*.pb`, a protobuf format belonging to a
 * different product, out of scope for this adapter and for `03 §2`'s
 * `gemini` harness). `plans/research/formats.md` marks its gemini section
 * **unmeasured** in so many words: "treat every line above as a lead, not a
 * fact."
 *
 * So this parser is written the way phase 5 wrote the four unverified MCP
 * clients: **structurally defensive, and loud about it.** It accepts every
 * plausible on-disk shape rather than betting on one, counts anything it does
 * not recognise (`03 §2`: unknown record types are counted, not fatal), and
 * {@link GEMINI_DOCTOR_NOTE} tells the user to their face that the format is
 * unverified. When someone runs this against a real checkpoint, the shape it
 * actually finds should be measured, written into `research/formats.md`, and
 * this header replaced with the measurement.
 *
 * ## the shapes accepted
 *
 * Gemini CLI persists a chat as a JSON array of `Content` objects — the
 * `@google/genai` wire type — so the leading candidate is:
 *
 * ```json
 * [ {"role": "user",  "parts": [{"text": "..."}]},
 *   {"role": "model", "parts": [{"text": "..."},
 *                               {"functionCall": {"name": "...", "args": {}}}]},
 *   {"role": "user",  "parts": [{"functionResponse": {"name": "...",
 *                                                     "response": {}}}]} ]
 * ```
 *
 * Three things follow from that shape and all three are handled:
 *
 *   1. **the assistant role is `model`, not `assistant`.** Both are accepted.
 *   2. **a tool result arrives as a `user` turn.** A `user` `Content` whose
 *      parts are *only* `functionResponse` is not a human prompt — it is the
 *      harness feeding output back. Treating it as a prompt would inflate
 *      `counts.userPrompts` with machine text, so {@link isHumanTurn} requires
 *      at least one non-`functionResponse` part. This is the same
 *      discriminator problem Claude Code's `tool_result` poses (`03 §2`).
 *   3. **there are no ids and no timestamps** inside the array. Ordering is
 *      array order, so that is what `seq` counts, and session times come from
 *      the file's own mtime — recorded plainly in the doctor note rather than
 *      guessed at.
 *
 * A wrapper object is also accepted, because `/chat save` may well store
 * metadata beside the history: any object with a `history`, `messages`,
 * `contents` or `turns` array is unwrapped, and `sessionId`, `startTime`/
 * `startedAt`, `lastUpdated`/`updatedAt`, `cwd`, `model` and `gitBranch` are
 * read off it when present. Every one of those is optional; none is invented.
 *
 * ## project recovery — a check against the hash, never a guess from it
 *
 * The directory under `tmp/` is a **hash of the project path**, not the path.
 * A hash cannot be inverted, so `project` is *not* reconstructed from it.
 * Instead {@link recoverCwd} does what the cursor adapter does with its slug:
 * collect absolute paths seen in tool-call arguments, walk each one and its
 * ancestors, and accept a candidate only when its hash **equals** the
 * directory name. That is corroboration, not reconstruction — and because the
 * exact hash Gemini CLI uses is itself unverified, {@link projectHashes} tries
 * the plausible constructions (sha256 of the path, of the path with a trailing
 * separator stripped) and accepts a match from any. When nothing matches,
 * `project` is `''` and the doctor note says the path is unrecoverable.
 *
 * Staying inside `~/.gemini` is not a preference, it is the standing ruling:
 * `plans/04-DECISIONS.md` (2026-08-21) held that the cursor adapter reads
 * `~/.cursor` only, because VS Code's `workspaceStorage` is not one of the
 * read-only inputs `00-README.md` names. The same reasoning binds here.
 *
 * No model calls, no network (`03 §1`). This file is potsherd's own.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
import { geminiDir, geminiTmpDir } from '../paths.js';
import { formatDoctorLine } from '../doctor-line.js';
import {
  filesFromToolInput,
  isRecord,
  stringifyToolInput,
  stringifyToolOutput,
  uniq,
} from '../parser/content.js';
import { exchangeId } from '../parser/claude.js';

export { geminiDir, geminiTmpDir } from '../paths.js';

export const DISPLAY_NAME = 'Gemini CLI';

/** Directory under `<gemini>/tmp/<hash>/` holding the saved chats. */
export const CHATS_DIR = 'chats';

/**
 * The one line `doctor` prints under the gemini row. The first clause is the
 * most important thing a user can learn about this adapter.
 */
/**
 * T6.6 D6 — the provenance, as a boolean rather than as prose.
 *
 * `GEMINI_DOCTOR_NOTE` says this in a sentence, and `doctorLine()` says it in a
 * word — but the rendered line is clipped to the terminal's width, and when
 * the tool is **absent** it does not carry the word at all. Absent is this
 * adapter's state on every machine that does not have the tool. `doctor
 * --json` is the documented API, and an API cannot ask a caller to grep a
 * width-dependent sentence for an adjective. So the fact is a field.
 */
export const GEMINI_FORMAT_UNVERIFIED = true;

export const GEMINI_DOCTOR_NOTE =
  'gemini: format unverified — this adapter was written from documentation, not from a real ' +
  'checkpoint, so record coverage is a best guess until someone runs it on one. Checkpoints ' +
  'carry no per-turn timestamps (session times come from file mtime) and the project directory ' +
  'is a hash, so the working directory is only recovered when a path in the transcript hashes ' +
  'to it.';

/**
 * `Content.part` keys this parser understands. Anything else in a part is
 * counted as `part:<key>` so `doctor` shows exactly what coverage is missing —
 * `inlineData`, `fileData`, `executableCode`, `codeExecutionResult` and
 * `thought` are all documented `Part` members this parser does not render, and
 * counting them is how the gap becomes visible instead of silent.
 */
const HANDLED_PART_KEYS = new Set(['text', 'functionCall', 'functionResponse']);

/** `Content.role` values this parser understands. */
const HANDLED_ROLES = new Set(['user', 'model', 'assistant', 'system', 'tool']);

/** Keys a wrapper object may carry the turn array under. */
const HISTORY_KEYS = ['history', 'messages', 'contents', 'turns'] as const;

export function sourceDir(override?: string): string {
  return geminiTmpDir(override);
}

/**
 * Walk `<gemini>/tmp/<project-hash>/chats/*.json`. A `readdir` + `stat` only,
 * per the {@link SessionSource} contract: no file is opened here.
 *
 * A project-hash directory with no `chats/` subdirectory is normal — Gemini
 * CLI uses `tmp/<hash>/` for other per-project scratch state too — so its
 * absence is skipped silently rather than counted as an error.
 */
export function discover(override?: string): SessionSource[] {
  const root = sourceDir(override);
  const out: SessionSource[] = [];
  let hashes: fs.Dirent[];
  try {
    hashes = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // gemini not installed, or no chats ever saved: not an error
  }

  for (const hash of hashes) {
    if (!hash.isDirectory()) continue;
    const dir = path.join(root, hash.name, CHATS_DIR);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      out.push({
        sessionId: sessionIdFromFilename(file, hash.name),
        harness: 'gemini',
        path: full,
        projectSlug: hash.name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        isSidechain: false,
        status: 'live',
      });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * A checkpoint's id. Gemini CLI names the file after the tag the user gave
 * `/chat save <tag>`, so `checkpoint-refactor.json` and a differently-hashed
 * project can both be called `refactor` — the id is therefore
 * `<hash12>-<tag>`, which is unique across the tree without being a path.
 * `parse()` overrides it if the file turns out to carry a real `sessionId`.
 */
export function sessionIdFromFilename(file: string, projectHash: string): string {
  const base = path.basename(file, '.json').replace(/^checkpoint-/, '') || 'checkpoint';
  return `${projectHash.slice(0, 12)}-${base}`;
}

export interface GeminiParseOptions extends ParseOptions {
  status?: SessionStatus;
  bytes?: number;
  /** `mtimeMs` of the source; `stat`ed if not supplied. */
  mtimeMs?: number;
}

export async function parse(
  source: SessionSource | string,
  options: GeminiParseOptions = {},
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
  // `endOffset` is the whole file: a checkpoint is one JSON document, so there
  // is no such thing as resuming from a byte offset inside it. `fromOffset` is
  // accepted (the contract requires the field) and deliberately ignored, as it
  // is for pi. Exchange ids are a pure function of `(sessionId, seq)`, so a
  // re-parse is an upsert, not a duplicate.
  const endOffset = Buffer.byteLength(raw, 'utf8');

  let doc: unknown;
  try {
    doc = raw.trim() ? JSON.parse(raw) : undefined;
  } catch {
    doc = undefined;
    if (raw.trim()) malformedLines += 1;
  }

  const { turns, meta } = unwrap(doc);
  if (doc !== undefined && turns.length === 0 && !meta) malformedLines += 1;

  const projectSlug = options.projectSlug ?? src?.projectSlug ?? path.basename(path.dirname(path.dirname(absolute)));
  const sessionId =
    options.sessionId ??
    (meta && typeof meta.sessionId === 'string' && meta.sessionId.trim()
      ? meta.sessionId
      : sessionIdFromFilename(absolute, projectSlug));

  const mtimeMs = options.mtimeMs ?? src?.mtimeMs ?? statMtime(absolute);
  const fileTime = new Date(mtimeMs).toISOString();

  const counts = { userPrompts: 0, assistantTurns: 0, toolCalls: 0 };
  const cwdCandidates: string[] = [];
  const exchanges = buildExchanges(turns, sessionId, fileTime, counts, unknownTypes, cwdCandidates);

  const metaString = (key: string): string | undefined => {
    if (!meta) return undefined;
    const v = meta[key];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };

  // A checkpoint carries no per-turn clock, so both ends of the session are
  // the file's mtime unless the wrapper says otherwise. Reported, not hidden:
  // GEMINI_DOCTOR_NOTE names this exact limitation.
  const startedAt = metaString('startTime') ?? metaString('startedAt') ?? fileTime;
  const endedAt = metaString('lastUpdated') ?? metaString('updatedAt') ?? fileTime;
  const cwd = metaString('cwd') ?? metaString('projectRoot');
  const title = metaString('title') ?? metaString('name') ?? metaString('tag');
  const model = metaString('model');
  const gitBranch = metaString('gitBranch') ?? metaString('branch');

  const session: SessionRecord = {
    id: sessionId,
    harness: 'gemini',
    sourcePath: absolute,
    project: cwd ?? recoverCwd(projectSlug, cwdCandidates) ?? '',
    projectSlug,
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

  return { session, exchanges, unknownTypes, endOffset, malformedLines };
}

/**
 * Accept both plausible top-level shapes: a bare array of `Content`, or an
 * object wrapping one under any of {@link HISTORY_KEYS}. Returns the turns and
 * the wrapper (if any), so metadata is read only when it genuinely exists.
 */
function unwrap(doc: unknown): { turns: unknown[]; meta?: Record<string, unknown> } {
  if (Array.isArray(doc)) return { turns: doc };
  if (!isRecord(doc)) return { turns: [] };
  for (const key of HISTORY_KEYS) {
    const v = doc[key];
    if (Array.isArray(v)) return { turns: v, meta: doc };
  }
  return { turns: [], meta: doc };
}

/**
 * One array of `Content` -> `Exchange[]`. An exchange opens on a **human**
 * turn and absorbs every model turn and tool result until the next one.
 *
 * A model turn arriving before any human turn (a resumed or system-seeded
 * chat) opens an exchange with an empty user side rather than being dropped:
 * nothing is lost silently here.
 */
function buildExchanges(
  turns: readonly unknown[],
  sessionId: string,
  fileTime: string,
  counts: { userPrompts: number; assistantTurns: number; toolCalls: number },
  unknownTypes: Record<string, number>,
  cwdCandidates: string[],
): Exchange[] {
  const out: Exchange[] = [];
  let seq = 0;
  let current: {
    seq: number;
    userTexts: string[];
    assistantTexts: string[];
    toolCalls: ExchangeToolCall[];
    byName: Map<string, number>;
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
      ts: fileTime,
      userText: b.userTexts.join('\n\n'),
      assistantText: b.assistantTexts.join('\n\n'),
      toolCalls: b.toolCalls,
      filesTouched: uniq(b.files),
      isSidechain: false,
      redacted: false,
    });
  };

  const open = () => {
    seq += 1;
    current = {
      seq,
      userTexts: [],
      assistantTexts: [],
      toolCalls: [],
      byName: new Map(),
      files: [],
    };
    return current;
  };

  for (const turn of turns) {
    if (!isRecord(turn)) {
      unknownTypes['(not an object)'] = (unknownTypes['(not an object)'] ?? 0) + 1;
      continue;
    }
    const role = typeof turn.role === 'string' ? turn.role : '';
    if (!HANDLED_ROLES.has(role)) {
      const key = `role:${role || '(no role)'}`;
      unknownTypes[key] = (unknownTypes[key] ?? 0) + 1;
      continue;
    }
    const parts = partsOf(turn, unknownTypes);

    if (isHumanTurn(role, parts)) {
      finalize();
      counts.userPrompts += 1;
      const b = open();
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) b.userTexts.push(p.text);
      }
      continue;
    }

    const b = current ?? open();
    const isModel = role === 'model' || role === 'assistant';
    if (isModel) counts.assistantTurns += 1;

    for (const p of parts) {
      if (typeof p.text === 'string' && p.text.trim()) b.assistantTexts.push(p.text);

      const call = p.functionCall;
      if (isRecord(call)) {
        const name = typeof call.name === 'string' ? call.name : 'unknown';
        const args = call.args ?? call.arguments;
        b.toolCalls.push({ name, input: stringifyToolInput(args) });
        counts.toolCalls += 1;
        // Pairing is by name: a `functionResponse` carries the function's name
        // and no call id, so the newest unanswered call of that name is the
        // one it answers.
        b.byName.set(name, b.toolCalls.length - 1);
        for (const f of filesFromToolInput(args)) {
          b.files.push(f);
          cwdCandidates.push(f);
        }
      }

      // Tool output coming back, joined to the call it answers. Handled for
      // **every** role, not just `user`: the role a `functionResponse` rides
      // on is not fixed by the documentation, and a result dropped because it
      // arrived on the turn we did not expect is exactly the silent loss this
      // parser exists to prevent.
      const res = p.functionResponse;
      if (!isRecord(res)) continue;
      const name = typeof res.name === 'string' ? res.name : 'unknown';
      const result = stringifyToolOutput(res.response ?? res.output ?? res.content);
      const isError =
        isRecord(res.response) && typeof res.response['error'] !== 'undefined' ? true : undefined;
      const at = b.byName.get(name);
      if (at !== undefined) {
        const answered = b.toolCalls[at];
        if (answered) {
          if (result !== undefined) answered.result = result;
          if (isError) answered.isError = true;
        }
        b.byName.delete(name);
        continue;
      }
      // An orphan response — the call is on the other side of a `/chat save`
      // boundary, or the checkpoint was truncated. Kept as a call of its own
      // rather than throwing the output away.
      b.toolCalls.push({
        name,
        input: '',
        ...(result !== undefined ? { result } : {}),
        ...(isError ? { isError: true } : {}),
      });
      counts.toolCalls += 1;
    }
  }

  finalize();
  return out;
}

/** `Content.parts`, tolerating a bare-string `parts` and counting odd keys. */
function partsOf(turn: Record<string, unknown>, unknownTypes: Record<string, unknown>): Record<string, unknown>[] {
  const parts = turn.parts ?? turn.content;
  if (typeof parts === 'string') return [{ text: parts }];
  if (!Array.isArray(parts)) return [];
  const out: Record<string, unknown>[] = [];
  for (const p of parts) {
    if (typeof p === 'string') {
      out.push({ text: p });
      continue;
    }
    if (!isRecord(p)) continue;
    for (const key of Object.keys(p)) {
      if (HANDLED_PART_KEYS.has(key)) continue;
      const k = `part:${key}`;
      const counts = unknownTypes as Record<string, number>;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    out.push(p);
  }
  return out;
}

/**
 * A human prompt is a `user` turn with at least one part that is **not** a
 * `functionResponse`. A `user` turn made only of `functionResponse` parts is
 * the harness feeding tool output back to the model, and counting it as a
 * prompt would put machine text into `counts.userPrompts`.
 */
export function isHumanTurn(role: string, parts: readonly Record<string, unknown>[]): boolean {
  if (role !== 'user') return false;
  if (parts.length === 0) return true; // an empty user turn is still a turn
  return parts.some((p) => !isRecord(p.functionResponse));
}

/**
 * Every hash construction Gemini CLI plausibly uses for `tmp/<hash>`. The
 * exact one is **unverified**; trying the plausible set and requiring an exact
 * match keeps {@link recoverCwd} a check rather than a guess, and adding a
 * construction later cannot make a wrong answer right — only make a missing
 * one findable.
 */
export function projectHashes(cwd: string): string[] {
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  const trimmed = cwd.length > 1 ? cwd.replace(/[/\\]+$/, '') : cwd;
  return uniq([sha(cwd), sha(trimmed), sha(trimmed + path.sep)]);
}

/**
 * Recover the working directory by **checking candidates against the hash**,
 * never by inverting it. Absolute paths seen in tool-call arguments and their
 * ancestor directories are hashed; the first whose hash equals the directory
 * name wins. Deepest candidates are tried first so `/a/b/c` beats `/a` when
 * both hash-match (they cannot, but the order makes the search deterministic).
 *
 * Returns `undefined` when nothing matches, which is the common case and is
 * exactly what {@link GEMINI_DOCTOR_NOTE} warns about.
 */
export function recoverCwd(projectHash: string, candidates: readonly string[]): string | undefined {
  if (!/^[0-9a-f]{16,}$/i.test(projectHash)) return undefined;
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const c of candidates) {
    if (!path.isAbsolute(c)) continue;
    let dir = path.dirname(path.resolve(c));
    // Walk up to the filesystem root; ~40 iterations is a hard ceiling on any
    // real path, and the loop terminates when `dirname` stops changing.
    for (let i = 0; i < 40; i += 1) {
      if (seen.has(dir)) break;
      seen.add(dir);
      dirs.push(dir);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  dirs.sort((a, b) => b.length - a.length);
  const want = projectHash.toLowerCase();
  for (const dir of dirs) {
    if (projectHashes(dir).some((h) => h === want)) return dir;
  }
  return undefined;
}

function statMtime(absolute: string): number {
  try {
    return fs.statSync(absolute).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The `doctor` line for gemini. It must distinguish three states plainly —
 * **not installed**, **installed with no sessions**, and **parsed** — because
 * "0 sessions" on its own is the one answer that could mean either of the
 * first two, and a user whose chats potsherd cannot see deserves to know which.
 *
 * `gemini      ready     ~/.gemini/tmp                 2 checkpoints · unverified format`
 */
export function doctorLine(override?: string): string {
  const tmp = sourceDir(override);
  const root = geminiDir(override);
  let found: SessionSource[] = [];
  try {
    found = discover(override);
  } catch {
    found = [];
  }
  const installed = fs.existsSync(root);
  const tmpExists = fs.existsSync(tmp);

  let status: string;
  let note: string;
  if (found.length > 0) {
    status = 'ready';
    note = `${found.length} checkpoint${found.length === 1 ? '' : 's'} · unverified format`;
  } else if (installed || tmpExists) {
    status = 'empty';
    note = tmpExists
      ? 'Gemini CLI installed, no saved chats (use /chat save) · unverified format'
      : 'Gemini CLI installed, no tmp/ yet — no chats saved · unverified format';
  } else {
    status = 'absent';
    note = 'Gemini CLI not installed';
  }
  return formatDoctorLine({ harness: 'gemini', status, dir: tmp, note });
}

/** The adapter, as `doctor` / `index` / `stats` consume it. */
export const geminiAdapter: Adapter = {
  harness: 'gemini',
  displayName: DISPLAY_NAME,
  sourceDir: () => sourceDir(),
  discover: () => discover(),
  parse: (src, opts) => parse(src, opts ?? {}),
};

export default geminiAdapter;
