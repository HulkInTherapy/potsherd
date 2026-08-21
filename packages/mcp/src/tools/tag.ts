import { z } from 'zod';
import { applyTags, parseTagArgs, sessionTags } from '@potsherd/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { UserError } from '../../../cli/src/output.js';
import { mustResolve } from '../../../cli/src/session-ref.js';
import { withIndex, type ServerContext } from '../context.js';
import { TAG_DESCRIPTION } from '../descriptions.js';
import { guarded, jsonResult } from '../result.js';
import { SESSION_REF } from './shapes.js';

export const tagInput = {
  session: SESSION_REF,
  add: z
    .array(z.string())
    .optional()
    .describe('tags to add. Letters, digits and - . _ / only; lower-cased on the way in'),
  remove: z.array(z.string()).optional().describe('tags to take off'),
};

export type TagArgs = z.infer<z.ZodObject<typeof tagInput>>;

/**
 * `potsherd tag` — the one tool on this server that writes.
 *
 * The CLI takes `+postgres -mysql` as operands and splits them with
 * `parseTagArgs`; the contract takes two arrays. Both go through
 * `parseTagArgs`, by re-forming the operands, rather than through a second
 * normaliser written here — the normalisation is what makes `tag +Postgres`
 * findable by `ls --tag postgres`, and a surface that normalised tags its own
 * way would write rows that the filter cannot see. One parser, two syntaxes.
 *
 * With neither `add` nor `remove` this reads instead of writing, exactly as
 * `potsherd tag <id>` with no operands does. That is not a special case bolted
 * on: it is the safe thing to type when you cannot remember what a session
 * carries, and a model that can check before it writes is a model that writes
 * less often.
 *
 * The add and the remove land in one transaction, in core. "postgres, not
 * mysql" is a single correction, and two calls is how a session ends up tagged
 * both ways.
 */
export function runTag(ctx: ServerContext, args: TagArgs): Record<string, unknown> {
  return withIndex(ctx, (db) => {
    const found = mustResolve(db, args.session, 'tag');
    const session = { id: found.id, kind: found.kind, title: found.title };

    const ops = [
      ...(args.add ?? []).map((t) => `+${String(t).replace(/^\+/, '')}`),
      ...(args.remove ?? []).map((t) => `-${String(t).replace(/^-/, '')}`),
    ];

    if (ops.length === 0) {
      return {
        session,
        tags: sessionTags(db, found.id),
        added: [],
        removed: [],
        unchanged: [],
        rejected: [],
        wrote: false,
      };
    }

    const { add, remove, rejected } = parseTagArgs(ops);
    if (rejected.length > 0 && add.length === 0 && remove.length === 0) {
      throw new UserError(
        `nothing usable in ${rejected.map((r) => `"${r}"`).join(', ')} — a tag is letters, digits, - . _ or /`,
        `potsherd tag ${found.id.slice(0, 8)} +postgres -mysql`,
      );
    }

    const result = applyTags(db, found.id, { add, remove });
    return {
      session,
      tags: result.tags,
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
      rejected,
      wrote: result.added.length > 0 || result.removed.length > 0,
    };
  });
}

export function registerTag(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'potsherd_tag',
    {
      title: 'Tag a session (the only tool that writes to the index)',
      description: TAG_DESCRIPTION,
      inputSchema: tagInput,
      annotations: {
        // One of the two `readOnlyHint: false` tools on this server —
        // `potsherd_graft` is the other, because it creates a file in the
        // user's project. A client that colours write tools differently, or
        // asks before running them, is reading this field and it must be
        // honest.
        readOnlyHint: false,
        // It adds and removes labels. Nothing it touches is unrecoverable and
        // the same call twice leaves the same tags.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => guarded(async () => jsonResult(runTag(ctx, args as TagArgs))),
  );
}
