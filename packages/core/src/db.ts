import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbPath, potsherdDir } from './paths.js';
import { createVecTables } from './vec.js';

/**
 * One SQLite file, `~/.potsherd/potsherd.db`, WAL mode.
 *
 * The schema is the one in plans/03-ARCHITECTURE.md section 3, created in full
 * from the first release even though phase 0 only writes `ghosts`,
 * `ghost_prompts` and `rescue_log`. Creating it whole now means later phases
 * add rows, not migrations, to tables that were always meant to exist.
 *
 * Migrations are additive and versioned: each entry in MIGRATIONS runs once and
 * is recorded in `schema_migrations`. Never edit a shipped migration; append.
 */

export interface OpenOptions {
  /** Overrides ~/.potsherd (POTSHERD_DIR also works). */
  root?: string;
  file?: string;
  readonly?: boolean;
}

export type Db = Database.Database;

interface Migration {
  version: number;
  name: string;
  /** Plain SQL. Exactly one of `up` / `run` is set. */
  up?: string;
  /**
   * A migration that may legitimately decline. It returns false when the thing
   * it needs is not on this machine; the version is then **not** recorded, so
   * the next `open()` tries again. Only migration 4 (the `sqlite-vec` loadable
   * extension) uses this — see `vec.ts` for why a native extension may never be
   * allowed to fail an index run.
   */
  run?: (db: Db) => boolean;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'sessions-exchanges-ghosts-cards',
    up: `
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  harness           TEXT NOT NULL,
  source_path       TEXT,
  project           TEXT,
  project_slug      TEXT,
  started_at        TEXT,
  ended_at          TEXT,
  title             TEXT,
  git_branch        TEXT,
  entrypoint        TEXT,
  model             TEXT,
  is_sidechain      INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  agent_name        TEXT,
  user_prompts      INTEGER NOT NULL DEFAULT 0,
  assistant_turns   INTEGER NOT NULL DEFAULT 0,
  tool_calls        INTEGER NOT NULL DEFAULT 0,
  bytes             INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'live',
  archived_path     TEXT,
  indexed_at        TEXT,
  source_mtime      INTEGER,
  source_offset     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_project    ON sessions(project);
CREATE INDEX IF NOT EXISTS sessions_harness    ON sessions(harness);
CREATE INDEX IF NOT EXISTS sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS sessions_status     ON sessions(status);
CREATE INDEX IF NOT EXISTS sessions_parent     ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS exchanges (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  ts                TEXT,
  user_text         TEXT NOT NULL DEFAULT '',
  assistant_text    TEXT NOT NULL DEFAULT '',
  files_touched     TEXT NOT NULL DEFAULT '[]',
  is_sidechain      INTEGER NOT NULL DEFAULT 0,
  parent_uuid       TEXT,
  redacted          INTEGER NOT NULL DEFAULT 0,
  embedding_version INTEGER
);
CREATE INDEX IF NOT EXISTS exchanges_session ON exchanges(session_id, seq);
CREATE INDEX IF NOT EXISTS exchanges_ts      ON exchanges(ts);

CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  name        TEXT,
  input       TEXT,
  result      TEXT,
  is_error    INTEGER NOT NULL DEFAULT 0,
  ts          TEXT
);
CREATE INDEX IF NOT EXISTS tool_calls_exchange ON tool_calls(exchange_id);
CREATE INDEX IF NOT EXISTS tool_calls_name     ON tool_calls(name);

CREATE TABLE IF NOT EXISTS ghosts (
  session_id    TEXT PRIMARY KEY,
  harness       TEXT NOT NULL DEFAULT 'claude',
  project       TEXT,
  first_ts      TEXT,
  last_ts       TEXT,
  prompt_count  INTEGER NOT NULL DEFAULT 0,
  first_prompt  TEXT,
  title         TEXT,
  message_count INTEGER,
  git_branch    TEXT,
  source        TEXT NOT NULL DEFAULT 'history'
);
CREATE INDEX IF NOT EXISTS ghosts_project ON ghosts(project);
CREATE INDEX IF NOT EXISTS ghosts_last_ts ON ghosts(last_ts);

CREATE TABLE IF NOT EXISTS ghost_prompts (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ghosts(session_id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL DEFAULT 0,
  ts         TEXT,
  text       TEXT NOT NULL DEFAULT '',
  redacted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ghost_prompts_session ON ghost_prompts(session_id, seq);

CREATE TABLE IF NOT EXISTS cards (
  session_id   TEXT PRIMARY KEY,
  title        TEXT,
  summary      TEXT,
  topics       TEXT NOT NULL DEFAULT '[]',
  decisions    TEXT NOT NULL DEFAULT '[]',
  files        TEXT NOT NULL DEFAULT '[]',
  outcome      TEXT,
  open_threads TEXT NOT NULL DEFAULT '[]',
  suggested_tags TEXT NOT NULL DEFAULT '[]',
  model        TEXT,
  verified     TEXT,
  cost_usd     REAL NOT NULL DEFAULT 0,
  created_at   TEXT,
  card_md      TEXT,
  source       TEXT NOT NULL DEFAULT 'transcript'
);

CREATE TABLE IF NOT EXISTS tags (
  session_id TEXT NOT NULL,
  tag        TEXT NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS pins (
  session_id TEXT PRIMARY KEY,
  pinned_at  TEXT
);

CREATE TABLE IF NOT EXISTS links (
  a_session_id TEXT NOT NULL,
  b_session_id TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT,
  PRIMARY KEY (a_session_id, b_session_id)
);

CREATE TABLE IF NOT EXISTS rescue_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at           TEXT NOT NULL,
  harness          TEXT NOT NULL DEFAULT 'claude',
  sessions_copied  INTEGER NOT NULL DEFAULT 0,
  files_copied     INTEGER NOT NULL DEFAULT 0,
  files_skipped    INTEGER NOT NULL DEFAULT 0,
  ghosts_built     INTEGER NOT NULL DEFAULT 0,
  prompts_recovered INTEGER NOT NULL DEFAULT 0,
  bytes            INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  settings_changed TEXT
);

CREATE TABLE IF NOT EXISTS archive_files (
  source_path  TEXT PRIMARY KEY,
  archive_path TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  source_mtime INTEGER NOT NULL,
  copied_at    TEXT NOT NULL,
  harness      TEXT NOT NULL DEFAULT 'claude'
);
`,
  },
  {
    version: 2,
    name: 'fts',
    up: `
CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
  user_text, assistant_text, content='exchanges', content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  title, summary, topics, decisions, open_threads, content='cards'
);
CREATE VIRTUAL TABLE IF NOT EXISTS ghosts_fts USING fts5(
  first_prompt, title, content='ghosts'
);
CREATE VIRTUAL TABLE IF NOT EXISTS ghost_prompts_fts USING fts5(
  text, content='ghost_prompts'
);
`,
  },
  {
    version: 3,
    name: 'sync-state',
    up: `
-- A tiny key/value note of what the last pass over a source looked like, so a
-- pass that provably cannot have changed anything can be skipped. Today it
-- holds one row: the fingerprint of the inputs the ghost rebuild reads
-- (history.jsonl's size and mtime, the session ids on disk, and the
-- sessions-index files). Anything that could change a ghost changes the
-- fingerprint, so a stale value can only ever cost work, never correctness.
CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 4,
    name: 'vec',
    // The last two tables of `03 §3`:
    //   vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])
    //   vec_cards     USING vec0(session_id TEXT PRIMARY KEY, embedding FLOAT[384])
    // vec0 comes from `sqlite-vec`, a loadable native extension and an
    // *optional* dependency. When it is not there this migration declines
    // rather than throwing: `index` still runs and simply writes no vectors
    // (exactly what `--no-embed` means), `find` uses fts5 alone, and `doctor`
    // says which of the two you are getting. Never crash someone's index
    // because a native extension did not load.
    run: createVecTables,
  },
  {
    version: 5,
    name: 'session-record-types',
    // `doctor` promises that every record type a parser did not consume is
    // listed with a count (plans/06). Until now those counts lived in one
    // `sync_state` blob that each `index` run overwrote with whatever *that
    // run* had re-read, so one incremental pass could take a type that exists
    // in three hundred transcripts down to one — or make it vanish. Counts
    // belong to the sessions they were counted in, so they live here, one row
    // per (session, version, type), and `ON DELETE CASCADE` retires them with
    // the session. `doctor` sums; nothing overwrites.
    //
    // The last two statements throw the old, per-run numbers away and clear
    // the incremental fingerprints, so the next `index` re-reads every
    // transcript once and refills the table honestly. A migration that left
    // the stale blob in place would keep reporting the wrong numbers, and a
    // wrong number that looks precise is worse than no number.
    up: `
CREATE TABLE IF NOT EXISTS session_record_types (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  harness    TEXT NOT NULL,
  version    TEXT NOT NULL DEFAULT 'unknown',
  type       TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  novel      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, version, type)
);
CREATE INDEX IF NOT EXISTS session_record_types_type
  ON session_record_types(harness, version, type);

DELETE FROM sync_state WHERE key = 'index:recordTypes';
DELETE FROM sync_state WHERE key LIKE 'index:%' AND key <> 'index:ghosts';
UPDATE sessions SET source_mtime = NULL;
`,
  },
];

export function open(opts: OpenOptions = {}): Db {
  const root = opts.root ?? potsherdDir();
  const file = opts.file ?? dbPath(root);
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new Database(file, { readonly: opts.readonly ?? false });
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // The database holds prompt text, so it is owner-only like the archive.
    // WAL creates two sidecar files; all three get the same treatment.
    if (file !== ':memory:') {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        try { fs.chmodSync(f, 0o600); } catch { /* not created yet */ }
      }
    }
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!opts.readonly) migrate(db);
  return db;
}

export function migrate(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  let ran = 0;
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      const done = m.up !== undefined ? (db.exec(m.up), true) : m.run!(db);
      if (!done) {
        // Declined, not failed. Nothing is recorded, so the next open retries.
        db.exec('ROLLBACK');
        continue;
      }
      record.run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
      ran++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`);
    }
  }
  return ran;
}

/**
 * The highest version every migration up to which has been applied.
 *
 * Not `MAX(version)`: migration 4 may legitimately decline on a machine with no
 * `sqlite-vec`, and later migrations still run. `MAX` would then report the
 * schema as complete while the vector tables were absent, which is the kind of
 * quietly-wrong number this codebase exists to avoid. Counting contiguously
 * makes `doctor`'s `schema v3 of v5` say exactly what is true.
 */
export function schemaVersion(db: Db): number {
  try {
    const applied = new Set<number>(
      (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );
    let v = 0;
    for (const m of MIGRATIONS) {
      if (!applied.has(m.version)) break;
      v = m.version;
    }
    return v;
  } catch {
    return 0;
  }
}

export function latestSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]!.version;
}

export function count(db: Db, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}
