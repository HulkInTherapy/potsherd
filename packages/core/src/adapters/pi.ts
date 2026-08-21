import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { piSessionsDir } from '../paths.js';
import { formatDoctorLine } from '../doctor-line.js';
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
import { readJsonlLines, parseJsonLine } from '../parser/jsonl.js';
import {
  extractTextFromContent,
  extractTypedText,
  filesFromToolInput,
  isRecord,
  stringifyToolInput,
  stringifyToolOutput,
  uniq,
} from '../parser/content.js';

/**
 * pi (`@earendil-works/pi-coding-agent`) adapter — `~/.pi/agent/sessions`.
 *
 * Nothing here is ported: pi's transcript format was characterised from the
 * real files on disk and from the installed `dist/core/session-manager.js`,
 * and is written up in `docs/upstream/PHASE-1-SCOUT.md` §C3.
 *
 * ## layout
 *
 * ```
 * ~/.pi/agent/sessions/<cwd-slug>/<file-timestamp>_<session-id>.jsonl
 * ```
 *
 * The directory under `sessions/` is a **cwd slug, not a session id** —
 * `--${cwd.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--` (`/Users/dev` ->
 * `--Users-dev--`). The mapping is lossy (`-` and spaces are not escaped), so
 * `project` always comes from the header's `cwd`, never from the slug. The
 * file-timestamp prefix is **not ISO-8601**: `:` and `.` are replaced with `-`
 * (`2026-05-13T08-09-45-791Z`), so it must never be fed to `new Date()`.
 *
 * ## the record tree
 *
 * Line 1 is a `type:"session"` header carrying `id` (a UUIDv7), `version`,
 * `timestamp` and `cwd`. Every later record is a node in a DAG keyed by an
 * **8-hex-char** `id` (`randomUUID().slice(0,8)`, uniquified per file only —
 * ids are not globally unique, so the store must namespace by session id) with
 * `parentId: string | null`.
 *
 * Three traps live in that sentence, all verified on the real corpus:
 *
 *   1. **the header is not in the tree.** pi's `_buildIndex()` explicitly
 *      `continue`s on `type === "session"`, so the header id is never indexed
 *      and never appears in a `parentId` (0 occurrences across all 4 real
 *      files). The DAG root is the first non-header record, which carries
 *      `parentId: null`.
 *   2. **the header has no `parentId` field at all** — absent, not null.
 *   3. **`parentId: null` appears mid-schema**, on the root record, which in
 *      every real file is a `model_change`.
 *
 * ## linearisation — file order, not timestamp
 *
 * `plans/phases/phase-1-foundation.md` T1.3 says "follow the latest leaf".
 * Read literally as "the leaf with the newest timestamp", that is **wrong**.
 * The leaf is the **last record in file order**. Three independent reasons:
 *
 *   1. **it is what pi does.** `SessionManager._buildIndex()` walks
 *      `fileEntries` in order and assigns `this.leafId = entry.id` on every
 *      indexed entry, so the final line wins; `buildSessionContext()` then
 *      walks `parentId` from that leaf to the root. `branch(id)` moves the
 *      in-memory leaf backwards, but the next append still lands at the end of
 *      the file — and on the next load the leaf is re-derived from file order.
 *      File order *is* pi's on-disk definition of the mainline. Any timestamp
 *      rule is a guess about someone else's semantics.
 *   2. **timestamps tie.** 3 of the 4 real files contain two records with a
 *      byte-identical `timestamp` (e.g. two `toolResult`s at
 *      `2026-05-13T08:26:16.174Z` — N parallel tool calls chain sequentially
 *      and can be written inside the same millisecond). A max-by-timestamp
 *      leaf is therefore *nondeterministic* on real data; if the sort keeps
 *      the earlier of a tied pair, the tail after it is silently dropped.
 *   3. **pi records two disagreeing clocks.** Every `message` record has an
 *      outer ISO `timestamp` and an inner epoch-ms `message.timestamp`, and
 *      they differ in all 4 real files — by up to **9.35 s** (record
 *      `36ef4bb7`: outer `08:10:07.079Z`, inner `08:09:57.733Z`), which is
 *      larger than the gap between adjacent turns. A rule that depends on
 *      "the" timestamp has to pick one of two contradictory clocks first.
 *
 * Wall-clock ordering and file order coincide while the machine's clock is
 * monotonic, so the two rules agree on all 4 real files — the bug is invisible
 * until a clock step (NTP correction, suspend/resume), a tie, or a
 * `createBranchedSession()` fork, whose new file copies path entries with
 * their **original** timestamps under a freshly stamped header. That is why
 * `tests/fixtures/pi/.../branched.jsonl` is built so the two rules disagree:
 * it is the only way to pin which one this file implements.
 *
 * ## branches become sidechains of the same session
 *
 * Per T1.3, records that are **not** on the mainline are not discarded: they
 * are grouped into the branch chains they belong to and emitted as further
 * `Exchange`s of the *same* session with `isSidechain: true` and
 * `parentUuid` = the record's own `parentId` (so the branch point is
 * recoverable). The `SessionRecord` itself stays `isSidechain: false` — a pi
 * branch is an abandoned edit, not a subagent transcript.
 *
 * ## no model calls, no network. ever.
 */

/** Record `type`s this parser understands. Anything else is counted. */
const HANDLED_TYPES = new Set([
  'session',
  'message',
  'model_change',
  'thinking_level_change',
  'session_info',
  'compaction',
  'branch_summary',
  'label',
  'custom',
  'custom_message',
]);

/** `message.role` values this parser turns into exchange content. */
const HANDLED_ROLES = new Set(['user', 'assistant', 'toolResult']);

export const DISPLAY_NAME = 'pi';

/**
 * `piDir()` (overridable by `POTSHERD_PI_DIR`, so tests never read the
 * developer's real one) moved to `paths.ts` in T1.5 beside `claudeDir()`, so
 * `doctor --privacy` enumerates every readable path from one module (F9). pi's
 * directory is a **read-only input** (`00-README` ground rules): potsherd never
 * writes a byte under it.
 */
export { piDir } from '../paths.js';

/** The directory `discover()` walks — reported by `doctor` even when empty. */
export function sourceDir(override?: string): string {
  return piSessionsDir(override);
}

/**
 * The `doctor` line for pi. Rendered by `packages/cli/src/commands/doctor.ts`,
 * which this worker does not own — the string lives here so the adapter and
 * its status can never drift apart.
 *
 * `pi           ready     ~/.pi/agent/sessions          4 sessions`
 */
export function doctorLine(override?: string): string {
  const dir = sourceDir(override);
  let sessions = 0;
  try {
    sessions = discover(override).length;
  } catch {
    sessions = 0;
  }
  const exists = fs.existsSync(dir);
  const status = exists ? 'ready' : 'absent';
  const note = exists ? `${sessions} session${sessions === 1 ? '' : 's'}` : 'pi not installed';
  return formatDoctorLine({ harness: 'pi', status, dir, note });
}

/**
 * Walk `~/.pi/agent/sessions/<slug>/*.jsonl`. A `readdir` + `stat` only: the
 * session id is read off the filename and `parse()` corrects it from the
 * header if they ever disagree.
 *
 * Empty slug directories exist (pi `mkdir`s the directory for a cwd the moment
 * it starts, before anything is written), so directory count != session count.
 */
export function discover(override?: string): SessionSource[] {
  const root = sourceDir(override);
  const out: SessionSource[] = [];
  let slugs: fs.Dirent[];
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // pi not installed: not an error, just nothing to index
  }

  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      out.push({
        sessionId: sessionIdFromFilename(file),
        harness: 'pi',
        path: full,
        projectSlug: slug.name,
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
 * `2026-05-13T08-09-45-791Z_019e206c-8b63-736e-8b39-8d01e7e5b678.jsonl` ->
 * `019e206c-8b63-736e-8b39-8d01e7e5b678`. The prefix is a file-safe stamp, not
 * an ISO timestamp; the id is everything after the **last** `_`, because the
 * stamp itself never contains one.
 */
export function sessionIdFromFilename(file: string): string {
  const base = path.basename(file, '.jsonl');
  const at = base.lastIndexOf('_');
  return at === -1 ? base : base.slice(at + 1);
}

export interface PiParseOptions extends ParseOptions {
  status?: SessionStatus;
  /** File size in bytes; `stat`ed if not supplied. */
  bytes?: number;
}

/** One node of the on-disk DAG, plus where it sat in the file. */
interface Node {
  id: string;
  parentId: string | null;
  type: string;
  ts: string;
  /** 0-based position in file order among non-header records. */
  order: number;
  record: Record<string, unknown>;
}

export async function parse(
  source: SessionSource | string,
  options: PiParseOptions = {},
): Promise<ParseResult> {
  const src: SessionSource | undefined = typeof source === 'string' ? undefined : source;
  const absolute = path.resolve(typeof source === 'string' ? source : source.path);

  const unknownTypes: Record<string, number> = {};
  let malformedLines = 0;
  let endOffset = 0;

  // A tree cannot be linearised from a byte suffix: one record appended at the
  // tail moves the leaf, which can change which *earlier* records are on the
  // mainline. So pi always re-reads the whole file — `options.fromOffset` is
  // accepted (the contract requires the field) and deliberately ignored for
  // reading. `endOffset` is still exact, so `(mtime, offset)` change detection
  // upstairs keeps working, and exchange ids are a pure function of
  // `(sessionId, seq)`, so a re-emit is an upsert, not a duplicate.
  const nodes: Node[] = [];
  const byId = new Map<string, Node>();
  let header: Record<string, unknown> | undefined;
  let order = 0;

  for await (const line of readJsonlLines(absolute)) {
    if (!line.terminated) break; // half-written tail: leave it for the next run
    endOffset = line.end;

    const parsed = parseJsonLine(line.text);
    if (parsed === undefined || !isRecord(parsed)) {
      if (line.text.trim()) malformedLines += 1;
      continue;
    }

    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (!HANDLED_TYPES.has(type)) {
      const key = type || '(no type)';
      unknownTypes[key] = (unknownTypes[key] ?? 0) + 1;
    } else if (type === 'message') {
      // The v3 format declares message roles this parser has never seen in the
      // wild — `bashExecution` (a `!`-escaped shell command the user typed),
      // `custom`, `branchSummary`, `compactionSummary`. They are counted under
      // `message:<role>` so `doctor` shows exactly what coverage is missing,
      // and they stay in the DAG so nothing below them is orphaned.
      const message = parsed.message;
      const role = isRecord(message) && typeof message.role === 'string' ? message.role : '';
      if (!HANDLED_ROLES.has(role)) {
        const key = `message:${role || '(no role)'}`;
        unknownTypes[key] = (unknownTypes[key] ?? 0) + 1;
      }
    }

    if (type === 'session') {
      // Exactly one, always line 1, and never a DAG node.
      header ??= parsed;
      continue;
    }

    const id = typeof parsed.id === 'string' ? parsed.id : '';
    if (!id) {
      malformedLines += 1;
      continue;
    }
    // Unknown types still enter the index: they carry id/parentId, so dropping
    // them would break the ancestry of everything below them.
    const node: Node = {
      id,
      parentId: typeof parsed.parentId === 'string' ? parsed.parentId : null,
      type,
      ts: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
      order: order++,
      record: parsed,
    };
    nodes.push(node);
    byId.set(id, node);
  }

  const sessionId =
    options.sessionId ??
    (header && typeof header.id === 'string' && header.id
      ? header.id
      : sessionIdFromFilename(absolute));

  const mainline = linearise(nodes, byId);
  const onMainline = new Set(mainline.map((n) => n.id));
  const branches = branchChains(nodes, onMainline);

  const counts = { userPrompts: 0, assistantTurns: 0, toolCalls: 0 };
  const exchanges: Exchange[] = [];
  let seq = 0;

  seq = buildExchanges(mainline, sessionId, false, seq, exchanges, counts);
  for (const chain of branches) {
    seq = buildExchanges(chain, sessionId, true, seq, exchanges, counts);
  }

  // Session-level settings are "last wins **along the mainline**", exactly as
  // pi's `buildSessionContext()` resolves them: a `model_change` on an
  // abandoned branch is not the session's model.
  let model: string | undefined;
  let title: string | undefined;
  for (const node of mainline) {
    if (node.type === 'model_change' && typeof node.record.modelId === 'string') {
      model = node.record.modelId;
    }
    if (node.type === 'message') {
      const message = node.record.message;
      if (isRecord(message) && message.role === 'assistant' && typeof message.model === 'string') {
        model = message.model;
      }
    }
    // pi does not title sessions. The **only** stored name is an optional
    // `session_info.name` the user set by hand; if there is none, `title`
    // stays undefined and `ls` falls back to `<slug>-<id8>` as it does for
    // claude sdk sessions. Nothing is derived from the first prompt here.
    if (node.type === 'session_info' && typeof node.record.name === 'string' && node.record.name.trim()) {
      title = node.record.name;
    }
  }

  const projectSlug = options.projectSlug ?? src?.projectSlug ?? path.basename(path.dirname(absolute));
  const headerCwd = header && typeof header.cwd === 'string' ? header.cwd : undefined;
  const startedAt = header && typeof header.timestamp === 'string' ? header.timestamp : nodes[0]?.ts ?? '';
  // `endedAt` is the newest activity, so `max` is right here even though the
  // *leaf* is by file order: the two questions are different.
  let endedAt = startedAt;
  for (const node of nodes) if (node.ts > endedAt) endedAt = node.ts;

  // `createBranchedSession()` stamps the fork's header with `parentSession`,
  // the *path* of the file it was forked from. Recorded as lineage; the
  // session is still not a sidechain.
  const parentSession = header && typeof header.parentSession === 'string' ? header.parentSession : undefined;

  const session: SessionRecord = {
    id: sessionId,
    harness: 'pi',
    sourcePath: absolute,
    project: headerCwd ?? unslugifyPi(projectSlug),
    projectSlug,
    startedAt,
    endedAt,
    ...(title ? { title } : {}),
    // pi never persists the git branch: `GitBranch` exists only in the live
    // TUI footer provider. Left undefined rather than guessed.
    entrypoint: 'cli',
    ...(model ? { model } : {}),
    isSidechain: false,
    ...(parentSession ? { parentSessionId: sessionIdFromFilename(parentSession) } : {}),
    counts: {
      userPrompts: counts.userPrompts,
      assistantTurns: counts.assistantTurns,
      toolCalls: counts.toolCalls,
      bytes: options.bytes ?? src?.bytes ?? statBytes(absolute),
    },
    status: options.status ?? src?.status ?? 'live',
  };

  return { session, exchanges, unknownTypes, endOffset, malformedLines };
}

/**
 * Root -> leaf, where the leaf is the **last record in file order** (see the
 * file header for why, at length). Defensive against a corrupt file: a missing
 * parent ends the walk, and a `parentId` cycle is broken by a visited set
 * rather than hanging the indexer.
 */
function linearise(nodes: readonly Node[], byId: ReadonlyMap<string, Node>): Node[] {
  const leaf = nodes[nodes.length - 1];
  if (!leaf) return [];
  const chain: Node[] = [];
  const seen = new Set<string>();
  let current: Node | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return chain;
}

/**
 * Everything not on the mainline, grouped into the chains it actually forms.
 * A record continues its parent's chain when the parent is also off-mainline;
 * otherwise it starts a new one (its parent is the branch point on the
 * mainline, or is missing). Two abandoned branches therefore stay two chains
 * instead of being welded into one nonsense conversation.
 */
function branchChains(nodes: readonly Node[], onMainline: ReadonlySet<string>): Node[][] {
  const chains: Node[][] = [];
  const chainOf = new Map<string, number>();
  for (const node of nodes) {
    if (onMainline.has(node.id)) continue;
    const parentChain = node.parentId === null ? undefined : chainOf.get(node.parentId);
    if (parentChain === undefined) {
      chainOf.set(node.id, chains.length);
      chains.push([node]);
      continue;
    }
    chainOf.set(node.id, parentChain);
    chains[parentChain]!.push(node);
  }
  return chains;
}

interface Builder {
  seq: number;
  ts: string;
  userText: string;
  assistantTexts: string[];
  toolCalls: ExchangeToolCall[];
  /** `toolCall.id` -> index into `toolCalls`, for pairing `toolResult`s. */
  byToolCallId: Map<string, number>;
  files: string[];
  parentUuid: string | null;
}

/**
 * One chain of records -> `Exchange[]`. An exchange opens on a
 * `message`/`role:"user"` record and absorbs every assistant turn and
 * `toolResult` until the next one.
 *
 * The human-prompt discriminator is just `role === "user"`, and unlike Claude
 * Code that is unambiguous: pi gives tool output its own `toolResult` role at
 * the same nesting level, never persists the system prompt, and keeps
 * hook/extension injections in `custom_message` / `role:"custom"` records.
 */
function buildExchanges(
  chain: readonly Node[],
  sessionId: string,
  isSidechain: boolean,
  startSeq: number,
  out: Exchange[],
  counts: { userPrompts: number; assistantTurns: number; toolCalls: number },
): number {
  let seq = startSeq;
  let current: Builder | null = null;

  const finalize = (): void => {
    if (!current) return;
    const b = current;
    current = null;
    if (!b.userText.trim() && b.assistantTexts.length === 0 && b.toolCalls.length === 0) return;
    out.push({
      id: exchangeId(sessionId, b.seq),
      sessionId,
      seq: b.seq,
      ts: b.ts,
      userText: b.userText,
      assistantText: b.assistantTexts.join('\n\n'),
      toolCalls: b.toolCalls,
      filesTouched: uniq(b.files),
      isSidechain,
      ...(b.parentUuid ? { parentUuid: b.parentUuid } : {}),
      redacted: false,
    });
  };

  const open = (ts: string, parentUuid: string | null): Builder => {
    seq += 1;
    const b: Builder = {
      seq,
      ts,
      userText: '',
      assistantTexts: [],
      toolCalls: [],
      byToolCallId: new Map(),
      files: [],
      parentUuid,
    };
    current = b;
    return b;
  };

  for (const node of chain) {
    if (node.type !== 'message') continue;
    const message = node.record.message;
    if (!isRecord(message)) continue;
    const role = typeof message.role === 'string' ? message.role : '';
    if (!HANDLED_ROLES.has(role)) continue; // counted by the caller as message:<role>

    if (role === 'user') {
      finalize();
      counts.userPrompts += 1;
      // `content` may be a bare string, or an array with only an `image` block
      // and no text at all — both stay exchanges, with empty `userText`.
      open(node.ts, node.parentId).userText = extractTypedText(message.content);
      continue;
    }

    // A hook-injected or resumed turn can put an assistant record before any
    // user record. Open an exchange with an empty user side rather than
    // dropping what the assistant said: nothing is lost silently here.
    const b = current ?? open(node.ts, node.parentId);

    if (role === 'assistant') {
      // Every assistant record is one turn, including a failed one
      // (`stopReason:"error"`, `content: []`, an `errorMessage` string). The
      // turn is counted and the exchange survives with an empty assistant
      // side; the harness's error text is not passed off as something the
      // model said.
      counts.assistantTurns += 1;
      const text = extractTypedText(message.content);
      if (text.trim()) b.assistantTexts.push(text);
      for (const block of toolCallBlocks(message.content)) {
        const name = typeof block.name === 'string' ? block.name : 'unknown';
        // `arguments` is an already-parsed object, not a JSON string.
        const call: ExchangeToolCall = { name, input: stringifyToolInput(block.arguments) };
        b.toolCalls.push(call);
        counts.toolCalls += 1;
        if (typeof block.id === 'string') b.byToolCallId.set(block.id, b.toolCalls.length - 1);
        for (const f of filesFromToolInput(block.arguments)) b.files.push(f);
      }
      continue;
    }

    // role === 'toolResult': a top-level record of its own, joined back to the
    // call by `toolCallId`.
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
    const at = callId === undefined ? undefined : b.byToolCallId.get(callId);
    const result = stringifyToolOutput(
      typeof message.content === 'string' ? message.content : extractTextFromContent(message.content),
    );
    if (at !== undefined) {
      const call = b.toolCalls[at];
      if (call) {
        if (result !== undefined) call.result = result;
        if (message.isError === true) call.isError = true;
      }
      continue;
    }
    // An orphan result — the call it answers is on the other side of a branch
    // point, or the transcript was truncated. Keep it as a call of its own
    // rather than throwing the output away.
    const name = typeof message.toolName === 'string' ? message.toolName : 'unknown';
    b.toolCalls.push({
      name,
      input: '',
      ...(result !== undefined ? { result } : {}),
      ...(message.isError === true ? { isError: true } : {}),
    });
    counts.toolCalls += 1;
  }

  finalize();
  return seq;
}

function toolCallBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'toolCall');
}

/**
 * Best-effort inverse of pi's slug, used only when a file has no header (a
 * truncated transcript). `--Users-dev-src--` -> `/Users/dev/src`. Lossy by
 * construction: pi escapes neither `-` nor spaces, so `/a/b-c` and `/a-b/c`
 * collide. The header's `cwd` is always preferred.
 */
export function unslugifyPi(slug: string): string {
  const inner = slug.replace(/^--/, '').replace(/--$/, '');
  return '/' + inner.replace(/-/g, '/');
}

function statBytes(absolute: string): number {
  try {
    return fs.statSync(absolute).size;
  } catch {
    return 0;
  }
}

/**
 * Stable across re-indexes and identical to the claude adapter's rule: an
 * exchange keeps its id as long as it keeps its place in its session. This is
 * what makes pi's always-full re-parse an upsert rather than a duplicate.
 */
export function exchangeId(sessionId: string, seq: number): string {
  return crypto.createHash('sha256').update(`${sessionId}:${seq}`).digest('hex').slice(0, 32);
}

/** The adapter, as `doctor` / `index` / `stats` consume it. */
export const piAdapter: Adapter = {
  harness: 'pi',
  displayName: DISPLAY_NAME,
  sourceDir: () => sourceDir(),
  discover: () => discover(),
  parse: (src, opts) => parse(src, opts ?? {}),
};

export default piAdapter;
