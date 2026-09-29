import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { paths, Theme } from '@potsherd/core';
import { doctorLine as geminiDoctorLine } from '../packages/core/src/adapters/gemini.js';
import { doctorLine as copilotDoctorLine } from '../packages/core/src/adapters/copilot.js';
import { renderIndexReceipt } from '../packages/cli/src/commands/index.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * `index` and `doctor` answer "is this harness installed?" the same way —
 * FIX-B D5.
 *
 * On the verifier's machine `potsherd index` printed `not installed` for
 * gemini and copilot while `potsherd doctor` reported both installed. Two
 * verbs, two answers, one question, and neither of them was lying about what
 * it had looked at: `doctor` asks the adapters, which test the harness's own
 * directory (`~/.gemini`, `~/.copilot`) **or** its transcript directory and
 * have three answers — `ready`, `empty`, `absent`. `index` tested the
 * transcript directory alone and had two, so the whole `empty` state — the
 * harness is installed and has simply written nothing yet — came out as the
 * words `not installed`.
 *
 * The adapters' own comments say "0 sessions alone cannot tell those apart".
 * The receipt is exactly the place that lost the distinction.
 *
 * These tests drive the wording through fixture directories rather than the
 * machine's real ones: `~/.gemini` and `~/.copilot` are read-only here, and a
 * test whose result depends on what happens to be installed is not a test.
 */

const cleanup: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const k of ['POTSHERD_GEMINI_DIR', 'POTSHERD_COPILOT_DIR']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of cleanup.splice(0)) rmrf(d);
});

function fixture(): string {
  const d = tempDir('potsherd-harness-');
  cleanup.push(d);
  return d;
}

describe('installed, but with nothing written yet', () => {
  it('is not "not installed" — paths agrees with the adapters', () => {
    const root = fixture();
    process.env['POTSHERD_GEMINI_DIR'] = root;
    // The harness's own directory exists; `tmp/` — where the chats go — does not.
    expect(fs.existsSync(paths.geminiTmpDir())).toBe(false);
    expect(paths.harnessInstalled('gemini')).toBe(true);
    // …and that is exactly what the adapter tells `doctor`.
    expect(geminiDoctorLine(root)).not.toContain('not installed');
    expect(geminiDoctorLine(root)).toContain('empty');
  });

  it('is "not installed" when the harness directory is absent too', () => {
    const gone = path.join(fixture(), 'nothing-here');
    process.env['POTSHERD_COPILOT_DIR'] = gone;
    expect(paths.harnessInstalled('copilot')).toBe(false);
    expect(copilotDoctorLine(gone)).toContain('absent');
  });

  it('reports the transcript directory as present when it exists', () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, 'session-state'), { recursive: true });
    process.env['POTSHERD_COPILOT_DIR'] = root;
    expect(paths.harnessInstalled('copilot')).toBe(true);
  });
});

describe('the index receipt says what doctor says', () => {
  const t = new Theme({ color: false, width: 100 });

  function receipt(present: boolean): string {
    return renderIndexReceipt(
      {
        harnesses: [
          {
            harness: 'gemini',
            present,
            discovered: 0,
            sessions: 0,
            sidechains: 0,
            exchanges: 0,
            parsed: 0,
            skipped: 0,
            failed: 0,
            bytes: 0,
            errors: [],
            unchanged: false,
            sourceDir: '/tmp/potsherd-gemini-fixture/tmp',
          },
        ],
        totals: {
          sessions: 0, sidechains: 0, exchanges: 0, toolCalls: 0, redactedExchanges: 0,
          parsed: 0, skipped: 0, failed: 0, bytes: 0, discovered: 0,
        },
        ghosts: { ghosts: 0, prompts: 0, unchanged: false },
        redaction: { total: 0, byType: {} },
        recordTypes: [],
        embeddings: { enabled: false, available: false, upToDate: 0 },
        full: false,
        ms: 12,
        ranAt: '2026-08-24T00:00:00Z',
      } as unknown as Parameters<typeof renderIndexReceipt>[0],
      t,
      '/tmp/potsherd-root',
      {},
    );
  }

  it('does not call an installed harness with no transcripts "not installed"', () => {
    const line = receipt(true).split('\n').find((l) => l.includes('gemini'))!;
    expect(line).not.toContain('not installed');
    expect(line).toContain('installed');
    expect(line).toContain('no transcripts');
  });

  it('still says "not installed" when the harness really is absent', () => {
    const line = receipt(false).split('\n').find((l) => l.includes('gemini'))!;
    expect(line).toContain('not installed');
  });
});
