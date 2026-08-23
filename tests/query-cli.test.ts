import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexAll, rescue, stripAnsi } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * `find`, `ls`, `show` and `stats` through the shipped binary.
 *
 * Two things only the binary can be held to, and both are acceptance criteria
 * rather than niceties:
 *
 *   **width.** Every line of every verb must fit 80 columns and stay legible at
 *   60. The design system uses multi-byte glyphs (`·` `→` `…` `★`), so this is
 *   counted in *characters* — a byte count would pass a line that wraps.
 *
 *   **`--json` carries the same data as the human view.** Not similar data: the
 *   same. A plugin, the MCP server and a shell pipeline all read the JSON, and
 *   a field that only exists in the rendering is a field they cannot have.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');
const FIXTURE = path.join(repo, 'evals', 'fixture', 'claude');

let root: string;
const dirs: string[] = [];

interface RunResult { code: number; stdout: string; stderr: string }

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [bin, ...args, '--potsherd-dir', root], {
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

/** The widest line, counted in characters after ANSI is stripped. */
function widest(text: string): { width: number; line: string } {
  let width = 0;
  let line = '';
  for (const raw of text.split('\n')) {
    const n = [...stripAnsi(raw)].length;
    if (n > width) {
      width = n;
      line = raw;
    }
  }
  return { width, line };
}

beforeAll(async () => {
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
  root = tempDir('potsherd-query-cli-');
  dirs.push(root);
  await rescue({ claudeDir: FIXTURE, root, ghostsOnly: true, quiet: true });
  await indexAll({ root, claudeDir: FIXTURE, harnesses: ['claude'], embed: false, full: true });
}, 120_000);

afterAll(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

const VERBS: [string, string[]][] = [
  ['ls', ['ls']],
  ['ls --ghosts only', ['ls', '--ghosts', 'only']],
  ['ls --sidechains only', ['ls', '--sidechains', 'only']],
  ['find', ['find', 'pgbouncer transaction pooling']],
  // A query whose best evidence is on the assistant side of a session whose
  // prompts are pasted-screenshot placeholders.
  ['find over boilerplate', ['find', 'pay button spinner']],
  ['find --ghosts only', ['find', 'brother laser printer', '--ghosts', 'only']],
  ['stats', ['stats']],
  ['show', ['show', '0a2fbf9b']],
  ['show a ghost', ['show', 'e6aa5ba7']],
];

describe('width: every verb fits the terminal it was designed for', () => {
  for (const [name, args] of VERBS) {
    it(`${name} fits 80 columns`, () => {
      const r = run([...args, '--width', '80']);
      expect(r.code === 0 || r.code === 1).toBe(true);
      const { width, line } = widest(r.stdout);
      expect(width, `widest line (${width}): ${line}`).toBeLessThanOrEqual(80);
    });

    it(`${name} fits 60 columns`, () => {
      const r = run([...args, '--width', '60']);
      const { width, line } = widest(r.stdout);
      expect(width, `widest line (${width}): ${line}`).toBeLessThanOrEqual(60);
    });
  }
});

describe('ls', () => {
  it('shows titles rather than uuids', () => {
    const r = run(['ls', '--width', '80', '--project', '/tmp/potsherd-eval-api']);
    expect(r.stdout).toContain('Pin the pgbouncer');
    expect(r.stdout).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  it('fits an 80x24 screenshot by default', () => {
    const r = run(['ls', '--width', '80']);
    expect(r.stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(24);
  });

  it('marks the deleted sessions and says what is left of them', () => {
    const r = run(['ls', '--ghosts', 'only', '--width', '80']);
    expect(r.stdout).toContain('ghost');
    expect(r.stdout).toContain('prompts only');
  });

  it('--json carries every column the table shows, and the id it does not', () => {
    const j = JSON.parse(run(['ls', '--json']).stdout) as {
      total: number;
      ghosts: number;
      rolledUp: number;
      sessions: Record<string, unknown>[];
    };
    expect(j.ghosts).toBe(12);
    expect(j.rolledUp).toBe(6);
    const first = j.sessions[0]!;
    for (const key of ['id', 'harness', 'project', 'displayTitle', 'status', 'isSidechain', 'resume']) {
      expect(Object.keys(first)).toContain(key);
    }
  });

  it('rejects a filter value it does not have, and names the ones it does', () => {
    const r = run(['ls', '--ghosts', 'maybe']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/include|only|exclude/);
  });
});

describe('find', () => {
  it('prints the resume command for the harness', () => {
    const r = run(['find', 'pgbouncer transaction pooling', '--width', '80']);
    expect(r.stdout).toMatch(/claude --resume [0-9a-f-]{36}/);
  });

  it('states the limitation on a ghost hit rather than offering a dead command', () => {
    const r = run(['find', 'brother laser printer', '--width', '80']);
    expect(r.stdout).toContain('assistant side not recoverable');
    expect(r.stdout).toContain('ghost');
  });

  it('finds a subagent transcript by default', () => {
    const j = JSON.parse(run(['find', 'tree shaking icon set', '--json']).stdout) as {
      sessions: { isSidechain: boolean }[];
    };
    expect(j.sessions.some((s) => s.isSidechain)).toBe(true);
  });

  it('--sidechains exclude turns that off again', () => {
    const j = JSON.parse(
      run(['find', 'tree shaking icon set', '--sidechains', 'exclude', '--json']).stdout,
    ) as { sessions: { isSidechain: boolean }[] };
    expect(j.sessions.every((s) => !s.isSidechain)).toBe(true);
  });

  it('exits non-zero and suggests a verb when nothing matches', () => {
    const r = run(['find', 'zzzznothinghere', '--width', '80']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('potsherd ls');
  });

  it('--json carries the score, the lists and the snippet the human view showed', () => {
    const j = JSON.parse(run(['find', 'pgbouncer transaction pooling', '--json']).stdout) as {
      vectors: { used: boolean; reason?: string };
      lists: { list: string }[];
      sessions: { score: number; resume: string | null; hits: { snippet: string }[] }[];
    };
    expect(j.lists.map((l) => l.list)).toContain('exchanges_fts');
    expect(j.sessions[0]!.score).toBeGreaterThan(0);
    expect(j.sessions[0]!.resume).toMatch(/^claude --resume /);
    expect(j.sessions[0]!.hits[0]!.snippet.length).toBeGreaterThan(0);
    // No embeddings in this index, so the verb must say why it is text-only.
    expect(j.vectors.used).toBe(false);
    expect(j.vectors.reason).toBeTruthy();
  });

  /**
   * T10.1 — the same three words on the screen and in the pipe.
   *
   * `05`'s contract is `--json` on everything, *identical data to the human
   * view*. For confidence that is not a nicety: an agent reads the JSON, a
   * person reads the terminal, and the entire value of the label is that the
   * two of them are looking at one fact. This runs the shipped binary twice
   * on one query and compares what each printed.
   */
  it('--json and the human view carry identical confidence, row for row', () => {
    const q = 'pgbouncer transaction pooling';
    const j = JSON.parse(run(['find', q, '--json']).stdout) as {
      confidence: string;
      minConfidence: string;
      withheld: number;
      sessions: {
        score: number;
        confidence: string;
        calibrated: number;
        coverage: number;
        hits: { confidence: string; calibrated: number }[];
      }[];
    };
    const human = run(['find', q, '--width', '80']).stdout;
    expect(j.sessions.length).toBeGreaterThan(0);
    expect(j.confidence).toBe('strong');
    // The floor `find` runs at, on the record, so a consumer knows whether it
    // is looking at a filtered page or an unfiltered one.
    expect(j.minConfidence).toBe('weak');
    expect(human.split('\n')[0]).toContain(j.confidence);
    for (const s of j.sessions) {
      const meta = human.split('\n').find((l) => l.includes(s.score.toFixed(4)));
      expect(meta, `no meta line for a session scored ${s.score}`).toBeDefined();
      expect(meta!).toContain(s.confidence);
      // 0..1, and a real number rather than a copy of the fused score, which
      // on this row is ~0.018.
      expect(s.calibrated).toBeGreaterThan(0);
      expect(s.calibrated).toBeLessThanOrEqual(1);
      expect(s.calibrated).not.toBeCloseTo(s.score, 3);
      expect(s.coverage).toBeGreaterThan(0);
      for (const h of s.hits) expect(['strong', 'weak', 'none']).toContain(h.confidence);
    }
  });

  it('an absent topic is an honest empty in both views, and exits 1', () => {
    // Every word of this is somewhere in the corpus; no conversation in it is
    // about the topic. Before T10.1 this returned confident-looking rows whose
    // top score was inside 12% of a true phrase hit on the reference archive.
    const q = 'kubernetes ingress payment service';
    const r = run(['find', q, '--width', '80']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('no match');
    expect(r.stdout).toContain('nothing in the index answers');
    expect(r.stdout).toContain('--min-confidence none');
    // The last line names the next verb, and after an honest empty the next
    // verb is a narrower search.
    expect(r.stdout.trimEnd().split('\n').at(-1)).toContain('potsherd find');

    const j = JSON.parse(run(['find', q, '--json']).stdout) as {
      confidence: string;
      withheld: number;
      sessions: unknown[];
    };
    expect(j.sessions).toEqual([]);
    expect(j.confidence).toBe('none');
    // The count is the difference between "nothing matched" and "things
    // matched and none of them well enough", which are different facts.
    expect(j.withheld).toBeGreaterThan(0);
  });

  /**
   * **T3.6.** A block is a conversation, so a hit under it can belong to the
   * session in the heading *or* to a subagent it spawned. The human view marks
   * the difference; without `sessionId` on the hit `--json` could not, and a
   * consumer had no way to tell which session actually matched.
   */
  it('--json says which session each hit belongs to', () => {
    const j = JSON.parse(run(['find', 'the', '--json', '--limit', '20']).stdout) as {
      sessions: { id: string; hits: { sessionId: string; isSidechain: boolean }[] }[];
    };
    for (const s of j.sessions) {
      for (const h of s.hits) expect(typeof h.sessionId).toBe('string');
    }
    // …and it is a real distinction, not a field that always echoes the block.
    const clustered = j.sessions.filter((s) => s.hits.some((h) => h.sessionId !== s.id));
    expect(clustered.length).toBeGreaterThan(0);
    expect(
      clustered.some((s) => s.hits.some((h) => h.sessionId !== s.id && h.isSidechain)),
    ).toBe(true);
  });

  it('shows the matched word rather than a pasted-screenshot placeholder', () => {
    // The T1.7 review's sharpest complaint: a top-three result whose only
    // snippet was `[Image: source: /var/folders/…/clipboard-…]`, so nothing on
    // the screen said why that result was there.
    //
    // Held over the WHOLE of stdout, which is where it started and where it
    // belongs. W8 narrowed it to the snippet lines for one release-candidate
    // hour, and said so: 8.2 made a session heading a *prompt*, and
    // `rescue.ts`'s stopping rule — not a slash command, at least eight
    // characters, not a stopword — admitted
    // `[Image: source: …/clipboard-….png]`, so the one eval-corpus session
    // whose prompts are all paste placeholders became headed by one. Narrowing
    // was the honest holding action; it was not the fix.
    //
    // The fix was to compose `isMostlyBoilerplate` — which this same file's
    // complaint produced, and which `find` already uses to refuse a
    // placeholder as a SNIPPET — into the title CANDIDATE filter. A string too
    // empty to quote as evidence is too empty to use as a name. So the
    // assertion is broad again: no placeholder anywhere on the screen, in a
    // snippet or in a heading.
    const r = run(['find', 'pay button spinner', '--width', '80']);
    const snippets = stripAnsi(r.stdout)
      .split('\n')
      .filter((l) => /^ {4}(?!run )\S/.test(l));
    expect(snippets.length).toBeGreaterThan(0);
    expect(r.stdout).not.toContain('[Image:');
    expect(r.stdout).toContain('spinner');
  });

  it('every snippet line begins on a word, at 80 columns and at 60', () => {
    for (const width of ['80', '60']) {
      const r = run(['find', 'idempotency key on a replayed request', '--width', width]);
      const lines = stripAnsi(r.stdout).split('\n');
      for (const line of lines) {
        // Snippet lines are the four-space-indented ones that are not the
        // `run …` action line.
        const m = /^ {4}(?!run )(.*)$/.exec(line);
        if (!m) continue;
        const body = m[1]!;
        if (!body || body.startsWith('the session title matched')) continue;
        // Either it starts at a sentence, or it starts with the ellipsis that
        // says an excerpt begins here. What it may never do is start with the
        // tail of a word, which is what `…wn) that book consultations` was.
        expect(body[0] === '…' || /^[\w"'(\[]/.test(body), `snippet: ${body}`).toBe(true);
      }
    }
  });

  it('--ascii keeps the block inside 7-bit and inside the column', () => {
    for (const width of ['80', '60']) {
      const r = run(['find', 'idempotency key on a replayed request', '--width', width, '--ascii']);
      // eslint-disable-next-line no-control-regex
      expect(stripAnsi(r.stdout)).toMatch(/^[\x00-\x7f]*$/);
      // The snippet window reserves room for two ellipses; under --ascii each
      // is three characters, not one, and reserving two overflowed by four.
      const { width: got, line } = widest(r.stdout);
      expect(got, `widest --ascii line (${got}): ${line}`).toBeLessThanOrEqual(Number(width));
    }
    expect(run(['find', 'idempotency key', '--width', '80', '--ascii']).stdout).toContain(
      'Idempotency keys',
    );
  });

  it('says rescue, not silence, when the index has no ghosts to search', async () => {
    // `index` does not build ghosts — `rescue` does. An empty
    // `find --ghosts only` on an indexed-but-never-rescued directory otherwise
    // reads as "you have no deleted sessions", which is the belief potsherd
    // exists to correct.
    const bare = tempDir('potsherd-no-ghosts-');
    dirs.push(bare);
    await indexAll({ root: bare, claudeDir: FIXTURE, harnesses: ['claude'], embed: false, full: true });
    // `find` exits 1 on no match, which is the point of this case.
    let out = '';
    try {
      out = execFileSync(
        'node',
        [bin, 'find', 'printer', '--ghosts', 'only', '--potsherd-dir', bare, '--width', '60'],
        { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
      ).toString();
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? '';
    }
    expect(out).toContain('potsherd rescue');
    expect(widest(out).width).toBeLessThanOrEqual(60);
  }, 60_000);

  it('says why a result is there when no snippet can show it', () => {
    // `timezone drift` rather than `pay button spinner`: this is the query
    // `plans/09 §13.5` measured for exactly this behaviour — one session
    // returned on the strength of its title alone, because its body contains
    // neither word — and the session it returns carries a HARNESS title, so
    // the case survives changes to how potsherd derives titles of its own.
    // The old query reached this branch only incidentally, and stopped when
    // 8.2 gave the session it depended on a real name.
    const r = run(['find', 'timezone drift', '--width', '80']);
    expect(r.stdout).toContain('the session title matched');
  });

  it('says text-only in the human view too, rather than pretending', () => {
    const r = run(['find', 'pgbouncer transaction pooling', '--width', '80']);
    expect(r.stdout).toContain('bm25');
    expect(r.stdout).not.toContain('bm25 + vectors');
  });
});

describe('show', () => {
  it('reads one session by an 8-character prefix', () => {
    const r = run(['show', '0a2fbf9b', '--width', '80']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Pin the pgbouncer');
    expect(r.stdout).toContain('claude --resume');
  });

  it('windows with --from and --to', () => {
    const j = JSON.parse(run(['show', '0a2fbf9b', '--from', '2', '--to', '2', '--json']).stdout) as {
      from: number;
      to: number;
      total: number;
      exchanges: unknown[];
    };
    expect(j.from).toBe(2);
    expect(j.exchanges.length).toBe(1);
    expect(j.total).toBe(3);
  });

  it('renders a ghost as prompts, and says the rest is gone', () => {
    const r = run(['show', 'e6aa5ba7', '--width', '80']);
    expect(r.stdout).toContain('not recoverable');
    expect(r.stdout).toContain('brother laser printer');
    expect(r.stdout).not.toContain('claude --resume');
  });

  it('--md is markdown with the session id in it', () => {
    const r = run(['show', '0a2fbf9b', '--md']);
    expect(r.stdout).toMatch(/^# Pin the pgbouncer/m);
    expect(r.stdout).toMatch(/- session: `[0-9a-f-]{36}`/);
  });

  it('names the candidates rather than guessing on an ambiguous prefix', () => {
    const r = run(['show', 'a', '--width', '80']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('matches');
    // The whole id, because the point is that the prefixes collided.
    expect(r.stdout).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  it('says so plainly when the id is not there', () => {
    const r = run(['show', 'zzzzzzzz']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('potsherd ls');
  });
});

describe('stats', () => {
  it('counts each harness, and the ghosts beside them', () => {
    const r = run(['stats', '--width', '80']);
    expect(r.stdout).toContain('claude');
    expect(r.stdout).toContain('ghosts');
    expect(r.stdout).toContain('prompts recovered');
  });

  it('--json carries the per-harness rows and the freshness check', () => {
    const j = JSON.parse(run(['stats', '--json']).stdout) as {
      harnesses: { harness: string; sessions: number; sidechains: number; ghosts: number }[];
      totals: { exchanges: number };
      freshness: { stale: number; missing: number; vecAvailable: boolean };
      redaction: unknown;
    };
    const claude = j.harnesses.find((h) => h.harness === 'claude')!;
    expect(claude.sessions).toBe(46);
    expect(claude.sidechains).toBe(6);
    expect(claude.ghosts).toBe(12);
    expect(j.freshness.stale).toBe(0);
    expect(j.freshness.missing).toBe(0);
    expect(j.redaction).toBeTruthy();
  });
});

describe('the index has to exist first', () => {
  it('says which command builds it', () => {
    const empty = tempDir('potsherd-query-empty-');
    dirs.push(empty);
    try {
      execFileSync('node', [bin, 'find', 'anything', '--potsherd-dir', empty], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('should have failed');
    } catch (err) {
      const e = err as { stderr?: string };
      expect(e.stderr ?? '').toContain('potsherd index');
    }
  });
});
