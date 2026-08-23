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
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

  it('the bundled MCP server answers tools/list with all six tools', () => {
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
    expect(names).toEqual(['potsherd_ask', 'potsherd_find', 'potsherd_graft', 'potsherd_ls', 'potsherd_read', 'potsherd_tag']);
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
