import { createRequire } from 'node:module';
import process from 'node:process';
import type { Db } from './db.js';
import { modelsDir, potsherdDir } from './paths.js';
import {
  EMBEDDING_VERSION,
  EmbeddingUnavailableError,
  blobToEmbedding,
  embeddingBackend,
  embeddingToBlob,
  embedThreads,
  generateExchangeEmbedding,
  isEmbeddingReady,
  type EmbeddingBackend,
} from './embeddings.js';
import { fitNote, vectorNote, vectorReport, warmingLine, type VectorReport } from './doctor-line.js';
import { bytes as fmtBytes, num as fmtNum } from './format.js';

/**
 * Vector storage and vector search, without a native extension.
 *
 * ## what this used to be, and why it changed
 *
 * `03 §3` put `vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding
 * FLOAT[384])` in the schema. vec0 is a loadable **native** extension shipped
 * by an optional npm package, and it fails for reasons that have nothing to do
 * with the user: an unsupported platform, a stripped `node_modules`, a sqlite
 * built without `enable_load_extension`, a hardened-runtime signature check.
 * On a clean `npm i -g potsherd` it is simply absent, which is the second half
 * of audit F2 — vectors could be computed and then had nowhere to live.
 *
 * A capability nobody has is not a capability. So it was measured instead of
 * assumed.
 *
 * ## the measurement that decided it
 *
 * The reference archive holds **1,678 exchanges**. 1,678 × 384 float32 is
 * 2.6 MB — small enough to read and score in JavaScript on every query.
 * Median of twelve top-25 searches on the reference machine, identical data,
 * identical results:
 *
 *     n         brute-force scan (JS)      sqlite-vec (native vec0)
 *     1,678               4.7 ms                      0.9 ms
 *     10,000             32.0 ms                      4.2 ms
 *     50,000            190.4 ms                     20.8 ms
 *     200,000          2,330.8 ms                    82.1 ms
 *
 * At the size potsherd actually indexes, the whole native dependency buys
 * **3.8 ms** on a `find` the audit measured at 23–270 ms. That is not a
 * trade-off, it is a rounding error, and it is paid for with an entire class
 * of install failure. So the scan is the storage and the search, on every
 * machine, and `sqlite-vec` is no longer used to answer a query at all. It is
 * still loaded, once, for one job: reading vec0 rows out of a database built
 * before this, in migration 10.
 *
 * The scan is O(n) and the table above says where that stops being free. A
 * corpus past ~50,000 exchanges — thirty times the reference archive — is where
 * an index would start to earn its keep, and that is the number to re-measure
 * against, not a hunch.
 *
 * ## how it presents the same surface
 *
 * Nothing else in the codebase changed, because nothing else had to. The
 * vectors live in ordinary tables (`vec_blob_exchanges`, `vec_blob_cards`,
 * `vec_blob_ghost_prompts`) and `vec_exchanges`, `vec_cards` and
 * `vec_ghost_prompts` are **views** over them with `INSTEAD OF` triggers, so
 * every statement already written against vec0 keeps working verbatim:
 *
 *     INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)   → trigger
 *     DELETE FROM vec_exchanges WHERE id = ?                    → trigger
 *     SELECT COUNT(*) FROM vec_exchanges                        → view
 *     SELECT id, embedding FROM vec_exchanges WHERE id IN (…)   → view
 *     SELECT id, distance FROM vec_exchanges
 *       WHERE embedding MATCH ? ORDER BY distance LIMIT ?       → view + UDFs
 *
 * The last one is the only interesting line. In SQLite `x MATCH y` is sugar
 * for the application-defined function `match(y, x)`; virtual tables override
 * it and everyone else gets an error. potsherd defines it: `match()` records
 * the query vector for the statement and returns 1, and the view's `distance`
 * column is `potsherd_vec_distance(embedding)`, which scores against that
 * recorded vector. WHERE is evaluated before the output columns of the first
 * row, so the vector is always there by the time a distance is asked for, and
 * when it is not the distance is `+inf` rather than a wrong number. Both
 * functions are registered non-deterministic so no planner hoists them.
 *
 * Verified on **both** drivers — `better-sqlite3` and `node:sqlite` — against
 * a JavaScript ground truth: identical ids, identical distances, zero error.
 *
 * ## the contract that did not change
 *
 * **Fail soft, and say so.** Nothing here throws. If anything at all is wrong,
 * {@link vecStatus} answers with a reason, `index` still parses and redacts,
 * `find` still runs fts5, and `doctor` prints the one line that says which of
 * the two indexes you have.
 */

export interface VecStatus {
  available: boolean;
  /** Which engine answers a KNN query: the built-in scan, or vec0 when asked. */
  backend?: 'scan' | 'sqlite-vec';
  /** `vec_version()`, when `sqlite-vec` happens to be installed. Informational. */
  version?: string;
  /** Absolute path of the loadable extension, when one was found. */
  path?: string;
  /** One line, for `doctor`, when it is not available. */
  reason?: string;

  // Everything below is populated only when {@link vecStatus} is given a
  // potsherd root, which is the call `index`, `doctor` and `find` all make.
  // They are carried on the status object rather than exported separately so
  // that there is one import, one call, and no way for two verbs to render
  // the same fact from two different places — which is the whole of audit F2's
  // second half.

  /** The numbers: embedded, pending, total, and what phase that adds up to. */
  report?: VectorReport;
  /** The `vectors` row, already worded, with a note that fits a given width. */
  row?: VectorRow;
  /** The one status sentence for a verb to print, or null when there is none. */
  line?: string | null;
  /**
   * Advance the index: embed what is pending, newest first, on this
   * connection. Bound here so a caller that has the status has the pass, and
   * cannot end up embedding into a different database than it just counted.
   */
  embed?: (options?: EmbedPendingOptions) => Promise<EmbedPendingResult>;
}

export interface VectorRow {
  value: string;
  parts: string[];
  tone: 'ok' | 'warn' | 'dim';
  /** The parts joined to `width`, dropping whole clauses rather than cutting. */
  note(width: number, sep?: string): string;
}

const require_ = createRequire(import.meta.url);

/** Per-connection: functions and extensions belong to a connection, not a process. */
const loaded = new WeakMap<Db, VecStatus>();
/** The query vector of the statement currently running, per connection. */
const needles = new WeakMap<Db, Float32Array>();

// -------------------------------------------------------------- the functions

/**
 * Teach this connection `match()` and `potsherd_vec_distance()`.
 *
 * Both drivers expose `function(name, options, impl)`. A driver that does not
 * is not a failure worth crashing over: vector search is then absent and text
 * search is not, which is the same answer as every other missing piece here.
 */
function installVectorFunctions(db: Db): { ok: true } | { ok: false; reason: string } {
  const fn = (db as unknown as { function?: unknown }).function;
  if (typeof fn !== 'function') {
    return { ok: false, reason: 'this sqlite driver cannot register functions' };
  }
  try {
    const register = (
      db as unknown as {
        function(name: string, opts: Record<string, unknown>, impl: (...a: never[]) => unknown): void;
      }
    ).function.bind(db);

    // `embedding MATCH ?` compiles to `match(?, embedding)` — two arguments,
    // and both drivers take the arity from `fn.length`, so the row argument
    // has to be declared even though the ranking does not use it here. It
    // records the query vector for the rest of the statement and admits every
    // row; the ranking is the ORDER BY, exactly as it was under vec0.
    register('match', { deterministic: false }, ((needle: unknown, _row: unknown) => {
      void _row;
      if (needle instanceof Uint8Array || Buffer.isBuffer(needle)) {
        needles.set(db, blobToEmbedding(needle as Uint8Array));
      }
      return 1;
    }) as never);

    // The view's `distance` column: L2 between the recorded query vector and
    // this row's. L2 over unit vectors is a monotone function of cosine, so
    // `l2DistanceToCosineSimilarity` in `recall.ts` keeps meaning what it
    // meant, and the order is the order vec0 produced.
    register('potsherd_vec_distance', { deterministic: false }, ((row: unknown) => {
      const q = needles.get(db);
      if (!q) return Number.MAX_VALUE;
      if (!(row instanceof Uint8Array) && !Buffer.isBuffer(row)) return Number.MAX_VALUE;
      const v = blobToEmbedding(row as Uint8Array);
      const n = Math.min(q.length, v.length);
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        const d = (q[i] ?? 0) - (v[i] ?? 0);
        sum += d * d;
      }
      return Math.sqrt(sum);
    }) as never);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: firstLine((err as Error)?.message ?? String(err)) };
  }
}

/**
 * `sqlite-vec`, if it is on the machine.
 *
 * Nothing depends on this any more. It is loaded so that migration 10 can read
 * the vectors out of a database that was built when it did, and so `doctor`
 * can name the version it found. `POTSHERD_NO_VEC` turns it off, which is the
 * one honest way to test the path everybody else is already on.
 */
function loadLegacyExtension(db: Db): { version?: string; path?: string } {
  const off = process.env['POTSHERD_NO_VEC'];
  if (off && off !== '0') return {};
  try {
    const mod = require_('sqlite-vec') as { getLoadablePath(): string };
    const p = mod.getLoadablePath();
    (db as unknown as { loadExtension(p: string): void }).loadExtension(p);
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string } | undefined;
    return { path: p, ...(row?.v ? { version: row.v } : {}) };
  } catch {
    return {};
  }
}

/**
 * Prepare this connection for vector work. Idempotent, cached, and total: a
 * failure is a {@link VecStatus} with a reason, never an exception.
 */
export function loadVec(db: Db): VecStatus {
  const cached = loaded.get(db);
  if (cached) return cached;

  const fns = installVectorFunctions(db);
  const legacy = loadLegacyExtension(db);
  const status: VecStatus = fns.ok
    ? { available: true, backend: 'scan', ...legacy }
    : { available: false, reason: fns.reason, ...legacy };
  loaded.set(db, status);
  return status;
}

/**
 * Status of vector search on this connection.
 *
 * With a `root`, it is also **the one source of truth for the `vectors` line**
 * — `index`, `doctor` and `find` all read their numbers from here, so they
 * cannot disagree in print the way audit F2 caught them doing. Without one it
 * is the cheap, cached backend check that `recall.ts` calls on every query.
 */
export function vecStatus(db: Db, root?: string): VecStatus {
  const base = loaded.get(db) ?? loadVec(db);
  if (root === undefined) return base;
  const counts = vectorCounts(db);
  const cacheDir = modelsDir(potsherdDir(root));
  const backend = embeddingBackend();
  // Deliberately a pure function of the database and the cache directory.
  // Whether *this* process is allowed to reach the network is a property of
  // this process, not of the index, and folding it in here made `doctor`,
  // `index` and `find` describe the same index differently depending on which
  // one you happened to run — the exact failure this call exists to end. The
  // verb that knows it is offline says so in its own sentence.
  const reason = base.available ? undefined : base.reason;
  const report = vectorReport({
    embedded: counts.embedded,
    pending: counts.pending,
    cacheDir,
    ...(backend ? { backend } : {}),
    ...(reason ? { reason } : {}),
  });
  const worded = vectorNote(report, { num: fmtNum, bytes: fmtBytes });
  return {
    ...base,
    report,
    row: {
      ...worded,
      note: (width: number, sep = ' · ') => fitNote(worded.parts, width, sep),
    },
    line: statusLine(report),
    embed: (options: EmbedPendingOptions = {}) =>
      embedPending(db, { cacheDir, ...options }),
  };
}

/**
 * The one sentence a verb prints while semantic search is not yet whole.
 *
 * `05`'s honesty contract and the audit's item 9 — *tell me what you can't do,
 * at the top* — with the audit's own wording for the shape: a **status, not a
 * degradation apology**. There is no command in it because there is nothing
 * for the reader to do; the work is already running. `null` when everything is
 * embedded, and `null` on an empty index, because a verb that has nothing to
 * report should print nothing.
 */
function statusLine(r: VectorReport): string | null {
  if (r.phase === 'ready' || r.phase === 'empty') return null;
  if (r.phase === 'unavailable') {
    return `semantic search: ${r.reason ?? 'not running on this machine'}`;
  }
  return warmingLine(r, fmtNum);
}

export function vecAvailable(db: Db): boolean {
  return vecStatus(db).available;
}

// ------------------------------------------------------------------- schema

/**
 * Every object the portable vector store needs, as one idempotent script.
 *
 * The blob tables are the storage. The views are the compatibility surface —
 * every `vec_*` statement written against vec0 keeps working — and the
 * `INSTEAD OF` triggers make them writable. All plain SQL: no extension, no
 * driver-specific feature, nothing that can decline.
 */
const EXCHANGE_STORE = `
CREATE TABLE IF NOT EXISTS vec_blob_exchanges (
  id TEXT PRIMARY KEY, embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS vec_blob_cards (
  session_id TEXT PRIMARY KEY, embedding BLOB NOT NULL
);
CREATE VIEW IF NOT EXISTS vec_exchanges AS
  SELECT id, embedding, potsherd_vec_distance(embedding) AS distance
    FROM vec_blob_exchanges;
CREATE TRIGGER IF NOT EXISTS vec_exchanges_insert INSTEAD OF INSERT ON vec_exchanges
BEGIN
  INSERT OR REPLACE INTO vec_blob_exchanges (id, embedding) VALUES (NEW.id, NEW.embedding);
END;
CREATE TRIGGER IF NOT EXISTS vec_exchanges_delete INSTEAD OF DELETE ON vec_exchanges
BEGIN
  DELETE FROM vec_blob_exchanges WHERE id = OLD.id;
END;
CREATE VIEW IF NOT EXISTS vec_cards AS
  SELECT session_id, embedding, potsherd_vec_distance(embedding) AS distance
    FROM vec_blob_cards;
CREATE TRIGGER IF NOT EXISTS vec_cards_insert INSTEAD OF INSERT ON vec_cards
BEGIN
  INSERT OR REPLACE INTO vec_blob_cards (session_id, embedding)
    VALUES (NEW.session_id, NEW.embedding);
END;
CREATE TRIGGER IF NOT EXISTS vec_cards_delete INSTEAD OF DELETE ON vec_cards
BEGIN
  DELETE FROM vec_blob_cards WHERE session_id = OLD.session_id;
END;
`;

const GHOST_STORE = `
CREATE TABLE IF NOT EXISTS vec_blob_ghost_prompts (
  id TEXT PRIMARY KEY, embedding BLOB NOT NULL
);
CREATE VIEW IF NOT EXISTS vec_ghost_prompts AS
  SELECT id, embedding, potsherd_vec_distance(embedding) AS distance
    FROM vec_blob_ghost_prompts;
CREATE TRIGGER IF NOT EXISTS vec_ghost_prompts_insert
INSTEAD OF INSERT ON vec_ghost_prompts
BEGIN
  INSERT OR REPLACE INTO vec_blob_ghost_prompts (id, embedding) VALUES (NEW.id, NEW.embedding);
END;
CREATE TRIGGER IF NOT EXISTS vec_ghost_prompts_delete
INSTEAD OF DELETE ON vec_ghost_prompts
BEGIN
  DELETE FROM vec_blob_ghost_prompts WHERE id = OLD.id;
END;
`;

/**
 * Migration 4's body, and it no longer declines.
 *
 * It used to return false on a machine without `sqlite-vec` — "not applied,
 * ask me again next time" — which meant that on most machines the schema
 * stopped at version 3 forever and semantic search was structurally
 * impossible. Nothing here needs an extension any more, so nothing here can
 * decline.
 */
export function createVecTables(db: Db): boolean {
  loadVec(db);
  try {
    if (legacyVecTable(db, 'vec_exchanges') || legacyVecTable(db, 'vec_cards')) {
      // A database that already has vec0 tables under these names. Migration
      // 10 owns that conversion; this migration has nothing left to do and
      // must not fail the run.
      return true;
    }
    db.exec(EXCHANGE_STORE);
    return true;
  } catch {
    return false;
  }
}

/** Migration 8's body, for recovered prompts. Same rules, same guarantees. */
export function createGhostVecTable(db: Db): boolean {
  loadVec(db);
  try {
    if (legacyVecTable(db, 'vec_ghost_prompts')) return true;
    db.exec(GHOST_STORE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migration 10's body: move an existing index off the native extension.
 *
 * Three cases, and only one of them can decline:
 *
 *   1. **Nothing to convert.** The usual case, and a fresh index. The portable
 *      objects are created and the migration is done.
 *   2. **vec0 tables that can be read.** `sqlite-vec` is installed, so every
 *      vector is copied into the blob tables before the virtual tables are
 *      dropped. Nobody loses an index they already paid for.
 *   3. **vec0 tables that cannot be read.** The extension is gone from a
 *      machine that once had it, so sqlite cannot open — or drop — the virtual
 *      tables at all. This declines rather than throwing, so it is retried on
 *      the next open, and `doctor` says what is in the way.
 */
export function migrateToPortableVectors(db: Db): boolean {
  loadVec(db);
  const legacy = (['vec_exchanges', 'vec_cards', 'vec_ghost_prompts'] as const).filter((t) =>
    legacyVecTable(db, t),
  );
  try {
    for (const table of legacy) {
      const key = table === 'vec_cards' ? 'session_id' : 'id';
      const blob = `vec_blob_${table.slice('vec_'.length)}`;
      db.exec(
        table === 'vec_ghost_prompts'
          ? `CREATE TABLE IF NOT EXISTS vec_blob_ghost_prompts (id TEXT PRIMARY KEY, embedding BLOB NOT NULL);`
          : `CREATE TABLE IF NOT EXISTS ${blob} (${key} TEXT PRIMARY KEY, embedding BLOB NOT NULL);`,
      );
      const rows = db.prepare(`SELECT ${key} AS k, embedding AS e FROM ${table}`).all() as {
        k: string;
        e: Uint8Array;
      }[];
      const insert = db.prepare(`INSERT OR REPLACE INTO ${blob} (${key}, embedding) VALUES (?, ?)`);
      for (const row of rows) insert.run(row.k, row.e);
      db.exec(`DROP TABLE ${table};`);
    }
  } catch (err) {
    // Case 3. Not an error the user caused and not one they can be asked to
    // fix mid-migration; decline and try again next time.
    void err;
    return false;
  }
  db.exec(EXCHANGE_STORE);
  db.exec(GHOST_STORE);
  return true;
}

/** True when `name` exists and is a vec0 virtual table rather than our view. */
function legacyVecTable(db: Db, name: string): boolean {
  try {
    const row = db
      .prepare(`SELECT type, sql FROM sqlite_master WHERE name = ?`)
      .get(name) as { type: string; sql: string | null } | undefined;
    return Boolean(row && row.type === 'table' && /USING\s+vec0/i.test(row.sql ?? ''));
  } catch {
    return false;
  }
}

/** True when this database can answer a vector query, view or virtual table. */
export function vecTablesExist(db: Db): boolean {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vec_exchanges'`)
      .get() as { n: number };
    return row.n > 0;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- counts

/**
 * How much of the index carries a current vector, and how much is waiting.
 *
 * Counted from `exchanges.embedding_version` and `ghost_prompts.embedding_version`
 * — the stamp the embedding pass writes — rather than from the vector tables,
 * because that is the number that decides whether there is work left to do. A
 * vector whose `EMBEDDING_VERSION` no longer matches is pending, not embedded.
 */
export function vectorCounts(db: Db): { embedded: number; pending: number } {
  let embedded = 0;
  let pending = 0;
  for (const table of ['exchanges', 'ghost_prompts'] as const) {
    try {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN embedding_version = ? THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN embedding_version IS NULL OR embedding_version != ? THEN 1 ELSE 0 END) AS todo
           FROM ${table}`,
        )
        .get(EMBEDDING_VERSION, EMBEDDING_VERSION) as { ok: number | null; todo: number | null };
      embedded += row.ok ?? 0;
      pending += row.todo ?? 0;
    } catch {
      // No such table yet, or no such column. Nothing to count.
    }
  }
  return { embedded, pending };
}

export { fitNote, vectorNote, vectorReport, warmingLine };
export type { VectorReport };

// ------------------------------------------------------------------ embedding

export interface EmbedPendingOptions {
  /** Where the runtime and weights live. Defaults to `~/.potsherd/models`. */
  cacheDir?: string;
  /** Stop after this many rows, so a foreground caller can bound its own time. */
  limit?: number;
  /** Never reach the network; embed only if everything is already on disk. */
  noAcquire?: boolean;
  /** Called after every row, and during the first-run acquisition. */
  onProgress?: (p: EmbedProgress) => void;
  /** Checked between rows. Returning true stops the pass cleanly. */
  shouldStop?: () => boolean;
}

export type EmbedProgress =
  | { phase: 'acquire'; done: number; total: number; file: string }
  | { phase: 'embed'; done: number; total: number };

export interface EmbedPendingResult {
  embedded: number;
  remaining: number;
  ms: number;
  backend?: EmbeddingBackend;
  /** Present when the pass could not run, or stopped early. One line. */
  reason?: string;
}

/**
 * Embed what is not embedded yet, **newest first**.
 *
 * Newest first is not a preference, it is the consequence of a measurement.
 * The wasm runtime is 6.5× slower than the native one it replaced (234 ms
 * against 36 ms per exchange on the reference machine), so on the reference
 * archive a full pass is minutes rather than seconds. §A2 item 3 says: if wasm
 * is more than 5× slower, embed newest-first so recent sessions get vectors in
 * the first minute. At 234 ms that is roughly 250 exchanges in the first
 * minute — and the exchanges a person searches for minutes after `index` are
 * overwhelmingly the ones they were just in.
 *
 * Ordered by `ts DESC` with nulls last, so a transcript with no timestamps
 * never displaces one that has them. Restartable by construction: the only
 * state is `embedding_version`, so a pass that is killed halfway simply leaves
 * fewer rows for the next one.
 */
export async function embedPending(
  db: Db,
  options: EmbedPendingOptions = {},
): Promise<EmbedPendingResult> {
  const started = Date.now();
  const cacheDir = options.cacheDir ?? modelsDir();
  const status = loadVec(db);
  if (!status.available) {
    return { embedded: 0, remaining: 0, ms: Date.now() - started, reason: status.reason ?? 'no vector store' };
  }

  const queue = pendingRows(db, options.limit);
  if (queue.error) {
    return { embedded: 0, remaining: 0, ms: Date.now() - started, reason: queue.error };
  }
  const rows = queue.rows;
  if (rows.length === 0) {
    return { embedded: 0, remaining: 0, ms: Date.now() - started };
  }

  const embedOptions = {
    cacheDir,
    ...(options.noAcquire ? { noAcquire: true } : {}),
    ...(options.onProgress
      ? {
          onProgress: (fraction: number, file: string) =>
            options.onProgress?.({
              phase: 'acquire',
              done: Math.round(fraction * 100),
              total: 100,
              file,
            }),
        }
      : {}),
  };

  const writers = {
    exchange: {
      insert: db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)'),
      stamp: db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?'),
    },
    ghost: {
      insert: db.prepare('INSERT INTO vec_ghost_prompts (id, embedding) VALUES (?, ?)'),
      stamp: db.prepare('UPDATE ghost_prompts SET embedding_version = ? WHERE id = ?'),
    },
  };

  let embedded = 0;
  let reason: string | undefined;
  for (const row of rows) {
    if (options.shouldStop?.()) {
      reason = 'stopped';
      break;
    }
    let vector: number[];
    try {
      vector = await generateExchangeEmbedding(
        row.userText,
        row.assistantText,
        undefined,
        embedOptions,
      );
    } catch (err) {
      reason =
        err instanceof EmbeddingUnavailableError
          ? err.reason
          : firstLine((err as Error)?.message ?? String(err));
      break;
    }
    const w = row.kind === 'ghost' ? writers.ghost : writers.exchange;
    try {
      w.insert.run(row.id, embeddingToBlob(vector));
      w.stamp.run(EMBEDDING_VERSION, row.id);
      embedded += 1;
    } catch (err) {
      reason = firstLine((err as Error)?.message ?? String(err));
      break;
    }
    options.onProgress?.({ phase: 'embed', done: embedded, total: rows.length });
  }

  const backend = embeddingBackend();
  return {
    embedded,
    remaining: vectorCounts(db).pending,
    ms: Date.now() - started,
    ...(backend ? { backend } : {}),
    ...(reason ? { reason } : {}),
  };
}

interface PendingRow {
  kind: 'exchange' | 'ghost';
  id: string;
  userText: string;
  assistantText: string;
}

/**
 * The work queue, newest first.
 *
 * Exchanges and recovered prompts are one queue rather than two passes,
 * because they compete for the same minutes and a ghost prompt is one sentence
 * against an exchange's two — a run that did all the exchanges before touching
 * a ghost would leave the cheapest rows for last.
 */
function pendingRows(db: Db, limit?: number): { rows: PendingRow[]; error?: string } {
  const cap = limit && limit > 0 ? limit : 1_000_000;
  // The ORDER BY lives outside the compound SELECT deliberately: sqlite only
  // accepts result-column names or ordinals as ORDER BY terms on a UNION, so
  // `ORDER BY ts IS NULL, ts DESC` written inside one is a prepare-time error
  // — which is exactly the kind of failure a bare `catch { return [] }` turns
  // into "there is nothing to embed", silently, forever. The wrapper makes the
  // expression legal and the error is now returned rather than swallowed.
  const sql = `
SELECT kind, id, a, b FROM (
  SELECT 'exchange' AS kind, id, user_text AS a, assistant_text AS b, ts
    FROM exchanges
   WHERE embedding_version IS NULL OR embedding_version != ?
  UNION ALL
  SELECT 'ghost' AS kind, id, text AS a, NULL AS b, ts
    FROM ghost_prompts
   WHERE embedding_version IS NULL OR embedding_version != ?
)
ORDER BY ts IS NULL, ts DESC
LIMIT ?`;
  let raw: { kind: string; id: string; a: string; b: string | null }[];
  try {
    raw = db
      .prepare(sql)
      .all(EMBEDDING_VERSION, EMBEDDING_VERSION, Math.min(cap, 1_000_000)) as typeof raw;
  } catch (err) {
    return { rows: [], error: firstLine((err as Error)?.message ?? String(err)) };
  }
  return {
    rows: raw.map((r) => ({
      kind: r.kind === 'ghost' ? 'ghost' : 'exchange',
      id: r.id,
      userText: r.a ?? '',
      assistantText: r.b ?? '',
    })),
  };
}

/** Exported so `doctor` can name the thread count without importing two modules. */
export { embedThreads };

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}
