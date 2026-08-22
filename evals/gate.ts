/**
 * T8.5 — the fusion gate, on its own, so that it can be tested without running
 * an eval.
 *
 * ## Why this file exists at all
 *
 * `pnpm evals` has exited 1 since phase 3. The gate `plans/06` wrote was
 *
 *   *phase 3 ≥ 22/25 hybrid, and hybrid must beat bm25-only and vec-only on
 *   the same set, or the fusion is not merged.*
 *
 * and "beat" was implemented as a strict `>` at recall@5. Measured, every run
 * since:
 *
 * ```
 * recall@5:  bm25 11/25 · vectors 22/25 · hybrid 22/25
 * recall@1:  bm25  9/25 · vectors  6/25 · hybrid 11/25
 * ```
 *
 * recall@5 is a **three-way tie at the ceiling of a 25-query set**, and a
 * strict `>` against a saturated metric can only be passed by making the set
 * easier or the weights fit the set. Phases 3, 4, 5, 6 and 7 each looked at
 * the two available fixes — re-tune the vector weight to 2.0 (fitting a
 * constant to the 25 queries that score it, when `1.5` is recorded as a
 * **stopping rule** rather than an argmax) or add recall@1 to the gate — and
 * each judged both dishonest for a worker to do unilaterally. They were right
 * to: neither is a change a build should make to its own exam.
 *
 * ## The amendment
 *
 * On 22 aug 2026 the author of the original gate amended it
 * (`plans/phases/phase-8-hardening.md` §8.5):
 *
 *   **hybrid must be ≥ both singles at recall@5, *and* strictly above both at
 *   recall@1.**
 *
 * The rationale, in the amendment's own words: recall@5 saturates on a
 * 25-query set — a three-way tie at 22 is the ceiling, not a failure — and
 * recall@1 is the metric a user experiences, because it is whether the answer
 * is the first row. The weights are untouched: `WEIGHTS.vec_* = 1.5` is still
 * the phase-3 stopping rule and nothing was re-tuned to clear this.
 *
 * ## What keeps it a gate and not a rubber stamp
 *
 * `plans/08` rule 4: *a benchmark that cannot fail is worse than no
 * benchmark.* Four separate conditions here can still go red, and the one that
 * matters most is `recall@1 strictly above both singles` — that is the number
 * fusion actually buys (11 against 9 and 6) and the number a regression in the
 * fusion destroys first. `tests/evals-gate.test.ts` pins each of them with the
 * shape of numbers that breaks it, including the measured shape of the
 * `--vector-weight 0` regression:
 *
 * ```
 * pnpm evals -- --vector-weight 0        # measured 22 aug 2026: exits 1
 * ```
 *
 * which collapses hybrid onto bm25 and therefore ties it at recall@1, where
 * the amended gate demands a strict win.
 */

/** `plans/06`: phase 1's gate is ≥ 8/10 on bm25 alone. */
export const PHASE_1_GATE = 0.8;

/**
 * `plans/06`'s absolute bar, kept by the amendment: hybrid ≥ 22/25 at
 * recall@k. The amendment changed how hybrid is compared *against the
 * singles*; it did not lower the floor, and a fusion that fell under 22/25
 * would still be refused.
 */
export const PHASE_3_GATE = 22 / 25;

/** recall@1 and recall@k for one retrieval mode, over the same query set. */
export interface ModeScore {
  /** Answers that came back first. */
  at1: number;
  /** Answers that came back in the top `k`. */
  atK: number;
}

/** The three modes the gate compares. `hybrid` is whichever fusion is judged. */
export interface GateInput {
  bm25: ModeScore;
  vectors: ModeScore;
  hybrid: ModeScore;
}

/** One half of the gate: a comparison of hybrid against both singles. */
export interface GateHalf {
  /** `'>='` at recall@k, `'>'` at recall@1. Printed and serialised, not implied. */
  comparison: '>=' | '>';
  hybrid: number;
  bm25: number;
  vectors: number;
  /** hybrid ≥ bm25 (at k) or hybrid > bm25 (at 1). */
  beatsBm25: boolean;
  beatsVectors: boolean;
}

export interface Gate {
  /** The mode being judged: `hybrid` (what `find` runs) or `always`. */
  mode: string;
  k: number;
  total: number;
  /** The amended rule, in words, for anything that renders this without the runner. */
  rule: string;
  /** hybrid ≥ both singles at recall@k. */
  wide: GateHalf;
  /** hybrid strictly above both singles at recall@1. */
  tight: GateHalf;
  /** hybrid/total ≥ {@link PHASE_3_GATE} at recall@k. */
  clearsBar: boolean;
  /** The bar as a count, for printing. */
  bar: number;
  pass: boolean;
}

/**
 * The amended rule as one sentence, parameterised by the run's `k` and set
 * size.
 *
 * It names both comparison operators explicitly. Somebody reading a screenshot
 * of a passing run has to be able to tell *which* gate passed, and "hybrid
 * beats both singles" was ambiguous enough to cost this project five phases.
 */
export const ruleLine = (k: number, total: number): string =>
  `hybrid ≥ both singles at recall@${k} (a ${total}-query set saturates there) ` +
  `and strictly > both at recall@1 (the row the user actually sees), ` +
  `with recall@${k} ≥ ${Math.round(PHASE_3_GATE * total)}/${total}`;

/**
 * Judge one fusion mode against both singles under the amended rule.
 *
 * Pure: it takes counts and returns a verdict. Everything about running an
 * index, embedding a corpus or finding a model lives in `run.ts`, so this can
 * be tested with numbers a test writes itself rather than numbers a machine
 * happens to produce.
 */
export function judge(mode: string, scores: GateInput, total: number, k: number): Gate {
  const wide: GateHalf = {
    comparison: '>=',
    hybrid: scores.hybrid.atK,
    bm25: scores.bm25.atK,
    vectors: scores.vectors.atK,
    beatsBm25: scores.hybrid.atK >= scores.bm25.atK,
    beatsVectors: scores.hybrid.atK >= scores.vectors.atK,
  };
  const tight: GateHalf = {
    comparison: '>',
    hybrid: scores.hybrid.at1,
    bm25: scores.bm25.at1,
    vectors: scores.vectors.at1,
    beatsBm25: scores.hybrid.at1 > scores.bm25.at1,
    beatsVectors: scores.hybrid.at1 > scores.vectors.at1,
  };
  const clearsBar = total > 0 && scores.hybrid.atK / total >= PHASE_3_GATE;
  return {
    mode,
    k,
    total,
    rule: ruleLine(k, total),
    wide,
    tight,
    clearsBar,
    bar: Math.round(PHASE_3_GATE * total),
    pass:
      wide.beatsBm25 && wide.beatsVectors && tight.beatsBm25 && tight.beatsVectors && clearsBar,
  };
}
