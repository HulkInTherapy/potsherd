import { createRequire } from 'node:module';
import process from 'node:process';
import type { Db } from './db.js';

/**
 * `sqlite-vec`, loaded lazily and never fatally.
 *
 * `03 §3` puts `vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding
 * FLOAT[384])` in the schema, and vec0 is a loadable **native** extension:
 * a platform-specific `.dylib`/`.so`/`.dll` shipped by an optional npm
 * dependency. Native extensions fail for reasons that have nothing to do with
 * the user — an unsupported platform, a stripped `node_modules`, a sqlite build
 * with `enable_load_extension` off, a hardened-runtime signature check.
 *
 * None of those may ever stop someone indexing their own transcripts. So the
 * contract here is: **fail soft, and say so.** If the extension does not load,
 * migration 4 declines (it is not recorded, so it is retried the next time the
 * database is opened, e.g. after the user installs the package), `index` runs
 * exactly as `--no-embed` would and produces no vectors, `find` falls back to
 * fts5 alone, and `doctor` prints the reason in one line.
 *
 * Nothing here throws. {@link vecStatus} answers with a reason instead.
 */

export interface VecStatus {
  available: boolean;
  /** `vec_version()`, e.g. `v0.1.9`. Present only when available. */
  version?: string;
  /** Absolute path of the loadable extension, when one was found. */
  path?: string;
  /** One line, for `doctor`, when it is not available. */
  reason?: string;
}

const require_ = createRequire(import.meta.url);

/** Per-connection: an extension is loaded into a connection, not a process. */
const loaded = new WeakMap<Db, VecStatus>();

/** The path of the loadable extension, or why there isn't one. */
function locate(): { path: string } | { reason: string } {
  // An escape hatch for a machine where the extension loads but misbehaves,
  // and the one honest way to test the fail-soft path.
  const off = process.env['POTSHERD_NO_VEC'];
  if (off && off !== '0' && off !== '') {
    return { reason: 'disabled by POTSHERD_NO_VEC' };
  }
  try {
    const mod = require_('sqlite-vec') as { getLoadablePath(): string };
    return { path: mod.getLoadablePath() };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (/Cannot find module/.test(message)) {
      return { reason: 'sqlite-vec is not installed — install it for vector search' };
    }
    return { reason: firstLine(message) };
  }
}

/**
 * Load vec0 into this connection. Idempotent, cached, and total: a failure is
 * a {@link VecStatus} with a reason, never an exception.
 */
export function loadVec(db: Db): VecStatus {
  const cached = loaded.get(db);
  if (cached) return cached;

  const found = locate();
  if ('reason' in found) {
    const status: VecStatus = { available: false, reason: found.reason };
    loaded.set(db, status);
    return status;
  }

  let status: VecStatus;
  try {
    db.loadExtension(found.path);
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string } | undefined;
    status = { available: true, path: found.path, ...(row?.v ? { version: row.v } : {}) };
  } catch (err) {
    status = {
      available: false,
      path: found.path,
      reason: firstLine((err as Error)?.message ?? String(err)),
    };
  }
  loaded.set(db, status);
  return status;
}

/** Status without forcing a load attempt if one already happened. */
export function vecStatus(db: Db): VecStatus {
  return loaded.get(db) ?? loadVec(db);
}

export function vecAvailable(db: Db): boolean {
  return vecStatus(db).available;
}

/**
 * Migration 4's body. Creates the two vec0 tables from `03 §3` and returns
 * false — "not applied, ask me again next time" — when the extension is not
 * there. `vec_cards` is created alongside `vec_exchanges` because both need
 * this same extension load; phase 3 fills it.
 */
export function createVecTables(db: Db): boolean {
  if (!loadVec(db).available) return false;
  try {
    db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
  id TEXT PRIMARY KEY, embedding FLOAT[384]
);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_cards USING vec0(
  session_id TEXT PRIMARY KEY, embedding FLOAT[384]
);
`);
    return true;
  } catch {
    // A partially-loaded extension, or a sqlite without virtual-table support.
    // Same answer as a missing one: no vectors, no crash.
    return false;
  }
}

/** True when the vec tables exist in this database, extension or not. */
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

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}
