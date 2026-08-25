/**
 * T8.5 / P11-GATE — the retrieval gate, on its own, so that it can be tested
 * without running an eval.
 *
 * ## The one thing to understand before changing anything here
 *
 * `potsherd` has **two retrieval surfaces**, and until 25 aug 2026 this file
 * only ever judged one of them while its own rule line claimed the other.
 *
 *   * **the ranking** — `recall()` at its library default, `minConfidence:
 *     'none'`. It withholds nothing. It is what `ask` and `graft` build a
 *     shortlist from, and it is the honest measure of *the fusion as a
 *     ranker*.
 *   * **the verb** — `recall()` at `weak`, the floor `potsherd find` and
 *     `potsherd_recall` actually apply. It is **what a user or an agent is
 *     handed**. It is the product.
 *
 * From phase 3 until 24 aug 2026 `evals/run.ts` called the library with no
 * floor, so every recall number this project has ever published — including
 * the ones the clauses below were written against — measured **the ranking**.
 * C-1 step 1 (`phases/phase-11/C1-REPORT.md` §0) fixed the instrument.
 * `evals/run.ts` now runs both and reports both.
 *
 * ## What the fixed instrument says, and why the old rule could not survive it
 *
 * Measured on `70dac23`, 60-query blind set, `pnpm evals`:
 *
 * ```
 *                     at the verb (weak)        at the ranking (none)    empty pages
 *   bm25 only      @5  8/60   @1  8/60      @5 40/60   @1 31/60           51/60
 *   vectors only   @5  8/60   @1  8/60      @5 57/60   @1 40/60           51/60
 *   hybrid (auto)  @5  7/60   @1  7/60      @5 57/60   @1 42/60           52/60
 * ```
 *
 * The pre-existing rule — *hybrid ≥ both singles at recall@5, strictly > both
 * at recall@1, and recall@5 ≥ 51/60* — was pointed at the verb by C-1 and
 * **fails on all five clauses there**, and no tuning can meet it: an
 * exhaustive search over every threshold on every scale-free quantity the
 * index carries bounds F1-safe recall at **16/60** (`C1-REPORT.md` §1). The
 * old floor needed 51.
 *
 * ## The re-scope, and its boundary
 *
 * Ruled 25 aug 2026 by the author of the original gate: *the paraphrase
 * criterion **is not deleted and is not marked met**. It becomes phase 12's
 * named target. Re-scope the shipped gate to what the instrument honestly
 * measures at the verb, floor-aware, and it must still be able to fail.*
 *
 * **The descoped number lives in `phases/phase-12/FIRST-JOB.md`** with the
 * evidence, the exhaustive bound, and the three reverted attempts. It is a
 * carried-forward target, not a met criterion. **This is not a lowered bar; it
 * is two bars where there was one wrongly-aimed bar.** Anyone reading this
 * file who wants to know what was given up reads that file, not this one.
 *
 * So the gate now judges **both surfaces, each on what it can honestly say**:
 *
 *   1. **The ranker keeps every comparative clause**, judged on the ranking
 *      view where they are meaningful and where they were always measured:
 *      hybrid 57/42 against bm25 40/31 and vectors 57/40. Hybrid ties vectors
 *      at recall@5 — a 60-query set saturates there — and **beats it by two at
 *      recall@1**, which is exactly what P11's `agreement` fix bought and the
 *      first thing a fusion regression destroys.
 *   2. **The verb is ratcheted at its measured value and is NOT compared to a
 *      single-lane mode.** See {@link VERB_RATCHET} for the argument.
 *
 * Both must hold. `pass` is their conjunction; a green ranker cannot buy a red
 * verb and a green verb cannot buy a red ranker.
 *
 * ## The regression controls, and what each one now reddens
 *
 * `plans/08` rule 4: *a benchmark that cannot fail is worse than no
 * benchmark.* Two controls exist and **both are red under the re-scoped gate,
 * each on two clauses**. Measured on `70dac23`, 25 aug 2026; all three
 * commands can be run again by anyone.
 *
 * ```
 * pnpm evals                        exit 0   ranker  bm25 40/31  vec 57/40  hyb 57/42
 *                                            verb    bm25  8/8   vec  8/8   hyb  7/7
 *   ✓ ≥ bm25 (40)  ✓ ≥ vectors (57)  ✓ ≥ 51/60 · ✓ > bm25 (31)  ✓ > vectors (40)
 *   ✓ verb ≥ 7/60 @5 and ≥ 7/60 @1        52/60 empty pages, 50 ranked and withheld
 *
 * pnpm evals -- --no-vector-lists   exit 1   ranker  bm25 40/31  vec  0/0   hyb 40/31
 *                                            verb    bm25  8/8   vec  0/0   hyb  8/8
 *   ✓ ≥ bm25 (40)  ✓ ≥ vectors (0)   ✗ ≥ 51/60 · ✗ > bm25 (31)  ✓ > vectors (0)
 *   ✓ verb ≥ 7/60          RED on 2 RANKER clauses: clearsBar, tight.beatsBm25
 *
 * pnpm evals -- --vector-weight 0   exit 1   ranker  bm25 40/31  vec 52/37  hyb 50/38
 *                                            verb    bm25  8/8   vec  8/8   hyb  7/7
 *   ✓ ≥ bm25 (40)  ✗ ≥ vectors (52)  ✗ ≥ 51/60 · ✓ > bm25 (31)  ✓ > vectors (37)
 *   ✓ verb ≥ 7/60          RED on 2 RANKER clauses: wide.beatsVectors, clearsBar
 * ```
 *
 * **Neither control reddens the verb**, and that is stated here rather than
 * left for a reader to notice. Both controls attack the semantic lane, and the
 * verb's floor is computed from *wording*, which no lane can change — with the
 * lane gone hybrid is bm25 and returns 8 at the verb, one *more* than the
 * ratchet. The verb's ratchet is proved able to fail by the seeded regression
 * in `tests/evals-gate.test.ts` — drop the verb by one, ranker untouched, gate
 * red — which is the only control that isolates that surface. There is no
 * command-line switch that regresses the verb without regressing the ranker,
 * and inventing one would mean a product flag that exists only to fail an exam.
 *
 * **`--vector-weight 0` got STRONGER, not weaker, and this is the audit trail.**
 * The record it replaces (`6a157fa`) had it red on **one** clause, `> vectors`
 * at recall@1 — and that was a clause **the shipped run also failed**, so the
 * probe proved nothing the release run did not already prove. On `70dac23` it
 * is red on **two**, `≥ vectors` at recall@5 and the ratchet, and the shipped
 * run passes both. Phase 10 quietly weakened a control and it took a verifier
 * to notice; the clause count for each control is therefore written down here,
 * and moving it means saying so.
 *
 * This paragraph has been wrong twice, both times the same way, and the rule it
 * keeps breaking is its own: *a comment describing a run nobody can reproduce
 * is the failure this project keeps finding.* Every number above and below was
 * re-measured on `70dac23` on 25 aug 2026, after the two instrument changes
 * (C-1 step 1's floor, and P11's `agreement` fix) that made the previous
 * records stale. When they move, move them, and move this paragraph with them.
 */

/** `plans/06`: phase 1's gate is ≥ 8/10 on bm25 alone. Unchanged, unaffected. */
export const PHASE_1_GATE = 0.8;

/**
 * The ranker's absolute floor, as a **ratchet** rather than a carried-over
 * percentage. **Judged on the ranking view** (`recall()` at `none`).
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
 * measured value.** The required count may only ever *rise* — that is what
 * "tighten" means for a recall floor — and it may never be lowered to let a
 * regression through. This is the discipline `scripts/check-privacy.py`
 * already runs on its id ceiling, in this repository, for the same reason: a
 * number nobody can derive is still worth keeping as a thing that must not get
 * worse.
 *
 * **51/60 was and remains a ranking number.** It was measured with no floor
 * applied, in every run from phase 10 onward. C-1 pointed it at the verb for
 * one day, where it is unreachable by 35 queries; the re-scope points it back
 * at the surface it was measured on. Nothing about its value moved.
 *
 * Deriving a principled absolute floor from what a user actually needs is on
 * the P2 list and blocks nothing.
 */
export const PHASE_3_FLOOR = { hits: 51, of: 60 } as const;

/** The ranker's floor as a ratio, for a set of a different size. */
export const PHASE_3_GATE = PHASE_3_FLOOR.hits / PHASE_3_FLOOR.of;

/**
 * **The verb's ratchet — the new clause, and the whole of the re-scope.**
 * Judged on `recall()` at `weak`: the page `potsherd find` actually prints.
 *
 * ## Why this is a ratchet and not a comparison
 *
 * At the ranking, "hybrid beats both singles" is a claim about a fusion and it
 * is true: 57/42 against 40/31 and 57/40. At the verb the same three modes
 * score **8, 8 and 7**, and hybrid is *below* bm25 by one. A comparative
 * clause here would be red on every build, forever, for a reason nobody
 * intends to fix in this phase — which is the definition of a rule that
 * teaches a reader to ignore it.
 *
 * And the one-query deficit is **not a defect**. C-1 measured its cause:
 * `weak` is a function of `calibration.coverage`, which counts how many of the
 * query's *literal* terms the row repeats. `score ≤ coverage` by construction
 * (the bracket `0.60 + 0.25 + 0.15` is a partition of 1), so no lane and no
 * weight can move a row across the floor — the floor is computed from wording.
 * What the semantic lane *can* move is `strength`, and `combinedStrength` is a
 * mean over a body of evidence by deliberate choice, so a row that bm25 tops
 * and the vector lane ranks eighth is averaged down. That is right for
 * ordering and irrelevant to the floor. **The fusion buys seventeen queries in
 * the ranking and costs one at the floor**, and gating on that one would gate
 * on `combinedStrength` working as designed.
 *
 * So the verb is held the way `plans/04`'s recorded ruling held the phase-3
 * absolute floor once its instrument was replaced: **pin the measured value
 * and forbid it getting worse.** That ruling's words, 24 aug 2026: *"the
 * ratchet may only move up (tighten); it may never be raised to accommodate a
 * regression."*
 *
 * **The ruling attached three conditions to a ratchet, and condition (b) —
 * a per-query pin, so that a regression NAMES the query that fell rather than
 * reporting a count — is already satisfied for this surface and was not built
 * by this change.** `compareToBaseline` in `evals/run.ts` reads `hitAt`, which
 * since C-1 step 1 is the verb's hit. `evals/per-query-baseline.json` is in
 * sync on `70dac23` (the shipped run reports no flips), so a change that
 * costs the verb one answer prints *which* query it lost beside this ratchet
 * going red. A ratchet on a count and an alarm that names the query are the
 * pair the ruling asked for, and the pair is here.
 *
 * ## The discipline, stated so it cannot be read the convenient way
 *
 * **The required count may only ever RISE. It may never be lowered — not by a
 * point, not "temporarily" — to let a build that regressed the verb go green.**
 * Lowering it is the move this project has refused six times, once at 3am on
 * its own orchestrator's recommendation (`plans/09 §17.1`). If a change drops
 * the verb from 7 to 6, the correct response is that the change is red, not
 * that the constant is 6.
 *
 * Raising it is not only allowed but expected: phase 12's named target is to
 * make this number large, and every point earned belongs here the day it is
 * earned.
 *
 * ## Why BOTH @k and @1 are pinned, when today they are the same number
 *
 * 7 and 7 on `70dac23`. They are equal because a page that survives the floor
 * is short. They are not the *same* number: a change that leaves seven answers
 * on the page but pushes one of them from row 1 to row 3 holds `atK` at 7 and
 * drops `at1` to 6. That is a real regression in what a user reads first and
 * only `at1` catches it, so both are pinned.
 *
 * ## What is deliberately NOT a clause here
 *
 * **Empty pages are reported and not judged.** 52/60 pages come back empty and
 * that number is printed by `pnpm evals`, in the JSON, and in {@link
 * VerbRatchet.emptyPages}. It is not a gate clause because a build that
 * withholds *more* junk while holding recall is an improvement in precision,
 * and a ratchet on empty pages would go red on it. A clause that reddens a
 * build that should be green is a different failure from the one this file
 * guards against, but it is still a failure, and there is no honest version of
 * it that does not need the target in `phases/phase-12/FIRST-JOB.md` closed
 * first.
 */
export const VERB_RATCHET = { atK: 7, at1: 7, of: 60 } as const;

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

/**
 * The same run, scored twice, at the two floors — because the gate judges two
 * different properties and each one is only meaningful on one of these.
 *
 * A caller that hands the same `GateInput` for both has broken the instrument
 * the way it was broken from phase 3 to phase 11; `tests/evals-gate.test.ts`
 * pins `run.ts`'s two floors against `find`'s own default so that cannot
 * happen silently.
 */
export interface Surfaces {
  /** `recall()` at `none` — every row the fusion found. Judges the RANKER. */
  ranking: GateInput;
  /** `recall()` at `weak` — the page the verb prints. Judges the PRODUCT. */
  verb: GateInput;
}

/** One half of the ranker's rule: a comparison of hybrid against both singles. */
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

/** The verb's half: a ratchet on the judged mode, with no comparison in it. */
export interface VerbRatchet {
  /** The judged mode's recall@k at `weak`. */
  atK: number;
  /** The judged mode's recall@1 at `weak`. */
  at1: number;
  /** {@link VERB_RATCHET} scaled to this run's set size. */
  barK: number;
  bar1: number;
  holdsAtK: boolean;
  holdsAt1: boolean;
  /** Both. This is the clause. */
  holds: boolean;
  /**
   * Queries whose verb page came back empty. **Reported, never judged** — see
   * {@link VERB_RATCHET}. `null` when the caller did not count them.
   */
  emptyPages: number | null;
  /**
   * Answers the ranker found in the top k and the floor withheld. Reported,
   * never judged. This is the size of the gap phase 12 is aimed at.
   */
  withheld: number | null;
}

export interface Gate {
  /** The mode being judged: `hybrid` (what `find` runs) or `always`. */
  mode: string;
  k: number;
  total: number;
  /** The rule, in words, for anything that renders this without the runner. */
  rule: string;
  /** RANKING surface: hybrid ≥ both singles at recall@k. */
  wide: GateHalf;
  /** RANKING surface: hybrid strictly above both singles at recall@1. */
  tight: GateHalf;
  /** RANKING surface: hybrid/total ≥ {@link PHASE_3_GATE} at recall@k. */
  clearsBar: boolean;
  /** The ranker's bar as a count, for printing. */
  bar: number;
  /** VERB surface: the ratchet. No comparison; see {@link VERB_RATCHET}. */
  verb: VerbRatchet;
  /** Every clause, both surfaces. */
  pass: boolean;
}

/** {@link VERB_RATCHET} scaled to a set of `total` queries. */
export const verbBars = (total: number): { barK: number; bar1: number } => ({
  barK: Math.round((VERB_RATCHET.atK / VERB_RATCHET.of) * total),
  bar1: Math.round((VERB_RATCHET.at1 / VERB_RATCHET.of) * total),
});

/**
 * The rule as two sentences, one per surface, parameterised by the run's `k`
 * and set size.
 *
 * Both surfaces are named in it and both comparison operators are named in it.
 * Somebody reading a screenshot of a passing run has to be able to tell *which*
 * gate passed and *what it was measured on*: "hybrid beats both singles" was
 * ambiguous enough about `>` versus `>=` to cost this project five phases, and
 * silence about the surface cost it eight.
 */
export const ruleLine = (k: number, total: number): string => {
  const { barK, bar1 } = verbBars(total);
  return (
    `ranker (recall() at none, every row the fusion found): hybrid ≥ both singles at ` +
    `recall@${k} (a ${total}-query set saturates there) and strictly > both at recall@1, ` +
    `with recall@${k} ≥ ${Math.round(PHASE_3_GATE * total)}/${total}. ` +
    `verb (recall() at weak, the page potsherd find prints): a ratchet at the measured ` +
    `${barK}/${total} at recall@${k} and ${bar1}/${total} at recall@1 — not a comparison, ` +
    `because the floor is computed from wording and no lane can move it. The number the ` +
    `verb does NOT reach is phase 12's named target: phases/phase-12/FIRST-JOB.md.`
  );
};

/**
 * Judge one fusion mode on both surfaces.
 *
 * Pure: it takes counts and returns a verdict. Everything about running an
 * index, embedding a corpus or finding a model lives in `run.ts`, so this can
 * be tested with numbers a test writes itself rather than numbers a machine
 * happens to produce.
 *
 * `reported` carries the two numbers that are printed and never judged.
 */
export function judge(
  mode: string,
  scores: Surfaces,
  total: number,
  k: number,
  reported: { emptyPages?: number | null; withheld?: number | null } = {},
): Gate {
  const wide: GateHalf = {
    comparison: '>=',
    hybrid: scores.ranking.hybrid.atK,
    bm25: scores.ranking.bm25.atK,
    vectors: scores.ranking.vectors.atK,
    beatsBm25: scores.ranking.hybrid.atK >= scores.ranking.bm25.atK,
    beatsVectors: scores.ranking.hybrid.atK >= scores.ranking.vectors.atK,
  };
  const tight: GateHalf = {
    comparison: '>',
    hybrid: scores.ranking.hybrid.at1,
    bm25: scores.ranking.bm25.at1,
    vectors: scores.ranking.vectors.at1,
    beatsBm25: scores.ranking.hybrid.at1 > scores.ranking.bm25.at1,
    beatsVectors: scores.ranking.hybrid.at1 > scores.ranking.vectors.at1,
  };
  const clearsBar = total > 0 && scores.ranking.hybrid.atK / total >= PHASE_3_GATE;

  // The verb: the judged mode against itself, and against nothing else.
  const { barK, bar1 } = verbBars(total);
  const holdsAtK = scores.verb.hybrid.atK >= barK;
  const holdsAt1 = scores.verb.hybrid.at1 >= bar1;
  const verb: VerbRatchet = {
    atK: scores.verb.hybrid.atK,
    at1: scores.verb.hybrid.at1,
    barK,
    bar1,
    holdsAtK,
    holdsAt1,
    holds: holdsAtK && holdsAt1,
    emptyPages: reported.emptyPages ?? null,
    withheld: reported.withheld ?? null,
  };

  return {
    mode,
    k,
    total,
    rule: ruleLine(k, total),
    wide,
    tight,
    clearsBar,
    bar: Math.round(PHASE_3_GATE * total),
    verb,
    pass:
      wide.beatsBm25 &&
      wide.beatsVectors &&
      tight.beatsBm25 &&
      tight.beatsVectors &&
      clearsBar &&
      verb.holds,
  };
}
