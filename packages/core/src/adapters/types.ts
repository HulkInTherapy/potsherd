/**
 * The L0 adapter contract — the one interface every harness adapter codes to.
 *
 * `SessionRecord` and `Exchange` are transcribed field for field from
 * `plans/03-ARCHITECTURE.md` §2. They are the boundary between "whatever this
 * harness happened to write on disk" and everything above L0: the store (L1),
 * redaction (L2), the index (L4) and recall (L6) know only these two shapes.
 * Changing a field here is an architecture change and needs a decision log
 * entry, not a commit.
 *
 * An adapter is one file per harness — `core/src/adapters/<harness>.ts` —
 * exporting `discover()` and `parse()`. It performs no model calls and no
 * network I/O, ever (`03` §1: L0-L4 ship with zero credentials).
 *
 * This file is potsherd's own; nothing here is ported from upstream. The
 * parsers it drives (`../parser/`) are the ported half.
 */

export type Harness =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'pi'
  | 'gemini'
  | 'opencode'
  | 'copilot';

/** Every harness potsherd knows about, in the order `doctor` reports them. */
export const HARNESSES: readonly Harness[] = [
  'claude',
  'codex',
  'cursor',
  'pi',
  'gemini',
  'opencode',
  'copilot',
] as const;

/**
 * `live`     the transcript is still where the harness left it
 * `archived` potsherd holds the only copy, under `~/.potsherd/archive/`
 * `ghost`    no transcript survives; rebuilt from history/index side-channels
 */
export type SessionStatus = 'live' | 'archived' | 'ghost';

export interface SessionRecord {
  id: string;                 // harness-native session id
  harness: Harness;
  sourcePath: string;         // absolute path of the transcript
  project: string;            // cwd at start (normalised absolute path)
  projectSlug: string;        // harness's slug if any
  startedAt: string; endedAt: string;   // iso
  title?: string;             // claude ai-title (last one), codex thread_name, cursor/pi derived
  gitBranch?: string;
  entrypoint?: string;        // cli | sdk-ts | vscode | desktop …
  model?: string;
  isSidechain: boolean;       // subagent transcript
  parentSessionId?: string;   // for sidechains
  agentName?: string;         // claude agent-name record, if any
  counts: { userPrompts: number; assistantTurns: number; toolCalls: number; bytes: number };
  status: SessionStatus;      // ghost = reconstructed from history, no transcript
}

/** One tool invocation, as it appears inside an {@link Exchange}. */
export interface ExchangeToolCall {
  name: string;
  input: string;
  result?: string;
  isError?: boolean;
}

export interface Exchange {          // one user prompt + the assistant turn(s) that answered it
  id: string; sessionId: string; seq: number;
  ts: string;
  userText: string; assistantText: string;
  toolCalls: ExchangeToolCall[];
  filesTouched: string[];     // parsed from Edit/Write/Read tool inputs
  isSidechain: boolean; parentUuid?: string;
  redacted: boolean;          // true if any secret was masked
}

/**
 * One transcript file, as `discover()` found it. This is the unit of
 * incremental indexing: `bytes` + `mtimeMs` decide whether a source changed,
 * and `parse()` resumes from a byte offset the store remembers
 * (`sessions.source_mtime` / `sessions.source_offset`, `03` §3).
 *
 * `discover()` must be cheap — a directory walk plus `stat`, no full parse.
 * `sessionId` may be a best guess from the filename; `parse()` is allowed to
 * correct it from the file's own records.
 */
export interface SessionSource {
  sessionId: string;
  harness: Harness;
  /** Absolute path of the transcript on disk. */
  path: string;
  /** The harness's own project directory name, if it has one. */
  projectSlug: string;
  bytes: number;
  mtimeMs: number;
  isSidechain: boolean;
  /** Set on sidechains: the session whose transcript spawned this one. */
  parentSessionId?: string;
  /** Where the file is: still the harness's, or potsherd's archive copy. */
  status?: SessionStatus;
}

export interface ParseOptions {
  /**
   * Resume an incremental index: start reading at this byte offset and number
   * the first exchange `fromSeq`. Both come from the previous run's
   * {@link ParseResult}. Omit for a full parse.
   */
  fromOffset?: number;
  fromSeq?: number;
  /** Override the session id `parse()` would otherwise derive. */
  sessionId?: string;
  /** Override the project slug `parse()` would otherwise derive. */
  projectSlug?: string;
}

export interface ParseResult {
  session: SessionRecord;
  exchanges: Exchange[];
  /**
   * Record `type` values the parser did not understand, with counts. Unknown
   * record types are **counted, not fatal** (`03` §2); `doctor` reports parse
   * coverage per harness+version from these.
   */
  unknownTypes: Record<string, number>;
  /**
   * Byte offset just past the last *complete* line consumed. Feed it back as
   * `fromOffset` next run. A half-written trailing line is never consumed, so
   * a session being appended to right now indexes cleanly.
   */
  endOffset: number;
  /** Lines that were not valid JSON. Counted, never fatal. */
  malformedLines: number;
}

/**
 * What every harness adapter exports. `discover()` is synchronous on purpose:
 * it is a `readdir`/`stat` walk and callers (`doctor`, `index`, `stats`) want
 * it in a plain loop.
 */
export interface Adapter {
  harness: Harness;
  /** Human name for `doctor` ("Claude Code", "Codex CLI", …). */
  displayName: string;
  /**
   * The directory this adapter reads. Reported by `doctor` even when the
   * adapter is a not-yet-supported stub, so the user learns where to look.
   */
  sourceDir(): string;
  discover(): SessionSource[];
  parse(source: SessionSource, options?: ParseOptions): Promise<ParseResult>;
}

/** A harness potsherd knows of but cannot parse yet — `doctor` says so. */
export interface AdapterStub {
  harness: Harness;
  displayName: string;
  sourceDir(): string;
  supported: false;
  /** One line explaining what is missing, shown by `doctor`. */
  reason: string;
}

export function isAdapter(a: Adapter | AdapterStub): a is Adapter {
  return !('supported' in a) || a.supported !== false;
}

/**
 * What is actually known about an adapter's format, as fields.
 *
 * `doctor --json` has carried a single `unverified: boolean` since T6.6 D6,
 * and it was the right field while the answer was binary: three phase-6
 * adapters had been written from documentation and none had ever seen real
 * input. T10.12 broke that. A real opencode-ai 1.18.21 session and a real
 * Copilot CLI 1.0.80 session were run against their adapters, and the result
 * for both was neither "unverified" nor "fine" — it was *this part is right,
 * measured, and this part is wrong, measured*. A boolean cannot hold that, and
 * the two ways of squashing it are both lies: `true` says nobody looked about
 * the one harness that got a full round trip, and `false` says it works.
 *
 * So the boolean keeps its literal meaning — some part of the format has never
 * been read from real input — and the split lives here beside it. Provenance
 * is a **record of measurements**, not a summary: every string in
 * {@link verified} and {@link wrong} is something a named version was observed
 * to do.
 */
export interface FormatProvenance {
  /** The build measured, and when. Null when nothing real has been read. */
  measured: string | null;
  /** Parts observed CORRECT against that build. */
  verified: readonly string[];
  /** Parts observed WRONG against that build — measured defects, not risks. */
  wrong: readonly string[];
  /**
   * The adapter's own `*_FORMAT_UNVERIFIED`, carried here so a caller reading
   * one object cannot get the two fields from different releases.
   */
  unverified: boolean;
  /** The full sentence — the adapter's `*_DOCTOR_NOTE`. */
  note: string;
}
