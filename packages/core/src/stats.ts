import fs from 'node:fs';
import type { Db } from './db.js';
import type { Harness } from './adapters/types.js';
import { HARNESSES } from './adapters/types.js';
import { storedRedactionCounts } from './ingest.js';
import { emptyCounts, type RedactionCounts } from './redact.js';
import { dbPath, potsherdDir } from './paths.js';
import { vecStatus, vecTablesExist } from './vec.js';

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
  vectors: number;
  vectorsPending: number;
  vecAvailable: boolean;
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
}

export function stats(db: Db, options: StatsOptions = {}): StatsReport {
  const root = potsherdDir(options.root);

  const sessionRows = db
    .prepare(
      `SELECT s.harness AS harness,
              SUM(s.is_sidechain = 0) AS sessions,
              SUM(s.is_sidechain = 1) AS sidechains,
              SUM(s.user_prompts)     AS prompts,
              SUM(s.bytes)            AS bytes,
              SUM(s.title IS NOT NULL) AS titled,
              SUM(s.status = 'live')   AS live,
              SUM(s.status = 'archived') AS archived,
              MIN(s.started_at)        AS first_ts,
              MAX(COALESCE(s.ended_at, s.started_at)) AS last_ts,
              (SELECT COUNT(*) FROM exchanges e JOIN sessions s2 ON s2.id = e.session_id
                 WHERE s2.harness = s.harness) AS exchanges,
              (SELECT COUNT(*) FROM tool_calls tc JOIN exchanges e2 ON e2.id = tc.exchange_id
                 JOIN sessions s3 ON s3.id = e2.session_id WHERE s3.harness = s.harness) AS tool_calls
         FROM sessions s GROUP BY s.harness`,
    )
    .all() as AggRow[];

  const ghostRows = db
    .prepare(
      `SELECT g.harness AS harness, COUNT(*) AS ghosts, SUM(g.prompt_count) AS prompts,
              MIN(g.first_ts) AS first_ts, MAX(COALESCE(g.last_ts, g.first_ts)) AS last_ts,
              (SELECT COUNT(*) FROM ghost_prompts p JOIN ghosts g2 ON g2.session_id = p.session_id
                 WHERE g2.harness = g.harness) AS prompt_rows
         FROM ghosts g GROUP BY g.harness`,
    )
    .all() as {
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

  const vecOk = vecTablesExist(db);
  const status = vecOk ? vecStatus(db) : { available: false, reason: 'sqlite-vec did not load' };
  const vectors = vecOk ? countOf(db, 'SELECT COUNT(*) AS n FROM vec_exchanges') : 0;
  const pending = countOf(
    db,
    'SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version IS NULL',
  );

  const file = dbPath(root);
  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(file).size;
  } catch {
    dbBytes = 0;
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
