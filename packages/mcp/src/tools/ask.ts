import { z } from 'zod';
import { ASK_K, NoBackendError, ask, detectBackend } from '@potsherd/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

import { parseFilters } from '../../../cli/src/filters.js';
import { UserError } from '../../../cli/src/output.js';
import { withIndexAsync, type ServerContext } from '../context.js';
import { ASK_DESCRIPTION } from '../descriptions.js';
import { guarded, jsonResult } from '../result.js';
import { TRI_STATE, whenField } from './shapes.js';
import { toFlags } from './find.js';

/** The largest fan-out a client may ask for. See the note on latency below. */
export const ASK_MAX_K = 12;

export const askFilters = z
  .object({
    project: z.string().optional().describe('only this project'),
    harness: z
      .enum(['claude', 'codex', 'cursor', 'pi', 'gemini', 'opencode', 'copilot'])
      .optional()
      .describe('only sessions from this coding agent'),
    since: whenField('only sessions at or after this'),
    until: whenField('only sessions at or before this'),
    tag: z.string().optional().describe('only sessions carrying this tag'),
    sidechains: TRI_STATE.describe('subagent transcripts: include (default), only, exclude'),
    ghosts: TRI_STATE.describe('deleted sessions: include (default), only, exclude'),
    pinned: z.boolean().optional().describe('only pinned sessions'),
  })
  .optional()
  .describe('narrow which sessions may be read, in the same words potsherd_find takes');

export const askInput = {
  question: z.string().min(1).describe('the question, as the user asked it'),
  k: z
    .number()
    .int()
    .min(1)
    .max(ASK_MAX_K)
    .optional()
    .describe(
      `sessions to read. Default ${ASK_K}. Each one is a model call, so this is the dial that decides how long the answer takes`,
    ),
  strict: z
    .boolean()
    .optional()
    .describe('refuse rather than answer when fewer than two quotes survive the citation check'),
  filters: askFilters,
};

export type AskArgs = z.infer<z.ZodObject<typeof askInput>>;

/**
 * `potsherd ask`, and the one hard problem this server has.
 *
 * **Measured, on the reference machine: 40–183 s, p50 ≈ 100 s at k=6.** One
 * haiku-class call through the agent SDK is 60–160 s, and `ask` is `k` readers
 * plus a synthesizer. That is not a number a wrapper can optimise away — it is
 * what the verb costs — so this file's job is to make sure two minutes of real
 * work never *looks* like a hang. Four things do that, in the order a client
 * meets them:
 *
 * **1. It fails in milliseconds when it cannot possibly succeed.**
 * `detectBackend` runs before the index is even opened. With no `claude`, no
 * `codex` and no `ANTHROPIC_API_KEY` the answer comes back instantly as a tool
 * error naming what to install, instead of after a two-minute walk to the same
 * conclusion. An MCP client on a plane is a real case, and the plane is exactly
 * where a hundred-second silence is least forgivable.
 *
 * **2. It reports progress, which is also what keeps the client alive.**
 * MCP's progress notifications are not decoration: a spec-compliant client
 * resets its request timeout each time one arrives (`resetTimeoutOnProgress`),
 * so a tool that says nothing for 100 s is a tool that gets cancelled at 60 by
 * a default nobody chose. `ask` already emits a progress callback per reader
 * with live cost and time; it is forwarded verbatim, `est.` label and all, so
 * the user watches "read 4/6 · $0.08 est." advance instead of watching nothing.
 *
 * **3. It has a deadline, and the deadline is honest.** `POTSHERD_MCP_ASK_
 * TIMEOUT_MS`, 240 s by default — comfortably past the 183 s worst case ever
 * measured, close enough that a genuinely wedged backend is caught. On expiry
 * the call comes back as a **tool error** saying how long it ran and what to do
 * instead. It does not come back as an empty answer: `ask`'s readers report
 * `found: false` when their promise rejects, so an aborted run would otherwise
 * synthesise "nothing in your history addresses this" out of six cancelled
 * calls — a confident wrong answer, which is the one failure this product
 * cannot afford.
 *
 * **4. It tells the model the price up front.** The description says 40–180 s
 * and names `potsherd_find` as the cheaper move. `03` §9 is explicit that the
 * description decides whether a tool gets used; here it also decides whether it
 * gets used *when something free would have done*.
 *
 * What this file deliberately does **not** do is start a job and hand back a
 * ticket. A poll tool would be a seventh tool, and `03` §9 fixes the ceiling at
 * six with agentmemory's 54 as the named anti-pattern. Nor does it lower `k`
 * behind the user's back: the phase-4 handoff reports the latency target as a
 * miss rather than meeting it by narrowing the fan-out, and a surface that
 * quietly did the narrowing would be re-telling the lie the handoff refused to.
 */
export async function runAsk(
  ctx: ServerContext,
  args: AskArgs,
  o: {
    signal?: AbortSignal;
    onProgress?: (p: { done: number; total: number; message: string }) => void;
  } = {},
): Promise<Record<string, unknown>> {
  const question = args.question?.trim();
  if (!question) {
    throw new UserError(
      'ask needs a question',
      'potsherd ask "how did we handle pgbouncer with prepared statements?"',
    );
  }

  // Before the index, before the clock: a verb that is about to spend money
  // says so before it spends it, and says what would fix it when it cannot.
  try {
    detectBackend({ env: ctx.env });
  } catch (err) {
    if (err instanceof NoBackendError) throw new UserError(err.message, err.fix);
    throw err;
  }

  const started = Date.now();
  const deadline = AbortSignal.timeout(ctx.askTimeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;

  const filterArgs = args.filters ?? {};

  try {
    const result = await withIndexAsync(ctx, async (db, root) => {
      const filters = parseFilters(db, toFlags(filterArgs));
      return ask(db, question, {
        filters,
        root,
        k: args.k ?? ASK_K,
        strict: Boolean(args.strict),
        signal,
        onProgress: (p) => {
          if (p.step !== 'read') return;
          o.onProgress?.({
            done: p.done,
            total: p.total,
            message: `read ${p.done}/${p.total} · $${p.spend.usd.toFixed(4)}${
              p.spend.estimatedInputCalls > 0 ? ' est.' : ''
            }`,
          });
        },
      });
    });

    // An abort that arrived between the last reader and the return would
    // otherwise come back as a well-formed answer built from nothing.
    if (deadline.aborted) throw timedOut(ctx, started);

    // `AskResult` verbatim, exactly as `ask --json` prints it and as
    // `phases/phase-4/WAVE.md` pins it. Nothing is reshaped on the way out.
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    if (deadline.aborted) throw timedOut(ctx, started);
    throw err;
  }
}

function timedOut(ctx: ServerContext, started: number): UserError {
  const s = Math.round((Date.now() - started) / 1000);
  return new UserError(
    `ask gave up after ${s}s (limit ${Math.round(ctx.askTimeoutMs / 1000)}s). ` +
      'It reads k sessions with one model call each and something is not answering. ' +
      'Nothing was written and no answer is being guessed at.',
    'potsherd_find with the same words, then potsherd_read — or raise POTSHERD_MCP_ASK_TIMEOUT_MS',
  );
}

export function registerAsk(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'potsherd_ask',
    {
      title: 'Ask your own history a question (slow: ~100s)',
      description: ASK_DESCRIPTION,
      inputSchema: askInput,
      annotations: {
        // It reads. It spends money, which is not what `readOnlyHint` is about
        // — that field is about the *environment*, and `ask` changes nothing in
        // it. The cost is disclosed where a model will actually read it: the
        // first sentence of the description.
        readOnlyHint: true,
        destructiveHint: false,
        // Two identical questions are two different model runs.
        idempotentHint: false,
        // It calls a model over the network.
        openWorldHint: true,
      },
    },
    async (args, extra) =>
      guarded(async () =>
        jsonResult(
          await runAsk(ctx, args as AskArgs, {
            signal: extra.signal,
            onProgress: progressSink(extra),
          }),
        ),
      ),
  );
}

/**
 * Forward `ask`'s progress to the client, if the client asked for progress.
 *
 * A `progressToken` is only present when the client sent one, and sending a
 * progress notification without one is a protocol error. So the absence of a
 * token is the absence of a sink — never a reason to fail the call, and never a
 * reason to log. A notification that cannot be delivered is swallowed for the
 * same reason: the run is still worth finishing.
 */
function progressSink(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ((p: { done: number; total: number; message: string }) => void) | undefined {
  const progressToken = extra._meta?.['progressToken'] as string | number | undefined;
  if (progressToken === undefined) return undefined;
  return (p) => {
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: p.done, total: p.total, message: p.message },
      })
      .catch(() => {});
  };
}
