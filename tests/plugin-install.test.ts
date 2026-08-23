// The plugin directory is installed ON ITS OWN. A marketplace install copies
// `plugins/claude-code/` to `~/.claude/plugins/cache/...` and nothing else, so
// the repository's root `package.json` ("type": "module") is not there. Node
// then walks UP to the nearest package.json — and on a real machine that is
// `~/.claude/package.json`, which Claude Code writes as {"type":"commonjs"} —
// so the ESM bundle in `dist/` failed to load and both the binary and the MCP
// server crashed on startup (found by the user on 23 aug 2026, after v1.1.0).
//
// Phase 9's fresh-copy test did not catch it because it copied the plugin to
// /tmp, where no package.json exists above it and Node auto-detects ESM. This
// test copies it under a parent that says "commonjs" on purpose: the one
// environment that reproduces the install, not the one that hides it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const PLUGIN_SRC = join(REPO, 'plugins', 'claude-code');

let root: string;
let plugin: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'potsherd-plugin-install-'));
  // the trap: a parent package.json that forces CommonJS on anything below it
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\n');
  plugin = join(root, 'potsherd');
  cpSync(PLUGIN_SRC, plugin, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the plugin directory, installed on its own under a commonjs parent', () => {
  it('ships its own package.json that marks dist/ as ES modules', () => {
    const p = join(PLUGIN_SRC, 'package.json');
    expect(existsSync(p)).toBe(true);
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(true);
    const manifest = JSON.parse(readFileSync(join(PLUGIN_SRC, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(pkg.version).toBe(manifest.version);
  });

  it('the bundled binary starts and prints its version, with no ESM warning', () => {
    const r = spawnSync('sh', [join(plugin, 'bin', 'potsherd'), '--version'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.stderr).not.toMatch(/Failed to load the ES module|Cannot use import statement/);
  });

  /**
   * `plugins/<harness>/dist` is BUILD OUTPUT, so every assertion here is about
   * whatever was last vendored rather than about the current source. A comment
   * used to say so and nothing enforced it, which makes the test's premise
   * something a person had to remember instead of something the test
   * establishes (`09 §7.2`, the recurring one). If the bundles are stale this
   * fails HERE, naming the command, rather than passing on last release's
   * behaviour under this release's name.
   */
  it('the vendored bundles are not older than the source they claim to be', () => {
    const newest = (dir: string): number => {
      let latest = 0;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'dist' || e.name === 'node_modules') continue;
          latest = Math.max(latest, newest(f));
        } else if (e.name.endsWith('.ts')) {
          latest = Math.max(latest, statSync(f).mtimeMs);
        }
      }
      return latest;
    };
    const srcRoot = join(REPO, 'packages');
    const bundle = join(PLUGIN_SRC, 'dist', 'mcp.js');
    expect(existsSync(bundle), `${bundle} is missing — run: pnpm build && pnpm vendor`).toBe(true);
    expect(
      statSync(bundle).mtimeMs,
      'the vendored plugin bundle is older than packages/**/*.ts — run: pnpm build && pnpm vendor',
    ).toBeGreaterThanOrEqual(newest(srcRoot));
  });

  it('the bundled MCP server answers tools/list with all three tools', () => {
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((f) => JSON.stringify(f)).join('\n') + '\n';
    const r = spawnSync('sh', [join(plugin, 'bin', 'potsherd-mcp')], {
      input: frames,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
      timeout: 30_000,
    });
    expect(r.stderr).not.toMatch(/Failed to load the ES module|Cannot use import statement/);
    const reply = r.stdout
      .split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((d) => d && d.id === 2);
    expect(reply, 'no tools/list reply').toBeTruthy();
    const names = reply.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['potsherd_graft', 'potsherd_read', 'potsherd_recall']);
  });

  it('and the same copy WITHOUT its package.json fails the way the install did', () => {
    rmSync(join(plugin, 'package.json'));
    const r = spawnSync('sh', [join(plugin, 'bin', 'potsherd'), '--version'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Failed to load the ES module|Cannot use import statement/);
    // put it back so the other tests in this file do not depend on order
    cpSync(join(PLUGIN_SRC, 'package.json'), join(plugin, 'package.json'));
  });
});

// ---------------------------------------------------------------------------
// THE CODEX PLUGIN, UNDER ITS OWN TRAP (T10.12)
//
// `plugins/codex/` had never been loaded by a codex, and this file contained
// zero occurrences of the word `codex`. It has now been loaded by a real
// `@openai/codex@0.149.0`, installed through codex's own marketplace, and the
// trap turns out NOT to be the one above. Measured, not assumed:
//
//   1. WHERE IT RUNS. `codex plugin add` copies the plugin alone to
//      `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/` — the
//      same shape as `~/.claude/plugins/cache/`, one level deeper for the
//      version. {@link CODEX_CACHE_DEPTH} reproduces it.
//
//   2. THE COMMONJS TRAP DOES NOT EXIST HERE. Walking up from that installed
//      root on the reference machine finds NO `package.json` at all: codex
//      writes none into `$CODEX_HOME`, unlike Claude Code, which writes
//      `~/.claude/package.json` = {"type":"commonjs"}. And `plugins/codex/`
//      ships no `dist/` to be mis-typed in the first place. So this is not the
//      trap to test, and testing it would be theatre.
//
//   3. THE TRAP CODEX ACTUALLY HAS IS THE MISSING BUNDLE. `plugins/codex/bin/
//      potsherd` resolves through four places, and a marketplace install
//      satisfies NONE of the first three: no `$ROOT/dist/`, no sibling
//      `../claude-code/dist/` (the marketplace copies one directory), no
//      `../../packages/cli/dist/` (there is no checkout above the cache). The
//      only thing that can save it is `potsherd` on PATH — which is exactly
//      what the author's machine has and a user's does not. That is the same
//      class as v1.1.0: the environment that hides the fault is the author's.
//      So the test asserts the honest failure (`exit 127`, all three places
//      named, phase 0's "never silently do nothing") and the working case.
//
//   4. AND THE ESM TRAP IS REAL ONE HOP OVER. Step 1b runs the CLAUDE plugin's
//      bundle from next door. That bundle is ESM and is only ESM because
//      `plugins/claude-code/package.json` says so — so the commonjs parent
//      DOES bite the codex plugin, through its neighbour. Both directions are
//      asserted below.
//
// Verified against the real binary on 2026-08-24 (`T10.12-REPORT.md` §2):
// codex sets **both** `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` for hooks, and
// discovers hooks at `<plugin>/hooks/hooks.json`.
const CODEX_PLUGIN_SRC = join(REPO, 'plugins', 'codex');
/** `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`, measured. */
const CODEX_CACHE_DEPTH = ['plugins', 'cache', 'potsherd-local', 'potsherd', '1.1.0'];

describe('the codex plugin, installed the way codex installs it', () => {
  let codexRoot: string;
  let codexPlugin: string;

  beforeAll(() => {
    codexRoot = mkdtempSync(join(tmpdir(), 'potsherd-codex-install-'));
    // Same commonjs parent as above. It cannot bite `plugins/codex` directly
    // (no dist/), and it is here so that the step-1b assertion below is made
    // in the environment that DID break the real install, not in a clean room.
    writeFileSync(join(codexRoot, 'package.json'), '{"type":"commonjs"}\n');
    codexPlugin = join(codexRoot, '.codex', ...CODEX_CACHE_DEPTH);
    cpSync(CODEX_PLUGIN_SRC, codexPlugin, { recursive: true });
  });

  afterAll(() => {
    rmSync(codexRoot, { recursive: true, force: true });
  });

  it('carries a codex manifest, versioned with the claude plugin', () => {
    const manifest = JSON.parse(
      readFileSync(join(CODEX_PLUGIN_SRC, '.codex-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('potsherd');
    const twin = JSON.parse(readFileSync(join(PLUGIN_SRC, 'package.json'), 'utf8'));
    expect(
      manifest.version,
      'plugins/codex/.codex-plugin/plugin.json and plugins/claude-code/package.json must agree',
    ).toBe(twin.version);
    // codex 0.149.0 clamps a SessionEnd hook to 3s and says so on every run.
    // The declared 10 is not honoured; the file is kept as-is deliberately
    // (T10.12-LABELS.md), and this records that the number is not the one that
    // takes effect, so nobody re-derives it from the file.
    const hooks = JSON.parse(readFileSync(join(CODEX_PLUGIN_SRC, 'hooks', 'hooks.json'), 'utf8'));
    expect(Object.keys(hooks.hooks).sort()).toEqual(['SessionEnd', 'SessionStart']);
  });

  it('ships NO dist/ — so a marketplace install has no bundle of its own', () => {
    expect(
      existsSync(join(CODEX_PLUGIN_SRC, 'dist')),
      'plugins/codex/dist appeared: it must now carry its own package.json ({"type":"module"}) ' +
        'or the commonjs parent above the codex cache will break it exactly as v1.1.0 broke',
    ).toBe(false);
  });

  it('installed alone, with nothing on PATH, it fails LOUDLY and names all three places', () => {
    const r = spawnSync('sh', [join(codexPlugin, 'bin', 'potsherd'), '--version'], {
      encoding: 'utf8',
      // The one thing the author's machine has that a fresh install does not.
      env: { PATH: '/usr/bin:/bin', HOME: codexRoot, NODE_PATH: '' },
    });
    expect(r.status, 'a shim that exits 0 having run nothing is the failure wearing the fix').toBe(
      127,
    );
    expect(r.stderr).toMatch(/vendored in the plugin/);
    expect(r.stderr).toMatch(/the surrounding checkout/);
    expect(r.stderr).toMatch(/potsherd on PATH/);
    expect(r.stdout).toBe('');
  });

  it('with the claude plugin next door it runs — and that bundle is ESM only because of its package.json', () => {
    // Step 1b: `$ROOT/../claude-code/dist/potsherd.js`. Reproduce the layout
    // the resolution expects, INSIDE the commonjs parent.
    const sibling = join(codexPlugin, '..', 'claude-code');
    cpSync(PLUGIN_SRC, sibling, { recursive: true });
    const run = () =>
      spawnSync('sh', [join(codexPlugin, 'bin', 'potsherd'), '--version'], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', HOME: codexRoot, NODE_PATH: '' },
      });

    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ok.stderr).not.toMatch(/Failed to load the ES module|Cannot use import statement/);

    // and the trap, one hop over: take the neighbour's package.json away and
    // the codex plugin inherits {"type":"commonjs"} from the parent.
    rmSync(join(sibling, 'package.json'));
    const broken = run();
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toMatch(/Failed to load the ES module|Cannot use import statement/);

    rmSync(sibling, { recursive: true, force: true });
  });

  it('the MCP shim resolves the same way and answers tools/list when it can', () => {
    const sibling = join(codexPlugin, '..', 'claude-code');
    cpSync(PLUGIN_SRC, sibling, { recursive: true });
    const frames =
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ]
        .map((f) => JSON.stringify(f))
        .join('\n') + '\n';
    const r = spawnSync('sh', [join(codexPlugin, 'bin', 'potsherd-mcp')], {
      input: frames,
      encoding: 'utf8',
      env: { ...process.env, HOME: codexRoot, NODE_PATH: '' },
      timeout: 30_000,
    });
    expect(r.stderr).not.toMatch(/Failed to load the ES module|Cannot use import statement/);
    const reply = r.stdout
      .split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((d) => d && d.id === 2);
    expect(reply, 'no tools/list reply from the codex plugin shim').toBeTruthy();
    const names = reply.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['potsherd_graft', 'potsherd_read', 'potsherd_recall']);
    rmSync(sibling, { recursive: true, force: true });
  });

  it("the .mcp.json codex reads declares the shim by a path relative to the plugin", () => {
    const mcp = JSON.parse(readFileSync(join(CODEX_PLUGIN_SRC, '.mcp.json'), 'utf8'));
    const server = mcp.mcpServers.potsherd;
    expect(server.command).toBe('sh');
    expect(server.args).toEqual(['bin/potsherd-mcp']);
    expect(existsSync(join(codexPlugin, ...server.args))).toBe(true);
  });
});
