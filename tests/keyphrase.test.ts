import { describe, expect, it } from 'vitest';
import {
  DF_TABLES,
  KEYPHRASE_RULE,
  MAX_SCORED_TERMS,
  NO_KEYPHRASE,
  contentTerms,
  selectTerms,
} from '../packages/core/src/keyphrase.js';
import { KEY_TERMS_REQUIRED, calibrate } from '../packages/core/src/calibration.js';
// Imported from source rather than from the `@potsherd/core` barrel:
// `packages/core/src/index.ts` is another worker's file this phase and does not
// re-export either module yet. `T10.9-REPORT.md` carries the exact barrel
// lines, the way `tests/calibration.test.ts` and `tests/cards-lane.test.ts`
// already do for T10.1 and T10.7.

/**
 * T10.9 — F8, the extraction rule itself, with no database in the way.
 *
 * `selectTerms` takes a document-frequency map the test writes, so everything
 * here is arithmetic about the rule rather than about the fixture corpus. The
 * rule's behaviour *on* the corpus is in `tests/recall.test.ts`, where it can
 * be measured against the audit's own failing query.
 */

const STOP = new Set(['the', 'on', 'a', 'and', 'what', 'is', 'to', 'where', 'did', 'we', 'off']);

const df = (o: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(o));

describe('KEYPHRASE_RULE — the constant the whole task reduces to', () => {
  // `plans/08` rule 3: a constant that encodes a decision needs a test that
  // fails when it moves. This asserts the rule's three fields *and* the
  // selection each of them produces, so moving any one of them in either
  // direction turns something here red rather than silently changing what
  // `find` searches for.
  it('is half, rounded up, floored at 1 and capped at 4', () => {
    expect(KEYPHRASE_RULE.keepRatio).toBe(0.5);
    expect(KEYPHRASE_RULE.minTerms).toBe(1);
    expect(KEYPHRASE_RULE.maxTerms).toBe(4);
  });

  it('is frozen, so nothing can move it at run time', () => {
    expect(Object.isFrozen(KEYPHRASE_RULE)).toBe(true);
  });

  it('keeps ceil(n/2) terms up to the cap — the whole ladder, spelled out', () => {
    // n -> how many terms come back. Every row is `ceil(n * keepRatio)` capped
    // at `maxTerms` and floored at `minTerms`. Change `keepRatio` to 0.4 and
    // rows 5 and 7 break; change the rounding to `floor` and rows 3, 5 and 7
    // break; change `maxTerms` and rows 8 and 12 break.
    const table: [number, number][] = [
      [1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3], [7, 4], [8, 4], [12, 4],
    ];
    for (const [n, want] of table) {
      const terms = Array.from({ length: n }, (_, i) => `t${i}`);
      const freqs = df(Object.fromEntries(terms.map((t, i) => [t, i + 1])));
      expect(selectTerms(terms, freqs), `n=${n}`).toHaveLength(want);
    }
  });

  it('keeps the rarest, in rarity order, not the order they were typed', () => {
    const terms = ['build', 'pgbouncer', 'work', 'leave'];
    const freqs = df({ build: 16, pgbouncer: 1, work: 4, leave: 5 });
    expect(selectTerms(terms, freqs)).toEqual(['pgbouncer', 'work']);
  });

  it('breaks a tie by the order the words were typed, so it is stable', () => {
    const freqs = df({ alpha: 3, beta: 3, gamma: 9, delta: 9 });
    expect(selectTerms(['alpha', 'beta', 'gamma', 'delta'], freqs)).toEqual(['alpha', 'beta']);
    expect(selectTerms(['beta', 'alpha', 'gamma', 'delta'], freqs)).toEqual(['beta', 'alpha']);
  });
});

describe('a term no document contains is the least selective word, not the most', () => {
  // T10.1 §d1 measured and rejected IDF-weighted coverage on this corpus:
  // `kept`, `even` and `fine` are at df 0, and `log(N/df)` hands exactly those
  // words the highest weight, making the natural-language case strictly worse.
  // The measurement is right and it does not apply here, because extraction
  // asks a different question from scoring: not *how surprising is this word*
  // but *which of these words will find the conversation*. A word in no
  // document finds nothing.
  it('drops df-0 terms rather than ranking them first', () => {
    const terms = ['kept', 'pod', 'fine', 'killed'];
    const freqs = df({ kept: 0, pod: 4, fine: 0, killed: 1 });
    expect(selectTerms(terms, freqs)).toEqual(['killed']);
  });

  it('has no opinion at all when every word of the query is absent', () => {
    // The safety valve. A query whose words are simply not in the archive gets
    // an empty keyphrase, which switches off both halves of F8: `recall()`
    // never builds a keyphrase pass, and `calibrate` never caps anything. The
    // alternative — gating on words that exist nowhere — would withhold every
    // row of every paraphrased query.
    expect(selectTerms(['vondrelic', 'pashtomeer'], df({ vondrelic: 0, pashtomeer: 0 }))).toEqual([]);
  });

  it('counts a term the fallback list still has to try', () => {
    // Dropping a df-0 term from the *keyphrase* is not dropping it from the
    // search: `recall()`'s third rung is the full any-word pass. This asserts
    // the module never pretends the term was not typed.
    const terms = contentTerms(['kept', 'the', 'pod', 'killed'], STOP);
    expect(terms).toContain('kept');
  });
});

describe('contentTerms', () => {
  it('drops the closed class, deduplicates, and keeps the typed order', () => {
    const tokens = 'where did we leave off on the pgbouncer work and what is left to build'.split(' ');
    expect(contentTerms(tokens, STOP)).toEqual(['leave', 'pgbouncer', 'work', 'left', 'build']);
  });

  it('deduplicates a word the user typed twice', () => {
    expect(contentTerms(['pod', 'the', 'pod', 'killed'], STOP)).toEqual(['pod', 'killed']);
  });

  it('caps how many terms one query can score', () => {
    const tokens = Array.from({ length: 40 }, (_, i) => `w${i}`);
    expect(contentTerms(tokens, STOP)).toHaveLength(MAX_SCORED_TERMS);
  });

  it('is empty for a query that is all function words', () => {
    expect(contentTerms(['the', 'on', 'a'], STOP)).toEqual([]);
  });
});

describe('the surfaces a document frequency is counted over', () => {
  it('is every text list a find can match, and nothing else', () => {
    // A df counted over exchanges alone would call a word that lives only in a
    // deleted session "absent", and ghosts are the reason potsherd exists.
    expect([...DF_TABLES]).toEqual([
      'exchanges_fts',
      'ghosts_fts',
      'ghost_prompts_fts',
      'cards_fts',
    ]);
  });

  it('has an empty value that is safe to return from a catch', () => {
    expect(NO_KEYPHRASE.terms).toEqual([]);
    expect(NO_KEYPHRASE.content).toEqual([]);
    expect(NO_KEYPHRASE.df.size).toBe(0);
  });
});

describe('KEY_TERMS_REQUIRED — the confidence half of F8', () => {
  // The gap the blind eval set caught: `bluetooth on the checkout page` must
  // return zero rows and returned two at `weak`. The arithmetic, reproduced
  // here without a database.
  const checkoutSession = { covered: 2, terms: 3, strength: 1, lists: 1 };

  it('is one term, and it is the most selective one', () => {
    expect(KEY_TERMS_REQUIRED).toBe(1);
  });

  it('reproduces the defect: two words of three clears the floor', () => {
    const before = calibrate(checkoutSession);
    expect(before.coverage).toBeCloseTo(2 / 3, 12);
    expect(before.score).toBeCloseTo((2 / 3) * 0.85, 12);
    expect(before.confidence).toBe('weak');
  });

  it('refuses the label when the distinctive word is the missing one', () => {
    const after = calibrate({ ...checkoutSession, keyCovered: 0, keyTerms: 1 });
    expect(after.confidence).toBe('none');
    expect(after.ceiling).toBe('none');
    // And the arithmetic is untouched: the cap refuses the *label*, so
    // `coverage x (base + …)` still reproduces from the printed numbers.
    expect(after.score).toBeCloseTo((2 / 3) * 0.85, 12);
    expect(after.coverage).toBeCloseTo(2 / 3, 12);
  });

  it('changes nothing for a row that shows the distinctive word', () => {
    const kept = calibrate({ ...checkoutSession, keyCovered: 1, keyTerms: 1 });
    expect(kept.confidence).toBe('weak');
    expect(kept.ceiling).toBeUndefined();
  });

  it('does not fire when the query has no distinctive term to require', () => {
    expect(calibrate({ ...checkoutSession, keyCovered: 0, keyTerms: 0 }).confidence).toBe('weak');
  });

  it('cannot lift a row, only refuse it', () => {
    // A necessary condition, never a bonus. A row that covers the distinctive
    // word and nothing else is still `none` on its own coverage.
    const thin = calibrate({ covered: 1, terms: 5, strength: 1, lists: 1, keyCovered: 1, keyTerms: 1 });
    expect(thin.confidence).toBe('none');
  });

  it('still cannot let a card claim strong', () => {
    // The two ceilings compose as a `min`, so F6's cap survives F8's.
    const card = calibrate({ covered: 3, terms: 3, strength: 1, lists: 2, ceiling: 'weak' });
    expect(card.confidence).toBe('weak');
    const cardMissingKey = calibrate({ ...card, keyCovered: 0, keyTerms: 1, ceiling: 'weak' });
    expect(cardMissingKey.confidence).toBe('none');
  });
});
