import { z } from 'zod';
import { listSessions } from '@potsherd/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { parseFilters, parseLimit } from '../../../cli/src/filters.js';
import { withIndex, type ServerContext } from '../context.js';
import { LS_DESCRIPTION } from '../descriptions.js';
import { guarded, jsonResult } from '../result.js';
import { TRI_STATE, whenField } from './shapes.js';
import { toFlags } from './find.js';

export const lsInput = {
  project: z
    .string()
    .optional()
    .describe('only this project — a directory name like "event-bus", not a path'),
  tag: z.string().optional().describe('only sessions carrying this tag'),
  pinned: z.boolean().optional().describe('only sessions the user pinned'),
  ghosts: TRI_STATE.describe(
    'sessions the harness deleted, rebuilt from history: include (default), only, or exclude',
  ),
  since: whenField('only sessions at or after this'),
  limit: z.number().int().min(1).max(200).optional().describe('rows to return. Default 15'),
};

export type LsArgs = z.infer<z.ZodObject<typeof lsInput>>;

/**
 * `potsherd ls`, minus the terminal.
 *
 * The CLI's default of 15 is kept rather than raised. It is not a screen-size
 * accident that happens to suit a terminal: `ls` is the verb that answers "what
 * have I been doing", and the answer to that is the last fortnight, not the
 * last year. A model that wants more asks for more, and the reply says how many
 * there were in `total`, so it always knows whether it is looking at all of
 * them.
 *
 * `resume` is on every row — `claude --resume <id>`, or the harness's
 * equivalent — because the most useful thing a client can do with a row is
 * hand the user the one command that reopens it.
 */
export function runLs(ctx: ServerContext, args: LsArgs): Record<string, unknown> {
  return withIndex(ctx, (db, root) => {
    const filters = parseFilters(db, toFlags(args));
    const limit = parseLimit(args.limit, 15);
    // The ignore list applies here exactly as it does at the CLI: an agent
    // reading this tool is reading the same archive the user is looking at,
    // and a filter that held on one surface and not the other would be worse
    // than no filter. `root` so it is read from the same `--potsherd-dir`.
    const result = listSessions(db, filters, { limit, root });

    return {
      total: result.total,
      shown: result.sessions.length,
      ghosts: result.ghosts,
      sidechains: result.sidechains,
      rolledUp: result.rolledUp,
      // `--json` parity: what `ls --json` carries, this carries. A hidden row
      // an agent cannot know about is the same lie to a model as to a person.
      ignored: result.ignored,
      filters,
      sessions: result.sessions.map((s) => ({
        id: s.id,
        kind: s.kind,
        harness: s.harness,
        title: s.title,
        displayTitle: s.displayTitle,
        cardTitle: s.cardTitle,
        cardSource: s.cardSource,
        project: s.project,
        projectName: s.projectName,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        status: s.status,
        isSidechain: s.isSidechain,
        parentSessionId: s.parentSessionId,
        agentName: s.agentName,
        gitBranch: s.gitBranch,
        pinned: s.pinned,
        tags: s.tags,
        prompts: s.prompts,
        exchanges: s.exchanges,
        bytes: s.bytes,
        resume: s.resume,
      })),
    };
  });
}

export function registerLs(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'potsherd_ls',
    {
      title: 'List past sessions',
      description: LS_DESCRIPTION,
      inputSchema: lsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => guarded(async () => jsonResult(runLs(ctx, args as LsArgs))),
  );
}
