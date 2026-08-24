import fs from 'node:fs';
import type { Db } from './db.js';
import type { Harness } from './adapters/types.js';
import { HARNESSES } from './adapters/types.js';
import { storedRedactionCounts } from './ingest.js';
import { emptyCounts, type RedactionCounts } from './redact.js';
import { dbPath, potsherdDir } from './paths.js';
import {
  countIgnoredSessions,
  ignoredProjectsInIndex,
  readIgnoreList,
  type IgnoreReport,
} from './ignore.js';
import { vecStatus, vecTablesExist } from './vec.js';
import { type VectorReport } from './doctor-line.js';

/**
 * `potsherd stats` — what is actually in the index, per harness.
 *
 * Every number here is a `COUNT` or a `SUM` over the store, so it can be
 * checked by hand (`03` phase-1 T1.3: "`potsherd stats` shows per-harness
 * counts matching `find … | wc`"). Nothing is estimated and nothing is cached.
 *
 * The one number that is not a count is **freshness**, and it is the reason
 * this verb is worth running twice. `sessions.source_mtime` records the mtime
 * of the transcript when it was read; comparing it against the file now says
 * how much of the index is behind, and whether a source has been deleted since
 * — which, for a tool whose whole premise is that Claude Code deletes things,
 * is the number the user came for.
 */

export interface HarnessStats {
  harness: Harness;
  /** Top-level sessions: transcripts that are not a subagent's. */
  sessions: number;
  sidechains: number;
  ghosts: number;
  exchanges: number;
  toolCalls: number;
  prompts: number;
  ghostPrompts: number;
  bytes: number;
  /**
   * Of `sessions` — subagents excluded — how many carry a title, whoever wrote
   * it: the harness, or potsherd from the session's first prompt (8.2). It
   * qualifies the `sessions` number and so it counts the same rows.
   */
  titled: number;
  live: number;
  archived: number;
  firstTs: string | null;
  lastTs: string | null;
}

export interface FreshnessStats {
  /** The most recent `sessions.indexed_at`. */
  lastIndexedAt: string | null;
  indexed: number;
  /** Sources whose mtime has moved since they were read. */
  stale: number;
  /** Sources that are no longer where they were read from. */
  missing: number;
  /** Sources potsherd holds the only copy of. */
  archived: number;
  /** Rows carrying a current vector. From {@link vecStatus}, like every verb. */
  vectors: number;
  /** Rows still waiting for one. Exchanges **and** recovered prompts. */
  vectorsPending: number;
  vecAvailable: boolean;
  /** The one report `doctor`, `index`, `find` and `stats` all render. */
  vectorReport?: VectorReport;
  vecReason?: string;
  dbBytes: number;
  dbPath: string;
}

export interface StatsReport {
  harnesses: HarnessStats[];
  totals: Omit<HarnessStats, 'harness' | 'firstTs' | 'lastTs'> & {
    firstTs: string | null;
    lastTs: string | null;
  };
  redaction: RedactionCounts;
  redactedExchanges: number;
  redactedPrompts: number;
  freshness: FreshnessStats;
  /**
   * The ignore list, and the sessions and ghosts it kept out of the counts
   * above. `renderStats` prints one line for it whenever `entries` is not
   * empty — a count of "your archive" that quietly excludes a third of it is
   * the one number in this verb that could be wrong without looking wrong.
   *
   * **`freshness` is deliberately not filtered.** It is a fact about the index
   * — how many rows are behind their source, how many sources have vanished,
   * how large the file is — and a user chasing a stale index needs the whole
   * of it. Ignoring is a view of your history, not of potsherd's health.
   */
  ignored: IgnoreReport;
  ranAt: string;
  root: string;
}

interface AggRow {
  harness: Harness;
  sessions: number;
  sidechains: number;
  exchanges: number;
  tool_calls: number;
  prompts: number;
  bytes: number;
  titled: number;
  live: number;
  archived: number;
  first_ts: string | null;
  last_ts: string | null;
}

export interface StatsOptions {
  /** potsherd root, for the db path and the archive check. */
  root?: string;
  /** Skip the per-file stat pass. Off by default; it costs ~2 ms per 100 files. */
  freshness?: boolean;
  /** `stats --all`: count the projects the ignore list hides, like every other row. */
  all?: boolean;
  /** The ignore list, instead of reading it from `<root>/config.json`. */
  ignore?: readonly string[];
}

export function stats(db: Db, options: StatsOptions = {}): StatsReport {
  const root = potsherdDir(options.root);

  // The ignore list becomes one `AND project NOT IN (…)` spliced into the two
  // aggregate queries. Spliced rather than appended to a filter object because
  // `stats` has no filters at all: it is the one verb that has always counted
  // everything, which is exactly why it has to say when it stops.
  const entries = options.all ? [] : [...(options.ignore ?? readIgnoreList(root))];
  const ignoredProjects = ignoredProjectsInIndex(db, entries);
  const ignoredMarks = ignoredProjects.map(() => '?').join(', ');
  const notIgnored = (column: string): string =>
    ignoredProjects.length === 0
      ? ''
      : `WHERE (${column} IS NULL OR ${column} NOT IN (${ignoredMarks}))`;
  const ignoredParams = ignoredProjects;
  const ignored: IgnoreReport = {
    entries: options.all ? [...(options.ignore ?? readIgnoreList(root))] : entries,
    projects: ignoredProjects,
    hidden: countIgnoredSessions(db, ignoredProjects),
  };

  // The exclusion is repeated inside the two correlated subqueries as well as
  // in the outer FROM: an exchange count that still included the ignored
  // projects' exchanges, under a session count that did not, would be a stats
  // card that fails its own arithmetic.
  const andNotIgnored = (column: string): string =>
    ignoredProjects.length === 0
      ? ''
      : `AND (${column} IS NULL OR ${column} NOT IN (${ignoredMarks}))`;

  const sessionRows = db
    .prepare(
      `SELECT s.harness AS harness,
              SUM(s.is_sidechain = 0) AS sessions,
              SUM(s.is_sidechain = 1) AS sidechains,
              SUM(s.user_prompts)     AS prompts,
              SUM(s.bytes)            AS bytes,
              -- Scoped to the sessions the "sessions" value counts.
              --
              -- SUM(s.title IS NOT NULL) summed over sidechains too. That was
              -- invisible while no subagent transcript ever carried a title,
              -- and 8.2 gave every one of them a title derived from its first
              -- prompt: the reference corpus's note went from
              -- "31 sessions - 197 subagents - 21 titled" to "225 titled",
              -- a count larger than the number it qualifies.
              SUM(s.is_sidechain = 0 AND s.title IS NOT NULL) AS titled,
              SUM(s.status = 'live')   AS live,
              SUM(s.status = 'archived') AS archived,
              MIN(s.started_at)        AS first_ts,
              MAX(COALESCE(s.ended_at, s.started_at)) AS last_ts,
              (SELECT COUNT(*) FROM exchanges e JOIN sessions s2 ON s2.id = e.session_id
                 WHERE s2.harness = s.harness ${andNotIgnored('s2.project')}) AS exchanges,
              (SELECT COUNT(*) FROM tool_calls tc JOIN exchanges e2 ON e2.id = tc.exchange_id
                 JOIN sessions s3 ON s3.id = e2.session_id
                WHERE s3.harness = s.harness ${andNotIgnored('s3.project')}) AS tool_calls
         FROM sessions s ${notIgnored('s.project')} GROUP BY s.harness`,
    )
    .all(...ignoredParams, ...ignoredParams, ...ignoredParams) as AggRow[];

  const ghostRows = db
    .prepare(
      `SELECT g.harness AS harness, COUNT(*) AS ghosts, SUM(g.prompt_count) AS prompts,
              MIN(g.first_ts) AS first_ts, MAX(COALESCE(g.last_ts, g.first_ts)) AS last_ts,
              (SELECT COUNT(*) FROM ghost_prompts p JOIN ghosts g2 ON g2.session_id = p.session_id
                 WHERE g2.harness = g.harness ${andNotIgnored('g2.project')}) AS prompt_rows
         FROM ghosts g ${notIgnored('g.project')} GROUP BY g.harness`,
    )
    .all(...ignoredParams, ...ignoredParams) as {
    harness: Harness;
    ghosts: number;
    prompts: number;
    first_ts: string | null;
    last_ts: string | null;
    prompt_rows: number;
  }[];


  const byHarness = new Map<Harness, HarnessStats>();
  const blank = (harness: Harness): HarnessStats => ({
    harness,
    sessions: 0,
    sidechains: 0,
    ghosts: 0,
    exchanges: 0,
    toolCalls: 0,
    prompts: 0,
    ghostPrompts: 0,
    bytes: 0,
    titled: 0,
    live: 0,
    archived: 0,
    firstTs: null,
    lastTs: null,
  });

  for (const r of sessionRows) {
    const h = byHarness.get(r.harness) ?? blank(r.harness);
    h.sessions = r.sessions ?? 0;
    h.sidechains = r.sidechains ?? 0;
    h.exchanges = r.exchanges ?? 0;
    h.toolCalls = r.tool_calls ?? 0;
    h.prompts = r.prompts ?? 0;
    h.bytes = r.bytes ?? 0;
    h.titled = r.titled ?? 0;
    h.live = r.live ?? 0;
    h.archived = r.archived ?? 0;
    h.firstTs = min(h.firstTs, r.first_ts);
    h.lastTs = max(h.lastTs, r.last_ts);
    byHarness.set(r.harness, h);
  }
  for (const r of ghostRows) {
    const h = byHarness.get(r.harness) ?? blank(r.harness);
    h.ghosts = r.ghosts ?? 0;
    h.ghostPrompts = r.prompt_rows ?? 0;
    h.prompts += r.prompts ?? 0;
    h.firstTs = min(h.firstTs, r.first_ts);
    h.lastTs = max(h.lastTs, r.last_ts);
    byHarness.set(r.harness, h);
  }

  const order = new Map(HARNESSES.map((h, i) => [h, i]));
  const harnesses = [...byHarness.values()].sort(
    (a, b) => (order.get(a.harness) ?? 99) - (order.get(b.harness) ?? 99),
  );

  const totals = harnesses.reduce(
    (acc, h) => ({
      sessions: acc.sessions + h.sessions,
      sidechains: acc.sidechains + h.sidechains,
      ghosts: acc.ghosts + h.ghosts,
      exchanges: acc.exchanges + h.exchanges,
      toolCalls: acc.toolCalls + h.toolCalls,
      prompts: acc.prompts + h.prompts,
      ghostPrompts: acc.ghostPrompts + h.ghostPrompts,
      bytes: acc.bytes + h.bytes,
      titled: acc.titled + h.titled,
      live: acc.live + h.live,
      archived: acc.archived + h.archived,
      firstTs: min(acc.firstTs, h.firstTs),
      lastTs: max(acc.lastTs, h.lastTs),
    }),
    {
      sessions: 0,
      sidechains: 0,
      ghosts: 0,
      exchanges: 0,
      toolCalls: 0,
      prompts: 0,
      ghostPrompts: 0,
      bytes: 0,
      titled: 0,
      live: 0,
      archived: 0,
      firstTs: null as string | null,
      lastTs: null as string | null,
    },
  );

  const redactedExchanges = countOf(db, 'SELECT COUNT(*) AS n FROM exchanges WHERE redacted = 1');
  const redactedPrompts = countOf(
    db,
    'SELECT COUNT(*) AS n FROM ghost_prompts WHERE redacted = 1',
  );

  return {
    harnesses,
    totals,
    redaction: safeRedaction(db),
    redactedExchanges,
    redactedPrompts,
    freshness: freshness(db, root, options.freshness !== false),
    ignored,
    ranAt: new Date().toISOString(),
    root,
  };
}

function freshness(db: Db, root: string, stat: boolean): FreshnessStats {
  const rows = stat
    ? (db
        .prepare(
          `SELECT source_path, source_mtime, status, archived_path FROM sessions
            WHERE source_path IS NOT NULL`,
        )
        .all() as {
        source_path: string;
        source_mtime: number | null;
        status: string;
        archived_path: string | null;
      }[])
    : [];

  let stale = 0;
  let missing = 0;
  let archived = 0;
  for (const r of rows) {
    if (r.status === 'archived' || r.archived_path) archived++;
    try {
      const st = fs.statSync(r.source_path);
      if (r.source_mtime !== null && Math.floor(st.mtimeMs) !== r.source_mtime) stale++;
    } catch {
      missing++;
    }
  }

  // FIX-B D2 — one source of truth, and `stats` is now inside it.
  //
  // These three lines used to be their own count: `COUNT(*) FROM vec_exchanges`
  // for embedded, `exchanges WHERE embedding_version IS NULL` for pending. Two
  // things were wrong with the second one and both of them printed. It counted
  // `exchanges` only, while `vec.ts` counts `exchanges` + `ghost_prompts` —
  // and a recovered prompt is a row that needs a vector exactly as much as an
  // exchange does — so on the verifier's archive `doctor` and `index` said
  // `warming 142 of 4,699` while `stats` said `1,586 pending`, 2.9x apart, in
  // the same minute. It also read `IS NULL` rather than `!= EMBEDDING_VERSION`,
  // so a vector left behind by an older model counted as done.
  //
  // §A2's acceptance says `doctor` and `index` report vectors from one source
  // of truth; `stats` was never brought in, and a third caller computing its
  // own numbers is not a source of truth, it is a coincidence that had already
  // stopped holding. `vecStatus(db, root)` is the call, `vec.ts` owns the
  // counting, `doctor-line.ts` owns the wording, and `render/stats.ts` renders
  // the same report `doctor` and `index` render.
  const vecOk = vecTablesExist(db);
  const status = vecOk ? vecStatus(db, root) : { available: false, reason: 'sqlite-vec did not load' };
  const report = 'report' in status ? status.report : undefined;
  const vectors = report?.embedded ?? 0;
  const pending = report?.pending ?? 0;

  const file = dbPath(root);
  /**
   * How big the database is — **asked of sqlite, not of the filesystem.**
   *
   * This used to be `fs.statSync(file).size`, and the store is in WAL mode
   * (`db.ts:542`). A file size therefore answers "how much of this database
   * has been checkpointed into the main file *at this instant*", which is a
   * fact about sqlite's housekeeping and about whatever else has the store
   * open — not about the archive. Measured, with one writer holding the WAL:
   *
   *     writer still open    statSync 4,096   wal 453,232   pages 442,368
   *     after a checkpoint   statSync 442,368 wal       0   pages 442,368
   *
   * The published `10-stats.txt` caught the mild version of this — the same
   * demo corpus printing `2.1 MB` and `2.2 MB` depending on what had run
   * before it, which is what made CI's new screen guard red — and the line
   * above is the severe one: `stats` would have said **4.1 kB** for a store
   * holding 442 kB. `plans/06` says a number a user reads must be measured;
   * this one was, of the wrong thing.
   *
   * `page_count * page_size` is the size of the database sqlite actually
   * holds, committed WAL pages included, so it does not move when a
   * checkpoint does. It is a read, so it is safe on a read verb — the
   * alternative, checkpointing here so the file size becomes true, would make
   * `stats` write to a store another process may be reading.
   */
  let dbBytes = 0;
  try {
    const pageCount = (db.pragma('page_count') as { page_count?: number }[])[0]?.page_count ?? 0;
    const pageSize = (db.pragma('page_size') as { page_size?: number }[])[0]?.page_size ?? 0;
    dbBytes = pageCount * pageSize;
  } catch {
    dbBytes = 0;
  }
  // A database sqlite could not be asked about — no pragma, a driver without
  // one — still has a file, and its size is a better answer than zero.
  if (dbBytes === 0) {
    try {
      dbBytes = fs.statSync(file).size;
    } catch {
      dbBytes = 0;
    }
  }

  return {
    lastIndexedAt:
      (db.prepare('SELECT MAX(indexed_at) AS v FROM sessions').get() as { v: string | null })?.v ??
      null,
    indexed: countOf(db, 'SELECT COUNT(*) AS n FROM sessions'),
    stale,
    missing,
    archived,
    vectors,
    vectorsPending: pending,
    vecAvailable: Boolean(status.available),
    // The whole report, so `--json` and the human view read one object and
    // `render/stats.ts` can print the same sentence `doctor` prints rather
    // than a second wording of the same facts.
    ...(report ? { vectorReport: report } : {}),
    ...(status.available ? {} : { vecReason: status.reason ?? 'unavailable' }),
    dbBytes,
    dbPath: file,
  };
}

function countOf(db: Db, sql: string): number {
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function safeRedaction(db: Db): RedactionCounts {
  try {
    return storedRedactionCounts(db);
  } catch {
    return emptyCounts();
  }
}

function min(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function max(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
