import process from 'node:process';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '@potsherd/core';

import { makeContext } from './context.js';
import { createServer } from './server.js';
import { selftest } from './selftest.js';

const USAGE = `potsherd-mcp — potsherd as an MCP stdio server (six tools)

  potsherd-mcp                     speak MCP on stdin/stdout
  potsherd-mcp --selftest          build a throwaway index and prove each tool answers
  potsherd-mcp --potsherd-dir DIR  read the index in DIR instead of ~/.potsherd

environment
  POTSHERD_DIR                     same as --potsherd-dir
  POTSHERD_GRAFT_CWD               where potsherd_graft writes its brief.
                                   Default: the directory the server was launched
                                   in, when that is a plausible project; otherwise
                                   nothing is written and the brief is returned inline.
  POTSHERD_MCP_ASK_TIMEOUT_MS      how long potsherd_ask may run. Default 240000.

.mcp.json
  { "mcpServers": { "potsherd": { "command": "node", "args": ["<this file>"] } } }
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (argv.includes('--selftest')) return selftest(process.stdout);

  const potsherdDir = flagValue(argv, '--potsherd-dir') ?? process.env['POTSHERD_DIR'];
  const ctx = makeContext(potsherdDir ? { potsherdDir } : {});
  const server = createServer(ctx);

  /**
   * Nothing but JSON-RPC may reach stdout.
   *
   * A stdio MCP server's stdout *is* the protocol channel. One stray
   * `console.log` — from this package, from a dependency, from a deprecation
   * warning — lands in the middle of a JSON-RPC frame and the client drops the
   * connection with a parse error that names no cause. `console` is therefore
   * pointed at stderr for the life of the process, where the client's log
   * viewer will show it.
   */
  console.log = console.info = console.debug = (...a: unknown[]) => {
    process.stderr.write(a.map(String).join(' ') + '\n');
  };

  /**
   * The server stays up. `WAVE.md` puts it as a rule binding on every worker
   * and it is the difference between a bad answer and a tool list that silently
   * disappears mid-conversation. Every *tool* failure is already a tool error
   * (`result.ts`); these two are the paths that are not a tool failure — a
   * rejected promise in a dependency, an EPIPE from a client that went away —
   * and neither of them is a reason to take the session with us.
   */
  process.on('uncaughtException', (err) => {
    process.stderr.write(`potsherd-mcp: uncaught: ${err?.stack ?? String(err)}\n`);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`potsherd-mcp: unhandled rejection: ${String(err)}\n`);
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `potsherd-mcp ${VERSION} ready · 6 tools · index ${potsherdDir ?? '~/.potsherd'}\n`,
  );

  /**
   * Run until the client goes away, then stop — and *actually* stop.
   *
   * Registering a `SIGTERM` handler replaces the default action, which is to
   * die. A stdio server also holds stdin open, so once that handler exists
   * nothing else will end the process: an editor that shuts the server down
   * between projects would leave one behind every time, and after a week the
   * user has twenty of them holding twenty sqlite handles. Caught the first
   * time this was driven over a real pipe — the child survived `kill` and had
   * to be killed by pid. So the signal path closes the transport and exits,
   * rather than merely resolving a promise and hoping the event loop drains.
   */
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => {
        void server.close().finally(() => process.exit(0));
      });
    }
  });
  await server.close().catch(() => {});
  return 0;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/index.js') ||
    process.argv[1].endsWith('/potsherd-mcp.js') ||
    process.argv[1].endsWith('/index.ts'));

if (invokedDirectly) {
  main().then(
    // `process.exit`, not `process.exitCode`: stdin is still open on the
    // server path and would hold the event loop forever. See the shutdown
    // note in `main`.
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`potsherd-mcp: ${(err as Error)?.message ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
