import type { Db } from './db.js';
import { ESTIMATOR_FIT } from './llm.js';
import type { Backend, Calibration, Estimate } from './llm.js';
import { wordMatchesToken, wordSpans } from './search/snippet.js';

/**
 * The estimator's self-check: what a run was quoted at, what it cost, and how
 * the next quote uses the difference.
 *
 * `03` §12's card budget has been wrong twice now, both times because a number
 * measured on a toy prompt was extrapolated to a real one. `llm.ts` re-fits
 * the constants against real calls, and that fixes the reference machine. This
 * module is what fixes everybody else's: after each finished `card` run,
 * `recordCardRun` writes one row saying predicted-vs-actual, and the next
 * `planCards` multiplies its estimate by what those rows say.
 *
 * Three rules, each of which exists because the alternative is a number that
 * lies:
 *
 *   1. **Only finished runs count.** A run stopped by `--max-usd`, or one that
 *      lost targets to errors, is recorded with `complete = 0` and never used
 *      as evidence. It did less work than it was quoted for, so its ratio is
 *      arithmetic about nothing.
 *   1a. **Only runs quoted by *this* estimator count** ({@link ESTIMATOR_FIT},
 *      T10.11). A row is a record of what one run was told by the constants
 *      that were compiled that day. Re-fit those constants and the row becomes
 *      a measurement of a different estimator, and averaging it into a
 *      correction on top of the new one applies the same error twice — which
 *      is not hypothetical: the two rows on the reference machine are the
 *      evidence for the current fit, and left unfiltered they would multiply
 *      the already-corrected quote by 1.66 again.
 *   2. **Only runs big enough to mean something.** {@link MIN_CALLS} calls.
 *      One session finishing 30% fast is noise, and correcting a 200-call
 *      quote by it would be worse than not correcting at all.
 *   3. **The correction is visible.** {@link Calibration.samples} rides along
 *      to the screen, so the card can say "×1.2 from 3 runs on this machine"
 *      rather than silently moving the number a user is about to trust.
 */

/** A run smaller than this is not evidence about a big one. */
export const MIN_CALLS = 5;

/** How many recent runs the correction averages over. */
export const CALIBRATION_WINDOW = 5;

/**
 * The furthest a correction may move a quote.
 *
 * A ratio outside this is far more likely to be a bug — a run recorded against
 * the wrong estimate, a clock jump — than a machine that is genuinely twenty
 * times slower, and a self-correcting estimator with no clamp is one bad row
 * away from quoting nonsense forever.
 */
export const MAX_RATIO = 5;
export const MIN_RATIO = 1 / MAX_RATIO;

export interface CardRunRecord {
  ranAt?: string;
  backend: Backend;
  model: string;
  concurrency: number;
  targets: number;
  predictedCalls: number;
  predictedSeconds: number;
  predictedUsd: number;
  actualCalls: number;
  actualSeconds: number;
  actualUsd: number;
  /** False when a ceiling stopped the run or any target failed. */
  complete: boolean;
}

export interface CardRunRow extends CardRunRecord {
  id: number;
  ranAt: string;
  timeRatio: number;
  usdRatio: number;
}

/**
 * Record what one run predicted and what it did.
 *
 * Ratios are stored, not recomputed on read, so a row stays meaningful after
 * the constants in `llm.ts` are re-fitted: it is a record of what *that* run
 * was told and what happened, which is exactly what an estimate needs to be
 * checkable after the fact.
 */
export function recordCardRun(db: Db, run: CardRunRecord): CardRunRow {
  const ranAt = run.ranAt ?? new Date().toISOString();
  const timeRatio = ratio(run.actualSeconds, run.predictedSeconds);
  const usdRatio = ratio(run.actualUsd, run.predictedUsd);
  const info = db
    .prepare(
      `INSERT INTO card_runs
         (ran_at, backend, model, concurrency, targets,
          predicted_calls, predicted_seconds, predicted_usd,
          actual_calls, actual_seconds, actual_usd,
          time_ratio, usd_ratio, complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ranAt,
      run.backend,
      run.model,
      run.concurrency,
      run.targets,
      run.predictedCalls,
      run.predictedSeconds,
      run.predictedUsd,
      run.actualCalls,
      run.actualSeconds,
      run.actualUsd,
      timeRatio,
      usdRatio,
      run.complete ? 1 : 0,
    );
  return { ...run, ranAt, id: Number(info.lastInsertRowid), timeRatio, usdRatio };
}

/**
 * What this machine's own finished runs say the quote is out by.
 *
 * `null` when there is nothing usable, which is the common case and must stay
 * cheap: the first run on a machine is quoted from the fitted constants alone
 * and says so. It is also, after T10.11's re-fit, the answer on the reference
 * machine itself: both of its recorded runs pre-date {@link ESTIMATOR_FIT} and
 * both were stopped early, so they are evidence *for* the constants rather
 * than a correction *on* them.
 */
export function readCalibration(
  db: Db,
  o: { backend?: Backend; model?: string; window?: number; fittedAt?: string } = {},
): Calibration | null {
  // The test seam is the *only* reason this is a parameter: production has
  // exactly one answer and it is the constant compiled beside the fit.
  const fittedAt = o.fittedAt ?? ESTIMATOR_FIT;
  let rows: { time_ratio: number; usd_ratio: number; ran_at: string }[];
  try {
    rows = db
      .prepare(
        `SELECT time_ratio, usd_ratio, ran_at
           FROM card_runs
          WHERE complete = 1
            AND actual_calls >= ?
            AND ran_at >= ?
            AND predicted_seconds > 0
            AND predicted_usd > 0
            ${o.backend ? 'AND backend = ?' : ''}
          ORDER BY ran_at DESC, id DESC
          LIMIT ?`,
      )
      .all(
        ...(o.backend
          ? [MIN_CALLS, fittedAt, o.backend, o.window ?? CALIBRATION_WINDOW]
          : [MIN_CALLS, fittedAt, o.window ?? CALIBRATION_WINDOW]),
      ) as { time_ratio: number; usd_ratio: number; ran_at: string }[];
  } catch {
    // A database from before migration 6. No table, no correction, no crash:
    // the estimate is still the fitted one and the card still renders.
    return null;
  }
  if (rows.length === 0) return null;

  const cal: Calibration = {
    timeRatio: clamp(median(rows.map((r) => r.time_ratio))),
    usdRatio: clamp(median(rows.map((r) => r.usd_ratio))),
    samples: rows.length,
  };
  const last = rows[0]?.ran_at;
  return last ? { ...cal, lastRanAt: last } : cal;
}

/** The rows themselves, newest first — for `doctor` and for a test. */
export function cardRuns(db: Db, limit = 20): CardRunRow[] {
  try {
    const rows = db
      .prepare(`SELECT * FROM card_runs ORDER BY ran_at DESC, id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r['id']),
      ranAt: String(r['ran_at']),
      backend: String(r['backend']) as Backend,
      model: String(r['model']),
      concurrency: Number(r['concurrency']),
      targets: Number(r['targets']),
      predictedCalls: Number(r['predicted_calls']),
      predictedSeconds: Number(r['predicted_seconds']),
      predictedUsd: Number(r['predicted_usd']),
      actualCalls: Number(r['actual_calls']),
      actualSeconds: Number(r['actual_seconds']),
      actualUsd: Number(r['actual_usd']),
      timeRatio: Number(r['time_ratio']),
      usdRatio: Number(r['usd_ratio']),
      complete: Number(r['complete']) === 1,
    }));
  } catch {
    return [];
  }
}

/**
 * The one line a receipt owes the user after a run: how the quote did.
 *
 * Named here rather than in a renderer because both the human card and
 * `--json` need the same sentence, and because a self-correcting estimator
 * that never shows its own error is just a different way of being confident.
 */
export function accuracyNote(run: {
  predictedSeconds: number;
  actualSeconds: number;
  predictedUsd: number;
  actualUsd: number;
}): string {
  const t = ratio(run.actualSeconds, run.predictedSeconds);
  const u = ratio(run.actualUsd, run.predictedUsd);
  return `the estimate was ${describe(t)} on time and ${describe(u)} on cost`;
}

/**
 * The same comparison, short enough for a card's note column (43 columns at
 * an 80-column terminal). The label and value carry the rest of the sentence.
 */
export function accuracyShort(run: {
  predictedSeconds: number;
  actualSeconds: number;
  predictedUsd: number;
  actualUsd: number;
}): string {
  const t = describe(ratio(run.actualSeconds, run.predictedSeconds));
  const u = describe(ratio(run.actualUsd, run.predictedUsd));
  return `${t} on time, ${u} on cost`;
}

function describe(r: number): string {
  if (r >= 0.9 && r <= 1.1) return 'right';
  // ASCII `x`, not `×`: this string goes into a card note that may be
  // rendered under `--ascii`, and it has no Theme to ask.
  return r > 1 ? `${r.toFixed(1)}x under` : `${(1 / r).toFixed(1)}x over`;
}

function ratio(actual: number, predicted: number): number {
  if (!(predicted > 0) || !(actual > 0)) return 1;
  return actual / predicted;
}

function clamp(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : ((s[mid - 1]! + s[mid]!) / 2);
}

/** Predicted-vs-actual for one finished run, from the plan's own estimate. */
export function compareToEstimate(
  e: Estimate,
  actual: { calls: number; seconds: number; usd: number },
): { timeRatio: number; usdRatio: number } {
  return {
    timeRatio: ratio(actual.seconds, e.seconds),
    usdRatio: ratio(actual.usd, e.usd),
  };
}

// ===================================================================
// retrieval confidence — F1, "a cliff, not a ranking"
// ===================================================================

/**
 * The second axis of `find`, and the reason this section is in the file named
 * `calibration` rather than in `recall.ts`: both halves answer the same
 * question — *how much should the number on the screen be trusted?* — and
 * neither of them is the ranker.
 *
 * ## The defect this exists to fix
 *
 * Measured on the reference archive at `99bbb8b` (433 MB, 332 transcripts),
 * `index --no-embed`:
 *
 * ```
 * potsherd find "privacy guard redaction"            4 rows, top 0.01836   true topic
 * potsherd find "kubernetes ingress payment service"  2 rows, top 0.01639   absent topic
 * ```
 *
 * A topic the archive answers and a topic the archive has never heard of are
 * **1.12x** apart. An agent given those two numbers cannot tell them apart,
 * so it does the rational thing and stops trusting the whole result set.
 *
 * ## Why the obvious fix cannot work
 *
 * The fused score is reciprocal rank fusion: `weight * 1/(k + rank)`. It is a
 * function of **rank only** — by the time it exists, how *well* anything
 * matched has already been discarded. Normalising it against the query's own
 * distribution therefore maps the top row to 1.0 whether that row is a
 * bullseye or the least-bad of two bad rows, and `kubernetes ingress payment
 * service` would come out as a confident 1.0. RRF stays the ranker; this is a
 * separate axis computed from evidence RRF throws away.
 *
 * ## What it is computed from
 *
 * Three things, all of which `recall()` already has and none of which is the
 * fused score:
 *
 *   1. **coverage** — of the distinctive words the user typed, what fraction
 *      does this row actually contain. Counted with the same prefix-tolerant
 *      matcher the snippet highlighter uses, over the same text the reader is
 *      about to be shown, so the number and the screen cannot disagree.
 *   2. **strength** — `from[].raw`: the list's *own* magnitude for this row
 *      (bm25, or cosine), as a fraction of the best magnitude that same list
 *      produced for this same query. Relative, never absolute: a bm25 of -13
 *      means nothing across corpora and everything against the -18 the same
 *      query got from the same index.
 *   3. **agreement** — how many **independent bodies of evidence** put this
 *      row in their candidates. One is a claim; three are a corroboration.
 *      *Independent* is load-bearing and was, until P11, only aspirational:
 *      `recall()` passed a count of *lists*, and `exchanges_fts` beside
 *      `vec_exchanges` is one exchange retrieved twice rather than two things
 *      agreeing. `recall.ts`'s `SOURCE_OF_LIST` is where the eight lists are
 *      mapped onto the four bodies of text they read, and it carries the
 *      measurement that made this necessary.
 *
 * and combines them **multiplicatively on coverage**:
 *
 * ```
 * calibrated = coverage * (BASE + W_STRENGTH * strength + W_AGREEMENT * agreement)
 * ```
 *
 * The shape is the whole point. Coverage is a *ceiling*: no amount of
 * corroboration and no bm25 magnitude can lift a row whose words are not
 * there. That is the cliff. Strength and agreement only decide how far a row
 * falls *below* its own coverage — which is what separates the exchange that
 * is about the pooler decision from the one that mentions the word once.
 *
 * ## Scale
 *
 * Every input is a ratio against something the same query produced on the same
 * index. Nothing here is an absolute magnitude, so nothing here should move
 * when the corpus grows from 0.5 MB to 433 MB. That was a design constraint,
 * not a discovery: a floor expressed in bm25 units would have to be re-fitted
 * per machine and would be wrong on the first one that was not the author's.
 */
export type Confidence = 'strong' | 'weak' | 'none';

/** Worst to best, so a minimum can be compared as a number. */
const RANK: Record<Confidence, number> = { none: 0, weak: 1, strong: 2 };

/** `a` is at least as confident as `b`. */
export function atLeastConfident(a: Confidence, b: Confidence): boolean {
  return RANK[a] >= RANK[b];
}

/** The better of two labels. */
export function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * How much of the calibrated score a row gets for merely being a match at all.
 *
 * With `WEIGHT_STRENGTH` and `WEIGHT_AGREEMENT` this is a partition of 1, so a
 * perfectly corroborated top-of-every-list row scores exactly its coverage and
 * nothing scores above it.
 */
export const WEIGHT_BASE = 0.6;

/** What the list's own magnitude, relative to that list's best, is worth. */
export const WEIGHT_STRENGTH = 0.25;

/** What independent lists agreeing is worth. */
export const WEIGHT_AGREEMENT = 0.15;

/**
 * Independent bodies of evidence that have to agree before agreement is worth
 * its full share.
 *
 * Three, not eight: on a text-only index four of the eight lists cannot run at
 * all, and a rule that needed all of them would score every result on a
 * `--no-embed` machine as uncorroborated. Three is the most a bm25-only index
 * can produce for one row: `exchanges_fts` + `titles` + `cards_fts`.
 *
 * **This number never moved, and P11 did not move it.** What changed is the
 * quantity it is the denominator of. The three lists named above are three
 * different *bodies of text* — a transcript, a session name, a summary — and
 * that is how the value 3 was derived; the code was dividing a count of
 * **lists** by it, and the two agree only while the semantic lane is off. The
 * second of the two examples this docstring used to give, *"or the two ghost
 * lists plus a title"*, is the sentence that gives the confusion away: it
 * counts `ghosts_fts` and `ghost_prompts_fts` as two, and they are one ghost
 * read at two granularities. It has been removed rather than corrected,
 * because it was never a second way of reaching three.
 *
 * `recall.ts`'s `SOURCE_OF_LIST` is the mapping, and it is there rather than
 * here for the reason `ROUTING_CEILING` is here rather than there: this file
 * owns what `agreement` *means*, `recall.ts` owns which of its lists are
 * looking at the same words.
 */
export const AGREEMENT_LISTS = 3;

/**
 * The floor. Below this a row is `none`, and `find` returns it to nobody.
 *
 * **This is a stopping rule, not an argmax.** It was not fitted to the six
 * queries that score it — phase 3 recorded `WEIGHTS.vec_* = 1.5` the same way
 * and for the same reason, and a constant tuned against its own exam is not
 * evidence of anything. It is 0.5 because 0.5 is the only number in the range
 * with an argument attached: at a rank-1 row of an uncorroborated list
 * (`strength` 1, `agreement` 0, so a multiplier of 0.85) it means **a row must
 * show a clear majority of the distinctive words that were typed** — 2 of 3,
 * 3 of 4, 3 of 5. A row showing half or fewer is answering a different
 * question than the one asked, and the honest thing to do with it is not to
 * show it.
 *
 * What was measured, and what it decided: on the demo corpus (0.5 MB, 31
 * sessions, 299 ghosts) the true-topic queries put every kept row at coverage
 * 1.0 and every dropped row at 1/3 or 1/4. The gap either side of this number
 * is a factor of three, so the number is not sitting on a cliff edge — which
 * is the only property a threshold has to have. `tests/calibration.test.ts`
 * fails when it moves, in both directions (`plans/08` rule 3).
 */
export const WEAK_FLOOR = 0.5;

/**
 * `strong` — the archive answers this.
 *
 * 0.75, by the same argument as {@link WEAK_FLOOR} and the same stopping rule.
 * At the uncorroborated rank-1 multiplier of 0.85 it means **essentially all
 * of the distinctive words are present in one conversation**; a row missing a
 * quarter of them can still reach `strong`, but only by being corroborated by
 * a second and third list, which is a different kind of evidence for the same
 * claim. An agent may act on `strong` without reading the rows. That is what
 * it is for, and it is why the bar is where it is rather than one band lower.
 */
export const STRONG_FLOOR = 0.75;

/**
 * The best a row whose only evidence is a **card** may ever be labelled.
 *
 * F6, and the reason it is a constant here rather than a rule in `recall.ts`:
 * `strong` is a promise with a documented meaning — *an agent may act on this
 * without reading the rows* — and this file is where that promise is defined.
 *
 * Why a card cannot keep it. A card is the artefact of a model call over a
 * transcript. Coverage, the ceiling every other row is judged by, is counted
 * over the text the row can show; for a card that text is the summary, so a
 * card that happens to have paraphrased the user's question covers it
 * perfectly and, at rank 1 of an uncorroborated list, scores
 * `1.0 x (0.6 + 0.25) = 0.85` — comfortably {@link STRONG_FLOOR}. Corroborated
 * by `vec_cards` it reaches 0.925. That is a summary certifying itself, and it
 * was reachable before T10.7: `tests/cards-lane.test.ts` measures both numbers
 * and then asserts the label is `weak` anyway.
 *
 * `weak` rather than `none`, deliberately. `none` would delete card-only rows
 * at `find`'s default floor and turn the demotion into a silencing — and
 * routing is the job Bet 02 was restated to *keep*. A card says "this thread
 * is probably worth opening", which is exactly what `weak` means: worth a
 * reader, not worth acting on.
 */
export const ROUTING_CEILING: Confidence = 'weak';

/**
 * How many of the query's **distinctive** terms a row must be able to show
 * before it may carry any label at all.
 *
 * One, and it is a *necessary condition* rather than a weight — which is the
 * whole difference between this and the IDF-weighted coverage T10.1 measured
 * and rejected (`T10.1-REPORT.md` §d1). Nothing here multiplies a score by a
 * rarity; a term's rarity decides only whether it is *in* the distinctive set,
 * and the set is chosen by relative rank on this index (`keyphrase.ts`), never
 * by a magnitude. T10.1's objection — that df-0 words get the highest IDF and
 * so the least informative words dominate — cannot arise, because
 * `selectTerms` excludes df-0 terms from the set entirely and, when every word
 * of a query is absent from the index, produces no set and this rule does not
 * fire.
 *
 * ## The defect it exists for, measured
 *
 * `evals/queries.jsonl` control `bluetooth on the checkout page`. The archive
 * has bluetooth (a deleted devices thread) and it has checkout (four web
 * sessions), and it has no conversation about both. The honest answer is zero
 * rows. Measured at `99bbb8b`, on the committed fixture, at the floor `find`
 * runs at:
 *
 * ```
 *   FAIL  zero rows   2 rows weak   bluetooth on the checkout page
 * ```
 *
 * and it fails **identically with vectors off and on an index built with
 * `--no-embed`** — `evals/run.ts` runs its controls at `vectors: false`, so
 * this was never a vector artefact. The arithmetic:
 *
 * ```
 * quotable terms      bluetooth · checkout · page
 * a checkout session  covers 2 of 3        = 0.667
 * x (0.6 + 0.25 x 1)                       = 0.567   >= WEAK_FLOOR
 * ```
 *
 * {@link coveredTerms} is a **uniform** partition: missing `bluetooth` costs
 * exactly what missing `page` would. So a two-topic question can be answered
 * at `weak` by a row that has one topic and not the other, and the half it is
 * missing is the half that named the subject. {@link WEAK_FLOOR}'s own
 * docstring says it means *a clear majority of the distinctive words*; 2 of 3
 * is a clear majority of the words, and the constant was keeping a promise
 * about a different quantity than the one it was measuring.
 *
 * This rule restores that promise **without moving the floor**: whatever a row
 * scores, if it cannot show one single distinctive word of the question, it is
 * not an answer to it.
 */
export const KEY_TERMS_REQUIRED = 1;

/** The worse of two labels — a ceiling, where {@link maxConfidence} is a floor. */
export function capConfidence(a: Confidence, b: Confidence): Confidence {
  return RANK[a] <= RANK[b] ? a : b;
}

/** What one row of a result offers the calibrator. */
export interface RowEvidence {
  /**
   * Distinct query terms this row can actually show, over how many were asked
   * for. `terms` of 0 means the query was all function words; see
   * {@link calibrate}.
   */
  covered: number;
  terms: number;
  /**
   * How hard the evidence behind this row matched, as a fraction of the best
   * the same list produced for the same query. 1 means "this list found
   * nothing better"; 0.4 means "four rows above it in its own list matched
   * harder".
   *
   * Where one row is found by several lists the caller decides how to combine
   * them, and `recall()`'s rule is *mean within a body of evidence, max across
   * them*: two methods scoring one document are two readings to be averaged,
   * two different documents are alternatives of which the best counts. See
   * `strengthOf` in `recall.ts` for the measurement behind that.
   */
  strength: number;
  /**
   * Distinct **independent** bodies of evidence that put this row in their
   * candidates — not distinct indexes. `exchanges_fts` and `vec_exchanges`
   * finding the same exchange is 1, not 2; a transcript hit and a session
   * title is 2. `recall.ts`'s `SOURCE_OF_LIST` is the partition, and
   * {@link AGREEMENT_LISTS} is what this is measured against.
   */
  lists: number;
  /**
   * The best label this row is allowed to carry, whatever it scores.
   *
   * Absent for an ordinary row. `recall()` passes {@link ROUTING_CEILING} for
   * a row whose only evidence is a card (F6). The mechanism is generic and the
   * policy is not: this file owns what `strong` means, `recall.ts` owns which
   * rows are disqualified from claiming it.
   */
  ceiling?: Confidence;
  /**
   * The distinctive terms of the query this row is **required** to show, and
   * how many of them it actually does. `keyTerms` 0 — or both absent — when
   * the query has no distinctive terms to speak of, which is the case for a
   * query whose words are all function words or all absent from the index.
   *
   * The caller decides which terms are required and how many;
   * {@link KEY_TERMS_REQUIRED} is the policy `recall()` applies. Missing any
   * of them caps the row at `none`.
   */
  keyCovered?: number;
  keyTerms?: number;
}

export interface Calibrated {
  /** 0..1. See the header: coverage, gated by strength and agreement. */
  score: number;
  confidence: Confidence;
  /** The three inputs, so `--explain` and a bug report can show the arithmetic. */
  coverage: number;
  strength: number;
  agreement: number;
  /**
   * The cap that was applied, when one was — so `--json` can say *why* a row
   * scoring 0.925 is labelled `weak` rather than leaving a caller to conclude
   * the two numbers disagree.
   *
   * {@link score} is **not** rewritten by the cap. The arithmetic stays true
   * and the label is the thing that is refused; a capped score would have made
   * `coverage x (base + …)` stop reproducing, which is the one property that
   * makes this module debuggable from `--explain` alone.
   */
  ceiling?: Confidence;
}

/**
 * One row's confidence, from evidence the fusion discarded.
 *
 * A query with no distinctive terms at all — `find "the"`, `find "it is"` —
 * has nothing to have covered, and calling that `none` would delete a result
 * the user can plainly see is correct. Coverage is 1 in that case by
 * definition: every word asked for is present, there just were not many.
 */
export function calibrate(e: RowEvidence): Calibrated {
  const coverage = e.terms > 0 ? clamp01(e.covered / e.terms) : 1;
  const strength = clamp01(e.strength);
  const agreement = clamp01((e.lists - 1) / (AGREEMENT_LISTS - 1));
  const score = clamp01(
    coverage * (WEIGHT_BASE + WEIGHT_STRENGTH * strength + WEIGHT_AGREEMENT * agreement),
  );
  // The distinctive-term condition (F8's second half). It is expressed as a
  // *ceiling of `none`* rather than as a term in the arithmetic on purpose:
  // `score` keeps reproducing `coverage x (base + …)` from the three numbers
  // printed beside it, which is the one property that makes this module
  // debuggable from `--explain` alone, and the thing being refused is the
  // label rather than the measurement.
  const missesKeyTerm = (e.keyTerms ?? 0) > 0 && (e.keyCovered ?? 0) < (e.keyTerms ?? 0);
  const ceiling = missesKeyTerm ? capConfidence(e.ceiling ?? 'none', 'none') : e.ceiling;
  // The cap, when the caller named one. `capConfidence` is a `min` over the
  // three-word ladder, so no score can climb past it — which is what makes "a
  // card-only hit cannot reach `strong`" a fact about this function rather
  // than a fact about how well cards happen to score.
  const confidence = ceiling ? capConfidence(label(score), ceiling) : label(score);
  return {
    score,
    confidence,
    coverage,
    strength,
    agreement,
    ...(ceiling ? { ceiling } : {}),
  };
}

/** Which band a calibrated score falls in. */
export function label(score: number): Confidence {
  if (score >= STRONG_FLOOR) return 'strong';
  if (score >= WEAK_FLOOR) return 'weak';
  return 'none';
}

/**
 * A list's own magnitude for one row, as a fraction of that list's best for
 * this query.
 *
 * bm25 is negative and lower is better; cosine is [-1, 1] and higher is
 * better; `titles` has no magnitude at all, because `titleMatches` already
 * dropped every title that did not match the query best — so every title hit
 * that survives is by construction the strongest of its kind.
 *
 * Relative, never absolute. `plans/08` and this task's brief both say the same
 * thing: a rule expressed in bm25 units is a rule that has to be re-fitted for
 * every corpus size, and would be wrong on the first machine that is not the
 * author's.
 */
export function relativeStrength(raw: number, best: number, kind: 'bm25' | 'cosine' | 'flat'): number {
  if (kind === 'flat') return 1;
  if (!Number.isFinite(raw) || !Number.isFinite(best)) return 0;
  if (kind === 'bm25') {
    // Both negative. |best| is the largest magnitude the list produced.
    const b = Math.abs(best);
    if (!(b > 0)) return 1;
    return clamp01(Math.abs(raw) / b);
  }
  if (!(best > 0)) return 0;
  return clamp01(Math.max(0, raw) / best);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * How many of `terms` this text can actually show.
 *
 * Counted with {@link wordMatchesToken} — the same prefix-tolerant matcher the
 * snippet highlighter uses — over the same text the reader is about to see, so
 * the confidence label and the highlighted words on the screen can never
 * disagree. fts5 does not stem, so `find "icons"` against a transcript that
 * says `icon` is two tokens to the ranker and one word to a human; the reader
 * is right and the ranker is the one being explained.
 */
export function coveredTerms(terms: readonly string[], text: string): number {
  if (terms.length === 0 || !text) return 0;
  const words = new Set(wordSpans(text).map((w) => w.word));
  let n = 0;
  for (const t of terms) {
    for (const w of words) {
      if (wordMatchesToken(w, t)) {
        n++;
        break;
      }
    }
  }
  return n;
}
