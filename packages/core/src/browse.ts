import type { Db } from './db.js';
import type { Harness, SessionStatus } from './adapters/types.js';
import { buildGhostFilters, buildSessionFilters, type SearchFilters } from './search/filters.js';
import { applyIgnore, type IgnoreReport } from './ignore.js';
import { tagsForSessions } from './tags.js';
import { readCard, type StoredCard } from './cards/write.js';
import {
  fromGhostRow,
  fromSessionRow,
  type GhostRow,
  type RecallSession,
  type SessionRow,
} from './recall.js';

/**
 * The browse side of L6: `ls` and `show`.
 *
 * `find` answers "where did I say this"; these two answer "what is in there at
 * all". They share `find`'s vocabulary deliberately — the same
 * {@link SearchFilters}, the same session shape, the same `<slug>-<id8>`
 * fallback title — so that `potsherd ls --project X` and
 * `potsherd find q --project X` can never disagree about what X contains.
 *
 * **Ghosts are rows here, not a footnote.** A deleted session has no row in
 * `sessions`; it lives in `ghosts` with its prompts and nothing else. `ls`
 * unions the two tables and sorts them together, because from the user's side
 * they are one archive with a hole in it, and the hole is the point.
 */

// `calibration`/`confidence` are `find`'s second axis and are computed against
// a *query*; `ls` has none, so a browse row carries the session's metadata and
// not the fields that only mean something inside a search. T10.1.
export interface BrowseSession
  extends Omit<RecallSession, 'score' | 'hits' | 'calibration' | 'confidence'> {
  /**
   * The card's title, when `potsherd card` has written one.
   *
   * A card title beats a harness title everywhere a session is listed
   * (`phase-2` T2.4): the harness's is a summary of the first prompt, the
   * card's is a summary of the session. `title` and `displayTitle` already
   * carry the winner — this field says which one won, so `--json` can tell
   * them apart and a later `card --force` can be judged against it.
   */
  cardTitle: string | null;
  /**
   * `cards.source`: what the card was written from — `transcript`, or
   * `prompts-only` for a ghost card (`phase-2` T2.3).
   *
   * It exists because {@link cardTitle} is otherwise indistinguishable from a
   * full session's. On the reference machine 299 of 330 sessions are ghosts,
   * so most rows in a real `ls` carry a title written from one half of a
   * conversation, and a listing that did not say so would be quietly claiming
   * more than it knows.
   */
  cardSource: string | null;
  /** The user's own tags, sorted. Empty until `potsherd tag` writes one. */
  tags: string[];
}

// ------------------------------------------------------------------- ls

export interface ListOptions {
  /** Rows to return. Default 20. */
  limit?: number;
  offset?: number;
  /**
   * `ls --all`: show the projects the ignore list hides.
   *
   * The list is still read and still reported, so `--all` says "13 rows you
   * normally do not see" rather than silently becoming a different command.
   */
  all?: boolean;
  /** potsherd root, for `config.json`. Defaults to the database's directory. */
  root?: string;
  /** The ignore list, instead of reading it. Tests, and callers that cached it. */
  ignore?: readonly string[];
}

export interface ListResult {
  sessions: BrowseSession[];
  /** Rows the filters match, before `limit`. */
  total: number;
  /** Of `total`, how many are ghosts — the line `ls` prints under the table. */
  ghosts: number;
  /** Sidechains that matched but are shown as a `↳n` on their parent's row. */
  rolledUp: number;
  /** Sidechains listed as rows of their own. */
  sidechains: number;
  /**
   * The ignore list and what it cost this listing.
   *
   * `hidden` is the number of rows that matched every other filter and were
   * dropped for their project alone. `renderLs` prints it, and it is in
   * `--json`, because a listing that quietly drops a third of the archive is
   * lying about the archive. 0 with an empty `entries` is the normal case and
   * prints nothing.
   */
  ignored: IgnoreReport;
  filters: SearchFilters;
}

/**
 * Subagent transcripts roll up under their parent instead of taking a row.
 *
 * They are *indexed* and *searchable* by default — that is the whole sidechain
 * fix, and `find` returns them. But a list is a different question: 197 of the
 * 236 transcripts on the reference machine are subagents of three sessions, and
 * listing them flat turns `ls` into the uuid dump it exists to replace. So the
 * parent's row carries `↳197` and one flag (`--sidechains only`) opens them.
 *
 * A sidechain whose parent is *not* in the index still gets its own row: it is
 * nobody's child here, and silently dropping it would be hiding work.
 */
const ROLLUP = `AND (s.is_sidechain = 0
       OR s.parent_session_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_session_id))`;

const SESSION_COLUMNS = `s.id, s.harness, s.title, s.project, s.started_at, s.ended_at, s.status,
       s.is_sidechain, s.parent_session_id, s.agent_name, s.git_branch,
       s.user_prompts, s.assistant_turns, s.bytes,
       (SELECT COUNT(*) FROM exchanges e WHERE e.session_id = s.id) AS exchanges,
       (SELECT COUNT(*) FROM sessions c WHERE c.parent_session_id = s.id) AS subagents,
       (SELECT COUNT(*) FROM pins p WHERE p.session_id = s.id) AS pinned,
       (SELECT c.title FROM cards c WHERE c.session_id = s.id) AS card_title,
       (SELECT c.source FROM cards c WHERE c.session_id = s.id) AS card_source`;

const GHOST_COLUMNS = `g.session_id, g.harness, g.title, g.first_prompt, g.project,
       g.first_ts, g.last_ts, g.prompt_count, g.git_branch,
       (SELECT p.text FROM ghost_prompts p WHERE p.session_id = g.session_id
          AND p.text NOT LIKE '/%' AND length(trim(p.text)) > 3
        ORDER BY p.seq LIMIT 1) AS best_prompt,
       (SELECT COUNT(*) FROM pins p WHERE p.session_id = g.session_id) AS pinned,
       (SELECT c.title FROM cards c WHERE c.session_id = g.session_id) AS card_title,
       (SELECT c.source FROM cards c WHERE c.session_id = g.session_id) AS card_source`;

/**
 * The two column lists above select two fields `recall.ts` does not know
 * about, so the row types are widened here rather than there: `recall` is the
 * search path and has no business growing card columns for `ls`'s sake.
 */
type CardColumns = { card_title: string | null; card_source: string | null };
type SessionRowPlus = SessionRow & CardColumns;
type GhostRowPlus = GhostRow & CardColumns;

/**
 * Card title beats harness title, everywhere a session is listed.
 *
 * The harness's title is a summary of the opening prompt written before the
 * session happened; the card's is a summary of what the session turned out to
 * be.
 *
 * `cardSource` rides along because it is the caveat on the title it replaced:
 * a `prompts-only` title was written without the assistant's half of the
 * conversation, and every surface that shows the title has to be able to say
 * so.
 */
function withCardTitle(
  s: Omit<BrowseSession, 'cardTitle' | 'cardSource' | 'tags'>,
  card: Partial<CardColumns> | null | undefined,
): BrowseSession {
  const clean = card?.card_title?.replace(/\s+/g, ' ').trim();
  const source = card?.card_source?.trim() || null;
  if (!clean) return { ...s, cardTitle: null, cardSource: source, tags: [] };
  return { ...s, title: clean, displayTitle: clean, cardTitle: clean, cardSource: source, tags: [] };
}

/**
 * Hang the user's own tags on a page of rows, in one query.
 *
 * Done after the page is cut, not before: `ls` reads at most a screenful and
 * tagging the whole candidate set would be work thrown away.
 */
function withTags(db: Db, rows: BrowseSession[]): BrowseSession[] {
  if (rows.length === 0) return rows;
  const tags = tagsForSessions(db, rows.map((r) => r.id));
  for (const row of rows) row.tags = tags.get(row.id) ?? [];
  return rows;
}

/** True when the filters can be satisfied by a ghost at all. */
function ghostsInScope(filters: SearchFilters): boolean {
  if (filters.status === 'ghost') return true;
  if ((filters.ghosts ?? 'include') === 'exclude') return false;
  // A ghost has no assistant side, no subagents and no recorded file edits, so
  // any filter that asks about one excludes every ghost by construction.
  if ((filters.sidechains ?? 'include') === 'only') return false;
  if (filters.file) return false;
  if (filters.status) return false;
  return true;
}

function sessionsInScope(filters: SearchFilters): boolean {
  if (filters.status === 'ghost') return false;
  return (filters.ghosts ?? 'include') !== 'only';
}

/** `potsherd ls` — newest first, titles not uuids, ghosts in line with the rest. */
export function listSessions(
  db: Db,
  requested: SearchFilters = {},
  options: ListOptions = {},
): ListResult {
  const limit = Math.max(1, options.limit ?? 20);
  const offset = Math.max(0, options.offset ?? 0);
  const want = limit + offset;

  // The ignore list is folded in here rather than by every caller, so `ls`
  // through the CLI, through the MCP server and through a script all hide the
  // same rows — and so a caller cannot forget. `--all` arrives as
  // `options.all` and simply does not apply it.
  const ignore = applyIgnore(db, requested, {
    ...(options.all !== undefined ? { all: options.all } : {}),
    ...(options.root !== undefined ? { root: options.root } : {}),
    ...(options.ignore !== undefined ? { entries: options.ignore } : {}),
  });
  const filters = ignore.filters;
  let hidden = 0;

  const rows: BrowseSession[] = [];
  let total = 0;
  let ghosts = 0;
  let sidechains = 0;
  let rolledUp = 0;

  if (sessionsInScope(filters)) {
    const f = buildSessionFilters(filters);
    const rollup = (filters.sidechains ?? 'include') === 'include' ? ROLLUP : '';
    // `want` rather than `limit`: each table is cut at the depth the merge
    // could possibly need, and the merge cuts again.
    const found = db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions s WHERE 1=1 ${f.sql} ${rollup}
          ORDER BY COALESCE(s.ended_at, s.started_at) DESC, s.id
          LIMIT ?`,
      )
      .all(...f.params, want) as SessionRowPlus[];
    for (const r of found) rows.push(withCardTitle(fromSessionRow(r), r));

    const counted = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(s.is_sidechain), 0) AS sidechains
           FROM sessions s WHERE 1=1 ${f.sql} ${rollup}`,
      )
      .get(...f.params) as { n: number; sidechains: number };
    total += counted.n;
    sidechains = counted.sidechains;
    hidden += countHidden(db, filters, ignore.applied, rollup, 'sessions', counted.n);

    if (rollup) {
      rolledUp = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM sessions s WHERE 1=1 ${f.sql}`)
          .get(...f.params) as { n: number }
      ).n - counted.n;
    }
  }

  if (ghostsInScope(filters)) {
    const f = buildGhostFilters(filters);
    const found = db
      .prepare(
        `SELECT ${GHOST_COLUMNS} FROM ghosts g WHERE 1=1 ${f.sql}
          ORDER BY COALESCE(g.last_ts, g.first_ts) DESC, g.session_id
          LIMIT ?`,
      )
      .all(...f.params, want) as GhostRowPlus[];
    for (const r of found) rows.push(withCardTitle(fromGhostRow(r), r));

    const counted = db
      .prepare(`SELECT COUNT(*) AS n FROM ghosts g WHERE 1=1 ${f.sql}`)
      .get(...f.params) as { n: number };
    total += counted.n;
    ghosts = counted.n;
    hidden += countHidden(db, filters, ignore.applied, '', 'ghosts', counted.n);
  }

  rows.sort((a, b) => when(b).localeCompare(when(a)) || a.id.localeCompare(b.id));
  return {
    sessions: withTags(db, rows.slice(offset, offset + limit)),
    total,
    ghosts,
    rolledUp,
    sidechains,
    ignored: { entries: ignore.entries, projects: ignore.projects, hidden },
    filters,
  };
}

/**
 * How many rows the ignore list cost *this* listing.
 *
 * Counted as the difference between the same query with and without the
 * exclusion, so it is the rows that matched every other filter and were
 * dropped for their project alone — not the size of the ignored projects,
 * which under `--since 7d` would be a much larger and quite untrue number.
 */
function countHidden(
  db: Db,
  filters: SearchFilters,
  applied: boolean,
  rollup: string,
  table: 'sessions' | 'ghosts',
  shown: number,
): number {
  if (!applied) return 0;
  const open: SearchFilters = { ...filters };
  delete open.excludeProjects;
  const f = table === 'sessions' ? buildSessionFilters(open) : buildGhostFilters(open);
  const sql =
    table === 'sessions'
      ? `SELECT COUNT(*) AS n FROM sessions s WHERE 1=1 ${f.sql} ${rollup}`
      : `SELECT COUNT(*) AS n FROM ghosts g WHERE 1=1 ${f.sql}`;
  const all = (db.prepare(sql).get(...f.params) as { n: number }).n;
  return Math.max(0, all - shown);
}

function when(s: BrowseSession): string {
  return s.endedAt ?? s.startedAt ?? '';
}

// ----------------------------------------------------------------- show

export interface SessionCandidate {
  id: string;
  kind: 'session' | 'ghost';
  title: string;
  project: string | null;
  when: string | null;
  isSidechain: boolean;
}

export interface ResolvedSession {
  id: string;
  kind: 'session' | 'ghost';
  /** Set when the reference matched more than one session it could mean. */
  ambiguous?: SessionCandidate[];
}

/**
 * Turn what the user typed into one session id.
 *
 * A full id resolves exactly. Anything shorter is a prefix, then — if that
 * finds nothing — a substring, which is how a subagent is addressable at all:
 * its id is `<parent-uuid>:agent-<hash>` and the eight characters `find` and
 * `ls` print for it come from the *right* half.
 *
 * Two rules that matter more than they look:
 *
 * **A parent wins over its own subagents.** `4c9339e0` is a prefix of one
 * session and of the 32 subagent transcripts it spawned, because their ids all
 * start with its uuid. Calling that ambiguous would make every session with
 * subagents unshowable. The conversation is what the user meant.
 *
 * **Anything still ambiguous lists the candidates rather than guessing.**
 * Showing someone the wrong conversation, confidently, is the one failure mode
 * a memory tool cannot recover from.
 */
export function resolveSession(db: Db, ref: string): ResolvedSession | null {
  const needle = ref.trim();
  if (!needle) return null;

  const exact = db.prepare('SELECT id FROM sessions WHERE id = ?').get(needle) as
    | { id: string }
    | undefined;
  if (exact) return { id: exact.id, kind: 'session' };
  const exactGhost = db.prepare('SELECT session_id FROM ghosts WHERE session_id = ?').get(needle) as
    | { session_id: string }
    | undefined;
  if (exactGhost) return { id: exactGhost.session_id, kind: 'ghost' };

  // `_` and `%` in a reference would otherwise be LIKE wildcards. Session ids
  // are uuids today, but the adapters do not promise it.
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  let candidates = matching(db, `${escaped}%`);
  if (candidates.length === 0) candidates = matching(db, `%${escaped}%`);
  if (candidates.length === 0) return null;

  const first = candidates[0]!;
  if (candidates.length === 1) return { id: first.id, kind: first.kind };

  const topLevel = candidates.filter((c) => !c.isSidechain);
  if (topLevel.length === 1) return { id: topLevel[0]!.id, kind: topLevel[0]!.kind };

  const pick = topLevel.length > 0 ? topLevel : candidates;
  return { id: pick[0]!.id, kind: pick[0]!.kind, ambiguous: pick };
}

function matching(db: Db, pattern: string): SessionCandidate[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id, 'session' AS kind, s.title AS title, s.project AS project,
              s.is_sidechain AS is_sidechain,
              COALESCE(s.ended_at, s.started_at) AS when_
         FROM sessions s WHERE s.id LIKE ? ESCAPE '\\'
       UNION ALL
       SELECT g.session_id AS id, 'ghost' AS kind,
              COALESCE(g.title, g.first_prompt) AS title, g.project AS project,
              0 AS is_sidechain,
              COALESCE(g.last_ts, g.first_ts) AS when_
         FROM ghosts g WHERE g.session_id LIKE ? ESCAPE '\\'
       ORDER BY is_sidechain, when_ DESC LIMIT 25`,
    )
    .all(pattern, pattern) as {
    id: string;
    kind: 'session' | 'ghost';
    title: string | null;
    project: string | null;
    is_sidechain: number;
    when_: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title ?? '',
    project: r.project,
    when: r.when_,
    isSidechain: r.is_sidechain === 1,
  }));
}

export interface ShownExchange {
  id: string;
  seq: number;
  ts: string | null;
  userText: string;
  assistantText: string;
  filesTouched: string[];
  toolCalls: { name: string; isError: boolean }[];
  isSidechain: boolean;
  redacted: boolean;
}

export interface ShowResult {
  session: BrowseSession;
  /** 1-based, inclusive, as `--from`/`--to` are. */
  from: number;
  to: number;
  /** Exchanges (or ghost prompts) the session holds in total. */
  total: number;
  exchanges: ShownExchange[];
  /** A ghost has prompts and no assistant side. Present only for ghosts. */
  ghostPrompts?: { seq: number; ts: string | null; text: string }[];
  /** Sidechains that name this session as their parent. */
  children: { id: string; agentName: string | null; exchanges: number }[];
  /**
   * The whole card, when this session has one (T2.7 D3).
   *
   * Until T2.7 `show` carried only `cardTitle` and `cardSource`, so the card —
   * this phase's central artifact — was readable through the markdown mirror
   * or a SQL client and nowhere else. The card is what a returning reader came
   * for; the transcript is what they read if the card does not answer them.
   */
  card: StoredCard | null;
}

export interface ShowOptions {
  from?: number;
  to?: number;
}

export function showSession(db: Db, id: string, options: ShowOptions = {}): ShowResult | null {
  const sessionRow = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.id = ?`)
    .get(id) as SessionRowPlus | undefined;

  if (sessionRow) {
    const session = withTags(db, [withCardTitle(fromSessionRow(sessionRow), sessionRow)])[0]!;
    const total = session.exchanges;
    const { from, to } = window(total, options);
    const rows = db
      .prepare(
        `SELECT id, seq, ts, user_text, assistant_text, files_touched, is_sidechain, redacted
           FROM exchanges WHERE session_id = ? ORDER BY seq LIMIT ? OFFSET ?`,
      )
      .all(id, Math.max(0, to - from + 1), Math.max(0, from - 1)) as {
      id: string;
      seq: number;
      ts: string | null;
      user_text: string;
      assistant_text: string;
      files_touched: string;
      is_sidechain: number;
      redacted: number;
    }[];

    const tools = db.prepare(
      'SELECT name, is_error FROM tool_calls WHERE exchange_id = ? ORDER BY rowid',
    );
    const exchanges: ShownExchange[] = rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      ts: r.ts,
      userText: r.user_text,
      assistantText: r.assistant_text,
      filesTouched: parseFiles(r.files_touched),
      toolCalls: (tools.all(r.id) as { name: string | null; is_error: number }[]).map((t) => ({
        name: t.name ?? '?',
        isError: t.is_error === 1,
      })),
      isSidechain: r.is_sidechain === 1,
      redacted: r.redacted === 1,
    }));

    const children = db
      .prepare(
        `SELECT s.id AS id, s.agent_name AS agent_name,
                (SELECT COUNT(*) FROM exchanges e WHERE e.session_id = s.id) AS exchanges
           FROM sessions s WHERE s.parent_session_id = ? ORDER BY s.started_at LIMIT 50`,
      )
      .all(id) as { id: string; agent_name: string | null; exchanges: number }[];

    return {
      session,
      from,
      to,
      total,
      exchanges,
      children: children.map((c) => ({
        id: c.id,
        agentName: c.agent_name,
        exchanges: c.exchanges,
      })),
      card: readCard(db, id),
    };
  }

  const ghostRow = db
    .prepare(`SELECT ${GHOST_COLUMNS} FROM ghosts g WHERE g.session_id = ?`)
    .get(id) as GhostRowPlus | undefined;
  if (!ghostRow) return null;

  const session = withTags(db, [withCardTitle(fromGhostRow(ghostRow), ghostRow)])[0]!;
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM ghost_prompts WHERE session_id = ?').get(id) as {
      n: number;
    }
  ).n;
  const { from, to } = window(total, options);
  const prompts = db
    .prepare(
      'SELECT seq, ts, text FROM ghost_prompts WHERE session_id = ? ORDER BY seq LIMIT ? OFFSET ?',
    )
    .all(id, Math.max(0, to - from + 1), Math.max(0, from - 1)) as {
    seq: number;
    ts: string | null;
    text: string;
  }[];

  return {
    session,
    from,
    to,
    total,
    exchanges: [],
    ghostPrompts: prompts,
    children: [],
    card: readCard(db, id),
  };
}

function window(total: number, o: ShowOptions): { from: number; to: number } {
  const from = Math.max(1, Math.floor(o.from ?? 1));
  const to = Math.min(Math.max(total, from), Math.floor(o.to ?? total));
  return { from, to };
}

function parseFiles(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Re-exported so a caller can type a row without reaching into `recall`. */
export type { Harness, SessionStatus };
