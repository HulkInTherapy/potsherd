/**
 * The claude-mem bridge — read-only, schema-discovered, worker-preferring.
 *
 * ## what claude-mem is, and what this bridge refuses to be
 *
 * claude-mem (thedotmack/claude-mem) captures forward from the moment you
 * install it: five hooks write observations into `~/.claude-mem/claude-mem.db`
 * and inject them back at SessionStart. It solves a failure potsherd does not
 * try to solve, and potsherd solves one it does not — it has no archive, and
 * its own author has said he never saw his memories surface unless he asked.
 *
 * So `03` §10's rule is the whole design here: **never duplicate their
 * capture.** This file installs no hook, writes no observation, and opens
 * nothing for writing. It reads what claude-mem already collected so that
 * `potsherd find --with claude-mem` can put their hits and ours on one page.
 *
 * ## licence
 *
 * claude-mem is **Apache-2.0** — verified 2026-08-22 against
 * `raw.githubusercontent.com/thedotmack/claude-mem/main/LICENSE` (202 lines,
 * verbatim Apache 2.0, no added field-of-use or non-commercial rider), the
 * GitHub API's `spdx_id`, the npm registry's `license` field, and the repo's
 * own `NOTICE` (Copyright 2026 Alex Newman).
 *
 * That is permissive, so vendoring would have been *permitted*. It is still
 * not done. Not one line of claude-mem is copied, adapted, or linked here:
 * this bridge speaks sqlite and HTTP to a store the user already owns, and
 * reading a file format needs no licence at all. The practical consequence is
 * that potsherd's `NOTICE` gains no entry for claude-mem and owes no Apache-2.0
 * attribution — there is nothing of theirs in the build to attribute.
 *
 * ## every path and constant below was verified, not assumed
 *
 * The data directory, the port formula and the endpoint are all read out of
 * claude-mem's own source rather than out of a plan document, and every one of
 * them turned out to be *overridable*, which a hard-coded bridge would have
 * got wrong for anyone who had configured it:
 *
 *   - `src/shared/paths.ts` — `DB_PATH = join(DATA_DIR, 'claude-mem.db')`,
 *     where `DATA_DIR` defaults to `~/.claude-mem` but is overridden by the
 *     `CLAUDE_MEM_DATA_DIR` environment variable.
 *   - `src/shared/SettingsDefaultsManager.ts:120` —
 *     `CLAUDE_MEM_WORKER_PORT: String(37700 + ((process.getuid?.() ?? 77) % 100))`.
 *     Note the `?? 77`: on a platform with no `getuid` the port is 37777, and
 *     an explicit `CLAUDE_MEM_WORKER_PORT` wins over the formula entirely.
 *   - `src/services/worker/http/routes/SearchRoutes.ts:149` —
 *     `app.get('/api/search/observations', …)`. A **GET**.
 *
 * And the one thing the plan asserted that the source did **not** confirm:
 * there is no `observations_fts` table. claude-mem's `SessionStore` creates
 * `observations` as an ordinary table and only `user_prompts_fts` as fts5. The
 * phase file said "read-only fts5 query of observations"; the schema says that
 * may not be possible. This is exactly why the discovery below asks the
 * database instead of trusting either document — and why it carries a `like`
 * strategy for the case where the text is there and an fts index over it is
 * not.
 */

import { ftsQuery } from '@potsherd/core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  absentStatus,
  emptyStatus,
  firstLine,
  unavailableList,
  unrecognisedStatus,
  type BridgeHit,
  type BridgeList,
  type BridgeQueryOptions,
  type BridgeStatus,
  type DiscoveredSchema,
  type WorkerProbe,
} from './types.js';
import {
  columnsOf,
  countRows,
  isFts5,
  openReadOnly,
  pickColumn,
  tables,
  type ReadOnlyDb,
  type TableInfo,
} from './sqlite.js';

/** claude-mem's fallback uid when the platform has no `getuid`. Theirs, not ours. */
const NO_UID = 77;

/** How long the localhost probe and the search may take. */
export const WORKER_TIMEOUT_MS = 1500;

export interface ClaudeMemOptions extends BridgeQueryOptions {
  /** Override the environment, for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Skip the localhost probe entirely. `find --offline` would set this. */
  noWorker?: boolean;
}

/**
 * claude-mem's data directory, honouring its own override.
 *
 * `CLAUDE_MEM_DATA_DIR` is read because claude-mem reads it: a bridge that
 * only knows the default answers "not installed" to every user who moved their
 * store, which is the most confusing possible way to be wrong.
 */
export function claudeMemDir(opts: ClaudeMemOptions = {}): string {
  const env = opts.env ?? process.env;
  const override = env['CLAUDE_MEM_DATA_DIR'];
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(opts.home ?? os.homedir(), '.claude-mem');
}

export function claudeMemDbPath(opts: ClaudeMemOptions = {}): string {
  return path.join(claudeMemDir(opts), 'claude-mem.db');
}

/** `37700 + (uid % 100)`, or whatever `CLAUDE_MEM_WORKER_PORT` says instead. */
export function claudeMemWorkerPort(opts: ClaudeMemOptions = {}): number {
  const env = opts.env ?? process.env;
  const override = Number(env['CLAUDE_MEM_WORKER_PORT']);
  if (Number.isInteger(override) && override > 0 && override < 65536) return override;
  const uid = typeof process.getuid === 'function' ? process.getuid() : NO_UID;
  return 37700 + (uid % 100);
}

// ------------------------------------------------------------------ detect

/**
 * Is claude-mem here, and if so what shape is its store?
 *
 * Returns one of the four {@link BridgeStatus.presence} values and never
 * throws. The three negative answers are kept apart on purpose:
 *
 *   - no `~/.claude-mem` at all          → `absent`, "not installed"
 *   - the directory but no `.db`, or a   → `empty`, "installed, nothing to
 *     `.db` with no observation rows        search"
 *   - a `.db` whose tables we cannot     → `unrecognised`, "bridge
 *     make sense of                         unavailable: schema not recognised"
 *
 * A caller that flattens these into "unavailable" is telling a user who has
 * claude-mem installed and empty to go install claude-mem.
 */
export async function detectClaudeMem(opts: ClaudeMemOptions = {}): Promise<BridgeStatus> {
  const dir = claudeMemDir(opts);
  const file = claudeMemDbPath(opts);

  if (!fs.existsSync(dir)) return absentStatus('claude-mem', file, `no ${tilde(dir)}`);
  if (!fs.existsSync(file)) {
    return emptyStatus('claude-mem', file, `${tilde(dir)} exists, no claude-mem.db in it`);
  }

  const { db, error } = await openReadOnly(file);
  if (!db) return unrecognisedStatus('claude-mem', file, error);

  try {
    const found = discover(db);
    if (!found.schema) return unrecognisedStatus('claude-mem', file, found.why, null);
    const rows = countRows(db, found.schema.table);
    if (rows === 0) {
      return {
        bridge: 'claude-mem',
        presence: 'empty',
        path: file,
        available: false,
        detail: `installed, nothing to search (${found.schema.table} is empty)`,
        headline: 'installed, nothing to search',
        schema: found.schema,
        rows: 0,
        worker: null,
      };
    }
    const worker = opts.noWorker ? null : await probeWorker(opts);
    return {
      bridge: 'claude-mem',
      presence: 'store',
      path: file,
      available: true,
      detail: rowsLine(found.schema, rows, worker),
      headline: rowsLine(found.schema, rows, worker),
      schema: found.schema,
      rows,
      worker,
    };
  } catch (err) {
    // Belt and braces. Everything above is written not to throw; if something
    // in a foreign schema finds a way anyway, it becomes a sentence here and
    // not a stack trace in someone's terminal.
    return unrecognisedStatus('claude-mem', file, firstLine(err));
  } finally {
    try {
      db.close();
    } catch {
      /* closing a read-only handle cannot lose data */
    }
  }
}

function rowsLine(schema: DiscoveredSchema, rows: number | null, worker: WorkerProbe | null): string {
  const n = rows === null ? 'some' : String(rows);
  const how = worker?.up ? `worker up on ${worker.port}` : schema.fts ? 'fts5' : 'no fts index, substring scan';
  return `${n} rows in ${schema.table} (${how})`;
}

// ---------------------------------------------------------------- discovery

/**
 * Column names worth trying, best first, for each role.
 *
 * These are *candidates offered to the database*, not a schema. Nothing here
 * is required to exist; `pickColumn` returns null and the bridge degrades. The
 * lists are deliberately generic rather than claude-mem-specific so that the
 * same discovery keeps working when they rename something — which they will,
 * and which no amount of reading their source today can prevent.
 */
const TEXT_COLUMNS = ['text', 'content', 'body', 'observation', 'summary', 'message', 'value'];
const TITLE_COLUMNS = ['title', 'summary', 'subject', 'name', 'heading', 'label'];
const ID_COLUMNS = ['id', 'uuid', 'observation_id', 'rowid', 'key'];
const TIME_COLUMNS = ['created_at', 'timestamp', 'created', 'ts', 'time', 'date', 'updated_at'];

/**
 * Table names worth reading, best first.
 *
 * `observations` is what the phase file names and what claude-mem's
 * `SessionStore` creates. The rest are here so that a fork, a rename, or the
 * separate server-side schema (`memory_items`) still federates instead of
 * reporting a store we cannot read.
 */
const TABLE_CANDIDATES = ['observations', 'memory_items', 'memories', 'user_prompts', 'session_summaries'];

interface Discovery {
  schema: DiscoveredSchema | null;
  /** The fts5 table to MATCH against, when it is not the base table itself. */
  ftsTable: string | null;
  why: string;
}

/**
 * Ask the database what it holds. Never assume, never hard-code.
 *
 * Two passes, because the phase file's premise may be false: first look for
 * one of the named tables, then — if none of them has usable text — accept any
 * fts5 table in the file. The second pass is what makes this bridge survive a
 * schema we have never seen, and it is why the failure message can name what
 * it looked at rather than saying "unavailable".
 */
function discover(db: ReadOnlyDb): Discovery {
  const all = tables(db);
  if (all.length === 0) return { schema: null, ftsTable: null, why: 'no tables in the file' };
  const byName = new Map(all.map((t) => [t.name.toLowerCase(), t]));

  for (const want of TABLE_CANDIDATES) {
    const info = byName.get(want);
    if (!info) continue;
    const built = build(db, info, all);
    if (built) return { schema: built.schema, ftsTable: built.ftsTable, why: '' };
  }

  for (const info of all) {
    if (!isFts5(info)) continue;
    const built = build(db, info, all);
    if (built) return { schema: built.schema, ftsTable: built.ftsTable, why: '' };
  }

  const names = all
    .map((t) => t.name)
    .filter((n) => !n.startsWith('sqlite_'))
    .slice(0, 8)
    .join(', ');
  return {
    schema: null,
    ftsTable: null,
    why: `no readable text column in ${names || 'any table'}`,
  };
}

function build(
  db: ReadOnlyDb,
  info: TableInfo,
  all: readonly TableInfo[],
): { schema: DiscoveredSchema; ftsTable: string | null } | null {
  const columns = columnsOf(db, info.name);
  if (columns.length === 0) return null;
  const textColumn = pickColumn(columns, TEXT_COLUMNS);
  if (!textColumn) return null;

  // An fts5 companion is found by *declaration*, not by name convention: a
  // table is only usable for MATCH if its own SQL says `using fts5`, and it is
  // only usable for this base table if it carries the same text column, which
  // is what makes the `rowid` join meaningful. `<name>_fts` is checked first
  // because that is the near-universal convention, including potsherd's own.
  const self = isFts5(info);
  let ftsTable: string | null = self ? info.name : null;
  if (!self) {
    const wanted = `${info.name.toLowerCase()}_fts`;
    const companion =
      all.find((t) => t.name.toLowerCase() === wanted && isFts5(t)) ??
      all.find(
        (t) =>
          isFts5(t) &&
          t.name.toLowerCase().startsWith(info.name.toLowerCase()) &&
          columnsOf(db, t.name)
            .map((c) => c.toLowerCase())
            .includes(textColumn.toLowerCase()),
      );
    ftsTable = companion?.name ?? null;
  }

  return {
    schema: {
      table: info.name,
      columns,
      idColumn: pickColumn(columns, ID_COLUMNS),
      textColumn,
      titleColumn: pickColumn(columns, TITLE_COLUMNS),
      timeColumn: pickColumn(columns, TIME_COLUMNS),
      fts: ftsTable !== null,
    },
    ftsTable,
  };
}

// ------------------------------------------------------------------ worker

/**
 * Is claude-mem's worker listening on localhost?
 *
 * The only network this bridge does, and it is not network in any sense worth
 * the word: one GET to `127.0.0.1` on a port derived from this user's own uid,
 * with a 1.5 s ceiling. `03` §11's "no network except model calls the user
 * initiated" is about packets leaving the machine, and none do.
 *
 * The worker is preferred over sqlite when it answers because it is the same
 * search claude-mem gives itself — its ranking, its recency weighting, its
 * idea of what an observation is. Reading their file directly is the fallback,
 * not the goal.
 */
export async function probeWorker(opts: ClaudeMemOptions = {}): Promise<WorkerProbe> {
  const port = claudeMemWorkerPort(opts);
  const url = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${url}/api/search/observations?q=potsherd-probe&limit=1`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? WORKER_TIMEOUT_MS),
    });
    // Any HTTP answer at all proves something is listening; a 404 or a 400
    // means it is not the worker, or not a worker that speaks this route, and
    // either way sqlite is the better read.
    if (!res.ok) {
      return { port, url, up: false, detail: `worker answered ${res.status} on ${port}` };
    }
    return { port, url, up: true, detail: `worker up on ${port}` };
  } catch (err) {
    return { port, url, up: false, detail: `no worker on ${port} (${firstLine(err)})` };
  }
}

// ------------------------------------------------------------------- query

/**
 * `potsherd find <query> --with claude-mem` — their hits, ranked by them.
 *
 * Returns a {@link BridgeList} whose hits carry no `score`; `federate()`
 * assigns those, because what a foreign list is worth in potsherd's fusion is
 * potsherd's decision and not this file's.
 *
 * Never throws, on any path.
 */
export async function queryClaudeMem(
  query: string,
  opts: ClaudeMemOptions = {},
): Promise<BridgeList> {
  const started = Date.now();
  const status = await detectClaudeMem(opts);
  if (!status.available) return unavailableList(status, Date.now() - started);

  const limit = Math.max(1, opts.limit ?? 20);

  if (status.worker?.up) {
    const viaHttp = await searchWorker(query, status, limit, opts);
    if (viaHttp) {
      return {
        list: 'claude-mem',
        status,
        hits: viaHttp,
        ms: Date.now() - started,
        unavailable: null,
        strategy: 'worker-http',
        // The worker ran their search, not ours. It relaxes or does not
        // relax by its own rules and does not tell us which, so claiming
        // either would be inventing a fact about someone else's ranker.
        relaxed: false,
      };
    }
    // Fall through to sqlite rather than reporting failure: the worker being
    // up and unhelpful is not a reason to tell the user their store is
    // unreadable when the file is right there.
  }

  return searchSqlite(query, status, limit, started, opts);
}

/**
 * The worker's answer, or null to fall back.
 *
 * **The response shape is not documented and was not verified.** The route
 * exists — `SearchRoutes.ts:149`, a GET — but its query-parameter names and
 * its JSON body were not confirmed from source, so this asks in the two most
 * likely spellings and reads the reply structurally: an array at the top
 * level, or the first array-valued property among the usual names. Anything
 * else returns null and sqlite answers instead. Guessing a shape and rendering
 * `undefined` into a result page would be worse than not using the worker.
 */
async function searchWorker(
  query: string,
  status: BridgeStatus,
  limit: number,
  opts: ClaudeMemOptions,
): Promise<BridgeHit[] | null> {
  const base = status.worker?.url;
  if (!base) return null;
  for (const key of ['q', 'query']) {
    try {
      const url = `${base}/api/search/observations?${key}=${encodeURIComponent(query)}&limit=${limit}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? WORKER_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      const rows = arrayIn(body);
      if (!rows) continue;
      const hits = rows.slice(0, limit).map((row, i) => rowToHit(row, i + 1, url));
      return hits.filter((h) => h.text.length > 0);
    } catch {
      // Timeout, connection reset, or a body that is not JSON. Next spelling,
      // then sqlite.
    }
  }
  return null;
}

/** The first array we can find in an undocumented response body. */
function arrayIn(body: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of ['results', 'observations', 'data', 'hits', 'items', 'rows']) {
    const value = obj[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return null;
}

function rowToHit(row: Record<string, unknown>, rank: number, source: string): BridgeHit {
  const text = firstString(row, [...TEXT_COLUMNS, 'snippet', 'excerpt']);
  const title = firstString(row, TITLE_COLUMNS);
  const id = firstString(row, ID_COLUMNS) || String(rank);
  const ts = firstString(row, TIME_COLUMNS);
  const score = Number(row['score'] ?? row['rank'] ?? NaN);
  return {
    bridge: 'claude-mem',
    id,
    title: oneLine(title || text),
    text,
    ts: ts || null,
    source,
    rank,
    raw: Number.isFinite(score) ? score : 0,
  };
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/**
 * Read claude-mem's file directly.
 *
 * Two strategies, chosen by what discovery found rather than by what the plan
 * hoped for:
 *
 *   - **fts5** when the table is an fts5 virtual table, or has a companion
 *     one. `MATCH` with claude-mem's own ranking, which is a real ranking.
 *   - **like** when it does not — which, on the schema claude-mem actually
 *     ships for `observations`, is the likely case. A substring scan over the
 *     text column, newest first, with every query token required. It is not a
 *     ranking and the `strategy` field says so; `raw` is 0 for every row
 *     because pretending to a score we did not compute would corrupt the
 *     `--explain` output downstream.
 */
async function searchSqlite(
  query: string,
  status: BridgeStatus,
  limit: number,
  started: number,
  opts: ClaudeMemOptions,
): Promise<BridgeList> {
  const file = status.path;
  const { db, error } = await openReadOnly(file);
  if (!db) {
    return unavailableList(unrecognisedStatus('claude-mem', file, error), Date.now() - started);
  }
  try {
    const found = discover(db);
    const schema = found.schema;
    if (!schema || !schema.textColumn) {
      return unavailableList(
        unrecognisedStatus('claude-mem', file, found.why || 'no text column', schema),
        Date.now() - started,
      );
    }

    // AND first, OR only if AND came back empty — the same order `recall()`
    // uses, and reported the same way, so a `--with claude-mem` result can say
    // that the foreign list had to loosen the query too.
    const fts = ftsQuery(query);
    let relaxed = false;
    let rows: Record<string, unknown>[] | null = null;
    if (found.ftsTable) {
      rows = matchRows(db, schema, found.ftsTable, fts.and, limit);
      if (!rows || rows.length === 0) {
        const loose = matchRows(db, schema, found.ftsTable, fts.or, limit);
        if (loose && loose.length > 0) {
          rows = loose;
          relaxed = true;
        }
      }
    }

    const strategy: 'fts5' | 'like' = rows ? 'fts5' : 'like';
    let finalRows = rows;
    if (!finalRows) {
      finalRows = likeRows(db, schema, fts.tokens, limit, true);
      if (finalRows.length === 0) {
        const loose = likeRows(db, schema, fts.tokens, limit, false);
        if (loose.length > 0) {
          finalRows = loose;
          relaxed = true;
        }
      }
    }

    const hits = finalRows.map((row, i) => sqliteHit(row, schema, i + 1, file));
    return {
      list: 'claude-mem',
      status,
      hits: hits.filter((h) => h.text.length > 0),
      ms: Date.now() - started,
      unavailable: null,
      strategy,
      relaxed,
    };
  } catch (err) {
    return unavailableList(
      unrecognisedStatus('claude-mem', file, firstLine(err), status.schema),
      Date.now() - started,
    );
  } finally {
    try {
      db.close();
    } catch {
      /* read-only */
    }
    void opts;
  }
}

/** fts5 `MATCH`, or null when the query or the index will not have it. */
function matchRows(
  db: ReadOnlyDb,
  schema: DiscoveredSchema,
  ftsTable: string,
  match: string,
  limit: number,
): Record<string, unknown>[] | null {
  if (!match.trim()) return null;
  const base = q(schema.table);
  const idx = q(ftsTable);
  const sql =
    ftsTable === schema.table
      ? `select *, rank as __rank from ${idx} where ${idx} match ? order by rank limit ?`
      : `select b.*, f.rank as __rank from ${idx} f join ${base} b on b.rowid = f.rowid where ${idx} match ? order by f.rank limit ?`;
  try {
    return db.prepare(sql).all(match, limit) as Record<string, unknown>[];
  } catch {
    // A malformed MATCH, a contentless fts5 table, or a rowid that does not
    // join. All three mean "use the other strategy", not "fail".
    return null;
  }
}

/**
 * Substring scan. Not a ranking, and never described as one.
 *
 * `requireAll` joins the terms with `and` (the strict pass) or `or` (the
 * relaxed one). Both are parameterised; the only thing interpolated is a
 * column name this connection's own `sqlite_master` handed us, quoted.
 */
function likeRows(
  db: ReadOnlyDb,
  schema: DiscoveredSchema,
  tokens: readonly string[],
  limit: number,
  requireAll: boolean,
): Record<string, unknown>[] {
  const text = schema.textColumn;
  if (!text) return [];
  const words = tokens.filter((t) => t.length > 1).slice(0, 6);
  if (words.length === 0) return [];
  const where = words
    .map(() => `${q(text)} like ? escape '\\'`)
    .join(requireAll ? ' and ' : ' or ');
  const order = schema.timeColumn ? `order by ${q(schema.timeColumn)} desc` : 'order by rowid desc';
  try {
    return db
      .prepare(`select * from ${q(schema.table)} where ${where} ${order} limit ?`)
      .all(...words.map((w) => `%${escapeLike(w)}%`), limit) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqliteHit(
  row: Record<string, unknown>,
  schema: DiscoveredSchema,
  rank: number,
  file: string,
): BridgeHit {
  const text = String(row[schema.textColumn ?? ''] ?? '').trim();
  const title = schema.titleColumn ? String(row[schema.titleColumn] ?? '').trim() : '';
  const id = schema.idColumn ? String(row[schema.idColumn] ?? '') : String(row['rowid'] ?? rank);
  const ts = schema.timeColumn ? normaliseTs(row[schema.timeColumn]) : null;
  // fts5's `rank` is negative and smaller-is-better. It is recorded as the
  // bridge's raw score and never used for ordering here, because the order it
  // implies is already the order the rows arrived in.
  const raw = Number(row['__rank'] ?? NaN);
  return {
    bridge: 'claude-mem',
    id: id || String(rank),
    title: oneLine(title || text),
    text,
    ts,
    source: file,
    rank,
    raw: Number.isFinite(raw) ? raw : 0,
  };
}

/**
 * Another tool's timestamp, in whatever it stores.
 *
 * Epoch seconds, epoch milliseconds and an ISO string are all plausible and
 * all appear in stores like this. An unparseable value becomes null rather
 * than `Invalid Date`, because a wrong date beside a hit is worse than none.
 */
function normaliseTs(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(/^\d+$/.test(s) ? Number(s) * (s.length > 12 ? 1 : 1000) : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
