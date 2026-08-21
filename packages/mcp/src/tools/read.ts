import { z } from 'zod';
import { showSession } from '@potsherd/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { UserError } from '../../../cli/src/output.js';
import { mustResolve } from '../../../cli/src/session-ref.js';
import { withIndex, type ServerContext } from '../context.js';
import { READ_DESCRIPTION } from '../descriptions.js';
import { guarded, jsonResult } from '../result.js';
import { SESSION_REF } from './shapes.js';

/**
 * Exchanges returned when the caller names no window.
 *
 * The CLI's `show` prints the whole session, because a terminal has a
 * scrollback and a human has a `q` key. A tool result has neither: it is
 * pasted whole into a context window, and a 400-exchange session arrives as
 * half a megabyte the model did not ask for and cannot skip. So this surface
 * pages by default and says so in the reply — `total`, `hasMore` and
 * `nextStartLine` are on every page, which is the difference between a model
 * that reads three pages and one that gives up after the first.
 */
export const READ_PAGE = 25;

/** The largest window a caller may ask for in one call. */
export const READ_MAX_SPAN = 200;

export const readInput = {
  session: SESSION_REF,
  start_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`first exchange to return, 1-based and inclusive. Default 1`),
  end_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `last exchange to return, 1-based and inclusive. Default start_line + ${READ_PAGE - 1}; at most ${READ_MAX_SPAN} exchanges per call`,
    ),
};

export type ReadArgs = z.infer<z.ZodObject<typeof readInput>>;

/**
 * `potsherd show`, paginated.
 *
 * `start_line` and `end_line` are the contract's names for what the CLI calls
 * `--from` and `--to`, and they mean the same thing it means: **1-based,
 * inclusive exchange numbers**, not lines of text and not characters. An
 * exchange is one user turn plus the assistant's reply, which is the unit the
 * index stores, the unit `seq` counts and the unit every citation in `ask` and
 * `graft` points at. Paginating by anything else would hand back a `seq` that
 * no citation could name.
 *
 * A ghost — a session Claude Code deleted, rebuilt from `history.jsonl` — has
 * prompts and no replies. It is returned with `ghostPrompts` populated and
 * `exchanges` empty, exactly as `show --json` returns it, because a reader that
 * is not told which half is missing will write "we decided X" about a
 * conversation whose answer nobody has.
 */
export function runRead(ctx: ServerContext, args: ReadArgs): Record<string, unknown> {
  return withIndex(ctx, (db) => {
    const found = mustResolve(db, args.session, 'read');

    const from = Math.max(1, args.start_line ?? 1);
    const requestedTo = args.end_line ?? from + READ_PAGE - 1;
    if (requestedTo < from) {
      throw new UserError(
        `end_line (${requestedTo}) is before start_line (${from})`,
        `potsherd show ${found.id.slice(0, 8)} --from ${from} --to ${from + READ_PAGE - 1}`,
      );
    }
    const to = Math.min(requestedTo, from + READ_MAX_SPAN - 1);

    const result = showSession(db, found.id, { from, to });
    if (!result) {
      throw new UserError(
        `session ${found.id} is in the index but has no body`,
        'potsherd index --full',
      );
    }

    const shown = result.exchanges.length || (result.ghostPrompts?.length ?? 0);
    const hasMore = result.to < result.total;

    return {
      session: result.session,
      from: result.from,
      to: result.to,
      total: result.total,
      // The contract's own words, echoed back so a client never has to guess
      // whether its window was honoured or clamped.
      start_line: result.from,
      end_line: result.to,
      shown,
      hasMore,
      nextStartLine: hasMore ? result.to + 1 : null,
      truncated: requestedTo > to,
      exchanges: result.exchanges,
      ghostPrompts: result.ghostPrompts ?? null,
      children: result.children,
      card: result.card,
    };
  });
}

export function registerRead(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'potsherd_read',
    {
      title: 'Read one past session',
      description: READ_DESCRIPTION,
      inputSchema: readInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => guarded(async () => jsonResult(runRead(ctx, args as ReadArgs))),
  );
}
