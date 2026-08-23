import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-query regression detection.
 *
 * The gate's floor is a count, and a count cannot say what broke. `51/60` going
 * to `50/60` tells somebody retrieval got worse; it does not tell them that the
 * query it stopped answering is the one about a ghost session, which is the
 * sentence they can act on. This module holds the other half: which queries
 * passed when the floor was last agreed, so a later run can name the ones that
 * changed.
 *
 * Ruled alongside the ratchet (24 aug 2026): *"pin the per-query pass/fail as a
 * fixture so a future regression names which query fell, not just the count."*
 *
 * Flips are reported in BOTH directions. A query that stopped passing is a
 * regression. A query that started passing is not a cause for celebration — it
 * is an unexplained change to a measurement, and this project has three
 * recorded instances of a number moving for a reason nobody checked.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(here, 'per-query-baseline.json');

export interface BaselineDoc {
  k: number;
  total: number;
  modes: Record<string, Record<string, { hit: boolean; hit1: boolean }>>;
}

/** One query whose result moved since the baseline was pinned. */
export interface Flip {
  mode: string;
  query: string;
  /** `lost` — passed then, fails now. `gained` — the other way. */
  direction: 'lost' | 'gained';
  /** Which metric moved: the top-k hit, or the rank-1 hit. */
  metric: 'hit' | 'hit1';
}

/** The pinned baseline, or `null` when there is none to compare against. */
export function readBaseline(): BaselineDoc | null {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as BaselineDoc;
  } catch {
    return null;
  }
}

export interface ModeResults {
  mode: string;
  results: readonly { query: string; hit: boolean; hit1: boolean }[];
}

/**
 * Every query whose pass/fail changed, most damaging first.
 *
 * A query present in this run and absent from the baseline is NOT a flip — the
 * query set legitimately grows, and reporting an addition as a regression would
 * train everyone to ignore this list. It is counted separately instead.
 */
export function compareToBaseline(
  runs: readonly ModeResults[],
  baseline: BaselineDoc | null,
): { flips: Flip[]; unknownQueries: number } {
  if (!baseline) return { flips: [], unknownQueries: 0 };
  const flips: Flip[] = [];
  let unknownQueries = 0;

  for (const run of runs) {
    const pinned = baseline.modes[run.mode];
    if (!pinned) continue;
    for (const r of run.results) {
      const was = pinned[r.query];
      if (!was) {
        unknownQueries += 1;
        continue;
      }
      for (const metric of ['hit', 'hit1'] as const) {
        if (was[metric] === r[metric]) continue;
        flips.push({
          mode: run.mode,
          query: r.query,
          direction: was[metric] ? 'lost' : 'gained',
          metric,
        });
      }
    }
  }

  // Losses first, and within them the top-k metric before rank-1: a query that
  // fell out of the results entirely matters more than one that merely stopped
  // being first.
  flips.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === 'lost' ? -1 : 1;
    if (a.metric !== b.metric) return a.metric === 'hit' ? -1 : 1;
    return a.query.localeCompare(b.query);
  });
  return { flips, unknownQueries };
}
