import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consent, looksLikeJsonc, readCleanupStatus, resolveHookCommand, unifiedDiff } from '@potsherd/core';
import { copyFixtureClaude, readJson, rmrf, tempDir } from './helpers.js';

const created: string[] = [];

function scratch(): string {
  const claude = copyFixtureClaude();
  created.push(path.dirname(claude));
  return claude;
}

afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

const settingsOf = (claude: string) => path.join(claude, 'settings.json');

describe('cleanup status', () => {
  it('reports the 30-day default when the key is unset', () => {
    const st = readCleanupStatus(scratch());
    expect(st.declared).toBeNull();
    expect(st.effective).toBe(30);
    expect(st.source).toBe('default');
    expect(st.editable).toBe(true);
  });

  it('reads the user value when it is set', () => {
    const claude = scratch();
    fs.writeFileSync(settingsOf(claude), JSON.stringify({ cleanupPeriodDays: 90 }, null, 2));
    const st = readCleanupStatus(claude);
    expect(st.declared).toBe(90);
    expect(st.effective).toBe(90);
    expect(st.source).toBe('user');
  });

  it('refuses to edit a settings.json that is not valid JSON', () => {
    const claude = scratch();
    fs.writeFileSync(settingsOf(claude), '{ "cleanupPeriodDays": 30,,, }');
    const st = readCleanupStatus(claude);
    expect(st.editable).toBe(false);
    expect(st.reason).toMatch(/not valid JSON/);
  });

  it('refuses to edit a settings.json with comments, rather than dropping them', () => {
    const claude = scratch();
    fs.writeFileSync(
      settingsOf(claude),
      '{\n  // keep my sessions\n  "cleanupPeriodDays": 365\n}\n',
    );
    const st = readCleanupStatus(claude);
    expect(st.editable).toBe(false);
    expect(st.reason).toMatch(/comments/);
  });
});

describe('looksLikeJsonc', () => {
  it('finds comments outside strings', () => {
    expect(looksLikeJsonc('{ // hi\n"a":1}')).toBe(true);
    expect(looksLikeJsonc('{ /* hi */ "a":1}')).toBe(true);
  });

  it('does not mistake a URL or a path inside a string for a comment', () => {
    expect(looksLikeJsonc('{"url":"https://example.com/x"}')).toBe(false);
    expect(looksLikeJsonc('{"cmd":"node /a/b.js"}')).toBe(false);
    expect(looksLikeJsonc('{"escaped":"a\\"//b"}')).toBe(false);
  });
});

describe('cleanupPeriodDays proposal', () => {
  it('adds the key and keeps every other key untouched', () => {
    const claude = scratch();
    const p = consent.proposeCleanupPeriod(claude, 3650);
    expect(p.safe).toBe(true);
    expect(p.noop).toBe(false);

    consent.applyProposal(p);
    const after = readJson<Record<string, unknown>>(settingsOf(claude));
    expect(after['cleanupPeriodDays']).toBe(3650);
    expect(after['permissions']).toEqual({ allow: ['Read', 'Grep'] });
    expect(after['hooks']).toBeDefined();
  });

  it('writes a backup before touching anything', () => {
    const claude = scratch();
    const before = fs.readFileSync(settingsOf(claude), 'utf8');
    const { backup } = consent.applyProposal(consent.proposeCleanupPeriod(claude, 3650));
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(backup!, 'utf8')).toBe(before);
  });

  it('is a no-op when the value is already what we would set', () => {
    const claude = scratch();
    consent.applyProposal(consent.proposeCleanupPeriod(claude, 3650));
    const second = consent.proposeCleanupPeriod(claude, 3650);
    expect(second.noop).toBe(true);
    expect(consent.applyProposal(second).written).toBe(false);
  });

  it('shows a diff a human can read before saying yes', () => {
    const claude = scratch();
    const p = consent.proposeCleanupPeriod(claude, 3650);
    expect(p.diff).toContain('+');
    expect(p.diff).toContain('cleanupPeriodDays');
    // The diff must not claim to remove keys it is not removing.
    const removed = p.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    expect(removed.every((l) => l.includes('}'))).toBe(true);
  });

  it('refuses to apply an unsafe proposal even if asked directly', () => {
    const claude = scratch();
    fs.writeFileSync(settingsOf(claude), '{ /* mine */ }');
    const p = consent.proposeCleanupPeriod(claude, 3650);
    expect(p.safe).toBe(false);
    expect(() => consent.applyProposal(p)).toThrow(/comments/);
    // And the file is exactly as it was.
    expect(fs.readFileSync(settingsOf(claude), 'utf8')).toBe('{ /* mine */ }');
  });

  it('prints manual instructions when it will not edit', () => {
    const claude = scratch();
    fs.writeFileSync(settingsOf(claude), '{ // mine\n}');
    const p = consent.proposeCleanupPeriod(claude, 3650);
    const lines = consent.manualInstructions(p, 'cleanup', 3650);
    expect(lines.join('\n')).toContain('"cleanupPeriodDays": 3650');
  });
});

describe('guard hook proposal', () => {
  it('appends beside an existing SessionStart hook instead of replacing it', () => {
    const claude = scratch();
    consent.applyProposal(consent.proposeGuardHook(claude));

    const after = readJson<{ hooks: { SessionStart: { hooks: { command: string }[] }[] } }>(
      settingsOf(claude),
    );
    const commands = after.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain('echo existing-hook-must-survive');
    expect(commands.some((c) => c.includes('potsherd rescue'))).toBe(true);
    expect(after.hooks.SessionStart).toHaveLength(2);
  });

  it('installs a hook that cannot prompt and cannot touch settings', () => {
    expect(consent.GUARD_COMMAND).toContain('--yes');
    expect(consent.GUARD_COMMAND).toContain('--quiet');
    expect(consent.GUARD_COMMAND).toContain('--no-settings');
  });

  it('is idempotent', () => {
    const claude = scratch();
    consent.applyProposal(consent.proposeGuardHook(claude));
    expect(consent.guardInstalled(claude)).toBe(true);
    expect(consent.proposeGuardHook(claude).noop).toBe(true);
  });

  it('--remove takes back only its own entry', () => {
    const claude = scratch();
    consent.applyProposal(consent.proposeGuardHook(claude));
    consent.applyProposal(consent.proposeGuardHook(claude, { remove: true }));

    expect(consent.guardInstalled(claude)).toBe(false);
    const after = readJson<{ hooks: { SessionStart: { hooks: { command: string }[] }[] } }>(
      settingsOf(claude),
    );
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(after.hooks.SessionStart[0]!.hooks[0]!.command).toBe('echo existing-hook-must-survive');
  });

  it('--remove on a machine that never installed it is a no-op', () => {
    const claude = scratch();
    expect(consent.proposeGuardHook(claude, { remove: true }).noop).toBe(true);
  });

  it('creates the hooks object when settings.json has none', () => {
    const claude = scratch();
    fs.writeFileSync(settingsOf(claude), JSON.stringify({ model: 'opus' }, null, 2));
    consent.applyProposal(consent.proposeGuardHook(claude));
    const after = readJson<Record<string, unknown>>(settingsOf(claude));
    expect(after['model']).toBe('opus');
    expect(consent.guardInstalled(claude)).toBe(true);
  });

  it('refuses a JSONC settings file', () => {
    const claude = scratch();
    fs.writeFileSync(settingsOf(claude), '{ // mine\n"model":"opus"}');
    const p = consent.proposeGuardHook(claude);
    expect(p.safe).toBe(false);
    expect(consent.manualInstructions(p, 'guard').join('\n')).toContain('SessionStart');
  });
});

describe('guard command resolution', () => {
  it('prefers potsherd on PATH, because that survives an upgrade', () => {
    const dir = path.join(tempDir('potsherd-bin-'), 'bin');
    created.push(path.dirname(dir));
    fs.mkdirSync(dir, { recursive: true });
    const fake = path.join(dir, 'potsherd');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const saved = process.env['PATH'];
    try {
      process.env['PATH'] = dir;
      const r = resolveHookCommand('rescue --yes', '/somewhere/potsherd.js');
      expect(r.via).toBe('path');
      expect(r.command).toBe('potsherd rescue --yes');
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it('falls back to an absolute path, so the hook is never a no-op', () => {
    const dir = tempDir('potsherd-bin-');
    created.push(dir);
    const entry = path.join(dir, 'potsherd.js');
    fs.writeFileSync(entry, '');

    const saved = process.env['PATH'];
    try {
      process.env['PATH'] = path.join(dir, 'definitely-empty');
      const r = resolveHookCommand('rescue --yes', entry);
      expect(r.via).toBe('absolute');
      expect(r.command).toBe(`node "${entry}" rescue --yes`);
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it('recognises its own hook whichever form it was installed in', () => {
    const claude = scratch();
    consent.applyProposal(
      consent.proposeGuardHook(claude, { command: 'node "/opt/x/potsherd.js" rescue --yes --quiet --no-settings' }),
    );
    expect(consent.guardInstalled(claude)).toBe(true);
    expect(consent.installedGuardCommand(claude)).toContain('/opt/x/potsherd.js');
    // And can take it back out again.
    consent.applyProposal(consent.proposeGuardHook(claude, { remove: true }));
    expect(consent.guardInstalled(claude)).toBe(false);
  });
});

describe('unifiedDiff', () => {
  it('shows only the lines that changed, with context', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nB\nc\n';
    const d = unifiedDiff(before, after, 'x');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
    expect(d).not.toContain('-a');
    expect(d).not.toContain('-c');
  });
});
