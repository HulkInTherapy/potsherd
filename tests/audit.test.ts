import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit, rescue, renderAuditCard, Theme, stripAnsi } from '@potsherd/core';
import { copyFixtureClaude, FIXTURE_CLAUDE, FIXTURE_MTIMES, IDS, rmrf, setMtime, tempDir } from './helpers.js';

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
    // Hermetic on purpose. Git does not record mtimes, so on a fresh clone the
    // fixture's transcripts are as old as the checkout and this test would read
    // whatever CI happened to stamp on them. The ages are set here, in the
    // test, on a throwaway copy — never inherited from the working tree.
    const claude = copyFixtureClaude();
    try {
      setMtime(path.join(claude, `projects/-tmp-potsherd-alpha/${IDS.alive}.jsonl`), '2026-08-01T09:05:20.000Z');
      setMtime(path.join(claude, `projects/-tmp-potsherd-beta/${IDS.sdk}.jsonl`), '2026-08-02T11:00:09.000Z');

      const r = await audit(claude, NOW);
      // alive mtime 1 aug, sdk mtime 2 aug, now 21 aug, period 30 days.
      const alive = r.nextSweep.find((s) => s.id === IDS.alive);
      expect(alive?.daysLeft).toBe(10);
      const sdk = r.nextSweep.find((s) => s.id === IDS.sdk);
      expect(sdk?.daysLeft).toBe(11);
      // nextSweep lists every live session, soonest first, for --sweep and --json.
      expect(r.nextSweep.map((s) => s.id)).toEqual([IDS.alive, IDS.sdk]);
      // The headline counts only the ones inside the week the card advertises.
      expect(r.nextSweepWithin7Days).toBe(0);
      expect(r.nextSweepWithinOneDay).toBe(0);
    } finally {
      rmrf(path.dirname(claude));
    }
  });

  it('reads no session age off the checked-out fixture', async () => {
    // The regression guard for the above: a fresh `git clone` stamps every
    // fixture file with the checkout time, so touching them must change nothing
    // any test asserts. If this fails, some test has started trusting a working
    // tree mtime again and CI will go red on a clean machine.
    const claude = copyFixtureClaude();
    try {
      // Stand in for the checkout stamping every file with "now".
      for (const rel of Object.keys(FIXTURE_MTIMES)) {
        setMtime(path.join(claude, rel), NOW.toISOString());
      }
      const r = await audit(claude, NOW);
      // Counts, prompts and wiped projects are all mtime-independent.
      expect(r.sessionsEver).toBe(5);
      expect(r.onDisk).toBe(2);
      expect(r.deleted).toBe(3);
      expect(r.promptsLost).toBe(6);
      // Only the sweep arithmetic moves, and it moves to "the full period".
      expect(r.nextSweep.map((s) => s.daysLeft)).toEqual([30, 30]);
    } finally {
      rmrf(path.dirname(claude));
    }
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


/**
 * A subagent transcript is part of the session that spawned it, never a session
 * of its own. Two layouts exist in the wild — `<slug>/<session>/subagents/` on
 * this corpus, `<slug>/subagents/` in plans/phases/phase-0-rescue.md T0.1 — and
 * counting either as a session would inflate "still on disk" and hide a
 * deleted session. potsherd and the standalone python must agree on that, on
 * both layouts, or the honesty contract is worthless.
 */
describe('sidechains are not sessions', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const verifier = path.join(repo, 'scripts', 'verify-audit.py');

  it('finds both sidechain layouts and counts neither as a session', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    // agent-01 under <session>/subagents/, agent-02 under <project>/subagents/.
    expect(r.sidechainFiles).toBe(2);
    expect(r.onDisk).toBe(2);
    expect(r.onDiskFiles).toBe(2);
    expect(r.sessionsEver).toBe(5);
    const ids = new Set(r.nextSweep.map((s) => s.id));
    expect(ids).toEqual(new Set([IDS.alive, IDS.sdk]));
    expect([...ids].some((id) => id.startsWith('agent-'))).toBe(false);
  });

  it('agrees with scripts/verify-audit.py on the same corpus', async () => {
    let raw: string;
    try {
      raw = execFileSync('python3', [verifier, '--json', '--claude-dir', FIXTURE_CLAUDE], {
        encoding: 'utf8',
      });
    } catch (err) {
      // A machine with no python3 cannot run the cross-check; CI always can.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const v = JSON.parse(raw) as Record<string, number>;
    const r = await audit(FIXTURE_CLAUDE, NOW);
    expect(v['sessionsEver']).toBe(r.sessionsEver);
    expect(v['onDisk']).toBe(r.onDisk);
    expect(v['deleted']).toBe(r.deleted);
    expect(v['promptsLost']).toBe(r.promptsLost);
    expect(v['promptsSurviving']).toBe(r.promptsSurviving);
    // The fifth number too. Non-vacuously: the fixture has exactly one deleted
    // session that recorded nothing but a stub, and a cross-check of 0 === 0
    // would pass against a script that never learned the rule.
    expect(r.deletedWithoutSubstantivePrompt).toBeGreaterThan(0);
    expect(v['deletedWithoutSubstantivePrompt']).toBe(r.deletedWithoutSubstantivePrompt);
    // And it saw the sidechains without counting them.
    expect(v['sidechainFiles']).toBe(r.sidechainFiles);
  });

  it('still refuses to count a sidechain when a project has only sidechains', async () => {
    const claude = copyFixtureClaude();
    try {
      const dir = path.join(claude, 'projects', '-tmp-potsherd-delta', 'subagents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'agent-09.jsonl'),
        JSON.stringify({ type: 'agent-name', agentName: 'lone', isSidechain: true }) + '\n',
      );
      const r = await audit(claude, NOW);
      expect(r.onDisk).toBe(2);
      expect(r.sessionsEver).toBe(5);
      expect(r.sidechainFiles).toBe(3);
    } finally {
      rmrf(path.dirname(claude));
    }
  });
});

/**
 * The honesty contract, run the way the documentation says to run it.
 *
 * `FINAL-REPORT.md` §4 hands a reader this line:
 *
 *     potsherd audit --claude-dir X --verify --json | jq -r .snippet | sh
 *
 * and `sh` does not inherit a flag — so the snippet read `~/.claude` and
 * answered about a different corpus. A fresh verifier followed exactly that
 * line and reported **340 / 41** against the audit's **330 / 31**, which reads
 * as potsherd under-reporting by ten. The product was right; the artefact whose
 * entire purpose is that nobody has to trust the product was answering a
 * different question.
 *
 * So the test is the pipeline, not the function: audit against a fixture, take
 * the snippet out of `--json`, run it in a shell that was told nothing, and
 * require the four numbers to match.
 */
describe('audit --verify, piped the way the docs pipe it', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bin = path.join(repoRoot, 'packages', 'cli', 'bin', 'potsherd.js');
  const run = (args: string[]): { code: number; stdout: string } => {
    try {
      return {
        code: 0,
        stdout: execFileSync(process.execPath, [bin, ...args], {
          encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1' },
        }),
      };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '' };
    }
  };

  it('recomputes the same four numbers with no flag and no environment', () => {
    const r = run(['audit', '--verify', '--json', '--claude-dir', FIXTURE_CLAUDE]);
    expect(r.code).toBe(0);
    const { snippet } = JSON.parse(r.stdout) as { snippet: string };

    const a = JSON.parse(
      run(['audit', '--json', '--claude-dir', FIXTURE_CLAUDE]).stdout,
    ) as Record<string, number>;

    // A shell with CLAUDE_CONFIG_DIR deliberately *cleared*: the point is that
    // the snippet carries what it needs.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env['CLAUDE_CONFIG_DIR'];
    const out = execFileSync('sh', ['-c', snippet], {
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv,
    });

    const got: Record<string, number> = {};
    for (const line of out.split('\n')) {
      const m = /^(.*?)\s+(\d+)$/.exec(line.trim());
      if (m) got[m[1] as string] = Number(m[2]);
    }
    expect(got['sessions ever started']).toBe(a['sessionsEver']);
    expect(got['still on disk']).toBe(a['onDisk']);
    expect(got['deleted']).toBe(a['deleted']);
    expect(got['prompts lost']).toBe(a['promptsLost']);

    // Every number the card prints, not four of them. A row the screen shows
    // and the receipt cannot recompute makes the receipt answer a smaller
    // question than the screen asks, while looking like it answered all of it.
    expect(a['deletedWithoutSubstantivePrompt']).toBeGreaterThan(0);
    expect(got['only commands and stubs']).toBe(a['deletedWithoutSubstantivePrompt']);

    // The screen and the pipeline, side by side. What is asserted is that
    // every number the card renders appears in the snippet's output, so a
    // sixth row added later without a sixth line here fails this test.
    const card = stripAnsi(
      execFileSync(process.execPath, [bin, 'audit', '--claude-dir', FIXTURE_CLAUDE, '--width', '80'], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      }),
    );
    for (const [label, n] of Object.entries(got)) {
      const row = card.split('\n').find((l) => l.trim().startsWith(label));
      expect(row, `no "${label}" row on the audit card`).toBeDefined();
      expect(row!.replace(/,/g, ''), row).toContain(String(n));
    }
  });

  it('leaves the default form alone, so a pasted snippet names no machine path', () => {
    // With no `--claude-dir` the environment variable is the honest answer, and
    // baking in a resolved home would put a machine path into something people
    // paste into issues.
    const r = run(['audit', '--verify', '--json']);
    const { snippet } = JSON.parse(r.stdout) as { snippet: string };
    expect(snippet.startsWith("python3 - <<'PY'")).toBe(true);
    expect(snippet).not.toContain(process.env['HOME'] ?? '\u0000never');
  });
});

describe('audit --verify', () => {
  it('prints python that needs no checkout and no potsherd', async () => {
    const { VERIFY_SNIPPET, renderVerify } = await import('@potsherd/core');
    // Nothing outside the standard library, and nothing from potsherd.
    expect(VERIFY_SNIPPET).not.toContain('potsherd');
    expect(VERIFY_SNIPPET.match(/^import .*/gm)).toEqual(['import glob, json, os']);
    expect(VERIFY_SNIPPET).toContain('subagents');

    const out = renderVerify('~/.claude', new Theme({ color: false, width: 80 }));
    expect(out).toContain('sessions ever started');
    expect(out).toContain('prompts lost');
    expect(out).toContain('scripts/verify-audit.py');
  });

  it('recomputes the four numbers the same way audit does', async () => {
    const { VERIFY_SNIPPET } = await import('@potsherd/core');
    // Strip the `python3 - <<'PY' ... PY` heredoc down to the program itself.
    const body = VERIFY_SNIPPET.split('\n').slice(1, -1).join('\n');
    let raw: string;
    try {
      raw = execFileSync('python3', ['-c', body], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: FIXTURE_CLAUDE },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const got = Object.fromEntries(
      raw.trim().split('\n').map((l) => {
        const m = /^(.*?)\s+(\d+)$/.exec(l.trim())!;
        return [m[1]!.trim(), Number(m[2])];
      }),
    );
    const r = await audit(FIXTURE_CLAUDE, NOW);
    expect(got['sessions ever started']).toBe(r.sessionsEver);
    expect(got['still on disk']).toBe(r.onDisk);
    expect(got['deleted']).toBe(r.deleted);
    expect(got['prompts lost']).toBe(r.promptsLost);
    expect(got['only commands and stubs']).toBe(r.deletedWithoutSubstantivePrompt);
  });
});

/**
 * **The second number beside the first** (`plans/09` §13.11).
 *
 * `deleted` is literally true and thinner than it looks. `history.jsonl` rows
 * carry exactly five fields — `display`, `pastedContents`, `project`,
 * `sessionId`, `timestamp` — and none of them separates a session somebody
 * worked in from a resume picker that was opened and closed. On the reference
 * machine 92 of the 299 deleted sessions are one `/resume` and nothing else,
 * and 0 of those 92 ever had a transcript. The signature is behavioural, not
 * structural: it cannot be read off the file, so no count changes.
 *
 * What is added is a measurement written beside the claim: of the deleted, how
 * many recorded something and nothing in it names them. The rule is
 * `rescue.ts`'s `isSubstantivePrompt`, the same one that decides what a ghost
 * is titled — not a second rule.
 *
 * The fixture is what makes these tests non-vacuous, and it establishes each
 * boundary of the definition rather than a single number:
 *   ghostA  `/model`  then a real question   → named, not counted
 *   ghostB  `continue` then a real question  → named, not counted
 *   ghostC  `clear` and nothing else         → counted
 */
describe('audit discloses what the deleted sessions recorded', () => {
  it('counts a deleted session that recorded only a stub, and only that one', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    expect(r.deleted).toBe(3);
    // Not "some": exactly the one whose every history line fails the rule. A
    // rule that rejected any session containing a slash command would say 2
    // here, and one that rejected nothing would say 0.
    expect(r.deletedWithoutSubstantivePrompt).toBe(1);
  });

  it('moves by exactly the number of stub-only sessions added', async () => {
    const claude = copyFixtureClaude();
    try {
      const before = await audit(claude, NOW);
      // Two more deleted sessions — no transcript is written for either, which
      // is what makes them deleted. One recorded a single `/resume` and
      // nothing else; the other opened the same way and then asked something.
      // Only the first is the thing being counted.
      const STUB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const REAL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const line = (sessionId: string, display: string, timestamp: number) =>
        JSON.stringify({ display, pastedContents: {}, timestamp, project: '/tmp/potsherd-gamma', sessionId });
      fs.appendFileSync(
        path.join(claude, 'history.jsonl'),
        [
          line(STUB, '/resume ', 1778500000000),
          line(REAL, '/resume ', 1778500100000),
          line(REAL, 'the deploy is failing on the health check again', 1778500200000),
        ].join('\n') + '\n',
      );

      const after = await audit(claude, NOW);
      expect(after.deleted).toBe(before.deleted + 2);
      expect(after.deletedWithoutSubstantivePrompt).toBe(
        (before.deletedWithoutSubstantivePrompt ?? -1) + 1,
      );
    } finally {
      rmrf(path.dirname(claude));
    }
  });

  it('does not count a deleted session that recorded nothing at all', async () => {
    const claude = copyFixtureClaude();
    try {
      const before = await audit(claude, NOW);
      // A session named only by a sessions-index: no transcript, no history
      // line. It recorded nothing, which is a different fact from recording
      // something that names nothing, and the disclosure line says the second.
      const idx = path.join(claude, 'projects', '-tmp-potsherd-alpha', 'sessions-index.json');
      const data = JSON.parse(fs.readFileSync(idx, 'utf8')) as { entries: unknown[] };
      data.entries.push({ sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', isSidechain: false });
      fs.writeFileSync(idx, JSON.stringify(data));

      const after = await audit(claude, NOW);
      expect(after.deleted).toBe(before.deleted + 1);
      expect(after.deletedWithoutSubstantivePrompt).toBe(before.deletedWithoutSubstantivePrompt);
    } finally {
      rmrf(path.dirname(claude));
    }
  });

  it('reports null, never zero, when the scan was never asked the question', async () => {
    const { collectAudit, computeAudit } = await import('@potsherd/core');
    const input = await collectAudit(FIXTURE_CLAUDE, NOW);
    expect(computeAudit(input).deletedWithoutSubstantivePrompt).toBe(1);

    // A `HistoryScan` taken without `withPrompts` has an empty `prompts` array
    // on every session, so the same arithmetic would come out `0` — a number,
    // on the product's first screen, meaning "nobody asked".
    const blind = { ...input, history: { ...input.history, withPrompts: false } };
    expect(computeAudit(blind).deletedWithoutSubstantivePrompt).toBeNull();
  });

  it('puts the row on the card only when there is something to disclose', async () => {
    const r = await audit(FIXTURE_CLAUDE, NOW);
    const t = new Theme({ color: false, width: 80 });

    const shown = stripAnsi(renderAuditCard(r, t));
    expect(shown).toContain('only commands and stubs');
    // Anchored to the denominator it is a fraction of, and not editorialised:
    // it says what was recorded, not what the sessions were.
    expect(shown).toMatch(/only commands and stubs\s+1\s+of the 3 deleted/);
    for (const line of shown.split('\n')) expect([...line].length).toBeLessThanOrEqual(80);

    // Nothing to disclose, and nothing said. Both the "every deleted session
    // had a real prompt" case and the "not measured" case.
    for (const value of [0, null]) {
      const quiet = stripAnsi(
        renderAuditCard({ ...r, deletedWithoutSubstantivePrompt: value }, t),
      );
      expect(quiet, String(value)).not.toContain('only commands and stubs');
    }
  });
});
