import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '@potsherd/core';

import { makeContext } from './context.js';
import { createServer } from './server.js';
import { selftest } from './selftest.js';

const USAGE = `potsherd-mcp — potsherd as an MCP stdio server (six tools)

  potsherd-mcp                     speak MCP on stdin/stdout
  potsherd-mcp --selftest          build a throwaway index and prove each tool answers
  potsherd-mcp --potsherd-dir DIR  read the index in DIR instead of ~/.potsherd
  potsherd-mcp --width N           column budget for --selftest. Default 80.

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
  if (argv.includes('--selftest')) {
    // `05` governs this screen: 80 columns, elide with an ellipsis, never
    // hard-cut mid-word. `--width` is the same flag every potsherd verb takes.
    const w = Number(flagValue(argv, '--width'));
    return selftest(process.stdout, Number.isFinite(w) && w > 0 ? Math.floor(w) : undefined);
  }

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

  /**
   * D14 — a line that is not JSON gets an answer.
   *
   * The SDK's `ReadBuffer` throws on a malformed frame, `StdioServerTransport`
   * catches it and calls `onerror`, and the default `onerror` is nothing at
   * all. So a client that wrote a truncated frame got: no reply, no error, no
   * log line — the server stayed up and perfectly silent, and the client sat
   * on that request id until somebody restarted it. Measured: `initialize`
   * replied, the malformed line produced zero bytes on stdout and zero on
   * stderr, and a subsequent good request was answered normally.
   *
   * JSON-RPC 2.0 says exactly what to send here: `-32700 Parse error`, with
   * `id: null`, because the id was inside the bytes we could not parse. That
   * does not unblock the client's own request id — nothing can, the id is
   * unknowable — but it turns "no response ever" into "the last thing you sent
   * was not JSON", which is the difference between a hang and a bug report.
   */
  const transport = new StdioServerTransport();
  transport.onerror = (err: Error) => {
    const parseError = /JSON|Unexpected|Unterminated|token/i.test(err.message);
    process.stderr.write(`potsherd-mcp: ${parseError ? 'unparseable frame' : 'transport error'}: ${err.message}\n`);
    if (!parseError) return;
    // One whole line, written between frames, so it cannot land inside one.
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err.message}`,
          data: { note: 'the id was inside the bytes that could not be parsed, so this reply carries none. Resend the request.' },
        },
      }) + '\n',
    );
  };

  await server.connect(transport);
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

/**
 * Is this module the program, rather than something a test imported?
 *
 * It used to be a list of **filenames** — `/index.js`, `/potsherd-mcp.js`,
 * `/index.ts` — and phase 7 broke it by copying the bundle into the plugin as
 * `dist/mcp.js`. The name did not match, `main()` never ran, and the process
 * started, did nothing, and exited **0**: no output, no error, no clue. An MCP
 * server that fails to start is invisible by design, and this one had found a
 * way to fail to start silently while looking like a clean exit.
 *
 * Compared by path now, which is what the question actually asks — through
 * `realpath`, which is not a detail. `import.meta.url` is resolved through
 * symlinks by the ESM loader and `process.argv[1]` is not, so on macOS, where
 * `/var` is a symlink to `/private/var`, the same file compares as
 * `/var/folders/…/mcp.js` against `/private/var/folders/…/mcp.js` and the
 * check says no. Every temp directory on that platform is under `/var`, which
 * is to say: every test of a marketplace install, and every plugin installed
 * somewhere a symlink points at.
 *
 * The `bin/` shim `import()`s this module, so `argv[1]` is the shim rather
 * than this file — hence the second arm, matched on the shim's own name and
 * not on this module's.
 */
function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const invokedDirectly =
  entry !== '' &&
  (samePath(entry, fileURLToPath(import.meta.url)) ||
    path.basename(entry) === 'potsherd-mcp.js');

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
