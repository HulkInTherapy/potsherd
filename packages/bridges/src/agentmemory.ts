/**
 * The agentmemory bridge — its MCP server as a client, one tool, warm.
 *
 * ## the anti-pattern this file is careful not to import
 *
 * agentmemory ships **54 MCP tools** (its registry defines roughly sixty
 * `memory_*` entries). `03` §9 names that number explicitly as the thing
 * potsherd's six verbs exist against: a tool surface that large is a surface
 * the model has to *choose* within, and every extra choice is a chance to pick
 * wrong. So this bridge calls exactly one tool, `memory_smart_search`, and
 * exposes none of theirs. Federating a search is not adopting a surface.
 *
 * ## no MCP dependency, and why that is the right call here
 *
 * `@modelcontextprotocol/sdk` is already a dependency of `@potsherd/mcp`,
 * where potsherd is the *server*. Being a client is a different job and a much
 * smaller one: MCP's stdio transport is newline-delimited JSON-RPC 2.0, and
 * the whole conversation this bridge needs is four messages — `initialize`,
 * the `initialized` notification, `tools/list`, `tools/call`. Writing those
 * four costs less than the risk of a version skew between two SDK copies in
 * one process, and it keeps `packages/bridges` at zero runtime dependencies.
 *
 * ## warm per process, 5 s, skip on failure
 *
 * The phase file's risk note is that agentmemory's server is slow to spawn.
 * So the client is cached per process and per launch command
 * ({@link warmClient}), the handshake and every call are under a hard 5 s
 * ceiling, and *any* failure — spawn, timeout, protocol, a tool that is not
 * there — is a `BridgeList` with a sentence in it rather than an exception.
 * A federated `find` must never be slower or less reliable than a plain one.
 *
 * ## the launch command is discovered, never downloaded
 *
 * agentmemory's own `plugin/.mcp.json` launches the server as
 * `npx -y @agentmemory/mcp`. This bridge will **not** run that: `-y` fetches
 * from the registry, and potsherd's constraint is no network except localhost
 * detection and model calls the user initiated. Spawning a package manager
 * that downloads and executes code, inside a search verb, is not something a
 * user asked for by typing `find`.
 *
 * So the command is discovered, in this order, and if none of them is present
 * the bridge reports `launch command not discoverable` and returns nothing:
 *
 *   1. `POTSHERD_AGENTMEMORY_COMMAND` — an explicit escape hatch.
 *   2. an `agentmemory` server entry in `<store>/.mcp.json` or `mcp.json`,
 *      minus any `npx -y` form, for the same reason.
 *   3. `agentmemory-mcp` on `PATH` — the bin name `@agentmemory/mcp` installs.
 *   4. a local install under `<store>/node_modules/.bin/`.
 *
 * ## what was and was not verified
 *
 * Verified live on 2026-08-22 from agentmemory's own source: the package is
 * `@agentmemory/mcp` with bin `agentmemory-mcp`, licence Apache-2.0, and
 * `src/mcp/tools-registry.ts` defines `memory_smart_search` with
 * `{ query: string (required), expandIds?: string, limit?: number }`.
 *
 * **Not verified, because agentmemory is not installed on this machine:** the
 * shape of the tool's *result*. It is therefore parsed structurally rather
 * than by a schema, and the argument names are still re-read from the server's
 * own `tools/list` at runtime instead of being trusted from the source above —
 * the same discipline `claude-mem.ts` applies to `pragma table_info`, for the
 * same reason. A store this bridge has never seen is a store whose schema it
 * must ask about.
 *
 * One more thing worth knowing before trusting a result: `@agentmemory/mcp`
 * describes itself as a thin shim over an HTTP backend at
 * `AGENTMEMORY_URL` (default `http://localhost:3111`). A running MCP server
 * with a stopped backend is a real state, and it surfaces here as a tool call
 * that errors — reported, not swallowed.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  absentStatus,
  emptyStatus,
  firstLine,
  unavailableList,
  unrecognisedStatus,
  type BridgeHit,
  type BridgeList,
  type BridgeQueryOptions,
  type BridgeStatus,
} from './types.js';

/** The phase file's ceiling: 5 s, then skip. */
export const AGENTMEMORY_TIMEOUT_MS = 5000;

/** The one tool this bridge calls. Not the other fifty-three. */
export const SEARCH_TOOL = 'memory_smart_search';

export interface AgentMemoryOptions extends BridgeQueryOptions {
  env?: NodeJS.ProcessEnv;
  /** Skip the cache and spawn fresh. Tests use it; nothing else should. */
  noCache?: boolean;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  /** Which of the four discovery routes found it, for the receipt. */
  via: 'env' | 'mcp.json' | 'PATH' | 'node_modules';
}

/**
 * Every directory agentmemory might keep its state in, best first.
 *
 * **The brief and `03` §10 both said `~/.agentmemory`, and both are wrong.**
 * agentmemory's README puts its state in the platform's application-data
 * directory — `~/Library/Application Support/agentmemory` on macOS, the XDG
 * data directory on Linux, `%APPDATA%` on Windows. This is the fourth thing in
 * two phases that the plan asserted about another tool and that turned out not
 * to exist (`rescue --background`, `index --card` and
 * `codex features enable plugin_hooks` were the others), which is the reason
 * every path in this package is probed rather than assumed.
 *
 * The dotdir is still checked, last: it costs one `existsSync`, and if any
 * version or fork ever used it, a user with real memories there gets them
 * federated instead of being told they have no agentmemory. What is *reported*
 * when nothing is found is the documented location, because that is where the
 * answer to "why does potsherd not see it" lives.
 */
export function agentMemoryDirs(
  opts: AgentMemoryOptions = {},
): { path: string; kind: 'app-data' | 'dotdir' }[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const out: { path: string; kind: 'app-data' | 'dotdir' }[] = [];
  const push = (p: string, kind: 'app-data' | 'dotdir'): void => {
    if (p && !out.some((e) => e.path === p)) out.push({ path: p, kind });
  };

  if (process.platform === 'darwin') {
    push(path.join(home, 'Library', 'Application Support', 'agentmemory'), 'app-data');
  } else if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData) push(path.join(appData, 'agentmemory'), 'app-data');
  }

  // XDG, which Linux uses and which some tools honour on macOS too.
  const xdgData = env['XDG_DATA_HOME'];
  push(path.join(xdgData || path.join(home, '.local', 'share'), 'agentmemory'), 'app-data');
  const xdgConfig = env['XDG_CONFIG_HOME'];
  push(path.join(xdgConfig || path.join(home, '.config'), 'agentmemory'), 'app-data');

  push(path.join(home, '.agentmemory'), 'dotdir');
  return out;
}

/**
 * The directory to use: the first that exists, or the documented one.
 *
 * "Or the documented one" matters for the receipt. A `doctor` line that names
 * `~/.agentmemory` when nothing is installed sends the reader to check a path
 * agentmemory would never have written, and they conclude potsherd is broken
 * rather than that the tool is absent.
 */
export function agentMemoryDir(opts: AgentMemoryOptions = {}): string {
  const candidates = agentMemoryDirs(opts);
  for (const c of candidates) {
    if (fs.existsSync(c.path)) return c.path;
  }
  return candidates[0]?.path ?? path.join(opts.home ?? os.homedir(), '.agentmemory');
}

// ---------------------------------------------------------------- discovery

/**
 * Find a way to start their server without downloading one.
 *
 * Returns null rather than falling back to `npx -y`, which would turn a search
 * into a package install. The caller reports that as `unrecognised`, because
 * "installed, and we cannot start it" is a fact about potsherd, not about the
 * user's data.
 */
export function discoverLaunch(opts: AgentMemoryOptions = {}): LaunchCommand | null {
  const env = opts.env ?? process.env;
  const dir = agentMemoryDir(opts);

  const override = env['POTSHERD_AGENTMEMORY_COMMAND'];
  if (override && override.trim()) {
    const parts = override.trim().split(/\s+/);
    const command = parts[0];
    if (command) return { command, args: parts.slice(1), via: 'env' };
  }

  for (const name of ['.mcp.json', 'mcp.json']) {
    const found = fromMcpJson(path.join(dir, name));
    if (found) return found;
  }

  const onPath = which('agentmemory-mcp', env);
  if (onPath) return { command: onPath, args: [], via: 'PATH' };

  const local = path.join(dir, 'node_modules', '.bin', 'agentmemory-mcp');
  if (isExecutable(local)) return { command: local, args: [], via: 'node_modules' };

  return null;
}

/**
 * Read a launch command out of an MCP config the user already has.
 *
 * The `npx -y` form is rejected here rather than at the call site so that
 * there is exactly one place in this file that can decide to run a downloader,
 * and it decides not to.
 */
function fromMcpJson(file: string): LaunchCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  const servers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  for (const [name, raw] of Object.entries(servers)) {
    if (!name.toLowerCase().includes('agentmemory')) continue;
    const entry = raw as { command?: unknown; args?: unknown };
    const command = typeof entry.command === 'string' ? entry.command : '';
    if (!command) continue;
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    if (/^(npx|pnpx|bunx|yarn|npm)$/.test(path.basename(command))) continue;
    return { command, args, via: 'mcp.json' };
  }
  return null;
}

function which(binary: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ detect

/**
 * Is agentmemory here?
 *
 * The four-way presence again, and the fourth value earns its keep on this
 * bridge more than on any other: `~/.agentmemory` present with no startable
 * server is `unrecognised`, and telling that user "not installed" would send
 * them to reinstall something they already have.
 */
export function detectAgentMemory(opts: AgentMemoryOptions = {}): BridgeStatus {
  const dir = agentMemoryDir(opts);
  if (!fs.existsSync(dir)) {
    // Every probed path, not just the one reported. "not installed (no ~/.x)"
    // invites the reply "but it is installed, look in ~/.y"; naming all of
    // them closes that off.
    const probed = agentMemoryDirs(opts).map((c) => tilde(c.path));
    return absentStatus('agentmemory', dir, `none of ${probed.join(', ')}`);
  }
  const launch = discoverLaunch(opts);
  if (!launch) {
    return unrecognisedStatus(
      'agentmemory',
      dir,
      'launch command not discoverable; set POTSHERD_AGENTMEMORY_COMMAND',
      null,
      'bridge unavailable',
    );
  }
  if (isEmptyDir(dir)) {
    return emptyStatus('agentmemory', dir, `${tilde(dir)} exists and is empty`);
  }
  return {
    bridge: 'agentmemory',
    presence: 'store',
    path: dir,
    available: true,
    detail: `mcp server via ${launch.via} (${path.basename(launch.command)}), one tool: ${SEARCH_TOOL}`,
    schema: null,
    rows: null,
    worker: null,
  };
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

// ------------------------------------------------------------- the client

/**
 * A minimal MCP stdio client: newline-delimited JSON-RPC 2.0, four messages.
 *
 * Not a general MCP implementation and not trying to be. It handles exactly
 * what one search needs, and every method resolves rather than rejects on
 * failure so that no caller has to wrap it.
 */
class StdioClient {
  // stdio is ['pipe','pipe','ignore'], so stderr is typed `null` — the exact
  // shape is spelled out rather than widened, because the narrowing below
  // (`this.child.stdout`) depends on it.
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (value: RpcResponse) => void>();
  private failed: string | null = null;

  constructor(private readonly launch: LaunchCommand) {}

  get error(): string | null {
    return this.failed;
  }

  /** True once the handshake has completed. Idempotent. */
  async start(timeoutMs: number, env: NodeJS.ProcessEnv): Promise<boolean> {
    if (this.failed) return false;
    if (this.child) return true;
    try {
      this.child = spawn(this.launch.command, this.launch.args, {
        // stderr is ignored on purpose: a 54-tool server is chatty at startup
        // and none of it belongs in a `find` result. Its *exit* is what we
        // notice, and that arrives on 'close'.
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...env },
      });
    } catch (err) {
      this.failed = `could not start ${path.basename(this.launch.command)}: ${firstLine(err)}`;
      return false;
    }

    // Held locally: `die()` sets `this.child` back to null, and every one of
    // these handlers can run after that.
    const child = this.child;
    child.on('error', (err) => this.die(firstLine(err)));
    child.on('close', (code) => this.die(`server exited (${code ?? 'signal'})`));
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.onData(String(chunk)));

    const init = await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'potsherd', version: '0.4.0' },
      },
      timeoutMs,
    );
    if (!init || init.error) {
      this.die(init?.error ? rpcError(init) : 'no answer to initialize');
      return false;
    }
    this.notify('notifications/initialized');
    return true;
  }

  /**
   * The server's own description of a tool, or null.
   *
   * Read at runtime rather than assumed from their source, so that a renamed
   * argument degrades to "schema not recognised" instead of silently sending
   * `{query: …}` to a tool that now wants `{q: …}` and getting an empty result
   * that looks like "you have no memories about this".
   */
  async tool(name: string, timeoutMs: number): Promise<{ properties: string[] } | null> {
    const res = await this.request('tools/list', {}, timeoutMs);
    if (!res || res.error) return null;
    const tools = (res.result as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) return null;
    for (const raw of tools) {
      const t = raw as { name?: unknown; inputSchema?: { properties?: Record<string, unknown> } };
      if (t?.name !== name) continue;
      const properties = Object.keys(t.inputSchema?.properties ?? {});
      return { properties };
    }
    return null;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ text: string; error: string | null }> {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (!res) return { text: '', error: `${name} timed out after ${timeoutMs} ms` };
    if (res.error) return { text: '', error: rpcError(res) };
    const result = res.result as { content?: unknown; isError?: unknown };
    if (result?.isError === true) return { text: '', error: `${name} reported an error` };
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((part) => {
        const p = part as { type?: unknown; text?: unknown };
        return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
      })
      .filter(Boolean)
      .join('\n');
    return { text, error: null };
  }

  close(): void {
    try {
      this.child?.stdin.end();
      this.child?.kill();
    } catch {
      /* it is already gone */
    }
    this.child = null;
  }

  private die(reason: string): void {
    if (!this.failed) this.failed = reason;
    for (const [, resolve] of this.pending) resolve({ id: -1, error: { message: reason } });
    this.pending.clear();
    this.child = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // MCP's stdio transport is newline-delimited JSON, one message per line.
    // A partial line stays in the buffer; a line that is not JSON — a stray
    // log from a server that writes to stdout — is skipped rather than fatal.
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as RpcResponse;
          const resolve = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
          if (resolve) {
            this.pending.delete(message.id as number);
            resolve(message);
          }
        } catch {
          /* not a JSON-RPC line */
        }
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private notify(method: string): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    } catch {
      /* the die() handler has it */
    }
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<RpcResponse | null> {
    const child = this.child;
    if (!child) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<RpcResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.die(firstLine(err));
        resolve(null);
      }
    });
  }
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
}

function rpcError(res: RpcResponse): string {
  const message = res.error?.message;
  return typeof message === 'string' && message ? message : 'the server returned an error';
}

/**
 * One live client per launch command per process.
 *
 * The cache is the phase file's mitigation for a slow server, and it is keyed
 * by the command so a test that points at a stub does not inherit a real
 * server's handle. A client that has failed stays in the map with its failure
 * recorded: retrying a spawn that did not work, once per keystroke, is how a
 * search verb becomes slower than the thing it federates.
 */
const clients = new Map<string, StdioClient>();

export function warmClient(launch: LaunchCommand): StdioClient {
  const key = [launch.command, ...launch.args].join(' ');
  const existing = clients.get(key);
  if (existing) return existing;
  const client = new StdioClient(launch);
  clients.set(key, client);
  return client;
}

/** Shut every cached server down. For process exit and for tests. */
export function closeAgentMemoryClients(): void {
  for (const [, client] of clients) client.close();
  clients.clear();
}

// ------------------------------------------------------------------- query

/**
 * `find --with agentmemory` — one tool call, 5 s, skip on failure.
 *
 * Never throws, never leaves a child process behind on the failure paths that
 * can leave one, and never blocks a `find` for longer than the ceiling.
 */
export async function queryAgentMemory(
  query: string,
  opts: AgentMemoryOptions = {},
): Promise<BridgeList> {
  const started = Date.now();
  const status = detectAgentMemory(opts);
  if (!status.available) return unavailableList(status, Date.now() - started);

  const launch = discoverLaunch(opts);
  if (!launch) {
    return unavailableList(
      unrecognisedStatus(
        'agentmemory',
        status.path,
        'launch command not discoverable',
        null,
        'bridge unavailable',
      ),
      Date.now() - started,
    );
  }

  const timeout = opts.timeoutMs ?? AGENTMEMORY_TIMEOUT_MS;
  const limit = Math.max(1, opts.limit ?? 20);
  const client = opts.noCache ? new StdioClient(launch) : warmClient(launch);

  try {
    const ok = await client.start(timeout, opts.env ?? process.env);
    if (!ok) {
      return unavailableList(
        { ...status, presence: 'unrecognised', available: false, detail: skipped(client.error) },
        Date.now() - started,
      );
    }

    // Their schema, from them, at runtime. `query` is the required argument in
    // the source read on 2026-08-22; if a future server calls it something
    // else this finds out here rather than returning a confident empty list.
    const tool = await client.tool(SEARCH_TOOL, timeout);
    if (!tool) {
      return unavailableList(
        unrecognisedStatus(
        'agentmemory',
        status.path,
        `no ${SEARCH_TOOL} in tools/list`,
        null,
        'bridge unavailable',
      ),
        Date.now() - started,
      );
    }
    const queryArg = tool.properties.find((p) => /^(query|q|text|search)$/i.test(p)) ?? 'query';
    const limitArg = tool.properties.find((p) => /^(limit|k|top_?k|max)$/i.test(p));

    const args: Record<string, unknown> = { [queryArg]: query };
    if (limitArg) args[limitArg] = limit;

    const { text, error } = await client.call(SEARCH_TOOL, args, timeout);
    if (error) {
      return unavailableList(
        { ...status, presence: 'unrecognised', available: false, detail: skipped(error) },
        Date.now() - started,
      );
    }

    return {
      list: 'agentmemory',
      status,
      hits: parseHits(text, limit, status.path),
      ms: Date.now() - started,
      unavailable: null,
      strategy: 'mcp',
      // Their search decides its own recall; we did not relax anything.
      relaxed: false,
    };
  } catch (err) {
    return unavailableList(
      { ...status, presence: 'unrecognised', available: false, detail: skipped(firstLine(err)) },
      Date.now() - started,
    );
  } finally {
    if (opts.noCache) client.close();
  }
}

function skipped(reason: string | null): string {
  return `skipped: ${reason ?? 'the mcp server did not answer'}`;
}

/**
 * Turn a tool result into hits, without a schema for it.
 *
 * The result shape was **not** verified — agentmemory is not installed here —
 * so this reads structurally and gives up gracefully:
 *
 *   - JSON array, or the first array-valued property of a JSON object → one
 *     hit per element, fields picked by the usual names.
 *   - JSON object that is not that → one hit, the whole thing.
 *   - not JSON → split on blank lines, one hit per paragraph.
 *
 * The last case is the important one. A tool that answers in prose still
 * produces usable hits, and a bridge that returned nothing because the reply
 * was not JSON would be reporting a parser's opinion as the user's memory.
 */
export function parseHits(text: string, limit: number, source: string): BridgeHit[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  let rows: unknown[] | null = null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === 'object') {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          rows = value;
          break;
        }
      }
      if (!rows) rows = [parsed];
    }
  } catch {
    rows = null;
  }

  if (!rows) {
    return trimmed
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, limit)
      .map((paragraph, i) => hit(String(i + 1), '', paragraph, null, i + 1, source));
  }

  return rows
    .slice(0, limit)
    .map((raw, i) => {
      if (typeof raw === 'string') return hit(String(i + 1), '', raw, null, i + 1, source);
      const row = (raw ?? {}) as Record<string, unknown>;
      const body = pick(row, ['text', 'content', 'body', 'observation', 'memory', 'summary']);
      const title = pick(row, ['title', 'summary', 'name', 'subject']);
      const id = pick(row, ['id', 'uuid', 'memoryId', 'observationId']) || String(i + 1);
      const ts = pick(row, ['created_at', 'createdAt', 'timestamp', 'ts', 'date']) || null;
      return hit(id, title, body || JSON.stringify(row).slice(0, 400), ts, i + 1, source);
    })
    .filter((h) => h.text.length > 0);
}

function hit(
  id: string,
  title: string,
  text: string,
  ts: string | null,
  rank: number,
  source: string,
): BridgeHit {
  return {
    bridge: 'agentmemory',
    id,
    title: (title || text).replace(/\s+/g, ' ').trim().slice(0, 160),
    text: text.trim(),
    ts,
    source,
    rank,
    // Their tool returns no comparable score, and inventing one would corrupt
    // `--explain`. Rank is what RRF reads anyway.
    raw: 0,
  };
}

function pick(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
