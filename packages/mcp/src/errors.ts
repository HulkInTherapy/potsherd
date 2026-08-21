import { UserError } from '../../cli/src/output.js';

/**
 * Every failure this server can have, turned into one line a model can act on.
 *
 * The acceptance test for this file is in `phases/phase-5/WAVE.md` and it is a
 * hard one: *errors are returned as tool errors, never a crash*. A stdio MCP
 * server that exits takes the client's whole session with it — the tool list
 * disappears mid-conversation and the model is left believing potsherd does not
 * exist. So nothing below throws; every path ends in a string.
 *
 * The string keeps the shape the CLI already prints, because a user reading
 * their terminal and a model reading a tool error are looking at the same
 * failure and should be told the same thing:
 *
 *     nothing indexed yet — no database at ~/.potsherd/potsherd.db
 *     try:  potsherd index
 *
 * `UserError.fix` is the one command that resolves it, and core's own typed
 * errors (`NoBackendError`, `GraftError`, `BudgetError`) carry the same field
 * under the same name, so one accessor covers both.
 */
export function describeError(err: unknown): string {
  if (err instanceof UserError) return withFix(err.message, err.fix);

  // Core's typed errors are not imported by class: `llm.ts` and `graft.ts` are
  // phase-4 modules and `instanceof` across a bundled and an unbundled copy of
  // the same class is a well-known way to lose a branch. The duck test is what
  // is actually being asked — "does this error know how to fix itself?".
  const e = err as { message?: unknown; fix?: unknown; name?: unknown } | null;
  if (e && typeof e === 'object' && typeof e.message === 'string') {
    return withFix(e.message, typeof e.fix === 'string' ? e.fix : undefined);
  }
  return String(err);
}

function withFix(message: string, fix?: string): string {
  return fix ? `${message}\ntry:  ${fix}` : message;
}
