import process from 'node:process';

import {
  Llm,
  NoBackendError,
  detectBackend,
  exportCards,
  paths,
  planCards,
  recordCardRun,
  renderCardRun,
  renderEstimate,
  resolveSession,
  runCards,
  type BackendChoice,
  type CardPlan,
  type CardRunReport,
} from '@potsherd/core';
import {
  Progress,
  UserError,
  confirm,
  print,
  printJson,
  themeFrom,
  type GlobalOptions,
} from '../output.js';
import { openIndex, parseFilters, type FilterFlags } from '../filters.js';

/**
 * `potsherd card` — the quote, and (from T2.2) the run.
 *
 * T2.1 owns everything up to the first model call: which sessions are in
 * scope, what they will cost, whether there is a backend at all, and the
 * consent gate. The ProMem-lite pipeline that turns a target into a card is
 * T2.2's; this file calls `planCards()` and stops.
 *
 * The order matters and is the acceptance criterion: **`--dry-run` never
 * touches a backend.** It does not even require one to exist — someone with no
 * `claude` and no key can still ask what carding their archive would cost, and
 * gets a real number plus the one sentence that tells them what they would
 * need. Nothing else in potsherd is allowed to make that decision later.
 *
 * T2.2 adds the second half: past the confirmation, `runCards()` executes the
 * ProMem-lite pipeline over `plan.targets` at concurrency and prints the
 * receipt. The estimate is still rendered first on every path, so the quote
 * and the bill are shown by the same command in the same run.
 *
 * **Ghosts are planned but not carded here.** `planCards` selects them and
 * prices them — they are 90 of the reference machine's 126 targets and a quote
 * that hid them would be a lie — and `runCards({ kinds: ['session'] })` steps
 * over them until T2.3 supplies a ghost transcript loader.
 */

export interface CardCommandOptions extends GlobalOptions, FilterFlags {
  session?: string;
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  probe?: boolean;
  model?: string;
  backend?: string;
  maxUsd?: number;
  maxTokens?: number;
  concurrency?: number;
  /** `--export <dir>`: copy the markdown mirror out. No model, no index. */
  export?: string;
}

export async function runCard(o: CardCommandOptions): Promise<number> {
  if (o.probe) return probe(o);
  if (o.export) return runExport(o, o.export);

  const { db, root } = openIndex(o);
  try {
    const filters = parseFilters(db, o);

    if (o.session) {
      const found = resolveSession(db, o.session);
      if (!found) {
        throw new UserError(`no session matches "${o.session}"`, 'potsherd ls');
      }
      filters.sessionId = found.id;
    } else if (!o.all && !filters.pinned && !filters.project && !filters.tag && !filters.since) {
      throw new UserError(
        'say which sessions to card',
        'potsherd card --dry-run --all      # what the whole archive would cost',
      );
    }

    // A dry run must work with no credentials at all, so a missing backend is
    // a note on the card here and an error only when something is about to run.
    let choice: BackendChoice | null = null;
    let missing: NoBackendError | null = null;
    try {
      choice = detectBackend({
        ...(o.model ? { model: o.model } : {}),
        ...(o.backend ? { backend: o.backend as BackendChoice['backend'] } : {}),
      });
    } catch (err) {
      if (!(err instanceof NoBackendError)) throw err;
      missing = err;
    }

    const plan = planCards(db, {
      filters,
      force: Boolean(o.force),
      ...(o.model ? { model: o.model } : {}),
      ...(choice ? { backend: choice.backend, chargeable: choice.chargeable } : {}),
      concurrency: o.concurrency ?? DEFAULT_CONCURRENCY,
    });

    // `--json` on a dry run is the quote and nothing else. `--json` on a real
    // run has to wait for the run: printing the plan here and the receipt
    // afterwards would emit two json documents on one stream, which nothing
    // downstream can parse. (T2.1 returned here unconditionally because there
    // was no second half to wait for.)
    if (o.json && (o.dryRun || missing || plan.targets.length === 0)) {
      printJson(cardJson(plan, choice, missing, o));
      return o.dryRun || !missing ? 0 : 1;
    }

    if (!o.json && !o.quiet) print(
      renderEstimate(plan, themeFrom(o), {
        root,
        backendNote: backendNote(choice, missing),
        ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
        dryRun: o.dryRun !== false,
      }),
    );

    if (o.dryRun) return 0;

    // Past this line something would actually be spent.
    if (missing) throw new UserError(missing.message, missing.fix);
    if (plan.targets.length === 0) return 0;
    if (!o.yes && !o.json) {
      const ok = await confirm(`  card ${plan.targets.length} sessions?`, { default: false });
      if (!ok) {
        print('  nothing was called.');
        return 0;
      }
    }

    const llm = Llm.open({
      ...(o.model ? { model: o.model } : {}),
      ...(o.backend ? { backend: o.backend as BackendChoice['backend'] } : {}),
      ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
      ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
    });

    const showProgress = !o.json && !o.quiet && Boolean(process.stderr.isTTY);
    const bar = new Progress('carding', showProgress);
    const concurrency = o.concurrency ?? DEFAULT_CONCURRENCY;

    let report: CardRunReport;
    try {
      report = await runCards(db, llm, {
        root,
        targets: plan.targets,
        concurrency,
        force: Boolean(o.force),
        onProgress: (p) => {
          if (p.phase === 'start') bar.update(p.done, p.total, p.target.id.slice(0, 8));
          else bar.update(p.done, p.total, p.detail ?? '');
        },
      });
    } finally {
      bar.done();
      await llm.close();
    }

    // T2.6: the estimator's self-check. One row saying what this run was
    // quoted and what it did, so the *next* quote on this machine corrects
    // itself by the difference (`core/src/calibration.ts`).
    recordCardRun(db, {
      backend: choice?.backend ?? 'agent-sdk',
      model: plan.model,
      concurrency,
      targets: plan.targets.length,
      predictedCalls: plan.estimate.calls,
      predictedSeconds: plan.estimate.seconds,
      predictedUsd: plan.estimate.usd,
      actualCalls: report.calls,
      actualSeconds: report.ms / 1000,
      actualUsd: report.usd,
      complete: !report.aborted && report.failed === 0,
    });

    if (o.json) {
      printJson(runJson(report, choice, concurrency));
      return report.aborted || report.failed > 0 ? 1 : 0;
    }
    if (!o.quiet) {
      print(
        renderCardRun(report, themeFrom(o), {
          root,
          model: plan.model,
          concurrency,
          backendNote: backendNote(choice, missing),
          chargeable: choice?.chargeable ?? true,
          predicted: { seconds: plan.estimate.seconds, usd: plan.estimate.usd },
          ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
        }),
      );
    }
    return report.aborted || report.failed > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

/** `03` §12: concurrency 6 is the default from phase 2 on. */
export const DEFAULT_CONCURRENCY = 6;

/**
 * `potsherd card --export <dir>` — copy the markdown mirror into a repo.
 *
 * Deliberately not a model verb: it reads `~/.potsherd/cards` and writes
 * files, and it must work on a machine with no backend at all. That is why it
 * short-circuits before `openIndex` needs anything but a path.
 */
function runExport(o: CardCommandOptions, dest: string): number {
  const root = paths.potsherdDir(o.potsherdDir);
  const result = exportCards(root, dest);
  if (o.json) {
    printJson({ ...result, from: paths.cardsDir(root) });
    return 0;
  }
  const t = themeFrom(o);
  print('');
  if (result.files === 0) {
    print(`  no cards in ${paths.tildify(paths.cardsDir(root))} yet.`);
    print(`  ${t.dim('try:')}  potsherd card --all`);
  } else {
    print(
      `  ${t.ok(String(result.files))} card${result.files === 1 ? '' : 's'} copied to ${dest}` +
        ` ${t.sep} ${(result.bytes / 1024).toFixed(0)} kB`,
    );
  }
  print('');
  return 0;
}

/**
 * The smallest possible real call, on purpose.
 *
 * There is no other way to answer "does the subscription path actually work on
 * this machine" without spending a run on it, and a user who is about to card
 * 300 sessions should be able to ask first. It is a deliberate, single,
 * user-initiated model call and it prints exactly what it cost.
 */
async function probe(o: CardCommandOptions): Promise<number> {
  const llm = Llm.open({
    ...(o.model ? { model: o.model } : {}),
    ...(o.backend ? { backend: o.backend as BackendChoice['backend'] } : {}),
  });
  try {
    const r = await llm.text({
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: 16,
      label: 'probe',
    });
    if (o.json) {
      printJson({
        backend: r.backend,
        model: r.model,
        text: r.text,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        usd: r.usd,
        chargeable: r.chargeable,
        ms: r.ms,
      });
      return 0;
    }
    const t = themeFrom(o);
    print('');
    print(`  ${t.ok('ok')}  ${r.backend} ${t.sep} ${r.model}`);
    print(
      `  ${t.dim('reply')}     ${r.text.trim().slice(0, 60)}`,
    );
    print(
      `  ${t.dim('cost')}      ${r.inputTokens} in ${t.sep} ${r.outputTokens} out ${t.sep} ` +
        `$${r.usd.toFixed(4)}${r.chargeable ? '' : ' equivalent'} ${t.sep} ${(r.ms / 1000).toFixed(1)}s`,
    );
    print('');
    return 0;
  } finally {
    await llm.close();
  }
}

/**
 * The receipt, as data.
 *
 * `verified` and `dropsByReason` are at the top level rather than buried per
 * card because they are the numbers `phase-2` T2.2's acceptance is written
 * against, and a check that has to reduce an array to find them is a check
 * nobody runs.
 */
function runJson(
  report: CardRunReport,
  choice: BackendChoice | null,
  concurrency: number,
): unknown {
  return {
    written: report.written,
    failed: report.failed,
    deferred: report.deferred,
    degraded: report.degraded,
    supplemented: report.supplemented,
    verified: report.verified,
    dropsByReason: report.dropsByReason,
    unresolved: report.unresolved,
    calls: report.calls,
    inputTokens: report.inputTokens,
    // The agent sdk does not count what it sends, so this is our own estimate
    // and the receipt says which it is (T2.6).
    inputTokensEstimated: report.inputTokensEstimated,
    outputTokens: report.outputTokens,
    usd: Number(report.usd.toFixed(4)),
    seconds: Math.round(report.ms / 1000),
    concurrency,
    backend: choice ? { name: choice.backend, model: choice.model, chargeable: choice.chargeable } : null,
    aborted: report.aborted ?? null,
    errors: report.errors,
    cards: report.cards,
  };
}

function backendNote(choice: BackendChoice | null, missing: NoBackendError | null): string {
  if (choice) {
    return choice.chargeable
      ? `${choice.backend} — metered, ANTHROPIC_API_KEY`
      : `${choice.backend} — your own subscription, $0`;
  }
  void missing;
  return 'no backend — install Claude Code or set ANTHROPIC_API_KEY';
}

function cardJson(
  plan: CardPlan,
  choice: BackendChoice | null,
  missing: NoBackendError | null,
  o: CardCommandOptions,
): unknown {
  return {
    dryRun: Boolean(o.dryRun),
    backend: choice
      ? { name: choice.backend, model: choice.model, why: choice.why, chargeable: choice.chargeable }
      : null,
    missing: missing ? { message: missing.message, fix: missing.fix } : null,
    targets: plan.targets.length,
    sessions: plan.sessions,
    ghosts: plan.ghosts,
    considered: plan.considered,
    skipped: plan.skipped,
    estimate: {
      sessions: plan.estimate.sessions,
      calls: plan.estimate.calls,
      inputTokens: plan.estimate.inputTokens,
      outputTokens: plan.estimate.outputTokens,
      // Every figure here is an estimate; the range and the basis travel with
      // them so a machine consumer cannot mistake one for a measurement (T2.6).
      estimated: true,
      usd: Number(plan.estimate.usd.toFixed(4)),
      usdLow: Number(plan.estimate.usdLow.toFixed(4)),
      usdHigh: Number(plan.estimate.usdHigh.toFixed(4)),
      seconds: Math.round(plan.estimate.seconds),
      secondsLow: Math.round(plan.estimate.secondsLow),
      secondsHigh: Math.round(plan.estimate.secondsHigh),
      minutes: Number((plan.estimate.seconds / 60).toFixed(1)),
      basis: plan.estimate.basis,
      measured: plan.estimate.measured,
      effectiveConcurrency: Number(plan.estimate.effectiveConcurrency.toFixed(2)),
      calibration: plan.estimate.calibration ?? null,
      model: plan.estimate.model,
      chargeable: plan.estimate.chargeable,
    },
    ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
    ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
  };
}
