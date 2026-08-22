import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { embeddings, format } from '@potsherd/core';

import { copyFixtureClaude, IDS, rmrf, tempDir } from './helpers.js';

/**
 * The plugin hooks, executed.
 *
 * D3 was not a wrong string anywhere — every branch of the old `hooks.json`
 * read correctly. It was that the branches were *ordered* wrong (PATH first,
 * so a stale 0.1.0 answered for a 0.4.0 checkout), that one of them probed a
 * file that has never existed (`bin/potsherd.js`; the file is `bin/potsherd`,
 * no extension), and that the whole thing was a JSON-escaped one-liner nobody
 * could run. Reading the file could not have caught any of that. So this suite
 * extracts the command string out of `hooks.json` exactly as the harness does
 * and *runs* it, against a machine built to look like the reference machine.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = ['claude-code', 'codex'] as const;
const sandboxes: string[] = [];

/** `${PLUGIN_ROOT}` is not interpolated by every host; the hooks read env. */
function hookCommand(plugin: string, event: 'SessionStart' | 'SessionEnd'): string {
  const file = path.join(repo, 'plugins', plugin, 'hooks', 'hooks.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  return json.hooks[event]![0]!.hooks[0]!.command;
}

interface Machine {
  /** Where the hook thinks $HOME is. */
  home: string;
  /** The plugin root to hand the hook. */
  root: (plugin: string) => string;
  potsherdDir: string;
  path: string;
}

/**
 * A machine with a stale potsherd 0.1.0 first on PATH — the phase-0 build,
 * which has no `index` verb — and optionally the current checkout beside the
 * plugin, which is how a developer's machine actually looks.
 */
function machine(opts: { withCheckout: boolean; vendored?: boolean }): Machine {
  const sb = tempDir('potsherd-hook-');
  sandboxes.push(sb);

  fs.mkdirSync(path.join(sb, 'fakebin'), { recursive: true });
  const stale = path.join(sb, 'fakebin', 'potsherd');
  fs.writeFileSync(
    stale,
    '#!/bin/sh\ncase "${1:-}" in\n  --version|-V) echo 0.1.0; exit 0 ;;\n' +
      '  *) echo "error: unknown command \'${1:-}\'" >&2; exit 1 ;;\nesac\n',
  );
  fs.chmodSync(stale, 0o755);

  const tree = path.join(sb, 'tree');
  fs.mkdirSync(path.join(tree, 'plugins'), { recursive: true });
  for (const p of PLUGINS) {
    fs.cpSync(path.join(repo, 'plugins', p), path.join(tree, 'plugins', p), { recursive: true });
    // `plugins/claude-code/dist/` is COMMITTED since phase 7 — that is what
    // makes a marketplace install work at all. Tests about what happens when
    // there is nothing to run therefore have to take it away, or they are
    // asserting against a machine that no longer exists. (`09 §7.2`: a test's
    // premise must be something the test establishes.)
    if (opts.vendored === false) rmrf(path.join(tree, 'plugins', p, 'dist'));
  }
  if (opts.withCheckout) {
    // The bundle is not self-contained: it resolves better-sqlite3 and
    // sqlite-vec through createRequire, so the node_modules must come too.
    fs.mkdirSync(path.join(tree, 'packages', 'cli', 'dist'), { recursive: true });
    fs.symlinkSync(
      path.join(repo, 'packages', 'cli', 'dist', 'potsherd.js'),
      path.join(tree, 'packages', 'cli', 'dist', 'potsherd.js'),
    );
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(tree, 'node_modules'));
    fs.symlinkSync(
      path.join(repo, 'packages', 'cli', 'node_modules'),
      path.join(tree, 'packages', 'cli', 'node_modules'),
    );
  }

  const home = path.join(sb, 'home');
  fs.mkdirSync(home, { recursive: true });
  const nodeDir = path.dirname(process.execPath);
  return {
    home,
    root: (plugin) => path.join(tree, 'plugins', plugin),
    potsherdDir: path.join(home, '.potsherd'),
    path: `${path.join(sb, 'fakebin')}:${nodeDir}:/usr/bin:/bin`,
  };
}

function runHook(
  m: Machine,
  plugin: string,
  event: 'SessionStart' | 'SessionEnd',
  stdin = '',
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('sh', ['-c', hookCommand(plugin, event)], {
    input: stdin,
    encoding: 'utf8',
    env: {
      HOME: m.home,
      PATH: m.path,
      CLAUDE_PLUGIN_ROOT: m.root(plugin),
      PLUGIN_ROOT: m.root(plugin),
      POTSHERD_DIR: m.potsherdDir,
      CLAUDE_CONFIG_DIR: path.join(m.home, '.claude'),
      // The one-off embedding download is not this suite's business, and CI
      // has no network. index degrades to bm25-only and still exits 0.
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The hooks detach their work, so the DB appears a moment after exit. */
function waitFor(file: string, ms = 30_000): boolean {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fs.existsSync(file)) return true;
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']);
  }
  return fs.existsSync(file);
}

beforeAll(() => {
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
});

afterAll(() => {
  while (sandboxes.length) rmrf(sandboxes.pop()!);
});

describe.each(PLUGINS)('%s hooks', (plugin) => {
  const pluginDir = path.join(repo, 'plugins', plugin);

  it('resolves through bin/potsherd and does not re-implement it', () => {
    const shim = path.join(pluginDir, 'bin', 'potsherd');
    expect(fs.existsSync(shim), `${plugin} has no bin/potsherd`).toBe(true);

    for (const event of ['SessionStart', 'SessionEnd'] as const) {
      const cmd = hookCommand(plugin, event);
      // The reversed resolution order, gone: no hook may consult PATH itself.
      expect(cmd, `${plugin} ${event}`).not.toMatch(/command -v potsherd/);
      // The branch that never fired: the file is `bin/potsherd`, no extension.
      expect(cmd, `${plugin} ${event}`).not.toMatch(/bin\/potsherd\.js/);
    }
  });

  it('has no dead bin/potsherd.js probe anywhere in the plugin', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (fs.readFileSync(f, 'utf8').includes('bin/potsherd.js')) hits.push(f);
      }
    };
    walk(pluginDir);
    expect(hits).toEqual([]);
  });

  it(
    'indexes the session when a stale potsherd is first on PATH',
    { timeout: 120_000 },
    () => {
      // D3, exactly: /opt/homebrew/bin/potsherd is 0.1.0 and has no `index`,
      // while the 0.4.0 checkout the plugin was installed from sits beside it.
      const m = machine({ withCheckout: true });
      fs.cpSync(copyFixtureClaude(), path.join(m.home, '.claude'), { recursive: true });

      runHook(m, plugin, 'SessionEnd', JSON.stringify({ session_id: IDS.alive }));

      const db = path.join(m.potsherdDir, 'potsherd.db');
      expect(waitFor(db), 'SessionEnd indexed nothing').toBe(true);
    },
  );

  it(
    'never fails silently when the resolved potsherd is too old for the verb',
    { timeout: 120_000 },
    () => {
      // Same stale 0.1.0, but nothing else on the machine — so the shim's last
      // resort IS the stale build and `index` genuinely cannot run. Phase 0's
      // ruling: a hook that looks installed and does nothing is worse than no
      // hook. It may fail. It may not fail quietly.
      const m = machine({ withCheckout: false, vendored: false });
      fs.cpSync(copyFixtureClaude(), path.join(m.home, '.claude'), { recursive: true });

      runHook(m, plugin, 'SessionEnd', JSON.stringify({ session_id: IDS.alive }));

      const log = path.join(m.potsherdDir, 'hook-failures.log');
      expect(waitFor(log), 'SessionEnd recorded nothing anywhere').toBe(true);
      const recorded = fs.readFileSync(log, 'utf8');
      expect(recorded).toContain(IDS.alive);
      expect(recorded).toMatch(/NOT indexed/);

      // …and the next SessionStart reads it out, because SessionEnd has no
      // channel to the user of its own.
      const start = runHook(m, plugin, 'SessionStart');
      expect(start.status).toBe(0);
      const msg = JSON.parse(start.stdout.trim()) as { systemMessage: string };
      expect(msg.systemMessage).toMatch(/0\.1\.0/);
      expect(msg.systemMessage).toMatch(/no 'index' verb/);
      // Read once, then cleared: the same failure is not reported forever.
      expect(fs.readFileSync(log, 'utf8')).toBe('');
    },
  );

  it('SessionStart emits parseable JSON and always exits 0', { timeout: 60_000 }, () => {
    const m = machine({ withCheckout: true });
    const r = runHook(m, plugin, 'SessionStart');
    expect(r.status).toBe(0);
    if (r.stdout.trim()) expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });

  it('never prints an install command for a package that is not published', () => {
    // D4. `npm i -g potsherd` was the single documented repair, printed in
    // both plugin READMEs, in the shim's exit-127 message and in the
    // SessionStart hook's systemMessage. `npm view potsherd version` is a 404:
    // the package is unpublished. A user following it got nothing and was told
    // nothing. Every remaining mention has to be flagged as a 404, not offered
    // as a fix — so a line that says the words must also say "not published"
    // or "404" within it.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(f);
          continue;
        }
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!/npm i(nstall)? -g potsherd/.test(line)) return;
          if (/404|not published|NOT published|unpublished/.test(line)) return;
          offenders.push(`${path.relative(repo, f)}:${String(i + 1)}`);
        });
      }
    };
    walk(pluginDir);
    expect(offenders).toEqual([]);
  });

  it('ships an MCP launcher that says why there are no tools', () => {
    // D4's other half: `.mcp.json` named packages/mcp/dist/index.js directly,
    // which a marketplace clone does not have, so node died before the server
    // spoke MCP and all six tools were simply absent with no explanation.
    const mcp = JSON.parse(
      fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8'),
    ) as { mcpServers: { potsherd: { args: string[] } } };
    expect(mcp.mcpServers.potsherd.args.join(' ')).toMatch(/bin\/potsherd-mcp/);

    const shim = path.join(pluginDir, 'bin', 'potsherd-mcp');
    expect(fs.existsSync(shim)).toBe(true);

    // With nothing to launch it must exit non-zero and name what is missing.
    // `dist/` has to be taken away for that to be the situation: it is
    // committed since phase 7, which is precisely what stopped this being the
    // situation a real user is in.
    const sb = tempDir('potsherd-mcpshim-');
    sandboxes.push(sb);
    fs.cpSync(pluginDir, path.join(sb, 'plugin'), { recursive: true });
    rmrf(path.join(sb, 'plugin', 'dist'));
    const r = spawnSync('sh', [path.join(sb, 'plugin', 'bin', 'potsherd-mcp')], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/NO potsherd tools/);
    expect(r.stderr).toMatch(/pnpm install && pnpm build/);
    expect(r.stderr).not.toMatch(/npm i -g potsherd\b/);
  });

  /**
   * The marketplace install, which is what open item A was about.
   *
   * A plugin install is a git clone: no `pnpm install`, no build, no
   * `node_modules`. For seven phases that produced a plugin with no CLI and no
   * MCP server — all six tools absent, `session-archaeologist` holding `Read`,
   * and the `bin/potsherd` shim falling through to whatever `potsherd` was on
   * PATH, which on the reference machine was a stale 0.1.0.
   *
   * These two tests are the ones that would have caught it. Both copy the
   * plugin **exactly as a clone gets it** — no checkout beside it, no
   * `node_modules` reachable, and `NODE_PATH` stripped, because vitest sets it
   * to three directories inside this repository's own `node_modules` and a
   * child would resolve `better-sqlite3` through it and prove nothing.
   */
  describe('a plugin installed the way the marketplace installs it', () => {
    /**
     * The plugins as a clone gets them, in a temp dir with nothing reachable
     * from it.
     *
     * Both plugin directories, keeping them siblings, because that is the
     * shape a marketplace source has: it names `./plugins/<name>` inside one
     * repository. Only `claude-code` carries the vendored bundles — 2.4 MB of
     * identical bytes is not worth doubling for a plugin that is inferred from
     * documentation and has never been loaded by codex — so `plugins/codex`'s
     * shims look next door, and this is the test that says next door is a real
     * place.
     */
    const cloned = (): string => {
      const sb = tempDir('potsherd-market-');
      sandboxes.push(sb);
      for (const p of PLUGINS) {
        fs.cpSync(path.join(repo, 'plugins', p), path.join(sb, 'plugins', p), { recursive: true });
      }
      return path.join(sb, 'plugins', plugin);
    };

    const bare = (): NodeJS.ProcessEnv => {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env['NODE_PATH'];
      delete env['POTSHERD_SQLITE'];
      env['PATH'] = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
      return env as NodeJS.ProcessEnv;
    };

    it('carries a CLI it can actually run', () => {
      const dir = cloned();
      const r = spawnSync('sh', [path.join(dir, 'bin', 'potsherd'), '--version'], {
        encoding: 'utf8',
        env: bare(),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);

      // And it does the thing the product is named for, with no database
      // driver installed anywhere on the machine.
      const home = fs.mkdtempSync(path.join(dir, '..', 'home-'));
      const audit = spawnSync(
        'sh',
        [
          path.join(dir, 'bin', 'potsherd'),
          'audit',
          '--json',
          '--claude-dir',
          copyFixtureClaude(),
          '--potsherd-dir',
          path.join(home, '.potsherd'),
        ],
        { encoding: 'utf8', env: bare() },
      );
      expect(audit.status, audit.stderr).toBe(0);
      expect((JSON.parse(audit.stdout) as { deleted: number }).deleted).toBe(3);
    });

    it('carries an MCP server that starts and lists its six tools', () => {
      const dir = cloned();
      // One `tools/list` over stdio. A server that fails to start is invisible
      // by design, so the only honest check is to speak the protocol to it.
      const req = (id: number, method: string, params: unknown): string =>
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      const input =
        req(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'potsherd-test', version: '0' },
        }) +
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' +
        req(2, 'tools/list', {});
      const r = spawnSync('sh', [path.join(dir, 'bin', 'potsherd-mcp')], {
        input,
        encoding: 'utf8',
        timeout: 30_000,
        env: bare(),
      });
      const tools = r.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { id?: number; result?: { tools?: { name: string }[] } })
        .find((m) => m.id === 2)?.result?.tools;
      expect(tools, `no tools/list reply. stderr:\n${r.stderr}`).toBeDefined();
      expect((tools ?? []).map((t) => t.name).sort()).toEqual([
        'potsherd_ask',
        'potsherd_find',
        'potsherd_graft',
        'potsherd_ls',
        'potsherd_read',
        'potsherd_tag',
      ]);
    });
  });

  it('promises no model download, because SessionEnd no longer causes one', () => {
    // This assertion is the exact inverse of the one it replaces, and the
    // inversion is the point.
    //
    // Phase 7 (D13) made the hooks quote the download at the same size the CLI
    // prints, because "33 MB" and "32.4 MB" cannot both be right. Phase 8.6
    // then flipped `index` to text-only, and `session-end.sh` runs
    // `index --session <id> --quiet` with NO `--embed` — so the download the
    // hooks announced stopped happening, while the test kept the sentence
    // alive by pinning it. A test that pins a string can hold a false claim in
    // place after the code beneath it has moved.
    //
    // What is asserted now: SessionStart makes no download promise at all, and
    // SessionEnd really does index without embedding. The second half is what
    // makes the first half true, so it is checked here rather than assumed.
    // Comments may still explain the history; only what the hook SAYS counts.
    const start = path.join(pluginDir, 'hooks', 'session-start.sh');
    const speech = fs
      .readFileSync(start, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(speech, start).not.toMatch(/downloads? one|no embedding model/i);
    expect(speech, start).not.toContain(format.bytes(embeddings.MODEL_DOWNLOAD_BYTES));

    // The half that makes the half above true: SessionEnd indexes without
    // embedding, so there is no download for SessionStart to have promised.
    const endPath = path.join(pluginDir, 'hooks', 'session-end.sh');
    if (fs.existsSync(endPath)) {
      const end = fs.readFileSync(endPath, 'utf8');
      expect(end).toMatch(/index --session .*--quiet/);
      expect(end).not.toContain('--embed');
    }
  });
});
