/**
 * A five-method MCP server, for testing `agentmemory.ts`'s client.
 *
 * Not a mock of agentmemory: it is a *protocol* stand-in. agentmemory is not
 * installed on the machine this was written on, so the bridge's result-shape
 * handling is tested against invented shapes (`parseHits`) and the client's
 * protocol handling is tested against this — which is the honest split. What
 * this file proves is that the four-message handshake works, that argument
 * names are read out of `tools/list` rather than hard-coded, and that the
 * consent gate is real.
 *
 * Writes are appended to a file rather than kept in memory so the test can
 * assert that a run without `--yes` wrote *nothing* — an assertion that can
 * only be made from outside the process that would have done the writing.
 *
 * Nothing here contains real session ids, titles or prose.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const WRITE_LOG = path.join(os.tmpdir(), 'potsherd-stub-mcp-writes.jsonl');
// Truncated at startup, so each spawned server starts from a clean slate and a
// test can assert "nothing was written" without inheriting an earlier run.
try {
  fs.rmSync(WRITE_LOG, { force: true });
} catch {
  /* nothing to remove */
}

const TOOLS = [
  {
    name: 'memory_smart_search',
    description: 'Hybrid semantic+keyword search with progressive disclosure.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        expandIds: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_store',
    description: 'Store one memory.',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string' }, title: { type: 'string' }, tags: { type: 'array' } },
      required: ['content'],
    },
  },
  // A decoy the write-tool discovery must not choose.
  {
    name: 'memory_delete_all',
    description: 'Remove every memory.',
    inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stub', version: '0.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params ?? {};
    if (name === 'memory_smart_search') {
      // The query is echoed back so the test can prove the client sent it
      // under the argument name the schema above declared.
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: [
                  { id: 'stub-1', text: `stub memory about ${args.query ?? ''}`, created_at: '2026-01-01T00:00:00Z' },
                  { id: 'stub-2', text: 'a second stub memory' },
                ],
              }),
            },
          ],
        },
      });
      return;
    }
    if (name === 'memory_store') {
      fs.appendFileSync(WRITE_LOG, `${JSON.stringify(args)}\n`);
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no such tool: ${name}` } });
  }
});
