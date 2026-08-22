/**
 * The shapes every bridge answers in (`03` §10, phase 6 deliverable 2).
 *
 * One rule governs this whole package and is worth stating before any type:
 * **potsherd never duplicates another tool's capture, and never writes to
 * another tool's store without `--yes`.** Every read here opens the other
 * tool's file read-only; every write path in this package refuses to run
 * without explicit consent and says so rather than asking twice.
 *
 * ---
 *
 * ## why `presence` has four values and not a boolean
 *
 * Phase 5 shipped four MCP clients labelled "docs only — unverified" because
 * they were not installed on the machine that built them, and the verifier
 * confirmed that label reached the user rather than being quietly dropped. A
 * bridge has the same problem in a sharper form: "claude-mem returned nothing"
 * is three completely different facts wearing one sentence.
 *
 *   - `absent`       — nothing at the path. The tool is not installed. Not an
 *                      error, not a warning; the overwhelmingly common case.
 *   - `empty`        — the directory is there and the store is not, or the
 *                      store is there and holds no rows. The tool is installed
 *                      and has captured nothing yet. "No hits" here means
 *                      something entirely different from "no hits" above.
 *   - `store`        — a store is there, it opened, and its schema was
 *                      recognised at runtime. This is the only value from
 *                      which a query result can be trusted.
 *   - `unrecognised` — a store is there and `pragma table_info` did not find
 *                      the columns this bridge knows how to read. The other
 *                      tool changed, or this is not the file we thought.
 *                      Degrade, name the mismatch, never guess.
 *
 * The distinction is carried in the type, in `--json`, and in the `doctor`
 * line, not only in a report — because a bridge that collapses it into
 * "unavailable" is a bridge that cannot tell a user whether to install the
 * tool, run it, or file a bug.
 */

/** The bridges this package ships. `notes` is potsherd reading its own host. */
export type BridgeName = 'claude-mem' | 'agentmemory' | 'notes';

export type BridgePresence = 'absent' | 'empty' | 'store' | 'unrecognised';

/**
 * What a runtime schema probe actually found.
 *
 * Recorded rather than assumed: the phase file says discover the schema with
 * `pragma table_info` and do not hard-code it, and phase 5 proved why — four
 * flags the plan assumed did not exist. So the columns this bridge decided to
 * read are reported back, and `doctor --json` can show them.
 */
export interface DiscoveredSchema {
  /** The table or view the rows came from. */
  table: string;
  /** Every column `pragma table_info` reported, in declaration order. */
  columns: string[];
  /** The column chosen as the row's identity, if one was found. */
  idColumn: string | null;
  /** The column chosen as the row's text. Without one there is no bridge. */
  textColumn: string | null;
  /** The column chosen as the row's title/summary, if any. */
  titleColumn: string | null;
  /** The column chosen as the row's timestamp, if any. */
  timeColumn: string | null;
  /** True when the table is an fts5 virtual table and `MATCH` is available. */
  fts: boolean;
}

/** A worker/HTTP endpoint a bridge probed on localhost. */
export interface WorkerProbe {
  port: number;
  url: string;
  up: boolean;
  /** One line. Why it is not up, when it is not. */
  detail: string;
}

/**
 * Everything `doctor` needs to print one honest line about one bridge.
 *
 * `detail` is always a single printable line and never a stack trace: the DoD
 * box for this task is "bridges degrade gracefully when the other tool is
 * absent — no stack traces", and the only way to keep that promise is for the
 * error path to produce a *sentence* at the point of failure rather than let
 * an exception travel.
 */
export interface BridgeStatus {
  bridge: BridgeName;
  presence: BridgePresence;
  /** The path probed. Always set, whatever the answer, so `doctor` can show it. */
  path: string;
  /** True only when a query can actually be attempted. `presence === 'store'`. */
  available: boolean;
  /** One line, printable, always. */
  detail: string;
  /** What the runtime probe found. Null when there was nothing to probe. */
  schema: DiscoveredSchema | null;
  /** Rows behind the store, when cheap to count. Null when unknown. */
  rows: number | null;
  /** localhost probe, for the bridges that have one. */
  worker: WorkerProbe | null;
}

/**
 * One hit from another tool's store.
 *
 * Deliberately *not* a {@link RecallHit}: a claude-mem observation has no
 * potsherd `sessionId`, no `exchanges.id`, and no row in this machine's index.
 * Giving it those fields would make it indistinguishable from something
 * potsherd actually holds, which is the one thing a federated result must
 * never do — `03` §10's "never duplicate their capture" is a display rule as
 * much as a storage rule.
 */
export interface BridgeHit {
  bridge: BridgeName;
  /** The other tool's own identifier for this row, as a string. */
  id: string;
  /** One line, already trimmed. Falls back to the head of `text`. */
  title: string;
  /** The matching text, as the other tool stored it. */
  text: string;
  ts: string | null;
  /** Where this came from, printable: an absolute path or a localhost URL. */
  source: string;
  /** Rank within this bridge's own result list, 1-based. */
  rank: number;
  /** The bridge's own score, on whatever scale it uses. Recorded, never fused. */
  raw: number;
  /**
   * RRF contribution on potsherd's scale. Filled in by `federate()`; absent
   * until then, because a bridge does not get to decide what its hits are
   * worth in someone else's fusion.
   */
  score?: number;
}

/**
 * A bridge's whole answer: the hits, and — always — why there are that many.
 *
 * `unavailable` is a sentence when the bridge could not run and `null` when it
 * ran. An empty `hits` with `unavailable: null` means the query genuinely
 * matched nothing, which is a different fact from the bridge being missing,
 * and the two must not be able to look alike downstream.
 */
export interface BridgeList {
  list: BridgeName;
  status: BridgeStatus;
  hits: BridgeHit[];
  ms: number;
  unavailable: string | null;
  /**
   * How the hits were actually obtained.
   *
   * Reported because the three sqlite strategies are not equally good and the
   * user is entitled to know which one answered: `fts5` is the other tool's
   * own ranking, `like` is a substring scan with no ranking at all (the
   * fallback when the store has no fts5 companion for the table we read), and
   * `worker-http` is the tool's own search service, which is the best answer
   * available because it is the same one the tool gives itself.
   */
  strategy: 'worker-http' | 'fts5' | 'like' | 'files' | 'mcp' | null;
  /**
   * True when every query token was required and that found nothing, so the
   * bridge fell back to any-token matching — the same relaxation `recall()`
   * performs, reported for the same reason.
   *
   * Without it a search for `zzz-does-not-exist` comes back with three hits
   * for the word `this`, and nothing downstream can tell that they are noise.
   * `federate()` does not penalise a relaxed bridge list the way `recall()`
   * penalises a relaxed local one, because a relaxed foreign list is still the
   * best that tool had to offer; but the flag has to survive to `--json` so a
   * reader can discount it.
   */
  relaxed: boolean;
}

export interface BridgeQueryOptions {
  /** Candidates to ask the other tool for. Default 20. */
  limit?: number;
  /** Override the home directory. Tests and `--potsherd-dir` runs use it. */
  home?: string;
  /** Hard ceiling on the whole call, ms. Default per bridge. */
  timeoutMs?: number;
}

/** The sentence a bridge produces when its schema probe came up short. */
export const SCHEMA_UNAVAILABLE = 'bridge unavailable: schema not recognised';

/**
 * Build a status for a bridge that is simply not installed.
 *
 * Shared so that all three bridges phrase the common case identically, and so
 * "not installed" can never accidentally be rendered as a failure.
 */
export function absentStatus(bridge: BridgeName, path: string, what: string): BridgeStatus {
  return {
    bridge,
    presence: 'absent',
    path,
    available: false,
    detail: `not installed (${what})`,
    schema: null,
    rows: null,
    worker: null,
  };
}

/** A bridge that ran but had nothing to search. */
export function emptyStatus(bridge: BridgeName, path: string, why: string): BridgeStatus {
  return {
    bridge,
    presence: 'empty',
    path,
    available: false,
    detail: `installed, nothing to search (${why})`,
    schema: null,
    rows: null,
    worker: null,
  };
}

/**
 * The one place an unknown error becomes a printable line.
 *
 * Every bridge funnels its catch blocks through here so that no thrown value
 * — an `Error`, a string, a `SQLITE_NOTADB` code, whatever a foreign module
 * decides to throw — can reach a terminal as a stack.
 */
export function firstLine(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? 'unknown');
  return (message.split('\n')[0] ?? 'unknown').trim().slice(0, 200) || 'unknown';
}

/** A `BridgeList` for a bridge that never got as far as a query. */
export function unavailableList(status: BridgeStatus, ms = 0): BridgeList {
  return {
    list: status.bridge,
    status,
    hits: [],
    ms,
    unavailable: status.detail,
    strategy: null,
    relaxed: false,
  };
}

/**
 * A status for a store that is present and whose schema was not recognised.
 *
 * Separate from {@link emptyStatus} on purpose: "installed, nothing to search"
 * is a fact about the user's data, "schema not recognised" is a fact about
 * potsherd, and only the second one is a bug report worth filing.
 */
export function unrecognisedStatus(
  bridge: BridgeName,
  path: string,
  why: string,
  schema: DiscoveredSchema | null = null,
): BridgeStatus {
  return {
    bridge,
    presence: 'unrecognised',
    path,
    available: false,
    detail: `${SCHEMA_UNAVAILABLE} (${why})`,
    schema,
    rows: null,
    worker: null,
  };
}
