import type { Harness, SessionStatus } from '../adapters/types.js';
import { LINKED_TO_SQL } from '../tags.js';

/**
 * Search filters and the bound-parameter builder for them.
 *
 * Adapted from obra/episodic-memory@1075769 `src/search.ts`
 * (MIT, (c) 2025 Jesse Vincent) — `buildSearchFilters` and `validateISODate`.
 * The pattern taken is the important part: filters become `?` placeholders
 * with a parallel params array, so no user input is ever concatenated into
 * SQL. Upstream has a test for exactly that and it should stay true here.
 *
 * Two things changed. The column names are potsherd's (`03` §3: `e.ts`,
 * `s.project`, `s.git_branch` — session metadata lives on `sessions`, not
 * denormalised onto every exchange). And the filter set is `03` §7's, which
 * adds `harness`, `sidechains`, `ghosts`, `tag`, `file` and `pinned`.
 *
 * **The sidechain change.** Upstream hard-codes `AND e.is_sidechain = 0` at
 * `src/search.ts:165` and `:188`, so a subagent's work is indexed and then
 * never returned. potsherd defaults `sidechains` to `include`, which is the
 * whole reason `197` subagent transcripts on the reference machine stop being
 * invisible. The generic version of that fix is prepared as an upstream pull
 * request in `docs/upstream/PR-sidechain-flag.md`.
 *
 * T1.5 builds `find` on top of this; nothing calls it yet.
 */

export type TriState = 'include' | 'only' | 'exclude';

export interface SearchFilters {
  project?: string;
  harness?: Harness;
  /** ISO date or datetime, inclusive. */
  since?: string;
  until?: string;
  tag?: string;
  branch?: string;
  /**
   * A path, a fragment of one, or a pattern: matched against the **elements**
   * of `exchanges.files_touched`, which is a JSON array. `%` and `*` are
   * wildcards; a value with neither is matched as a substring. See
   * {@link FILE_TOUCHED_SQL}.
   */
  file?: string;
  /** Default `include` — the opposite of upstream's hard-coded exclusion. */
  sidechains?: TriState;
  ghosts?: TriState;
  pinned?: boolean;
  /**
   * Sessions the user linked to this one, **from either side of the link**.
   * `links` stores the pair as it was typed; meaning is undirected. See
   * `tags.ts`'s `LINKED_TO_SQL`, which is the only place that knows the OR.
   */
  linkedTo?: string;
  /**
   * Sessions with nothing but their id to call them by: no card title, and no
   * title from the harness. The Claude Agent SDK writes transcripts with no
   * summary at all, so these are the sessions `potsherd card` should be
   * pointed at first — which is what this filter is for (`phase-2` T2.4).
   */
  untitled?: boolean;
  sessionId?: string;
  /**
   * `live` (transcript still where the harness put it), `archived` (potsherd
   * holds the only copy) or `ghost` (prompts only, rebuilt from history).
   * A ghost has no row in `sessions`, so `status: 'ghost'` is the caller's cue
   * to run the ghost lists alone — see `buildGhostFilters`.
   */
  status?: SessionStatus;
  /**
   * Projects to leave out, as **exact `project` values**, already resolved
   * from the user's ignore list (`ignore.ts`). It is a filter and not a
   * special case: `ls`, `find`, `ask` and `stats` all AND it in beside
   * `--project` and `--since` and get one consistent answer, and `--all`
   * simply does not set it.
   *
   * Exact values rather than the patterns the user typed, because the ignore
   * rule is about paths (`potsherd` matches every segment called `potsherd`)
   * and SQL is about literals. `applyIgnore` resolves one into the other
   * against the projects actually in the index, which is also what lets every
   * surface print *how many* rows it hid.
   */
  excludeProjects?: readonly string[];
}

/**
 * "No card title and no harness title", for a session.
 *
 * `cards` is empty until T2.2 writes the first row, so today the second
 * conjunct is always true and this reads as "the harness never named it".
 * It is written against the finished table deliberately: the moment `card`
 * starts writing, `--untitled` has to *stop* listing the sessions that now
 * have one, with no second edit and no chance of the two drifting. A card row
 * whose own title is empty names nothing, so it does not count as a title.
 */
const UNTITLED_SESSION_SQL = `COALESCE(TRIM(s.title), '') = ''
       AND NOT EXISTS (SELECT 1 FROM cards c
                        WHERE c.session_id = s.id AND COALESCE(TRIM(c.title), '') <> '')`;

/**
 * The same question for a ghost, which has one more way of being named: the
 * prompts `rescue` recovered. `ls` titles a ghost with its first non-slash
 * prompt (`recall.ts`'s `fromGhostRow`), so a ghost that has one is not
 * untitled however empty `ghosts.title` is — hence the third conjunct, which
 * mirrors that lookup exactly. Without it `--untitled` would list all 299
 * ghosts on the reference machine and bury the sdk sessions it exists for.
 */
const UNTITLED_GHOST_SQL = `COALESCE(TRIM(g.title), '') = ''
       AND NOT EXISTS (SELECT 1 FROM cards c
                        WHERE c.session_id = g.session_id
                          AND COALESCE(TRIM(c.title), '') <> '')
       AND NOT EXISTS (SELECT 1 FROM ghost_prompts p
                        WHERE p.session_id = g.session_id
                          AND p.text NOT LIKE '/%' AND length(trim(p.text)) > 3)`;

/**
 * `AND (project IS NULL OR project NOT IN (?, ?))` — the ignore list, bound.
 *
 * A NULL project is never excluded: the list names projects, and a session
 * whose project is unknown has not been named by anything.
 */
function excludeProjectsClause(column: string, projects: readonly string[]): string {
  return `(${column} IS NULL OR ${column} NOT IN (${projects.map(() => '?').join(', ')}))`;
}

export interface BoundClause {
  /** Already prefixed with `AND `, or empty. Safe to interpolate. */
  sql: string;
  params: unknown[];
}

/**
 * Build the AND-clause and bound-parameter list constraining an exchange
 * search. `e` is the `exchanges` alias, `s` the `sessions` alias.
 */
export function buildExchangeFilters(filters: SearchFilters = {}): BoundClause {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (filters.since) {
    validateISODate(filters.since, '--since');
    parts.push('e.ts >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    validateISODate(filters.until, '--until');
    parts.push('e.ts <= ?');
    params.push(filters.until);
  }
  if (filters.project) {
    parts.push('s.project = ?');
    params.push(filters.project);
  }
  if (filters.harness) {
    parts.push('s.harness = ?');
    params.push(filters.harness);
  }
  if (filters.status && filters.status !== 'ghost') {
    parts.push('s.status = ?');
    params.push(filters.status);
  }
  if (filters.branch) {
    parts.push(branchClause(filters.branch, 's.git_branch'));
    params.push(branchParam(filters.branch));
  }
  if (filters.sessionId) {
    parts.push('e.session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.file) {
    parts.push(FILE_TOUCHED_SQL('e.files_touched'));
    params.push(likePattern(filters.file));
  }
  if (filters.tag) {
    parts.push('EXISTS (SELECT 1 FROM tags t WHERE t.session_id = e.session_id AND t.tag = ?)');
    params.push(filters.tag);
  }
  if (filters.pinned) {
    parts.push('EXISTS (SELECT 1 FROM pins p WHERE p.session_id = e.session_id)');
  }
  if (filters.linkedTo) {
    parts.push(LINKED_TO_SQL('e.session_id'));
    params.push(filters.linkedTo, filters.linkedTo);
  }
  // `s` is already in scope here — every exchange query joins `sessions`, which
  // is what `s.project = ?` above relies on.
  if (filters.untitled) parts.push(UNTITLED_SESSION_SQL);
  if (filters.excludeProjects?.length) {
    parts.push(excludeProjectsClause('s.project', filters.excludeProjects));
    params.push(...filters.excludeProjects);
  }

  // include -> no clause at all. This is the line upstream does not have.
  const sidechains = filters.sidechains ?? 'include';
  if (sidechains === 'only') parts.push('e.is_sidechain = 1');
  else if (sidechains === 'exclude') parts.push('e.is_sidechain = 0');

  return {
    sql: parts.length ? `AND ${parts.join(' AND ')}` : '',
    params,
  };
}

/**
 * The same clause one level up, for a query over `sessions` alone (`ls`,
 * `stats`) where `s` is the only alias in scope.
 *
 * The dates move with it. An exchange has one timestamp, so `--since` on
 * `exchanges` is `e.ts >= ?`; a *session* is an interval, and someone asking
 * for `--since 2026-08-01` means "sessions that were alive in August", not
 * "sessions that happened to start in August". So the window is tested against
 * the interval, not against one end of it.
 *
 * `--file` becomes an EXISTS over that session's exchanges, which is the same
 * predicate `buildExchangeFilters` applies row-by-row, lifted.
 */
export function buildSessionFilters(filters: SearchFilters = {}): BoundClause {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (filters.since) {
    validateISODate(filters.since, '--since');
    parts.push('COALESCE(s.ended_at, s.started_at) >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    validateISODate(filters.until, '--until');
    parts.push('COALESCE(s.started_at, s.ended_at) <= ?');
    params.push(filters.until);
  }
  if (filters.project) {
    parts.push('s.project = ?');
    params.push(filters.project);
  }
  if (filters.harness) {
    parts.push('s.harness = ?');
    params.push(filters.harness);
  }
  if (filters.status && filters.status !== 'ghost') {
    parts.push('s.status = ?');
    params.push(filters.status);
  }
  if (filters.branch) {
    parts.push(branchClause(filters.branch, 's.git_branch'));
    params.push(branchParam(filters.branch));
  }
  if (filters.sessionId) {
    parts.push('s.id = ?');
    params.push(filters.sessionId);
  }
  if (filters.file) {
    parts.push(
      `EXISTS (SELECT 1 FROM exchanges e WHERE e.session_id = s.id
                 AND ${FILE_TOUCHED_SQL('e.files_touched')})`,
    );
    params.push(likePattern(filters.file));
  }
  if (filters.tag) {
    parts.push('EXISTS (SELECT 1 FROM tags t WHERE t.session_id = s.id AND t.tag = ?)');
    params.push(filters.tag);
  }
  if (filters.pinned) {
    parts.push('EXISTS (SELECT 1 FROM pins p WHERE p.session_id = s.id)');
  }
  if (filters.linkedTo) {
    parts.push(LINKED_TO_SQL('s.id'));
    params.push(filters.linkedTo, filters.linkedTo);
  }
  if (filters.untitled) parts.push(UNTITLED_SESSION_SQL);
  if (filters.excludeProjects?.length) {
    parts.push(excludeProjectsClause('s.project', filters.excludeProjects));
    params.push(...filters.excludeProjects);
  }

  const sidechains = filters.sidechains ?? 'include';
  if (sidechains === 'only') parts.push('s.is_sidechain = 1');
  else if (sidechains === 'exclude') parts.push('s.is_sidechain = 0');

  return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

/**
 * The same clause for the ghost tables, where `g` is the `ghosts` alias.
 *
 * A ghost is a session reconstructed from `history.jsonl` after Claude Code's
 * sweep deleted the transcript: prompts only, no assistant side, no subagents,
 * no files touched. So the filters that survive are the ones a ghost can
 * answer — project, harness, dates, branch, tag, pin — and `--sidechains`,
 * `--file` and `--status` are handled by the caller switching the ghost lists
 * off entirely rather than by a clause that could never match.
 *
 * Dates come off `first_ts`/`last_ts` rather than one column, so `--since`
 * finds a session that *ran* in the window even when it started before it.
 */
export function buildGhostFilters(filters: SearchFilters = {}): BoundClause {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (filters.since) {
    validateISODate(filters.since, '--since');
    parts.push('COALESCE(g.last_ts, g.first_ts) >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    validateISODate(filters.until, '--until');
    parts.push('COALESCE(g.first_ts, g.last_ts) <= ?');
    params.push(filters.until);
  }
  if (filters.project) {
    parts.push('g.project = ?');
    params.push(filters.project);
  }
  if (filters.harness) {
    parts.push('g.harness = ?');
    params.push(filters.harness);
  }
  if (filters.branch) {
    parts.push(branchClause(filters.branch, 'g.git_branch'));
    params.push(branchParam(filters.branch));
  }
  if (filters.sessionId) {
    parts.push('g.session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.tag) {
    parts.push('EXISTS (SELECT 1 FROM tags t WHERE t.session_id = g.session_id AND t.tag = ?)');
    params.push(filters.tag);
  }
  if (filters.pinned) {
    parts.push('EXISTS (SELECT 1 FROM pins p WHERE p.session_id = g.session_id)');
  }
  if (filters.linkedTo) {
    parts.push(LINKED_TO_SQL('g.session_id'));
    params.push(filters.linkedTo, filters.linkedTo);
  }
  if (filters.untitled) parts.push(UNTITLED_GHOST_SQL);
  if (filters.excludeProjects?.length) {
    parts.push(excludeProjectsClause('g.project', filters.excludeProjects));
    params.push(...filters.excludeProjects);
  }

  return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

/** True when a filter constrains rows the vec0 KNN cannot see before its cut. */
export function hasMetadataFilters(filters: SearchFilters = {}): boolean {
  return Boolean(
    filters.project ||
      filters.harness ||
      filters.status ||
      filters.branch ||
      filters.sessionId ||
      filters.tag ||
      filters.file ||
      filters.pinned ||
      filters.linkedTo ||
      filters.untitled ||
      filters.excludeProjects?.length ||
      (filters.sidechains && filters.sidechains !== 'include'),
  );
}

/**
 * vec0 applies KNN *before* WHERE, so when metadata filters are active a
 * search must ask for more candidates than it wants and trim afterwards.
 * Upstream's constant (3x) is kept.
 */
export function knnCandidates(limit: number, filters: SearchFilters = {}): number {
  return hasMetadataFilters(filters) ? limit * 3 : limit;
}

/**
 * `--file` against `exchanges.files_touched`, which is a **JSON array**.
 *
 * The column holds `["packages/core/src/db/pool.ts","README.md"]`, so the
 * obvious `files_touched LIKE '%/db/%'` is wrong in both directions: it matches
 * the commas and brackets between elements (a session that touched `a/db` and
 * `x.ts` matches a pattern spanning the two) and it cannot anchor a pattern to
 * one path's end. json1's `json_each` turns the array into rows, and the
 * pattern is then applied to one whole path at a time — which is what
 * `--file "%/db/%"` means and what `03` §7 asks for by name.
 *
 * The `CASE` is not defensive decoration. `json_each` raises *malformed JSON*
 * when handed a value that is not an array, and one unparseable row written by
 * some future adapter would abort the whole search rather than not matching —
 * a filter that turns a result set into an error. An unreadable value matches
 * nothing, which is the honest answer.
 *
 * The pattern is still a bound `?`. Nothing the user types is concatenated
 * into SQL here, and the ESCAPE clause means a literal `_` in a filename
 * cannot act as a wildcard.
 */
export function FILE_TOUCHED_SQL(column: string): string {
  return `EXISTS (SELECT 1 FROM json_each(
                    CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END
                  ) jf WHERE jf.value LIKE ? ESCAPE '\\')`;
}

/**
 * What a user's `--file` argument means as a LIKE pattern.
 *
 *   `pool.ts`      -> `%pool.ts%`   nobody types leading and trailing wildcards
 *   `%/db/%`       -> `%/db/%`      already a pattern; left alone
 *   `src/*.ts`     -> `src/%.ts`    the glob everyone's shell taught them
 *
 * `_` is escaped in every case, because `snake_case.py` is a filename and not
 * a single-character wildcard, and the difference is silent otherwise.
 */
export function likePattern(value: string): string {
  const hasWildcard = /[%*]/.test(value);
  const escaped = value.replace(/[\\_]/g, (c) => `\\${c}`);
  return hasWildcard ? escaped.replace(/\*/g, '%') : `%${escaped}%`;
}

/**
 * `--branch` is an equality by default and a pattern when it is written as one.
 *
 * Branch names are typed in full far more often than paths are, and an
 * unanchored substring match would make `--branch main` also select
 * `feat/main-nav-redesign`. But `--branch "feat/*"` is what a person means when
 * they ask what a whole line of work touched, so a value carrying a wildcard
 * becomes a LIKE.
 */
export function branchClause(value: string, column: string): string {
  return /[%*]/.test(value) ? `${column} LIKE ? ESCAPE '\\'` : `${column} = ?`;
}

export function branchParam(value: string): string {
  return /[%*]/.test(value)
    ? value.replace(/[\\_]/g, (c) => `\\${c}`).replace(/\*/g, '%')
    : value;
}

export function validateISODate(value: string, paramName: string): void {
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) {
    throw new Error(
      `invalid ${paramName} date: "${value}". expected YYYY-MM-DD (for example 2026-08-01)`,
    );
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new Error(`invalid ${paramName} date: "${value}". not a valid calendar date`);
  }
}
