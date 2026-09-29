import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

import { VERSION } from '@potsherd/core';

import type { ServerContext } from './context.js';
import { createServer } from './server.js';

/**
 * A real MCP client, joined to a real server, over an in-memory transport.
 *
 * Everything that exercises this package goes through here — `--selftest` and
 * `tests/mcp.test.ts` both — for one reason: calling the `run*` functions
 * directly would prove the wrapping and not the **wiring**, and the wiring is
 * the half that breaks. A zod shape that does not match the argument a client
 * sends, a handler registered under the wrong name, a result the SDK's own
 * validator rejects: none of those are visible from inside the function.
 *
 * It lives in `src/` rather than in the test file for a mechanical reason too.
 * `vitest.config.ts` collects `tests/**` and `packages/*​/src/**`, and the MCP
 * SDK resolves from `packages/mcp/node_modules` — so a test at the repository
 * root cannot import the SDK, while a module in this package can. One
 * re-export here is cheaper than an alias in a config file four other live
 * workers are also depending on.
 */
export interface Harness {
  client: Client;
  close: () => Promise<void>;
}

export async function connectInMemory(ctx: ServerContext, name = 'potsherd-harness'): Promise<Harness> {
  const server = createServer(ctx);
  const client = new Client({ name, version: VERSION });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function listTools(client: Client): Promise<ListToolsResult> {
  return client.listTools();
}

/** One `tools/call`, returned whether it succeeded or came back as an error. */
export async function callRaw(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The text a tool returned — the `--json` bytes on success, the message on failure. */
export function textOf(r: CallToolResult): string {
  const first = r.content?.[0];
  return first && first.type === 'text' ? first.text : '';
}

/** One successful `tools/call`, parsed. Throws with the tool's own message. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await callRaw(client, name, args);
  if (r.isError) throw new Error(`${name}: ${textOf(r)}`);
  return JSON.parse(textOf(r)) as Record<string, unknown>;
}

export type { CallToolResult, Client };
