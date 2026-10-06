import fs from 'node:fs';
import { dbPath, potsherdDir } from './paths.js';
import { count } from './db.js';
import { openAuditSqliteSnapshot } from './audit-sqlite.js';

export const ARCHIVE_UNAVAILABLE_WARNING = 'archive snapshot unavailable; local retention counts remain available';

/**
 * A read-only peek at what potsherd has already rescued.
 *
 * `audit` uses this so its closing lines can tell the truth on a machine that
 * has already run `rescue` — a card that still says "run potsherd rescue" after
 * you have run it is the kind of output that fails the screenshot test.
 *
 * It opens nothing that does not already exist, and opens it read-only, so
 * `audit` keeps its promise of writing nothing anywhere.
 */
export interface ArchiveState {
  dbPath: string;
  ghosts: number;
  ghostPrompts: number;
  archivedFiles: number;
  archivedBytes: number;
  rescues: number;
  lastRescueAt: string | null;
}

export function readArchiveState(root = potsherdDir()): ArchiveState | null {
  const file = dbPath(root);
  if (!fs.existsSync(file)) return null;
  let snapshot: ReturnType<typeof openAuditSqliteSnapshot>;
  try {
    snapshot = openAuditSqliteSnapshot(file);
  } catch {
    // A database from a newer potsherd, or a half-written one. Not worth
    // failing an otherwise read-only command over.
    return null;
  }
  const db=snapshot.db;
  try {
    const last = db
      .prepare('SELECT ran_at, bytes FROM rescue_log ORDER BY id DESC LIMIT 1')
      .get() as { ran_at: string; bytes: number } | undefined;
    const bytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM archive_files').get() as { n: number };
    const state = {
      dbPath: file,
      ghosts: count(db, 'ghosts'),
      ghostPrompts: count(db, 'ghost_prompts'),
      archivedFiles: count(db, 'archive_files'),
      archivedBytes: bytes.n,
      rescues: count(db, 'rescue_log'),
      lastRescueAt: last?.ran_at ?? null,
    };
    snapshot.assertCurrent();
    return state;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
