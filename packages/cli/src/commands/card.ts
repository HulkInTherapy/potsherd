import {
  Llm,
  NoBackendError,
  detectBackend,
  planCards,
  renderEstimate,
  resolveSession,
  type BackendChoice,
  type CardPlan,
} from '@potsherd/core';
import { UserError, confirm, print, printJson, themeFrom, type GlobalOptions } from '../output.js';
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
}

export async function runCard(o: CardCommandOptions): Promise<number> {
  if (o.probe) return probe(o);

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
      ...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
    });

    if (o.json) {
      printJson(cardJson(plan, choice, missing, o));
      return o.dryRun || !missing ? 0 : 1;
    }

    print(
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
    if (!o.yes) {
      const ok = await confirm(`  card ${plan.targets.length} sessions?`, { default: false });
      if (!ok) {
        print('  nothing was called.');
        return 0;
      }
    }

    // T2.2 replaces this line with the ProMem-lite pipeline. Everything it
    // needs is already built: `plan.targets`, and an `Llm` from `Llm.open()`.
    throw new UserError(
      'the card pipeline is not wired yet — T2.1 ships the estimator, the caps and the backend',
      'potsherd card --dry-run --all',
    );
  } finally {
    db.close();
  }
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
      usd: Number(plan.estimate.usd.toFixed(4)),
      seconds: Math.round(plan.estimate.seconds),
      minutes: Number((plan.estimate.seconds / 60).toFixed(1)),
      model: plan.estimate.model,
      chargeable: plan.estimate.chargeable,
    },
    ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
    ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
  };
}
