import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { copyFixtureClaude, FIXTURE_CLAUDE, rmrf, tempDir } from './helpers.js';

/**
 * Exercises the shipped binary rather than the library: these are the exact
 * argument strings the readme, the hooks and the plugin use, so a change that
 * only breaks the CLI wiring must fail here.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');
const created: string[] = [];

beforeAll(() => {
  // The bundle is what `npx potsherd` runs; build it if it is stale or missing.
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
});

afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

afterAll(() => {
  while (created.length) rmrf(created.pop()!);
});

interface RunResult { code: number; stdout: string; stderr: string }

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync('node', [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function scratchRoot(): string {
  const root = tempDir('potsherd-cli-');
  created.push(root);
  return root;
}

describe('potsherd cli', () => {
  it('with no arguments prints a tour that names the first verb', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('potsherd audit');
    expect(r.stdout).toContain('start here');
  });

  it('audit works read-only against a fixture directory', () => {
    const r = run(['audit', '--claude-dir', FIXTURE_CLAUDE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sessions ever started');
    expect(r.stdout).toContain('potsherd rescue');
  });

  it('accepts --json after the verb, which is what people type', () => {
    const r = run(['audit', '--json', '--claude-dir', FIXTURE_CLAUDE]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as Record<string, number>;
    expect(j['deleted']).toBe(3);
    expect(j['promptsLost']).toBe(6);
  });

  it('accepts --json before the verb too', () => {
    const r = run(['--json', 'audit', '--claude-dir', FIXTURE_CLAUDE]);
    expect(JSON.parse(r.stdout)['deleted']).toBe(3);
  });

  it('audit never creates the potsherd directory', () => {
    const root = path.join(scratchRoot(), 'nested');
    run(['audit', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('rescue --dry-run writes nothing and says so', () => {
    const root = scratchRoot();
    const r = run(['rescue', '--dry-run', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing was written');
    expect(fs.existsSync(path.join(root, 'potsherd.db'))).toBe(false);
  });

  it('rescue --yes --no-settings --quiet is silent and leaves settings alone', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();
    const before = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');

    const r = run(['rescue', '--yes', '--no-settings', '--quiet', '--claude-dir', claude, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, 'potsherd.db'))).toBe(true);
  });

  it('the hook command finishes fast on the second, unchanged run', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();
    const args = ['rescue', '--yes', '--no-settings', '--quiet', '--claude-dir', claude, '--potsherd-dir', root];
    run(args);
    const t0 = Date.now();
    const r = run(args);
    const elapsed = Date.now() - t0;
    expect(r.code).toBe(0);
    // The budget is one second including node's own startup.
    expect(elapsed).toBeLessThan(1000);
  });

  it('rescue --yes sets cleanupPeriodDays and keeps a backup', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();

    const r = run(['rescue', '--yes', '--claude-dir', claude, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    const after = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(after['cleanupPeriodDays']).toBe(3650);
    expect(after['permissions']).toBeDefined();
    const backups = fs.readdirSync(claude).filter((f) => f.includes('potsherd-bak'));
    expect(backups).toHaveLength(1);
  });

  it('refuses to change settings with no terminal and no --yes, and says how to fix it', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();
    const r = run(['rescue', '--claude-dir', claude, '--potsherd-dir', root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('try:');
    expect(r.stderr).toContain('--yes');
    // The archive still happened; only the settings prompt failed.
    expect(fs.existsSync(path.join(root, 'potsherd.db'))).toBe(true);
  });

  it('guard --status reports honestly and changes nothing', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const before = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');
    const r = run(['guard', '--status', '--claude-dir', claude]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('not installed');
    expect(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')).toBe(before);
  });

  it('guard installs and removes its hook', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));

    expect(run(['guard', '--yes', '--claude-dir', claude]).code).toBe(0);
    expect(run(['guard', '--status', '--json', '--claude-dir', claude]).stdout).toContain('"installed": true');

    expect(run(['guard', '--remove', '--yes', '--claude-dir', claude]).code).toBe(0);
    expect(run(['guard', '--status', '--json', '--claude-dir', claude]).stdout).toContain('"installed": false');
  });

  it('doctor reports zero fatal parse errors on the fixture', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--json', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { fatalErrors: number; recordTypes: Record<string, number> };
    expect(j.fatalErrors).toBe(0);
    expect(Object.keys(j.recordTypes).length).toBeGreaterThan(5);
  });

  it('doctor --privacy names every path read and written', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--privacy', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.stdout).toContain('reads');
    expect(r.stdout).toContain('writes');
    expect(r.stdout).toContain('no network');
  });

  it('every verb has --help with at least one example', () => {
    for (const verb of ['audit', 'rescue', 'guard', 'doctor']) {
      const r = run([verb, '--help']);
      expect(r.code, verb).toBe(0);
      expect(r.stdout, verb).toContain('example:');
      expect(r.stdout, verb).toContain(`potsherd ${verb}`);
      expect(r.stdout, verb).toContain('--json');
    }
  });

  it('an unknown verb points at --help instead of a stack trace', () => {
    const r = run(['excavate']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain('at Object.');
    expect(r.stderr).toContain('--help');
  });

  it('honours NO_COLOR and emits no escape codes', () => {
    const r = run(['audit', '--claude-dir', FIXTURE_CLAUDE], { NO_COLOR: '1' });
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(r.stdout)).toBe(false);
  });

  it('honours CLAUDE_CONFIG_DIR when no --claude-dir is given', () => {
    const r = run(['audit', '--json'], { CLAUDE_CONFIG_DIR: FIXTURE_CLAUDE });
    expect(JSON.parse(r.stdout)['deleted']).toBe(3);
  });
});
