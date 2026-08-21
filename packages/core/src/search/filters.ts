import type { Harness, SessionStatus } from '../adapters/types.js';

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
  /** Substring match against `exchanges.files_touched`. */
  file?: string;
  /** Default `include` — the opposite of upstream's hard-coded exclusion. */
  sidechains?: TriState;
  ghosts?: TriState;
  pinned?: boolean;
  sessionId?: string;
  /**
   * `live` (transcript still where the harness put it), `archived` (potsherd
   * holds the only copy) or `ghost` (prompts only, rebuilt from history).
   * A ghost has no row in `sessions`, so `status: 'ghost'` is the caller's cue
   * to run the ghost lists alone — see `buildGhostFilters`.
   */
  status?: SessionStatus;
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
    parts.push('s.git_branch = ?');
    params.push(filters.branch);
  }
  if (filters.sessionId) {
    parts.push('e.session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.file) {
    parts.push('e.files_touched LIKE ?');
    params.push(`%${filters.file}%`);
  }
  if (filters.tag) {
    parts.push('EXISTS (SELECT 1 FROM tags t WHERE t.session_id = e.session_id AND t.tag = ?)');
    params.push(filters.tag);
  }
  if (filters.pinned) {
    parts.push('EXISTS (SELECT 1 FROM pins p WHERE p.session_id = e.session_id)');
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
    parts.push('s.git_branch = ?');
    params.push(filters.branch);
  }
  if (filters.sessionId) {
    parts.push('s.id = ?');
    params.push(filters.sessionId);
  }
  if (filters.file) {
    parts.push(
      'EXISTS (SELECT 1 FROM exchanges e WHERE e.session_id = s.id AND e.files_touched LIKE ?)',
    );
    params.push(`%${filters.file}%`);
  }
  if (filters.tag) {
    parts.push('EXISTS (SELECT 1 FROM tags t WHERE t.session_id = s.id AND t.tag = ?)');
    params.push(filters.tag);
  }
  if (filters.pinned) {
    parts.push('EXISTS (SELECT 1 FROM pins p WHERE p.session_id = s.id)');
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
    parts.push('g.git_branch = ?');
    params.push(filters.branch);
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
