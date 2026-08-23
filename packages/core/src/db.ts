import fs from 'node:fs';
import path from 'node:path';
import { dbPath, potsherdDir } from './paths.js';
import { openDatabase, type Db } from './sqlite-driver.js';
import { createGhostVecTable, createVecTables, migrateToPortableVectors } from './vec.js';

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

export type { Db } from './sqlite-driver.js';
export {
  NoSqliteError,
  sqliteAvailable,
  sqliteDriverName,
  resetDriverCache,
  type DriverKind,
} from './sqlite-driver.js';

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
  {
    version: 6,
    name: 'card-runs',
    // What a card run was quoted at, and what it actually cost.
    //
    // `card --dry-run --all` once said "7m 26s, $2.66" before a run that took
    // 55m 25s and reported $12.93. The constants behind that quote have been
    // re-fitted (`llm.ts`), but a constant fitted on one machine is still a
    // guess about every other one: the number that matters is what *this*
    // machine did. So every finished run writes one row here, and the next
    // estimate multiplies itself by the ratio it finds (`calibration.ts`).
    //
    // `complete` is 0 for a run a ceiling stopped or that lost targets to
    // errors. Those rows are kept — they are the record of what happened —
    // and excluded from the correction, because a run that stopped early is
    // not evidence about how long a whole one takes.
    up: `
CREATE TABLE IF NOT EXISTS card_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at            TEXT    NOT NULL,
  backend           TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  concurrency       INTEGER NOT NULL DEFAULT 1,
  targets           INTEGER NOT NULL DEFAULT 0,
  predicted_calls   INTEGER NOT NULL DEFAULT 0,
  predicted_seconds REAL    NOT NULL DEFAULT 0,
  predicted_usd     REAL    NOT NULL DEFAULT 0,
  actual_calls      INTEGER NOT NULL DEFAULT 0,
  actual_seconds    REAL    NOT NULL DEFAULT 0,
  actual_usd        REAL    NOT NULL DEFAULT 0,
  time_ratio        REAL    NOT NULL DEFAULT 1,
  usd_ratio         REAL    NOT NULL DEFAULT 1,
  complete          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS card_runs_backend ON card_runs(backend, ran_at);
`,
  },
  {
    version: 7,
    name: 'ghost-vectors',
    // Ghosts join the semantic half of the hybrid.
    //
    // `03 §7` fuses five lists and a ghost could only ever appear in two of
    // them, because nothing had ever embedded a recovered prompt. RRF has no
    // opinion about a list you are missing from — it simply adds nothing — so
    // a session that can appear in five lists collects five contributions and
    // a ghost collects two, and on phase 3's eval set every ghost-only query
    // fell out of the top five the moment the vector lists were switched on.
    //
    // The column is stamped exactly like `exchanges.embedding_version`, so
    // `index --embed` re-embeds a prompt whose model changed and skips one
    // whose did not. `vec_ghost_prompts` needs `sqlite-vec`, so this migration
    // is its own migration (8) that may decline, like migration 4 — the column
    // is unconditional so that every code path can read it whether or not the
    // extension ever loads.
    up: `ALTER TABLE ghost_prompts ADD COLUMN embedding_version INTEGER;`,
  },
  {
    version: 8,
    name: 'ghost-vectors-table',
    // See migration 7. Split off because `sqlite-vec` may not be installed and
    // a declining migration rolls its whole transaction back, which would take
    // the column with it.
    run: createGhostVecTable,
  },
  {
    version: 9,
    name: 'session-title-source',
    // Who named this session.
    //
    // NULL is the whole history of the column: the harness wrote the title, or
    // there is no title at all. `'prompt'` means potsherd derived one from the
    // session's first substantive prompt (`ingest.ts`, `rescue.ts`'s rule), and
    // it exists so that `--untitled` can keep meaning what it has always meant.
    //
    // Without it, deriving a title empties `ls --untitled`: its SQL is "no card
    // title and no `s.title`", so the moment potsherd writes a title of its own
    // the flag stops finding the sessions it exists to find. A flag that
    // silently stops meaning anything is worse than one that was never added,
    // so the derivation and this column land together and `--untitled` reads
    // "nothing a card would not improve" instead.
    up: `ALTER TABLE sessions ADD COLUMN title_source TEXT;`,
  },
  {
    version: 10,
    name: 'portable-vectors',
    // Vectors stop needing a native extension.
    //
    // Migrations 4 and 8 created `vec_exchanges`, `vec_cards` and
    // `vec_ghost_prompts` as vec0 virtual tables, which meant they declined
    // entirely on a machine without `sqlite-vec` — an optional dependency that
    // a clean `npm i -g potsherd` does not install. On those machines the
    // schema stopped at version 3 and semantic search was structurally
    // impossible, which is the second half of the agent audit's F2.
    //
    // The vectors now live in ordinary tables and those three names are views
    // over them with `INSTEAD OF` triggers, so every statement already written
    // against vec0 works verbatim and nothing outside `vec.ts` changed. A
    // brute-force scan answers the KNN query in 4.7 ms at the reference
    // archive's 1,678 exchanges, against sqlite-vec's 0.9 ms — 3.8 ms, for an
    // entire class of install failure.
    //
    // Where an index already exists this copies every vector across before it
    // drops the virtual tables, so nobody loses embeddings they have already
    // paid for. It declines — rather than throwing — on the one case it cannot
    // handle: vec0 tables on a machine that has since lost the extension, where
    // sqlite can neither read nor drop them. `doctor` says so, and the next
    // open retries.
    run: migrateToPortableVectors,
  },
];

export function open(opts: OpenOptions = {}): Db {
  const root = opts.root ?? potsherdDir();
  const file = opts.file ?? dbPath(root);
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = openDatabase(file, { readonly: opts.readonly ?? false });
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

/**
 * Another tool's sqlite file, read-only — the opencode adapter's opener.
 *
 * Here rather than in the adapter so that `better-sqlite3` is reached through
 * one lazy loader in the whole of core, and a machine without the addon gets
 * the same sentence from every direction.
 */
export function openSqliteReadOnly(file: string): Db {
  return openDatabase(file, { readonly: true, fileMustExist: true });
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
