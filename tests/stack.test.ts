import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as store from '../packages/core/src/db.js';
import type { Db } from '../packages/core/src/db.js';
import { Theme } from '../packages/core/src/theme.js';
import { wrap } from '../packages/core/src/format.js';
import {
  FAILURES,
  POTSHERD,
  TOOLS,
  VERIFIED_ON,
  coverageGlyph,
  detectTools,
  episodicIndexPath,
  overlaps,
  recommend,
  stackReport,
  toolSpec,
  type Coverage,
  type Detection,
  type ToolId,
} from '../packages/core/src/stack.js';
import {
  DEFAULT_LIMIT,
  MEASURED_PRECISION,
  renderSuggestions,
  suggestLinks,
} from '../packages/core/src/link-suggest.js';
import { render as renderStack } from '../packages/cli/src/commands/stack.ts';
import { linkSessions } from '../packages/core/src/tags.js';
import { FIXTURE_CLAUDE, rmrf, tempDir } from './helpers.js';

/**
 * T6.4 — `potsherd stack` and `link --suggest`.
 *
 * These two verbs fail in ways the rest of the product cannot, so the tests
 * are organised around those failures rather than around the functions:
 *
 *   - **`stack` prints claims about other people's software.** Four phantom
 *     flags have already been found in this build. The tests that matter here
 *     are the ones that hold the *honesty apparatus* in place: every row
 *     carries a verification level, the level reaches the terminal, the
 *     count of docs-only rows is printed, and potsherd's own row loses two of
 *     the four failures. If someone later "improves" the table by giving
 *     potsherd a `yes` on cold start, three tests fail.
 *   - **`link --suggest` rests on a rule pass measured at 1–2 useful in 8.**
 *     That number must appear in the output, and the suggester must never
 *     write a link. Both are asserted against the rendered lines, not against
 *     an intention.
 *
 * Detection runs against a throwaway HOME so that the reference machine's own
 * installed tools cannot make a test pass or fail.
 */

const OPEN: Db[] = [];
afterEach(() => {
  while (OPEN.length) OPEN.pop()!.close();
});

function memDb(): Db {
  const db = store.open({ file: ':memory:' });
  OPEN.push(db);
  return db;
}

// --------------------------------------------------------------- fake $HOME

let home = '';
let realHome: string | undefined;
let realUserProfile: string | undefined;

beforeEach(() => {
  home = tempDir('potsherd-stack-');
  realHome = process.env['HOME'];
  realUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
});

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  if (realUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = realUserProfile;
  rmrf(home);
});

/** Create a marker directory for `id`, as the tool itself would. */
function install(id: ToolId, env: NodeJS.ProcessEnv = process.env): string {
  const marker = toolSpec(id).markers(env)[0]!;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  // A file for a `.sqlite` marker, a directory for everything else: `stack`
  // must not care which, and neither must this helper.
  if (marker.endsWith('.sqlite') || marker.endsWith('.md')) fs.writeFileSync(marker, '');
  else fs.mkdirSync(marker, { recursive: true });
  return marker;
}

function theme(width = 80): Theme {
  return new Theme({ color: false, width });
}

function plain(lines: string[]): string {
  return lines.join('\n');
}

// ================================================================== the table

describe('stack: the mapping is the verb', () => {
  it('maps every tool onto all four failures, with no gaps', () => {
    expect(FAILURES.map((f) => f.n)).toEqual([1, 2, 3, 4]);
    for (const spec of TOOLS) {
      expect(spec.coverage, spec.id).toHaveLength(4);
      for (const c of spec.coverage) {
        expect(['yes', 'partial', 'no', 'unknown']).toContain(c);
      }
    }
  });

  it('agrees with 01 §1 about which two failures are unsolved', () => {
    expect(FAILURES.filter((f) => !f.solved).map((f) => f.n)).toEqual([3, 4]);
  });

  /**
   * The ruling, as a test. `01 §1` scopes potsherd to failures 3 and 4, and a
   * table where potsherd wins every row is marketing rather than a tool. This
   * is the assertion that has to be deliberately deleted before that can
   * happen.
   */
  it('potsherd loses failures 1 and 2, and its row is first', () => {
    expect(TOOLS[0]).toBe(POTSHERD);
    expect(POTSHERD.coverage).toEqual(['no', 'no', 'yes', 'yes']);
    const wins = POTSHERD.coverage.filter((c) => c === 'yes').length;
    expect(wins).toBe(2);
  });

  it('no tool claims to solve failure 1: nothing on this list is in the session', () => {
    for (const spec of TOOLS) expect(spec.coverage[0], spec.id).toBe('no');
  });

  it('someone other than potsherd owns cold start', () => {
    const owners = TOOLS.filter((s) => s.id !== 'potsherd' && s.coverage[1] === 'yes');
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.map((s) => s.id)).toContain('auto-memory');
  });

  it('every row records a licence and how far its claim was checked', () => {
    for (const spec of TOOLS) {
      expect(spec.licence, spec.id).toBeTruthy();
      expect(['tool', 'config', 'docs']).toContain(spec.verified);
      expect(spec.evidenceNote.length, spec.id).toBeGreaterThan(10);
      expect(spec.source.length, spec.id).toBeGreaterThan(10);
    }
  });

  /**
   * `04-DECISIONS.md` Q1 binds this project on attribution, and
   * `research/competitors.md` guessed claude-mem was *"AGPL-ish? check before
   * linking"*. The GitHub licence API said Apache-2.0 on {@link VERIFIED_ON}.
   * Pinned here because a later phase will reuse something on the strength of
   * it, and a licence that quietly changes value in this file must fail loudly.
   */
  it('records the licences that a later phase will act on', () => {
    expect(toolSpec('claude-mem').licence).toBe('Apache-2.0');
    expect(toolSpec('claude-mem').licenceNote).toMatch(/Apache-2\.0/);
    expect(toolSpec('agentmemory').licence).toBe('Apache-2.0');
    expect(toolSpec('episodic-memory').licence).toBe('MIT');
    expect(toolSpec('hindsight').licence).toBe('MIT');
    expect(toolSpec('greplica').licence).toBe('MIT');
    expect(toolSpec('superbrain').licence).toBe('MIT');
  });

  it('dates the docs-only claims', () => {
    expect(VERIFIED_ON).toMatch(/^\d{1,2} [a-z]{3} \d{4}$/);
    for (const spec of TOOLS) {
      if (spec.verified === 'docs') expect(spec.evidenceNote).toContain(VERIFIED_ON);
    }
  });

  it('coverage glyphs are one character wide, so the table cannot wrap', () => {
    for (const c of ['yes', 'partial', 'no', 'unknown'] as Coverage[]) {
      expect(coverageGlyph(c)).toHaveLength(1);
      expect(coverageGlyph(c, true)).toHaveLength(1);
      expect(coverageGlyph(c, true)).toMatch(/^[\x20-\x7e]$/);
    }
  });
});

// ================================================================= detection

describe('stack: detection reads and never writes', () => {
  it('finds nothing on an empty home, and says so rather than throwing', () => {
    const d = detectTools();
    const others = d.filter((x) => x.spec.id !== 'potsherd');
    expect(others.every((x) => !x.present)).toBe(true);
    for (const x of others) expect(x.looked.length).toBeGreaterThan(0);
  });

  it('finds a tool by the directory it creates', () => {
    install('claude-mem');
    const d = detectTools().find((x) => x.spec.id === 'claude-mem')!;
    expect(d.present).toBe(true);
    expect(d.found).toHaveLength(1);
  });

  /**
   * agentmemory's README puts its state in the platform's app-data directory,
   * **not** `~/.agentmemory`, which is what the phase brief assumed. A
   * detector that only knows the wrong path reports "absent" on a machine
   * where the tool is running, so both are checked.
   */
  it('knows agentmemory keeps state outside ~/.agentmemory', () => {
    const markers = toolSpec('agentmemory').markers();
    expect(markers.length).toBeGreaterThan(1);
    expect(markers.some((m) => !m.endsWith('.agentmemory'))).toBe(true);
  });

  /**
   * episodic-memory ships inside the superpowers marketplace, so its index is
   * under `~/.config/superpowers/`, not under anything named after it.
   */
  it('finds episodic-memory where superpowers actually puts it', () => {
    expect(episodicIndexPath()).toContain(path.join('superpowers', 'conversation-index'));
    expect(toolSpec('episodic-memory').markers()[0]).toBe(episodicIndexPath());
  });

  it('honours XDG_CONFIG_HOME for the episodic-memory index', () => {
    const custom = path.join(home, 'xdg');
    expect(episodicIndexPath({ XDG_CONFIG_HOME: custom })).toBe(
      path.join(custom, 'superpowers', 'conversation-index', 'db.sqlite'),
    );
  });

  it('writes nothing into the directories it looks at', () => {
    const before = fs.readdirSync(home).sort();
    detectTools();
    stackReport();
    expect(fs.readdirSync(home).sort()).toEqual(before);
  });

  it('a marker that cannot be read is "not installed", not a crash', () => {
    // `existsSync` on a path under a file rather than a directory. The point
    // is that nothing throws and the tool reads as absent.
    const blocker = path.join(home, '.claude-mem');
    fs.writeFileSync(blocker, 'not a directory');
    expect(() => detectTools()).not.toThrow();
  });
});

// ================================================================== overlaps

describe('stack: overlaps and double capture', () => {
  function detectionsFor(ids: ToolId[]): Detection[] {
    return TOOLS.map((spec) => ({
      spec,
      present: ids.includes(spec.id),
      found: ids.includes(spec.id) ? ['~/fake'] : [],
      looked: ['~/fake'],
    }));
  }

  it('says nothing when one capturer is installed', () => {
    expect(overlaps(detectionsFor(['claude-mem']))).toEqual([]);
  });

  it('flags double capture when two tools hook the same sessions', () => {
    const o = overlaps(detectionsFor(['claude-mem', 'superbrain']));
    expect(o.map((x) => x.kind)).toContain('double-capture');
  });

  it('flags double injection separately, because it costs context not disk', () => {
    const o = overlaps(detectionsFor(['claude-mem', 'auto-memory']));
    const inject = o.find((x) => x.kind === 'double-inject')!;
    expect(inject).toBeTruthy();
    expect(inject.tools).toContain('claude-mem');
    expect(inject.tools).toContain('CLAUDE.md');
  });

  it('never warns about tools that are not installed', () => {
    for (const o of overlaps(detectionsFor(['claude-mem']))) {
      expect(o.tools).not.toContain('agentmemory');
    }
  });

  it('recommends someone other than potsherd for failures 1 and 2', () => {
    const rec = recommend(detectionsFor(['claude-mem']));
    expect(rec.rows).toHaveLength(4);
    expect(rec.rows[0]!.use).not.toBe('potsherd');
    expect(rec.rows[1]!.use).toBe('claude-mem');
    expect(rec.rows[2]!.use).toBe('potsherd');
    expect(rec.rows[3]!.use).toBe('potsherd');
  });

  it('falls back to CLAUDE.md for cold start when nothing else is installed', () => {
    const rec = recommend(detectionsFor([]));
    expect(rec.rows[1]!.use).toBe('CLAUDE.md');
  });
});

// ============================================================ the rendered page

describe('stack: the page a user actually sees', () => {
  it('fits 80 columns, and still fits 60', () => {
    for (const width of [80, 60]) {
      const lines = renderStack(stackReport(), theme(width), {});
      for (const line of lines) expect(line.length, `${width}: ${line}`).toBeLessThanOrEqual(width);
    }
  });

  it('carries no emoji and no ascii art', () => {
    const out = plain(renderStack(stackReport(), theme(80), {}));
    expect(out).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{FE0F}]/u);
  });

  it('folds to pure ascii under --ascii', () => {
    const lines = renderStack(stackReport(), new Theme({ color: false, width: 80, ascii: true }), {});
    for (const line of lines) {
      expect(line, line).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  /**
   * The ruling: *every claim about another tool is either verified against its
   * current docs, or labelled unverified — in the output, not only in the docs
   * page*. This is that assertion.
   */
  it('labels the docs-only rows in the terminal', () => {
    const r = stackReport();
    const out = plain(renderStack(r, theme(80), {}));
    expect(out).toContain('docs only');
    expect(out).toContain(`${r.unverified} of these ${r.detections.length} rows`);
    expect(out).toContain(VERIFIED_ON);
    expect(out).toContain('never exercised here');
  });

  it('says what potsherd does not do, before it says anything about anyone else', () => {
    const out = plain(renderStack(stackReport(), theme(80), {}));
    expect(out).toContain('what potsherd does not do');
    expect(out).toMatch(/refused on purpose/);
    expect(out).toContain('no knowledge graph');
    expect(out).toContain('no server, no account, no telemetry');
    expect(out.indexOf('what potsherd does not do')).toBeLessThan(out.indexOf('recommended'));
  });

  it('prints the legend for the four failures every time', () => {
    const out = plain(renderStack(stackReport(), theme(80), {}));
    for (const f of FAILURES) expect(out).toContain(f.label);
  });

  it('degrades to a line when nothing is installed, never a stack trace', () => {
    const r = stackReport();
    const out = plain(renderStack(r, theme(80), {}));
    expect(r.installed).toBe(0);
    expect(out).toContain('not installed here');
    expect(out).not.toContain('Error');
    expect(out).not.toContain('at Object.');
  });

  it('--paths shows where it looked, so a false negative is diagnosable', () => {
    const withPaths = plain(renderStack(stackReport(), theme(80), { paths: true }));
    expect(withPaths).toContain('.claude-mem');
  });

  it('--sources prints the url behind every row', () => {
    const out = plain(renderStack(stackReport(), theme(80), { sources: true }));
    expect(out).toContain('github.com/thedotmack/claude-mem');
    expect(out).toContain('code.claude.com/docs/en/memory');
  });

  it('ends with the next verb', () => {
    const lines = renderStack(stackReport(), theme(80), {}).filter((l) => l.trim());
    expect(lines[lines.length - 1]).toContain('potsherd audit');
  });

  it('reports an installed tool with the path that proved it', () => {
    install('claude-mem');
    const out = plain(renderStack(stackReport(), theme(80), {}));
    expect(out).toContain('installed here');
    expect(out).toContain('claude-mem');
  });
});

// ============================================================== link --suggest

let nextId = 0;
function uuid(tag: string): string {
  nextId += 1;
  return `${tag}${String(nextId).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36);
}

/** One carded session, written the way `cards/write.ts` writes it. */
function addCard(
  db: Db,
  spec: {
    project: string;
    topics?: string[];
    files?: string[];
    decisions?: { what: string; why?: string }[];
  },
): string {
  const id = uuid('s');
  const decisions = (spec.decisions ?? []).map((d) => ({
    what: d.what,
    why: d.why ?? '',
    evidence_seq: [1],
  }));
  db.prepare(
    'INSERT INTO sessions (id, harness, project, started_at, status) VALUES (?,?,?,?,?)',
  ).run(id, 'claude', spec.project, '2026-07-01T10:00:00.000Z', 'archived');
  db.prepare(
    'INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text) VALUES (?,?,?,?,?,?)',
  ).run(`${id}#1`, id, 1, '2026-07-01T11:00:00.000Z', 'q', 'a');
  db.prepare(
    `INSERT INTO cards (session_id, title, summary, topics, decisions, files, outcome, open_threads, source)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    'a card',
    'what happened',
    JSON.stringify(spec.topics ?? []),
    JSON.stringify(decisions),
    JSON.stringify(spec.files ?? []),
    'shipped',
    '[]',
    'transcript',
  );
  return id;
}

/**
 * Two related projects, one of which decided something the other never
 * mentions: the shape the phase-4 rule pass raises a candidate from.
 */
function twoProjects(db: Db): { a: string; b: string } {
  const a = addCard(db, {
    project: '/w/pgbouncer-gateway',
    topics: ['pgbouncer pooling', 'transaction mode', 'prepared statements'],
    files: ['src/pool/pgbouncer.ts', 'docs/pooling.md'],
    decisions: [
      { what: 'move pgbouncer to transaction pooling mode', why: 'session mode pinned connections' },
    ],
  });
  const b = addCard(db, {
    project: '/w/pgbouncer-reports',
    topics: ['pgbouncer pooling', 'transaction mode', 'reporting queries'],
    files: ['src/pool/pgbouncer.ts', 'docs/pooling.md'],
    decisions: [{ what: 'add a nightly reporting query', why: 'the dashboard was stale' }],
  });
  return { a, b };
}

describe('link --suggest: it proposes, it never writes', () => {
  it('writes no link, whatever it finds', () => {
    const db = memDb();
    twoProjects(db);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }).n;
    suggestLinks(db);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }).n;
    expect(before).toBe(0);
    expect(after).toBe(0);
  });

  it('reuses phase 4, and each suggestion carries the command that would apply it', () => {
    const db = memDb();
    const { a, b } = twoProjects(db);
    const r = suggestLinks(db);
    expect(r.suggestions.length).toBeGreaterThan(0);
    const s = r.suggestions[0]!;
    expect([a, b]).toContain(s.a);
    expect([a, b]).toContain(s.b);
    expect(s.aProject).not.toBe(s.bProject);
    expect(s.command).toBe(`potsherd link ${s.a8} ${s.b8}`);
  });

  it('drops a pair the user already linked, in either storage order', () => {
    const db = memDb();
    const { a, b } = twoProjects(db);
    const before = suggestLinks(db);
    expect(before.suggestions.length).toBeGreaterThan(0);

    // Link it the *other* way round, which is the case a naive check misses.
    linkSessions(db, b, a, 'same thread');
    const after = suggestLinks(db);
    expect(after.alreadyLinked).toBeGreaterThan(0);
    expect(after.suggestions.some((s) => s.a === a && s.b === b)).toBe(false);
  });

  it('proposes one row per pair, not one per session in the other project', () => {
    const db = memDb();
    twoProjects(db);
    const r = suggestLinks(db, { limit: 20 });
    const pairs = r.suggestions.map((s) => (s.a < s.b ? `${s.a}|${s.b}` : `${s.b}|${s.a}`));
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('an empty index is an empty result with a reason, not a crash', () => {
    const db = memDb();
    const r = suggestLinks(db);
    expect(r.cards).toBe(0);
    expect(r.suggestions).toEqual([]);
    const out = plain(renderSuggestions(r, theme(80), wrap));
    expect(out).toContain('no cards in the index');
    expect(out).not.toContain('Error');
  });

  it('defaults to five, because the measured rate does not reward a bigger screen', () => {
    expect(DEFAULT_LIMIT).toBe(5);
    const db = memDb();
    twoProjects(db);
    expect(suggestLinks(db).suggestions.length).toBeLessThanOrEqual(DEFAULT_LIMIT);
    expect(suggestLinks(db, { limit: 0 }).suggestions).toEqual([]);
  });
});

describe('link --suggest: the measured precision reaches the user', () => {
  /**
   * The ruling: *if you cannot make it useful at the measured precision, say
   * so with the number*. Phase 4's own evidence
   * (`phases/phase-4/evidence-T4.2/RESULTS.md`) is 8/8 absent, 1–2/8 worth
   * raising. These are pinned so that softening the disclosure requires
   * deleting an assertion.
   */
  it('carries phase 4 evidence-T4.2 verbatim', () => {
    expect(MEASURED_PRECISION.raised).toBe(8);
    expect(MEASURED_PRECISION.absent).toBe(8);
    expect(MEASURED_PRECISION.worthLow).toBe(1);
    expect(MEASURED_PRECISION.worthHigh).toBe(2);
  });

  it('prints the number, and does not imply the rows are all good', () => {
    const db = memDb();
    twoProjects(db);
    const out = plain(renderSuggestions(suggestLinks(db), theme(80), wrap));
    expect(out).toContain('1-2 of 8');
    expect(out).toContain('genuinely absent from the other project');
    expect(out).toContain('expect most of these to be wrong');
    expect(out).toContain('nothing was written');
  });

  it('fits 80 columns, and still fits 60', () => {
    const db = memDb();
    twoProjects(db);
    const r = suggestLinks(db);
    for (const width of [80, 60]) {
      for (const line of renderSuggestions(r, theme(width), wrap)) {
        expect(line.length, `${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('ends with the next verb, and it is show rather than link', () => {
    const db = memDb();
    twoProjects(db);
    const lines = renderSuggestions(suggestLinks(db), theme(80), wrap).filter((l) => l.trim());
    expect(lines[lines.length - 1]).toContain('potsherd show');
  });

  it('says so when it has nothing to propose', () => {
    const db = memDb();
    addCard(db, { project: '/w/only-one', topics: ['solo'], decisions: [{ what: 'ship it' }] });
    const r = suggestLinks(db);
    expect(r.suggestions).toEqual([]);
    const out = plain(renderSuggestions(r, theme(80), wrap));
    expect(out).toContain('nothing to propose');
  });
});

// The fake home must be under the OS temp root, so that a failing cleanup can
// never touch a real home directory. `realpath` on both sides because macOS
// hands out `/var/...` for a directory that is really `/private/var/...`.
it('the fake home is under the OS temp root', () => {
  expect(fs.realpathSync(home).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
});

// ------------------------------------------------- T6.6 D8 · D9 · D14: width

describe('stack and find are self-consistent, and fit the width they are given', () => {
  const bin = path.resolve(process.cwd(), 'packages', 'cli', 'bin', 'potsherd.js');
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) rmrf(tmpDirs.pop()!);
  });
  /** An indexed throwaway store: `find` must get past "nothing indexed yet". */
  const tempPotsherdDir = (): string => {
    const d = tempDir('potsherd-width-');
    tmpDirs.push(d);
    runCli([
      'index', '--harness', 'claude', '--no-embed', '--full',
      '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', d,
    ]);
    return d;
  };

  const runCli = (args: string[]): string => {
    try {
      return execFileSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return (err as { stdout?: string }).stdout ?? '';
    }
  };

  /**
   * T6.6 D14 — the header said `7 tools known` over a table of eight rows,
   * one screen above a footer that said `8 rows`. Same table, two numbers.
   */
  it('the heading, the table and the footer agree on how many tools there are', () => {
    const out = runCli(['stack', '--width', '80']);
    const report = stackReport();
    const n = report.detections.length;
    expect(out).toContain(`${n} tools known`);
    expect(out).toContain(`of these ${n} rows`);
    // And the count the header pairs with `installed`, which excludes
    // potsherd by definition, says which set it is about.
    expect(out).toContain(`${report.installed} of ${n - 1} others here`);
  });

  /**
   * T6.6 D14 — and the prose count in `commands/stack.ts`'s own header, which
   * said *six* against a table, a footer and a `--json` payload that all said
   * five. Read out of the comment, so it cannot drift again in silence.
   */
  it('the docs only count in the module comment is the one the report computes', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/cli/src/commands/stack.ts'),
      'utf-8',
    );
    const words: Record<string, number> = {
      three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    };
    // The jsdoc `*` gutter first, so the sentence can be matched as a sentence.
    const prose = src.replace(/^\s*\*\s?/gm, '');
    const m = /Every row says how well its claim was checked\.\*\*\s+(\w+) of the (\w+)/.exec(prose);
    expect(m).not.toBeNull();
    const report = stackReport();
    expect(words[m![1]!.toLowerCase()]).toBe(report.unverified);
    expect(words[m![2]!.toLowerCase()]).toBe(report.detections.length);
  });

  /**
   * T6.6 D9 — `--sources` is the flag whose entire job is to print the url a
   * claim was read from. Every one of them was elided at 80 columns.
   */
  it('stack --sources prints whole urls, never elided ones', () => {
    const out = runCli(['stack', '--sources', '--width', '80']);
    for (const d of stackReport().detections) {
      expect(out, d.spec.id).toContain(d.spec.source);
    }
    // The ellipsis the old layout produced, on the source lines only.
    const sources = out.split('\n').filter((l) => l.includes('http') || l.includes('plans/'));
    expect(sources.length).toBeGreaterThanOrEqual(7);
    for (const line of sources) expect(line).not.toContain('…');
  });

  /**
   * T6.6 D8 — the federation footer came out at 84 characters under
   * `--width 80`, on a screen where every other line fitted.
   */
  it('the find --with footer fits the width, and never breaks a bridge in half', () => {
    const width = 80;
    const out = runCli([
      'find', 'pgbouncer', '--with', 'claude-mem,agentmemory,notes',
      '--width', String(width), '--potsherd-dir', tempPotsherdDir(),
    ]);
    const footer = out
      .split('\n')
      .filter((l) => /^\s{2}(claude-mem|agentmemory|notes):/.test(l));
    expect(footer.length).toBeGreaterThanOrEqual(1);
    for (const line of footer) expect([...line].length).toBeLessThanOrEqual(width);
    // Wrapped on the separator: every bridge named is followed by its own
    // sentence on the same line.
    for (const bridge of ['claude-mem', 'agentmemory', 'notes']) {
      expect(footer.join(' ')).toMatch(new RegExp(`${bridge}: \\S`));
    }
  });

  it('the find --with footer still fits when the terminal is narrow', () => {
    const width = 34;
    const out = runCli([
      'find', 'pgbouncer', '--with', 'claude-mem,agentmemory,notes',
      '--width', String(width), '--potsherd-dir', tempPotsherdDir(),
    ]);
    const footer = out
      .split('\n')
      .filter((l) => /^\s{2}(claude-mem|agentmemory|notes):/.test(l));
    expect(footer.length).toBe(3);
    for (const line of footer) expect([...line].length).toBeLessThanOrEqual(width);
  });
});
