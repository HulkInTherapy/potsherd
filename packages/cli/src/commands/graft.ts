import process from 'node:process';

import {
  DEFAULT_BUDGET,
  GraftError,
  Llm,
  MIN_BUDGET,
  NoBackendError,
  ReentrancyError,
  graft,
  graftJson,
  renderGraft,
  type Llm as LlmType,
} from '@potsherd/core';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { openIndex } from '../filters.js';
import { mustResolve } from '../session-ref.js';

/**
 * `potsherd graft` — a month-old session, dropped into a live agent's context.
 *
 * `plans/05` moment 5. One command, and the agent knows a thing from another
 * project a month ago. Everything about this verb is in service of the brief
 * being *short, cited and honest about its budget*, and the CLI's share of
 * that is three decisions:
 *
 * **The target may be a query.** `graft "instagram client"` is in the spec
 * alongside `graft 4c9339e0`, so the id path goes through `session-ref.ts` —
 * the resolver `show`, `tag`, `pin` and `link` already share — and only falls
 * through to `recall` when nothing in the index has an id like that. There is
 * no second resolver.
 *
 * **No backend is not a failure.** A re-entry verb that needs the network is a
 * re-entry verb that does not work on a plane. With no `claude`, no `codex`
 * and no key, `graft` prints a brief assembled from the card in code and says
 * `unsummarised` on the face of it. `--no-model` asks for that path directly.
 *
 * **It writes into the current directory.** `./.potsherd/graft-<id8>.md` is
 * the one place potsherd writes outside `~/.potsherd`, and it is deliberate:
 * the brief is for *this* project, and the agent working in it should be able
 * to read the file without being told where potsherd keeps its things. The
 * directory gets a generated `.gitignore` — which never clobbers one that is
 * already there — and `doctor --privacy` names the path.
 */
export interface GraftCommandOptions extends GlobalOptions {
  target: string;
  about?: string;
  budget?: number;
  clip?: boolean;
  /** `--no-model`: the card-only brief, with no call and no backend needed. */
  model?: boolean | string;
  backend?: string;
  cwd?: string;
}

export async function runGraft(o: GraftCommandOptions): Promise<number> {
  const target = o.target?.trim();
  if (!target) {
    throw new UserError('graft needs a session id or a query', 'potsherd graft 4c9339e0');
  }

  const budget = parseBudget(o.budget);
  const { db, root } = openIndex(o);
  let llm: LlmType | null = null;

  try {
    // The id form resolves through the shared resolver, so `graft 4c9339e0`
    // and `show 4c9339e0` can never mean two different sessions — and an
    // ambiguous prefix lists its candidates here rather than being silently
    // handed to `recall` as a search term.
    const resolved = looksLikeId(target) ? tryResolve(db, target) : null;
    const wanted = resolved ?? target;

    if (o.model !== false) {
      llm = openLlm(o);
    }

    const report = await graft(db, wanted, {
      ...(o.about ? { about: o.about } : {}),
      budget,
      clip: Boolean(o.clip),
      llm,
      root,
      ...(o.cwd ? { cwd: o.cwd } : {}),
    });

    if (o.json) {
      // `graftJson` is the shared shape; the chain is added here rather than
      // there so that a caller who grafts a session that was never forked sees
      // exactly the object it saw before, with `sessions: 1`.
      //
      // Both fields matter to an agent. `sessions` says the exchange count is
      // a **thread's**, spanning transcripts, so it cannot be reconciled
      // against `show <id>` on the id alone; `threadId` is the root, which is
      // the stable name for the work across every fork of it.
      printJson({
        ...graftJson(report),
        sessions: report.sessions,
        threadId: report.threadId,
      });
      return 0;
    }
    print(renderGraft(report, themeFrom(o)));
    return 0;
  } catch (err) {
    if (err instanceof GraftError) throw new UserError(err.message, err.fix);
    throw err;
  } finally {
    if (llm) await llm.close();
    db.close();
  }
}

/**
 * Try the shared resolver, and treat "no such id" as "then it was a query".
 *
 * An **ambiguous** prefix is different and is raised: two sessions whose ids
 * both start with what was typed is a question only the user can answer, and
 * quietly grafting the newer one is the confident-wrong-answer failure the
 * whole resolver exists to prevent.
 */
function tryResolve(db: ReturnType<typeof openIndex>['db'], ref: string): string | null {
  try {
    return mustResolve(db, ref, 'graft').id;
  } catch (err) {
    const message = (err as Error)?.message ?? '';
    if (message.includes('matches')) throw err;
    return null;
  }
}

/** Hex, no spaces, at least six characters: the shape `ls` and `find` print. */
function looksLikeId(s: string): boolean {
  return /^[0-9a-f]{6,}[0-9a-f:-]*$/i.test(s.trim());
}

function parseBudget(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_BUDGET;
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_BUDGET) {
    throw new UserError(
      `--budget takes a number of at least ${MIN_BUDGET} — not "${String(value)}"`,
      `potsherd graft <session> --budget ${DEFAULT_BUDGET}`,
    );
  }
  return Math.floor(n);
}

/**
 * A model if there is one, and `null` if there is not.
 *
 * `NoBackendError` is the case worth naming: with no `claude`, no `codex` and
 * no `ANTHROPIC_API_KEY` this verb still has a job, and refusing to do it
 * would be a re-entry tool that stops working exactly when someone is offline.
 * The brief comes back labelled `unsummarised` instead, and it says why.
 */
function openLlm(o: GraftCommandOptions): LlmType | null {
  try {
    return Llm.open({
      ...(typeof o.model === 'string' && o.model ? { model: o.model } : {}),
      ...(o.backend ? { backend: o.backend as 'agent-sdk' | 'codex' | 'api' } : {}),
      env: process.env,
    });
  } catch (err) {
    if (err instanceof NoBackendError || err instanceof ReentrancyError) return null;
    throw err;
  }
}
