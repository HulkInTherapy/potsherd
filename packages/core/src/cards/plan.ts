import type { Db } from '../db.js';
import type { Harness } from '../adapters/types.js';
import {
  buildGhostFilters,
  buildSessionFilters,
  type SearchFilters,
} from '../search/filters.js';
import {
  CARD_MODEL,
  estimate,
  type Backend,
  type Estimate,
  type EstimateSession,
} from '../llm.js';

/**
 * What a card run would do, decided before any of it happens.
 *
 * This is the read-only half of `potsherd card`: which sessions are in scope,
 * how much text each one will send, and therefore what the run costs. It runs
 * against the store alone — no model, no network, no credentials — which is
 * what makes `card --dry-run` worth trusting.
 *
 * T2.2 (the ProMem-lite pipeline) and T2.3 (ghost cards) both start here:
 * {@link planCards} selects and prices, they execute. Nothing else in phase 2
 * should re-derive eligibility or char counts.
 */

/** `03` §6: a session under this many exchanges has nothing to summarise. */
export const MIN_EXCHANGES = 3;

/** `03` §6: a ghost is prompts only, so it needs more of them to be worth a card. */
export const MIN_GHOST_PROMPTS = 5;

/**
 * Per exchange, the `seq: 12 · 2026-08-21` header the pipeline prepends so the
 * model can cite evidence by seq (`phase-2` T2.2 §1). Small, but 1,406
 * exchanges of it is 34k characters on the reference corpus, and an estimate
 * that ignores it under-quotes.
 */
export const SEQ_HEADER_CHARS = 24;

export type CardKind = 'session' | 'ghost';

export interface CardTarget {
  id: string;
  kind: CardKind;
  harness: Harness;
  title: string | null;
  project: string | null;
  /**
   * The single path segment the markdown mirror lives under
   * (`~/.potsherd/cards/<harness>/<slug>/<id>.md`). Carried on the target so a
   * run that fails before it can load the transcript still knows where to
   * leave its error sentinel.
   */
  projectSlug: string | null;
  /** Exchanges for a session, prompts for a ghost. */
  units: number;
  /**
   * Characters of **redacted** text the run will send for this target. The
   * store is redacted at rest (`03` §5), so this is measured, not guessed.
   */
  chars: number;
  /** A card row already exists. */
  carded: boolean;
  /** The transcript changed after the card was written. */
  stale: boolean;
  isSidechain: boolean;
}

export interface SkipReasonCounts {
  /** Below {@link MIN_EXCHANGES} / {@link MIN_GHOST_PROMPTS}. */
  tooShort: number;
  /** Already carded and not stale, and `--force` was not passed. */
  alreadyCarded: number;
}

export interface CardPlan {
  targets: CardTarget[];
  skipped: SkipReasonCounts;
  /** Everything the filters matched, before eligibility and `--force`. */
  considered: number;
  sessions: number;
  ghosts: number;
  estimate: Estimate;
  model: string;
  backend?: Backend;
}

export interface PlanOptions {
  filters?: SearchFilters;
  /** Re-card even when a card exists and the transcript has not changed. */
  force?: boolean;
  /** Alias or explicit model id. Default {@link CARD_MODEL}. */
  model?: string;
  backend?: Backend;
  /** Zero marginal cost on the subscription paths. */
  chargeable?: boolean;
  /** Cards run in parallel; wall time divides by this. */
  concurrency?: number;
  /** Cap the target list, for `card <session>` and for testing. */
  limit?: number;
}

interface SessionRow {
  id: string;
  harness: Harness;
  title: string | null;
  project: string | null;
  project_slug: string | null;
  is_sidechain: number;
  source_mtime: number | null;
  exchanges: number;
  chars: number;
  carded: number;
  card_created_at: string | null;
}

interface GhostRow {
  session_id: string;
  harness: Harness;
  title: string | null;
  project: string | null;
  prompts: number;
  chars: number;
  carded: number;
}

/**
 * The scope of a card run, priced.
 *
 * Ghosts are selected by the same filters as sessions and appear in the same
 * list, flagged `kind: 'ghost'`. They are not an afterthought: on the
 * reference machine 299 of the 336 sessions are ghosts, so a plan that quietly
 * dropped them would quote a run an order of magnitude smaller than the one
 * the user asked for.
 */
export function planCards(db: Db, options: PlanOptions = {}): CardPlan {
  const filters = options.filters ?? {};
  const targets: CardTarget[] = [];
  const skipped: SkipReasonCounts = { tooShort: 0, alreadyCarded: 0 };
  let considered = 0;

  if ((filters.ghosts ?? 'include') !== 'only' && filters.status !== 'ghost') {
    const f = buildSessionFilters(filters);
    const rows = db
      .prepare(
        `SELECT s.id, s.harness, s.title, s.project, s.project_slug, s.is_sidechain, s.source_mtime,
                (SELECT COUNT(*) FROM exchanges e WHERE e.session_id = s.id) AS exchanges,
                (SELECT COALESCE(SUM(length(e.user_text) + length(e.assistant_text)), 0)
                   FROM exchanges e WHERE e.session_id = s.id) AS chars,
                (SELECT COUNT(*) FROM cards c WHERE c.session_id = s.id) AS carded,
                (SELECT c.created_at FROM cards c WHERE c.session_id = s.id) AS card_created_at
           FROM sessions s
          WHERE 1=1 ${f.sql}
          ORDER BY COALESCE(s.ended_at, s.started_at) DESC`,
      )
      .all(...f.params) as SessionRow[];

    for (const r of rows) {
      considered++;
      if (r.exchanges < MIN_EXCHANGES) {
        skipped.tooShort++;
        continue;
      }
      const stale = isStale(r.card_created_at, r.source_mtime);
      if (r.carded > 0 && !stale && !options.force) {
        skipped.alreadyCarded++;
        continue;
      }
      targets.push({
        id: r.id,
        kind: 'session',
        harness: r.harness,
        title: r.title,
        project: r.project,
        projectSlug: r.project_slug,
        units: r.exchanges,
        chars: r.chars + r.exchanges * SEQ_HEADER_CHARS,
        carded: r.carded > 0,
        stale,
        isSidechain: r.is_sidechain === 1,
      });
    }
  }

  if (ghostsInScope(filters)) {
    const f = buildGhostFilters(filters);
    const rows = db
      .prepare(
        `SELECT g.session_id, g.harness, g.title, g.project,
                (SELECT COUNT(*) FROM ghost_prompts p WHERE p.session_id = g.session_id) AS prompts,
                (SELECT COALESCE(SUM(length(p.text)), 0)
                   FROM ghost_prompts p WHERE p.session_id = g.session_id) AS chars,
                (SELECT COUNT(*) FROM cards c WHERE c.session_id = g.session_id) AS carded
           FROM ghosts g
          WHERE 1=1 ${f.sql}
          ORDER BY COALESCE(g.last_ts, g.first_ts) DESC`,
      )
      .all(...f.params) as GhostRow[];

    for (const r of rows) {
      considered++;
      if (r.prompts < MIN_GHOST_PROMPTS) {
        skipped.tooShort++;
        continue;
      }
      if (r.carded > 0 && !options.force) {
        skipped.alreadyCarded++;
        continue;
      }
      targets.push({
        id: r.session_id,
        kind: 'ghost',
        harness: r.harness,
        title: r.title,
        project: r.project,
        // Ghosts have no `project_slug` column; `project` is what `rescue`
        // recovered and the mirror path is derived from it.
        projectSlug: r.project,
        units: r.prompts,
        chars: r.chars + r.prompts * SEQ_HEADER_CHARS,
        carded: r.carded > 0,
        stale: false,
        isSidechain: false,
      });
    }
  }

  const capped =
    options.limit !== undefined ? targets.slice(0, Math.max(0, options.limit)) : targets;

  const sessions: EstimateSession[] = capped.map((t) => ({ id: t.id, chars: t.chars }));
  const model = options.model ?? CARD_MODEL;

  return {
    targets: capped,
    skipped,
    considered,
    sessions: capped.filter((t) => t.kind === 'session').length,
    ghosts: capped.filter((t) => t.kind === 'ghost').length,
    estimate: estimate({
      sessions,
      model,
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.chargeable !== undefined ? { chargeable: options.chargeable } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    }),
    model,
    ...(options.backend ? { backend: options.backend } : {}),
  };
}

/**
 * Re-card only when the transcript moved (`03` §6, incremental).
 *
 * `source_mtime` is epoch milliseconds; `cards.created_at` is an ISO string.
 * A card with no timestamp is treated as stale rather than fresh: an unknown
 * age should cost one call, not silently pin a wrong card forever.
 */
export function isStale(cardCreatedAt: string | null, sourceMtime: number | null): boolean {
  if (!cardCreatedAt) return true;
  if (sourceMtime === null || sourceMtime === undefined) return false;
  const created = Date.parse(cardCreatedAt);
  if (Number.isNaN(created)) return true;
  return sourceMtime > created;
}

function ghostsInScope(filters: SearchFilters): boolean {
  if (filters.status === 'ghost') return true;
  if ((filters.ghosts ?? 'include') === 'exclude') return false;
  // A ghost has no assistant side, no subagents and no recorded file edits.
  if ((filters.sidechains ?? 'include') === 'only') return false;
  if (filters.file) return false;
  if (filters.status) return false;
  return true;
}
