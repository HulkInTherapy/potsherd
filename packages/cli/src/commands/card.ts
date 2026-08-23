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
import { openIndex, parseFilters, parseLimit, type FilterFlags } from '../filters.js';

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
 * **Ghosts are carded here too** (T2.3). `planCards` selects and prices them
 * beside the surviving sessions — on the reference machine they are 299 of the
 * 329 targets, and a quote that hid them would be a lie — and `runCards` sends
 * them through the same pipeline with a different loader. The card they get
 * says `source: prompts-only` and its outcome is always `unknown`.
 * `--ghosts only` (or `--ghosts-only`) cards nothing else.
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
  /**
   * `--ghosts-only`: card the sessions Claude Code deleted and nothing else.
   *
   * Spelled as its own boolean rather than as the bare `--ghosts` the phase
   * plan sketches, because `--ghosts <mode>` is a shared filter flag that
   * takes a value on `find` and `ls` too. Making it optional-valued would let
   * `potsherd card --ghosts 9c4d2f18` swallow the session argument. `rescue`
   * already spells the same idea `--ghosts-only`.
   */
  ghostsOnly?: boolean;
  /**
   * `--limit n`: card the **n newest** targets.
   *
   * A shared filter flag, so it arrives here for free — but until T2.7 it was
   * dropped on the floor between `filterFlags()` and `planCards()`, and
   * `card --ghosts-only --limit 10` quoted and ran all ninety. A limit that
   * the quote honours and the run ignores is worse than no limit at all: the
   * confirmation says 10 and the machine spends an hour. Quote and run share
   * one `plan.targets`, so they cannot disagree.
   *
   * **T8.E: a limit is a scope.** `--limit 5` used to be refused with "say
   * which sessions to card" unless `--all` (or a filter) came with it, which
   * made the smallest, cheapest, most obvious first card run the one command
   * that did not work. It now implies `--all`: everything eligible, ordered
   * newest-first by `planCards`, cut to n. It still *composes* — `--ghosts-only
   * --limit 5` is the five newest ghosts, `--project x --limit 5` the five
   * newest in that project — because it caps after the filters, not instead
   * of them, and `--force` only changes what is eligible before the cut.
   */
  limit?: number;
}

export async function runCard(o: CardCommandOptions): Promise<number> {
  if (o.probe) return probe(o);
  if (o.export) return runExport(o, o.export);

  const { db, root } = openIndex(o);
  try {
    const filters = parseFilters(db, o);
    if (o.ghostsOnly) filters.ghosts = 'only';

    const limit = parseLimit(o.limit, 0);

    if (o.session) {
      const found = resolveSession(db, o.session);
      if (!found) {
        throw new UserError(`no session matches "${o.session}"`, 'potsherd ls');
      }
      filters.sessionId = found.id;
    } else if (
      !o.all &&
      // `--limit n` names a scope on its own: the n newest. It is the first
      // card run a stranger should make, and refusing it was the one thing
      // standing between the dry-run quote and a real card (`08` §8.6).
      limit === 0 &&
      !filters.pinned &&
      !filters.project &&
      !filters.tag &&
      !filters.since &&
      // `--ghosts only` and `--status ghost` each name a scope on their own:
      // "card everything the sweep took" is a whole request, and on the
      // reference machine it is 299 of the 329 targets.
      filters.ghosts !== 'only' &&
      filters.status !== 'ghost'
    ) {
      throw new UserError(
        'say which sessions to card — a session id, a filter, --limit n, or --all',
        'potsherd card --limit 5 --dry-run      # the 5 newest, quoted before anything runs',
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
      ...(limit > 0 ? { limit } : {}),
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
        ...(limit > 0 ? { limit } : {}),
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
    print(
      result.skipped > 0
        ? `  no cards in ${paths.tildify(paths.cardsDir(root))} — only ${result.skipped} error marker` +
          `${result.skipped === 1 ? '' : 's'} from a failed run.`
        : `  no cards in ${paths.tildify(paths.cardsDir(root))} yet.`,
    );
    print(`  ${t.dim('try:')}  potsherd card --all`);
  } else {
    print(
      `  ${t.ok(String(result.files))} card${result.files === 1 ? '' : 's'} copied to ${dest}` +
        ` ${t.sep} ${(result.bytes / 1024).toFixed(0)} kB`,
    );
    // The skipped ones are failed sessions, and a user who exported a vault
    // should be told the vault is short rather than left to count.
    if (result.skipped > 0) {
      print(
        `  ${t.dim(String(result.skipped) + ' not copied')} ${t.sep} ` +
          `error markers from a failed card run, not cards`,
      );
      print(`  ${t.dim('try:')}  potsherd card --all --force`);
    }
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
    backend: choice
      ? {
          name: choice.backend,
          model: choice.model,
          rung: choice.rung,
          rungId: choice.rungId,
          chargeable: choice.chargeable,
        }
      : null,
    aborted: report.aborted ?? null,
    errors: report.errors,
    cards: report.cards,
  };
}

/**
 * The one line on the quote and on the receipt that says how this machine
 * reaches a model — **and which rung of `llm.ts`'s ladder that is.**
 *
 * `card` is the verb the audit found dead on a clean install, and the reason
 * was never that the machine could not reach a model: it was that potsherd
 * only knew one way to. So the note now names the rung rather than only the
 * transport, because "rung 2 — the claude binary, spawned" tells a user what
 * changed and "agent-sdk" tells them nothing they can act on.
 *
 * When there is no backend at all, the note is {@link NoBackendError}'s own
 * `fix` — one line, from one place, so `card`, `ask` and `graft` cannot end up
 * telling three different stories about the same machine. On a host-agent
 * machine that line is the seam, not an install.
 */
function backendNote(choice: BackendChoice | null, missing: NoBackendError | null): string {
  if (choice) {
    const rung = `rung ${choice.rung}`;
    return choice.chargeable
      ? `${choice.backend} — ${rung}, metered, ANTHROPIC_API_KEY`
      : `${choice.backend} — ${rung}, your own subscription, $0`;
  }
  return missing ? `no backend — ${missing.fix}` : 'no backend';
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
      ? {
          name: choice.backend,
          model: choice.model,
          why: choice.why,
          // A1's ladder, as data. An agent reading `--json` should not have to
          // parse `why` to learn that the host seam was available and the
          // 677 MB package was not needed.
          rung: choice.rung,
          rungId: choice.rungId,
          chargeable: choice.chargeable,
        }
      : null,
    missing: missing ? { message: missing.message, fix: missing.fix, rung: missing.rung } : null,
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
