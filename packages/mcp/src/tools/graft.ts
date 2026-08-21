import { z } from 'zod';
import {
  DEFAULT_BUDGET,
  GraftError,
  Llm,
  MIN_BUDGET,
  NoBackendError,
  ReentrancyError,
  graft,
  graftJson,
  type Llm as LlmType,
} from '@potsherd/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { UserError } from '../../../cli/src/output.js';
import { mustResolve } from '../../../cli/src/session-ref.js';
import { withIndexAsync, type ServerContext } from '../context.js';
import { GRAFT_DESCRIPTION } from '../descriptions.js';
import { guarded, jsonResult } from '../result.js';
import { SESSION_REF } from './shapes.js';

export const graftInput = {
  session: SESSION_REF,
  about: z
    .string()
    .optional()
    .describe('narrow the brief to one topic, when the session covered several'),
  budget: z
    .number()
    .int()
    .min(MIN_BUDGET)
    .optional()
    .describe(`token ceiling for the brief itself. Default ${DEFAULT_BUDGET}`),
};

export type GraftArgs = z.infer<z.ZodObject<typeof graftInput>>;

/**
 * `potsherd graft` — one past session, compressed into a brief for this one.
 *
 * Two things this surface has to get right that the CLI does not.
 *
 * **Where the brief is written.** `graft` writes `./.potsherd/graft-<id8>.md`
 * into the process's working directory. For the CLI that is where the user
 * typed the command, which is by construction the project they mean. For a
 * stdio server it is wherever the client happened to launch it, which may be
 * `/`. The whole decision lives in `resolveGraftCwd` in `context.ts`; what
 * happens here is the consequence of it: when there is no plausible project
 * directory the call runs with `write: false`, `path` comes back `null`, and
 * the brief — which was always the deliverable — is returned inline with a note
 * saying why there is no file. The reply names the path on every call, so a
 * client is never left guessing whether something was written.
 *
 * **No backend is not a failure.** Copied straight from the CLI's reasoning: a
 * re-entry verb that needs the network is a re-entry verb that does not work on
 * a plane. With no `claude`, no `codex` and no key, the brief is assembled from
 * the stored card in code, comes back labelled `via: "card-only"` with a
 * `reason`, and is still cited. That is why `Llm.open` is wrapped rather than
 * awaited on — `NoBackendError` and `ReentrancyError` both mean "run the other
 * path", not "stop".
 *
 * The target is resolved through the shared `mustResolve`, so `graft 4c9339e0`
 * and `read 4c9339e0` can never mean two different sessions, and an ambiguous
 * prefix lists its candidates instead of quietly picking the newer one. Unlike
 * the CLI this does **not** fall through to a search when the id does not
 * resolve: at this surface the id came from `potsherd_find` or `potsherd_ls` a
 * moment ago, and silently searching for a mistyped id is how a model grafts a
 * session nobody asked for.
 */
export async function runGraft(
  ctx: ServerContext,
  args: GraftArgs,
): Promise<Record<string, unknown>> {
  const budget = Math.floor(args.budget ?? DEFAULT_BUDGET);
  if (!Number.isFinite(budget) || budget < MIN_BUDGET) {
    throw new UserError(
      `budget takes a number of at least ${MIN_BUDGET} — not "${String(args.budget)}"`,
      `potsherd graft <session> --budget ${DEFAULT_BUDGET}`,
    );
  }

  let llm: LlmType | null = null;
  try {
    return await withIndexAsync(ctx, async (db, root) => {
      const found = mustResolve(db, args.session, 'graft');
      llm = openLlm(ctx.env);

      const write = ctx.graftCwd !== null;
      const report = await graft(db, found.id, {
        ...(args.about ? { about: args.about } : {}),
        budget,
        llm,
        root,
        write,
        ...(ctx.graftCwd ? { cwd: ctx.graftCwd } : {}),
      });

      return {
        ...graftJson(report),
        // `graftJson` carries `path: ''` when nothing was written. `null` is
        // what a JSON consumer can branch on without knowing that.
        path: report.path || null,
        via: report.via,
        reason: report.reason,
        isGhost: report.isGhost,
        title: report.title,
        trimmed: report.trimmed,
        droppedLines: report.droppedLines,
        wrote: write,
        wroteGitignore: report.wroteGitignore,
        // The one disclosure this surface owes that the CLI does not: the CLI's
        // user knows what directory they are standing in and a model does not.
        writeNote: write
          ? `the brief is also on disk at ${report.path}`
          : 'nothing was written to disk: this server was launched with no project directory ' +
            '(set POTSHERD_GRAFT_CWD in the mcp server config to write the brief into a project). ' +
            'The brief above is complete.',
      };
    });
  } catch (err) {
    if (err instanceof GraftError) throw new UserError(err.message, err.fix);
    throw err;
  } finally {
    if (llm) await (llm as LlmType).close();
  }
}

function openLlm(env: NodeJS.ProcessEnv): LlmType | null {
  try {
    return Llm.open({ env });
  } catch (err) {
    if (err instanceof NoBackendError || err instanceof ReentrancyError) return null;
    throw err;
  }
}

export function registerGraft(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'potsherd_graft',
    {
      title: 'Bring a past session into this one',
      description: GRAFT_DESCRIPTION,
      inputSchema: graftInput,
      annotations: {
        // **This tool writes a file into the user's project, so it is not
        // read-only, whatever the prose around it once said.**
        //
        // It was annotated `readOnlyHint: true` until T5.9, on the reasoning
        // that it "modifies no state anything else reads" — not the index, not
        // the archive, not a transcript, not a tag. That reading is wrong for
        // this field. `readOnlyHint` is not documentation; it is the
        // machine-readable safety annotation clients use to decide what may run
        // WITHOUT ASKING. Annotated true, a model could create
        // `./.potsherd/graft-<id8>.md` and a `./.potsherd/.gitignore` in
        // somebody's repository with no prompt. The verifier watched it happen:
        //
        //     project dir before: []      project dir after: [".potsherd"]
        //     written by a tool annotated readOnlyHint:true:
        //       [".gitignore", "graft-c2f68b40.md"]
        //
        // MCP defines the field as "does not modify its environment", and
        // creating two files in the cwd is modifying the environment. The
        // narrower in-house reading of "read-only" is a fine thing to say in a
        // description; it is not a thing to say in this field.
        //
        // `WAVE.md` pinned the opposite ("every tool is read-only except
        // `potsherd_tag`") while its own next clause admitted the write
        // ("nothing writes outside `~/.potsherd` except `potsherd_graft`'s
        // brief, which lands in the cwd"). The contract contradicted itself;
        // the annotation follows the behaviour.
        //
        readOnlyHint: false,
        // The path is `graft-<id8>.md`, derived from the session, so a second
        // graft of the same session replaces its own file and nothing else's.
        // Not idempotent, though: `via === 'model'` means the brief is
        // regenerated and the bytes need not match.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => guarded(async () => jsonResult(await runGraft(ctx, args as GraftArgs))),
  );
}
