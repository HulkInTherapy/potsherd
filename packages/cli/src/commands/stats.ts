import { countsJson, renderStats, sessionStats } from '@potsherd/core';
import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';
import { openIndex } from '../filters.js';

export interface StatsCommandOptions extends GlobalOptions {
  fresh?: boolean;
  /**
   * `--all`: show the projects the ignore list hides.
   *
   * Deliberately **not** part of the shared `addFilters` registration, though
   * every other flag on this verb is. `potsherd card --all` already exists and
   * means "every session in the index"; a single `--all` registered across the
   * shared block would have put two meanings on one word. So `ls`, `find` and
   * `stats` each declare it, with the same description and the same effect,
   * and nothing else does.
   *
   * It overrides the ignore list and only the ignore list: every other filter
   * still applies.
   */
  all?: boolean;
}

/**
 * `potsherd stats` — per-harness counts, redaction totals, index freshness.
 *
 * Every row is a `COUNT` or a `SUM` the user could recompute with one sqlite
 * query, which is the point: `stats` is how you check that `index` did what it
 * said, and how phase-1's acceptance ("counts matching `find … | wc` by hand")
 * gets checked at all.
 */
export async function runStats(o: StatsCommandOptions): Promise<number> {
  const { db, root } = openIndex(o);
  try {
    const report = sessionStats(db, { root, freshness: o.fresh !== false, all: Boolean(o.all) });
    if (o.json) {
      printJson({ ...report, redaction: countsJson(report.redaction) });
      return 0;
    }
    print(renderStats(report, themeFrom(o)));
    return 0;
  } finally {
    db.close();
  }
}
