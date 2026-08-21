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
function machine(opts: { withCheckout: boolean }): Machine {
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
      const m = machine({ withCheckout: false });
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

  it('quotes the model download at the size the CLI prints', () => {
    // D13: the hooks said "33 MB" and `potsherd index` said "32.4 MB". One
    // number cannot have two values, and neither copy may drift again.
    const size = format.bytes(embeddings.MODEL_DOWNLOAD_BYTES);
    const script = fs.readFileSync(path.join(pluginDir, 'hooks', 'session-start.sh'), 'utf8');
    expect(script).toContain(`${size}, Xenova/bge-small-en-v1.5`);
    expect(script).not.toMatch(/\b33 MB\b/);
  });
});
