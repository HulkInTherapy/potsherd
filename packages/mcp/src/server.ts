import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { VERSION } from '@potsherd/core';
import type { ServerContext } from './context.js';
import { registerAsk } from './tools/ask.js';
import { registerFind } from './tools/find.js';
import { registerGraft } from './tools/graft.js';
import { registerLs } from './tools/ls.js';
import { registerRead } from './tools/read.js';
import { registerTag } from './tools/tag.js';

/**
 * The six names, in one array, so that "six tools, no more" is a thing the
 * build can check rather than a thing a reviewer has to count.
 *
 * `03` §9 fixes the ceiling and names the anti-pattern: agentmemory ships 54
 * and a model handed 54 tools picks none of them. Six is not a budget that
 * happened to be enough — it is the whole verb surface a memory tool needs, and
 * a seventh would mean one of these six failed to cover its job. `tests/mcp.
 * test.ts` asserts the list, in order, so a seventh tool cannot be added by
 * anyone who has not read this paragraph.
 */
export const TOOLS = [
  'potsherd_find',
  'potsherd_read',
  'potsherd_ask',
  'potsherd_graft',
  'potsherd_ls',
  'potsherd_tag',
] as const;

/** Every tool but `potsherd_tag` reads and does not write. */
export const WRITE_TOOLS: readonly string[] = ['potsherd_tag'];

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: 'potsherd', version: VERSION, title: 'potsherd' },
    {
      capabilities: { tools: {} },
      instructions:
        'potsherd indexes every coding-agent session on this machine — Claude Code, Codex, ' +
        'Cursor, pi — including subagent transcripts and sessions the harness has already ' +
        'deleted. Search it BEFORE telling the user you have no memory of earlier work: ' +
        'potsherd_find for words, potsherd_ls for a period or a label, potsherd_read for the ' +
        'exact exchanges, potsherd_graft to carry a past session into this one, and ' +
        'potsherd_ask (slow, ~100s) only when the first four cannot answer. ' +
        'potsherd_tag is the only tool here that writes anything.',
    },
  );

  // Registration order is the order the tool list is advertised in, and the
  // order is the teaching order from `plans/05`: find, then read what you
  // found, then the two expensive verbs, then browse, then label.
  registerFind(server, ctx);
  registerRead(server, ctx);
  registerAsk(server, ctx);
  registerGraft(server, ctx);
  registerLs(server, ctx);
  registerTag(server, ctx);

  return server;
}
