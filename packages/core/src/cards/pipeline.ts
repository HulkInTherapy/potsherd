import type { EmbeddingsOptions } from '../embeddings.js';
import type { Llm } from '../llm.js';
import { measureCoverage, mergeSupplement, type CoverageReport } from './coverage.js';
import { dedupeCard } from './dedupe.js';
import { extractCard, supplementCard, type ExtractSpend } from './extract.js';
import type { Gate } from './gate.js';
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
  const verified = await verifyCard(card, transcript.units, embedder.embed, {
    ...(options.verifyCosine !== undefined ? { cosine: options.verifyCosine } : {}),
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

  return {
    transcript,
    card,
    chunks: extracted.chunks,
    verified: verified.verified,
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
