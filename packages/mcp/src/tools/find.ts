import { z } from 'zod';
import { recall } from '@potsherd/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { parseFilters, parseLimit, type FilterFlags } from '../../../cli/src/filters.js';
import { UserError } from '../../../cli/src/output.js';
import { withIndexAsync, type ServerContext } from '../context.js';
import { FIND_DESCRIPTION } from '../descriptions.js';
import { guarded, jsonResult } from '../result.js';
import { TRI_STATE, whenField } from './shapes.js';

/** The pinned shape from `phases/phase-5/WAVE.md`. Fields, names and all. */
export const findInput = {
  query: z.string().min(1).describe('the words to look for, as the user would say them'),
  project: z
    .string()
    .optional()
    .describe('only this project — a directory name like "event-bus", not a path'),
  harness: z
    .enum(['claude', 'codex', 'cursor', 'pi', 'gemini', 'opencode', 'copilot'])
    .optional()
    .describe('only sessions from this coding agent'),
  since: whenField('only sessions at or after this'),
  until: whenField('only sessions at or before this'),
  tag: z.string().optional().describe('only sessions carrying this tag'),
  sidechains: TRI_STATE.describe(
    'subagent transcripts: include (default), only, or exclude. Most of the actual work is in these',
  ),
  ghosts: TRI_STATE.describe(
    'sessions the harness deleted, rebuilt from history: include (default), only, or exclude',
  ),
  pinned: z.boolean().optional().describe('only sessions the user pinned'),
  limit: z.number().int().min(1).max(100).optional().describe('sessions to return. Default 10'),
};

export type FindArgs = z.infer<z.ZodObject<typeof findInput>>;

/**
 * `potsherd find`, minus the terminal.
 *
 * This is `packages/cli/src/commands/find.ts` with `printJson` replaced by a
 * return: the same `parseFilters`, the same `parseLimit`, the same `recall`,
 * the same projection of every field. There is deliberately no second filter
 * parser in this package — `--project event-bus` has to select the same sessions
 * whether it arrives as a flag or as a JSON field, and the only way to
 * guarantee that is for one function to decide.
 *
 * Two things the CLI's `--json` does not do, both because the pinned contract
 * asks for them by name:
 *
 *   `hits` — the CLI nests hits inside their session. The contract names a
 *   top-level `hits[]`, and `RecallResult` already carries one (every hit that
 *   survived diversification, best first), so it is passed through rather than
 *   rebuilt. The nested copies stay where they were; nothing is moved.
 *
 *   `k`, `weights`, `relaxedLists` — the fusion's own parameters. The CLI puts
 *   these behind `--explain`; the contract puts them on every reply. They are
 *   three scalars, and a client that can see why a session ranked where it did
 *   is a client that can tell a weak match from a strong one without a model.
 *
 * Vectors are left on `'auto'`, exactly as `find` has them: bm25 answers and
 * the embedding model is only woken when the words did not match. A tool that
 * loaded a 34 MB model on every call would be a tool nobody leaves installed.
 */
export async function runFind(ctx: ServerContext, args: FindArgs): Promise<Record<string, unknown>> {
  const query = args.query?.trim();
  if (!query) {
    throw new UserError('find needs something to look for', 'potsherd find "pgbouncer"');
  }

  return withIndexAsync(ctx, async (db, root) => {
    const filters = parseFilters(db, toFlags(args));
    const limit = parseLimit(args.limit, 10);
    const result = await recall(db, query, filters, { limit, root, vectors: 'auto' });

    return {
      query: result.query,
      filters,
      vectors: result.vectors,
      lists: result.lists,
      relaxed: result.relaxed,
      ms: result.ms,
      // The contract's four named fields, straight off `RecallResult`.
      k: result.k,
      weights: result.weights,
      relaxedLists: result.relaxedLists,
      hits: result.hits.map(hitJson),
      sessions: result.sessions.map((s) => ({
        id: s.id,
        kind: s.kind,
        harness: s.harness,
        title: s.title,
        displayTitle: s.displayTitle,
        project: s.project,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        status: s.status,
        isSidechain: s.isSidechain,
        parentSessionId: s.parentSessionId,
        agentName: s.agentName,
        gitBranch: s.gitBranch,
        pinned: s.pinned,
        prompts: s.prompts,
        exchanges: s.exchanges,
        resume: s.resume,
        score: s.score,
        hits: s.hits.map(hitJson),
      })),
    };
  });
}

type Hit = Awaited<ReturnType<typeof recall>>['hits'][number];

function hitJson(h: Hit): Record<string, unknown> {
  return {
    kind: h.kind,
    sessionId: h.sessionId,
    isSidechain: h.isSidechain,
    id: h.id ?? null,
    seq: h.seq ?? null,
    ts: h.ts ?? null,
    score: h.score,
    from: h.from,
    snippet: h.snippet.text,
    match: h.snippet.match ?? null,
  };
}

/** The contract's field names, in the words `parseFilters` already speaks. */
export function toFlags(args: {
  project?: string;
  harness?: string;
  since?: string;
  until?: string;
  tag?: string;
  sidechains?: string;
  ghosts?: string;
  pinned?: boolean;
}): FilterFlags {
  return {
    ...(args.project ? { project: args.project } : {}),
    ...(args.harness ? { harness: args.harness } : {}),
    ...(args.since ? { since: args.since } : {}),
    ...(args.until ? { until: args.until } : {}),
    ...(args.tag ? { tag: args.tag } : {}),
    ...(args.sidechains ? { sidechains: args.sidechains } : {}),
    ...(args.ghosts ? { ghosts: args.ghosts } : {}),
    ...(args.pinned ? { pinned: true } : {}),
  };
}

export function registerFind(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'potsherd_find',
    {
      title: 'Search past coding sessions',
      description: FIND_DESCRIPTION,
      inputSchema: findInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => guarded(async () => jsonResult(await runFind(ctx, args as FindArgs))),
  );
}
