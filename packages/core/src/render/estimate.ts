import { Card } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { tildify } from '../paths.js';
import { CHARS_PER_TOKEN, type Calibration } from '../llm.js';
import type { CardPlan } from '../cards/plan.js';

/**
 * The quote, shown before anything is spent (`03` §6, `03` §12).
 *
 * Two rules shape this card:
 *
 *   **The headline number depends on who is paying.** On the subscription
 *   paths the marginal cost of a call is zero, so the number that constrains
 *   the run is wall time and that is what gets the accent. On the api path the
 *   money is the constraint and the money gets the accent. The other number is
 *   still printed on both — a user deciding whether to buy a key needs the
 *   dollar figure, and a user on a key still needs to know it will take a
 *   quarter of an hour.
 *
 *   **Every number says where it came from.** `chars ÷ 3.6` is an estimate and
 *   is labelled as one; `03` §12's targets are printed beside the estimate so
 *   a miss is visible on the same screen rather than in a plan file.
 *
 *   **A number that was 7× wrong is not rendered as though it were precise.**
 *   This card once said "estimated time 7m 26s, equivalent cost $2.66"
 *   immediately before a run that took 55m 25s and reported $12.93. The
 *   constants behind it have been re-fitted from real calls (`llm.ts`), but
 *   the deeper mistake was typographic: `7m 26s` claims a precision nothing
 *   here has. So the time and the money are printed as `~55m` with the range
 *   and the basis beside them, every estimated figure carries `est.`, and when
 *   this machine's own finished runs have moved the number the card says so
 *   and by how much.
 */

/** `03` §12: `card` over the whole archive. */
export const TARGET_SECONDS = 15 * 60;
export const TARGET_USD = 2;

export interface EstimateCardOptions {
  root?: string;
  /** The backend line, e.g. `agent-sdk · claude on PATH`. */
  backendNote?: string;
  /** What `--max-usd` was set to, if anything. */
  maxUsd?: number;
  ranAt?: Date;
  /** `card --dry-run` ends on a different line than `card` does. */
  dryRun?: boolean;
  /**
   * What `--limit` was set to, if anything. The closing line has to name
   * the scope that was just quoted: after `card --limit 5 --dry-run`,
   * `potsherd card --all` is 123 targets on the reference archive and not
   * the five above it. A quote the closing command does not honour is the
   * defect 8.6 exists for, one layer further out.
   */
  limit?: number;
}

export function renderEstimate(
  plan: CardPlan,
  t: Theme = new Theme(),
  o: EstimateCardOptions = {},
): string {
  const card = new Card(t);
  const e = plan.estimate;
  card
    .heading(
      o.dryRun === false ? 'card' : 'card --dry-run',
      ...(o.root ? [tildify(o.root)] : []),
      f.date(o.ranAt ?? new Date()),
    )
    .blank();

  if (plan.targets.length === 0) {
    card
      .text(
        plan.considered === 0
          ? 'nothing indexed yet, so there is nothing to card.'
          : `nothing to card: ${f.num(plan.skipped.alreadyCarded)} already carded, ` +
            `${f.num(plan.skipped.tooShort)} too short.`,
      )
      .blank();
    if (plan.considered === 0) {
      card.fix('potsherd index', 'to read every transcript on this machine.', 'to read them.');
    } else {
      card.fix('potsherd card --all --force', 'to rebuild every card anyway.', 'to rebuild them.');
    }
    return card.toString();
  }

  const skippedNote = [
    plan.skipped.alreadyCarded ? `${f.num(plan.skipped.alreadyCarded)} already carded` : '',
    plan.skipped.tooShort ? `${f.num(plan.skipped.tooShort)} too short` : '',
  ]
    .filter(Boolean)
    .join(` ${t.sep} `);

  card.rows([
    {
      label: 'sessions to card',
      value: f.num(plan.sessions),
      note: skippedNote || `of ${f.num(plan.considered)} in scope`,
    },
    ...(plan.ghosts
      ? [
          {
            label: 'ghosts to card',
            value: f.num(plan.ghosts),
            note: 'prompts only — the sessions Claude Code deleted',
          } as const,
        ]
      : []),
    {
      label: 'model calls',
      value: f.num(e.calls),
      note: `${e.model} ${t.sep} ${o.backendNote ?? e.backend ?? 'not selected'}`,
    },
  ]);

  card.blank();

  const money = `~${approxMoney(e.usd)}`;
  const time = `~${approxDuration(e.seconds)}`;
  const overTime = e.secondsLow > TARGET_SECONDS;
  const overMoney = e.usdLow > TARGET_USD;
  const timeRange = `${approxDuration(e.secondsLow)}${t.g('–', '-')}${approxDuration(e.secondsHigh)}`;
  const moneyRange = `${approxMoney(e.usdLow)}${t.g('–', '-')}${approxMoney(e.usdHigh)}`;

  card.rows([
    {
      label: 'input tokens',
      value: compact(e.inputTokens),
      note: `est. ${t.sep} chars ${t.g('÷', '/')} ${CHARS_PER_TOKEN} of the redacted text`,
    },
    {
      label: 'output tokens',
      value: compact(e.outputTokens),
      note: `est. ${t.sep} ${f.num(perCallOutput(e))} a call, measured`,
    },
    {
      label: 'estimated time',
      value: time,
      tone: e.chargeable ? (overTime ? 'warn' : 'none') : overTime ? 'warn' : 'accent',
      note: `est. ${timeRange} ${t.sep} target ${f.duration(TARGET_SECONDS * 1000)}`,
    },
    {
      label: e.chargeable ? 'estimated cost' : 'equivalent cost',
      value: money,
      tone: e.chargeable ? (overMoney ? 'warn' : 'accent') : 'dim',
      note: e.chargeable
        ? `est. ${moneyRange} ${t.sep} target ${f.money(TARGET_USD)}`
        : `$0 charged ${t.sep} ${moneyRange} on an api key`,
    },
    ...(o.maxUsd !== undefined
      ? [
          {
            label: 'hard ceiling',
            value: f.money(o.maxUsd),
            tone: e.usd > o.maxUsd ? ('warn' as const) : ('dim' as const),
            note:
              e.usd > o.maxUsd
                ? 'the run will stop part-way and say how far it got'
                : '--max-usd, checked before every call',
          },
        ]
      : []),
  ]);

  card.blank();
  for (const line of basisLines(e, t)) card.text(line, 'dim');
  card.blank();
  if (o.dryRun === false) {
    card.text('this is what the run will do.');
  } else {
    card.text('nothing was called, and nothing was written.');
    card.blank();
    card.fix(
      `potsherd card ${o.limit !== undefined ? `--limit ${o.limit}` : '--all'}` +
        `${o.maxUsd !== undefined ? ` --max-usd ${o.maxUsd}` : ''}`,
      'to write these cards for real.',
      'to write them.',
    );
  }
  return card.toString();
}

/**
 * An estimate rounded to the precision it actually has.
 *
 * `f.duration` gives `55m 25s`, which is the right answer for a stopwatch and
 * the wrong one for a projection: the seconds are noise dressed as knowledge.
 * Above two minutes this rounds to the minute; below it, to five seconds.
 */
export function approxDuration(seconds: number): string {
  if (seconds >= 120) return f.duration(Math.round(seconds / 60) * 60_000);
  return f.duration(Math.round(seconds / 5) * 5_000);
}

/** Output tokens the profile expects per call — the measured figure, shown. */
function perCallOutput(e: { calls: number; outputTokens: number }): number {
  return e.calls > 0 ? Math.round(e.outputTokens / e.calls) : 0;
}

/**
 * A dollar figure at the precision an estimate has. `$11.18` claims cents it
 * cannot know; `$11` is the same number without the false promise.
 */
export function approxMoney(usd: number): string {
  if (usd >= 10) return `$${Math.round(usd)}`;
  if (usd >= 1) return `$${(Math.round(usd * 10) / 10).toFixed(1)}`;
  return f.money(usd);
}

/**
 * Where the two headline numbers come from.
 *
 * The first line says what the constants are fitted to, and whether they were
 * fitted at all — the api and codex paths have never been measured and must
 * say so. The second says what *this* machine's own finished runs did to them,
 * because a correction the user cannot see is a number they cannot argue with.
 */
export function basisLines(
  e: { basis: string; measured: boolean; calibration?: Calibration },
  t: Theme,
): string[] {
  const first = e.measured
    ? `time and cost are estimates, fitted to ${e.basis}.`
    : `time and cost are estimates: ${e.basis}.`;
  const cal = e.calibration;
  const second =
    cal && cal.samples > 0
      ? `corrected ${t.g('×', 'x')}${cal.timeRatio.toFixed(1)} on time and ` +
        `${t.g('×', 'x')}${cal.usdRatio.toFixed(1)} on cost from ` +
        `${cal.samples} finished ${f.plural(cal.samples, 'run')} here.`
      : 'no finished run on this machine yet has corrected them.';
  return [first, second];
}

/** `1.2M`, `418k`, `900`. Token counts are magnitudes, not exact figures. */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
