import { z } from 'zod';
import { idTag, showSession } from '@potsherd/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { UserError } from '../../../cli/src/output.js';
import { withIndex, type ServerContext } from '../context.js';
import { READ_DESCRIPTION } from '../descriptions.js';
import { guarded, jsonResult } from '../result.js';
import { THREAD_REF } from './shapes.js';
import { citationFacts, mintCitation } from './sources.js';
import { resolveThreadRef, type ThreadLink } from './thread.js';

/**
 * `potsherd_read(thread, from?, to?)` — the windowing subagent's whole world.
 *
 * Plan §B7 gives the reason for the parenthesis in its own sentence:
 * *"(paginated, seq+ts — so the windowing subagent never needs filesystem
 * `Read`)"*. That is F3's fix stated as a capability rather than a prohibition.
 * The archaeologist lost `Read` because it used it to cite `HANDOFF.md §3`; it
 * can afford to lose it because everything it legitimately needed `Read` for is
 * here — ordered exchanges, a page at a time, each carrying the `seq` and `ts`
 * a citation is made of, and a `citation` line minted from the index so the
 * agent copies rather than composes.
 *
 * Three differences from the v1.1.0 `potsherd_read`, all of them F4:
 *
 *   **The unit is the thread.** `from` and `to` are positions in the whole
 *   fork/resume chain, not in one link of it. A chain whose newest link holds
 *   four exchanges and whose parent holds 1,738 reads as one run of 1,742,
 *   which is what the work actually was.
 *
 *   **Every row says which session it came from.** `seq` is session-local —
 *   it is what `[id8@seq]` cites and what `filterAnswer` resolves against — so
 *   a thread-global position without a `sessionId` beside it would be a
 *   citation nobody could check. Both are on every row.
 *
 *   **The names are `from` and `to`.** `start_line`/`end_line` were wrong in
 *   two ways at once: these are exchanges rather than lines, and the CLI has
 *   called them `--from`/`--to` since phase 2. One vocabulary.
 */

/** Exchanges returned when the caller names no window. */
export const READ_PAGE = 25;

/** The largest window a caller may ask for in one call. */
export const READ_MAX_SPAN = 200;

export const readInput = {
  thread: THREAD_REF,
  from: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('first exchange in the thread to return, 1-based and inclusive. Default 1'),
  to: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `last exchange to return, 1-based and inclusive. Default from + ${READ_PAGE - 1}; at most ${READ_MAX_SPAN} exchanges per call`,
    ),
};

export type ReadArgs = z.infer<z.ZodObject<typeof readInput>>;

export function runRead(ctx: ServerContext, args: ReadArgs): Record<string, unknown> {
  return withIndex(ctx, (db) => {
    const thread = resolveThreadRef(db, args.thread, 'read');

    const from = Math.max(1, args.from ?? 1);
    const requestedTo = args.to ?? from + READ_PAGE - 1;
    if (requestedTo < from) {
      throw new UserError(
        `to (${requestedTo}) is before from (${from})`,
        `potsherd_read {"thread":"${idTag(thread.threadId)}","from":${from},"to":${from + READ_PAGE - 1}}`,
      );
    }
    const to = Math.min(requestedTo, from + READ_MAX_SPAN - 1, thread.total);

    const exchanges: Record<string, unknown>[] = [];
    const ghostPrompts: Record<string, unknown>[] = [];
    const citations: { sessionId: string; id8: string; citation: string }[] = [];
    const children: { id: string; agentName: string | null; exchanges: number }[] = [];
    let card: unknown = null;

    for (const link of thread.links) {
      const span = overlap(link, from, to);
      if (!span) continue;

      const shown = showSession(db, link.sessionId, { from: span.localFrom, to: span.localTo });
      if (!shown) continue;

      const facts = citationFacts(db, link.sessionId);
      const citation = facts
        ? mintCitation(facts)
        : mintCitation({
            sessionId: link.sessionId,
            kind: link.kind,
            harness: 'claude',
            project: null,
            exchanges: link.total,
            prompts: link.total,
            date: (link.endedAt ?? link.startedAt)?.slice(0, 10) ?? null,
          });
      citations.push({ sessionId: link.sessionId, id8: link.id8, citation });
      if (!card && shown.card) card = shown.card;
      for (const c of shown.children) children.push(c);

      for (const e of shown.exchanges) {
        exchanges.push({
          position: link.offset + (e.seq - 1),
          sessionId: link.sessionId,
          id8: link.id8,
          // Session-local, because that is what `<id8>@<seq>` means everywhere
          // else in this product. Cite with this, never with `position`.
          seq: e.seq,
          ts: e.ts,
          cite: `${link.id8}@${String(e.seq)}`,
          citation,
          userText: e.userText,
          assistantText: e.assistantText,
          filesTouched: e.filesTouched,
          toolCalls: e.toolCalls,
          isSidechain: e.isSidechain,
          redacted: e.redacted,
        });
      }

      for (const p of shown.ghostPrompts ?? []) {
        ghostPrompts.push({
          position: link.offset + (p.seq - 1),
          sessionId: link.sessionId,
          id8: link.id8,
          seq: p.seq,
          ts: p.ts,
          cite: `${link.id8}@${String(p.seq)}`,
          citation,
          text: p.text,
          assistantSide: 'unrecoverable',
        });
      }
    }

    const shown = exchanges.length + ghostPrompts.length;
    const hasMore = to < thread.total;

    return {
      thread: {
        id: thread.threadId,
        // VERIFICATION-8 C8-1 — `idTag`, never `slice(0, 8)`. See `mintCitation`.
        id8: idTag(thread.threadId),
        via: thread.via,
        note: thread.note,
        links: thread.links,
      },
      from,
      to,
      total: thread.total,
      shown,
      hasMore,
      nextFrom: hasMore ? to + 1 : null,
      truncated: requestedTo > to,
      /**
       * The only lines that count as sources for anything read here.
       *
       * `sources.ts` refuses a `SOURCES` row whose id8 does not resolve; these
       * are the rows that do, written by code from the index. Copy one.
       */
      citations,
      citationRule:
        'A source line is one of the strings in `citations`, copied. A line you composed — a ' +
        'file path, a dash, an id you did not get from potsherd — is refused as a citation.',
      exchanges,
      ghostPrompts: ghostPrompts.length > 0 ? ghostPrompts : null,
      ghostNote:
        ghostPrompts.length > 0
          ? 'these are PROMPTS ONLY. The assistant side was deleted by the harness sweep and is ' +
            'not recoverable. You may say what was asked. You may not say what was answered.'
          : null,
      children,
      card,
    };
  });
}

/** Where a thread-global window falls inside one link, in that link's own numbering. */
function overlap(
  link: ThreadLink,
  from: number,
  to: number,
): { localFrom: number; localTo: number } | null {
  const start = link.offset;
  const end = link.offset + link.total - 1;
  if (to < start || from > end) return null;
  return {
    localFrom: Math.max(from, start) - start + 1,
    localTo: Math.min(to, end) - start + 1,
  };
}

export function registerRead(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'potsherd_read',
    {
      title: 'Read a past thread',
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
