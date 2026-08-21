import type { Db } from './db.js';
import type { Backend, Calibration, Estimate } from './llm.js';

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
 * and says so.
 */
export function readCalibration(
  db: Db,
  o: { backend?: Backend; model?: string; window?: number } = {},
): Calibration | null {
  let rows: { time_ratio: number; usd_ratio: number; ran_at: string }[];
  try {
    rows = db
      .prepare(
        `SELECT time_ratio, usd_ratio, ran_at
           FROM card_runs
          WHERE complete = 1
            AND actual_calls >= ?
            AND predicted_seconds > 0
            AND predicted_usd > 0
            ${o.backend ? 'AND backend = ?' : ''}
          ORDER BY ran_at DESC, id DESC
          LIMIT ?`,
      )
      .all(
        ...(o.backend
          ? [MIN_CALLS, o.backend, o.window ?? CALIBRATION_WINDOW]
          : [MIN_CALLS, o.window ?? CALIBRATION_WINDOW]),
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
