/**
 * Folding a bridge's hits into a potsherd result as one more RRF list.
 *
 * ## why this is a separate function and not a change to `recall()`
 *
 * `packages/core/src/recall.ts` fuses eight lists that all describe rows in
 * *this machine's index*: every hit has a `sessionId`, and the fusion's last
 * act is to cluster hits by conversation and diversify within it. A claude-mem
 * observation has none of that. It has no session, it cannot corroborate a
 * potsherd hit, and it must not be able to displace one by pretending to.
 *
 * So the bridge lists are fused *beside* the local result rather than into it:
 * same constant, same arithmetic, same scale, separate array. `03` §10 says
 * "never duplicate their capture", and the display rule follows from the
 * storage rule — a federated result that could not tell you which tool an
 * answer came from would have duplicated it in the only way that matters.
 *
 * ## same arithmetic, deliberately not a second implementation
 *
 * The contribution of a hit at rank `r` is `weight * 1/(k + r)`, with `k`
 * taken from the {@link RecallResult} being merged into rather than chosen
 * here — so a `find --k 20` sweep moves both halves together and cannot
 * silently leave the bridges on a different constant. `recall()` records each
 * hit's contribution rather than solving for it later, for a reason its own
 * comment gives: two implementations of one formula disagree the moment
 * anything relaxes. `tests/bridges.test.ts` asserts this file agrees with
 * `search/similarity.ts` numerically, which is the cheap way to keep one
 * formula honest across two packages.
 */

import type { RecallResult } from '@potsherd/core';
import type { BridgeHit, BridgeList, BridgeName, BridgePresence } from './types.js';

/**
 * What a bridge list is worth in the fusion, before penalties.
 *
 * RRF's own formula has no weights — every list is `1/(k+rank)` — and for
 * lists of comparable trustworthiness that is right. These are not quite
 * comparable to each other:
 *
 *   - `claude-mem` and `agentmemory` return their own ranked search results.
 *     Rank 1 there means what rank 1 means here, so they are worth 1.
 *   - `notes` is ranked by a token count over a handful of markdown files
 *     (see `notes.ts`), not by bm25 over a corpus. Its rank 1 is a weaker
 *     claim, so it is worth less — but it is still worth having, because the
 *     answer it gives ("this is already in your CLAUDE.md") is one no other
 *     list can give at all.
 */
export const BRIDGE_WEIGHTS: Record<BridgeName, number> = {
  'claude-mem': 1,
  agentmemory: 1,
  notes: 0.8,
};

/**
 * What a list is worth when its order is not a ranking.
 *
 * The `like` strategy is a substring scan ordered by recency: the rows are
 * relevant, their *order* carries no information about relevance, and RRF
 * reads nothing but order. Halving the weight is the same move `recall()`
 * makes with `RELAXED_PENALTY` for the same reason — the hits are still worth
 * showing, they are just not worth what a ranked list's hits are worth.
 */
export const UNRANKED_PENALTY = 0.5;

/** One bridge's line in the federated report. */
export interface FederatedList {
  list: BridgeName;
  /** Hits the bridge returned. */
  candidates: number;
  ms: number;
  /**
   * The tri-state the whole package is built around, carried all the way to
   * `--json`: `absent` (not installed), `empty` (installed, nothing captured),
   * `store` (read), `unrecognised` (schema mismatch).
   */
  presence: BridgePresence;
  /** One printable line when the bridge could not run; null when it ran. */
  unavailable: string | null;
  /**
   * {@link BridgeStatus.headline} — the bridge's own short sentence.
   *
   * T6.6 D4: `federationLine` used to derive its wording from `presence`
   * alone, which cannot distinguish "the schema was read and rejected" from
   * "the server was never started", and printed the first at people in the
   * second state. `types.ts` says why that is not a cosmetic bug: it "would
   * send them to look in the wrong place."
   */
  headline: string;
  strategy: BridgeList['strategy'];
  /** What this list was actually worth on this query, after penalties. */
  weight: number;
  /** The path or URL read, so a receipt can show it. */
  path: string;
}

/** Where a position in the merged order came from. */
export type MergedRef = { kind: 'local'; index: number } | { kind: 'external'; index: number };

/**
 * A {@link RecallResult} with the bridges beside it.
 *
 * It **is** a `RecallResult` — every existing renderer, `--json` consumer and
 * test keeps working on it unchanged, and a caller that ignores `bridges` and
 * `external` sees exactly what `find` has always produced. That is the point:
 * `--with claude-mem` must be additive, and a flag that changed the shape of
 * the result for everyone would not be.
 */
export interface FederatedResult extends RecallResult {
  bridges: FederatedList[];
  /** Bridge hits with `score` filled in, best first. Never merged into `hits`. */
  external: BridgeHit[];
  /**
   * The two halves in one order, by score.
   *
   * A renderer that wants "their hits and ours on one page" walks this;
   * one that wants them in separate blocks ignores it. Both are legitimate,
   * and neither needs to re-sort anything.
   */
  order: MergedRef[];
}

export interface FederateOptions {
  /** Per-list weight overrides, merged over {@link BRIDGE_WEIGHTS}. */
  weights?: Partial<Record<BridgeName, number>>;
  /** External hits to keep. Default: the local result's own session count, min 5. */
  limit?: number;
}

/**
 * Merge zero or more bridge lists into a recall result.
 *
 * Bridges that could not run are still reported — with their `presence` and
 * their sentence — and simply contribute no hits. That is the whole graceful
 * degradation contract in one line: **an absent tool changes the report, never
 * the results, and never the exit path.**
 */
export function federate(
  result: RecallResult,
  lists: readonly BridgeList[],
  options: FederateOptions = {},
): FederatedResult {
  const k = result.k;
  const bridges: FederatedList[] = [];
  const external: BridgeHit[] = [];

  for (const list of lists) {
    const base = options.weights?.[list.list] ?? BRIDGE_WEIGHTS[list.list] ?? 1;
    const ranked = list.strategy !== 'like';
    const weight = base * (ranked ? 1 : UNRANKED_PENALTY);

    bridges.push({
      list: list.list,
      candidates: list.hits.length,
      ms: list.ms,
      presence: list.status.presence,
      unavailable: list.unavailable,
      headline: list.status.headline,
      strategy: list.strategy,
      weight,
      path: list.status.path,
    });

    list.hits.forEach((hit, i) => {
      // `hit.rank` is the bridge's own 1-based rank; the array index is used
      // only when a bridge left it unset, so that a malformed bridge cannot
      // put every hit at rank 1 and dominate the fusion.
      const rank = Number.isInteger(hit.rank) && hit.rank > 0 ? hit.rank : i + 1;
      external.push({ ...hit, rank, score: weight * (1 / (k + rank)) });
    });
  }

  external.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.rank - b.rank);
  const keep = Math.max(options.limit ?? Math.max(result.sessions.length, 5), 0);
  const kept = external.slice(0, keep);

  const order: MergedRef[] = [
    ...result.hits.map((_, index) => ({ kind: 'local' as const, index })),
    ...kept.map((_, index) => ({ kind: 'external' as const, index })),
  ].sort((a, b) => scoreOf(result, kept, b) - scoreOf(result, kept, a));

  return { ...result, bridges, external: kept, order };
}

function scoreOf(result: RecallResult, external: readonly BridgeHit[], ref: MergedRef): number {
  return ref.kind === 'local'
    ? (result.hits[ref.index]?.score ?? 0)
    : (external[ref.index]?.score ?? 0);
}

/**
 * The one-line summary `find --with …` prints under the results.
 *
 * Written here rather than in the CLI because the sentence has to distinguish
 * the four presences, and that distinction is this package's whole reason for
 * existing — a renderer that had to re-derive it from a boolean would collapse
 * it back into "unavailable" within a release.
 */
export function federationLine(bridges: readonly FederatedList[]): string {
  if (bridges.length === 0) return '';
  return bridges
    .map((b) => {
      if (b.presence === 'absent') return `${b.list}: not installed`;
      if (b.presence === 'empty') return `${b.list}: installed, nothing to search`;
      // T6.6 D4. Not `'schema not recognised'`: the bridge already knows what
      // went wrong and has said so, and this is the third of the four
      // presences whose sentence is *not* a function of the presence. A
      // launch command that could not be found and a text column that was not
      // there are the same presence and two different things to go and check.
      if (b.presence === 'unrecognised') return `${b.list}: ${b.headline}`;
      return `${b.list}: ${b.candidates} hit${b.candidates === 1 ? '' : 's'}`;
    })
    .join('  ·  ');
}
