import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  db as store,
  recall,
  renderFind,
  search,
  Theme,
  type Db,
} from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * T3.2 and T3.3 — the filters of `03` §7 composing, and `find --explain`.
 *
 * ## Why the corpus is built by hand here
 *
 * `tests/recall.test.ts` runs against `evals/fixture`, which is the right
 * corpus for "does the answer come back". It is the wrong one for filters:
 * proving that four filters AND together needs sessions that differ in
 * *exactly one* attribute each, and a corpus shaped that way is a fixture for
 * this test rather than a corpus anyone would search.
 *
 * ## The shape that catches last-one-wins
 *
 * The bug a per-filter test cannot see is a builder that overwrites its clause
 * instead of appending it — every filter "works" alone, and `--tag x --pinned`
 * quietly means `--pinned`. Phase 2's tags worker found the shape that catches
 * it: a combination where **every pair is satisfiable and the whole is not**.
 * Under real AND the answer is nothing; under last-one-wins it is whatever the
 * last flag alone selects, which here is four sessions. One assertion, and no
 * amount of individually-correct filters can fake it.
 *
 * The five sessions below are one session that matches everything and four
 * that miss by exactly one attribute, plus a sixth that makes the negative
 * combination pairwise-satisfiable. Every filter in `03` §7 is exercised
 * against them, alone and in combination.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');

/** Fixed, so `--since "in july"` resolves to the same month every run. */
const NOW = new Date('2026-08-21T12:00:00.000Z');

const S = {
  /** claude · feat/pooler · src/db/pool.ts · postgres · pinned · july */
  all: 'aaaa1111-0000-4000-8000-000000000001',
  /** the same, but codex */
  codex: 'aaaa1111-0000-4000-8000-000000000002',
  /** the same, but on main */
  main: 'aaaa1111-0000-4000-8000-000000000003',
  /** the same, but it never touched a db path */
  readme: 'aaaa1111-0000-4000-8000-000000000004',
  /** the same, but tagged redis */
  redis: 'aaaa1111-0000-4000-8000-000000000005',
  /** codex · main · src/db/pool.ts · redis — makes the negative case pairwise ok */
  codexMain: 'aaaa1111-0000-4000-8000-000000000006',
  /** a deleted session: prompts only, no files, no branch of its own */
  ghost: 'aaaa1111-0000-4000-8000-00000000000f',
} as const;

const DB_FILE = 'packages/core/src/db/pool.ts';
const PROJECT = '/tmp/potsherd-filters';

let root: string;
let db: Db;
const dirs: string[] = [];

interface Row {
  id: string;
  harness: string;
  branch: string;
  files: string[];
  tag: string;
  pinned: boolean;
  ts: string;
  title: string;
  text: string;
}

const ROWS: Row[] = [
  {
    id: S.all, harness: 'claude', branch: 'feat/pooler', files: [DB_FILE, 'README.md'],
    tag: 'postgres', pinned: true, ts: '2026-07-15T09:00:00.000Z',
    title: 'Pooler work', text: 'the widget pool needs a bigger connection budget',
  },
  {
    id: S.codex, harness: 'codex', branch: 'feat/pooler', files: [DB_FILE],
    tag: 'postgres', pinned: true, ts: '2026-06-02T09:00:00.000Z',
    title: 'Pooler work in codex', text: 'the widget pool from the other harness',
  },
  {
    id: S.main, harness: 'claude', branch: 'main', files: [DB_FILE],
    tag: 'postgres', pinned: true, ts: '2026-06-03T09:00:00.000Z',
    title: 'Pooler work on main', text: 'the widget pool, merged to main',
  },
  {
    id: S.readme, harness: 'claude', branch: 'feat/pooler', files: ['README.md', 'snake_case.py'],
    tag: 'postgres', pinned: true, ts: '2026-06-04T09:00:00.000Z',
    title: 'Docs for the pooler', text: 'the widget pool, documented only',
  },
  {
    id: S.redis, harness: 'claude', branch: 'feat/pooler', files: [DB_FILE],
    tag: 'redis', pinned: true, ts: '2026-06-05T09:00:00.000Z',
    title: 'Cache in front of the pooler', text: 'the widget pool behind a cache',
  },
  {
    id: S.codexMain, harness: 'codex', branch: 'main', files: [DB_FILE],
    tag: 'redis', pinned: false, ts: '2026-06-06T09:00:00.000Z',
    title: 'Codex on main', text: 'the widget pool, codex, on main',
  },
];

beforeAll(() => {
  root = tempDir('potsherd-filters-');
  dirs.push(root);
  db = store.open({ root });

  const session = db.prepare(
    `INSERT INTO sessions (id, harness, project, project_slug, started_at, ended_at, title,
                           git_branch, is_sidechain, user_prompts, assistant_turns, bytes, status)
     VALUES (?, ?, ?, 'filters', ?, ?, ?, ?, 0, 1, 1, 100, 'live')`,
  );
  const exchange = db.prepare(
    `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text, files_touched,
                            is_sidechain)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0)`,
  );
  // `exchanges_fts` is external-content: the row has to be written into the
  // index by hand, exactly as `ingest.ts` does it.
  const fts = db.prepare(
    'INSERT INTO exchanges_fts (rowid, user_text, assistant_text) VALUES (last_insert_rowid(), ?, ?)',
  );
  const tag = db.prepare('INSERT INTO tags (session_id, tag) VALUES (?, ?)');
  const pin = db.prepare('INSERT INTO pins (session_id, pinned_at) VALUES (?, ?)');

  db.exec('BEGIN');
  for (const r of ROWS) {
    session.run(r.id, r.harness, PROJECT, r.ts, r.ts, r.title, r.branch);
    const assistant = `answered about the widget pool for ${r.branch}`;
    exchange.run(`${r.id}-e1`, r.id, r.ts, r.text, assistant, JSON.stringify(r.files));
    fts.run(r.text, assistant);
    tag.run(r.id, r.tag);
    if (r.pinned) pin.run(r.id, r.ts);
  }
  // One ghost, so `--file` and `--sidechains only` can be shown to switch the
  // ghost lists off rather than to filter them to nothing.
  db.prepare(
    `INSERT INTO ghosts (session_id, harness, project, first_ts, last_ts, prompt_count,
                         first_prompt, title, git_branch)
     VALUES (?, 'claude', ?, ?, ?, 1, ?, NULL, 'feat/pooler')`,
  ).run(S.ghost, PROJECT, '2026-07-16T09:00:00.000Z', '2026-07-16T09:00:00.000Z',
    'the widget pool in a session claude code deleted');
  db.prepare('INSERT INTO ghosts_fts (rowid, first_prompt, title) VALUES (last_insert_rowid(), ?, NULL)')
    .run('the widget pool in a session claude code deleted');
  db.prepare(
    `INSERT INTO ghost_prompts (id, session_id, seq, ts, text)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(`${S.ghost}-p1`, S.ghost, '2026-07-16T09:00:00.000Z',
    'the widget pool in a session claude code deleted');
  db.prepare('INSERT INTO ghost_prompts_fts (rowid, text) VALUES (last_insert_rowid(), ?)')
    .run('the widget pool in a session claude code deleted');
  db.exec('COMMIT');
});

afterAll(() => {
  db?.close();
  while (dirs.length) rmrf(dirs.pop()!);
});

type Filters = search.SearchFilters;

/** Session ids a `find "widget pool"` returns under these filters. */
async function found(filters: Filters): Promise<string[]> {
  const r = await recall(db, 'widget pool', filters, { vectors: false, limit: 20 });
  return r.sessions.map((s) => s.id).sort();
}

const since = (phrase: string): string => search.whenEdge(phrase, 'since', NOW)!;
const until = (phrase: string): string => search.whenEdge(phrase, 'until', NOW)!;

// -------------------------------------------------------------- one at a time

describe('every filter of 03 §7, alone', () => {
  it('--file matches an element of the files_touched JSON array', async () => {
    expect(await found({ file: '%/db/%' })).toEqual(
      [S.all, S.codex, S.main, S.redis, S.codexMain].sort(),
    );
  });

  it('--file takes a glob as well as a LIKE pattern', async () => {
    // `*` is what a shell taught everyone to type; `%` is what SQL wants.
    expect(await found({ file: '*/db/*' })).toEqual(await found({ file: '%/db/%' }));
    expect(await found({ file: '*.py' })).toEqual([S.readme]);
  });

  it('--file with no wildcard is a substring of one path', async () => {
    expect(await found({ file: 'pool.ts' })).toEqual(
      [S.all, S.codex, S.main, S.redis, S.codexMain].sort(),
    );
    expect(await found({ file: 'nothing-here.ts' })).toEqual([]);
  });

  it('--file cannot match across two elements of the array', async () => {
    // This is the whole reason for json_each. `files_touched` is
    // `["packages/core/src/db/pool.ts","README.md"]`, so a plain
    // `files_touched LIKE '%pool.ts","README%'` matches the comma between two
    // paths and returns a session that touched no such file.
    expect(await found({ file: '%pool.ts%README%' })).toEqual([]);
  });

  it('--file treats _ in a filename as a letter, not as a wildcard', async () => {
    expect(await found({ file: 'snake_case.py' })).toEqual([S.readme]);
    expect(await found({ file: 'snakeXcase.py' })).toEqual([]);
  });

  it('--branch is exact, so main does not select feat/pooler', async () => {
    expect(await found({ branch: 'main' })).toEqual([S.main, S.codexMain].sort());
    // The ghost carries a branch too — `history.jsonl` keeps it even when the
    // transcript is gone — so it belongs in the answer.
    expect(await found({ branch: 'feat/pooler' })).toEqual(
      [S.all, S.codex, S.readme, S.redis, S.ghost].sort(),
    );
  });

  it('--branch takes a wildcard when one is written', async () => {
    expect(await found({ branch: 'feat/*' })).toEqual(
      [S.all, S.codex, S.readme, S.redis, S.ghost].sort(),
    );
  });

  it('--since and --until take relative phrases', async () => {
    // "in july" is the whole month, and which end of it depends on the flag.
    expect(await found({ since: since('in july') })).toEqual([S.all, S.ghost].sort());
    expect(await found({ until: until('in june') })).toEqual(
      [S.codex, S.main, S.readme, S.redis, S.codexMain].sort(),
    );
    expect(await found({ since: since('2026-07'), until: until('2026-07') })).toEqual(
      [S.all, S.ghost].sort(),
    );
  });

  it('--harness, --tag and --pinned each narrow on their own', async () => {
    expect(await found({ harness: 'codex' })).toEqual([S.codex, S.codexMain].sort());
    expect(await found({ tag: 'redis' })).toEqual([S.redis, S.codexMain].sort());
    expect((await found({ pinned: true })).includes(S.codexMain)).toBe(false);
  });

  it('--file switches the ghost lists off — a ghost touched no files', async () => {
    expect((await found({})).includes(S.ghost)).toBe(true);
    expect((await found({ file: '%/db/%' })).includes(S.ghost)).toBe(false);
  });
});

// -------------------------------------------------------------- in combination

describe('filters compose (and would not, under last-one-wins)', () => {
  const QUAD: Filters = {
    harness: 'claude',
    branch: 'feat/pooler',
    file: '%/db/%',
    tag: 'postgres',
  };

  it('four filters AND down to the one session that satisfies all of them', async () => {
    expect(await found(QUAD)).toEqual([S.all]);
    // Under last-one-wins, whichever single filter the builder kept selects at
    // least four sessions. Nothing but real AND returns exactly this one.
    for (const [name, one] of Object.entries({
      harness: { harness: QUAD.harness },
      branch: { branch: QUAD.branch },
      file: { file: QUAD.file },
      tag: { tag: QUAD.tag },
    } as Record<string, Filters>)) {
      expect((await found(one)).length, `${name} alone must be looser`).toBeGreaterThan(1);
    }
  });

  it('a five-filter combination adds the date window without losing the rest', async () => {
    expect(await found({ ...QUAD, since: since('in july') })).toEqual([S.all]);
    // The one session that satisfies the other four is the one outside the
    // window, so the answer is nothing rather than "the last filter's".
    expect(await found({ ...QUAD, until: until('in june') })).toEqual([]);
  });

  it('the pairwise-satisfiable quadruple that no session satisfies', async () => {
    // Every pair below matches something; all four match nothing. A builder
    // that kept only the last clause would answer with `--tag postgres`'s four
    // sessions, and a builder that ORed them would answer with all six.
    const impossible: Filters = {
      harness: 'codex',
      branch: 'main',
      file: '%/db/%',
      tag: 'postgres',
    };
    expect(await found(impossible)).toEqual([]);

    const pairs: [string, Filters][] = [
      ['harness+branch', { harness: 'codex', branch: 'main' }],
      ['harness+file', { harness: 'codex', file: '%/db/%' }],
      ['harness+tag', { harness: 'codex', tag: 'postgres' }],
      ['branch+file', { branch: 'main', file: '%/db/%' }],
      ['branch+tag', { branch: 'main', tag: 'postgres' }],
      ['file+tag', { file: '%/db/%', tag: 'postgres' }],
    ];
    for (const [name, f] of pairs) {
      expect((await found(f)).length, `${name} must still match something`).toBeGreaterThan(0);
    }
  });

  it('a triple whose every pair is satisfiable and which nothing satisfies', async () => {
    expect(await found({ harness: 'codex', branch: 'main', tag: 'postgres' })).toEqual([]);
    expect(await found({ harness: 'codex', branch: 'main' })).toEqual([S.codexMain]);
    expect(await found({ harness: 'codex', tag: 'postgres' })).toEqual([S.codex]);
    expect(await found({ branch: 'main', tag: 'postgres' })).toEqual([S.main]);
  });

  it('--pinned composes with the rest rather than replacing it', async () => {
    expect(await found({ ...QUAD, pinned: true })).toEqual([S.all]);
    expect(await found({ harness: 'codex', branch: 'main', pinned: true })).toEqual([]);
  });

  it('the sql stays parameterised: a quote in a filter matches nothing, throws nothing',
    async () => {
      // The injection surface of the whole filter set, in one line.
      expect(await found({ file: "'; DROP TABLE sessions; --" })).toEqual([]);
      expect(await found({ branch: "' OR 1=1 --" })).toEqual([]);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
      ).toBe(ROWS.length);
    });
});

// -------------------------------------------------------------- date phrases

describe('the date phrases a person types', () => {
  const at = (phrase: string): string | null => search.whenEdge(phrase, 'since', NOW);

  it('accepts spans, calendar words, months and weekdays', () => {
    expect(at('30d')!.slice(0, 10)).toBe('2026-07-22');
    expect(at('6w')!.slice(0, 10)).toBe('2026-07-10');
    expect(at('3 days ago')!.slice(0, 10)).toBe('2026-08-18');
    expect(at('last 30 days')!.slice(0, 10)).toBe('2026-07-22');
    expect(search.parseWhen('today', NOW)!.label).toBe('today');
    expect(search.parseWhen('yesterday', NOW)!.label).toBe('yesterday');
    expect(search.parseWhen('last week', NOW)!.label).toBe('last week');
    expect(search.parseWhen('last month', NOW)!.label).toBe('last month');
    expect(search.parseWhen('in july', NOW)!.label).toBe('july 2026');
    // Asked in august, "in september" can only mean the one that has happened.
    expect(search.parseWhen('in september', NOW)!.label).toBe('september 2025');
    expect(search.parseWhen('july 2025', NOW)!.label).toBe('july 2025');
    expect(search.parseWhen('2026-08', NOW)!.label).toBe('2026-08');
    expect(search.parseWhen('last tuesday', NOW)!.label).toContain('tuesday');
  });

  it('a phrase is an interval, so --since and --until take opposite ends', () => {
    const july = search.parseWhen('in july', NOW)!;
    expect(search.whenEdge('in july', 'since', NOW)).toBe(july.start);
    expect(search.whenEdge('in july', 'until', NOW)).toBe(july.end);
    expect(july.start < july.end).toBe(true);
  });

  it('--until on a bare date includes that whole day', () => {
    // The single-instant reading made `--since X --until X` mean "nothing".
    expect(search.whenEdge('2026-08-01', 'until', NOW)).toBe('2026-08-01T23:59:59.999Z');
    expect(search.whenEdge('2026-08-01', 'since', NOW)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns null rather than a wrong date for something it cannot read', () => {
    expect(search.parseWhen('the day before the outage', NOW)).toBeNull();
    expect(search.parseWhen('2026-13-01', NOW)).toBeNull();
    expect(search.parseWhen('', NOW)).toBeNull();
  });

  it('the core store still refuses anything but ISO', async () => {
    // The phrases are resolved at the CLI edge. `recall` itself must stay
    // strict, or an unparsed phrase would reach SQL as a string comparison
    // that silently matches nothing.
    await expect(recall(db, 'widget', { since: 'last week' }, { vectors: false })).rejects.toThrow(
      /--since/,
    );
  });
});

// ------------------------------------------------------------------- explain

describe('find --explain', () => {
  it('every contribution adds up to the score it explains', async () => {
    const r = await recall(db, 'widget pool', {}, { vectors: false, limit: 5 });
    const e = search.explain(r);
    expect(e.sessions.length).toBeGreaterThan(0);
    for (const s of e.sessions) {
      for (const hit of s.hits) {
        expect(hit.lists.length).toBeGreaterThan(0);
        // The ledger's whole claim: the rows on screen sum to the hit's score.
        expect(Math.abs(hit.residual)).toBeLessThan(1e-9);
        for (const l of hit.lists) {
          expect(l.rank).toBeGreaterThan(0);
          expect(l.contribution).toBeCloseTo(l.weight / (e.k + l.rank), 12);
        }
      }
      // And the hits sum to the session score by `recall`'s own formula.
      expect(s.score).toBeCloseTo(s.best + s.corroboration, 12);
    }
  });

  it('reads each list weight from recall rather than solving for it', async () => {
    const r = await recall(db, 'widget pool', {}, { vectors: false, limit: 5 });
    const e = search.explain(r);
    expect(e.weights.length).toBeGreaterThan(0);
    // The ledger prints the weight the fusion *used*, so it must be the same
    // object `recall` reported — not a re-derivation that can drift from it.
    expect(e.k).toBe(r.k);
    for (const w of e.weights) expect(w.weight).toBe(r.weights[w.list]);
    // Those are effective weights, not the static table: `titles` is scaled by
    // how much of the query the best title covered, so a copy of `recall.ts`'s
    // constants would print 1.5 where the fusion used 0.75.
    const titles = e.weights.find((w) => w.list === 'titles');
    if (titles) expect(titles.weight).not.toBe(1.5);
    // And the old solver — kept as a cross-check — still recovers the same
    // numbers from the scores alone. If these two ever disagree, one of them is
    // lying about how the page was ordered.
    const solved = search.solveWeights(r.hits, r.k);
    let compared = 0;
    for (const [list, w] of solved) {
      if (!w.solved) continue;
      compared += 1;
      expect(w.weight).toBeCloseTo(r.weights[list] ?? 1, 9);
    }
    // A cross-check that compares nothing is not a cross-check. Without this
    // the loop passed on a solver that never solved a single list — which is
    // exactly the failure it was written to catch.
    expect(compared).toBeGreaterThan(0);
  });

  it('names which list ranked the top two, and when corroboration decided it',
    async () => {
      const r = await recall(db, 'widget pool', {}, { vectors: false, limit: 5 });
      const e = search.explain(r);
      expect(e.margin).not.toBeNull();
      expect(['best', 'corroboration']).toContain(e.margin!.reason);
      expect(e.margin!.by).toBeGreaterThanOrEqual(0);
    });

  it('renders a ledger whose numbers are on the screen', async () => {
    const r = await recall(db, 'widget pool', {}, { vectors: false, limit: 3 });
    const out = renderFind(r, new Theme({ color: false, ascii: true, width: 80 }), NOW, {
      explain: true,
    });
    expect(out).toContain('rrf 1/(k+rank), k=60');
    expect(out).toContain('exchanges_fts');
    expect(out).toMatch(/r\d+/);
    expect(out).toContain('best');
    expect(out).toMatch(/#1 leads #2 by 0\.\d{4}/);
  });

  it('fits 80 and 60 columns, counted in characters, and folds to pure ASCII',
    async () => {
      const r = await recall(db, 'widget pool', {}, { vectors: false, limit: 5 });
      for (const width of [60, 80]) {
        for (const ascii of [false, true]) {
          const t = new Theme({ color: false, ascii, width });
          const out = t.asciiLine(renderFind(r, t, NOW, { explain: true }));
          const over = out.split('\n').filter((l) => [...l].length > width);
          expect(over, `overflowing lines at --width ${width}`).toEqual([]);
          if (ascii) {
            // eslint-disable-next-line no-control-regex
            expect(out).toMatch(/^[\x00-\x7F]*$/);
          }
        }
      }
    });

  it('falls back to the empty-result block rather than an empty ledger', async () => {
    const r = await recall(db, 'zzzznotinthiscorpus', {}, { vectors: false });
    const out = renderFind(r, new Theme({ color: false, width: 80 }), NOW, { explain: true });
    expect(out).toContain('nothing in the index matches');
  });
});

// ----------------------------------------------------------------- the binary

describe('the flags on the shipped binary', () => {
  const runCli = (args: string[]): { code: number; stdout: string; stderr: string } => {
    try {
      const stdout = execFileSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  it('--help documents every filter of 03 §7 with one example each', () => {
    const help = runCli(['find', '--help']).stdout;
    for (const example of [
      // Still the real project name, because this asserts the literal text of
      // `--help`, which lives in packages/cli/src/index.ts. Scrubbing one side
      // without the other just makes the test lie. Pinned in
      // scripts/check-privacy.py and assigned in registration-T5.7.txt.
      '--project Fulcrum',
      '--harness claude',
      '--since "last week"',
      '--until 2026-08-15',
      '--tag postgres',
      '--branch feat/pooler',
      '--file "%/db/%"',
      '--sidechains only',
      '--ghosts only',
      '--pinned',
      '--status archived',
      '--explain',
    ]) {
      expect(help, `${example} must be in find --help`).toContain(example);
    }
  });

  it('an unreadable --since says what it accepts instead of throwing a stack', () => {
    const r = runCli(['find', 'widget', '--since', 'the day before the outage',
      '--potsherd-dir', root]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--since did not understand');
    expect(r.stderr).toContain('2026-08-01');
    expect(r.stderr).toContain('30d');
    expect(r.stderr).toContain('in july');
    expect(r.stderr).not.toContain('at Object.');
  });

  it('--explain --json carries the same ledger as the human view', () => {
    const r = runCli(['find', 'widget pool', '--explain', '--json', '--potsherd-dir', root]);
    const json = JSON.parse(r.stdout) as {
      explain: { k: number; sessions: { hits: { lists: { list: string }[] }[] }[] };
    };
    expect(json.explain.k).toBe(60);
    expect(json.explain.sessions[0]!.hits[0]!.lists[0]!.list).toBeTruthy();
  });
});
