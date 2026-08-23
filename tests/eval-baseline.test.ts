import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareToBaseline, readBaseline, type BaselineDoc } from '../evals/baseline.js';

/**
 * The per-query baseline, and the gate ruling that asked for it.
 *
 * The phase-3 floor is a count. A count says retrieval got worse; it cannot say
 * which query stopped working, which is the only form of the news anybody can
 * act on. The ruling that ratcheted the floor to its measured value (24 aug
 * 2026) attached this condition to it: *"pin the per-query pass/fail as a
 * fixture so a future regression names which query fell, not just the count."*
 *
 * So these tests are about the ALARM, not about the score. They must fail if
 * the alarm stops working, and they must not need editing when retrieval
 * legitimately improves.
 */
describe('the per-query eval baseline', () => {
  const repo = path.resolve(__dirname, '..');

  it('is committed, and covers every mode and every query the set holds', () => {
    const doc = readBaseline();
    expect(doc).not.toBeNull();
    const b = doc as BaselineDoc;

    // Non-vacuous: an empty or truncated baseline would silently report no
    // regressions for ever, which is the worst possible failure for an alarm.
    const modes = Object.keys(b.modes);
    expect(modes).toEqual(expect.arrayContaining(['bm25', 'vectors', 'hybrid']));

    const setFile = path.join(repo, 'evals', 'queries.jsonl');
    const recallQueries = fs
      .readFileSync(setFile, 'utf8')
      .split('\n')
      // The set carries `//` comment lines, the way the runner's own loader
      // tolerates them. Parsing them is not this test's job.
      .filter((l) => l.trim() && !l.trimStart().startsWith('//'))
      .map((l) => JSON.parse(l) as { query: string; control?: string })
      .filter((q) => !q.control);

    expect(recallQueries.length).toBeGreaterThanOrEqual(50);
    expect(b.total).toBe(recallQueries.length);

    // Every recall query is pinned in every mode. A query missing from the
    // baseline is reported as "new" rather than as a regression, so a partial
    // baseline would quietly excuse exactly the queries it omitted.
    for (const mode of modes) {
      const pinned = new Set(Object.keys(b.modes[mode]!));
      const missing = recallQueries.filter((q) => !pinned.has(q.query)).map((q) => q.query);
      expect(missing).toEqual([]);
    }
  });

  it('names the query that fell, and says which direction it moved', () => {
    const baseline: BaselineDoc = {
      k: 5,
      total: 2,
      modes: {
        hybrid: {
          'the pooler decision': { hit: true, hit1: true },
          'the disk filling up': { hit: true, hit1: false },
        },
      },
    };
    const { flips, unknownQueries } = compareToBaseline(
      [
        {
          mode: 'hybrid',
          results: [
            // fell out of the top k entirely
            { query: 'the pooler decision', hit: false, hit1: false },
            // climbed to first, which is a change worth naming too
            { query: 'the disk filling up', hit: true, hit1: true },
          ],
        },
      ],
      baseline,
    );

    expect(unknownQueries).toBe(0);
    // Losses are reported before gains, and within a loss the top-k metric
    // before rank-1: falling out of the results matters more than falling to
    // second place.
    expect(flips.map((f) => [f.direction, f.metric, f.query])).toEqual([
      ['lost', 'hit', 'the pooler decision'],
      ['lost', 'hit1', 'the pooler decision'],
      ['gained', 'hit1', 'the disk filling up'],
    ]);
  });

  it('counts a query the baseline has never seen as new, not as a regression', () => {
    const baseline: BaselineDoc = {
      k: 5,
      total: 1,
      modes: { hybrid: { known: { hit: true, hit1: true } } },
    };
    const { flips, unknownQueries } = compareToBaseline(
      [
        {
          mode: 'hybrid',
          results: [
            { query: 'known', hit: true, hit1: true },
            { query: 'added last week', hit: false, hit1: false },
          ],
        },
      ],
      baseline,
    );
    // The set legitimately grows. Reporting an addition as a regression is how
    // a list like this trains everybody to ignore it.
    expect(flips).toEqual([]);
    expect(unknownQueries).toBe(1);
  });

  it('reports nothing at all when there is no baseline to compare against', () => {
    expect(compareToBaseline([{ mode: 'hybrid', results: [] }], null)).toEqual({
      flips: [],
      unknownQueries: 0,
    });
  });
});
