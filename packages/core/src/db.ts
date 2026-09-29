import fs from 'node:fs';
import path from 'node:path';
import { dbPath, potsherdDir } from './paths.js';
import { openDatabase, type Db } from './sqlite-driver.js';
import {
  createGhostVecTable,
  createVecTables,
  loadVec,
  migrateToPortableVectors,
  reconcileVectorStamps,
} from './vec.js';

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
    // paid for.
    //
    // It used to decline — rather than throw — on the one case it could not
    // handle: vec0 tables on a machine that has since lost the extension, where
    // sqlite can neither read nor drop them. That limitation was written down
    // here as a limitation, and by `plans/09 §13.9` a guard's stated limitation
    // is an open item. It was: **every database written by 1.1.0 is that case**,
    // because 1.1.0 only built vec0 tables on a machine that had `sqlite-vec`,
    // and 1.2.0 no longer installs it. The migration declined politely, migration
    // 11 below cleared the incremental fingerprints so the next `index` re-read
    // every transcript, and `clearExchanges` prepared `DELETE FROM vec_exchanges`
    // for the first of them: `potsherd index` → `no such module: vec0`, with
    // every fix in the release gated behind it (audit §N1, FIX-H).
    //
    // It no longer declines on that case. `DROP TABLE` on a moduleless virtual
    // table calls the module's own destructor and cannot work — but the schema
    // is data, so the row is deleted from `sqlite_master` under
    // `PRAGMA writable_schema` and vec0's four storage tables, which are
    // ordinary tables, drop normally. `vec.ts` owns that and documents the
    // driver difference it probes for first. Declining is now reserved for a
    // driver that refuses the rewrite, it changes nothing when it happens, and
    // the reason it records names a driver that is measured to succeed.
    run: migrateToPortableVectors,
  },
  {
    version: 11,
    name: 'threads',
    // The fork/resume chain, and the evidence it is derived from.
    //
    // `claude --resume <id>` writes a **new** transcript whose head is a copy
    // of the old one. potsherd stored each file as an independent session with
    // no pointer to the other, and the agent audit (F4) measured what that
    // costs: a session with 123 exchanges of work grafts as 4, and `show`
    // dates it eight days before the first exchange it prints on the same
    // screen.
    //
    // Three tables, because the derivation has to survive an incremental run
    // that opens one transcript out of 328:
    //
    //   `session_record_ids`       the harness's own record ids, per session.
    //                              The evidence. Written by `ingest.ts` when a
    //                              transcript is parsed, so a run that skips a
    //                              file still has that file's ids to compare.
    //   `session_declared_parents` the parent the records themselves name
    //                              (claude's `session_id`, which survives the
    //                              rewrite of `sessionId`). Kept whether or
    //                              not it is corroborated, so `threads.ts` can
    //                              report the ones it refused rather than
    //                              silently dropping them.
    //   `session_threads`          the derived chain. Rebuilt whole on every
    //                              `index`; never hand-edited.
    //
    // `ON DELETE CASCADE` retires all three with their session, exactly like
    // `session_record_types` (migration 5).
    //
    // The last two statements are migration 5's trick and are here for its
    // reason: every session indexed before this migration has no record ids
    // stored, so the incremental test would skip all of them for ever and the
    // first chain would be derived from an empty table. Clearing the
    // fingerprints makes the next `index` re-read each transcript once and
    // fill the evidence in honestly. `index:ghosts` is left alone — ghosts
    // have no transcript and nothing here concerns them.
    up: `
CREATE TABLE IF NOT EXISTS session_record_ids (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  record_id  TEXT NOT NULL,
  PRIMARY KEY (session_id, record_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_record_ids_record ON session_record_ids(record_id);

CREATE TABLE IF NOT EXISTS session_declared_parents (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id  TEXT NOT NULL,
  records    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, parent_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_threads (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  thread_id  TEXT NOT NULL,
  parent_id  TEXT,
  head       INTEGER NOT NULL DEFAULT 0,
  depth      INTEGER NOT NULL DEFAULT 0,
  via        TEXT,
  shared     INTEGER NOT NULL DEFAULT 0,
  overlap    REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS session_threads_thread ON session_threads(thread_id);
CREATE INDEX IF NOT EXISTS session_threads_head   ON session_threads(head);

DELETE FROM sync_state WHERE key LIKE 'index:%' AND key <> 'index:ghosts';
UPDATE sessions SET source_mtime = NULL;
`,
  },
  {
    version: 12,
    name: 'notes',
    // The notes lane — the first table potsherd writes on a user's say-so
    // rather than on what it read (`docs/AGENT-AUDIT-2026-08-23.md` §4.7,
    // phase-10 §B9). Every other verb is read-only; this is the one that
    // makes the archive learn.
    //
    // Four properties are load-bearing, and each one is a column decision:
    //
    // **Append-only.** `id` is an autoincrement rowid and nothing in
    // `notes.ts` issues an `UPDATE` or a `DELETE` against this table — a
    // second note on the same thread is a second row, and the older verdict
    // is still there afterwards. There is deliberately no `superseded_by`
    // column, because maintaining one would mean writing to a row that had
    // already been written, which is the property this table exists to not
    // have. "Which note is current" is derived at read time (`MAX(id)`) and
    // therefore cannot go stale or be corrupted by a half-finished write.
    //
    // **No foreign key.** Exactly the reasoning `tags`, `pins` and `links`
    // carry (migration 1): a ghost has no row in `sessions`, and a note about
    // a session the sweep later deletes is the note most worth keeping. An
    // `ON DELETE CASCADE` here would also hand any future re-index the power
    // to destroy user-written text, which no read path should ever have.
    //
    // **`thread_id` and `session_id` both.** The thread is the unit a note
    // attaches to (migration 11), but threads are *derived* and are rebuilt
    // whole on every `index`. Storing only the derived id would mean a
    // re-derivation could orphan a note. Storing only the session id would
    // lose the thing the caller actually meant. So both are recorded: what it
    // was told (`session_id`, the ref the caller named, resolved) and what
    // that meant at the time (`thread_id`).
    //
    // **`author` and `via` are recorded, never inferred.** `via` is known for
    // certain — the code path that wrote the row. `author` is not: from a
    // terminal potsherd cannot tell an agent typing a command from a human
    // typing the same command, so it defaults to `'unknown'` and is only ever
    // whatever the caller stated with `--by`. A guessed author on an
    // assertion table would be a fabricated provenance, which is worse than
    // no provenance.
    //
    // `notes_fts` is `content='notes'` exactly like `cards_fts`: sqlite keeps
    // no second copy of the text. It is safe as external content precisely
    // because rows are never deleted or updated, so the 'delete' command form
    // that `cards/write.ts` needs has no counterpart here.
    up: `
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  decided    TEXT NOT NULL DEFAULT '',
  open       TEXT NOT NULL DEFAULT '',
  next_step  TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT 'unknown',
  via        TEXT NOT NULL DEFAULT 'cli',
  written_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_thread  ON notes(thread_id, id);
CREATE INDEX IF NOT EXISTS notes_session ON notes(session_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  decided, open, next_step, content='notes'
);
`,
  },
];

// Cover the stamp reconciliation queries without reading large transcript bodies.
MIGRATIONS.push({
  version: 13,
  name: 'cover-vector-stamps',
  up: `
CREATE INDEX IF NOT EXISTS exchanges_embedding_stamp ON exchanges(embedding_version, id);
CREATE INDEX IF NOT EXISTS ghost_prompts_embedding_stamp ON ghost_prompts(embedding_version, id);
DELETE FROM sync_state WHERE key = 'index:codex';
UPDATE sessions SET source_mtime = NULL WHERE harness = 'codex';
`,
});


// Phase 12 authoritative evidence is independent of legacy compatibility rows.
MIGRATIONS.push({ version: 14, name: 'immutable-evidence-ledger', up: `
CREATE TABLE memory_epochs (singleton INTEGER PRIMARY KEY CHECK(singleton=1), evidence_epoch INTEGER NOT NULL DEFAULT 0 CHECK(evidence_epoch>=0), notes_epoch INTEGER NOT NULL DEFAULT 0 CHECK(notes_epoch>=0), lineage_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lineage_epoch>=0), deletion_epoch INTEGER NOT NULL DEFAULT 0 CHECK(deletion_epoch>=0), vector_epoch INTEGER NOT NULL DEFAULT 0 CHECK(vector_epoch>=0));
INSERT INTO memory_epochs(singleton) VALUES(1);
CREATE TABLE memory_sources (source_id TEXT PRIMARY KEY, harness TEXT NOT NULL CHECK(harness IN ('claude','codex','cursor','pi','gemini','opencode','copilot')), native_session_id TEXT NOT NULL, active_revision_id TEXT REFERENCES source_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED, project TEXT, availability TEXT NOT NULL CHECK(availability IN ('live','archived','lost','forgotten','conflict')), created_at TEXT NOT NULL, UNIQUE(harness,native_session_id));
CREATE TABLE source_aliases (source_id TEXT NOT NULL REFERENCES memory_sources(source_id), path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('live','archive')), last_seen_at TEXT NOT NULL, last_stat_json TEXT NOT NULL CHECK(json_valid(last_stat_json)), artifact_hash TEXT, missing_at TEXT, PRIMARY KEY(source_id,path));
CREATE TABLE source_revisions (revision_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES memory_sources(source_id), artifact_hash TEXT NOT NULL, artifact_bytes INTEGER NOT NULL CHECK(artifact_bytes>=0), archive_relative_path TEXT, adapter_version TEXT NOT NULL, normalization_version TEXT NOT NULL, manifest_hash TEXT NOT NULL, event_min TEXT, event_max TEXT, observed_at TEXT NOT NULL, project TEXT, branch TEXT, completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial','legacy')), coverage_gaps_json TEXT NOT NULL CHECK(json_valid(coverage_gaps_json)), UNIQUE(source_id,artifact_hash,adapter_version,normalization_version,manifest_hash));
CREATE TABLE evidence_units (unit_revision_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES memory_sources(source_id), unit_key TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool_input','tool_result','ghost_prompt')), text TEXT NOT NULL, text_hash TEXT NOT NULL, normalization_version TEXT NOT NULL, tool_name TEXT, tool_call_id TEXT, outcome TEXT CHECK(outcome IS NULL OR outcome IN ('success','error','unknown')), event_at TEXT, time_basis TEXT NOT NULL CHECK(time_basis IN ('record','exchange','unknown')), project TEXT, branch TEXT, locator_json TEXT NOT NULL CHECK(json_valid(locator_json)), locator_fidelity TEXT NOT NULL CHECK(locator_fidelity IN ('record_id','record_ordinal','exchange_ordinal')), legacy_exchange_id TEXT, legacy_seq INTEGER CHECK(legacy_seq IS NULL OR legacy_seq>=0));
CREATE TABLE revision_units (revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id), unit_revision_id TEXT NOT NULL REFERENCES evidence_units(unit_revision_id), ordinal INTEGER NOT NULL CHECK(ordinal>=0), PRIMARY KEY(revision_id,unit_revision_id), UNIQUE(revision_id,ordinal));
CREATE TABLE evidence_spans (span_rowid INTEGER PRIMARY KEY, span_id TEXT NOT NULL UNIQUE, unit_revision_id TEXT NOT NULL REFERENCES evidence_units(unit_revision_id), start_utf16 INTEGER NOT NULL CHECK(start_utf16>=0), end_utf16 INTEGER NOT NULL CHECK(end_utf16>start_utf16), text TEXT NOT NULL, text_hash TEXT NOT NULL, chunk_policy TEXT NOT NULL, embedding_input_hash TEXT NOT NULL, embedding_context_json TEXT NOT NULL CHECK(json_valid(embedding_context_json)), UNIQUE(unit_revision_id,start_utf16,end_utf16,chunk_policy));
CREATE TABLE revision_spans (revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id), span_id TEXT NOT NULL REFERENCES evidence_spans(span_id), ordinal INTEGER NOT NULL CHECK(ordinal>=0), PRIMARY KEY(revision_id,span_id), UNIQUE(revision_id,ordinal));
CREATE TABLE source_relations (relation_id TEXT PRIMARY KEY, from_source_id TEXT NOT NULL REFERENCES memory_sources(source_id), to_source_id TEXT NOT NULL REFERENCES memory_sources(source_id), kind TEXT NOT NULL CHECK(kind IN ('spawn','resume','fork','record_overlap')), evidence_revision_id TEXT REFERENCES source_revisions(revision_id), basis_json TEXT NOT NULL CHECK(json_valid(basis_json)), observed_at TEXT NOT NULL, lineage_version TEXT NOT NULL);
CREATE VIRTUAL TABLE spans_fts USING fts5(text,content='evidence_spans',content_rowid='span_rowid');
CREATE INDEX evidence_units_source_key ON evidence_units(source_id,unit_key);
CREATE INDEX memory_sources_scope ON memory_sources(project,availability);
CREATE INDEX source_relations_from ON source_relations(from_source_id);
CREATE INDEX source_relations_to ON source_relations(to_source_id);
CREATE INDEX source_revisions_events ON source_revisions(source_id,event_min,event_max);
CREATE TRIGGER revision_unit_source BEFORE INSERT ON revision_units WHEN (SELECT source_id FROM source_revisions WHERE revision_id=NEW.revision_id)<>(SELECT source_id FROM evidence_units WHERE unit_revision_id=NEW.unit_revision_id) BEGIN SELECT RAISE(ABORT,'unit source mismatch'); END;
CREATE TRIGGER revision_span_unit BEFORE INSERT ON revision_spans WHEN NOT EXISTS(SELECT 1 FROM revision_units ru JOIN evidence_spans s ON s.unit_revision_id=ru.unit_revision_id WHERE ru.revision_id=NEW.revision_id AND s.span_id=NEW.span_id) BEGIN SELECT RAISE(ABORT,'span unit outside revision'); END;
CREATE TRIGGER source_active_revision BEFORE UPDATE OF active_revision_id ON memory_sources WHEN NEW.active_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_revisions WHERE revision_id=NEW.active_revision_id AND source_id=NEW.source_id) BEGIN SELECT RAISE(ABORT,'active revision source mismatch'); END;
` });
MIGRATIONS.push({ version: 15, name: 'durable-work-fences', up: `
CREATE TABLE maintenance_jobs (job_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('discover','capture','parse','lineage','embed','rebuild','forget')), target_id TEXT NOT NULL, target_revision_id TEXT REFERENCES source_revisions(revision_id), input_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','retry','done','blocked','cancelled')), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at TEXT NOT NULL, owner_token TEXT, lease_generation INTEGER CHECK(lease_generation IS NULL OR lease_generation>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT, error_detail_redacted TEXT, UNIQUE(kind,target_id,input_hash));
CREATE INDEX maintenance_jobs_due ON maintenance_jobs(state,next_attempt_at);
CREATE TABLE maintenance_leases (lane TEXT PRIMARY KEY, owner_token TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=0), pid INTEGER NOT NULL CHECK(pid>0), process_started_at TEXT NOT NULL, host_id TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE capture_checkpoints (source_id TEXT PRIMARY KEY REFERENCES memory_sources(source_id), discovered_fingerprint TEXT, acknowledged_fingerprint TEXT, acknowledged_revision_id TEXT REFERENCES source_revisions(revision_id), consumed_offset INTEGER NOT NULL DEFAULT 0 CHECK(consumed_offset>=0), reopen_offset INTEGER NOT NULL DEFAULT 0 CHECK(reopen_offset>=0 AND reopen_offset<=consumed_offset), prefix_hash TEXT, continuation_json TEXT CHECK(continuation_json IS NULL OR json_valid(continuation_json)), last_success_at TEXT, last_error_at TEXT, error_code TEXT);
CREATE TABLE maintenance_events (event_id INTEGER PRIMARY KEY, job_id TEXT REFERENCES maintenance_jobs(job_id), kind TEXT NOT NULL, at TEXT NOT NULL, detail_json TEXT NOT NULL CHECK(json_valid(detail_json)));
CREATE INDEX maintenance_events_job ON maintenance_events(job_id,event_id);
` });
MIGRATIONS.push({ version: 16, name: 'named-span-vector-spaces', up: `
CREATE TABLE embedding_spaces (space_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, model_revision TEXT NOT NULL, model_asset_hash TEXT NOT NULL, tokenizer_hash TEXT NOT NULL, runtime_version TEXT NOT NULL, dtype TEXT NOT NULL, pooling TEXT NOT NULL CHECK(pooling IN ('mean','cls')), query_prefix TEXT NOT NULL, normalization TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions>0), chunk_policy TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('building','active','retired')));
CREATE UNIQUE INDEX embedding_one_active ON embedding_spaces(state) WHERE state='active';
CREATE TABLE span_embeddings (span_id TEXT NOT NULL REFERENCES evidence_spans(span_id), space_id TEXT NOT NULL REFERENCES embedding_spaces(space_id), input_hash TEXT NOT NULL, vector_blob BLOB NOT NULL, created_at TEXT NOT NULL, job_id TEXT REFERENCES maintenance_jobs(job_id), PRIMARY KEY(span_id,space_id));
CREATE TRIGGER span_vector_bytes_insert BEFORE INSERT ON span_embeddings WHEN length(NEW.vector_blob)<>(SELECT dimensions*4 FROM embedding_spaces WHERE space_id=NEW.space_id) BEGIN SELECT RAISE(ABORT,'vector dimensions mismatch'); END;
CREATE TRIGGER span_vector_bytes_update BEFORE UPDATE ON span_embeddings WHEN length(NEW.vector_blob)<>(SELECT dimensions*4 FROM embedding_spaces WHERE space_id=NEW.space_id) BEGIN SELECT RAISE(ABORT,'vector dimensions mismatch'); END;
` });
MIGRATIONS.push({ version: 17, name: 'sourced-note-events', up: `
CREATE TABLE memory_note_events (note_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, origin_source_id TEXT REFERENCES memory_sources(source_id), legacy_note_id INTEGER REFERENCES notes(id), kind TEXT NOT NULL CHECK(kind IN ('decision','open','next','observation','retraction')), text TEXT NOT NULL, text_hash TEXT NOT NULL, project TEXT NOT NULL, branch TEXT, lineage_anchor_source_id TEXT REFERENCES memory_sources(source_id), event_at TEXT, valid_from TEXT, valid_until TEXT, observed_at TEXT NOT NULL, author_claim TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('cli','mcp','api','migration')), authority TEXT NOT NULL CHECK(authority IN ('user_attested','agent_assertion','unknown')), support_status TEXT NOT NULL CHECK(support_status IN ('linked','unverified','orphaned')), normalization_version TEXT NOT NULL, CHECK(valid_from IS NULL OR valid_until IS NULL OR valid_from<=valid_until));
CREATE INDEX memory_notes_scope ON memory_note_events(project,branch,observed_at);
CREATE TABLE note_supports (note_id TEXT NOT NULL REFERENCES memory_note_events(note_id), revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id), span_id TEXT NOT NULL REFERENCES evidence_spans(span_id), relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','context')), PRIMARY KEY(note_id,revision_id,span_id,relation), FOREIGN KEY(revision_id,span_id) REFERENCES revision_spans(revision_id,span_id));
CREATE TABLE note_supersessions (new_note_id TEXT NOT NULL REFERENCES memory_note_events(note_id), old_note_id TEXT NOT NULL REFERENCES memory_note_events(note_id), scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), reason TEXT NOT NULL, PRIMARY KEY(new_note_id,old_note_id), CHECK(new_note_id<>old_note_id));
CREATE TRIGGER note_supersession_scope BEFORE INSERT ON note_supersessions WHEN NOT EXISTS(SELECT 1 FROM memory_note_events n JOIN memory_note_events o WHERE n.note_id=NEW.new_note_id AND o.note_id=NEW.old_note_id AND n.project=o.project AND n.branch IS o.branch) BEGIN SELECT RAISE(ABORT,'supersession scope mismatch'); END;
CREATE TRIGGER note_supersession_cycle BEFORE INSERT ON note_supersessions WHEN EXISTS(WITH RECURSIVE chain(id) AS (SELECT old_note_id FROM note_supersessions WHERE new_note_id=NEW.old_note_id UNION SELECT s.old_note_id FROM note_supersessions s JOIN chain c ON s.new_note_id=c.id) SELECT 1 FROM chain WHERE id=NEW.new_note_id) BEGIN SELECT RAISE(ABORT,'supersession cycle'); END;
CREATE TABLE memory_write_receipts (request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, batch_id TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), committed_at TEXT NOT NULL);
CREATE TABLE forget_tombstones (tombstone_id TEXT PRIMARY KEY, source_id TEXT, note_id TEXT, scope_hash TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','complete','reversed')), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), CHECK((source_id IS NOT NULL)+(note_id IS NOT NULL)=1));
CREATE INDEX forget_tombstones_source ON forget_tombstones(source_id,state);
CREATE INDEX forget_tombstones_note ON forget_tombstones(note_id,state);
CREATE VIRTUAL TABLE memory_notes_fts USING fts5(text,content='memory_note_events');
` });

// Distinguish observed immutable snapshots from actual active-pointer transitions.
MIGRATIONS.push({version:18,name:'source-activation-history',up:`
CREATE UNIQUE INDEX source_revisions_source_revision ON source_revisions(source_id,revision_id);
CREATE TABLE source_activation_baselines(source_id TEXT PRIMARY KEY REFERENCES memory_sources(source_id) ON DELETE CASCADE,known_from TEXT NOT NULL,history_complete INTEGER NOT NULL CHECK(history_complete IN(0,1)));
CREATE TABLE source_activations(activation_id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL REFERENCES memory_sources(source_id) ON DELETE CASCADE,revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id) ON DELETE CASCADE,activated_at TEXT NOT NULL,evidence_epoch INTEGER NOT NULL CHECK(evidence_epoch>=0),basis TEXT NOT NULL CHECK(basis IN('published','migration_current')),FOREIGN KEY(source_id,revision_id) REFERENCES source_revisions(source_id,revision_id) ON DELETE CASCADE);
CREATE INDEX source_activations_order ON source_activations(source_id,activation_id DESC);
CREATE INDEX source_activations_cutoff ON source_activations(source_id,activated_at,activation_id);
INSERT INTO source_activation_baselines SELECT source_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),0 FROM memory_sources WHERE active_revision_id IS NOT NULL AND availability<>'forgotten';
INSERT INTO source_activations(source_id,revision_id,activated_at,evidence_epoch,basis) SELECT s.source_id,s.active_revision_id,b.known_from,e.evidence_epoch,'migration_current' FROM memory_sources s JOIN source_activation_baselines b ON b.source_id=s.source_id CROSS JOIN memory_epochs e WHERE e.singleton=1;
`});

export function open(opts: OpenOptions = {}): Db {
  const root = opts.root ?? potsherdDir();
  const file = opts.file ?? dbPath(root);
  if (file !== ':memory:' && !opts.readonly) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  let db = openDatabase(file, { readonly: opts.readonly ?? false });
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
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
  // `vec_exchanges`, `vec_cards` and `vec_ghost_prompts` are views whose
  // `distance` column is an application-defined function, and sqlite resolves
  // every column of a view at prepare time — so a connection that has not been
  // given the functions cannot even `SELECT COUNT(*)` from them. They are
  // registered here, on every connection including a read-only one, because
  // this is the single point every connection passes through and the
  // alternative is each call site remembering. `loadVec` is idempotent, costs
  // two closures, and never throws.
  loadVec(db);
  if (!opts.readonly) {
    db = reopenForSchemaSurgery(db, file, opts);
    migrate(db);
    // VERIFICATION-7 C7-1. The stamp and the vector store are two records of
    // one fact, and until this call nothing on any code path compared them —
    // so a re-index that dropped a stamp without dropping the vector left an
    // archive whose every status surface said `0 of 4,774` while `find` fused
    // 4,589 of them on the same screen. `reconcileVectorStamps` is that
    // comparison, and it repairs rather than reports because the store is the
    // half search can actually use. It is here, beside `migrate`, because this
    // is the single point every writable connection passes through — the same
    // reason `loadVec` is above — and because `doctor` opens read-only and
    // must be able to *see* drift it cannot fix (`vectorDrift`).
    reconcileVectorStamps(db);
  }
  return db;
}

/**
 * The one database that needs a connection ordinary code may not have.
 *
 * Migration 10 converts a 1.1.0 index by deleting three rows from
 * `sqlite_master` (see `vec.ts`), and from Node v24.19.0 `node:sqlite` opens
 * every connection with `SQLITE_DBCONFIG_DEFENSIVE` **on**, where that is
 * refused and `PRAGMA writable_schema = ON` is *silently ignored*. Defensive
 * mode has no runtime switch on that driver — it is a construction option — so
 * a connection that has already been opened cannot be talked into it. The only
 * answer is to open a second one, and the only honest place to decide that is
 * here, where the file, the mode and the driver are all still in hand.
 *
 * It costs an extra `open()` **only on a database that is actually stranded**,
 * which is a database written by 1.1.0 on a machine that has since lost
 * `sqlite-vec` — once, because the migration it enables is what stops it being
 * stranded. Every other connection in the product, on every driver, keeps its
 * driver's own defaults: this is not a global loosening, it is one connection,
 * one database, one migration.
 *
 * `:memory:` is excluded because reopening it would open a *different*,
 * empty database and silently discard the caller's. A stranded vec0 store
 * cannot exist in a fresh in-memory database anyway — it has no 1.1.0 past —
 * and a test that builds one in memory keeps the connection it built it on.
 */
function reopenForSchemaSurgery(db: Db, file: string, opts: OpenOptions): Db {
  if (file === ':memory:') return db;
  if ((loadVec(db).legacy ?? []).length === 0) return db;
  let next: Db;
  try {
    next = openDatabase(file, { readonly: false, schemaWritable: true });
  } catch {
    // Nothing is worse than before: the migration will decline on the
    // connection we already have, and say so in a sentence naming a way out.
    return db;
  }
  try {
    db.close();
  } catch {
    /* already gone; the new handle is the one that matters */
  }
  next.pragma('journal_mode = WAL');
  next.pragma('synchronous = FULL');
  next.pragma('foreign_keys = ON');
  next.pragma('busy_timeout = 5000');
  loadVec(next);
  void opts;
  return next;
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
