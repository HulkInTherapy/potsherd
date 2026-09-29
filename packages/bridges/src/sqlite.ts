/**
 * The smallest possible read-only sqlite surface, loaded dynamically.
 *
 * ## why dynamic, and why no dependency
 *
 * `packages/bridges/package.json` declares **no runtime dependency at all**.
 * That is deliberate on three counts:
 *
 *   1. The root `package.json` is not ours to touch, and a bridge that made
 *      `potsherd` heavier to install would be paying for a feature almost
 *      nobody has the other tool for. On this machine neither claude-mem nor
 *      agentmemory is installed; that is the common case, and the common case
 *      should cost nothing.
 *   2. `better-sqlite3` is already a real dependency of `@potsherd/core` and
 *      of the CLI, and it is a native module. Declaring it twice risks two
 *      copies with different ABIs in one process — the classic way a native
 *      addon starts throwing `NODE_MODULE_VERSION` at a user who did nothing
 *      wrong. Resolving it from the host that already loaded it cannot.
 *   3. A missing driver is then just one more `presence: 'absent'` answer, on
 *      the same degradation path as a missing store, rather than a crash at
 *      import time in a package the user never asked to use.
 *
 * ## read-only is enforced here, once
 *
 * {@link openReadOnly} is the only way this package opens another tool's
 * database, and it passes `readonly: true` every time. `03` §11 and the
 * governing rule for this task both say potsherd reads other tools' stores
 * read-only; making that a property of the single opener rather than of each
 * call site is what stops the fourth bridge from forgetting.
 */

import { firstLine } from './types.js';

/**
 * The slice of `better-sqlite3` this package uses.
 *
 * Written out rather than imported from `@types/better-sqlite3` so that the
 * package needs no dependency, dev or otherwise, to typecheck.
 */
export interface ReadOnlyStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface ReadOnlyDb {
  prepare(sql: string): ReadOnlyStatement;
  close(): void;
}

interface DatabaseCtor {
  new (path: string, options: { readonly: boolean; fileMustExist: boolean }): ReadOnlyDb;
}

/** Resolved once per process; a native module should be loaded once. */
let cached: DatabaseCtor | null | undefined;

/**
 * Held in a variable rather than written inline, and that is load-bearing
 * twice over. TypeScript cannot resolve types for a module this package does
 * not depend on, so a literal specifier fails `tsc` — and esbuild, which
 * bundles the CLI, cannot statically follow a computed specifier either, so
 * the import survives bundling as a real runtime `import()` resolved from
 * whatever host loaded us. Both are the behaviour we want: no dependency, no
 * second copy of a native addon, and a `catch` instead of a crash.
 */
const DRIVER = 'better-sqlite3';

async function driver(): Promise<DatabaseCtor | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import(DRIVER)) as { default?: DatabaseCtor };
    cached = mod.default ?? (mod as unknown as DatabaseCtor);
  } catch {
    cached = null;
  }
  return cached;
}

export interface OpenResult {
  db: ReadOnlyDb | null;
  /** One line. Empty when `db` is non-null. */
  error: string;
}

/**
 * Open another tool's sqlite file read-only, or explain why not.
 *
 * Never throws. A bridge's whole contract is that the other tool being
 * missing, corrupt, locked, or newer than us produces a sentence rather than
 * a stack trace, and an opener that can throw makes that contract impossible
 * to keep at every call site at once.
 */
export async function openReadOnly(file: string): Promise<OpenResult> {
  const Database = await driver();
  if (!Database) {
    return { db: null, error: 'sqlite driver unavailable (better-sqlite3 did not load)' };
  }
  try {
    return { db: new Database(file, { readonly: true, fileMustExist: true }), error: '' };
  } catch (err) {
    return { db: null, error: firstLine(err) };
  }
}

/** Every table and view in an open database, with the SQL that declared it. */
export interface TableInfo {
  name: string;
  type: string;
  sql: string;
}

/** Never throws; an unreadable `sqlite_master` yields an empty list. */
export function tables(db: ReadOnlyDb): TableInfo[] {
  try {
    const rows = db
      .prepare("select name, type, coalesce(sql, '') as sql from sqlite_master where type in ('table', 'view')")
      .all() as { name?: unknown; type?: unknown; sql?: unknown }[];
    return rows.map((r) => ({
      name: String(r.name ?? ''),
      type: String(r.type ?? ''),
      sql: String(r.sql ?? ''),
    }));
  } catch {
    return [];
  }
}

/**
 * `pragma table_info(<name>)` — the schema discovery the phase file mandates.
 *
 * The column names come back from the database itself and are never assumed.
 * Phase 5 assumed four flags into existence that did not exist; this is the
 * cheap way not to do that again to somebody else's schema, which we do not
 * control and which will change without telling us.
 */
export function columnsOf(db: ReadOnlyDb, table: string): string[] {
  try {
    // `pragma table_info` takes an identifier, not a bindable parameter, so the
    // name is interpolated — and can only ever be a name this function was
    // handed by `sqlite_master` on the same connection. It is quoted anyway,
    // with embedded quotes doubled, so that a table named by someone else can
    // never end a string literal early.
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const rows = db.prepare(`pragma table_info(${quoted})`).all() as { name?: unknown }[];
    return rows.map((r) => String(r.name ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/** Row count, or null when the table cannot be counted. */
export function countRows(db: ReadOnlyDb, table: string): number | null {
  try {
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const row = db.prepare(`select count(*) as n from ${quoted}`).get() as { n?: unknown };
    const n = Number(row?.n ?? NaN);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Pick the column that plays a role, from names the database actually has.
 *
 * Candidates are tried in order and matched case-insensitively, first exactly
 * and then as a substring — `content` before `content_hash`, but `body_text`
 * still found by `text`. Returns null rather than guessing when nothing fits,
 * because a bridge with no text column is not a bridge with a bad text column;
 * it is a schema we do not recognise, and it must say so.
 */
export function pickColumn(columns: readonly string[], candidates: readonly string[]): string | null {
  const lower = columns.map((c) => c.toLowerCase());
  for (const want of candidates) {
    const exact = lower.indexOf(want);
    if (exact >= 0) return columns[exact] ?? null;
  }
  for (const want of candidates) {
    const partial = lower.findIndex((c) => c.includes(want));
    if (partial >= 0) return columns[partial] ?? null;
  }
  return null;
}

/** True when this table's declaration is an fts5 virtual table. */
export function isFts5(info: TableInfo): boolean {
  return /\busing\s+fts5\b/i.test(info.sql);
}
