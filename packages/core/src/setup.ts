import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { backupPath, looksLikeJsonc, stringifySettings, unifiedDiff } from './claude/settings.js';
import { applyProposal, type SettingsProposal } from './consent.js';
import * as paths from './paths.js';
import { onPath } from './resolve-bin.js';

/**
 * `potsherd setup` — the second, and last, place in potsherd that can write
 * outside `~/.potsherd`, and the only one that can write into a *different*
 * tool's directory.
 *
 * `00-README.md`'s ground rule is "never write into another tool's
 * directories". This module is the one deliberate exception, and it bends that
 * rule exactly as narrowly as phase 0 bent it for `~/.claude/settings.json`:
 *
 *   - every function here returns a **proposal**, never a write. Nothing in
 *     this file reads stdin, and nothing lands on disk until
 *     {@link applySetupPlan} is called separately — which the CLI only does
 *     after an explicit `y`. A library user cannot be tricked into a silent
 *     write.
 *   - the existing file is **merged, never replaced**: a user with three other
 *     MCP servers keeps all three, and {@link SetupPlan.keeps} names them so
 *     the prompt can say so out loud before the y.
 *   - a file potsherd cannot rewrite losslessly — JSONC, unparseable, or an
 *     inline `mcp_servers` table — is refused with manual instructions, exactly
 *     as `consent.ts` refuses a commented `settings.json`.
 *   - a backup lands next to the original before every write.
 *
 * The consent *flow* itself — diff, ask, `y`, backup — is `consent.ts`'s and is
 * reused rather than reimplemented: {@link SetupPlan} is a `SettingsProposal`,
 * and every JSON client applies through `consent.applyProposal`. Only the TOML
 * client (codex) needs its own writer, because `applyProposal` re-parses its
 * own `after` as JSON before writing — the check that makes it safe, and also
 * what makes it JSON-only.
 */

// --------------------------------------------------------------- the server

/** The name the stanza is registered under, in every client. */
export const SERVER_NAME = 'potsherd';

/** The bin `@potsherd/mcp` puts on PATH (T5.1). */
export const MCP_BIN = 'potsherd-mcp';

/** The built stdio entry point, relative to a checkout or an install root. */
export const MCP_ENTRY_RELATIVE = path.join('packages', 'mcp', 'dist', 'index.js');

/** The same file, when potsherd was installed from the registry. */
export const MCP_PACKAGE_RELATIVE = path.join('node_modules', '@potsherd', 'mcp', 'dist', 'index.js');

export interface McpResolution {
  /** argv[0] for the client to spawn. */
  command: string;
  /** argv[1..]. */
  args: string[];
  /**
   * `path`    — `potsherd-mcp` was found on PATH; portable, survives upgrades.
   * `local`   — the built server was found in this install; pinned by path.
   * `assumed` — neither exists yet; this is where it *will* be.
   */
  via: 'path' | 'local' | 'assumed';
  /** The file the client would execute, when there is one to name. */
  file?: string;
  /** False when nothing at {@link McpResolution.file} exists yet. */
  exists: boolean;
}

/**
 * Where the MCP server is, or will be.
 *
 * Phase 0's ruling about the guard hook applies here unchanged: *a hook that
 * looks installed and silently does nothing is worse than no hook*. An MCP
 * stanza pointing at a binary that is not there is the same failure with a
 * longer feedback loop — the client starts, the spawn fails, and the model
 * simply never sees the tools. So the resolution reports whether the file it
 * names exists, and the CLI refuses to write when it does not.
 *
 * The absolute `node` is deliberate. `guard` writes a shell string, so a bare
 * `node` there is resolved by the user's shell; an MCP client spawns argv
 * directly, and several of these clients are GUI applications launched from
 * Finder or a desktop entry, which inherit no shell PATH at all. A
 * version-managed `node` would not be found from there.
 */
export function resolveMcpServer(
  entry: string | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
): McpResolution {
  const found = onPath(MCP_BIN, env);
  if (found) return { command: MCP_BIN, args: [], via: 'path', file: found, exists: true };

  const local = findMcpEntry(entry);
  const via = local.exists ? 'local' : 'assumed';
  return { command: process.execPath, args: [local.file], via, file: local.file, exists: local.exists };
}

/**
 * Walk up from the bin script node was handed, looking for the built server.
 *
 * T5.1 owns `packages/mcp` and it does not exist in every checkout yet, so this
 * always returns a path and `exists` is what says whether it is real. The
 * assumed layout is the one `phases/phase-5-surfaces.md` verifies against:
 * `node packages/mcp/dist/index.js`.
 */
export function findMcpEntry(entry: string | undefined): { file: string; exists: boolean } {
  const start = entry && fs.existsSync(entry) ? path.dirname(path.resolve(entry)) : process.cwd();
  let dir = start;
  let root: string | null = null;
  for (let i = 0; i < 8; i++) {
    for (const rel of [MCP_ENTRY_RELATIVE, MCP_PACKAGE_RELATIVE]) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return { file: candidate, exists: true };
    }
    // The fallback root has to be *potsherd's* root, not whatever package the
    // entry happened to be loaded from: under a test runner `argv[1]` sits deep
    // inside `node_modules`, and naming a path in there would be a confident
    // lie about where the server will be.
    if (root === null && !dir.split(path.sep).includes('node_modules') && fs.existsSync(path.join(dir, 'package.json'))) {
      root = dir;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { file: path.join(root ?? start, MCP_ENTRY_RELATIVE), exists: false };
}

// -------------------------------------------------------------- the clients

export type ClientId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'copilot' | 'pi';

/**
 * How much of a client's stanza potsherd has actually checked, in the terms
 * `05`'s honesty contract uses. This travels into `--status`, into `--json` and
 * into `docs/mcp-clients.md`, so a snippet can never quietly present itself as
 * better verified than it is.
 *
 *   `tool`   — exercised against the tool itself, installed on this machine.
 *   `config` — the key and the entry shape were read out of a real config file
 *              that tool had written.
 *   `docs`   — from the client's documentation only. Unverified here.
 */
export type Verification = 'tool' | 'config' | 'docs';

export interface ClientSpec {
  id: ClientId;
  label: string;
  format: 'json' | 'toml';
  /** Executables whose presence proves the client is installed. */
  bins: string[];
  verified: Verification;
  /** One line saying what was checked. Printed by `--status` and the docs. */
  evidenceNote: string;
  /** The config file potsherd would edit. */
  configPath(env?: NodeJS.ProcessEnv): string;
  /** The client's own directory, when it has one; second-best evidence. */
  homeDir(env?: NodeJS.ProcessEnv): string | null;
  /** Where the map of servers lives inside a JSON config. */
  jsonPath?: string[];
  /** The stanza value, in this client's schema. */
  entry(res: McpResolution): Record<string, unknown>;
  /** Extra keys the file needs when potsherd creates it from nothing. */
  seed?: Record<string, unknown>;
  note?: string;
}

function stdio(res: McpResolution): { command: string; args: string[] } {
  return { command: res.command, args: [...res.args] };
}

/** `~/.config/opencode`, honouring XDG_CONFIG_HOME. */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.trim()
    ? path.resolve(paths.expandTilde(xdg.trim()))
    : path.join(paths.home(), '.config');
  return path.join(base, 'opencode');
}

/**
 * `~/.claude.json`, which is *not* inside `~/.claude`.
 *
 * Claude Code keeps user-scope MCP servers in this file, beside the config
 * directory rather than in it. When `CLAUDE_CONFIG_DIR` or `--claude-dir`
 * relocates the directory, the file moves inside it — which is also what makes
 * this verb testable without going near a real one.
 */
export function claudeJsonPath(dir?: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = dir ?? (env['CLAUDE_CONFIG_DIR']?.trim() || undefined);
  if (override) return path.join(paths.claudeDir(override), '.claude.json');
  return path.join(paths.home(), '.claude.json');
}

/**
 * Every client `setup` knows, in the order `--all` walks them.
 *
 * `verified` is the load-bearing field. One of these was exercised against the
 * installed tool, two were read out of real config files on the reference
 * machine, and four come from documentation alone — so they say so, here and
 * everywhere they are printed, rather than looking identical to the ones that
 * were checked.
 */
export const CLIENTS: ClientSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    format: 'json',
    bins: ['claude'],
    verified: 'tool',
    evidenceNote:
      'claude is installed here; `claude mcp add -s user` writes this file, and real entries in it were read for the key and shape',
    configPath: (env) => claudeJsonPath(undefined, env),
    homeDir: () => paths.claudeDir(),
    jsonPath: ['mcpServers'],
    entry: (res) => ({ type: 'stdio', ...stdio(res) }),
    note: 'the Claude Code plugin installs the same server without touching this file; `setup --claude` is for people not using the plugin',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    format: 'toml',
    bins: ['codex'],
    verified: 'config',
    evidenceNote:
      'read from a real ~/.codex/config.toml on this machine, which already carries two [mcp_servers.*] tables',
    configPath: () => path.join(paths.codexDir(), 'config.toml'),
    homeDir: () => paths.codexDir(),
    entry: (res) => stdio(res),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    bins: ['cursor', 'cursor-agent'],
    verified: 'config',
    evidenceNote: 'read from a real ~/.cursor/mcp.json on this machine',
    configPath: () => path.join(paths.cursorDir(), 'mcp.json'),
    homeDir: () => paths.cursorDir(),
    jsonPath: ['mcpServers'],
    entry: (res) => stdio(res),
    note: 'per project instead: the same stanza in ./.cursor/mcp.json',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    format: 'json',
    bins: ['gemini'],
    verified: 'docs',
    evidenceNote: 'documentation only: no gemini on this machine, and no settings.json to read',
    configPath: () => path.join(paths.geminiDir(), 'settings.json'),
    homeDir: () => paths.geminiDir(),
    jsonPath: ['mcpServers'],
    entry: (res) => stdio(res),
  },
  {
    id: 'opencode',
    label: 'opencode',
    format: 'json',
    bins: ['opencode'],
    verified: 'docs',
    evidenceNote: 'documentation only: no opencode on this machine, and no opencode.json to read',
    configPath: (env) => path.join(opencodeConfigDir(env), 'opencode.json'),
    homeDir: (env) => opencodeConfigDir(env),
    jsonPath: ['mcp'],
    // opencode is the one schema here that is not `mcpServers`: the map is
    // `mcp`, and argv is a single array rather than command plus args.
    entry: (res) => ({ type: 'local', command: [res.command, ...res.args], enabled: true }),
    seed: { $schema: 'https://opencode.ai/config.json' },
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    format: 'json',
    bins: ['copilot'],
    verified: 'docs',
    evidenceNote:
      'documentation only: ~/.copilot exists here but holds no mcp-config.json, and copilot is not on PATH',
    configPath: () => path.join(paths.copilotDir(), 'mcp-config.json'),
    homeDir: () => paths.copilotDir(),
    jsonPath: ['mcpServers'],
    entry: (res) => ({ type: 'local', ...stdio(res), tools: ['*'] }),
  },
  {
    id: 'pi',
    label: 'pi',
    format: 'json',
    bins: ['pi'],
    verified: 'docs',
    evidenceNote:
      'documentation only, and the weakest of the seven: no pi on this machine, and the real ~/.pi/agent/settings.json here carries no MCP key to read',
    configPath: () => path.join(paths.piDir(), 'agent', 'settings.json'),
    homeDir: () => paths.piDir(),
    jsonPath: ['mcpServers'],
    entry: (res) => stdio(res),
  },
];

export const CLIENT_IDS: ClientId[] = CLIENTS.map((c) => c.id);

export function clientSpec(id: ClientId): ClientSpec {
  const spec = CLIENTS.find((c) => c.id === id);
  if (!spec) throw new Error(`unknown client: ${id}`);
  return spec;
}

// --------------------------------------------------------------- detection

export interface ClientDetection {
  client: ClientId;
  label: string;
  path: string;
  /** The executable, when the client is on PATH. */
  bin: string | null;
  /** The executables that were looked for, for the "not installed" message. */
  bins: string[];
  configExists: boolean;
  dirExists: boolean;
  /**
   * Any evidence at all that this client is used here. `setup` writes when this
   * is true and prints the snippet to paste when it is false — a client that is
   * not installed is a fact to report, not an error.
   */
  present: boolean;
  evidence: 'binary' | 'config' | 'directory' | 'none';
  /** True when a `potsherd` server is already registered in that file. */
  registered: boolean;
  /** The command currently registered, for `--status`. */
  registeredCommand: string | null;
  /** Every other MCP server in the file. A write preserves all of them. */
  others: string[];
  verified: Verification;
  evidenceNote: string;
}

export function detectClient(
  spec: ClientSpec,
  opts: { claudeDir?: string; env?: NodeJS.ProcessEnv } = {},
): ClientDetection {
  const env = opts.env ?? process.env;
  const p = spec.id === 'claude' ? claudeJsonPath(opts.claudeDir, env) : spec.configPath(env);
  const dir = spec.homeDir(env);
  const bin = spec.bins.map((b) => onPath(b, env)).find((x): x is string => Boolean(x)) ?? null;
  const configExists = fs.existsSync(p);
  const dirExists = Boolean(dir && fs.existsSync(dir));

  const read = readServers(spec, p);
  const registered = Object.prototype.hasOwnProperty.call(read.servers, SERVER_NAME);

  const evidence: ClientDetection['evidence'] = bin
    ? 'binary'
    : configExists
      ? 'config'
      : dirExists
        ? 'directory'
        : 'none';

  return {
    client: spec.id,
    label: spec.label,
    path: p,
    bin,
    bins: [...spec.bins],
    configExists,
    dirExists,
    present: evidence !== 'none',
    evidence,
    registered,
    registeredCommand: registered ? commandOf(read.servers[SERVER_NAME]) : null,
    others: Object.keys(read.servers).filter((k) => k !== SERVER_NAME).sort(),
    verified: spec.verified,
    evidenceNote: spec.evidenceNote,
  };
}

export function detectAll(opts: { claudeDir?: string; env?: NodeJS.ProcessEnv } = {}): ClientDetection[] {
  return CLIENTS.map((spec) => detectClient(spec, opts));
}

/** The argv a registered stanza runs, however that client spells it. */
export function commandOf(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (Array.isArray(e['command'])) return (e['command'] as unknown[]).map(String).join(' ');
  if (typeof e['command'] === 'string') {
    const args = Array.isArray(e['args']) ? (e['args'] as unknown[]).map(String) : [];
    return [e['command'], ...args].join(' ');
  }
  return null;
}

/**
 * Can the command a stanza names actually be run from here?
 *
 * `guard --status` asks the same question of its hook, for the same reason: the
 * failure that matters is a stanza that looks installed and no longer spawns.
 */
export function commandRunnable(command: string | null): boolean | null {
  if (!command) return null;
  const bin = command.trim().split(/\s+/)[0] ?? '';
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\')) {
    if (!fs.existsSync(bin)) return false;
  } else if (onPath(bin) === null) {
    return false;
  }
  // `node /abs/path/index.js` is only runnable if the script is there too.
  const script = command.trim().split(/\s+/).slice(1).find((a) => a.includes(path.sep));
  if (script) return fs.existsSync(script);
  return true;
}

// ----------------------------------------------------------------- reading

interface ServerRead {
  /** The parsed server map; empty when the file is absent or unreadable. */
  servers: Record<string, unknown>;
  text: string | null;
  json?: Record<string, unknown>;
  /** Set when the file exists but potsherd must not rewrite it. */
  blocked?: string;
}

function readServers(spec: ClientSpec, p: string): ServerRead {
  if (!fs.existsSync(p)) return { servers: {}, text: null };
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return { servers: {}, text: null, blocked: `${p} is unreadable (${(err as Error).message})` };
  }
  if (spec.format === 'toml') return { servers: tomlServers(text), text };

  if (looksLikeJsonc(text)) {
    return { servers: {}, text, blocked: `${p} contains comments, so rewriting it as JSON would drop them` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { servers: {}, text, blocked: `${p} is not valid JSON (${(err as Error).message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { servers: {}, text, blocked: `${p} does not hold a JSON object` };
  }
  const json = parsed as Record<string, unknown>;
  const node = getIn(json, spec.jsonPath ?? []);
  if (node !== undefined && (typeof node !== 'object' || node === null || Array.isArray(node))) {
    return {
      servers: {},
      text,
      json,
      blocked: `${p} already has a "${(spec.jsonPath ?? []).join('.')}" that is not an object`,
    };
  }
  return { servers: (node as Record<string, unknown> | undefined) ?? {}, text, json };
}

function getIn(obj: Record<string, unknown>, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function setIn(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (last !== undefined) cur[last] = value;
}

// -------------------------------------------------------------------- TOML

/**
 * Codex's config is TOML, and potsherd will not take a TOML dependency to add
 * one table to it: the root `package.json` is reserved, and a round-tripping
 * TOML writer that preserved a user's comments and ordering would be a far
 * larger thing to get wrong than the edit itself.
 *
 * So the codex edit is textual and strictly additive: append one
 * `[mcp_servers.potsherd]` table at the end of the file, which is valid TOML
 * whatever precedes it and cannot disturb a table already written. Anything
 * that makes that unsafe — an inline `mcp_servers = { … }` that an appended
 * table would redefine — is detected here and refused with manual instructions.
 */
export const TOML_TABLE_RE =
  /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"([^"]+)"|'([^']+)'|([^\]]+?))[ \t]*\][ \t]*$/;
const TOML_INLINE_RE = /^[ \t]*mcp_servers[ \t]*=/;

/**
 * The server a `[mcp_servers.…]` header names, or null for any other line.
 *
 * Sub-tables such as `[mcp_servers.x.env]` carry the same prefix, so an
 * unquoted name is cut at its first dot — but a *quoted* name is one key even
 * when it contains dots, and cutting that one would invent a server nobody
 * declared.
 */
function tomlServerName(line: string): string | null {
  const m = TOML_TABLE_RE.exec(line);
  if (!m) return null;
  const quoted = m[1] ?? m[2];
  if (quoted !== undefined) return quoted;
  const bare = m[3];
  if (bare === undefined) return null;
  return bare.split('.')[0] ?? bare;
}

export function tomlServers(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split('\n')) {
    const name = tomlServerName(line);
    if (name) out[name] = {};
  }
  return out;
}

export function tomlHasInlineServers(text: string): boolean {
  return text.split('\n').some((l) => TOML_INLINE_RE.test(l));
}

/** Enough TOML to emit a string, a boolean, a number or an array of those. */
export function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => tomlValue(v)).join(', ')}]`;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

export function tomlTable(name: string, entry: Record<string, unknown>): string {
  const lines = [`[mcp_servers.${name}]`];
  for (const [k, v] of Object.entries(entry)) lines.push(`${k} = ${tomlValue(v)}`);
  return lines.join('\n') + '\n';
}

/** Drop `[mcp_servers.<name>]` and everything up to the next table header. */
export function tomlWithout(text: string, name: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const found = tomlServerName(line);
    if (found !== null) {
      skipping = found === name;
      if (skipping) continue;
    } else if (skipping && /^[ \t]*\[/.test(line)) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  // Collapse the blank run the removed table leaves behind.
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ------------------------------------------------------------------- plans

export interface SetupPlan extends SettingsProposal {
  client: ClientId;
  label: string;
  format: 'json' | 'toml';
  action: 'add' | 'update' | 'remove' | 'none';
  /** Every other MCP server in that file. The merge keeps all of them. */
  keeps: string[];
  /** The stanza on its own, in that client's syntax. */
  snippet: string;
  detection: ClientDetection;
  resolution: McpResolution;
}

export interface PlanOptions {
  remove?: boolean;
  claudeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Normally `process.argv[1]`; the entry the MCP path is resolved from. */
  entry?: string;
  resolution?: McpResolution;
}

export function planClient(spec: ClientSpec, opts: PlanOptions = {}): SetupPlan {
  const env = opts.env ?? process.env;
  const detection = detectClient(spec, {
    ...(opts.claudeDir ? { claudeDir: opts.claudeDir } : {}),
    env,
  });
  const resolution = opts.resolution ?? resolveMcpServer(opts.entry, env);
  const p = detection.path;
  const read = readServers(spec, p);
  const before = read.text ?? '';
  const entry = spec.entry(resolution);

  const base = {
    path: p,
    before,
    client: spec.id,
    label: spec.label,
    format: spec.format,
    keeps: detection.others,
    snippet: snippetFor(spec, entry),
    detection,
    resolution,
  };

  if (read.blocked) {
    return { ...base, after: before, diff: '', safe: false, reason: read.blocked, noop: false, action: 'none' };
  }
  if (spec.format === 'toml' && read.text && tomlHasInlineServers(read.text)) {
    return {
      ...base,
      after: before,
      diff: '',
      safe: false,
      reason: `${p} declares mcp_servers as an inline table, which potsherd will not extend without a TOML parser`,
      noop: false,
      action: 'none',
    };
  }

  const present = detection.registered;
  if (opts.remove && !present) {
    return { ...base, after: before, diff: '', safe: true, noop: true, action: 'none' };
  }

  const after = opts.remove ? removeStanza(spec, read, before) : addStanza(spec, read, before, entry);
  if (after === before) {
    return { ...base, after, diff: '', safe: true, noop: true, action: 'none' };
  }
  return {
    ...base,
    after,
    diff: unifiedDiff(before, after, paths.tildify(p)),
    safe: true,
    noop: false,
    action: opts.remove ? 'remove' : present ? 'update' : 'add',
  };
}

/** Plan every client named, in `CLIENTS` order. */
export function planClients(ids: ClientId[], opts: PlanOptions = {}): SetupPlan[] {
  const wanted = new Set(ids);
  return CLIENTS.filter((c) => wanted.has(c.id)).map((spec) => planClient(spec, opts));
}

function addStanza(
  spec: ClientSpec,
  read: ServerRead,
  before: string,
  entry: Record<string, unknown>,
): string {
  if (spec.format === 'toml') {
    if (!before.trim()) return tomlTable(SERVER_NAME, entry);
    // Strictly additive. Replacing our own table means removing it first, which
    // only ever touches lines potsherd wrote.
    const body = Object.prototype.hasOwnProperty.call(read.servers, SERVER_NAME)
      ? tomlWithout(before, SERVER_NAME)
      : before;
    const sep = body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    return body + sep + tomlTable(SERVER_NAME, entry);
  }
  const json: Record<string, unknown> = read.json ? structuredClone(read.json) : { ...(spec.seed ?? {}) };
  setIn(json, [...(spec.jsonPath ?? []), SERVER_NAME], entry);
  return stringifySettings(json);
}

function removeStanza(spec: ClientSpec, read: ServerRead, before: string): string {
  if (spec.format === 'toml') return tomlWithout(before, SERVER_NAME);
  if (!read.json) return before;
  const json = structuredClone(read.json);
  const holder = getIn(json, spec.jsonPath ?? []);
  if (holder && typeof holder === 'object') {
    delete (holder as Record<string, unknown>)[SERVER_NAME];
    // An empty map is left behind rather than deleted: the client wrote that
    // key, and removing our own server is not a licence to tidy their file.
  }
  return stringifySettings(json);
}

/** The stanza on its own, in that client's syntax — what the docs show. */
export function snippetFor(spec: ClientSpec, entry: Record<string, unknown>): string {
  if (spec.format === 'toml') return tomlTable(SERVER_NAME, entry);
  const doc: Record<string, unknown> = {};
  setIn(doc, [...(spec.jsonPath ?? []), SERVER_NAME], entry);
  return JSON.stringify(doc, null, 2) + '\n';
}

// ------------------------------------------------------------------- write

/**
 * The write, and the only one in this module.
 *
 * JSON goes through `consent.applyProposal` unchanged, so both places potsherd
 * can write outside `~/.potsherd` share one implementation of "validate, back
 * up, then write". TOML cannot use it — see the module comment — but it uses
 * the same `backupPath`, so the two receipts read identically.
 */
export function applySetupPlan(
  plan: SetupPlan,
  now = new Date(),
): { written: boolean; backup: string | null } {
  if (!plan.safe) throw new Error(plan.reason ?? 'refusing to write this config');
  if (plan.noop) return { written: false, backup: null };

  if (plan.format === 'json') return applyProposal(plan, now);

  let backup: string | null = null;
  if (fs.existsSync(plan.path)) {
    backup = backupPath(plan.path, now);
    fs.copyFileSync(plan.path, backup);
  } else {
    fs.mkdirSync(path.dirname(plan.path), { recursive: true });
  }
  fs.writeFileSync(plan.path, plan.after, { mode: 0o600 });
  return { written: true, backup };
}

/** Printed whenever potsherd refuses to edit a file, or cannot find the client. */
export function manualSteps(plan: SetupPlan): string[] {
  const lines: string[] = [];
  if (plan.reason) lines.push(`potsherd did not edit ${paths.tildify(plan.path)}: ${plan.reason}`, '');
  lines.push(`add this to ${paths.tildify(plan.path)} by hand:`, '');
  for (const l of plan.snippet.trimEnd().split('\n')) lines.push('  ' + l);
  return lines;
}

/**
 * Every path `setup` can write.
 *
 * `03` §11 says `doctor --privacy` lists every path written, and the receipt
 * has under-reported twice already. `setup` adds seven paths in *other tools'*
 * directories — the largest privacy-relevant change since `graft` — so they are
 * enumerated from the same list the writer walks and cannot drift from it.
 */
export function setupWritePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return CLIENTS.map((spec) => (spec.id === 'claude' ? claudeJsonPath(undefined, env) : spec.configPath(env)));
}
