import { createRequire } from 'node:module';
import process from 'node:process';
import type { Db } from './db.js';
import { sqliteDriverName } from './sqlite-driver.js';
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
import {
  fitNote,
  stoppedLine,
  vectorNote,
  vectorReport,
  warmingHead,
  warmingLine,
  type VectorReport,
} from './doctor-line.js';
import { holder } from './lock.js';
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
  /**
   * The vec0 virtual tables a 1.1.0 index left behind that this connection
   * cannot read — empty on every healthy database, and the whole of FIX-H's
   * N1 when it is not.
   *
   * It is on the status object rather than behind a second call for the same
   * reason everything else here is: `index`, `find` and `doctor` must not be
   * able to describe this state differently, and `doctor` is the one verb that
   * can *only* see it (it opens read-only, so it never runs the migration that
   * clears it).
   */
  legacy?: readonly VecTable[];

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

/** The three names `03 §3` gave the store, and the three 1.1.0 built as vec0. */
export type VecTable = 'vec_exchanges' | 'vec_cards' | 'vec_ghost_prompts';

const VEC_TABLES: readonly VecTable[] = ['vec_exchanges', 'vec_cards', 'vec_ghost_prompts'];

/** What {@link installCore} establishes once per connection, and caches. */
interface VecCore {
  ok: boolean;
  reason?: string;
  version?: string;
  path?: string;
}

/**
 * Per-connection: functions and extensions belong to a connection, not a
 * process — and **only** functions and extensions.
 *
 * What is deliberately *not* cached here is whether the vec tables can be used,
 * because that is a fact about the file and it changes underneath a live
 * connection: migration 10 converts three vec0 virtual tables into three views
 * while `open()` is still running, on the same handle that asked the question a
 * moment earlier. A cached "no" would then survive the repair and switch
 * embedding off for the rest of the process — the fix hiding itself, which is
 * the shape of the bug being fixed here. {@link strandedVecTables} is one
 * `sqlite_master` read on a healthy database and is answered fresh every time.
 */
const cores = new WeakMap<Db, VecCore>();
/** Why migration 10 could not convert, when it could not. See {@link strandedReason}. */
const declines = new WeakMap<Db, string>();
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

/** The half of {@link loadVec} that is connection state: registered once, cached. */
function installCore(db: Db): VecCore {
  const cached = cores.get(db);
  if (cached) return cached;
  const fns = installVectorFunctions(db);
  const ext = loadLegacyExtension(db);
  const core: VecCore = fns.ok ? { ok: true, ...ext } : { ok: false, reason: fns.reason, ...ext };
  cores.set(db, core);
  return core;
}

/**
 * Prepare this connection for vector work. Idempotent and total: a failure is a
 * {@link VecStatus} with a reason, never an exception.
 *
 * Two things can be wrong, and they are different sentences:
 *
 *   1. **This driver cannot register functions.** Nothing can be scored, so
 *      there is no vector search on this machine at all.
 *   2. **A 1.1.0 index left vec0 virtual tables behind** and the extension that
 *      made them readable is no longer on the machine. Every statement naming
 *      one of them throws `no such module: vec0` at *prepare* time — which is
 *      exactly where `potsherd index` died (`ingest.ts` `clearExchanges`).
 *
 * Case 2 reports `available: false` on purpose rather than being handled at
 * each of the call sites that touch the store: every one of them already asks
 * this question before writing a vector, so one honest answer here turns a
 * crash into the degradation this file's contract promises. Migration 10 clears
 * the state on the next write-open; until then the reason names the command
 * that clears it.
 */
export function loadVec(db: Db): VecStatus {
  const core = installCore(db);
  const ext = {
    ...(core.version ? { version: core.version } : {}),
    ...(core.path ? { path: core.path } : {}),
  };
  if (!core.ok) return { available: false, ...(core.reason ? { reason: core.reason } : {}), ...ext };
  const stranded = strandedVecTables(db);
  if (stranded.length > 0) {
    return { available: false, legacy: stranded, reason: strandedReason(db), ...ext };
  }
  return { available: true, backend: 'scan', ...ext };
}

/**
 * The vec0 tables of a 1.1.0 index that this connection cannot read.
 *
 * Both halves are load-bearing. `type = 'table'` excludes the views migration
 * 10 puts under the same three names, so a converted database answers with one
 * cheap query and no `prepare` at all. `USING vec0` is then checked against the
 * stored DDL, and only a name that passes both is *tried*: a `prepare` is
 * enough, because "no such module" is raised while compiling, and it is the
 * whole question — a statement that cannot be compiled cannot be run.
 */
function strandedVecTables(db: Db): VecTable[] {
  const out: VecTable[] = [];
  let rows: { name: string; sql: string | null }[];
  try {
    rows = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'table' AND name IN ('vec_exchanges', 'vec_cards', 'vec_ghost_prompts')`,
      )
      .all() as { name: string; sql: string | null }[];
  } catch {
    return out;
  }
  for (const row of rows) {
    if (!/USING\s+vec0/i.test(row.sql ?? '')) continue;
    if (statementsCompile(db, row.name)) continue;
    out.push(row.name as VecTable);
  }
  return out;
}

/** Can sqlite compile a statement against this name on this connection? */
function statementsCompile(db: Db, name: string): boolean {
  try {
    db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The sentence for a stranded vec0 index — and it must name a command that
 * runs, because the whole finding is that the old one did not.
 *
 * **The command comes first, and that is a measurement, not a preference.**
 * `doctor`'s note column is 43 characters at width 80 and 63 at its maximum, and
 * a row is elided from the right. Written the other way round — *"a vec0 index
 * written by potsherd 1.1.0 — run potsherd index"* — a real `doctor` printed
 * `a vec0 index written by potsherd 1.1.0 — r…` at *both* widths, which is the
 * `plans/04` truncation defect in its worst form: the clause that survives is
 * the one the reader can do nothing with. The verb is 18 characters and fits
 * everywhere, so it leads and the explanation is what gets dropped.
 *
 * The ordinary case is the first: the database has not been opened for writing
 * since the upgrade, `doctor` opens read-only and therefore never migrates, and
 * `potsherd index` is the verb that converts it. The second only appears after
 * migration 10 has actually tried and been refused, and it names the driver
 * that is measured to succeed — `node:sqlite` writes `sqlite_master` under
 * `writable_schema`, and a `better-sqlite3` too old for `unsafeMode` cannot.
 *
 * ## the third case, and why it needs a sentence of its own
 *
 * VERIFICATION-6 C-8: on a database that is stranded **and already stamped**,
 * `potsherd index` prescribed `potsherd index`, and it will never work.
 * `migrate()` skips any version already in `schema_migrations`, so once 10 is
 * recorded, migration 10 cannot run again on that file — whatever put it in
 * that state. A decline records nothing and retries on the next open, which is
 * what makes the first two sentences true; a *recorded* 10 is the one shape
 * where they are not. `tests/upgrade-from-1.1.test.ts` builds it and calls it
 * requirement 2, the requirement was *must not throw*, and it does not — the
 * sentence was simply not brought along.
 *
 * So the state is asked rather than assumed, from the one table that decides
 * it, and the sentence for it names something that actually works. There is no
 * verb that repairs this file: the three vec0 names cannot be dropped without
 * the extension, and no migration will be offered the chance to try. What is
 * left is a rebuild, and the note says so with the command first, because
 * `doctor`'s note column is 43 characters and elides from the right.
 */
function strandedReason(db: Db): string {
  const declined = declines.get(db);
  if (declined) return declined;
  if (!portableVectorsStamped(db)) {
    return 'run potsherd index — it converts a vec0 store written by 1.1.0';
  }
  return 'delete potsherd.db and run potsherd index — this vec0 store cannot be converted in place';
}

/**
 * Is migration 10 already recorded on this database?
 *
 * Read straight from `schema_migrations`, because that table is the whole of
 * what `migrate()` consults before it decides to skip a version, and a second
 * idea about "has the conversion run" is how the sentence above came to be
 * false in the first place. `false` on any error: an unreadable
 * `schema_migrations` is a database nothing has migrated, and the ordinary
 * sentence is the right one for it.
 */
function portableVectorsStamped(db: Db): boolean {
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?')
      .get(PORTABLE_VECTORS) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Migration 10's version number, named here because this file is where its
 * body lives ({@link migrateToPortableVectors}) and `db.ts` is where its
 * registration does. A bare `10` in a predicate about "has the conversion run"
 * is the kind of constant that outlives the reason for it.
 */
const PORTABLE_VECTORS = 10;

/**
 * Can this connection run a statement against `table` right now?
 *
 * The predicate every write path should ask before naming one of the three, and
 * the one `vecTablesExist` could not be: that one reads `sqlite_master`, and a
 * stranded vec0 table is present in `sqlite_master` and unusable, which is
 * precisely how `clearExchanges` came to prepare a `DELETE` that threw.
 */
export function vecTableUsable(db: Db, table: VecTable = 'vec_exchanges'): boolean {
  if (!loadVec(db).available) return false;
  return statementsCompile(db, table);
}

/**
 * Status of vector search on this connection.
 *
 * With a `root`, it is also **the one source of truth for the `vectors` line**
 * — `index`, `doctor` and `find` all read their numbers from here, so they
 * cannot disagree in print the way audit F2 caught them doing. Without one it
 * is the cheap, cached backend check that `recall.ts` calls on every query.
 */
export function vecStatus(
  db: Db,
  root?: string,
  opts: {
    /**
     * Override the lock read — FIX-F round 2.
     *
     * Exactly one caller may pass this and it is the one that has just
     * **started** a pass: `cli/commands/index.ts` spawns a detached embedder
     * and then prints its receipt microseconds later, before the child has had
     * time to `mkdir` the lock. For that window the spawner knows something the
     * lock does not, and this is where it says so — once, into the report every
     * one of the receipt's three renderings (`row`, `line`, `--json`) is built
     * from, so they cannot disagree about it.
     *
     * It is deliberately not a way to *silence* the fact: `working: false` is
     * what the lock already says whenever nobody holds the lane, and no caller
     * has any reason to assert it.
     */
    working?: boolean;
  } = {},
): VecStatus {
  const base = loadVec(db);
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
  // FIX-F C2 — is anybody actually embedding the rest?
  //
  // The counts say how far the index has got; they cannot say whether a pass
  // is under way, and every surface used to assume one was. The background
  // worker holds `<root>/.lock.embed` for the whole pass and writes its `pid`
  // into it, so the lock is the evidence — and `lock.holder` already answers
  // `null` for a lock whose owner is gone, which is exactly the crashed-embedder
  // case that must read as stopped rather than as warming. It is a read: it
  // never creates, removes or waits on anything, so asking it here cannot
  // block a verb or lose a lock.
  const working = opts.working ?? holder({ root, lane: 'embed' }) !== null;
  const report = vectorReport({
    embedded: counts.embedded,
    pending: counts.pending,
    cacheDir,
    working,
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
  // FIX-F round 2 — the sentence a verb prints while it *waits* is only true
  // while something is running. The lock says which; see
  // {@link VectorReport.working}. `undefined` keeps the old sentence, because
  // a caller with no root could not ask and must not guess.
  //
  // `index` does not read this branch when it has just spawned a worker: it
  // computes this report *before* the spawn, so for a few milliseconds the
  // lock has not caught up and it knows better. It passes its own `spawned`
  // flag to {@link warmingLine} instead — `cli/commands/index.ts`, and there
  // are three assertions in `tests/index.test.ts` that go red if that is
  // undone.
  if (r.working === false) return stoppedLine(r, fmtNum, fmtBytes);
  // `fmtBytes` as well as `fmtNum` — VERIFICATION-6 C-7. `warmingLine` now
  // carries the same fetch clause `doctor`'s row does, and a clause with a
  // byte figure in it has to be given the same formatter or the two surfaces
  // print `46.1 MB` and `48 MB` for one number.
  return warmingLine(r, fmtNum, fmtBytes);
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
 * Three cases, and the third is FIX-H:
 *
 *   1. **Nothing to convert.** The usual case, and a fresh index. The portable
 *      objects are created and the migration is done.
 *   2. **vec0 tables that can be read.** `sqlite-vec` is installed, so every
 *      vector is copied into the blob tables before the virtual tables are
 *      dropped. Nobody loses an index they already paid for. This path is tried
 *      first for every table, always, precisely because it is the one that
 *      keeps the vectors.
 *   3. **vec0 tables that cannot be read.** The extension is gone from a
 *      machine that once had it. This used to decline — and the comment said so
 *      as a limitation, which by `plans/09 §13.9` makes it an open item and not
 *      boilerplate. It was: the migration declined politely and then every verb
 *      downstream threw `no such module: vec0`, because `index` re-reads every
 *      transcript after migration 11 and `clearExchanges` prepares a `DELETE`
 *      against `vec_exchanges` for each one. That is the whole of the audit's
 *      N1, and it is release-blocking on every database written by 1.1.0.
 *
 * **Half of the stated blocker was true.** sqlite genuinely cannot `DROP` a
 * virtual table whose module is missing — the drop calls the module's own
 * destructor — and `ALTER TABLE … RENAME` fails for the same reason (both
 * measured, both `no such module: vec0`). But the *schema is data*: under
 * `PRAGMA writable_schema` the row can be deleted from `sqlite_master`
 * directly, and vec0's storage is four **ordinary** tables (`_chunks`, `_info`,
 * `_rowids`, `_vector_chunks00`) which then drop normally. See
 * {@link detachStranded} for the driver difference that decides whether that is
 * allowed, which is why it is asked rather than assumed.
 *
 * **What is lost, said plainly.** A vector inside a vec0 table this machine
 * cannot read is already unreachable: no query can select it and no verb can
 * use it. Dropping it therefore loses nothing that was still recoverable —
 * whereas leaving it in place loses the entire product for that user. The
 * exchange and ghost vectors are rebuilt for free by the background pass
 * ({@link forgetStrandedStamps}); card vectors are not stamped and are rebuilt
 * on the next `potsherd card`, with the card's own text, cost and mirror
 * untouched in `cards` and on disk.
 */
export function migrateToPortableVectors(db: Db): boolean {
  installCore(db);
  const legacy = VEC_TABLES.filter((t) => legacyVecTable(db, t));
  if (legacy.length === 0) {
    db.exec(EXCHANGE_STORE);
    db.exec(GHOST_STORE);
    declines.delete(db);
    return true;
  }

  const stranded: VecTable[] = [];
  try {
    for (const table of legacy) {
      if (!copyVectorsAcross(db, table)) stranded.push(table);
    }
  } catch {
    return decline(db, `${otherDriverCommand()} — this vec0 store could not be read`);
  }

  if (stranded.length > 0 && !detachStranded(db, stranded)) {
    return decline(
      db,
      `${otherDriverCommand()} — this sqlite will not rewrite a schema`,
    );
  }

  db.exec(EXCHANGE_STORE);
  db.exec(GHOST_STORE);
  if (stranded.length > 0) forgetStrandedStamps(db, stranded);
  declines.delete(db);
  return true;
}

/**
 * The command for the driver that is **not** the one that just refused.
 *
 * It used to name `POTSHERD_SQLITE=node` unconditionally, and FIX-H2 is the
 * proof that a hardcoded answer here becomes a lie: from Node v24.19.0 it is
 * `node:sqlite` that refuses the schema rewrite, so on that build the sentence
 * told the reader to re-run on the driver they were already on and had just
 * watched fail. Neither driver is *the* answer; the other one is, and which
 * one that is is a fact this process knows. `plans/05`: never print a command
 * the reader cannot follow, and never one that cannot work.
 */
function otherDriverCommand(): string {
  return sqliteDriverName() === 'node:sqlite'
    ? 'run POTSHERD_SQLITE=better-sqlite3 potsherd index'
    : 'run POTSHERD_SQLITE=node potsherd index';
}

/** Record why, then decline: nothing is stamped and the next open retries. */
function decline(db: Db, reason: string): false {
  declines.set(db, reason);
  return false;
}

/**
 * Case 2: copy every vector out of a readable vec0 table and drop it properly.
 *
 * `false` means the table could not be read — the module is missing — and says
 * nothing about whether it can be dealt with, which is {@link detachStranded}'s
 * question. Anything already copied is removed again so that a half-read table
 * cannot leave a partial index behind claiming to be whole.
 */
function copyVectorsAcross(db: Db, table: VecTable): boolean {
  const key = table === 'vec_cards' ? 'session_id' : 'id';
  const blob = `vec_blob_${table.slice('vec_'.length)}`;
  db.exec(`CREATE TABLE IF NOT EXISTS ${blob} (${key} TEXT PRIMARY KEY, embedding BLOB NOT NULL);`);
  let rows: { k: string; e: Uint8Array }[];
  try {
    rows = db.prepare(`SELECT ${key} AS k, embedding AS e FROM ${table}`).all() as {
      k: string;
      e: Uint8Array;
    }[];
  } catch {
    return false;
  }
  try {
    const insert = db.prepare(`INSERT OR REPLACE INTO ${blob} (${key}, embedding) VALUES (?, ?)`);
    for (const row of rows) insert.run(row.k, row.e);
    db.exec(`DROP TABLE ${table};`);
  } catch {
    db.exec(`DELETE FROM ${blob};`);
    return false;
  }
  return true;
}

/**
 * Case 3: take unreadable vec0 tables out of the schema by hand.
 *
 * **The driver difference, measured rather than assumed** — this is the whole
 * reason the attempt is probed before anything is changed:
 *
 * ```
 * node:sqlite      DELETE FROM sqlite_master …  ->  1 row, integrity_check ok
 * better-sqlite3   DELETE FROM sqlite_master …  ->  table sqlite_master may not be modified
 * better-sqlite3   + db.unsafeMode(true)        ->  1 row, integrity_check ok
 * ```
 *
 * `better-sqlite3` turns `SQLITE_DBCONFIG_DEFENSIVE` **on** by default, and
 * defensive mode refuses every write to `sqlite_master` however
 * `writable_schema` is set; `unsafeMode` is its documented off switch.
 * `node:sqlite` does not set defensive and has no such method. So the capability
 * is *asked for* through {@link allowSchemaWrites} and then **probed with a
 * delete that matches nothing**, which runs the identical authorizer check and
 * changes not one byte. Only when that probe passes is anything actually
 * removed — so a driver that refuses leaves the database exactly as it found
 * it, the migration declines with a reason naming a driver that does not
 * refuse, and no half-rewritten schema can outlive the attempt.
 */
function detachStranded(db: Db, tables: readonly VecTable[]): boolean {
  const restore = allowSchemaWrites(db);
  try {
    try {
      db.pragma('writable_schema = ON');
      // **Read it back.** `PRAGMA writable_schema = ON` is not a request that
      // fails — under `SQLITE_DBCONFIG_DEFENSIVE` sqlite accepts it and does
      // nothing, and it reads back as 0. That is a phantom flag, and this
      // project has now recorded seven of them: a setting that looks applied,
      // succeeds, and has no effect. Trusting it is what sent v1.2.0's
      // migration into the `DELETE` below on Node v24.19.0, where it was
      // refused. The delete that matches nothing stays as the second check —
      // it proves the *write* is permitted, not merely the flag — but the
      // readback is what names the reason.
      if (!schemaIsWritable(db)) return false;
      db.prepare(`DELETE FROM sqlite_master WHERE type = 'table' AND name = ?`).run(
        '__potsherd_probe_no_such_table__',
      );
    } catch {
      return false;
    } finally {
      // RESET is `OFF` plus a reload of the schema this connection has cached.
      // The reload is the load-bearing half below: without it sqlite still
      // believes the name is taken and `CREATE VIEW … vec_exchanges` is a
      // silent no-op under `IF NOT EXISTS`.
      db.pragma('writable_schema = RESET');
    }
    for (const table of tables) {
      try {
        db.pragma('writable_schema = ON');
        db.prepare(`DELETE FROM sqlite_master WHERE type = 'table' AND name = ?`).run(table);
      } finally {
        db.pragma('writable_schema = RESET');
      }
      // Now ordinary tables, and they hold every byte the vectors occupied.
      for (const shadow of shadowTables(db, table)) db.exec(`DROP TABLE IF EXISTS "${shadow}"`);
    }
    return true;
  } catch {
    return false;
  } finally {
    restore();
  }
}

/**
 * Ask this driver to allow a write to `sqlite_master`, and hand back the undo.
 *
 * Asked for by feature rather than by driver name: a driver with no
 * `unsafeMode` either does not need one (`node:sqlite`) or cannot be persuaded,
 * and both answers are the same here — try, and let the probe in
 * {@link detachStranded} say which it was. The undo runs in a `finally`, so
 * defensive mode is off for the deletes of one migration and for nothing else.
 */
/**
 * Did `PRAGMA writable_schema = ON` actually take?
 *
 * `0` means defensive mode swallowed it. Anything unreadable is treated as
 * "no", because a pragma this connection cannot even report on is not one to
 * bet a schema rewrite on.
 */
function schemaIsWritable(db: Db): boolean {
  try {
    const rows = db.pragma('writable_schema') as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const row = rows[0] as Record<string, unknown>;
    const value = row['writable_schema'] ?? Object.values(row)[0];
    return value === 1 || value === true || value === '1';
  } catch {
    return false;
  }
}

function allowSchemaWrites(db: Db): () => void {
  const fn = (db as unknown as { unsafeMode?: (on: boolean) => unknown }).unsafeMode;
  if (typeof fn !== 'function') return () => {};
  try {
    fn.call(db, true);
  } catch {
    return () => {};
  }
  return () => {
    try {
      fn.call(db, false);
    } catch {
      /* the connection is closing, or never had it; either way nothing to undo */
    }
  };
}

/**
 * vec0's own storage for one virtual table: `_chunks`, `_info`, `_rowids` and
 * `_vector_chunks00` today, and whatever a later version added.
 *
 * Matched by prefix rather than by a list of suffixes so that a database
 * written by a `sqlite-vec` this code has never seen still gets cleaned up
 * rather than leaving orphan tables behind. Every underscore in the name is
 * escaped, so `vec\_exchanges\_%` cannot reach `vec_blob_exchanges`, and
 * `type = 'table'` keeps it away from the `vec_exchanges_insert` trigger the
 * portable store is about to create under a matching name.
 */
function shadowTables(db: Db, table: VecTable): string[] {
  const like = `${table.replace(/_/g, '\\_')}\\_%`;
  try {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`)
        .all(like) as { name: string }[]
    ).map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Stop claiming to have vectors that were just thrown away.
 *
 * `exchanges.embedding_version` is the stamp *everything* reads —
 * `vectorCounts`, `doctor`'s row, the pending queue and the background pass all
 * ask it rather than the store — so leaving it set after a detach would report
 * a full index with an empty one underneath, and no pass would ever refill it.
 * Clearing it is what makes the next `index` rebuild them, locally and for
 * free, from text potsherd already holds.
 *
 * `vec_cards` has no such column: a card's vector is written by `potsherd card`
 * beside the card itself. It is not re-derived here, and it is not lost money —
 * the card's text, model, cost and mirror are all still in `cards` — but until
 * that session is carded again `find` scores it on `cards_fts` alone.
 */
function forgetStrandedStamps(db: Db, stranded: readonly VecTable[]): void {
  const clear = (table: string) => {
    try {
      db.exec(`UPDATE ${table} SET embedding_version = NULL WHERE embedding_version IS NOT NULL;`);
    } catch {
      /* the column arrives with migration 7; an index older than that has none */
    }
  };
  if (stranded.includes('vec_exchanges')) clear('exchanges');
  if (stranded.includes('vec_ghost_prompts')) clear('ghost_prompts');
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

export { fitNote, stoppedLine, vectorNote, vectorReport, warmingHead, warmingLine };
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
