import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { format } from '@potsherd/core';
import { copyFixtureClaude, FIXTURE_CLAUDE, rmrf, tempDir } from './helpers.js';

const bytes = format.bytes;

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
      // POTSHERD_DIR and CLAUDE_CONFIG_DIR come from tests/setup.ts and point
      // at a throwaway sandbox, so a missing --potsherd-dir can never reach the
      // machine's real archive.
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

  it('guard --status says whether the installed hook can actually run', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));

    run(['guard', '--yes', '--claude-dir', claude]);
    const ok = JSON.parse(run(['guard', '--status', '--json', '--claude-dir', claude]).stdout) as {
      installed: boolean; runnable: boolean; command: string;
    };
    expect(ok.installed).toBe(true);
    expect(ok.runnable).toBe(true);

    // Break it the way a moved checkout or a global uninstall would.
    const settings = path.join(claude, 'settings.json');
    const j = JSON.parse(fs.readFileSync(settings, 'utf8')) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    for (const entry of j.hooks.SessionStart) {
      for (const h of entry.hooks) {
        if (h.command.includes('rescue')) {
          h.command = 'node "/nowhere/potsherd.js" rescue --yes --quiet --no-settings';
        }
      }
    }
    fs.writeFileSync(settings, JSON.stringify(j, null, 2));

    const broken = run(['guard', '--status', '--claude-dir', claude]);
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain('broken');
    expect(broken.stdout).toContain('potsherd guard --remove');
  });

  it('doctor reports zero fatal parse errors on the fixture', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--json', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { fatalErrors: number; recordTypes: Record<string, number> };
    expect(j.fatalErrors).toBe(0);
    expect(Object.keys(j.recordTypes).length).toBeGreaterThan(5);
  });

  it('doctor sizes the archive by the archive, not by the live corpus', () => {
    // `files archived 2 · 88 B of source` printed right after rescue reported
    // 277 B copied: the count was of archived files, the size of ~/.claude.
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();

    const dry = run(['doctor', '--claude-dir', claude, '--potsherd-dir', root, '--width', '100']);
    expect(dry.stdout).toContain('nothing archived yet');

    const rescued = run(['rescue', '--yes', '--no-settings', '--json', '--claude-dir', claude, '--potsherd-dir', root]);
    const bytesArchived = (JSON.parse(rescued.stdout) as { bytesArchived: number }).bytesArchived;

    const doc = run(['doctor', '--json', '--claude-dir', claude, '--potsherd-dir', root]);
    const j = JSON.parse(doc.stdout) as { corpus: { bytes: number } };
    // The two figures really are different; the row must use the archive's.
    expect(bytesArchived).not.toBe(j.corpus.bytes);

    const human = run(['doctor', '--claude-dir', claude, '--potsherd-dir', root, '--width', '100']);
    const row = human.stdout.split('\n').find((l) => l.includes('files archived'))!;
    expect(row).toContain(bytes(bytesArchived));
    expect(row).not.toContain(bytes(j.corpus.bytes));
  });

  it('audit --verify prints runnable python, writes nothing and exits 0', () => {
    const root = path.join(scratchRoot(), 'nested');
    const r = run(['audit', '--verify', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("python3 - <<'PY'");
    expect(r.stdout).toContain('sessions ever started');
    expect(r.stdout).toContain('scripts/verify-audit.py');
    // --verify is still `audit`: it must not create ~/.potsherd either.
    expect(fs.existsSync(root)).toBe(false);

    const j = JSON.parse(
      run(['audit', '--verify', '--json', '--claude-dir', FIXTURE_CLAUDE]).stdout,
    ) as { snippet: string; scriptPath: string };
    expect(j.scriptPath).toBe('scripts/verify-audit.py');
    expect(j.snippet).toContain('history.jsonl');
  });

  it('the audit card keeps its closing command whole at 60 columns', () => {
    const r = run(['audit', '--claude-dir', FIXTURE_CLAUDE, '--width', '60']);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    const last = lines[lines.length - 1]!;
    expect(last.endsWith('…')).toBe(false);
    expect(last).toMatch(/run {2}potsherd (audit|rescue|guard)(?: --[a-z-]+)?(?: {2}\S|$)/);
  });

  it('does not write "all 1" or "1 prompts" anywhere', () => {
    // One deleted session, one stored prompt: every count is pluralised.
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const projects = path.join(claude, 'projects');
    // Give the two gamma ghosts their transcripts back, so exactly one session
    // is deleted and that session typed exactly one prompt.
    for (const [slug, id] of [
      ['-tmp-potsherd-gamma', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['-tmp-potsherd-gamma', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ] as const) {
      fs.mkdirSync(path.join(projects, slug), { recursive: true });
      fs.writeFileSync(
        path.join(projects, slug, `${id}.jsonl`),
        JSON.stringify({ type: 'user', sessionId: id, timestamp: '2026-08-01T00:00:00.000Z' }) + '\n',
      );
    }
    const card = run(['audit', '--claude-dir', claude, '--width', '100']).stdout;
    expect(card).toContain('deleted by 30-day sweep');
    expect(card).not.toContain('all 1 are');
    expect(card).toMatch(/that one session/);

    const root = scratchRoot();
    run(['rescue', '--yes', '--no-settings', '--quiet', '--claude-dir', claude, '--potsherd-dir', root]);
    const doc = run(['doctor', '--claude-dir', claude, '--potsherd-dir', root, '--width', '100']).stdout;
    const ghosts = doc.split('\n').find((l) => l.includes('ghosts stored'))!;
    expect(ghosts).toMatch(/1 {2,}1 prompt$/);
    expect(ghosts).not.toContain('1 prompts');
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
