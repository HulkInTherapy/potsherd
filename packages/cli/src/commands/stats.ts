import { countsJson, renderStats, sessionStats } from '@potsherd/core';
import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';
import { openIndex } from '../filters.js';

export interface StatsCommandOptions extends GlobalOptions {
  fresh?: boolean;
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
    const report = sessionStats(db, { root, freshness: o.fresh !== false });
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
