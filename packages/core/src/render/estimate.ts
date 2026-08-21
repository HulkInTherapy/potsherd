import { Card } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { tildify } from '../paths.js';
import { CHARS_PER_TOKEN } from '../llm.js';
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

  const money = f.money(e.usd);
  const time = f.duration(e.seconds * 1000);
  const overTime = e.seconds > TARGET_SECONDS;
  const overMoney = e.usd > TARGET_USD;

  card.rows([
    {
      label: 'input tokens',
      value: compact(e.inputTokens),
      note: `chars ${t.g('÷', '/')} ${CHARS_PER_TOKEN} of the redacted text`,
    },
    {
      label: 'output tokens',
      value: compact(e.outputTokens),
      note: 'estimated, not measured',
    },
    {
      label: 'estimated time',
      value: time,
      tone: e.chargeable ? (overTime ? 'warn' : 'none') : overTime ? 'warn' : 'accent',
      note: e.chargeable
        ? overTime
          ? `over the ${f.duration(TARGET_SECONDS * 1000)} target`
          : `target ${f.duration(TARGET_SECONDS * 1000)}`
        : 'the real budget on your subscription',
    },
    {
      label: e.chargeable ? 'estimated cost' : 'equivalent cost',
      value: money,
      tone: e.chargeable ? (overMoney ? 'warn' : 'accent') : 'dim',
      note: e.chargeable
        ? overMoney
          ? `over the ${f.money(TARGET_USD)} target`
          : `target ${f.money(TARGET_USD)}`
        : `$0 charged ${t.sep} what this would cost on an api key`,
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
  if (o.dryRun === false) {
    card.text('this is what the run will do.');
  } else {
    card.text('nothing was called, and nothing was written.');
    card.blank();
    card.fix(
      `potsherd card --all${o.maxUsd !== undefined ? ` --max-usd ${o.maxUsd}` : ''}`,
      'to write these cards for real.',
      'to write them.',
    );
  }
  return card.toString();
}

/** `1.2M`, `418k`, `900`. Token counts are magnitudes, not exact figures. */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
