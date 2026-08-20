import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbPath, potsherdDir } from './paths.js';

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
  up: string;
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
      db.exec(m.up);
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

export function schemaVersion(db: Db): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    return row?.v ?? 0;
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
