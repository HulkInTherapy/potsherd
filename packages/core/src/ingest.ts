import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { open as openDb } from './db.js';
import * as claudeAdapterModule from './adapters/claude.js';
import * as codexAdapterModule from './adapters/codex.js';
import * as cursorAdapterModule from './adapters/cursor.js';
import * as piAdapterModule from './adapters/pi.js';
import type {
  Exchange,
  Harness,
  ParseResult,
  SessionRecord,
  SessionSource,
} from './adapters/types.js';
import {
  MASK_RE,
  addCounts,
  emptyCounts,
  elideExchange,
  emptyElisions,
  redactExchange,
  redact,
  tally,
  type Elisions,
  type RedactionCounts,
  type SecretType,
} from './redact.js';
import {
  EMBEDDING_VERSION,
  MODEL_DOWNLOAD_BYTES,
  MODEL_ID,
  embeddingToBlob,
  generateExchangeEmbedding,
  isModelCached,
} from './embeddings.js';
import { loadVec, vecAvailable, vecStatus, vecTablesExist, type VecStatus } from './vec.js';
import { modelsDir, potsherdDir } from './paths.js';

/**
 * L1 + L4 — adapter output into the store.
 *
 * This is the seam the whole of phase 1 exists to produce: five adapters on one
 * side, one SQLite file on the other, and exactly one path between them so
 * there is exactly one place where the invariants hold.
 *
 * **Redaction runs before anything is written** (`03` §5). Not before the
 * search index, before the *store*: `exchanges.user_text`,
 * `exchanges.assistant_text`, `tool_calls.input`, `tool_calls.result` and
 * `ghost_prompts.text` are masked on the way in, and `exchanges.redacted` is
 * set where a rule fired. The database is therefore safe to hand to a model,
 * to grep, or to copy. The **archive** copy (L3) is not touched by any of this
 * — it stays byte-exact and unredacted, because it is the user's own file on
 * the user's own disk.
 *
 * **Incremental is a stat comparison**, the same trick `archive_files` plays
 * for `rescue` (phase-0 HANDOFF item 2). `sessions.source_mtime` and
 * `sessions.source_offset` record what was read; a source whose mtime and byte
 * count both match is not opened at all. One level up, `sync_state` holds a
 * fingerprint per harness of everything `discover()` saw, so an unchanged
 * harness costs one `readdir` walk and no database work whatever.
 *
 * **Nothing here is fatal.** An unreadable transcript is counted and named; an
 * unknown record type is counted; a missing `sqlite-vec` means no vectors, not
 * no index.
 */

// --------------------------------------------------------------- adapters

export interface AdapterSpec {
  harness: Harness;
  displayName: string;
  sourceDir: string;
  discover(): SessionSource[];
  parse(source: SessionSource): Promise<ParseResult>;
  /** `(harness, version, type)` needs a version; only claude and codex have one. */
  version(result: ParseResult): string;
  novel(type: string): boolean;
}

export interface AdapterOptions {
  claudeDir?: string;
  potsherdDir?: string;
  codexHome?: string;
  cursorDir?: string;
  piDir?: string;
}

/**
 * The five adapters, bound to whatever directory overrides this run was given.
 * One list, in `doctor`'s order — `index`, `doctor` and (phase 2) `stats` all
 * walk it, so a harness can never be supported by one verb and invisible to
 * another.
 */
export function adapterSpecs(o: AdapterOptions = {}): AdapterSpec[] {
  return [
    {
      harness: 'claude',
      displayName: 'Claude Code',
      sourceDir: claudeAdapterModule.sourceDir(o.claudeDir),
      discover: () =>
        claudeAdapterModule.discover({
          ...(o.claudeDir ? { claudeDir: o.claudeDir } : {}),
          ...(o.potsherdDir ? { potsherdDir: o.potsherdDir } : {}),
        }),
      parse: (source) => claudeAdapterModule.parse(source),
      version: (r) => (r as claudeAdapterModule.ClaudeParseResult).version ?? 'unknown',
      novel: claudeAdapterModule.isNovelRecordType,
    },
    {
      harness: 'codex',
      displayName: 'Codex CLI',
      sourceDir: codexAdapterModule.codexPaths(codexAdapterModule.codexDir(o.codexHome)).sessions,
      discover: () => codexAdapterModule.discover(o.codexHome ? { codexHome: o.codexHome } : {}),
      parse: (source) =>
        codexAdapterModule.parse(source, o.codexHome ? { codexHome: o.codexHome } : {}),
      version: (r) => (r as codexAdapterModule.CodexParseResult).codex?.cliVersion ?? 'unknown',
      novel: () => true,
    },
    {
      harness: 'cursor',
      displayName: 'Cursor',
      sourceDir: cursorAdapterModule.cursorProjectsDir(o.cursorDir),
      discover: () => cursorAdapterModule.discover(o.cursorDir),
      parse: (source) => cursorAdapterModule.parse(source),
      version: () => 'unknown',
      novel: () => true,
    },
    {
      harness: 'pi',
      displayName: 'pi',
      sourceDir: piAdapterModule.sourceDir(o.piDir),
      discover: () => piAdapterModule.discover(o.piDir),
      parse: (source) => piAdapterModule.parse(source),
      version: () => 'unknown',
      novel: () => true,
    },
  ];
}

// ------------------------------------------------------------ one session

export interface IngestOptions {
  /** `stat().mtimeMs` of the source, stored for the incremental comparison. */
  sourceMtimeMs?: number;
  /** Where the harness used to keep it, when `path` is potsherd's archive copy. */
  archivedPath?: string;
  originalPath?: string;
  indexedAt?: string;
}

export interface IngestSessionResult {
  sessionId: string;
  exchanges: number;
  toolCalls: number;
  /** Exchanges where at least one rule fired. */
  redactedExchanges: number;
  counts: RedactionCounts;
  /** Binary payloads dropped before redaction ever saw them. */
  elisions: Elisions;
}

/**
 * Write one parsed session into the store, redacting on the way in.
 *
 * Replaces the session's exchanges wholesale rather than merging: exchange ids
 * are a pure function of `(sessionId, seq)`, so a re-parse of a grown
 * transcript re-derives the same ids for the same turns and a straight replace
 * is both idempotent and correct. `ON DELETE CASCADE` takes `tool_calls` with
 * them; `exchanges_fts` and `vec_exchanges` are not real tables and are cleaned
 * up by hand here — an external-content fts5 index only stays consistent if the
 * *old* values are handed back to it on delete.
 */
export function ingestSession(
  db: Db,
  parsed: ParseResult,
  options: IngestOptions = {},
): IngestSessionResult {
  const session = parsed.session;
  const counts = emptyCounts();
  let redactedExchanges = 0;
  let toolCallCount = 0;

  const elisions = emptyElisions();
  const redacted: Exchange[] = [];
  for (const exchange of parsed.exchanges) {
    // Binary payloads are elided *before* redaction, never by it. A base64
    // image in a tool result is not a credential and no scanner can read it as
    // anything but 500 KB of maximum-entropy noise: measured on the reference
    // corpus, images alone accounted for 98.6% of every mask potsherd emitted.
    // `redact-elide.ts` has the argument in full; the codex adapter has done
    // the same thing at its own layer since T1.3.
    const { exchange: lean, elisions: e } = elideExchange(exchange);
    const { exchange: clean, hits } = redactExchange(lean);
    elisions.binaryParts += e.binaryParts;
    elisions.charsElided += e.charsElided;
    tally(hits, counts);
    if (clean.redacted) redactedExchanges += 1;
    toolCallCount += clean.toolCalls.length;
    redacted.push(clean);
  }

  const run = db.transaction(() => {
    upsertSession(db, session, parsed, options);
    clearExchanges(db, session.id);
    for (const exchange of redacted) insertExchange(db, exchange);
  });
  run();

  return {
    sessionId: session.id,
    exchanges: redacted.length,
    toolCalls: toolCallCount,
    redactedExchanges,
    counts,
    elisions,
  };
}

function upsertSession(
  db: Db,
  s: SessionRecord,
  parsed: ParseResult,
  o: IngestOptions,
): void {
  db.prepare(
    `INSERT INTO sessions (
       id, harness, source_path, project, project_slug, started_at, ended_at, title,
       git_branch, entrypoint, model, is_sidechain, parent_session_id, agent_name,
       user_prompts, assistant_turns, tool_calls, bytes, status, archived_path,
       indexed_at, source_mtime, source_offset)
     VALUES (
       @id, @harness, @source_path, @project, @project_slug, @started_at, @ended_at, @title,
       @git_branch, @entrypoint, @model, @is_sidechain, @parent_session_id, @agent_name,
       @user_prompts, @assistant_turns, @tool_calls, @bytes, @status, @archived_path,
       @indexed_at, @source_mtime, @source_offset)
     ON CONFLICT(id) DO UPDATE SET
       harness = excluded.harness, source_path = excluded.source_path,
       project = excluded.project, project_slug = excluded.project_slug,
       started_at = excluded.started_at, ended_at = excluded.ended_at,
       title = COALESCE(excluded.title, sessions.title),
       git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
       entrypoint = COALESCE(excluded.entrypoint, sessions.entrypoint),
       model = COALESCE(excluded.model, sessions.model),
       is_sidechain = excluded.is_sidechain,
       parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
       agent_name = COALESCE(excluded.agent_name, sessions.agent_name),
       user_prompts = excluded.user_prompts, assistant_turns = excluded.assistant_turns,
       tool_calls = excluded.tool_calls, bytes = excluded.bytes,
       status = excluded.status, archived_path = excluded.archived_path,
       indexed_at = excluded.indexed_at, source_mtime = excluded.source_mtime,
       source_offset = excluded.source_offset`,
  ).run({
    id: s.id,
    harness: s.harness,
    source_path: o.originalPath ?? s.sourcePath,
    project: s.project || null,
    project_slug: s.projectSlug || null,
    started_at: s.startedAt || null,
    ended_at: s.endedAt || null,
    title: s.title ?? null,
    git_branch: s.gitBranch ?? null,
    entrypoint: s.entrypoint ?? null,
    model: s.model ?? null,
    is_sidechain: s.isSidechain ? 1 : 0,
    parent_session_id: s.parentSessionId ?? null,
    agent_name: s.agentName ?? null,
    user_prompts: s.counts.userPrompts,
    assistant_turns: s.counts.assistantTurns,
    tool_calls: s.counts.toolCalls,
    bytes: s.counts.bytes,
    status: s.status,
    archived_path: o.archivedPath ?? (s.status === 'archived' ? s.sourcePath : null),
    indexed_at: o.indexedAt ?? new Date().toISOString(),
    source_mtime: o.sourceMtimeMs !== undefined ? Math.floor(o.sourceMtimeMs) : null,
    source_offset: parsed.endOffset,
  });
}

/**
 * Drop a session's exchanges, and with them their fts5 and vec0 rows.
 *
 * `exchanges_fts` is an external-content table: sqlite stores no copy of the
 * text, so a plain `DELETE` would leave its index pointing at rows that no
 * longer exist and every later query would return garbage or raise
 * `database disk image is malformed`. The documented protocol is to feed the
 * *old* column values back in with the `'delete'` command first, which is what
 * the loop below does.
 */
function clearExchanges(db: Db, sessionId: string): void {
  const rows = db
    .prepare('SELECT rowid, id, user_text, assistant_text FROM exchanges WHERE session_id = ?')
    .all(sessionId) as { rowid: number; id: string; user_text: string; assistant_text: string }[];
  if (rows.length === 0) return;

  const unindex = db.prepare(
    `INSERT INTO exchanges_fts (exchanges_fts, rowid, user_text, assistant_text)
     VALUES ('delete', ?, ?, ?)`,
  );
  for (const row of rows) unindex.run(row.rowid, row.user_text, row.assistant_text);

  // Both conditions: the table can be in `sqlite_master` while this particular
  // connection has not loaded vec0, and then the DELETE raises "no such module".
  // `ingestSession` is exported and may be called without `indexAll`'s setup.
  if (vecAvailable(db) && vecTablesExist(db)) {
    const dropVec = db.prepare('DELETE FROM vec_exchanges WHERE id = ?');
    for (const row of rows) dropVec.run(row.id);
  }
  db.prepare('DELETE FROM exchanges WHERE session_id = ?').run(sessionId);
}

function insertExchange(db: Db, e: Exchange): void {
  const info = db
    .prepare(
      `INSERT INTO exchanges (
         id, session_id, seq, ts, user_text, assistant_text, files_touched,
         is_sidechain, parent_uuid, redacted, embedding_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      e.id,
      e.sessionId,
      e.seq,
      e.ts || null,
      e.userText,
      e.assistantText,
      JSON.stringify(e.filesTouched),
      e.isSidechain ? 1 : 0,
      e.parentUuid ?? null,
      e.redacted ? 1 : 0,
    );

  db.prepare(
    'INSERT INTO exchanges_fts (rowid, user_text, assistant_text) VALUES (?, ?, ?)',
  ).run(info.lastInsertRowid, e.userText, e.assistantText);

  if (e.toolCalls.length === 0) return;
  const insertTool = db.prepare(
    `INSERT INTO tool_calls (id, exchange_id, name, input, result, is_error, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  e.toolCalls.forEach((tc, i) => {
    insertTool.run(
      `${e.id}:${i}`,
      e.id,
      tc.name,
      tc.input,
      tc.result ?? null,
      tc.isError ? 1 : 0,
      e.ts || null,
    );
  });
}

// ---------------------------------------------------------------- ghosts

export interface GhostSyncResult {
  ghosts: number;
  prompts: number;
  /** Ghost prompt rows a rule fired on. */
  redactedPrompts: number;
  counts: RedactionCounts;
  /** True when the fingerprint matched and nothing had to be re-read. */
  unchanged: boolean;
}

const GHOST_INDEX_KEY = 'index:ghosts';

/**
 * Put the ghosts into the search index, redacted.
 *
 * Phase 0 created `ghosts_fts` and `ghost_prompts_fts` and never filled them,
 * because phase 0 had no search. `rescue` writes `ghosts` / `ghost_prompts`
 * straight from `history.jsonl`, unredacted — that pass is the *rescue*, and it
 * runs from a hook where a secret scan would be an unwelcome cost. Redaction is
 * this pass's job, and it happens here before a single token reaches fts5.
 *
 * The prompt text is rewritten in place. That is not the archive: the archive
 * copy of `history.jsonl` under `~/.potsherd/archive/` is byte-exact and
 * untouched, and it is the only copy that has to be. The database is an index,
 * and `03` §5 says the index is redacted.
 */
export function ingestGhosts(db: Db, options: { full?: boolean } = {}): GhostSyncResult {
  const fingerprint = ghostFingerprint(db);
  if (!options.full) {
    const seen = readIndexState(db, GHOST_INDEX_KEY);
    if (seen && seen === fingerprint) {
      const totals = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM ghosts) AS g,
                  (SELECT COUNT(*) FROM ghost_prompts) AS p,
                  (SELECT COUNT(*) FROM ghost_prompts WHERE redacted = 1) AS r`,
        )
        .get() as { g: number; p: number; r: number };
      return {
        ghosts: totals.g,
        prompts: totals.p,
        redactedPrompts: totals.r,
        counts: emptyCounts(),
        unchanged: true,
      };
    }
  }

  const counts = emptyCounts();
  let redactedPrompts = 0;

  const ghosts = db
    .prepare('SELECT rowid, session_id, first_prompt, title FROM ghosts')
    .all() as { rowid: number; session_id: string; first_prompt: string | null; title: string | null }[];
  const prompts = db
    .prepare('SELECT rowid, id, text, redacted FROM ghost_prompts')
    .all() as { rowid: number; id: string; text: string; redacted: number }[];

  const run = db.transaction(() => {
    db.prepare(`INSERT INTO ghosts_fts (ghosts_fts) VALUES ('delete-all')`).run();
    db.prepare(`INSERT INTO ghost_prompts_fts (ghost_prompts_fts) VALUES ('delete-all')`).run();

    const updateGhost = db.prepare('UPDATE ghosts SET first_prompt = ?, title = ? WHERE rowid = ?');
    const indexGhost = db.prepare(
      'INSERT INTO ghosts_fts (rowid, first_prompt, title) VALUES (?, ?, ?)',
    );
    for (const g of ghosts) {
      const first = maskField(g.first_prompt, counts);
      const title = maskField(g.title, counts);
      if (first !== g.first_prompt || title !== g.title) updateGhost.run(first, title, g.rowid);
      indexGhost.run(g.rowid, first, title);
    }

    const updatePrompt = db.prepare('UPDATE ghost_prompts SET text = ?, redacted = ? WHERE rowid = ?');
    const indexPrompt = db.prepare('INSERT INTO ghost_prompts_fts (rowid, text) VALUES (?, ?)');
    for (const p of prompts) {
      const result = redact(p.text);
      const fired = result.hits.length > 0 ? 1 : 0;
      if (fired) {
        tally(result.hits, counts);
        redactedPrompts += 1;
      }
      if (result.text !== p.text || p.redacted !== fired) updatePrompt.run(result.text, fired, p.rowid);
      indexPrompt.run(p.rowid, result.text);
    }

    writeIndexState(db, GHOST_INDEX_KEY, ghostFingerprint(db));
  });
  run();

  return {
    ghosts: ghosts.length,
    prompts: prompts.length,
    redactedPrompts,
    counts,
    unchanged: false,
  };
}

function maskField(value: string | null, counts: RedactionCounts): string | null {
  if (!value) return value;
  const result = redact(value);
  if (result.hits.length > 0) tally(result.hits, counts);
  return result.text;
}

/**
 * What the ghost tables look like right now. Any rescue that adds, removes or
 * rewrites a ghost moves the row counts or the total text length, so a match
 * means the fts side is already current.
 */
function ghostFingerprint(db: Db): string {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM ghosts) AS g,
              (SELECT COALESCE(SUM(LENGTH(COALESCE(first_prompt,'')) + LENGTH(COALESCE(title,''))), 0) FROM ghosts) AS gl,
              (SELECT COUNT(*) FROM ghost_prompts) AS p,
              (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM ghost_prompts) AS pl,
              (SELECT COUNT(*) FROM ghosts_fts) AS gf,
              (SELECT COUNT(*) FROM ghost_prompts_fts) AS pf`,
    )
    .get() as Record<string, number>;
  return `${row.g}:${row.gl}:${row.p}:${row.pl}:${row.gf}:${row.pf}`;
}

// ------------------------------------------- what is masked in the index

/**
 * Redaction counts by type, read back out of the index itself.
 *
 * `doctor` has to answer "what did potsherd mask?" long after the run that
 * masked it, and on an incremental run that parsed nothing. Rather than keep a
 * counter that can drift from the data, this counts the masks that are actually
 * in the stored text — `‹redacted:<type>:<sha8>›` is unmistakable and cannot
 * occur naturally (see `redact.ts` on why the guillemets were chosen). Only
 * rows flagged `redacted = 1` are read, so the scan touches the handful of rows
 * that can contain a mask rather than the whole corpus.
 *
 * The number is therefore verifiable by hand:
 *
 *     sqlite3 ~/.potsherd/potsherd.db \
 *       "SELECT user_text FROM exchanges WHERE redacted = 1" | grep -o '‹redacted:[a-z-]*' | sort | uniq -c
 */
export function storedRedactionCounts(db: Db): RedactionCounts {
  const counts = emptyCounts();
  const scan = (text: string | null): void => {
    if (!text) return;
    const rx = new RegExp(MASK_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const type = m[0].split(':')[1] as SecretType | undefined;
      if (!type) continue;
      counts.byType[type] = (counts.byType[type] ?? 0) + 1;
      counts.total += 1;
    }
  };

  for (const row of db
    .prepare('SELECT user_text, assistant_text FROM exchanges WHERE redacted = 1')
    .iterate() as Iterable<{ user_text: string; assistant_text: string }>) {
    scan(row.user_text);
    scan(row.assistant_text);
  }
  for (const row of db
    .prepare(
      `SELECT t.input, t.result FROM tool_calls t
       JOIN exchanges e ON e.id = t.exchange_id WHERE e.redacted = 1`,
    )
    .iterate() as Iterable<{ input: string | null; result: string | null }>) {
    scan(row.input);
    scan(row.result);
  }
  for (const row of db
    .prepare('SELECT text FROM ghost_prompts WHERE redacted = 1')
    .iterate() as Iterable<{ text: string }>) {
    scan(row.text);
  }
  for (const row of db
    .prepare('SELECT first_prompt, title FROM ghosts')
    .iterate() as Iterable<{ first_prompt: string | null; title: string | null }>) {
    scan(row.first_prompt);
    scan(row.title);
  }
  return counts;
}

// ------------------------------------------------------------ sync_state

export function readIndexState(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function writeIndexState(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

/** Everything `discover()` saw, in one hash: path, size and mtime of each file. */
function sourceFingerprint(sources: readonly SessionSource[]): string {
  const hash = crypto.createHash('sha256');
  for (const s of [...sources].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${s.path}:${s.bytes}:${Math.floor(s.mtimeMs)}\n`);
  }
  return `${sources.length}:${hash.digest('hex').slice(0, 32)}`;
}

// ----------------------------------------------------------------- index

export interface RecordTypeRow {
  harness: Harness;
  version: string;
  type: string;
  count: number;
  files: number;
  novel: boolean;
}

export interface HarnessReport {
  harness: Harness;
  displayName: string;
  sourceDir: string;
  present: boolean;
  discovered: number;
  /** Sources opened and parsed this run. */
  parsed: number;
  /** Sources whose mtime and byte count were unchanged, so never opened. */
  skipped: number;
  failed: number;
  sessions: number;
  sidechains: number;
  exchanges: number;
  toolCalls: number;
  redactedExchanges: number;
  malformedLines: number;
  bytes: number;
  errors: string[];
  /** True when the whole harness was skipped on its `sync_state` fingerprint. */
  unchanged: boolean;
  ms: number;
}

export interface EmbeddingReport {
  enabled: boolean;
  available: boolean;
  model: string;
  /** Exchanges embedded this run. */
  embedded: number;
  /** Exchanges already carrying a current vector. */
  upToDate: number;
  /**
   * Recovered prompts embedded this run (`vec_ghost_prompts`, schema 8).
   *
   * Counted apart from {@link embedded} because a ghost prompt is one sentence
   * and an exchange is a whole turn: adding them together would make the
   * per-item timing the eval prints meaningless.
   */
  ghostPrompts: number;
  /** Set when `enabled` but not `available`. */
  reason?: string;
  /** True when the model had to be fetched (~34 MB) during this run. */
  downloaded: boolean;
  ms: number;
}

export interface IndexReport {
  ranAt: string;
  full: boolean;
  harnesses: HarnessReport[];
  totals: {
    sessions: number;
    exchanges: number;
    toolCalls: number;
    redactedExchanges: number;
    parsed: number;
    skipped: number;
    failed: number;
    bytes: number;
  };
  recordTypes: RecordTypeRow[];
  redaction: RedactionCounts;
  ghosts: GhostSyncResult;
  embeddings: EmbeddingReport;
  vec: VecStatus;
  ms: number;
}

export type IndexProgress =
  | { phase: 'discover'; harness: Harness }
  | { phase: 'parse'; harness: Harness; done: number; total: number; note: string }
  | { phase: 'ghosts' }
  | { phase: 'model-download'; fraction: number }
  | { phase: 'embed'; done: number; total: number };

export interface IndexOptions extends AdapterOptions {
  /** An already-open database. Otherwise one is opened under `root`. */
  db?: Db;
  root?: string;
  /** Re-read and re-write every source, ignoring both change fingerprints. */
  full?: boolean;
  /** Restrict to these harnesses. */
  harnesses?: readonly Harness[];
  /** Restrict to one session id (its transcript is still discovered normally). */
  sessionId?: string;
  /** Default true. `false` is `--no-embed`: fts-only, no model, no network. */
  embed?: boolean;
  onProgress?: (p: IndexProgress) => void;
  /** Called once, before a ~34 MB first-run download starts. */
  onModelDownload?: (bytes: number) => void;
}

/**
 * The whole of `potsherd index`. Discover, parse, redact, store, fts, ghosts,
 * embed — in that order, because every later step depends on the earlier one
 * having already masked the text.
 */
export async function indexAll(options: IndexOptions = {}): Promise<IndexReport> {
  const started = Date.now();
  const ranAt = new Date().toISOString();
  const root = options.root ?? potsherdDir(options.potsherdDir);
  const db = options.db ?? openDb({ root });
  const ownDb = !options.db;
  const embed = options.embed !== false;
  // The archive fallback lives under potsherd's own directory, and it must be
  // the *same* directory this run is writing to. Defaulting one from the other
  // is not a nicety: a run given only `root` would otherwise discover the real
  // `~/.potsherd/archive` and index someone else's corpus into a scratch db.
  const adapterOptions: AdapterOptions = { ...options, potsherdDir: options.potsherdDir ?? root };

  try {
    // Migration 4 may have declined at open() if `sqlite-vec` was missing; ask
    // once here so the report can say which of the two indexes this run built.
    const vec = loadVec(db);

    const wanted = options.harnesses ? new Set(options.harnesses) : null;
    const specs = adapterSpecs(adapterOptions).filter((s) => !wanted || wanted.has(s.harness));

    const harnesses: HarnessReport[] = [];
    const recordTypes = new Map<string, RecordTypeRow>();
    let redaction = emptyCounts();

    for (const spec of specs) {
      options.onProgress?.({ phase: 'discover', harness: spec.harness });
      const report = await indexHarness(db, spec, { ...options, ...adapterOptions }, recordTypes);
      redaction = addCounts(redaction, report.redaction);
      harnesses.push(report.harness_);
    }

    options.onProgress?.({ phase: 'ghosts' });
    const ghosts = ingestGhosts(db, { full: Boolean(options.full) });
    redaction = addCounts(redaction, ghosts.counts);

    const embeddings = await embedExchanges(db, { ...options, embed }, vec);

    const totals = {
      sessions: sum(harnesses, (h) => h.sessions),
      exchanges: sum(harnesses, (h) => h.exchanges),
      toolCalls: sum(harnesses, (h) => h.toolCalls),
      redactedExchanges: sum(harnesses, (h) => h.redactedExchanges),
      parsed: sum(harnesses, (h) => h.parsed),
      skipped: sum(harnesses, (h) => h.skipped),
      failed: sum(harnesses, (h) => h.failed),
      bytes: sum(harnesses, (h) => h.bytes),
    };

    return {
      ranAt,
      full: Boolean(options.full),
      harnesses,
      totals,
      recordTypes: [...recordTypes.values()].sort(
        (a, b) =>
          Number(b.novel) - Number(a.novel) ||
          b.count - a.count ||
          (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0) ||
          (a.type < b.type ? -1 : 1),
      ),
      redaction,
      ghosts,
      embeddings,
      vec: vecStatus(db),
      ms: Date.now() - started,
    };
  } finally {
    if (ownDb) db.close();
  }
}

async function indexHarness(
  db: Db,
  spec: AdapterSpec,
  options: IndexOptions,
  recordTypes: Map<string, RecordTypeRow>,
): Promise<{ harness_: HarnessReport; redaction: RedactionCounts }> {
  const started = Date.now();
  const report: HarnessReport = {
    harness: spec.harness,
    displayName: spec.displayName,
    sourceDir: spec.sourceDir,
    present: fs.existsSync(spec.sourceDir),
    discovered: 0,
    parsed: 0,
    skipped: 0,
    failed: 0,
    sessions: 0,
    sidechains: 0,
    exchanges: 0,
    toolCalls: 0,
    redactedExchanges: 0,
    malformedLines: 0,
    bytes: 0,
    errors: [],
    unchanged: false,
    ms: 0,
  };
  let redaction = emptyCounts();

  let sources: SessionSource[];
  try {
    sources = spec.discover();
  } catch (err) {
    report.errors.push(`discover: ${(err as Error).message}`);
    report.ms = Date.now() - started;
    return { harness_: report, redaction };
  }
  if (options.sessionId) {
    sources = sources.filter((s) => s.sessionId === options.sessionId || s.sessionId.endsWith(`:${options.sessionId}`));
  }
  report.discovered = sources.length;
  report.bytes = sources.reduce((a, s) => a + s.bytes, 0);

  const stateKey = `index:${spec.harness}`;
  const fingerprint = sourceFingerprint(sources);
  if (!options.full && !options.sessionId && readIndexState(db, stateKey) === fingerprint) {
    report.unchanged = true;
    report.skipped = sources.length;
    fillStoredCounts(db, report);
    report.ms = Date.now() - started;
    return { harness_: report, redaction };
  }

  const known = new Map<string, { mtime: number | null; offset: number }>();
  for (const row of db
    .prepare('SELECT id, source_mtime, source_offset FROM sessions WHERE harness = ?')
    .all(spec.harness) as { id: string; source_mtime: number | null; source_offset: number }[]) {
    known.set(row.id, { mtime: row.source_mtime, offset: row.source_offset });
  }

  let done = 0;
  for (const source of sources) {
    done += 1;
    options.onProgress?.({
      phase: 'parse',
      harness: spec.harness,
      done,
      total: sources.length,
      note: path.basename(source.path),
    });

    // The incremental test, and it is a stat comparison exactly as
    // `archive_files` does it for rescue: same mtime and same byte count means
    // the file cannot have changed, so it is never opened.
    const seen = known.get(source.sessionId);
    if (
      !options.full &&
      seen &&
      seen.mtime !== null &&
      seen.mtime === Math.floor(source.mtimeMs) &&
      seen.offset === source.bytes
    ) {
      report.skipped += 1;
      continue;
    }

    let parsed: ParseResult;
    try {
      parsed = await spec.parse(source);
    } catch (err) {
      // A live transcript can vanish between readdir and read; that is the
      // sweep doing its job, not a parse failure. Everything else is named.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        report.failed += 1;
        report.errors.push(`${source.path}: ${(err as Error).message}`);
      }
      continue;
    }

    const result = ingestSession(db, parsed, {
      sourceMtimeMs: source.mtimeMs,
      ...(source.status === 'archived' ? { archivedPath: source.path } : {}),
      ...((source as { originalPath?: string }).originalPath
        ? { originalPath: (source as { originalPath?: string }).originalPath }
        : {}),
    });

    report.parsed += 1;
    report.malformedLines += parsed.malformedLines;
    redaction = addCounts(redaction, result.counts);

    const version = spec.version(parsed);
    // Two ledgers, deliberately: the map is what *this run* saw and goes on the
    // receipt; the table is what the *index* holds and is what `doctor` reads
    // back, months later, after an incremental pass that opened one file.
    writeSessionRecordTypes(db, parsed.session.id, spec, version, parsed.unknownTypes);
    for (const [type, count] of Object.entries(parsed.unknownTypes)) {
      const key = `${spec.harness}\0${version}\0${type}`;
      const row = recordTypes.get(key);
      if (row) {
        row.count += count;
        row.files += 1;
      } else {
        recordTypes.set(key, {
          harness: spec.harness,
          version,
          type,
          count,
          files: 1,
          novel: spec.novel(type),
        });
      }
    }
  }

  if (!options.sessionId) writeIndexState(db, stateKey, fingerprint);
  fillStoredCounts(db, report);
  report.ms = Date.now() - started;
  return { harness_: report, redaction };
}

/**
 * The counts a report carries are the state of the *index*, not of this run:
 * "your index holds 227 claude sessions" is the true and useful sentence, and
 * an incremental run that parsed nothing must still say it. What the run itself
 * did is `parsed` / `skipped` / `failed`.
 */
function fillStoredCounts(db: Db, report: HarnessReport): void {
  const s = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(is_sidechain), 0) AS side
       FROM sessions WHERE harness = ?`,
    )
    .get(report.harness) as { n: number; side: number };
  const e = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(e.redacted), 0) AS red,
              (SELECT COUNT(*) FROM tool_calls t JOIN exchanges x ON x.id = t.exchange_id
                 JOIN sessions y ON y.id = x.session_id WHERE y.harness = ?) AS tools
       FROM exchanges e JOIN sessions s ON s.id = e.session_id WHERE s.harness = ?`,
    )
    .get(report.harness, report.harness) as { n: number; red: number; tools: number };
  report.sessions = s.n;
  report.sidechains = s.side;
  report.exchanges = e.n;
  report.toolCalls = e.tools;
  report.redactedExchanges = e.red;
}

// ------------------------------------------------------------ embeddings

/**
 * How many exchanges are written per transaction, and how often the progress
 * bar moves. Not a model batch size: see {@link embedExchanges}.
 */
const EMBED_CHUNK = 32;

/**
 * bge-small over every exchange that does not already have a current vector.
 *
 * Three things this must never do: download 34 MB without saying so first,
 * take a minute in silence, or fail the whole index because the vector store
 * is unavailable. `--no-embed` skips it entirely, which is what makes `find`
 * work on day one, offline, before the model exists.
 */
async function embedExchanges(
  db: Db,
  options: IndexOptions & { embed: boolean },
  vec: VecStatus,
): Promise<EmbeddingReport> {
  const started = Date.now();
  const report: EmbeddingReport = {
    enabled: options.embed,
    available: false,
    model: MODEL_ID,
    embedded: 0,
    upToDate: 0,
    ghostPrompts: 0,
    downloaded: false,
    ms: 0,
  };

  const upToDate = db
    .prepare('SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version = ?')
    .get(EMBEDDING_VERSION) as { n: number };
  report.upToDate = upToDate.n;

  if (!options.embed) {
    report.reason = '--no-embed: text search only';
    report.ms = Date.now() - started;
    return report;
  }
  if (!vec.available) {
    report.reason = vec.reason ?? 'sqlite-vec unavailable';
    report.ms = Date.now() - started;
    return report;
  }
  report.available = true;

  const pending = db
    .prepare(
      `SELECT id, user_text, assistant_text FROM exchanges
       WHERE embedding_version IS NULL OR embedding_version != ?
       ORDER BY rowid`,
    )
    .all(EMBEDDING_VERSION) as { id: string; user_text: string; assistant_text: string }[];
  // Two populations need vectors, and they run out of work independently. The
  // early return used to ask only the exchanges — so on every run after the
  // first, when nothing in `exchanges` was stale, it returned *before* the
  // ghost pass below and `vec_ghost_prompts` stayed empty forever for anyone
  // who was upgrading rather than building an index from scratch. Which is
  // everyone. Ask both, and leave only when neither has anything to do.
  const ghostsPending = pendingGhostPrompts(db);
  if (pending.length === 0 && ghostsPending === 0) {
    report.ms = Date.now() - started;
    return report;
  }

  // The model lives under *this run's* potsherd directory, so `--potsherd-dir`
  // is genuinely self-contained and a test sandbox can never write into the
  // developer's real cache.
  const cacheDir = modelsDir(options.root ?? potsherdDir(options.potsherdDir));
  if (!isModelCached(cacheDir)) {
    report.downloaded = true;
    options.onModelDownload?.(MODEL_DOWNLOAD_BYTES);
  }

  // vec0 is a virtual table and implements neither UPSERT nor `INSERT OR
  // REPLACE`; delete-then-insert is the documented way to replace a vector.
  const dropVec = db.prepare('DELETE FROM vec_exchanges WHERE id = ?');
  const insertVec = db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)');
  const stamp = db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?');

  const embedOptions = {
    cacheDir,
    ...(options.onProgress
      ? { onProgress: (fraction: number) => options.onProgress?.({ phase: 'model-download', fraction }) }
      : {}),
  };

  for (let i = 0; i < pending.length; i += EMBED_CHUNK) {
    const chunk = pending.slice(i, i + EMBED_CHUNK);
    let vectors: number[][];
    try {
      // One exchange per forward pass. Batching was measured on the reference
      // machine and buys nothing (the model dominates, not the call overhead)
      // while q8's per-pass activation scales make a batched vector differ from
      // a single-call one by ~3e-3 of cosine. No speed to gain, so take the
      // reproducible vector. See `embeddings.generateExchangeEmbeddings`.
      vectors = [];
      for (const row of chunk) {
        vectors.push(
          await generateExchangeEmbedding(row.user_text, row.assistant_text, undefined, embedOptions),
        );
      }
    } catch (err) {
      // The model, or the runtime that loads it, is not on this machine.
      // `--no-embed` is what the user gets, and they are told which of the two
      // indexes they now have rather than losing the whole run.
      report.available = false;
      report.reason = `embeddings unavailable: ${firstLine((err as Error)?.message ?? String(err))}`;
      report.ms = Date.now() - started;
      return report;
    }
    const write = db.transaction(() => {
      chunk.forEach((row, n) => {
        const vector = vectors[n];
        if (!vector) return;
        dropVec.run(row.id);
        insertVec.run(row.id, embeddingToBlob(vector));
        stamp.run(EMBEDDING_VERSION, row.id);
        report.embedded += 1;
      });
    });
    write();
    options.onProgress?.({ phase: 'embed', done: Math.min(i + EMBED_CHUNK, pending.length), total: pending.length });
  }

  report.ghostPrompts = await embedGhostPrompts(db, embedOptions);

  report.ms = Date.now() - started;
  return report;
}

/**
 * The semantic half of the hybrid, for sessions whose transcript is gone.
 *
 * `03 §7` fuses five lists; a ghost could only ever appear in the two text
 * ones, because nothing embedded a recovered prompt. RRF adds nothing for a
 * list you are absent from, so a ghost collected two contributions where a live
 * session collected five, and phase 3 measured the consequence: every
 * ghost-only eval query fell out of the top five as soon as the vector lists
 * were switched on, and raising the vector weight pushed them further out.
 *
 * A prompt is embedded in the same shape as an exchange with no answer —
 * `exchangeText(text, '')` — so a ghost prompt and a live exchange land in the
 * same geometry and one query embedding ranks both. Failures are swallowed the
 * same way the exchange pass swallows them: the vectors that did get written
 * stay, and `find` keeps working on the text half.
 */
/**
 * Migration 8 declines on a machine without `sqlite-vec`, so the ghost vector
 * table may simply not be there; that is `--no-embed` for ghosts, not an error.
 */
function ghostVecTable(db: Db): boolean {
  return (
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vec_ghost_prompts'`)
        .get() as { n: number }
    ).n > 0
  );
}

/**
 * How many recovered prompts still want a vector — the question that decides
 * whether the embedding pass has work to do even when every exchange is
 * already current. Same predicate as the pass itself, so the two cannot
 * disagree about what "pending" means.
 */
function pendingGhostPrompts(db: Db): number {
  try {
    if (!ghostVecTable(db)) return 0;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ghost_prompts
          WHERE (embedding_version IS NULL OR embedding_version != ?)
            AND length(trim(text)) > 3`,
      )
      .get(EMBEDDING_VERSION) as { n: number };
    return row.n;
  } catch {
    // No `embedding_version` column yet, or no table at all. Nothing pending.
    return 0;
  }
}

async function embedGhostPrompts(
  db: Db,
  embedOptions: { cacheDir: string; onProgress?: (fraction: number) => void },
): Promise<number> {
  if (!ghostVecTable(db)) return 0;
  let pending: { id: string; text: string }[];
  try {
    pending = db
      .prepare(
        `SELECT id, text FROM ghost_prompts
          WHERE (embedding_version IS NULL OR embedding_version != ?)
            AND length(trim(text)) > 3
          ORDER BY rowid`,
      )
      .all(EMBEDDING_VERSION) as { id: string; text: string }[];
  } catch {
    return 0;
  }
  if (pending.length === 0) return 0;

  const dropVec = db.prepare('DELETE FROM vec_ghost_prompts WHERE id = ?');
  const insertVec = db.prepare('INSERT INTO vec_ghost_prompts (id, embedding) VALUES (?, ?)');
  const stamp = db.prepare('UPDATE ghost_prompts SET embedding_version = ? WHERE id = ?');
  let embedded = 0;
  for (let i = 0; i < pending.length; i += EMBED_CHUNK) {
    const chunk = pending.slice(i, i + EMBED_CHUNK);
    let vectors: number[][];
    try {
      vectors = [];
      for (const row of chunk) {
        vectors.push(await generateExchangeEmbedding(row.text, '', undefined, embedOptions));
      }
    } catch {
      // Same contract as the exchange pass: what was written stays, and the
      // text half of the search is unaffected.
      return embedded;
    }
    const write = db.transaction(() => {
      chunk.forEach((row, n) => {
        const vector = vectors[n];
        if (!vector) return;
        dropVec.run(row.id);
        insertVec.run(row.id, embeddingToBlob(vector));
        stamp.run(EMBEDDING_VERSION, row.id);
        embedded += 1;
      });
    });
    write();
  }

  return embedded;
}

/**
 * Record the types one session's parser did not consume.
 *
 * Written per session, replacing that session's rows, so re-reading a grown
 * transcript updates its own numbers and touches nobody else's. The previous
 * design kept one JSON blob per *run* in `sync_state`, and an incremental pass
 * that re-read a single file rewrote the whole harness's counts to whatever
 * that one file happened to contain: `queue-operation 10` became
 * `queue-operation 1`, and types absent from that file disappeared from
 * `doctor` altogether. Counts are a property of the corpus, so they are stored
 * against the corpus.
 */
function writeSessionRecordTypes(
  db: Db,
  sessionId: string,
  spec: AdapterSpec,
  version: string,
  unknownTypes: Readonly<Record<string, number>>,
): void {
  const write = db.transaction(() => {
    db.prepare('DELETE FROM session_record_types WHERE session_id = ?').run(sessionId);
    const insert = db.prepare(
      `INSERT INTO session_record_types (session_id, harness, version, type, count, novel)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, version, type) DO UPDATE SET count = excluded.count`,
    );
    for (const [type, count] of Object.entries(unknownTypes)) {
      insert.run(sessionId, spec.harness, version, type, count, spec.novel(type) ? 1 : 0);
    }
  });
  write();
}

/**
 * Every record type in the index right now, summed over every session that is
 * in it — not over whatever the last run happened to open.
 *
 * `files` is the number of transcripts the type appears in, which is why the
 * rows are grouped rather than summed in the caller.
 */
export function storedRecordTypes(db: Db): RecordTypeRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT harness, version, type,
                SUM(count) AS count, COUNT(*) AS files, MAX(novel) AS novel
           FROM session_record_types
          GROUP BY harness, version, type
          ORDER BY count DESC`,
      )
      .all() as { harness: Harness; version: string; type: string; count: number; files: number; novel: number }[];
    return rows.map((r) => ({
      harness: r.harness,
      version: r.version,
      type: r.type,
      count: r.count,
      files: r.files,
      novel: r.novel === 1,
    }));
  } catch {
    // A database from a potsherd older than migration 5. Say nothing rather
    // than say something wrong; the next `index` fills the table.
    return [];
  }
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((a, x) => a + f(x), 0);
}
