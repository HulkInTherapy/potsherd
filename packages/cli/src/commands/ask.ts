import process from 'node:process';

import {
  ASK_CONCURRENCY,
  ASK_K,
  ASK_MAX_USD,
  NoBackendError,
  ask,
  detectBackend,
  format as f,
  renderAsk,
  type AskDrop,
  type AskResult,
} from '@potsherd/core';
import {
  Progress,
  UserError,
  print,
  printJson,
  themeFrom,
  type GlobalOptions,
} from '../output.js';
import { openIndex, parseFilters, type FilterFlags } from '../filters.js';

/**
 * `potsherd ask` — interrogation with citations (`03` §8).
 *
 * This file does four things and deliberately not a fifth: it parses the
 * flags, opens the index, shows cost and time while the readers run, and
 * prints `AskResult`. **Every judgement about what a user is allowed to read
 * lives in `core/ask.ts`'s filter**, above this layer, so that the library
 * entry point and the CLI cannot diverge — the phase-5 plugin will call `ask()`
 * directly with its own reader function and must get the same guarantees this
 * command gets.
 *
 * The exit codes are part of the interface:
 *
 * ```
 *   0   an answer, grounded
 *   1   nothing matched, or nothing survived the filter without --strict
 *   2   --strict and fewer than two evidence lines survived   (phase-4 T4.1 §4)
 * ```
 */

export interface AskCommandOptions extends GlobalOptions, FilterFlags {
  question: string;
  k?: unknown;
  strict?: boolean;
  maxUsd?: unknown;
  model?: string;
  readerModel?: string;
  concurrency?: unknown;
  vectors?: string;
  vec?: boolean;
}

export async function runAsk(o: AskCommandOptions): Promise<number> {
  const question = o.question?.trim();
  if (!question) {
    throw new UserError(
      'ask needs a question',
      'potsherd ask "how did we handle pgbouncer with prepared statements?"',
    );
  }

  // A verb that is about to spend money says so before it spends it, and says
  // what would fix it when it cannot. `card --dry-run` is allowed to work with
  // no backend because it makes no call; `ask` always makes one.
  try {
    detectBackend({ ...(o.model ? { model: o.model } : {}) });
  } catch (err) {
    if (err instanceof NoBackendError) throw new UserError(err.message, err.fix);
    throw err;
  }

  const { db, root } = openIndex(o);
  const t = themeFrom(o);
  const drops: AskDrop[] = [];
  const progress = new Progress('reading', !o.json && !o.quiet && Boolean(process.stderr.isTTY));

  try {
    const filters = parseFilters(db, o);
    const result = await ask(db, question, {
      filters,
      root,
      k: positive(o.k, ASK_K, '--k'),
      strict: Boolean(o.strict),
      maxUsd: money(o.maxUsd),
      concurrency: positive(o.concurrency, ASK_CONCURRENCY, '--concurrency'),
      ...(vectorMode(o) !== undefined ? { vectors: vectorMode(o) } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(o.readerModel ? { readerModel: o.readerModel } : {}),
      onProgress: (p) => {
        if (p.step !== 'read') return;
        // Cost and time, live, on stderr — so `ask --json > f` still shows it
        // and the json stays parseable. `est.` is inherited from the result,
        // never guessed here.
        progress.update(
          p.done,
          p.total,
          `${f.money(p.spend.usd)}${p.spend.estimatedInputCalls > 0 ? ' est.' : ''}`,
        );
      },
      onDrop: (d) => drops.push(d),
    });
    progress.done();

    if (o.debug) reportDrops(drops);

    if (o.json) {
      // `AskResult` verbatim, as `phases/phase-4/WAVE.md` pins it. Nothing is
      // reshaped, renamed or summarised on the way out — the eval harness and
      // the human view are reading the same object.
      printJson(result);
      return exitCode(result);
    }

    print(renderAsk(result, t, new Date()));
    return exitCode(result);
  } finally {
    progress.done();
    db.close();
  }
}

/**
 * `--strict` refusing is not an error in the shell sense of "something broke",
 * but it must be distinguishable from an answer, or `potsherd ask … --strict &&
 * do-something` would act on a refusal. phase-4 T4.1 §4 fixes it at 2.
 */
function exitCode(r: AskResult): number {
  if (r.refused) return 2;
  return r.sentences.length > 0 ? 0 : 1;
}

/**
 * What the filter threw away, under `--debug` only.
 *
 * On stderr, so it can never contaminate `--json`. This is the audit trail for
 * the one claim the product makes that nobody should take on trust: a run that
 * drops nothing on an adversarial question is a bug, and without this there is
 * no way to see it from outside.
 */
function reportDrops(drops: readonly AskDrop[]): void {
  if (drops.length === 0) {
    process.stderr.write('  filter: nothing dropped\n');
    return;
  }
  process.stderr.write(`  filter: ${drops.length} dropped\n`);
  for (const d of drops) {
    const where = d.sessionId ? `${d.sessionId.slice(0, 8)}@${d.seq}` : '';
    const text = d.text.replace(/\s+/g, ' ').slice(0, 90);
    process.stderr.write(`    ${d.kind.padEnd(8)} ${d.reason.padEnd(16)} ${where.padEnd(14)} ${text}\n`);
  }
}

function positive(value: unknown, fallback: number, flag: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new UserError(`${flag} takes a positive number — not "${String(value)}"`, `potsherd ask "…" ${flag} ${fallback}`);
  }
  return Math.floor(n);
}

function money(value: unknown): number {
  if (value === undefined || value === null || value === '') return ASK_MAX_USD;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UserError(
      `--max-usd takes a positive number — not "${String(value)}"`,
      `potsherd ask "…" --max-usd ${ASK_MAX_USD}`,
    );
  }
  return n;
}

/**
 * `--vectors on|auto|off`, or **nothing at all**.
 *
 * Returning `undefined` when the user did not choose is the whole point and it
 * cost a day to learn: `find` registers `--vectors` with `.default('auto')`,
 * and copying that here meant the CLI passed `'auto'` on every run and
 * silently overrode `ask`'s own default of vectors-on. Every real run then
 * shortlisted on bm25 alone, and on the reference corpus that is the
 * difference between the six sessions that discuss the question and six that
 * tie at 0.0098 because the AND pass relaxed. Four consecutive runs came back
 * `0 answered` and the readers were blamed for it.
 *
 * So the flag has no default here. Unset means "the library decides", and the
 * library's reasoning is in `ask.ts` beside the `recall` call.
 */
function vectorMode(o: AskCommandOptions): boolean | 'auto' | undefined {
  if (o.vec === false) return false;
  switch (o.vectors) {
    case 'on':
      return true;
    case 'auto':
      return 'auto';
    case 'off':
      return false;
    default:
      return undefined;
  }
}
