import type { EmbeddingsOptions } from '../embeddings.js';
import type { Llm } from '../llm.js';
import { measureCoverage, mergeSupplement, type CoverageReport } from './coverage.js';
import { dedupeCard } from './dedupe.js';
import { extractCard, supplementCard, type ExtractSpend } from './extract.js';
import type { Gate } from './gate.js';
import { ghostClaimGate } from './ghost.js';
import { normaliseCard, type ExtractedCard } from './schema.js';
import type { Transcript } from './transcript.js';
import { unresolvedEvidence, verifyCard, type DroppedClaim, type VerifyTotals } from './verify.js';
import { cachedEmbedder, type CachedEmbedder } from './vectors.js';

/**
 * ProMem-lite, end to end: the five steps of `03` §6 over one transcript.
 *
 * ```
 *   slice ──▶ extract ──▶ coverage ──▶ verify ──▶ dedupe ──▶ card
 *              (model)     (model,      (no model)  (no model)
 *                           at most
 *                           once more)
 * ```
 *
 * The steps are not collapsible and the order is not arbitrary
 * (`research/memory-research.md` §1):
 *
 * - **coverage before verify.** Coverage answers *ahead-of-time bias* — it can
 *   only add claims, and every claim it adds must then face the same filter as
 *   the first pass's. Verifying first and supplementing after would write
 *   unchecked claims into the card.
 * - **verify before dedupe.** Dedupe keeps "the verified version"; if it ran
 *   first, an unsupported phrasing could absorb a supported one and then be
 *   dropped, losing both.
 * - **dedupe last**, because both earlier steps produce duplicates: a
 *   map-reduce over four chunks restates the session's one real decision four
 *   times, and the supplement restates whatever it found near the boundary.
 *
 * Two of the five steps cost nothing. That is the point: the expensive half is
 * the model's opinion and the cheap half is the transcript's veto.
 *
 * ## Ghosts run the same five steps
 *
 * A ghost — a session Claude Code's sweep deleted, rebuilt from its prompts —
 * is a {@link Transcript} whose units came from `ghost_prompts`, and it goes
 * through this function unchanged. Two things differ, both of them
 * *restrictions* applied here rather than new machinery: the verify step
 * carries `ghostClaimGate`, and the finished card's `outcome` is overwritten
 * with `unknown`. See `cards/ghost.ts` for why each one is a taking rather
 * than an asking.
 */

export interface CardPipelineOptions {
  /** The old card, when re-carding a session whose transcript grew. */
  prior?: ExtractedCard | null;
  /** Share one cache across a whole run; the pipeline makes its own otherwise. */
  embedder?: CachedEmbedder;
  embeddings?: EmbeddingsOptions;
  signal?: AbortSignal;
  /** Test seam: deterministic vectors with no 34 MB model. */
  embed?: (text: string) => Promise<number[]>;
  verifyCosine?: number;
  dedupeCosine?: number;
  /** Off only for tests that are measuring something else. */
  coverage?: boolean;
  /** The run's global limit on in-flight model calls. See `cards/gate.ts`. */
  gate?: Gate;
  onStep?: (step: CardStep, detail: string) => void;
}

export type CardStep = 'extract' | 'coverage' | 'supplement' | 'verify' | 'dedupe';

export interface CardResult {
  transcript: Transcript;
  card: ExtractedCard;
  /** How many chunks the session was sliced into. 1 for a single-call session. */
  chunks: number;
  verified: VerifyTotals;
  drops: DroppedClaim[];
  /** Coverage measured after any supplement. Null when there was nothing to measure. */
  coverage: CoverageReport | null;
  /** Coverage as first measured, before the supplement. */
  coverageBefore: CoverageReport | null;
  supplemented: boolean;
  dedupeRemoved: number;
  spend: ExtractSpend;
  /** Both JSON attempts failed somewhere; the card is title + summary only. */
  degraded: boolean;
  model: string;
  ms: number;
  /**
   * Citations that survived to the finished card without resolving. Always
   * empty — `verify.ts` prunes them — and asserted rather than assumed,
   * because "100% of `decisions[].evidence_seq` resolve" is the acceptance
   * criterion and an invariant nobody checks is a wish.
   */
  unresolved: { claim: string; seq: number }[];
}

export async function cardTranscript(
  llm: Llm,
  transcript: Transcript,
  options: CardPipelineOptions = {},
): Promise<CardResult> {
  const started = Date.now();
  const embedder =
    options.embedder ??
    cachedEmbedder({
      ...(options.embed ? { embed: options.embed } : {}),
      ...(options.embeddings ? { embeddings: options.embeddings } : {}),
    });
  // The store already holds a vector for every exchange it embedded. Priming
  // the cache with them is what makes step 3 affordable: coverage compares
  // every exchange against every item, and at ~190 ms a forward pass a
  // 60-exchange session would otherwise pay 11 s before the first model call.
  for (const unit of transcript.units) {
    if (unit.embedding) embedder.prime(unit.text, unit.embedding);
  }

  // ---- 1 + 2: slice and extract
  const extracted = await extractCard(llm, transcript, {
    ...(options.prior ? { prior: options.prior } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.gate ? { gate: options.gate } : {}),
  });
  options.onStep?.('extract', `${extracted.chunks} chunk(s), ${extracted.spend.calls} call(s)`);
  let card = extracted.card;
  const spend = { ...extracted.spend };
  const degraded = !extracted.parsed;

  // ---- 3: coverage, and at most one supplement
  let coverageBefore: CoverageReport | null = null;
  let coverage: CoverageReport | null = null;
  let supplemented = false;
  if (options.coverage !== false) {
    coverageBefore = await measureCoverage(transcript.units, card, embedder.embed);
    coverage = coverageBefore;
    options.onStep?.(
      'coverage',
      `${coverageBefore.covered}/${coverageBefore.total} covered`,
    );
    if (coverageBefore.needsSupplement && coverageBefore.uncovered.length > 0) {
      const extra = await supplementCard(llm, transcript, coverageBefore.uncovered, card, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.gate ? { gate: options.gate } : {}),
      });
      spend.calls += extra.spend.calls;
      spend.inputTokens += extra.spend.inputTokens;
      spend.outputTokens += extra.spend.outputTokens;
      spend.usd += extra.spend.usd;
      spend.ms += extra.spend.ms;
      card = mergeSupplement(card, extra.card);
      supplemented = true;
      coverage = await measureCoverage(transcript.units, card, embedder.embed);
      options.onStep?.(
        'supplement',
        `${coverageBefore.uncovered.length} uncovered → ${coverage.uncovered.length}`,
      );
    }
  }

  // ---- 4: verify. No model runs past this line.
  //
  // A ghost brings one extra rule with it (`cards/ghost.ts`): a decision is
  // kept only when a prompt *states* it. It is applied here, inside the same
  // filter and with the same lookup-not-model discipline, so that a claim the
  // supplement added faces it exactly as the first pass's claims do.
  const verified = await verifyCard(card, transcript.units, embedder.embed, {
    ...(options.verifyCosine !== undefined ? { cosine: options.verifyCosine } : {}),
    ...(transcript.kind === 'ghost' ? { claimGate: ghostClaimGate } : {}),
  });
  card = verified.card;
  options.onStep?.('verify', `${verified.verified.kept} kept, ${verified.verified.dropped} dropped`);

  // ---- 5: dedupe
  const deduped = await dedupeCard(card, embedder.embed, options.dedupeCosine);
  card = normaliseCard(deduped.card);
  options.onStep?.('dedupe', `${deduped.report.removed} removed`);

  // A degraded card asserts nothing, so it must not carry a title that claims
  // the session was something. `fallbackCard` already writes one that says so.
  if (!card.title.trim()) {
    card = normaliseCard({ ...card, title: transcript.title ?? transcript.id.slice(0, 8) });
  }

  // A ghost's outcome is `unknown`, always, and it is taken rather than asked
  // for. Whether a session shipped is a fact about what the assistant did, and
  // a ghost has none of that — so a model shown ten confident prompts will
  // answer `shipped`, and the answer is removed instead of trusted.
  // `cards/ghost.ts` has the rest of the reasoning.
  if (transcript.kind === 'ghost' && card.outcome !== 'unknown') {
    card = { ...card, outcome: 'unknown' };
  }

  // `verified.kept` as the receipt reports it is a count of **claims the card
  // holds**, not of claims that passed step 4. The two differ, and they differ
  // by design: dedupe runs after verify, so a claim can pass verification and
  // then be absorbed by an identical one. The run receipt said 224 kept where
  // the database held 218 (T2.7 D7) — six claims that were verified and then
  // correctly deduplicated, reported as if they were on disk. What is counted
  // here is what was written. `dropped` still counts step 4's drops, because
  // that is what it is named after and a deduplicated claim was not dropped:
  // its text survives in the twin that absorbed it, which is why
  // `dedupeRemoved` is a separate number.
  const written = card.decisions.length + card.open_threads.length;

  return {
    transcript,
    card,
    chunks: extracted.chunks,
    verified: { kept: written, dropped: verified.verified.dropped },
    drops: verified.drops,
    coverage,
    coverageBefore,
    supplemented,
    dedupeRemoved: deduped.report.removed,
    spend,
    degraded,
    model: extracted.model,
    ms: Date.now() - started,
    unresolved: unresolvedEvidence(card, transcript.units),
  };
}
