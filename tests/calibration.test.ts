import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_LISTS,
  STRONG_FLOOR,
  WEAK_FLOOR,
  WEIGHT_AGREEMENT,
  WEIGHT_BASE,
  WEIGHT_STRENGTH,
  atLeastConfident,
  calibrate,
  coveredTerms,
  label,
  maxConfidence,
  relativeStrength,
} from '../packages/core/src/calibration.js';
// Imported from source rather than from the `@potsherd/core` barrel, which is
// how `ask.test.ts` and `llm.test.ts` already reach modules the barrel does not
// re-export. `packages/core/src/index.ts` is another worker's file this task
// may not edit; T10.1's report carries the exact export block it owes.

/**
 * T10.1 — `find`'s second axis, on its own, with no index behind it.
 *
 * The arithmetic is a pure function of four numbers, so it is tested as one.
 * What it does to a real corpus is `tests/recall.test.ts`; what it does to a
 * query set is `evals/queries.jsonl`. This file is the part that has to be
 * true before either of those means anything.
 *
 * ## Why this is not `calibration` in the other sense
 *
 * `packages/core/src/calibration.ts` already held one calibrator — the
 * estimator's predicted-vs-actual self-check for `card`. This is a second one
 * in the same file, deliberately: both answer *how much should the number on
 * the screen be trusted?* and neither of them is allowed to change the number.
 * The two share no code and no constants.
 */

describe('the shape of the score', () => {
  it('is coverage, gated by strength and agreement — never the other way round', () => {
    // The one property everything else rests on. A row that cannot show a
    // single word the user typed is `none` no matter how hard the ranker
    // liked it and no matter how many lists agreed. That is the cliff: the
    // audit's ten confident rows for a topic the archive has never heard of
    // are exactly this case, and normalising the RRF score cannot reach it
    // because the RRF score is a function of rank alone.
    const nothing = calibrate({ covered: 0, terms: 4, strength: 1, lists: 8 });
    expect(nothing.score).toBe(0);
    expect(nothing.confidence).toBe('none');

    // And the mirror: full coverage is the *ceiling*, reached only when the
    // row is also the best its list found and corroborated by others.
    const everything = calibrate({ covered: 4, terms: 4, strength: 1, lists: AGREEMENT_LISTS });
    expect(everything.score).toBeCloseTo(1, 12);
    expect(everything.confidence).toBe('strong');
  });

  it('never exceeds its own coverage', () => {
    for (const covered of [0, 1, 2, 3, 4]) {
      for (const strength of [0, 0.5, 1]) {
        for (const lists of [1, 2, 3, 8]) {
          const c = calibrate({ covered, terms: 4, strength, lists });
          expect(c.score).toBeLessThanOrEqual(covered / 4 + 1e-12);
        }
      }
    }
  });

  it('separates a true topic from an absent one three to one, against the fusion\'s 1.12', () => {
    // The two rows this whole task exists for, as they were measured on the
    // demo corpus. Both are rank 1 of their own list — identical `strength`,
    // identical `agreement` — and on the reference archive their *fused*
    // scores were 0.01836 and 0.01639, which is 1.12x apart. Coverage is what
    // the fusion threw away.
    const trueTopic = calibrate({ covered: 3, terms: 3, strength: 1, lists: 1 });
    const absentTopic = calibrate({ covered: 1, terms: 3, strength: 1, lists: 1 });
    expect(trueTopic.confidence).toBe('strong');
    expect(absentTopic.confidence).toBe('none');
    // Exactly 3.00 here because coverage is 3/3 against 1/3 and every other
    // input is identical — which is the cleanest possible statement of what
    // the second axis is measuring. The fusion put these two rows 1.12x apart.
    expect(trueTopic.score / absentTopic.score).toBeCloseTo(3, 6);
  });

  it('gives a query with no distinctive words the benefit of the doubt', () => {
    // `find "the"` has nothing to have covered. Calling that `none` would
    // delete a result the user can plainly see is correct, so coverage is 1 by
    // definition: every word asked for is present, there just were not many.
    const c = calibrate({ covered: 0, terms: 0, strength: 1, lists: 1 });
    expect(c.coverage).toBe(1);
    expect(c.confidence).toBe('strong');
  });

  it('lets a weaker match fall below a stronger one at identical coverage', () => {
    // Two rows that say all the same words, one of which its own list ranked
    // far below the other. This is `from[].raw` doing the only job coverage
    // cannot do — separating the exchange that is *about* the pooler decision
    // from the one that mentions it on the way past.
    const best = calibrate({ covered: 2, terms: 3, strength: 1, lists: 1 });
    const faint = calibrate({ covered: 2, terms: 3, strength: 0.4, lists: 1 });
    expect(best.confidence).toBe('weak');
    expect(faint.confidence).toBe('none');
  });

  it('clamps inputs rather than trusting them', () => {
    // `raw` comes out of sqlite and `lists` out of a Set; neither should be
    // able to produce a score outside 0..1 even if a future list reports
    // something the normaliser did not expect.
    for (const e of [
      { covered: 9, terms: 3, strength: 4, lists: 99 },
      { covered: -1, terms: 3, strength: -4, lists: 0 },
      { covered: 1, terms: 3, strength: Number.NaN, lists: 1 },
    ]) {
      const c = calibrate(e);
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
      expect(['strong', 'weak', 'none']).toContain(c.confidence);
    }
  });
});

/**
 * `plans/08` rule 3 — *a constant encoding a measured trade-off needs a test
 * that fails when it moves.*
 *
 * Each of these pins a **behaviour** to the shipped value rather than
 * restating the number, so the test fails when the constant moves in either
 * direction and says what the movement would do. The floors were recorded as a
 * stopping rule, not an argmax over the queries that score them — the same
 * discipline phase 3 applied to `WEIGHTS.vec_* = 1.5` — and these are what
 * hold them still.
 */
describe('the constants', () => {
  it('WEAK_FLOOR means: a clear majority of the words you typed', () => {
    // At a rank-1 row of a single uncorroborated list the multiplier is
    // BASE + STRENGTH = 0.85, so the floor is a statement about coverage:
    // 2 of 3 is in, 2 of 4 is out. Move WEAK_FLOOR down and half-covered rows
    // come back; move it up and the majority rule stops being the rule.
    const rank1 = (covered: number, terms: number) =>
      calibrate({ covered, terms, strength: 1, lists: 1 }).confidence;
    expect(rank1(2, 3)).toBe('weak');
    expect(rank1(3, 5)).toBe('weak');
    expect(rank1(2, 4)).toBe('none');
    expect(rank1(1, 3)).toBe('none');
    // And the number itself, so a silent edit cannot pass by keeping the
    // behaviour above true for some other reason.
    expect(WEAK_FLOOR).toBe(0.5);
    expect(label(WEAK_FLOOR)).toBe('weak');
    expect(label(WEAK_FLOOR - 1e-9)).toBe('none');
  });

  it('STRONG_FLOOR means: an agent may act on this without reading the rows', () => {
    const rank1 = (covered: number, terms: number) =>
      calibrate({ covered, terms, strength: 1, lists: 1 }).confidence;
    // Everything present, best of its list: strong, and it is the case the
    // whole verb exists to be able to say.
    expect(rank1(4, 4)).toBe('strong');
    expect(rank1(1, 1)).toBe('strong');
    // A quarter of the query missing is not strong on one list's word alone —
    // but three lists agreeing about it is a different kind of evidence for
    // the same claim, and that is allowed to clear the bar.
    expect(rank1(3, 4)).toBe('weak');
    expect(calibrate({ covered: 3, terms: 4, strength: 1, lists: AGREEMENT_LISTS }).confidence).toBe(
      'strong',
    );
    expect(STRONG_FLOOR).toBe(0.75);
    expect(label(STRONG_FLOOR)).toBe('strong');
    expect(label(STRONG_FLOOR - 1e-9)).toBe('weak');
  });

  it('the three weights are a partition of one, so nothing can score above its coverage', () => {
    // This is not bookkeeping. If they summed to more than 1 a fully
    // corroborated row would score *above* its own coverage and the ceiling
    // property — the entire cliff — would be gone.
    expect(WEIGHT_BASE + WEIGHT_STRENGTH + WEIGHT_AGREEMENT).toBeCloseTo(1, 12);
    expect(WEIGHT_BASE).toBeGreaterThan(WEIGHT_STRENGTH + WEIGHT_AGREEMENT);
  });

  it('AGREEMENT_LISTS is reachable on a text-only index', () => {
    // Four of the eight lists cannot run without embeddings. A bar that
    // needed more than three would score every result on a `--no-embed`
    // machine — which is the default since 8.6 — as uncorroborated.
    expect(AGREEMENT_LISTS).toBe(3);
    expect(calibrate({ covered: 1, terms: 1, strength: 0, lists: AGREEMENT_LISTS }).agreement).toBe(
      1,
    );
  });

  /**
   * P11 — what `lists` is a count *of*, pinned as arithmetic.
   *
   * The constant did not move and this test would fail if it did. What P11
   * changed is one caller: `recall()` used to pass a count of indexes, and
   * `agreement`'s docstring has always said *independent*. On a hybrid index
   * those are different numbers — `exchanges_fts` beside `vec_exchanges` is
   * one exchange retrieved twice — and the difference is worth exactly the
   * step below, which is what decided the top row on eight queries of the
   * committed 60-query set.
   *
   * The partition itself lives in `recall.ts` (`SOURCE_OF_LIST`) and is pinned
   * in `tests/recall.test.ts`; this is the other half of the contract, stated
   * where the meaning is defined.
   */
  it('one extra body of evidence is worth exactly half the agreement term', () => {
    const one = calibrate({ covered: 1, terms: 1, strength: 0, lists: 1 });
    const two = calibrate({ covered: 1, terms: 1, strength: 0, lists: 2 });
    expect(one.agreement).toBe(0);
    expect(two.agreement).toBe(0.5);
    // The number a mis-counted list was buying, on a row whose coverage is 1.
    expect(two.score - one.score).toBeCloseTo(WEIGHT_AGREEMENT / 2, 12);
    // Scaled by coverage, because coverage is the ceiling — which is why the
    // measured margins on the eight queries were 0.013–0.024 rather than
    // 0.075: every one of those rows covered a quarter to a half of what was
    // asked.
    const thin = { covered: 1, terms: 4, strength: 0 };
    expect(
      calibrate({ ...thin, lists: 2 }).score - calibrate({ ...thin, lists: 1 }).score,
    ).toBeCloseTo((WEIGHT_AGREEMENT / 2) * 0.25, 12);
  });
});

describe('relativeStrength', () => {
  it('reads bm25 as a magnitude against its own list, never as an absolute', () => {
    // bm25 is negative and lower is better. -13 against a list whose best was
    // -13 is 1; against a list whose best was -26 it is a half. Neither
    // number means anything on its own, which is the point: a floor expressed
    // in bm25 units would have to be re-fitted for every corpus size.
    expect(relativeStrength(-13, -13, 'bm25')).toBeCloseTo(1, 12);
    expect(relativeStrength(-13, -26, 'bm25')).toBeCloseTo(0.5, 12);
    // The same row, the same list, a corpus ten times the size: bm25 moves,
    // the ratio does not.
    expect(relativeStrength(-130, -260, 'bm25')).toBeCloseTo(0.5, 12);
  });

  it('reads cosine as itself, and refuses a negative best', () => {
    expect(relativeStrength(0.7, 0.7, 'cosine')).toBeCloseTo(1, 12);
    expect(relativeStrength(0.35, 0.7, 'cosine')).toBeCloseTo(0.5, 12);
    expect(relativeStrength(-0.2, 0.7, 'cosine')).toBe(0);
    expect(relativeStrength(0.5, -0.1, 'cosine')).toBe(0);
  });

  it('treats a title match as having no magnitude left to compare', () => {
    // `titleMatches` already dropped every title that did not match the query
    // as well as the best one did, so every title hit that survives is by
    // construction the strongest of its kind.
    expect(relativeStrength(0, 0, 'flat')).toBe(1);
  });
});

describe('coveredTerms', () => {
  it('counts a word the reader would call a match, not one fts5 would', () => {
    // fts5 does not stem, so `icons` and `icon` are two tokens to the ranker
    // and one word to a human. The confidence label uses the same
    // prefix-tolerant matcher the snippet highlighter uses, so the number and
    // the highlighted words on the screen cannot disagree.
    expect(coveredTerms(['icon'], 'which import made the icons so big')).toBe(1);
    expect(coveredTerms(['pgbouncer', 'prepared'], 'prepared statements behind pgbouncer')).toBe(2);
    expect(coveredTerms(['pgbouncer', 'kubernetes'], 'prepared statements behind pgbouncer')).toBe(
      1,
    );
  });

  it('counts each term once, however often it appears', () => {
    expect(coveredTerms(['pool'], 'pool pool pool pool')).toBe(1);
  });

  it('is zero on nothing, and never throws on it', () => {
    expect(coveredTerms([], 'anything at all')).toBe(0);
    expect(coveredTerms(['pool'], '')).toBe(0);
  });
});

describe('the ordering of the three words', () => {
  it('compares as a floor', () => {
    expect(atLeastConfident('strong', 'weak')).toBe(true);
    expect(atLeastConfident('weak', 'weak')).toBe(true);
    expect(atLeastConfident('none', 'weak')).toBe(false);
    // `--min-confidence none` is the escape hatch: at that floor nothing is
    // withheld, which is what makes it an escape hatch and not a fourth band.
    expect(atLeastConfident('none', 'none')).toBe(true);
  });

  it('takes the best of a set, which is what the envelope is', () => {
    expect(maxConfidence('none', 'strong')).toBe('strong');
    expect(maxConfidence('weak', 'none')).toBe('weak');
    expect(maxConfidence('none', 'none')).toBe('none');
  });
});

/**
 * C-1 §1 — the structural claim, made permanent.
 *
 * VERIFICATION-6 C-1 asserted that `potsherd find`'s emptiness on 52 of 60
 * benchmark queries is *structural, not a tuning accident*, and gave the
 * mechanism in one line: `score = coverage x (BASE + …)`, the bracket is a
 * partition of 1, therefore **`score <= coverage` always** — so `weak` at 0.5
 * demands that at least half of the query's literal terms appear in the row,
 * and no cosine, no bm25 magnitude and no amount of corroboration can change
 * that.
 *
 * That claim was verified and it is the reason C-1 could not be closed by
 * moving a constant. It is pinned here because it is now load-bearing in three
 * places — this file's arithmetic, `recall.ts`'s two `calibrate` call sites,
 * and `packages/mcp/src/tools/recall.ts`'s `note`, which tells an agent in
 * words that the floor measures wording rather than contents. If the shape of
 * the score ever stops implying it, all three become lies at once and this
 * goes red first.
 */
describe('C-1 — coverage is a ceiling, and that is the whole finding', () => {
  it('never scores a row above its own literal coverage, over the whole input space', () => {
    // Exhaustive on a grid rather than illustrative on three cases: the claim
    // is universally quantified and a handful of examples cannot carry it.
    for (let covered = 0; covered <= 8; covered++) {
      for (let terms = Math.max(covered, 1); terms <= 8; terms++) {
        for (const strength of [0, 0.25, 0.5, 0.75, 1]) {
          for (let lists = 1; lists <= AGREEMENT_LISTS + 2; lists++) {
            const c = calibrate({ covered, terms, strength, lists });
            expect(c.score).toBeLessThanOrEqual(c.coverage + 1e-12);
          }
        }
      }
    }
  });

  it('cannot reach the weak floor below half the query, at any strength or agreement', () => {
    // The consequence a reader has to be able to see: the best possible row —
    // top of every list, corroborated by every independent source there is —
    // is still refused when it repeats fewer than half of the words typed.
    const best = { strength: 1, lists: AGREEMENT_LISTS + 5 };
    expect(calibrate({ covered: 1, terms: 3, ...best }).confidence).toBe('none');
    expect(calibrate({ covered: 2, terms: 5, ...best }).confidence).toBe('none');
    expect(calibrate({ covered: 3, terms: 4, ...best }).confidence).not.toBe('none');
    // And the bracket really is a partition of 1, which is what makes the
    // sentence above a theorem rather than an observation about these numbers.
    expect(WEIGHT_BASE + WEIGHT_STRENGTH + WEIGHT_AGREEMENT).toBeCloseTo(1, 12);
  });

  it('is blind to the semantic lane: only literal coverage is an input', () => {
    // The half of the finding that F8 is about. `calibrate` has no argument
    // that can carry "a vector found this and nothing else did" — `strength`
    // is a *relative* magnitude, so the top row of a list donates 1.0 whether
    // it is a bullseye or the least-bad of a bad list. A row the semantic lane
    // alone found therefore scores exactly what its wording earns.
    const semanticOnly = { covered: 1, terms: 4, strength: 1, lists: 1 };
    const nothingButWording = { covered: 1, terms: 4, strength: 0, lists: 1 };
    expect(calibrate(semanticOnly).coverage).toBe(calibrate(nothingButWording).coverage);
    expect(calibrate(semanticOnly).confidence).toBe('none');
    // A full 0.25 of strength is worth less than a quarter of one term of a
    // four-term query, which is the arithmetic reason the lane cannot rescue.
    expect(calibrate(semanticOnly).score - calibrate(nothingButWording).score).toBeLessThan(
      1 / 4,
    );
  });
});
