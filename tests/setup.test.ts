import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySetupPlan,
  claudeJsonPath,
  clientSpec,
  commandRunnable,
  detectAll,
  detectClient,
  findMcpEntry,
  manualSteps,
  planClient,
  planClients,
  resolveMcpServer,
  setupWritePaths,
  snippetFor,
  tomlHasInlineServers,
  tomlServers,
  tomlTable,
  tomlWithout,
  CLIENTS,
  CLIENT_IDS,
  MCP_BIN,
  SERVER_NAME,
  type ClientId,
  type McpResolution,
} from '../packages/core/src/setup.js';
import { runSetup } from '../packages/cli/src/commands/setup.js';
import { rmrf, readJson, tempDir } from './helpers.js';

/**
 * `setup` is the only verb that writes into another tool's directory, so the
 * tests that matter are the ones about restraint: it merges rather than
 * clobbers, it refuses what it cannot rewrite losslessly, it writes nothing on
 * a dry run, and it never writes without a `y`.
 *
 * Every test runs against a throwaway HOME under the OS temp directory. The
 * real `~/.claude`, `~/.codex`, `~/.cursor` and `~/.pi` are read-only inputs
 * (`00-README.md`) and nothing here goes near them: `home()` resolves through
 * `$HOME`, and each fixture home is removed in `afterEach`.
 */

const created: string[] = [];
let home = '';
const saved: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'POTSHERD_CURSOR_DIR',
  'POTSHERD_PI_DIR',
  'XDG_CONFIG_HOME',
  'PATH',
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = path.join(tempDir('potsherd-setup-'), 'home');
  created.push(path.dirname(home));
  fs.mkdirSync(home, { recursive: true });
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'POTSHERD_CURSOR_DIR', 'POTSHERD_PI_DIR', 'XDG_CONFIG_HOME'] as const) {
    delete process.env[k];
  }
  // Nothing named `potsherd-mcp` may be found by accident: the resolution the
  // tests assert on is the one a fresh machine gets.
  process.env['PATH'] = path.join(home, 'bin');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  while (created.length) rmrf(created.pop()!);
});

/** A resolution that pretends the server is built, for the write tests. */
function built(): McpResolution {
  const file = path.join(home, 'mcp', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// stub\n');
  return { command: process.execPath, args: [file], via: 'local', file, exists: true };
}

function write(p: string, text: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

/** Capture everything a verb prints, the way a terminal would see it. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: chunks.join('') };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

const cursorConfig = () => path.join(home, '.cursor', 'mcp.json');
const codexConfig = () => path.join(home, '.codex', 'config.toml');

/** Three MCP servers that a user already had, and must still have after. */
const THREE_OTHERS = JSON.stringify(
  {
    mcpServers: {
      linear: { command: 'npx', args: ['-y', 'linear-mcp'] },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      sentry: { url: 'https://mcp.sentry.dev/mcp' },
    },
  },
  null,
  2,
) + '\n';

// ---------------------------------------------------------------- resolution

describe('where the MCP server is', () => {
  it('prefers potsherd-mcp on PATH, because that survives an upgrade', () => {
    const bin = path.join(home, 'bin', MCP_BIN);
    write(bin, '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
    const res = resolveMcpServer(undefined, { PATH: path.join(home, 'bin') });
    expect(res).toMatchObject({ command: MCP_BIN, args: [], via: 'path', exists: true });
  });

  it('falls back to an absolute node plus the built entry point', () => {
    const root = path.join(home, 'checkout');
    const entry = write(path.join(root, 'packages', 'mcp', 'dist', 'index.js'), '// stub\n');
    write(path.join(root, 'package.json'), '{}\n');
    const cliBin = write(path.join(root, 'packages', 'cli', 'bin', 'potsherd.js'), '// stub\n');

    const res = resolveMcpServer(cliBin, { PATH: '' });
    expect(res.via).toBe('local');
    expect(res.exists).toBe(true);
    expect(res.args).toEqual([entry]);
    // Not bare `node`: several of these clients are GUI apps with no shell PATH.
    expect(path.isAbsolute(res.command)).toBe(true);
  });

  it('still names the path the server will have when nothing is built yet', () => {
    const root = path.join(home, 'checkout');
    write(path.join(root, 'package.json'), '{}\n');
    const cliBin = write(path.join(root, 'packages', 'cli', 'bin', 'potsherd.js'), '// stub\n');

    const res = resolveMcpServer(cliBin, { PATH: '' });
    expect(res.via).toBe('assumed');
    expect(res.exists).toBe(false);
    expect(res.file).toBe(path.join(root, 'packages', 'mcp', 'dist', 'index.js'));
  });

  /**
   * A git worktree lives inside its own repository, so the walk up from
   * `packages/cli/bin` passes straight through the worktree root and into the
   * parent checkout. Left unbounded it found the *parent's* built server and
   * registered that — a different potsherd than the one being run, and no
   * message anywhere would have said so.
   */
  it('stops at its own checkout, and does not adopt the parent one’s build', () => {
    const outer = path.join(home, 'outer');
    write(path.join(outer, 'package.json'), '{}\n');
    const outerBuild = write(path.join(outer, 'packages', 'mcp', 'dist', 'index.js'), '// stub\n');

    const inner = path.join(outer, '.worktrees', 'wt');
    write(path.join(inner, 'package.json'), '{}\n');
    const cliBin = write(path.join(inner, 'packages', 'cli', 'bin', 'potsherd.js'), '// stub\n');

    const found = findMcpEntry(cliBin);
    expect(found.file).toBe(path.join(inner, 'packages', 'mcp', 'dist', 'index.js'));
    expect(found.file).not.toBe(outerBuild);
    expect(found.exists).toBe(false);
  });

  /**
   * An installed copy with nothing built and no checkout above it has no build
   * directory to name, so it names none: the fallback is the bin the install
   * should have put on PATH, marked as not there.
   */
  it('names no path at all when there is no checkout to build in', () => {
    const bin = write(path.join(home, 'node_modules', 'potsherd', 'bin', 'potsherd.js'), '// stub\n');
    expect(findMcpEntry(bin)).toEqual({ file: null, exists: false });
    const res = resolveMcpServer(bin, { PATH: '' });
    expect(res).toEqual({ command: MCP_BIN, args: [], via: 'assumed', exists: false });
  });

  it('finds a registry install under node_modules/@potsherd/mcp', () => {
    const root = path.join(home, 'lib');
    const entry = write(path.join(root, 'node_modules', '@potsherd', 'mcp', 'dist', 'index.js'), '// stub\n');
    const cliBin = write(path.join(root, 'bin', 'potsherd.js'), '// stub\n');
    expect(findMcpEntry(cliBin)).toEqual({ file: entry, exists: true });
  });

  it('knows whether a command already registered would still run', () => {
    expect(commandRunnable(null)).toBeNull();
    expect(commandRunnable('/does/not/exist/potsherd-mcp')).toBe(false);
    expect(commandRunnable(`${process.execPath} /does/not/exist.js`)).toBe(false);
    const real = write(path.join(home, 'real.js'), '// stub\n');
    expect(commandRunnable(`${process.execPath} ${real}`)).toBe(true);
  });
});

// ----------------------------------------------------------------- detection

describe('detecting a client', () => {
  it('reports a client that is not here without failing', () => {
    const d = detectClient(clientSpec('cursor'));
    expect(d.present).toBe(false);
    expect(d.evidence).toBe('none');
    expect(d.registered).toBe(false);
    expect(d.path).toBe(cursorConfig());
  });

  it('counts a bare directory as evidence, and a config file as better', () => {
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    expect(detectClient(clientSpec('cursor')).evidence).toBe('directory');
    write(cursorConfig(), '{}\n');
    expect(detectClient(clientSpec('cursor')).evidence).toBe('config');
  });

  it('lists the other servers it found, which is what the merge preserves', () => {
    write(cursorConfig(), THREE_OTHERS);
    const d = detectClient(clientSpec('cursor'));
    expect(d.others).toEqual(['linear', 'playwright', 'sentry']);
    expect(d.registered).toBe(false);
  });

  it('covers every client in one sweep', () => {
    const all = detectAll();
    expect(all.map((d) => d.client)).toEqual(CLIENT_IDS);
    expect(CLIENT_IDS).toEqual(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'copilot', 'pi']);
  });

  /**
   * `05`'s honesty contract applies to the tool's own claims about itself.
   * Four of the seven schemas could not be checked against a running tool or a
   * real config file, and the code says which four rather than letting them
   * look as verified as the ones that were.
   */
  it('says, per client, how well its schema was verified', () => {
    const byId = Object.fromEntries(CLIENTS.map((c) => [c.id, c.verified]));
    expect(byId).toEqual({
      claude: 'tool',
      codex: 'config',
      cursor: 'config',
      gemini: 'docs',
      opencode: 'docs',
      copilot: 'docs',
      pi: 'docs',
    });
    for (const c of CLIENTS) expect(c.evidenceNote.length).toBeGreaterThan(20);
  });
});

// --------------------------------------------------------------------- merge

describe('merging, never clobbering', () => {
  it('keeps all three of a user’s existing MCP servers', () => {
    write(cursorConfig(), THREE_OTHERS);
    const plan = planClient(clientSpec('cursor'), { resolution: built() });
    expect(plan.safe).toBe(true);
    expect(plan.keeps).toEqual(['linear', 'playwright', 'sentry']);

    applySetupPlan(plan);
    const after = readJson<{ mcpServers: Record<string, unknown> }>(cursorConfig());
    expect(Object.keys(after.mcpServers).sort()).toEqual(['linear', 'playwright', 'potsherd', 'sentry']);
    // Byte-for-byte, not just key-for-key: the other three entries are untouched.
    const before = JSON.parse(THREE_OTHERS) as { mcpServers: Record<string, unknown> };
    for (const name of ['linear', 'playwright', 'sentry']) {
      expect(after.mcpServers[name]).toEqual(before.mcpServers[name]);
    }
  });

  it('backs the file up before touching it', () => {
    write(cursorConfig(), THREE_OTHERS);
    const plan = planClient(clientSpec('cursor'), { resolution: built() });
    const { written, backup } = applySetupPlan(plan);
    expect(written).toBe(true);
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(backup!, 'utf8')).toBe(THREE_OTHERS);
  });

  it('creates the file, and the directory, when the client has neither', () => {
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const plan = planClient(clientSpec('cursor'), { resolution: built() });
    expect(plan.action).toBe('add');
    const { backup } = applySetupPlan(plan);
    expect(backup).toBeNull();
    expect(readJson<{ mcpServers: Record<string, unknown> }>(cursorConfig()).mcpServers).toHaveProperty(SERVER_NAME);
  });

  it('is a no-op the second time, and re-points a stale command', () => {
    write(cursorConfig(), THREE_OTHERS);
    const res = built();
    applySetupPlan(planClient(clientSpec('cursor'), { resolution: res }));

    const again = planClient(clientSpec('cursor'), { resolution: res });
    expect(again.noop).toBe(true);
    expect(again.diff).toBe('');

    const moved: McpResolution = { ...res, args: [path.join(home, 'elsewhere.js')] };
    const repoint = planClient(clientSpec('cursor'), { resolution: moved });
    expect(repoint.action).toBe('update');
    expect(repoint.keeps).toEqual(['linear', 'playwright', 'sentry']);
  });

  it('removes only its own entry, leaving the others and the key alone', () => {
    write(cursorConfig(), THREE_OTHERS);
    applySetupPlan(planClient(clientSpec('cursor'), { resolution: built() }));
    const plan = planClient(clientSpec('cursor'), { remove: true });
    expect(plan.action).toBe('remove');
    applySetupPlan(plan);
    const after = readJson<{ mcpServers: Record<string, unknown> }>(cursorConfig());
    expect(Object.keys(after.mcpServers).sort()).toEqual(['linear', 'playwright', 'sentry']);
  });

  it('has nothing to remove when it was never there', () => {
    write(cursorConfig(), THREE_OTHERS);
    const plan = planClient(clientSpec('cursor'), { remove: true });
    expect(plan.noop).toBe(true);
    expect(applySetupPlan(plan)).toEqual({ written: false, backup: null });
  });
});

// -------------------------------------------------------------------- refusal

describe('what it refuses to rewrite', () => {
  it('will not drop a user’s comments to add a stanza', () => {
    write(cursorConfig(), '// my servers\n{\n  "mcpServers": {}\n}\n');
    const plan = planClient(clientSpec('cursor'), { resolution: built() });
    expect(plan.safe).toBe(false);
    expect(plan.reason).toContain('comments');
    expect(() => applySetupPlan(plan)).toThrow(/comments/);
    expect(manualSteps(plan).join('\n')).toContain('by hand');
  });

  it('will not guess at a config that is not valid JSON', () => {
    write(cursorConfig(), '{ "mcpServers": ,,, }\n');
    const plan = planClient(clientSpec('cursor'), { resolution: built() });
    expect(plan.safe).toBe(false);
    expect(plan.reason).toContain('not valid JSON');
  });

  it('will not overwrite an mcpServers that is not an object', () => {
    write(cursorConfig(), '{ "mcpServers": [] }\n');
    const plan = planClient(clientSpec('cursor'), { resolution: built() });
    expect(plan.safe).toBe(false);
    expect(plan.reason).toContain('not an object');
  });

  it('leaves the file exactly as it was after every refusal', () => {
    const text = '// mine\n{ "mcpServers": {} }\n';
    write(cursorConfig(), text);
    const plan = planClient(clientSpec('cursor'), { resolution: built() });
    expect(() => applySetupPlan(plan)).toThrow();
    expect(fs.readFileSync(cursorConfig(), 'utf8')).toBe(text);
  });
});

// ----------------------------------------------------------------------- TOML

describe('codex, whose config is TOML', () => {
  const EXISTING = [
    '[features]',
    'js_repl = false',
    '',
    '[mcp_servers.node_repl]',
    'args = []',
    'command = "/somewhere/node_repl"',
    '',
    '[mcp_servers.node_repl.env]',
    'CODEX_HOME = "/somewhere/.codex"',
    '',
    '[mcp_servers.computer-use]',
    'command = "./thing"',
    'enabled = false',
    '',
  ].join('\n');

  it('reads the server names out of the table headers', () => {
    expect(Object.keys(tomlServers(EXISTING)).sort()).toEqual(['computer-use', 'node_repl']);
    expect(Object.keys(tomlServers('[mcp_servers."with.dots"]\n'))).toEqual(['with.dots']);
  });

  it('appends one table and changes not a byte of what was there', () => {
    write(codexConfig(), EXISTING);
    const plan = planClient(clientSpec('codex'), { resolution: built() });
    expect(plan.keeps).toEqual(['computer-use', 'node_repl']);
    applySetupPlan(plan);
    const after = fs.readFileSync(codexConfig(), 'utf8');
    expect(after.startsWith(EXISTING)).toBe(true);
    expect(after).toContain('[mcp_servers.potsherd]');
    expect(Object.keys(tomlServers(after)).sort()).toEqual(['computer-use', 'node_repl', 'potsherd']);
  });

  it('replaces only its own table when re-pointed', () => {
    write(codexConfig(), EXISTING);
    applySetupPlan(planClient(clientSpec('codex'), { resolution: built() }));
    const moved: McpResolution = { command: 'potsherd-mcp', args: [], via: 'path', exists: true };
    applySetupPlan(planClient(clientSpec('codex'), { resolution: moved }));
    const after = fs.readFileSync(codexConfig(), 'utf8');
    expect(after).toContain('command = "potsherd-mcp"');
    expect(after.match(/\[mcp_servers\.potsherd\]/g)).toHaveLength(1);
    expect(after).toContain('[mcp_servers.node_repl.env]');
  });

  it('removes its table without eating the next one', () => {
    const withUs = EXISTING + '[mcp_servers.potsherd]\ncommand = "x"\nargs = []\n\n[desktop]\nk = 1\n';
    expect(tomlWithout(withUs, SERVER_NAME)).toContain('[desktop]');
    expect(tomlWithout(withUs, SERVER_NAME)).not.toContain('potsherd');
    expect(tomlWithout(withUs, SERVER_NAME)).toContain('[mcp_servers.node_repl.env]');
  });

  it('refuses an inline mcp_servers rather than redefine it', () => {
    write(codexConfig(), 'mcp_servers = { a = { command = "x" } }\n');
    expect(tomlHasInlineServers('mcp_servers = { a = 1 }')).toBe(true);
    const plan = planClient(clientSpec('codex'), { resolution: built() });
    expect(plan.safe).toBe(false);
    expect(plan.reason).toContain('inline table');
  });

  it('writes a whole file when codex has none', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    applySetupPlan(planClient(clientSpec('codex'), { resolution: built() }));
    expect(fs.readFileSync(codexConfig(), 'utf8')).toMatch(/^\[mcp_servers\.potsherd\]/);
  });

  it('quotes its scalars', () => {
    expect(tomlTable('x', { command: 'a b', args: ['-y', 'z'], enabled: true })).toBe(
      '[mcp_servers.x]\ncommand = "a b"\nargs = ["-y", "z"]\nenabled = true\n',
    );
  });
});

// ------------------------------------------------------------------- schemas

describe('one snippet per client, in that client’s own schema', () => {
  const res: McpResolution = { command: 'potsherd-mcp', args: [], via: 'path', exists: true };

  it('uses mcpServers for six clients and mcp for opencode', () => {
    for (const id of ['claude', 'cursor', 'gemini', 'copilot', 'pi'] as ClientId[]) {
      const spec = clientSpec(id);
      expect(spec.jsonPath).toEqual(['mcpServers']);
      expect(snippetFor(spec, spec.entry(res))).toContain('"mcpServers"');
    }
    const oc = clientSpec('opencode');
    expect(oc.jsonPath).toEqual(['mcp']);
    expect(JSON.parse(snippetFor(oc, oc.entry(res)))).toEqual({
      mcp: { potsherd: { type: 'local', command: ['potsherd-mcp'], enabled: true } },
    });
  });

  it('gives claude a stdio type, and copilot its tools list', () => {
    expect(clientSpec('claude').entry(res)).toEqual({ type: 'stdio', command: 'potsherd-mcp', args: [] });
    expect(clientSpec('copilot').entry(res)).toEqual({
      type: 'local',
      command: 'potsherd-mcp',
      args: [],
      tools: ['*'],
    });
  });

  it('seeds a new opencode config with its $schema', () => {
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    applySetupPlan(planClient(clientSpec('opencode'), { resolution: built() }));
    const written = readJson<Record<string, unknown>>(path.join(home, '.config', 'opencode', 'opencode.json'));
    expect(written['$schema']).toBe('https://opencode.ai/config.json');
  });

  it('honours XDG_CONFIG_HOME for opencode', () => {
    process.env['XDG_CONFIG_HOME'] = path.join(home, 'xdg');
    expect(detectClient(clientSpec('opencode')).path).toBe(
      path.join(home, 'xdg', 'opencode', 'opencode.json'),
    );
  });

  /**
   * `~/.claude.json` is not inside `~/.claude`, which is the one path in this
   * module that is easy to get wrong and impossible to notice: potsherd would
   * write a file Claude Code never reads.
   */
  it('puts the claude stanza beside ~/.claude, not inside it', () => {
    expect(claudeJsonPath()).toBe(path.join(home, '.claude.json'));
    const relocated = path.join(home, 'elsewhere');
    expect(claudeJsonPath(relocated)).toBe(path.join(relocated, '.claude.json'));
  });
});

// ------------------------------------------------------------------ the verb

describe('the verb', () => {
  const base = { json: false, color: false, quiet: false } as const;

  it('names which agent to configure when told none', async () => {
    await expect(capture(() => runSetup({ ...base }))).rejects.toThrow(/which agent/);
  });

  it('--dry-run prints the diff and writes nothing at all', async () => {
    write(cursorConfig(), THREE_OTHERS);
    const before = fs.readFileSync(cursorConfig(), 'utf8');
    const { code, out } = await capture(() =>
      runSetup({ ...base, clients: ['cursor'], dryRun: true, width: 80 }),
    );
    expect(code).toBe(0);
    expect(out).toContain('~/.cursor/mcp.json');
    expect(out).toContain('+++');
    expect(out).toContain('dry run: nothing was written.');
    expect(out).toContain('3');
    expect(out).toContain('linear');
    expect(fs.readFileSync(cursorConfig(), 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(home, '.cursor'))).toEqual(['mcp.json']);
  });

  /**
   * The whole point of the verb, stated as a test: with no terminal to ask at
   * and no `--yes`, it raises rather than writing. `confirm()` returns its
   * default without asking when stdin is not a TTY, so a verb that leaned on
   * it alone would silently take the default — which for a file potsherd did
   * not create is not good enough.
   */
  it('never writes without an explicit y', async () => {
    const bin = write(path.join(home, 'bin', MCP_BIN), '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
    write(cursorConfig(), THREE_OTHERS);
    const before = fs.readFileSync(cursorConfig(), 'utf8');
    await expect(
      capture(() => runSetup({ ...base, clients: ['cursor'] })),
    ).rejects.toThrow(/terminal to confirm/);
    expect(fs.readFileSync(cursorConfig(), 'utf8')).toBe(before);
  });

  it('reports a client that is not installed, and does not fail', async () => {
    const { code, out } = await capture(() =>
      runSetup({ ...base, clients: ['gemini'], width: 80 }),
    );
    expect(code).toBe(0);
    expect(out).toContain('Gemini CLI is not installed here');
    expect(out).toContain('"mcpServers"');
    expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
  });

  it('exits non-zero, and writes nothing, when it refuses a file', async () => {
    write(cursorConfig(), '// mine\n{}\n');
    const { code, out } = await capture(() =>
      runSetup({ ...base, clients: ['cursor'], yes: true, width: 80 }),
    );
    expect(code).toBe(1);
    expect(out).toContain('comments');
    expect(fs.readFileSync(cursorConfig(), 'utf8')).toBe('// mine\n{}\n');
  });

  /**
   * Phase 0's ruling, carried across: *a hook that looks installed and silently
   * does nothing is worse than no hook*. An MCP stanza pointing at a server
   * that was never built fails the same way, only later and more quietly.
   */
  it('refuses to register a server that is not built', async () => {
    write(cursorConfig(), THREE_OTHERS);
    const before = fs.readFileSync(cursorConfig(), 'utf8');
    // This test must describe a machine where the server is not built, and it
    // used to do that by relying on `packages/mcp` not existing in the tree.
    // T5.1 then built it, and the test started asserting the opposite of what
    // it meant — it was measuring the checkout, not the behaviour. Resolution
    // starts from `process.argv[1]`, so pointing that at a scratch directory
    // with no workspace above it *is* the unbuilt machine, on any checkout.
    // The entry must *exist*: resolution falls back to `process.cwd()` for a
    // path that does not, which would land back in this checkout and resolve
    // the very build we are pretending is absent.
    const elsewhere = path.join(home, 'installed', 'bin');
    fs.mkdirSync(elsewhere, { recursive: true });
    const fakeBin = path.join(elsewhere, 'potsherd.js');
    fs.writeFileSync(fakeBin, '');
    const argv1 = process.argv[1];
    process.argv[1] = fakeBin;
    let code: number;
    let out: string;
    try {
      ({ code, out } = await capture(() =>
        runSetup({ ...base, clients: ['cursor'], yes: true, width: 80 }),
      ));
    } finally {
      process.argv[1] = argv1;
    }
    expect(out).toContain('not built on this machine');
    expect(code).toBe(1);
    expect(fs.readFileSync(cursorConfig(), 'utf8')).toBe(before);
  });

  it('says a schema is unverified on the screen that asks for consent', async () => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    const { out } = await capture(() =>
      runSetup({ ...base, clients: ['gemini'], dryRun: true, width: 80 }),
    );
    expect(out).toContain('unverified');
  });

  it('--all walks every client in one run', async () => {
    const { code, out } = await capture(() =>
      runSetup({ ...base, all: true, dryRun: true, width: 100 }),
    );
    expect(code).toBe(0);
    for (const c of CLIENTS) expect(out).toContain(c.label);
  });

  /**
   * `05`: designed for 80 columns, never wraps a table, long paths elide in the
   * middle. The paths this verb prints are other people's config paths and the
   * backups beside them, which are exactly the long ones.
   */
  it('keeps to 80 columns, whatever the path lengths', async () => {
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    // D11: the `note` line of a docs-only client's consent screen ran to 179
    // characters, unwrapped and unelided, while `runs` on the same screen
    // elided to exactly 80 and `tools` wrapped. The list below did not reach
    // it, because in a throwaway home none of the four docs-only clients has
    // a directory and so none of their plans is ever printed. Making them
    // exist is what makes this test see the screen the user sees.
    for (const dir of [['.gemini'], ['.copilot'], ['.pi', 'agent'], ['.config', 'opencode']]) {
      fs.mkdirSync(path.join(home, ...dir), { recursive: true });
    }
    const runs = [
      () => runSetup({ ...base, all: true, status: true, width: 80 }),
      () => runSetup({ ...base, all: true, dryRun: true, width: 80 }),
      // Each docs-only client on its own, which is the form the verifier ran.
      () => runSetup({ ...base, clients: ['pi'], dryRun: true, width: 80 }),
      () => runSetup({ ...base, clients: ['gemini'], dryRun: true, width: 80 }),
      () => runSetup({ ...base, clients: ['opencode'], dryRun: true, width: 80 }),
      () => runSetup({ ...base, clients: ['copilot'], dryRun: true, width: 80 }),
    ];
    for (const r of runs) {
      const { out } = await capture(r);
      for (const line of out.split('\n')) {
        // A diff body line carries file content verbatim; clipping it would
        // misreport what is about to be written. Everything else is ours.
        if (/^ {2}[-+ ]/.test(line) && !/^ {2}(---|\+\+\+) /.test(line)) continue;
        expect([...line].length, line).toBeLessThanOrEqual(80);
      }
    }
  });

  it('--json carries the same data as the human view', async () => {
    write(cursorConfig(), THREE_OTHERS);
    const { out } = await capture(() =>
      runSetup({ ...base, json: true, clients: ['cursor'], dryRun: true }),
    );
    const parsed = JSON.parse(out) as {
      dryRun: boolean;
      server: { name: string; built: boolean; tools: string[] };
      results: { client: string; keeps: string[]; written: boolean; wouldWrite: boolean; verified: string }[];
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.server.name).toBe(SERVER_NAME);
    expect(parsed.server.tools).toHaveLength(6);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]!.keeps).toEqual(['linear', 'playwright', 'sentry']);
    expect(parsed.results[0]!.written).toBe(false);
    expect(parsed.results[0]!.wouldWrite).toBe(false);
    expect(parsed.results[0]!.verified).toBe('config');
  });

  it('--status says what is registered where, and never writes', async () => {
    write(cursorConfig(), THREE_OTHERS);
    const { out } = await capture(() =>
      runSetup({ ...base, json: true, all: true, status: true }),
    );
    const parsed = JSON.parse(out) as { clients: { client: string; registered: boolean; otherServers: string[] }[] };
    expect(parsed.clients).toHaveLength(CLIENT_IDS.length);
    const cursor = parsed.clients.find((c) => c.client === 'cursor')!;
    expect(cursor.registered).toBe(false);
    expect(cursor.otherServers).toEqual(['linear', 'playwright', 'sentry']);
    expect(fs.readFileSync(cursorConfig(), 'utf8')).toBe(THREE_OTHERS);
  });

  /**
   * D8. The unverified label reached the write path, `--dry-run` and `--json`,
   * and not `--status` — where all seven clients printed `registered`
   * identically. `--status` is the verb somebody runs *later*, to check what is
   * where; a screen that flattens "potsherd has read a real config of this
   * shape" and "potsherd has only read the documentation" into one word is the
   * one screen most likely to be believed.
   */
  it('--status carries the unverified label, and says what it means', async () => {
    const { out } = await capture(() =>
      runSetup({ ...base, all: true, status: true, width: 80 }),
    );
    const lines = out.split('\n');
    for (const spec of CLIENTS) {
      // startsWith, not includes: the label `pi` is a substring of
      // `GitHub Copilot CLI`.
      const i = lines.findIndex((l) => l.trimStart().startsWith(spec.label));
      expect(i, spec.label).toBeGreaterThanOrEqual(0);
      // The label sits on the client's own line, where a reader scanning the
      // column of states cannot miss it.
      expect(/unverified/.test(lines[i]!), `${spec.label} line: ${lines[i]!}`)
        .toBe(spec.verified === 'docs');
      if (spec.verified === 'docs') {
        // …and the reason follows, in the client's own block.
        const block = lines.slice(i, i + 6).join(' ');
        expect(block, spec.label).toContain(spec.evidenceNote.slice(0, 19));
      }
    }
    // One footer sentence explaining the word, only when the word appears.
    expect(out).toMatch(/schema unverified means potsherd has never read a real config/);
  });

  it('--status says nothing about verification when every client is verified', async () => {
    const verified = CLIENTS.filter((c) => c.verified !== 'docs').map((c) => c.id);
    const { out } = await capture(() =>
      runSetup({ ...base, clients: [...verified], status: true, width: 80 }),
    );
    expect(out).not.toMatch(/unverified/);
  });

  it('--status reports a registered stanza that would no longer spawn', async () => {
    write(cursorConfig(), JSON.stringify({
      mcpServers: { potsherd: { command: '/gone/potsherd-mcp', args: [] } },
    }, null, 2) + '\n');
    const { code, out } = await capture(() =>
      runSetup({ ...base, json: true, clients: ['cursor'], status: true }),
    );
    expect(code).toBe(1);
    expect(JSON.parse(out).clients[0].runnable).toBe(false);
  });

  it('writes, backs up and merges once a y is given', async () => {
    // A real `potsherd-mcp` on the fake PATH, so the verb resolves a server
    // that exists and has nothing left to refuse.
    const bin = write(path.join(home, 'bin', MCP_BIN), '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
    write(cursorConfig(), THREE_OTHERS);

    // `--yes` is the explicit y, and the only route to a write without a TTY.
    const { code, out } = await capture(() =>
      runSetup({ ...base, clients: ['cursor'], yes: true, width: 80 }),
    );
    expect(code).toBe(0);
    expect(out).toContain('registered');
    expect(out).toContain('backup:');

    const after = readJson<{ mcpServers: Record<string, { command: string }> }>(cursorConfig());
    expect(Object.keys(after.mcpServers).sort()).toEqual(['linear', 'playwright', 'potsherd', 'sentry']);
    expect(after.mcpServers[SERVER_NAME]!.command).toBe(MCP_BIN);
    // And the backup holds what was there before.
    const backups = fs.readdirSync(path.join(home, '.cursor')).filter((f) => f.includes('potsherd-bak'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, '.cursor', backups[0]!), 'utf8')).toBe(THREE_OTHERS);
  });
});

// ---------------------------------------------------------------------- docs

/**
 * `docs/mcp-clients.md` is deliverable 4 of the phase, and it is a published
 * artefact that can lie about what the product does — the same class of thing
 * as the privacy receipt, which has drifted from the live command twice. So the
 * snippets in it are checked against the ones `setup` actually writes, and the
 * honesty labels are checked against `ClientSpec.verified`.
 */
describe('docs/mcp-clients.md', () => {
  const doc = fs.readFileSync(path.resolve(process.cwd(), 'docs', 'mcp-clients.md'), 'utf8');
  const onPathRes: McpResolution = { command: 'potsherd-mcp', args: [], via: 'path', exists: true };

  const jsonBlocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map(
    (m) => JSON.parse(m[1]!) as Record<string, unknown>,
  );

  it('shows a snippet that matches what setup would write, for every client', () => {
    for (const spec of CLIENTS) {
      const snippet = snippetFor(spec, spec.entry(onPathRes));
      if (spec.format === 'toml') {
        expect(doc).toContain(snippet.trimEnd());
        continue;
      }
      expect(jsonBlocks, `no snippet for ${spec.id}`).toContainEqual(JSON.parse(snippet) as unknown);
    }
  });

  it('names every config path it claims to configure', () => {
    for (const spec of CLIENTS) {
      const shown = detectClient(spec).path.replace(home, '~');
      expect(doc, `${spec.id} path missing`).toContain(shown);
    }
  });

  it('labels every unverified snippet as unverified, and no other', () => {
    // One "> Unverified" callout per docs-only client, and none for the three
    // that were checked.
    const callouts = [...doc.matchAll(/^> Unverified/gim)].length;
    expect(callouts).toBe(CLIENTS.filter((c) => c.verified === 'docs').length);
    for (const spec of CLIENTS.filter((c) => c.verified !== 'docs')) {
      const section = doc.split(`## ${spec.label}`)[1]?.split('\n## ')[0] ?? '';
      expect(section).not.toMatch(/^> Unverified/im);
    }
  });
});

// ------------------------------------------------------------------- privacy

describe('the privacy receipt', () => {
  /**
   * `03` §11: `doctor --privacy` lists every path written, and it has
   * under-reported twice. `setup` adds seven paths in *other tools'*
   * directories, so the list a receipt would print comes from the same array
   * the writer walks and cannot drift from it.
   */
  it('can enumerate every path setup is able to write', () => {
    const written = setupWritePaths();
    expect(written).toHaveLength(CLIENT_IDS.length);
    expect(written).toEqual([
      path.join(home, '.claude.json'),
      path.join(home, '.codex', 'config.toml'),
      path.join(home, '.cursor', 'mcp.json'),
      path.join(home, '.gemini', 'settings.json'),
      path.join(home, '.config', 'opencode', 'opencode.json'),
      path.join(home, '.copilot', 'mcp-config.json'),
      path.join(home, '.pi', 'agent', 'settings.json'),
    ]);
    // Every path setup can plan for is a path the receipt names.
    const planned = planClients([...CLIENT_IDS]).map((p) => p.path);
    expect(planned.sort()).toEqual([...written].sort());
  });

  it('writes nowhere near the real home directory', () => {
    for (const p of setupWritePaths()) {
      expect(p.startsWith(home)).toBe(true);
      expect(p.startsWith(os.homedir())).toBe(true);
    }
  });
});
