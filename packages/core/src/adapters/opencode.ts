/**
 * L0 adapter — opencode's sqlite session store.
 *
 *   ~/.local/share/opencode/**\/*.{db,sqlite,sqlite3}
 *
 * ## PROVENANCE — `unverified — documentation only`
 *
 * **Nothing here was measured against a real opencode store.**
 * `~/.local/share/opencode` does not exist on the reference machine — not
 * empty, absent — and `plans/research/formats.md` marks its opencode section
 * **unmeasured**: "none here, nothing has been parsed." This adapter is
 * therefore the same call phase 5 made for four unverified MCP clients:
 * written from documentation, exercised against synthetic fixtures, and
 * labelled as such in the file header, the doctor line and the doctor note.
 *
 * ## the schema is discovered, never hard-coded
 *
 * `03 §10`'s rule for bridges — *do not hard-code a schema you did not
 * write; discover it at runtime with `pragma table_info` and degrade on
 * mismatch* — is the load-bearing decision in this file, and it applies with
 * more force here than to a bridge, because opencode's store is one this
 * project has never seen. So:
 *
 *   - tables come from `sqlite_master`, columns from `pragma table_info`;
 *   - a column is found by matching the candidate names in {@link SESSION_COLUMNS}
 *     and {@link MESSAGE_COLUMNS} case-insensitively, so `sessionID`,
 *     `session_id` and `session` all resolve;
 *   - **every query is built from column names the database itself reported**,
 *     quoted, never from a string the caller supplied;
 *   - when the required columns are not all present, {@link describeStore}
 *     returns a `reason` and the adapter degrades to **unsupported version**.
 *     It does not throw, does not half-parse, and `doctor` prints the reason.
 *
 * Adding a candidate name to those lists can only make a store that was
 * unreadable readable. It can never change what an already-readable store
 * parses to, which is the property that makes widening the lists safe.
 *
 * ## the store is opened read-only
 *
 * `~/.local/share/opencode` is a **read-only input** (`00-README.md` ground
 * rules). The connection is opened `readonly: true`, and additionally with
 * `fileMustExist: true` so a typo in a path can never cause better-sqlite3 to
 * create a database inside another tool's directory. potsherd never writes a
 * byte under it.
 *
 * ## one database, many sessions
 *
 * Unlike every other harness potsherd reads, an opencode transcript is not a
 * file — one database holds every session. So `SessionSource.path` is the
 * database and `SessionSource.sessionId` is what distinguishes one source from
 * the next; `bytes` is the session's own content size rather than the file's,
 * because the file's size is a fact about all the sessions at once and would
 * make `counts.bytes` meaningless. There is no byte offset to resume from
 * inside a database, so `fromOffset` is accepted and deliberately ignored, as
 * it is for pi, and `endOffset` reports the session's content size. Exchange
 * ids are a pure function of `(sessionId, seq)`, so a re-parse is an upsert.
 *
 * ## a known other layout, deliberately not built
 *
 * Recent opencode versions are documented as keeping sessions as JSON under
 * `storage/session/`. That is a second layout, not a correction to this one,
 * and building it against no real files would be a second guess stacked on
 * the first. {@link describeStore} names it in the degrade reason when no
 * database is found but a `storage/` directory is, so the user learns that
 * potsherd saw their install and knows what it would take to read it.
 *
 * No model calls, no network (`03 §1`). This file is potsherd's own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openSqliteReadOnly, type Db } from '../db.js';

import type {
  Adapter,
  Exchange,
  FormatProvenance,
  ExchangeToolCall,
  ParseOptions,
  ParseResult,
  SessionRecord,
  SessionSource,
  SessionStatus,
} from './types.js';
import { opencodeDir } from '../paths.js';
import { formatDoctorLine } from '../doctor-line.js';
import {
  filesFromToolInput,
  isRecord,
  safeParseJson,
  stringifyToolInput,
  stringifyToolOutput,
  uniq,
} from '../parser/content.js';
import { exchangeId } from '../parser/claude.js';

export { opencodeDir } from '../paths.js';

export const DISPLAY_NAME = 'opencode';

/** File extensions treated as a candidate sqlite store. */
const DB_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];

/** How deep under the opencode directory `discover()` looks for a store. */
const MAX_DEPTH = 3;

/**
 * T6.6 D6 — the provenance, as a boolean rather than as prose.
 *
 * `OPENCODE_DOCTOR_NOTE` says this in a sentence, and `doctorLine()` says it
 * in a word — but the rendered line is clipped to the terminal's width, and
 * when the tool is **absent** it does not carry the word at all. Absent is
 * this adapter's state on every machine that does not have the tool. `doctor
 * --json` is the documented API, and an API cannot ask a caller to grep a
 * width-dependent sentence for an adjective. So the fact is a field.
 *
 * **Still `true` after T10.12, and the reason changed.** It no longer means
 * "written from documentation": a real 1.18.21 store was read. It means the
 * part of the format that carries the answer — `part.data` — has never been
 * read, which `T10.12-LABELS.md` §6 records as opencode keeping *a form of*
 * the label. Which part, and which parts are now verified right, is in
 * {@link OPENCODE_FORMAT_PROVENANCE}; a caller wanting more than one bit
 * reads that.
 */
export const OPENCODE_FORMAT_UNVERIFIED = true;

export const OPENCODE_DOCTOR_NOTE =
  'opencode: measured against opencode-ai 1.18.21 (T10.12, 24 aug 2026) — a real session was run ' +
  'and indexed, and the label splits in two. DISCOVERY AND SESSION METADATA ARE CORRECT: the ' +
  'store is at ~/.local/share/opencode/opencode.db exactly where this adapter looks, ' +
  'describeStore accepts it, and the session row parses with title, directory and both ' +
  'timestamps right. MESSAGE CONTENT IS NOT READ: at 1.18.21 the `message` table carries neither ' +
  'a role column nor a text column — the role is inside a `data` JSON blob, and the turn text is ' +
  'in the child `part` table, which this adapter does not join — so a real session indexes with ' +
  '0 prompts and its answer does not reach the index. Schema is still discovered at runtime ' +
  '(pragma table_info) rather than assumed, and an unrecognised store degrades to "unsupported ' +
  'version" rather than half-parsing. The database is opened read-only.';

/**
 * The split label as fields. See {@link FormatProvenance} for why a boolean
 * could not hold this any more.
 *
 * Every entry is from `phases/phase-10/T10.12-LABELS.md` §4, which recorded
 * the round trip: `opencode run "say hello"` under a relocated HOME, then
 * `potsherd index` and `potsherd ls` over what it wrote.
 */
export const OPENCODE_FORMAT_PROVENANCE: FormatProvenance = {
  measured: 'opencode-ai 1.18.21, 24 aug 2026',
  verified: ['store discovery', 'session metadata (title, directory, timestamps)'],
  wrong: ['message role — it is inside message.data, not a column', 'turn text — it is in part.data, which is not joined'],
  unverified: OPENCODE_FORMAT_UNVERIFIED,
  note: OPENCODE_DOCTOR_NOTE,
};

/**
 * Candidate column names, most specific first. The first name present in the
 * table wins, so a store carrying both `created_at` and `created` resolves
 * deterministically rather than by row order.
 */
const SESSION_COLUMNS = {
  id: ['id', 'session_id', 'sessionid', 'sessionID', 'uuid'],
  title: ['title', 'name', 'summary', 'label'],
  created: ['created_at', 'createdat', 'created', 'time_created', 'started_at', 'startedat'],
  updated: ['updated_at', 'updatedat', 'updated', 'time_updated', 'ended_at', 'endedat'],
  directory: ['directory', 'cwd', 'worktree', 'root', 'project', 'path'],
  parent: ['parent_id', 'parentid', 'parentID', 'parent_session_id', 'parent'],
  model: ['model', 'model_id', 'modelid'],
} as const;

const MESSAGE_COLUMNS = {
  id: ['id', 'message_id', 'messageid', 'uuid'],
  session: ['session_id', 'sessionid', 'sessionID', 'session'],
  role: ['role', 'type', 'kind', 'author'],
  content: ['content', 'parts', 'text', 'body', 'data', 'message'],
  created: ['created_at', 'createdat', 'created', 'time_created', 'timestamp', 'ts'],
} as const;

/** `role` values understood as a human prompt. */
const USER_ROLES = new Set(['user', 'human', 'prompt']);
/** `role` values understood as a model turn. */
const ASSISTANT_ROLES = new Set(['assistant', 'model', 'ai', 'agent']);

export function sourceDir(override?: string): string {
  return opencodeDir(override);
}

// ------------------------------------------------------- schema discovery

/** One resolved table: its name and the columns this adapter needs from it. */
export interface ResolvedTable {
  table: string;
  columns: Record<string, string | undefined>;
}

export interface StoreSchema {
  dbPath: string;
  sessions: ResolvedTable;
  messages: ResolvedTable;
}

export type StoreDescription =
  | { ok: true; schema: StoreSchema }
  | { ok: false; reason: string };

/** Every table name in the database, from `sqlite_master`. */
function tableNames(db: Db): string[] {
  try {
    const rows = db
      .prepare(`select name from sqlite_master where type in ('table','view')`)
      .all() as { name: string }[];
    return rows.map((r) => r.name).filter((n) => !n.startsWith('sqlite_'));
  } catch {
    return [];
  }
}

/** Column names of one table, from `pragma table_info` — never hard-coded. */
export function columnsOf(db: Db, table: string): string[] {
  try {
    const rows = db.pragma(`table_info(${quoteIdent(table)})`) as { name: string }[];
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/** Resolve one logical column to whatever this store actually calls it. */
function pick(present: readonly string[], candidates: readonly string[]): string | undefined {
  const lower = new Map(present.map((c) => [c.toLowerCase(), c]));
  for (const want of candidates) {
    const hit = lower.get(want.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Discover the store's shape, or say why it cannot be read. This is the whole
 * of `03 §10`'s rule in one function: nothing below it assumes a column name.
 *
 * The bar for "readable" is deliberately low — a session table with an id, and
 * a message table with a session reference and some content. A store that
 * clears it parses; a store that does not is reported as an unsupported
 * version with the reason, which is strictly more useful than a stack trace.
 */
export function describeStore(dbPath: string): StoreDescription {
  let db: Db;
  try {
    db = openSqliteReadOnly(dbPath);
  } catch (e) {
    return { ok: false, reason: `cannot open store read-only (${errText(e)})` };
  }
  try {
    const tables = tableNames(db);
    if (tables.length === 0) return { ok: false, reason: 'no tables in store' };

    const sessionTable = bestTable(tables, [/^sessions?$/i, /session/i]);
    if (!sessionTable) {
      return { ok: false, reason: `unsupported version — no session table (saw: ${tables.slice(0, 6).join(', ')})` };
    }
    const messageTable = bestTable(
      tables.filter((t) => t !== sessionTable),
      [/^messages?$/i, /message/i, /^parts?$/i, /part/i, /event/i],
    );
    if (!messageTable) {
      return { ok: false, reason: `unsupported version — no message table (saw: ${tables.slice(0, 6).join(', ')})` };
    }

    const sCols = columnsOf(db, sessionTable);
    const mCols = columnsOf(db, messageTable);

    const sessions: ResolvedTable = {
      table: sessionTable,
      columns: Object.fromEntries(
        Object.entries(SESSION_COLUMNS).map(([k, v]) => [k, pick(sCols, v)]),
      ),
    };
    const messages: ResolvedTable = {
      table: messageTable,
      columns: Object.fromEntries(
        Object.entries(MESSAGE_COLUMNS).map(([k, v]) => [k, pick(mCols, v)]),
      ),
    };

    if (!sessions.columns['id']) {
      return { ok: false, reason: `unsupported version — ${sessionTable} has no id column (saw: ${sCols.join(', ')})` };
    }
    if (!messages.columns['session']) {
      return { ok: false, reason: `unsupported version — ${messageTable} has no session column (saw: ${mCols.join(', ')})` };
    }
    if (!messages.columns['content']) {
      return { ok: false, reason: `unsupported version — ${messageTable} has no content column (saw: ${mCols.join(', ')})` };
    }
    return { ok: true, schema: { dbPath, sessions, messages } };
  } finally {
    db.close();
  }
}

/** First table matching the most specific pattern that matches anything. */
function bestTable(tables: readonly string[], patterns: readonly RegExp[]): string | undefined {
  for (const re of patterns) {
    const hit = tables.find((t) => re.test(t));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Quote an identifier for interpolation into SQL. Only ever applied to names
 * the **database itself** reported through `sqlite_master` / `pragma
 * table_info`, never to caller input — but quoted regardless, because a table
 * legitimately called `order` or containing a quote would otherwise produce a
 * syntax error that looked like an unsupported version.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ------------------------------------------------------------- discovery

/** Every candidate sqlite file under the opencode directory. */
export function findStores(override?: string): string[] {
  const root = sourceDir(override);
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (DB_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) out.push(full);
    }
  };
  walk(root, 0);
  out.sort();
  return out;
}

export function discover(override?: string): SessionSource[] {
  const out: SessionSource[] = [];
  for (const dbPath of findStores(override)) {
    const described = describeStore(dbPath);
    if (!described.ok) continue; // degrade quietly here; `doctor` says why
    out.push(...discoverIn(described.schema));
  }
  out.sort((a, b) =>
    a.path === b.path ? (a.sessionId < b.sessionId ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
  return out;
}

function discoverIn(schema: StoreSchema): SessionSource[] {
  const out: SessionSource[] = [];
  let db: Db;
  try {
    db = openSqliteReadOnly(schema.dbPath);
  } catch {
    return out;
  }
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(schema.dbPath).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  try {
    const c = schema.sessions.columns;
    const select = [
      `${quoteIdent(c['id']!)} as id`,
      c['directory'] ? `${quoteIdent(c['directory'])} as directory` : `null as directory`,
      c['parent'] ? `${quoteIdent(c['parent'])} as parent` : `null as parent`,
    ].join(', ');
    const rows = db
      .prepare(`select ${select} from ${quoteIdent(schema.sessions.table)}`)
      .all() as { id: unknown; directory: unknown; parent: unknown }[];

    // Message bytes per session, so `counts.bytes` is a fact about the
    // session rather than about every session sharing the file.
    const bytes = new Map<string, number>();
    const mc = schema.messages.columns;
    try {
      const byteRows = db
        .prepare(
          `select ${quoteIdent(mc['session']!)} as sid, ` +
            `sum(length(${quoteIdent(mc['content']!)})) as n ` +
            `from ${quoteIdent(schema.messages.table)} group by 1`,
        )
        .all() as { sid: unknown; n: unknown }[];
      for (const r of byteRows) bytes.set(String(r.sid), Number(r.n) || 0);
    } catch {
      // A content column of a type `length()` refuses is not fatal: the
      // session still indexes, with bytes unknown.
    }

    for (const r of rows) {
      const id = String(r.id ?? '');
      if (!id) continue;
      const directory = typeof r.directory === 'string' ? r.directory : '';
      const parent = typeof r.parent === 'string' && r.parent ? r.parent : undefined;
      out.push({
        sessionId: id,
        harness: 'opencode',
        path: schema.dbPath,
        projectSlug: directory ? path.basename(directory) : '',
        bytes: bytes.get(id) ?? 0,
        mtimeMs,
        // opencode's `parent_id` marks a child session — a subagent
        // transcript in `03 §2`'s sense — so it is a sidechain, and unlike a
        // pi branch the *session* itself is the sidechain.
        isSidechain: parent !== undefined,
        ...(parent ? { parentSessionId: parent } : {}),
        status: 'live',
      });
    }
  } catch {
    // A store that passed `describeStore` but fails to query is treated as
    // unsupported rather than fatal.
  } finally {
    db.close();
  }
  return out;
}

// ----------------------------------------------------------------- parse

export interface OpencodeParseOptions extends ParseOptions {
  status?: SessionStatus;
  bytes?: number;
}

export async function parse(
  source: SessionSource | string,
  options: OpencodeParseOptions = {},
): Promise<ParseResult> {
  const src: SessionSource | undefined = typeof source === 'string' ? undefined : source;
  const dbPath = path.resolve(typeof source === 'string' ? source : source.path);
  const sessionId = options.sessionId ?? src?.sessionId ?? '';

  const unknownTypes: Record<string, number> = {};
  const empty = (reason: string): ParseResult => {
    unknownTypes[reason] = (unknownTypes[reason] ?? 0) + 1;
    return {
      session: {
        id: sessionId,
        harness: 'opencode',
        sourcePath: dbPath,
        project: '',
        projectSlug: src?.projectSlug ?? '',
        startedAt: '',
        endedAt: '',
        entrypoint: 'cli',
        isSidechain: src?.isSidechain ?? false,
        counts: { userPrompts: 0, assistantTurns: 0, toolCalls: 0, bytes: 0 },
        status: options.status ?? src?.status ?? 'live',
      },
      exchanges: [],
      unknownTypes,
      endOffset: 0,
      malformedLines: 0,
    };
  };

  const described = describeStore(dbPath);
  if (!described.ok) return empty(described.reason);
  const schema = described.schema;
  if (!sessionId) return empty('no session id supplied');

  let db: Db;
  try {
    db = openSqliteReadOnly(dbPath);
  } catch (e) {
    return empty(`cannot open store read-only (${errText(e)})`);
  }

  try {
    const sc = schema.sessions.columns;
    const sSelect = [
      `${quoteIdent(sc['id']!)} as id`,
      col(sc['title'], 'title'),
      col(sc['created'], 'created'),
      col(sc['updated'], 'updated'),
      col(sc['directory'], 'directory'),
      col(sc['parent'], 'parent'),
      col(sc['model'], 'model'),
    ].join(', ');
    const sessionRow = db
      .prepare(
        `select ${sSelect} from ${quoteIdent(schema.sessions.table)} ` +
          `where ${quoteIdent(sc['id']!)} = ? limit 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;

    const mc = schema.messages.columns;
    const mSelect = [
      col(mc['id'], 'id'),
      col(mc['role'], 'role'),
      `${quoteIdent(mc['content']!)} as content`,
      col(mc['created'], 'created'),
    ].join(', ');
    // Ordered by the created column when there is one, then by rowid — which
    // every ordinary sqlite table has and which is insertion order. Never by
    // an assumed `id`: opencode's ids may or may not sort chronologically, and
    // ordering a transcript by a guess is how turns end up interleaved wrong.
    const orderBy = mc['created']
      ? `order by ${quoteIdent(mc['created'])} asc, rowid asc`
      : `order by rowid asc`;
    let messageRows: Record<string, unknown>[] = [];
    try {
      messageRows = db
        .prepare(
          `select ${mSelect} from ${quoteIdent(schema.messages.table)} ` +
            `where ${quoteIdent(mc['session']!)} = ? ${orderBy}`,
        )
        .all(sessionId) as Record<string, unknown>[];
    } catch {
      // A view without a rowid, most likely. Retry unordered rather than
      // losing the session entirely; the doctor note already warns that this
      // store's shape is unverified.
      try {
        messageRows = db
          .prepare(
            `select ${mSelect} from ${quoteIdent(schema.messages.table)} ` +
              `where ${quoteIdent(mc['session']!)} = ?`,
          )
          .all(sessionId) as Record<string, unknown>[];
      } catch {
        messageRows = [];
      }
    }

    const counts = { userPrompts: 0, assistantTurns: 0, toolCalls: 0 };
    let malformedLines = 0;
    const { exchanges, contentBytes, firstTs, lastTs, model: turnModel } = buildExchanges(
      messageRows,
      sessionId,
      counts,
      unknownTypes,
      () => {
        malformedLines += 1;
      },
    );

    const str = (key: string): string | undefined => {
      const v = sessionRow?.[key];
      return typeof v === 'string' && v.trim() ? v : undefined;
    };
    const directory = str('directory');
    const parent = str('parent');

    const session: SessionRecord = {
      id: sessionId,
      harness: 'opencode',
      sourcePath: dbPath,
      project: directory ?? '',
      projectSlug: options.projectSlug ?? src?.projectSlug ?? (directory ? path.basename(directory) : ''),
      startedAt: isoOf(sessionRow?.['created']) ?? firstTs ?? '',
      endedAt: isoOf(sessionRow?.['updated']) ?? lastTs ?? isoOf(sessionRow?.['created']) ?? '',
      ...(str('title') ? { title: str('title')! } : {}),
      entrypoint: 'cli',
      ...(str('model') ?? turnModel ? { model: (str('model') ?? turnModel)! } : {}),
      isSidechain: parent !== undefined || (src?.isSidechain ?? false),
      ...(parent ? { parentSessionId: parent } : {}),
      counts: {
        userPrompts: counts.userPrompts,
        assistantTurns: counts.assistantTurns,
        toolCalls: counts.toolCalls,
        bytes: options.bytes ?? src?.bytes ?? contentBytes,
      },
      status: options.status ?? src?.status ?? 'live',
    };

    return { session, exchanges, unknownTypes, endOffset: contentBytes, malformedLines };
  } finally {
    db.close();
  }
}

function col(name: string | undefined, alias: string): string {
  return name ? `${quoteIdent(name)} as ${alias}` : `null as ${alias}`;
}

/**
 * Message rows -> `Exchange[]`. An exchange opens on a user-role row and
 * absorbs every assistant row and tool part until the next one.
 */
function buildExchanges(
  rows: readonly Record<string, unknown>[],
  sessionId: string,
  counts: { userPrompts: number; assistantTurns: number; toolCalls: number },
  unknownTypes: Record<string, number>,
  onMalformed: () => void,
): {
  exchanges: Exchange[];
  contentBytes: number;
  firstTs?: string;
  lastTs?: string;
  model?: string;
} {
  const out: Exchange[] = [];
  let seq = 0;
  let contentBytes = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let model: string | undefined;

  let current: {
    seq: number;
    ts: string;
    userTexts: string[];
    assistantTexts: string[];
    toolCalls: ExchangeToolCall[];
    files: string[];
  } | null = null;

  const finalize = (): void => {
    if (!current) return;
    const b = current;
    current = null;
    if (!b.userTexts.length && !b.assistantTexts.length && !b.toolCalls.length) return;
    out.push({
      id: exchangeId(sessionId, b.seq),
      sessionId,
      seq: b.seq,
      ts: b.ts,
      userText: b.userTexts.join('\n\n'),
      assistantText: b.assistantTexts.join('\n\n'),
      toolCalls: b.toolCalls,
      filesTouched: uniq(b.files),
      isSidechain: false,
      redacted: false,
    });
  };

  const open = (ts: string) => {
    seq += 1;
    current = { seq, ts, userTexts: [], assistantTexts: [], toolCalls: [], files: [] };
    return current;
  };

  for (const row of rows) {
    const raw = row['content'];
    const text = raw === null || raw === undefined ? '' : String(raw);
    contentBytes += Buffer.byteLength(text, 'utf8');

    const ts = isoOf(row['created']) ?? '';
    if (ts) {
      firstTs ??= ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    const role = String(row['role'] ?? '').toLowerCase();
    const parsed = parseContent(text, unknownTypes, onMalformed);
    if (parsed.model) model = parsed.model;

    if (USER_ROLES.has(role)) {
      finalize();
      counts.userPrompts += 1;
      const b = open(ts);
      if (parsed.text) b.userTexts.push(parsed.text);
      absorbTools(b, parsed, counts);
      continue;
    }

    const b = current ?? open(ts);
    if (ASSISTANT_ROLES.has(role)) {
      counts.assistantTurns += 1;
    } else {
      // A role this adapter does not classify — counted, never dropped. Its
      // text still lands on the assistant side so nothing is lost silently.
      const key = `role:${role || '(no role)'}`;
      unknownTypes[key] = (unknownTypes[key] ?? 0) + 1;
    }
    if (parsed.text) b.assistantTexts.push(parsed.text);
    absorbTools(b, parsed, counts);
  }

  finalize();
  return {
    exchanges: out,
    contentBytes,
    ...(firstTs ? { firstTs } : {}),
    ...(lastTs ? { lastTs } : {}),
    ...(model ? { model } : {}),
  };
}

function absorbTools(
  b: { toolCalls: ExchangeToolCall[]; files: string[] },
  parsed: ParsedContent,
  counts: { toolCalls: number },
): void {
  for (const call of parsed.toolCalls) {
    b.toolCalls.push(call.call);
    counts.toolCalls += 1;
    for (const f of call.files) b.files.push(f);
  }
}

interface ParsedContent {
  text: string;
  toolCalls: { call: ExchangeToolCall; files: string[] }[];
  model?: string;
}

/**
 * A message's content column, which may be plain text or a JSON parts array.
 * Both are handled: if it parses as JSON and looks like parts, the parts are
 * walked; otherwise the column is taken as prose, which is the safe default
 * for a schema nobody here has seen.
 */
export function parseContent(
  raw: string,
  unknownTypes: Record<string, number>,
  onMalformed: () => void,
): ParsedContent {
  const trimmed = raw.trim();
  const out: ParsedContent = { text: raw, toolCalls: [] };
  if (!trimmed || (trimmed[0] !== '[' && trimmed[0] !== '{')) return out;

  // `safeParseJson` signals failure by returning **its own input**, not
  // `undefined` (see `parser/content.ts`). That is only distinguishable from
  // success because we got here at all: the guard above means `trimmed` starts
  // with `[` or `{`, and no valid JSON document beginning with either can
  // parse to a string. So a string result here means the parse failed.
  const doc = safeParseJson(trimmed);
  if (typeof doc === 'string') {
    // Looked like JSON and was not. Counted as malformed, and the raw string
    // is still kept as prose rather than the message vanishing.
    onMalformed();
    return out;
  }

  const parts: unknown[] = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc['parts'])
      ? (doc['parts'] as unknown[])
      : isRecord(doc) && Array.isArray(doc['content'])
        ? (doc['content'] as unknown[])
        : [];
  if (parts.length === 0) {
    if (isRecord(doc) && typeof doc['text'] === 'string') {
      out.text = doc['text'];
      if (typeof doc['model'] === 'string') out.model = doc['model'];
      return out;
    }
    return out;
  }

  const texts: string[] = [];
  if (isRecord(doc) && typeof doc['model'] === 'string') out.model = doc['model'];

  for (const p of parts) {
    if (typeof p === 'string') {
      texts.push(p);
      continue;
    }
    if (!isRecord(p)) continue;
    const type = String(p['type'] ?? '').toLowerCase();
    if (type === 'text' || (!type && typeof p['text'] === 'string')) {
      if (typeof p['text'] === 'string') texts.push(p['text']);
      continue;
    }
    if (type === 'tool' || type === 'tool-invocation' || type === 'tool_use' || type === 'tool-call') {
      const state = isRecord(p['state']) ? p['state'] : {};
      const name = String(p['tool'] ?? p['name'] ?? state['tool'] ?? 'unknown');
      const input = state['input'] ?? p['input'] ?? p['args'] ?? p['arguments'];
      const output = state['output'] ?? p['output'] ?? p['result'];
      const status = String(state['status'] ?? p['status'] ?? '').toLowerCase();
      const result = stringifyToolOutput(output);
      const call: ExchangeToolCall = {
        name,
        input: stringifyToolInput(input),
        ...(result !== undefined ? { result } : {}),
        ...(status === 'error' || status === 'failed' ? { isError: true } : {}),
      };
      out.toolCalls.push({ call, files: filesFromToolInput(input) });
      continue;
    }
    // `reasoning`, `file`, `step-start`, `snapshot`, `patch` … — every part
    // type this parser does not render is counted so `doctor` shows exactly
    // what coverage is missing (`03 §2`).
    const key = `part:${type || '(no type)'}`;
    unknownTypes[key] = (unknownTypes[key] ?? 0) + 1;
  }

  out.text = texts.join('\n\n');
  return out;
}

/**
 * A timestamp column may be ISO text or epoch milliseconds (or seconds).
 * Anything else yields `undefined` rather than an `Invalid Date` string.
 */
export function isoOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Below ~1e11 the value cannot be milliseconds since 1970 for any date
    // after 1973, so it is seconds.
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && /^\d+$/.test(value.trim())) return isoOf(n);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The `doctor` line for opencode. Four states, each said plainly, because
 * "0 sessions" alone cannot distinguish them:
 *
 *   absent       the directory does not exist — opencode is not installed
 *   empty        installed, but no store, or a store with no sessions
 *   unsupported  a store is there and its schema is not one we can read
 *   ready        parsed
 */
export function doctorLine(override?: string): string {
  const dir = sourceDir(override);
  const installed = fs.existsSync(dir);
  if (!installed) {
    return formatDoctorLine({
      harness: 'opencode',
      status: 'absent',
      dir,
      note: 'opencode not installed',
    });
  }

  const stores = findStores(override);
  if (stores.length === 0) {
    const hasStorage = fs.existsSync(path.join(dir, 'storage'));
    return formatDoctorLine({
      harness: 'opencode',
      status: 'empty',
      dir,
      note: hasStorage
        ? 'opencode installed, no sqlite store — this install uses storage/ json, which potsherd does not read yet'
        : 'opencode installed, no sessions yet',
    });
  }

  const failures: string[] = [];
  let sessions = 0;
  let readable = 0;
  for (const store of stores) {
    const described = describeStore(store);
    if (!described.ok) {
      failures.push(described.reason);
      continue;
    }
    readable += 1;
    try {
      sessions += discoverIn(described.schema).length;
    } catch {
      /* counted as readable-but-empty */
    }
  }

  if (readable === 0) {
    return formatDoctorLine({
      harness: 'opencode',
      status: 'unsupported',
      dir,
      note: `${failures[0] ?? 'unsupported version'} · schema not recognised`,
    });
  }
  if (sessions === 0) {
    return formatDoctorLine({
      harness: 'opencode',
      status: 'empty',
      dir,
      note: 'opencode installed, store readable, no sessions yet',
    });
  }
  const note = [`${sessions} session${sessions === 1 ? '' : 's'}`];
  if (failures.length) note.push(`${failures.length} store${failures.length === 1 ? '' : 's'} unsupported`);
  // The measurement, not a state of ignorance: T10.12 ran a real 1.18.21
  // session through this path and the prompts came out empty.
  note.push('content unread at 1.18.21 — text is in part.data');
  return formatDoctorLine({
    harness: 'opencode',
    status: 'ready',
    dir,
    note: note.join(' · '),
  });
}

/** The adapter, as `doctor` / `index` / `stats` consume it. */
export const opencodeAdapter: Adapter = {
  harness: 'opencode',
  displayName: DISPLAY_NAME,
  sourceDir: () => sourceDir(),
  discover: () => discover(),
  parse: (src, opts) => parse(src, opts ?? {}),
};

export default opencodeAdapter;
