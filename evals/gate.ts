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
 * fusion actually buys and the number a regression in the fusion destroys
 * first. `tests/evals-gate.test.ts` pins each of them with the shape of
 * numbers that breaks it, and one end-to-end run proves the whole instrument
 * can still go red on demand.
 *
 * ## The regression control, corrected 25 aug 2026 (P11 step 1)
 *
 * **The control is `--no-vector-lists`, and until this correction this file
 * named `--vector-weight 0` instead, with numbers from a build that no longer
 * exists.** Both statements this paragraph used to make — that the probe
 * "collapses hybrid onto bm25 and therefore ties it at recall@1", and the
 * companion claim in `tests/evals-gate.test.ts` that it "lands 11 under the
 * floor" — were true of the pre-FIX-I ordering and are false of this build.
 *
 * Why they stopped being true: before FIX-I the fused score was the only thing
 * that ordered the page, so zeroing a list's weight erased everything that
 * list could do. Since FIX-I the page is ordered by `byLabel` — lane,
 * confidence word, `calibration.score`, then the fused score — and
 * `calibrate()` reads `from[].raw` and how many lists found the row, neither
 * of which is a weight. A zero-weighted list therefore still runs, still
 * admits candidates, and still corroborates. Measured on this commit, on the
 * committed 60-query fixture set:
 *
 * ```
 * pnpm evals -- --vector-weight 0     # exits 1, but on ONE clause
 *   bm25    @5 40/60  @1 31/60
 *   vectors @5 52/60  @1 37/60
 *   hybrid  @5 52/60  @1 33/60
 *   ✓ ≥ bm25 (40)  ✓ ≥ vectors (52)  ✓ ≥ 51/60 · ✓ > bm25 (31)  ✗ > vectors (37)
 * ```
 *
 * Hybrid does not collapse onto bm25: 52 against 40 at recall@5. **Twelve
 * queries are bought by lists whose weight is zero**, it clears the floor by
 * one, and it beats bm25 at recall@1. The probe was down to a single clause,
 * and the single clause it fails is the one the *shipped* build already fails
 * — so it proved nothing the release run did not already prove.
 *
 * `--no-vector-lists` drops the three vector lists from every mode, the way
 * `--no-cards` drops the two card lists, on the same embedded index. Measured
 * on this commit:
 *
 * ```
 * pnpm evals -- --no-vector-lists     # exits 1, on TWO independent clauses
 *   bm25    @5 40/60  @1 31/60
 *   vectors @5  0/60  @1  0/60        (no lists left to search)
 *   hybrid  @5 40/60  @1 31/60
 *   ✓ ≥ bm25 (40)  ✓ ≥ vectors (0)  ✗ ≥ 51/60 · ✗ > bm25 (31)  ✓ > vectors (0)
 * ```
 *
 * Hybrid is now bm25, exactly and to the digit, so:
 *
 *   1. **`tight.beatsBm25` is false** — 31 against 31 is a tie, and the
 *      amended gate demands a strict win at the metric fusion exists for.
 *   2. **`clearsBar` is false** — 40/60 is eleven under the 51/60 ratchet.
 *
 * Two clauses, from two different halves of the rule, on one probe. That is
 * what makes this a gate rather than a rubber stamp, and it is reproducible
 * today by anyone who runs the command.
 */

/** `plans/06`: phase 1's gate is ≥ 8/10 on bm25 alone. */
export const PHASE_1_GATE = 0.8;

/**
 * The absolute floor, as a **ratchet** rather than a carried-over percentage.
 *
 * `plans/06` set it at 22/25 — 88% — and phase 8.5's amendment kept it. Phase
 * 10 replaced the instrument: the 25-query set decided its verdict on a margin
 * of one against noise of about 2.2, and the 60-query set that replaced it
 * covers all twelve ghosts where the old covered five. A ghost has no
 * recoverable assistant side, so the same retrieval scores *lower* on the new
 * set by construction. 88% was a measured value on a retired instrument, not an
 * independently derived floor, and comparing 51/60 against it is comparing two
 * different tests.
 *
 * **Ruled by the author of the original gate (24 aug 2026): ratchet at the
 * measured value. It may never fall. It lowers — meaning tightens — only when
 * retrieval improves, never rises to accommodate a regression.** This is the
 * discipline `scripts/check-privacy.py` already runs on its id ceiling, in this
 * repository, for the same reason: a number nobody can derive is still worth
 * keeping as a thing that must not get worse.
 *
 * Deriving a principled absolute floor from what a user actually needs is on
 * the P2 list and blocks nothing.
 *
 * What did NOT move, by the same ruling: both fusion clauses, and the
 * requirement that a regression check exist at all. The ratchet is the floor
 * alone. (Which *command* is that check was corrected on 25 aug 2026 — see the
 * header. The clause it has to redden did not change.)
 */
export const PHASE_3_FLOOR = { hits: 51, of: 60 } as const;

/** The floor as a ratio, for a set of a different size. */
export const PHASE_3_GATE = PHASE_3_FLOOR.hits / PHASE_3_FLOOR.of;

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
