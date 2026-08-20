import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit, rescue, renderAuditCard, Theme, stripAnsi } from '@potsherd/core';
import { copyFixtureClaude, FIXTURE_CLAUDE, IDS, rmrf, tempDir } from './helpers.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');

describe('audit', () => {
  it('counts sessions from disk, history and sessions-index together', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);

    // 2 transcripts on disk (one cli, one sdk) + 3 whose transcripts are gone.
    expect(r.onDisk).toBe(2);
    expect(r.deleted).toBe(3);
    expect(r.sessionsEver).toBe(5);
    expect(r.sessionsEver).toBe(r.onDisk + r.deleted);
  });

  it('counts prompts from the deleted sessions only', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    // ghostA 3 + ghostB 2 + ghostC 1
    expect(r.promptsLost).toBe(6);
    expect(r.promptsSurviving).toBe(2);
  });

  it('does not lose the SDK session, which never reaches history.jsonl', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    expect(r.historySessions).toBe(4);
    expect(r.sdkSessions).toBe(1);
    // The history-only view would have said 4 ever; the union says 5.
    expect(r.sessionsEver).toBeGreaterThan(r.historySessions);
  });

  it('takes the last ai-title, not the first', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    expect(r.titledSessions).toBe(1);
    const doomed = r.nextSweep.find((s) => s.id === IDS.alive);
    expect(doomed?.title).toBe('Pin pgbouncer prepared-statement handling');
  });

  it('counts a project as wiped only when every session in it is gone', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const names = r.projectsWiped.map((p) => p.name);
    // gamma lost both its sessions; alpha lost one but still has the live one.
    expect(names).toEqual(['potsherd-gamma']);
    expect(r.projectsWiped[0]!.sessions).toBe(2);
    expect(r.projectsWiped[0]!.prompts).toBe(5);
  });

  it('reports the default cleanup period when the key is unset', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    expect(r.cleanupPeriodDays).toBeNull();
    expect(r.cleanupPeriodEffective).toBe(30);
    expect(r.cleanupPeriodSource).toBe('default');
    expect(r.cleanupEditable).toBe(true);
  });

  it('computes days left from mtime, and flags what the sweep takes next', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    // alive mtime 1 aug, sdk mtime 2 aug, now 21 aug, period 30 days.
    const alive = r.nextSweep.find((s) => s.id === IDS.alive);
    expect(alive?.daysLeft).toBe(10);
    // nextSweep lists every live session, soonest first, for --sweep and --json.
    expect(r.nextSweep.map((s) => s.id)).toEqual([IDS.alive, IDS.sdk]);
    // The headline counts only the ones inside the week the card advertises.
    expect(r.nextSweepWithin7Days).toBe(0);
    expect(r.nextSweepWithinOneDay).toBe(0);
  });

  it('tolerates a malformed history line and one with no sessionId', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    expect(r.warnings.some((w) => w.includes('malformed'))).toBe(true);
    // Neither is fatal, and neither inflates the counts.
    expect(r.historyPrompts).toBe(8);
  });

  it('counts every record type it saw, including the undocumented ones', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    expect(Object.keys(r.recordTypes)).toEqual(
      expect.arrayContaining(['user', 'assistant', 'ai-title', 'agent-name', 'permission-mode']),
    );
  });

  it('never reports a path outside the claude dir as read', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const outside = r.pathsRead.filter(
      (p) => !p.startsWith(FIXTURE_CLAUDE) && !p.includes('managed-settings'),
    );
    expect(outside).toEqual([]);
  });

  it('runs well inside the two-second budget on the fixture', async () => {
    const t0 = Date.now();
    await audit(FIXTURE_CLAUDE, NOW);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('audit card', () => {
  const width = 80;

  it('fits 80 columns and never wraps', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const out = renderAuditCard(r, new Theme({ color: false, width }));
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it('is still legible at 60 columns', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const out = renderAuditCard(r, new Theme({ color: false, width: 60 }));
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    expect(out).toContain('sessions ever');
    expect(out).toContain('potsherd rescue');
  });

  it('ends with the next verb', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const out = renderAuditCard(r, new Theme({ color: false, width }));
    const lines = out.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toContain('potsherd rescue');
  });

  it('emits no colour at all when colour is off', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const plain = renderAuditCard(r, new Theme({ color: false, width }));
    expect(stripAnsi(plain)).toBe(plain);
  });

  it('spends the accent colour on one line and the warning colour on one line', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const coloured = renderAuditCard(r, new Theme({ color: true, width }));
    const lines = coloured.split('\n');
    const ACCENT = '38;5;209';
    const WARN = '38;5;214';
    const OK = '38;5;71';
    expect(lines.filter((l) => l.includes(ACCENT))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(WARN)).length).toBeLessThanOrEqual(1);
    // Never more than three colours on screen, dim aside.
    const used = [ACCENT, WARN, OK].filter((c) => coloured.includes(c));
    expect(used.length).toBeLessThanOrEqual(3);
  });

  it('uses ASCII fallbacks under --ascii', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const out = renderAuditCard(r, new Theme({ color: false, ascii: true, width }));
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(out)).toBe(false);
  });

  it('tells you to rescue before you have, and what it rescued after', async () => {
    const before = await audit(FIXTURE_CLAUDE, NOW);
    const beforeOut = renderAuditCard(before, new Theme({ color: false, width }));
    expect(before.archive).toBeNull();
    expect(beforeOut).toContain('run  potsherd rescue');
    expect(beforeOut).toContain('recoverable from history.jsonl');

    const root = tempDir('potsherd-audit-');
    try {
      await rescue({ claudeDir: FIXTURE_CLAUDE, root });
      const after = await audit(FIXTURE_CLAUDE, NOW, { potsherdDir: root });
      const afterOut = renderAuditCard(after, new Theme({ color: false, width }));

      expect(after.archive?.ghosts).toBe(3);
      expect(afterOut).toContain('3 ghosts rebuilt');
      // The card must never tell you to run something you have already run.
      expect(afterOut).not.toContain('recoverable from history.jsonl');
      expect(afterOut.trimEnd().split('\n').pop()).toMatch(/potsherd (rescue --yes|guard)/);
    } finally {
      rmrf(root);
    }
  });

  it('stops calling it the 30-day sweep once the user has turned it off', async () => {
    const claude = copyFixtureClaude();
    try {
      fs.writeFileSync(
        path.join(claude, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 3650 }, null, 2),
      );
      const r = await audit(claude, NOW);
      const out = renderAuditCard(r, new Theme({ color: false, width }));
      expect(out).not.toContain('3650-day sweep');
      expect(out).toContain('already deleted');
      // A settings value never gets a thousands separator.
      expect(out).toContain('3650');
      expect(out).not.toContain('3,650');
    } finally {
      rmrf(path.dirname(claude));
    }
  });

  it('says something useful when there is no claude directory at all', async () => {
    const r = await audit('/tmp/potsherd-does-not-exist', NOW);
    const out = renderAuditCard(r, new Theme({ color: false, width }));
    expect(out).toContain('--claude-dir');
    expect(r.sessionsEver).toBe(0);
  });
});
