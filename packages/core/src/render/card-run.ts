import { Card, table } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { tildify } from '../paths.js';
import { idTag } from '../recall.js';
import type { CardRunReport } from '../cards/run.js';
import { compact, TARGET_SECONDS, TARGET_USD } from './estimate.js';
import { accuracyShort } from '../calibration.js';

/**
 * The receipt for a card run: what ran, what it cost, and how much of it the
 * transcript refused to confirm.
 *
 * `phases/phase-1/HANDOFF.md`, rule 8: *a run reports what the run did; the
 * index reports what the index holds.* This card is the first kind. It never
 * says how many cards exist — only how many this run wrote — and the
 * `verified` line is the run's own number, not a property of the store.
 *
 * The `dropped` figure is given the accent even when it is small, because it
 * is the one number here that says the pipeline did its job. A run reporting
 * `0 dropped` across a whole archive is not a clean bill of health; it means
 * the filter never bit and something upstream is wrong (`phase-2` T2.2's
 * acceptance says so outright). The card therefore says that, in words, when
 * it happens.
 */

export interface CardRunOptions {
  root?: string;
  ranAt?: Date;
  /** `agent-sdk — your own subscription, $0`. */
  backendNote?: string;
  model?: string;
  chargeable?: boolean;
  concurrency?: number;
  /** How many cards to list under the totals. */
  show?: number;
  maxUsd?: number;
  /**
   * What the pre-run quote said, so the receipt can grade it (T2.6).
   *
   * An estimator that never publishes its own error is just a confident one.
   * The same comparison is written to `card_runs` and corrects the next quote.
   */
  predicted?: { seconds: number; usd: number };
}

export function renderCardRun(
  report: CardRunReport,
  t: Theme = new Theme(),
  o: CardRunOptions = {},
): string {
  const card = new Card(t);
  const chargeable = o.chargeable ?? true;
  card
    .heading('card', ...(o.root ? [tildify(o.root)] : []), f.date(o.ranAt ?? new Date()))
    .blank();

  // The cap first. A run that stopped at `--max-usd` before its first call has
  // written nothing and failed nothing, and "nothing was carded" is the one
  // thing it must not say: the user set a ceiling, hit it, and needs to be
  // told that rather than left thinking their archive had nothing in it.
  if (report.aborted) {
    card.rows([
      { label: 'cards written', value: f.num(report.written), note: `of ${f.num(report.aborted.total)} in scope` },
      { label: chargeable ? 'cost' : 'equivalent cost', value: f.money(report.usd), tone: 'dim', note: 'before the ceiling stopped it' },
    ]);
    card.blank();
    card.text(report.aborted.message, 'warn');
    card.blank();
    card.fix(report.aborted.fix, 'to carry on from where it stopped.', 'to carry on.');
    return card.toString();
  }

  if (report.written === 0 && report.failed === 0) {
    card.text('nothing was carded.').blank();
    card.fix('potsherd card --dry-run --all', 'to see what is in scope.', 'to see the scope.');
    return card.toString();
  }

  const overTime = report.ms / 1000 > TARGET_SECONDS;
  const overMoney = report.usd > TARGET_USD;

  card.rows([
    {
      label: 'cards written',
      value: f.num(report.written),
      note:
        [
          report.failed ? `${f.num(report.failed)} failed` : '',
          report.deferred ? `${f.num(report.deferred)} ghosts deferred to T2.3` : '',
          report.supplemented ? `${f.num(report.supplemented)} supplemented` : '',
        ]
          .filter(Boolean)
          .join(` ${t.sep} `) || 'every session in scope',
    },
    {
      label: 'claims kept',
      value: f.num(report.verified.kept),
      // "the cards hold", not "verify passed": dedupe runs after verify, so
      // the two numbers differ and only one of them is on disk (T2.7 D7).
      note: 'decisions and open threads the cards hold',
    },
    {
      label: 'claims dropped',
      value: f.num(report.verified.dropped),
      tone: report.verified.dropped === 0 ? 'warn' : 'accent',
      note:
        report.verified.dropped === 0
          ? 'nothing was filtered — check the verify step ran'
          : dropNote(report, t),
    },
    ...(report.unresolved
      ? [
          {
            label: 'unresolved seq',
            value: f.num(report.unresolved),
            tone: 'warn' as const,
            note: 'cards citing exchanges that do not exist — this is a bug',
          },
        ]
      : []),
    ...(report.degraded
      ? [
          {
            label: 'minimal cards',
            value: f.num(report.degraded),
            tone: 'warn' as const,
            note: 'the model never returned valid json; title and summary only',
          },
        ]
      : []),
  ]);

  card.blank();

  card.rows([
    {
      label: 'model calls',
      value: f.num(report.calls),
      note: `${o.model ?? 'haiku'} ${t.sep} ${o.backendNote ?? 'agent-sdk'}`,
    },
    {
      label: 'wall time',
      value: f.duration(report.ms),
      tone: overTime ? 'warn' : chargeable ? 'none' : 'accent',
      note: overTime
        ? `over the ${f.duration(TARGET_SECONDS * 1000)} target${o.concurrency ? ` at concurrency ${o.concurrency}` : ''}`
        : `target ${f.duration(TARGET_SECONDS * 1000)}${o.concurrency ? ` ${t.sep} concurrency ${o.concurrency}` : ''}`,
    },
    {
      label: chargeable ? 'cost' : 'equivalent cost',
      value: f.money(report.usd),
      tone: chargeable ? (overMoney ? 'warn' : 'accent') : 'dim',
      note: chargeable
        ? overMoney
          ? `over the ${f.money(TARGET_USD)} target`
          : `target ${f.money(TARGET_USD)}`
        : `$0 charged ${t.sep} what this would have cost on an api key`,
    },
    {
      label: 'input tokens',
      value: compact(report.inputTokens),
      tone: 'dim',
      // The agent sdk's `usage.input_tokens` excludes cache tokens, so it
      // reported 1,980 for a 198-call run. When it is not believable the
      // number here is ours, and the note says so rather than letting an
      // estimate pass for a measurement (T2.6).
      note: report.inputTokensEstimated
        ? `est. ${t.sep} chars ${t.g('÷', '/')} 3.6, not counted by the sdk`
        : `measured ${t.sep} reported by the backend`,
    },
    ...(o.predicted
      ? [
          {
            label: 'the estimate said',
            value: f.duration(o.predicted.seconds * 1000),
            tone: 'dim' as const,
            note: accuracyShort({
              predictedSeconds: o.predicted.seconds,
              actualSeconds: report.ms / 1000,
              predictedUsd: o.predicted.usd,
              actualUsd: report.usd,
            }),
          },
        ]
      : []),
  ]);

  const show = o.show ?? 6;
  const listed = report.cards.slice(0, show);
  if (listed.length > 0) {
    card.blank();
    card.text(
      listed.length < report.cards.length
        ? `${listed.length} of ${report.cards.length} cards, most-filtered first:`
        : 'the cards:',
    );
    card.blank();
    for (const line of table(
      t,
      listed.map((c) => [
        c.title || idTag(c.id),
        c.outcome,
        `${c.decisions}d ${c.openThreads}o`,
        c.dropped ? `-${c.dropped}` : t.g('·', '.'),
        c.coverage === null ? t.g('·', '.') : `${Math.round(c.coverage * 100)}%`,
      ]),
      { grow: 0, align: ['left', 'left', 'right', 'right', 'right'] },
    )) {
      card.raw(line);
    }
  }

  if (report.errors.length > 0) {
    card.blank();
    card.text(`${f.num(report.errors.length)} failed:`, 'warn');
    for (const e of report.errors.slice(0, 3)) {
      card.text(`  ${idTag(e.id)}  ${f.clip(e.message, Math.max(20, t.width - 16), t)}`, 'dim');
    }
  }

  card.blank();
  card.fix('potsherd ls', 'to read them as titles instead of uuids.', 'to read them.');
  return card.toString();
}

/** Why claims were dropped, in one note-width line. */
function dropNote(report: CardRunReport, t: Theme): string {
  const parts = [
    report.dropsByReason['no-match'] ? `${report.dropsByReason['no-match']} unsupported` : '',
    report.dropsByReason['unresolved-seq']
      ? `${report.dropsByReason['unresolved-seq']} bad seq`
      : '',
    report.dropsByReason['no-citation'] ? `${report.dropsByReason['no-citation']} uncited` : '',
    // Ghosts only, and worth its own word: these claims *were* in the prompts.
    // They were dropped because the prompt asked about the choice instead of
    // making it (`cards/ghost.ts`).
    report.dropsByReason['asked-not-decided']
      ? `${report.dropsByReason['asked-not-decided']} asked, not decided`
      : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(` ${t.sep} `) : 'no evidence in the cited exchanges';
}
