import { RRF_K, rrfScore } from './similarity.js';
import { CORROBORATION } from '../recall.js';
import type { ListName, RecallHit, RecallResult, RecallSession } from '../recall.js';

/**
 * `find --explain` — the arithmetic behind the order, taken apart.
 *
 * `find` fuses up to seven independently ranked lists (`03` §7). Each one puts
 * a row somewhere; RRF turns each of those positions into `1/(k+rank)`, scales
 * it by that list's weight, and adds them up. Then the hits are grouped into
 * sessions and a *session* score decides the page order. Four steps, and by the
 * time a block reaches the screen every one of them is invisible.
 *
 * That is a problem twice over. It is a problem for the person tuning recall —
 * phase 2 handed phase 3 the open question of why the fusion loses to bm25
 * alone on the eval set, and no amount of staring at ranked output answers it.
 * And it is a problem for the person who simply does not believe the result:
 * "why is this above that" is a fair question and a search tool should be able
 * to answer it in its own output.
 *
 * So this module reconstructs the whole sum from what `recall` returns, and the
 * renderer prints it as a ledger: one row per (hit, list), showing where that
 * list ranked the row, what it scored raw, what the weight did to it, and what
 * share of the hit's total that contribution is. Nothing is summarised away —
 * the numbers on the screen add up to the number beside the title.
 *
 * ## Nothing here is inferred any more
 *
 * This module used to *solve* for the weights, because `recall` reported
 * `{ list, rank, raw }` and not the weight it had applied — and the effective
 * weight is not a constant, since `titles` is scaled by query coverage and any
 * relaxed list is penalised. A hit found by one list alone pins that list's
 * weight (`score = w / (k + rank)`); a hit with one unknown left over pins that
 * one from the residual; two passes and a median covered the rest.
 *
 * It worked, and it was still the wrong shape: the debugger's arithmetic and
 * the ranker's arithmetic were two implementations of the same formula, and a
 * debugger that can disagree with the thing it is debugging is worth very
 * little at the moment you need it. T3.1 made `recall` report `k`, the
 * effective `weights`, `relaxedLists` and a per-list `contribution`, so the
 * ledger now *reads* every number it prints. {@link solveWeights} is kept and
 * exported because it is a genuinely useful cross-check — it recovers the same
 * weights from the scores alone — but `explain` no longer depends on it.
 */

export interface ListExplain {
  list: ListName;
  /** Where this list put the row. 1 is best. */
  rank: number;
  /** bm25 (negative; lower is better) or cosine similarity, as the list gave it. */
  raw: number;
  /** The effective weight `recall` applied, after coverage and relaxation. */
  weight: number;
  /** True when the list had relaxed to any-word matching on this query. */
  relaxed: boolean;
  /** `weight * 1/(k+rank)` — what this list added to the hit. */
  contribution: number;
  /** That contribution as a fraction of the hit's score. */
  share: number;
}

export interface HitExplain {
  kind: RecallHit['kind'];
  /** `exchange 12`, `ghost prompt 3`, `card`, `title`. */
  label: string;
  score: number;
  /** Best-first, so the list that decided the hit is the first row. */
  lists: ListExplain[];
  /** Score minus the contributions accounted for. ~0 when the solve worked. */
  residual: number;
}

export interface SessionExplain {
  id: string;
  /** 1-based position on the page. */
  place: number;
  title: string;
  score: number;
  /** The session's best single hit — the term that dominates its score. */
  best: number;
  /** What the other hits added after halving, and whether the cap bit. */
  corroboration: number;
  capped: boolean;
  hits: HitExplain[];
}

export interface Explain {
  query: string;
  k: number;
  weights: { list: ListName; weight: number; relaxed: boolean }[];
  lists: RecallResult['lists'];
  sessions: SessionExplain[];
  /**
   * Why the first is first. `null` when there is nothing to compare it to.
   */
  margin: {
    by: number;
    /**
     * `best` — the winner's strongest single hit is stronger, and `list` is
     * where that happened. `corroboration` — it is *not*, and the winner is
     * ahead because more hits agreed with it, which is the case a reader would
     * otherwise never guess from the order.
     */
    reason: 'best' | 'corroboration';
    /** The list that decided the winner's best hit. */
    list: ListName | null;
    firstRank: number | null;
    /** Where that same list put the runner-up's best hit, if it found it. */
    secondRank: number | null;
    firstHits: number;
    secondHits: number;
  } | null;
}

/**
 * Build the full ledger for a finished search.
 *
 * `k` is only a fallback for a `RecallResult` from before `recall` reported its
 * own — the result's value wins whenever it has one, because a caller that
 * passed `{ k: 10 }` to `recall` must not be shown a ledger computed at 60.
 */
export function explain(result: RecallResult, k = result.k ?? RRF_K): Explain {
  const relaxed = new Set(result.relaxedLists ?? []);
  const sessions = result.sessions.map((s, i) => explainSession(s, i + 1, k, relaxed, result));
  return {
    query: result.query,
    k,
    weights: Object.entries(result.weights ?? {})
      .map(([list, weight]) => ({
        list: list as ListName,
        weight: weight ?? 1,
        relaxed: relaxed.has(list as ListName),
      }))
      .sort((a, b) => b.weight - a.weight || a.list.localeCompare(b.list)),
    lists: result.lists,
    sessions,
    margin: marginOf(sessions),
  };
}

function explainSession(
  s: RecallSession,
  place: number,
  k: number,
  relaxed: ReadonlySet<ListName>,
  result: RecallResult,
): SessionExplain {
  const hits = [...s.hits]
    .sort((a, b) => b.score - a.score)
    .map((h) => explainHit(h, k, relaxed, result));
  const best = hits.length > 0 ? hits[0]!.score : 0;
  const rest = hits.slice(1).reduce((n, h) => n + h.score, 0);
  // `recall`'s `sessionScore`: best + min(rest/2, best * CORROBORATION).
  // Restated rather than imported because the point of the line on screen is to
  // show the formula, and a shared helper would hide exactly the part being
  // explained — but the *cap* is read from the ranker, so tuning it can never
  // make the ledger disagree with the order it is explaining.
  const cap = best * CORROBORATION;
  return {
    id: s.id,
    place,
    title: s.displayTitle,
    score: s.score,
    best,
    corroboration: Math.min(rest / 2, cap),
    capped: rest / 2 > cap + 1e-12,
    hits,
  };
}

function explainHit(
  hit: RecallHit,
  k: number,
  relaxed: ReadonlySet<ListName>,
  result: RecallResult,
): HitExplain {
  const lists = hit.from
    .map((f) => {
      // Reported by the ranker. The fallback is for a hand-built RecallHit in a
      // test, and is the same formula the ranker used.
      const weight = result.weights?.[f.list] ?? 1;
      const contribution = f.contribution ?? weight * rrfScore(f.rank, k);
      return {
        list: f.list,
        rank: f.rank,
        raw: f.raw,
        weight,
        relaxed: relaxed.has(f.list),
        contribution,
        share: hit.score > 0 ? contribution / hit.score : 0,
      };
    })
    .sort((a, b) => b.contribution - a.contribution);
  const accounted = lists.reduce((n, l) => n + l.contribution, 0);
  return {
    kind: hit.kind,
    label: labelOf(hit),
    score: hit.score,
    lists,
    residual: hit.score - accounted,
  };
}

function labelOf(hit: RecallHit): string {
  switch (hit.kind) {
    case 'exchange':
      return hit.seq === undefined ? 'exchange' : `exchange ${hit.seq}`;
    case 'ghost':
      return hit.seq === undefined || hit.seq === 0 ? 'ghost' : `prompt ${hit.seq}`;
    case 'card':
      return 'card';
    default:
      return 'title';
  }
}

interface Weight {
  weight: number;
  solved: boolean;
}

/**
 * Recover each list's effective weight from the scores it produced.
 *
 * A hit found by one list alone is a one-unknown equation and solves exactly.
 * With those in hand, a hit found by two lists where one is already known
 * solves the other from the residual — which is how `titles` (whose weight
 * moves with query coverage) and any relaxed list get pinned down even when
 * every one of their hits was corroborated by something else.
 *
 * The median, not the mean: one hit whose score was perturbed by floating-point
 * accumulation should not drag a weight, and with a handful of samples the
 * median is the estimator that ignores it.
 */
export function solveWeights(hits: readonly RecallHit[], k = RRF_K): Map<ListName, Weight> {
  const samples = new Map<ListName, number[]>();
  const add = (list: ListName, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) return;
    const arr = samples.get(list) ?? [];
    arr.push(value);
    samples.set(list, arr);
  };

  for (const hit of hits) {
    if (hit.from.length === 1) {
      const f = hit.from[0]!;
      add(f.list, hit.score * (k + f.rank));
    }
  }

  const known = (): Map<ListName, number> => {
    const out = new Map<ListName, number>();
    for (const [list, values] of samples) out.set(list, median(values));
    return out;
  };

  // Two passes are enough for the shapes that occur (a list with no solo hit
  // is pinned by a pair, a list with neither by a triple); a third changes
  // nothing on any corpus tried and the loop has to stop somewhere.
  for (let pass = 0; pass < 3; pass++) {
    const w = known();
    for (const hit of hits) {
      const unknown = hit.from.filter((f) => !w.has(f.list));
      if (unknown.length !== 1) continue;
      const accounted = hit.from
        .filter((f) => w.has(f.list))
        .reduce((n, f) => n + w.get(f.list)! * rrfScore(f.rank, k), 0);
      const target = unknown[0]!;
      add(target.list, (hit.score - accounted) * (k + target.rank));
    }
  }

  const out = new Map<ListName, Weight>();
  const solved = known();
  for (const hit of hits) {
    for (const f of hit.from) {
      if (out.has(f.list)) continue;
      const w = solved.get(f.list);
      out.set(f.list, w === undefined ? { weight: 1, solved: false } : { weight: w, solved: true });
    }
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * What separates the first result from the second — and, when the obvious
 * answer is the wrong one, saying so.
 *
 * A session's score is `best + min(rest/2, best * CORROBORATION)`, so there are exactly two
 * ways to be first: a stronger single hit, or more of them. The second case is
 * the one worth printing, because nothing else on the screen hints at it. On
 * the fixture corpus `find "database migration"` puts a session bm25 ranked
 * *second* above the one it ranked first, purely on corroboration — and a
 * reader comparing the two top rows would conclude the ranking was broken.
 */
function marginOf(sessions: SessionExplain[]): Explain['margin'] {
  if (sessions.length < 2) return null;
  const [a, b] = [sessions[0]!, sessions[1]!];
  const bestA = a.hits[0];
  const bestB = b.hits[0];
  const list = bestA?.lists[0]?.list ?? null;
  return {
    by: a.score - b.score,
    reason: a.best > b.best + 1e-12 ? 'best' : 'corroboration',
    list,
    firstRank: bestA?.lists[0]?.rank ?? null,
    // The same list's rank on the runner-up, so the two numbers compare.
    secondRank: bestB?.lists.find((l) => l.list === list)?.rank ?? null,
    firstHits: a.hits.length,
    secondHits: b.hits.length,
  };
}
