import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Theme, toAscii, VERSION } from '@potsherd/core';
import { copyFixtureClaude, IDS, rmrf, tempDir } from './helpers.js';

/**
 * The two promises the terminal design system (plans/05) makes about *shape*
 * rather than content, checked against the shipped binary for every verb:
 *
 *   `--ascii` output contains no non-ASCII character. Not "mostly" — the flag
 *   exists so the output survives a terminal with no unicode font, and one
 *   stray `…` in a screenshot is the whole point missed. Before T1.7a `ls
 *   --ascii` emitted eleven of them, `stats --ascii` seven em dashes, and
 *   `doctor --ascii` all three glyphs at once.
 *
 *   No line is wider than the terminal. Counted in characters, because the
 *   design system uses multi-byte glyphs and a byte count would let `·` hide a
 *   column of overflow.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');

const ASCII_ONLY = /^[\x00-\x7F]*$/;
const created: string[] = [];

/** Characters, not UTF-16 code units: an emoji is one column, not two. */
function widthOf(line: string): number {
  return [...line].length;
}

interface RunResult { code: number; stdout: string; stderr: string }

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let claudeDir = '';
let potsherdDir = '';

/**
 * A corpus with unicode in it, because a corpus of pure ASCII would let a
 * broken `--ascii` pass. The title carries an em dash, a middle dot, an
 * accented letter and an emoji — one of each thing the fold has to handle.
 */
function writeUnicodeTranscript(dir: string): void {
  const sid = '99999999-9999-4999-8999-999999999999';
  const project = path.join(dir, 'projects', '-tmp-potsherd-unicode');
  fs.mkdirSync(project, { recursive: true });
  const common = {
    sessionId: sid,
    cwd: '/tmp/potsherd-unicode',
    version: '2.1.240',
    gitBranch: 'main',
    userType: 'external',
    entrypoint: 'cli',
    isSidechain: false,
  };
  const lines = [
    // A record type no parser consumes, with a name long enough to be worth
    // eliding — it is the D6 regression, and it must survive whole.
    JSON.stringify({ type: 'user:injected-continuation', sessionId: sid }),
    JSON.stringify({ type: 'user:injected-continuation', sessionId: sid }),
    JSON.stringify({
      ...common,
      type: 'user',
      uuid: 'un1',
      parentUuid: null,
      promptId: 'unp1',
      timestamp: '2026-08-06T09:00:05.000Z',
      message: { role: 'user', content: 'résumé — naïve · fiancé 🎉 pgbouncer' },
    }),
    JSON.stringify({
      ...common,
      type: 'assistant',
      uuid: 'un2',
      parentUuid: 'un1',
      requestId: 'unr1',
      timestamp: '2026-08-06T09:00:12.000Z',
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'café — ½ done ★ pgbouncer' }],
      },
    }),
  ];
  fs.writeFileSync(path.join(project, `${sid}.jsonl`), lines.join('\n') + '\n');
}

beforeAll(() => {
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
  claudeDir = copyFixtureClaude();
  created.push(path.dirname(claudeDir));
  writeUnicodeTranscript(claudeDir);
  potsherdDir = tempDir('potsherd-terminal-');
  created.push(potsherdDir);
  // Ghosts come from `rescue`, so run it: `find --ghosts only` on an index
  // that has none is a different (and separately reported) problem.
  run(['rescue', '--yes', '--no-settings', '--quiet', '--claude-dir', claudeDir, '--potsherd-dir', potsherdDir]);
  run(['index', '--full', '--no-embed', '--harness', 'claude', '--claude-dir', claudeDir, '--potsherd-dir', potsherdDir]);
});

afterAll(() => {
  while (created.length) rmrf(created.pop()!);
});

/** Every verb, in the form a person types it. */
function verbs(): { name: string; args: string[] }[] {
  return [
    { name: 'audit', args: ['audit'] },
    { name: 'doctor', args: ['doctor'] },
    { name: 'doctor --privacy', args: ['doctor', '--privacy'] },
    { name: 'index', args: ['index', '--no-embed', '--harness', 'claude'] },
    { name: 'stats', args: ['stats'] },
    { name: 'ls', args: ['ls'] },
    { name: 'ls --ghosts only', args: ['ls', '--ghosts', 'only'] },
    { name: 'find', args: ['find', 'pgbouncer'] },
    { name: 'find --ghosts only', args: ['find', 'canon', '--ghosts', 'only'] },
    { name: 'find (no match)', args: ['find', 'zzzznotinthecorpus'] },
    // The explain ledger is the widest thing `find` prints — six columns of
    // numbers per row — so it is the one most likely to overflow 60.
    { name: 'find --explain', args: ['find', 'pgbouncer', '--explain'] },
    { name: 'find --explain (no match)', args: ['find', 'zzzznotinthecorpus', '--explain'] },
    { name: 'show', args: ['show', IDS.alive] },
    { name: 'guard --status', args: ['guard', '--status'] },
    { name: 'rescue --dry-run', args: ['rescue', '--dry-run', '--yes', '--no-settings'] },
    // The nine verbs this list did not cover until phase 7. `stack` is the one
    // that matters most: it shipped in phase 6 as a module the command line
    // could not reach, and "every verb has --help" passed *because* it was not
    // a verb. A list of verbs written by hand can always be the list somebody
    // remembered; `describe('every verb is on this list')` below is what stops
    // that.
    { name: 'stack', args: ['stack'] },
    { name: 'card --dry-run', args: ['card', '--dry-run', '--all'] },
    { name: 'tag', args: ['tag', IDS.alive, '+pooler'] },
    { name: 'pin', args: ['pin', IDS.alive] },
    { name: 'unpin', args: ['unpin', IDS.alive] },
    { name: 'link', args: ['link', '--suggest'] },
    { name: 'setup --status', args: ['setup', '--status'] },
    // The BARE forms of the two verbs that write to a config file. A fresh
    // verifier found both overflowing and found why this list could not see it:
    // it is written per *argument form*, not per verb, so `guard --status` was
    // covered and `guard` — the verb `audit`'s own last line tells you to run
    // next — was not. That is the "list somebody remembered" failure the tour
    // test was written to end, in the file that wrote it.
    { name: 'guard', args: ['guard'] },
    { name: 'setup', args: ['setup'] },
    { name: 'export --to markdown', args: ['export', '--to', 'markdown', exportDir()] },
  ];
}

/** A throwaway directory for the one verb in the list that writes files. */
function exportDir(): string {
  const d = tempDir('potsherd-export-');
  created.push(d);
  return d;
}

function invoke(args: string[], extra: string[]): RunResult {
  return run([...args, ...extra, '--claude-dir', claudeDir, '--potsherd-dir', potsherdDir]);
}

describe('--ascii', () => {
  for (const v of verbs()) {
    it(`${v.name} emits no non-ASCII character`, () => {
      const r = invoke(v.args, ['--ascii', '--no-color', '--width', '80']);
      expect(ASCII_ONLY.test(r.stdout), `stdout of ${v.name}:\n${r.stdout}`).toBe(true);
      expect(ASCII_ONLY.test(r.stderr), `stderr of ${v.name}:\n${r.stderr}`).toBe(true);
    });
  }

  it('holds at 60 columns too, where more text has to be elided', () => {
    for (const v of verbs()) {
      const r = invoke(v.args, ['--ascii', '--no-color', '--width', '60']);
      expect(ASCII_ONLY.test(r.stdout + r.stderr), `${v.name}:\n${r.stdout}`).toBe(true);
    }
  });

  it('replaces the glyphs rather than dropping them, and never widens a line', () => {
    const t = new Theme({ color: false, ascii: true, width: 80 });
    expect(t.asciiLine('a … b · c — d → e ★ f ≤ g • h')).toBe('a . b . c - d > e * f < g * h');
    // Never longer, in characters: the fold runs after a line has been fitted.
    for (const s of ['résumé', 'naïve · café', '🎉 done', 'ばか', 'a b', '½']) {
      expect(widthOf(toAscii(s))).toBeLessThanOrEqual(widthOf(s));
      expect(ASCII_ONLY.test(toAscii(s))).toBe(true);
    }
    // A theme without --ascii is left exactly alone.
    expect(new Theme({ color: false, width: 80 }).asciiLine('a … b')).toBe('a … b');
  });
});

/**
 * `plans/05`, the terminal design system: *"every verb ends with the next verb.
 * audit -> rescue -> ls -> find -> ask -> graft. the tool teaches itself in the
 * last line of each output."*
 *
 * That rule had no guard, and one verb had quietly stopped obeying it: `find`
 * printed its next-verb line **only when it had no other footer note**, so the
 * moment a search turned up a ghost or a subagent hit -- the interesting case,
 * and the one worth screenshotting -- the teaching line was what got dropped to
 * make room. Both committed `find` screens end that way, and they were the only
 * two of fifteen with no next verb on them.
 *
 * The exceptions are named rather than pattern-matched, because "this screen is
 * allowed to end differently" is a decision, and a regex that happens to
 * tolerate a missing line is not one.
 */
/**
 * Every line of every verb fits the width it was given, at 80 and at 60.
 *
 * `describe('--ascii')` above has run over `verbs()` since phase 1, and the
 * width rule was only ever checked for `doctor` and `index` — the two that had
 * been caught overflowing. Widening `verbs()` in phase 7 from fifteen entries
 * to twenty-three immediately found a third: `setup --status` printed a
 * 79-character sentence unwrapped, so it overflowed every terminal narrower
 * than 80. A rule enforced for the two verbs that broke it is not a rule.
 */
/**
 * The test count, which four documents quote and three of them got wrong.
 *
 * `FINAL-REPORT.md` hands a reader `pnpm test  # 1,426` as the first thing to
 * try; the handoff said 1,428, the README said 1,426, and the suite had 1,427.
 * A fresh verifier found all three, and the shape of the mistake is the one
 * `plans/08` rule 1 is about: a number a user reads must be measured.
 *
 * This cannot assert the *true* count — a suite cannot count itself while
 * running — but it can refuse the failure that actually happened, which is four
 * documents disagreeing. One number, wherever it appears.
 */
describe('the test count the documents quote', () => {
  it('is the same number in every file that quotes one', () => {
    // Documents that describe the build AS IT IS. A signed-off phase record is
    // deliberately not here: `phases/phase-7/HANDOFF.md` says the suite held
    // 1,434 at `v1.0.0` and that remains true of `v1.0.0` forever. It was in
    // this list while every document happened to agree, which made the list
    // look right for the wrong reason — the moment phase 8 moved the live
    // count, a correct historical record became a "disagreement".
    //
    // The rule this encodes: a number in a phase handoff is a measurement with
    // a date on it; a number in the README is a claim about the current build.
    // Only the second kind has to agree with the first kind of anything else.
    const files = ['README.md', 'FINAL-REPORT.md', 'CHANGELOG.md', 'docs/08-STATE-OF-PLAY.md'];
    const found = new Map<string, Set<string>>();
    for (const f of files) {
      // A line that says `baseline` is quoting history — the handoff records
      // what the suite held when the phase *started* — and history is not a
      // claim about now.
      const text = fs
        .readFileSync(path.join(repo, f), 'utf-8')
        .split('\n')
        .filter((l) => !/baseline|was \d|previously/i.test(l))
        .join('\n');
      // `1,433 tests`, `1,433 green`, `1,433-test`, `pnpm test  # 1,433`
      const ns = new Set(
        [...text.matchAll(/\b(1,\d{3})(?=[\s-]?(?:tests?\b|green\b|$))/gm)].map(
          (m) => m[1] as string,
        ),
      );
      if (ns.size > 0) found.set(f, ns);
    }
    expect(found.size, 'no document quotes a test count at all').toBeGreaterThan(0);
    const all = new Set([...found.values()].flatMap((s2) => [...s2]));
    expect(
      [...all],
      `documents disagree: ${[...found].map(([f, n]) => `${f}=${[...n].join('/')}`).join(', ')}`,
    ).toHaveLength(1);
  });
});

describe('every verb fits the width it was given', () => {
  for (const width of [60, 80]) {
    it(`at ${width} columns`, () => {
      const over: string[] = [];
      for (const v of verbs()) {
        const r = invoke(v.args, ['--no-color', '--width', String(width)]);
        for (const line of r.stdout.split('\n')) {
          // A consent diff is shown whole or not at all. It is the literal text
          // about to be written into somebody's settings file, and a truncated
          // one misrepresents the thing they are being asked to approve — which
          // is a worse failure than a line that runs off the edge.
          const d = line.trimStart();
          if (
            /^[-+ ]?\s*[{}"]/.test(d) ||
            d.startsWith('@@') ||
            d.startsWith('---') ||
            d.startsWith('+++')
          ) {
            continue;
          }
          if (widthOf(line) > width) over.push(`${v.name}: ${widthOf(line)} — ${line}`);
        }
      }
      expect(over).toEqual([]);
    });
  }
});

describe('every verb ends with the next verb', () => {
  /** Screens whose last line is deliberately something else, and why. */
  const EXEMPT: Record<string, string> = {
    guard: 'ends by asking for consent, or by refusing for want of a terminal',
    setup: 'ends by naming the flag it needs; there is no next verb until it has one',
    'doctor --privacy': 'ends with the privacy receipt, which is the point of it',
    'find --explain': 'ends with the ledger it was asked for; the numbers are the output',
    'find --explain (no match)': 'falls through to the empty-result screen',
  };

  for (const v of verbs()) {
    it(`${v.name}${EXEMPT[v.name] ? ' — exempt' : ''}`, () => {
      const r = invoke(v.args, ['--no-color', '--width', '80']);
      const lines = r.stdout.split('\n').filter((l) => l.trim() !== '');
      const last = lines.at(-1) ?? '';
      if (EXEMPT[v.name]) {
        // An exempt screen still has to say *something*; `setup` with no client
        // says it on stderr, because it is an error.
        expect(
          (r.stdout + r.stderr).trim().length,
          `${v.name} printed nothing at all`,
        ).toBeGreaterThan(0);
        return;
      }
      // Anchored on `run  potsherd <verb>` rather than the start of the line:
      // `rescue --dry-run` ends `nothing was written. run  potsherd rescue  to
      // do it for real.`, which is the rule obeyed with a preamble, not broken.
      expect(last, `${v.name} last line:\n${r.stdout}`).toMatch(/run\s{2}potsherd \w/);
    });
  }
});

describe('terminal width', () => {
  /**
   * `doctor` overflowed `--width 60` by exactly one character on every `known`
   * record-type row: three spaces after the count where two fit. One character
   * is enough to wrap every row of a card in a screenshot.
   */
  for (const width of [60, 80]) {
    it(`doctor fits --width ${width}`, () => {
      for (const ascii of [[], ['--ascii']]) {
        const r = invoke(['doctor'], [...ascii, '--no-color', '--width', String(width)]);
        const over = r.stdout.split('\n').filter((l) => widthOf(l) > width);
        expect(over, `overflowing lines at ${width}${ascii.length ? ' --ascii' : ''}`).toEqual([]);
      }
    });

    it(`index fits --width ${width}`, () => {
      for (const ascii of [[], ['--ascii']]) {
        const r = invoke(
          ['index', '--no-embed', '--harness', 'claude'],
          [...ascii, '--no-color', '--width', String(width)],
        );
        const over = r.stdout.split('\n').filter((l) => widthOf(l) > width);
        expect(over, `overflowing lines at ${width}`).toEqual([]);
      }
    });

    /**
     * `find --explain` prints a six-column ledger — list, rank, raw score,
     * weight, contribution, share — which is the widest thing any verb emits.
     * At 60 columns the raw column has to go rather than the line wrapping, so
     * this is the assertion that keeps that decision honest.
     */
    it(`find --explain fits --width ${width}`, () => {
      for (const ascii of [[], ['--ascii']]) {
        const r = invoke(
          ['find', 'pgbouncer', '--explain'],
          [...ascii, '--no-color', '--width', String(width)],
        );
        const over = r.stdout.split('\n').filter((l) => widthOf(l) > width);
        expect(over, `overflowing lines at ${width}`).toEqual([]);
      }
    });
  }
});

describe('doctor keeps the record type name', () => {
  /**
   * `cursor user:injected-continua…` sends a reader nowhere. The name is the
   * one field that identifies what the parser skipped, so the version column
   * gives ground instead, and at any width the name is printed whole.
   */
  for (const width of [60, 80]) {
    it(`prints the whole name at --width ${width}`, () => {
      const r = invoke(['doctor'], ['--no-color', '--width', String(width)]);
      expect(r.stdout).toContain('claude user:injected-continuation');
      expect(r.stdout).not.toContain('user:injected-continua…');
    });
  }
});

describe('find --json', () => {
  /**
   * The shape is an object, not an array: it carries `vectors` (whether the
   * embedding index was consulted, and why not when it was not) and `ms`,
   * which a bare array of sessions cannot. `plans/phases/phase-1-foundation.md`
   * documents `jq '.[0].session'` and is the thing that needs correcting.
   */
  it('is an object with .sessions, not a bare array', () => {
    const r = invoke(['find', 'pgbouncer'], ['--json']);
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Array.isArray(j)).toBe(false);
    expect(Array.isArray(j['sessions'])).toBe(true);
    expect(j).toHaveProperty('vectors');
    expect(j).toHaveProperty('ms');
  });
});

/**
 * D2: a run reports what the run did; the index reports what the index holds.
 *
 * The receipt used to print `secrets masked 0 · nothing matched — index holds
 * no secrets` after an incremental pass that re-read one file, on an index
 * that held three masks. Both halves were wrong: the count was the run's and
 * the sentence was about the index.
 */
describe('index reports the run, not the index', () => {
  const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'; // AWS's own published example key
  const SESSION = 'dddd1111-0000-4000-8000-00000000000d';

  const CLEAN = 'dddd1111-0000-4000-8000-00000000000e';

  /**
   * Two sessions: one whose prompt carries an aws key, one that carries
   * nothing. The clean one is the file the incremental pass re-reads, so the
   * run genuinely masks nothing while the index genuinely holds a mask —
   * which is the exact situation the old wording lied about.
   */
  function corpus(): { claude: string; pot: string; file: string } {
    const base = tempDir('potsherd-honesty-');
    created.push(base);
    const claude = path.join(base, 'claude');
    const dir = path.join(claude, 'projects', '-tmp-potsherd-honesty');
    fs.mkdirSync(dir, { recursive: true });
    const write = (id: string, rows: Record<string, unknown>[]): string => {
      const file = path.join(dir, `${id}.jsonl`);
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return file;
    };
    const b = (id: string) => ({ sessionId: id, cwd: '/tmp/potsherd-honesty', version: '2.1.237', gitBranch: 'main' });
    write(SESSION, [
      { ...b(SESSION), type: 'user', promptId: 'p1', uuid: 'u1', timestamp: '2026-08-19T09:00:00.000Z', message: { role: 'user', content: `deploy with ${AWS_KEY} please` } },
      { ...b(SESSION), type: 'assistant', uuid: 'a1', timestamp: '2026-08-19T09:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done.' }] } },
    ]);
    const file = write(CLEAN, [
      { ...b(CLEAN), type: 'user', promptId: 'p1', uuid: 'c1', timestamp: '2026-08-19T10:00:00.000Z', message: { role: 'user', content: 'nothing sensitive in this one' } },
      { ...b(CLEAN), type: 'assistant', uuid: 'c2', timestamp: '2026-08-19T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'agreed.' }] } },
    ]);
    return { claude, pot: path.join(base, 'potsherd'), file };
  }

  it('never claims the index holds no secrets on the strength of one pass', () => {
    const c = corpus();
    const args = ['--no-embed', '--harness', 'claude', '--no-color', '--width', '80',
      '--claude-dir', c.claude, '--potsherd-dir', c.pot];
    const first = run(['index', '--full', ...args]);
    expect(first.stdout).toContain('masked this run');
    expect(first.stdout).toMatch(/masked this run\s+1\s/);

    fs.appendFileSync(
      c.file,
      JSON.stringify({ sessionId: CLEAN, cwd: '/tmp/potsherd-honesty', version: '2.1.237', type: 'user', promptId: 'p2', uuid: 'c3', timestamp: '2026-08-19T10:02:00.000Z', message: { role: 'user', content: 'nothing secret here either' } }) + '\n',
    );
    const second = run(['index', ...args]);
    expect(second.stdout).toContain('1 parsed');
    expect(second.stdout).toContain('1 unchanged');
    // The run masked nothing, and says exactly that.
    expect(second.stdout).toContain('nothing matched in what was re-read');
    // It never speaks for the index.
    expect(second.stdout).not.toContain('index holds no secrets');

    // And `doctor`, which does speak for the index, still counts the mask.
    const doc = run(['doctor', '--no-color', '--width', '80', '--claude-dir', c.claude, '--potsherd-dir', c.pot]);
    expect(doc.stdout).toMatch(/secrets masked\s+1\s/);
  });

  it('says where ghosts come from rather than printing a bare zero', () => {
    const c = corpus();
    const r = run(['index', '--full', '--no-embed', '--harness', 'claude', '--no-color',
      '--width', '80', '--claude-dir', c.claude, '--potsherd-dir', c.pot]);
    expect(r.stdout).toContain('ghosts indexed');
    expect(r.stdout).toContain('run potsherd rescue');
  });
});

/**
 * The version a user reads must be true.
 *
 * `packages/core/src/version.ts` said the product had "exactly one literal now
 * and a test that pins it to the manifest npm actually publishes". The literal
 * was real; the test was not, and nobody had written it. So the tag went to
 * v0.3.0 and then v0.4.0 while `potsherd --version` went on printing `0.2.0` —
 * the number a user quotes in a bug report, disagreeing with the number `npm
 * install potsherd@0.4.0` would have put on their disk.
 *
 * This is `plans/08` rule 1 in its smallest form: a number a user reads must
 * be measured, or labelled `est.`. A version is a fact about the artefact, not
 * an estimate, so there is no reading of this where it is merely cosmetic.
 *
 * Four things have to agree, and the test names all four rather than checking
 * a pair, because the last drift was between the pair nobody was checking: the
 * shipped binary's `--version` output, `VERSION` in core, and the two package
 * manifests. `doctor`'s heading prints the same string and is checked with
 * them, since that is where a pasted bug report usually gets its number.
 */
describe('the version a user reads', () => {
  const manifest = (rel: string): { version: string } =>
    JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf-8')) as { version: string };

  it('is the same string in core, in both manifests, and out of the binary', () => {
    // The manifest npm publishes is the one a user installs, so it is the
    // authority the other three are checked against.
    const cli = manifest('packages/cli/package.json').version;
    expect(manifest('packages/core/package.json').version).toBe(cli);
    expect(VERSION).toBe(cli);

    expect(run(['--version']).stdout.trim()).toBe(cli);

    const doc = run(['doctor', '--no-color', '--width', '80',
      '--claude-dir', claudeDir, '--potsherd-dir', potsherdDir]);
    expect(doc.stdout).toContain(`potsherd ${cli}`);
  });

  it('is a plain semver triple, so it can be compared with a git tag', () => {
    // `0.2.0` was still being printed at tag `v0.4.0`. Nothing in the suite can
    // reach the tag list of the repository a user cloned, but it can insist the
    // string is the shape a tag is made from, so that comparing the two is a
    // one-line check rather than a parse.
    expect(manifest('packages/cli/package.json').version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * The four-way check above was still not wide enough. At tag `v0.7.0` the
   * binary printed `0.4.0`: the four things it names agreed with each other
   * perfectly, and all four were three releases stale, because nothing joined
   * them to the tag. Two more surfaces were never in it at all — the plugin
   * manifest a marketplace listing shows, and the marketplace entry itself,
   * which said `0.5.0` for two phases after phase 5.
   *
   * So: every manifest in the repository that carries a potsherd version is
   * enumerated here rather than listed, and the git tag is checked when a git
   * checkout is what the test is running inside. A published tarball has no
   * `.git`, and a shallow clone reaches no tag from HEAD; both skip loudly —
   * visibly, as a skip and not as a pass — rather than assert something the
   * environment, not the test, established (`09 §7.2`).
   */
  it('is the same string in every manifest that carries one', () => {
    const cli = manifest('packages/cli/package.json').version;
    const carriers: [string, (o: Record<string, unknown>) => unknown][] = [
      ['packages/core/package.json', (o) => o['version']],
      ['packages/cli/package.json', (o) => o['version']],
      ['packages/mcp/package.json', (o) => o['version']],
      ['packages/bridges/package.json', (o) => o['version']],
      ['plugins/claude-code/.claude-plugin/plugin.json', (o) => o['version']],
      ['plugins/claude-code/package.json', (o) => o['version']],
      ['plugins/codex/.codex-plugin/plugin.json', (o) => o['version']],
      [
        '.claude-plugin/marketplace.json',
        (o) => (o['plugins'] as { version: string }[])[0]?.version,
      ],
    ];
    for (const [rel, pick] of carriers) {
      const json = JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(pick(json), `${rel} carries a stale version`).toBe(cli);
    }
  });

  /**
   * **The premise is the tags this repository actually released** — `09` rule 7,
   * and this one was a landmine on the tag rather than a flake.
   *
   * This used to read `git tag --list 'v[0-9]*'`, which counts every tag the
   * checkout happens to hold. potsherd has a second remote by design —
   * `upstream-episodic` → `github.com/obra/episodic-memory`, kept for the
   * NOTICE — and a fetch of it landed **that** project's tags under plain `v*`
   * names beside the `upstream-v*` copies that were the intended form. So
   * `v1.0.1` … `v1.4.2` sat in the checkout, none of them potsherd's, and this
   * assertion read `VERSION is 1.2.0 but this checkout already has tag v1.4.2`
   * and went red on a release that had not happened.
   *
   * Deleting them fixed that afternoon. The remote is still there and will be
   * fetched again, so the premise is scoped instead: **`--merged HEAD`**, which
   * is every tag whose commit is an ancestor of what is checked out. A foreign
   * project's release is not in potsherd's history and cannot be, so it cannot
   * be counted here however it got into `.git`. It needs no network, which
   * `git ls-remote origin --tags` would have.
   *
   * (The worse half of the same story is why this is worth a paragraph:
   * `v1.2.0` — the version in every manifest above — was one of the names
   * taken, so `git tag v1.2.0` would have failed at release time, and forcing
   * it would have pointed the publish workflow's tag/manifest agreement check
   * at another project's `packages/cli/package.json`.)
   *
   * The three escapes it already had are kept and are now what they claimed to
   * be. A published tarball has no `.git`, a machine may have no `git`, and a
   * shallow clone reaches no tag from HEAD; none of the three is a finding
   * about potsherd, so none of them asserts anything. What changed is that they
   * **skip** instead of returning — vitest reports a bare `return` as a pass —
   * and that on CI, where the checkout is the workflow's own choice rather than
   * the environment's, a missing premise fails. See the block inside the test.
   */
  it('is not behind the newest git tag this repository released', (ctx) => {
    // **VERIFICATION-5 C-10.** The three escapes below were bare `return`s, and
    // vitest reports a bare `return` as a **pass**. Simulated with a `git` shim
    // that answers `git tag` with nothing:
    //
    //   ✓ the version a user reads > is not behind the newest git tag …
    //    Tests  1 passed | 69 skipped (70)
    //
    // — a green tick on an assertion that was never evaluated, which is rule 4
    // ("a benchmark that cannot fail is worse than no benchmark") on the one
    // assertion that exists because at tag `v0.7.0` the binary printed `0.4.0`.
    //
    // And it was **CI's state on every run**: `actions/checkout@v4` at
    // `.github/workflows/ci.yml:24` had no `fetch-depth` and no `fetch-tags`.
    // Measured against this repository over `file://`, which is the same fetch
    // machinery a runner uses:
    //
    //   fetch-depth  fetch-tags   v-tags   --merged HEAD   .git    fetch
    //   1 (default)  false            0               0   3.5M    0.52s
    //   1            true             0               0   3.5M    0.50s
    //   0            false            0               0   5.9M    2.07s
    //   0            true             9               9   5.9M    1.48s
    //
    // So `fetch-tags: true` alone buys **nothing**: `--depth 1` fetches only
    // tags that point into the history it fetched, and this test asks
    // `--merged HEAD`, which a depth-1 HEAD can never answer. Both knobs are
    // needed, and the workflow now sets both.
    //
    // Which is why the escape is not symmetric. Off CI a missing premise really
    // is the environment — a packed tarball has no `.git`, a contributor's
    // shallow clone has no reachable tag — and the honest report is a visible
    // **skip** with the reason printed. On CI the premise is not the
    // environment's to withhold: the workflow decides what it checks out, so a
    // missing premise there is a workflow regression and fails as one. That is
    // what stops this from silently going back to a green tick meaning
    // "not run".
    const absent = ((): string | null => {
      if (!fs.existsSync(path.join(repo, '.git'))) {
        return 'no .git here — this is a packed tarball, which has no tags to be behind';
      }
      try {
        execFileSync('git', ['--version'], { cwd: repo, encoding: 'utf8' });
      } catch {
        return 'no git binary on PATH';
      }
      return null;
    })();
    let tags: string[] = [];
    if (absent === null) {
      tags = execFileSync('git', ['tag', '--list', 'v[0-9]*', '--merged', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      })
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean);
    }
    const missing =
      absent ??
      (tags.length === 0
        ? 'no v* tag is reachable from HEAD — a shallow clone, or a commit older than every release'
        : null);
    if (missing !== null) {
      if (process.env['CI']) {
        expect.fail(
          `${missing}. On CI that is a workflow regression, not an environment: ` +
            '.github/workflows/ci.yml must check out with BOTH fetch-depth: 0 and ' +
            'fetch-tags: true. A depth-1 checkout reaches no tag from HEAD even with ' +
            'fetch-tags, so `git tag --merged HEAD` comes back empty and this assertion ' +
            'is never evaluated — which is exactly the green-that-means-not-run this ' +
            'test was found guilty of.',
        );
      }
      // Printed before the skip, not instead of it: `09 §7.2` asks for a loud
      // skip, and a skip nobody can see the reason for is half a report.
      console.log(`  SKIPPED — ${missing}`);
      ctx.skip();
      return;
    }

    const parse = (s: string): [number, number, number] => {
      const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
    };
    const cmp = (a: [number, number, number], b: [number, number, number]): number =>
      a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

    const newest = tags.map(parse).sort(cmp).at(-1) as [number, number, number];
    const here = parse(VERSION);
    expect(
      cmp(here, newest),
      `VERSION is ${VERSION} but this repository already released v${newest.join('.')}`,
    ).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------- C-2 / C-3

/**
 * `run`, in a named time zone — the thing this file could not do.
 *
 * VERIFICATION-6 C-2 existed **because nothing in the repository could see
 * it**: `scripts/make-screens.sh` and the CI screens step both pin `TZ=UTC`,
 * and UTC is the one zone in which both ends of a date filter render
 * correctly. The pin is right — a published artefact must not encode which
 * country its last regenerator was sitting in — so the answer is not to
 * unpin it, it is to have one test that deliberately stands somewhere else.
 */
function runIn(zone: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', TZ: zone },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * Four zones, and the two that matter are on opposite sides of UTC.
 *
 * `Asia/Kolkata` is UTC+05:30 and moved the `--until` receipt forward a day;
 * `America/Los_Angeles` is UTC-07/-08 and moved the `--since` receipt back
 * one. `Pacific/Auckland` is the far east of the line and is here because a
 * whole-day offset from UTC is the case a half-hour offset does not cover.
 */
const ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland'] as const;

describe('the receipt of a date filter is what the user typed', () => {
  /** The four headlines, one per zone, from one command typed one way. */
  function headlines(): Map<string, string> {
    const out = new Map<string, string>();
    for (const zone of ZONES) {
      const r = runIn(zone, [
        'ls',
        '--since', '2026-08-01',
        '--until', '2026-08-02',
        '--limit', '1',
        '--no-color',
        '--width', '100',
        '--claude-dir', claudeDir,
        '--potsherd-dir', potsherdDir,
      ]);
      out.set(zone, r.stdout.split('\n')[0] ?? '');
    }
    return out;
  }

  /**
   * THE ZONE TEST. This is the assertion the repository did not have.
   *
   * Same command, same index, same rows — the receipt of the user's own input
   * moved by a day east of UTC on `--until` and west of it on `--since`,
   * because the bound was stored as an instant and re-rendered with
   * `getDate()`/`getMonth()`. Under `TZ=UTC`, the zone both the screens script
   * and the CI screens step pin, it is the one setting where neither end
   * moves, so nothing in the repository could see it.
   */
  it('does not move with the reader\'s zone', () => {
    const seen = headlines();
    expect(
      new Set(seen.values()).size,
      [...seen].map(([z, h]) => `TZ=${z}  ${h}`).join('\n'),
    ).toBe(1);
  });

  it('quotes --since and --until back exactly as they were typed', () => {
    for (const [zone, headline] of headlines()) {
      // The bound the user typed, echoed. Not a re-rendering of the instant it
      // was parsed into: that instant is `2026-08-02T23:59:59.999Z`, and read
      // back with local-time getters east of UTC it is the third of August.
      expect(headline, `TZ=${zone}`).toContain('since 2026-08-01');
      expect(headline, `TZ=${zone}`).toContain('until 2026-08-02');
    }
  });

  it('the rows the filter selects do not move with the zone either', () => {
    const bodies = new Set<string>();
    for (const zone of ZONES) {
      const r = runIn(zone, [
        'ls',
        '--since', '2026-08-01',
        '--until', '2026-08-02',
        '--json',
        '--claude-dir', claudeDir,
        '--potsherd-dir', potsherdDir,
      ]);
      const j = JSON.parse(r.stdout) as { filters: Record<string, string>; total: number };
      bodies.add(JSON.stringify([j.filters['since'], j.filters['until'], j.total]));
    }
    // `--json` was always right; it is the control that proves the defect was
    // in the receipt and not in the filter.
    expect([...bodies]).toHaveLength(1);
  });
});

/**
 * C-3 — the score column is the order the page is in, or it is not printed.
 *
 * The page is sorted by `byLabel` (`recall.ts`): lane, then the confidence
 * word, then `calibration.score`. The number in the right-hand column was the
 * fused RRF score, which is none of those, so the column ran backwards under a
 * `strong` header — as a caption-free screenshot, a broken sort.
 *
 * The corpus is written here rather than borrowed, because the defect needs a
 * shape the shared fixture does not have: a session whose **body** answers the
 * query, and a subagent whose **title** answers it and whose body does not.
 * RRF ranks the second above the first; calibration ranks it below. That is the
 * disagreement, and it is the whole of C-3.
 */
describe('the score column is the order the page is in', () => {
  const RANK: Record<string, number> = { strong: 0, weak: 1, none: 2 };
  const PARENT = '11110000-0000-4000-8000-000000000001';
  const OTHER = '11110000-0000-4000-8000-000000000002';
  let c3Claude = '';
  let c3Root = '';

  function transcript(
    file: string,
    sid: string,
    pairs: [string, string][],
    extra: Record<string, unknown> = {},
  ): void {
    const base = {
      sessionId: sid,
      cwd: '/tmp/potsherd-c3',
      version: '2.1.237',
      gitBranch: 'main',
      ...extra,
    };
    const rows: unknown[] = [];
    pairs.forEach(([u, a], i) => {
      const ts = `2026-08-${String(10 + i).padStart(2, '0')}T0${(i % 9) + 1}:00:00.000Z`;
      rows.push({ ...base, type: 'user', promptId: `p${i}`, uuid: `${sid.slice(0, 8)}-u${i}`, timestamp: ts, message: { role: 'user', content: u } });
      rows.push({ ...base, type: 'assistant', uuid: `${sid.slice(0, 8)}-a${i}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: a }] } });
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  beforeAll(() => {
    const base = tempDir('potsherd-c3-');
    created.push(base);
    c3Claude = path.join(base, 'claude');
    c3Root = path.join(base, 'potsherd');
    const project = path.join(c3Claude, 'projects', '-tmp-potsherd-c3');

    transcript(path.join(project, `${PARENT}.jsonl`), PARENT, [
      ['the postgres connection pool saturates when the ingest workers spin up', 'Raising default_pool_size on the postgres connection pool.'],
      ['does the postgres connection pool recycle in transaction mode', 'Yes — the postgres connection pool returns a connection at statement end.'],
      ['what did the postgres connection pool do under load', 'The postgres connection pool queued and then timed out.'],
    ]);
    transcript(path.join(project, `${OTHER}.jsonl`), OTHER, [
      ['the connection pool in postgres is leaking handles on retry', 'The connection pool leaks a postgres handle on every retry path.'],
      ['show me the postgres connection pool metrics', 'postgres connection pool: 60 in use, 4 idle.'],
    ]);
    const titles = [
      'write the migration for the postgres connection pool',
      'review the postgres connection pool for race conditions',
      'what is the blast radius of changing the postgres connection pool',
    ];
    titles.forEach((title, i) => {
      transcript(
        path.join(project, PARENT, 'subagents', `agent-${i}.jsonl`),
        `2222000${i}-0000-4000-8000-00000000000${i}`,
        [[title, 'Done. Nothing else to add here.']],
        { isSidechain: true, agentName: 'code-reviewer' },
      );
    });
    run(['index', '--full', '--no-embed', '--harness', 'claude', '--claude-dir', c3Claude, '--potsherd-dir', c3Root]);
  });

  function column(stdout: string): { word: string; n: number }[] {
    const out: { word: string; n: number }[] = [];
    for (const line of stdout.split('\n')) {
      const m = /\s(strong|weak|none)\s\s(\d\.\d{4})\s*$/.exec(line);
      if (m) out.push({ word: m[1] as string, n: Number(m[2]) });
    }
    return out;
  }

  it('never runs backwards, and never contradicts the word beside it', () => {
    const r = run([
      'find', 'postgres connection pool',
      '--min-confidence', 'none',
      '--no-color', '--width', '100',
      '--claude-dir', c3Claude, '--potsherd-dir', c3Root,
    ]);
    const rows = column(r.stdout);
    expect(rows.length, `no score column found in:\n${r.stdout}`).toBeGreaterThan(1);
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1]!;
      const here = rows[i]!;
      expect(
        here.n,
        `row ${i} prints ${here.n} under row ${i - 1}'s ${prev.n}:\n${r.stdout}`,
      ).toBeLessThanOrEqual(prev.n);
      // And the word is a band cut from that same number, so a weaker row can
      // never print a number a stronger row on the same page does not beat.
      if (RANK[here.word]! > RANK[prev.word]!) {
        expect(
          here.n,
          `${here.word} ${here.n} sits under ${prev.word} ${prev.n}:\n${r.stdout}`,
        ).toBeLessThan(prev.n);
      }
    }
  });
});
