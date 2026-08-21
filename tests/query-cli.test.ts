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
    expect(j.ghosts).toBe(5);
    expect(j.rolledUp).toBe(2);
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

  it('shows the matched word rather than a pasted-screenshot placeholder', () => {
    // The T1.7 review's sharpest complaint: a top-three result whose only
    // snippet was `[Image: source: /var/folders/…/clipboard-…]`, so nothing on
    // the screen said why that result was there.
    const r = run(['find', 'pay button spinner', '--width', '80']);
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
    const r = run(['find', 'pay button spinner', '--width', '80']);
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
    expect(claude.sessions).toBe(24);
    expect(claude.sidechains).toBe(2);
    expect(claude.ghosts).toBe(5);
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
