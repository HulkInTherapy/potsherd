import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { db as store } from '../packages/core/src/index.js';
import {
  addIgnored,
  applyIgnore,
  countIgnoredSessions,
  ignoredProjectsInIndex,
  isIgnoredProject,
  matchesIgnoreEntry,
  normalizeIgnoreEntry,
  readIgnoreConfig,
  readIgnoreList,
  removeIgnored,
  rootForDb,
  writeIgnoreList,
} from '../packages/core/src/ignore.js';
import { listSessions } from '../packages/core/src/browse.js';
import { recall } from '../packages/core/src/recall.js';
import { stats } from '../packages/core/src/stats.js';
import { ask, type AskReaderFn } from '../packages/core/src/ask.js';
import { configPath } from '../packages/core/src/paths.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * The ignore list (phase 8, 8.4).
 *
 * `potsherd ignore <project>` exists because on the reference machine 9 of the
 * top 15 `ls` rows were potsherd's own worker and sdk sessions and `find
 * pgbouncer` returned potsherd's own test sessions first. Nothing was broken:
 * the archive was complete, and completeness is what buried the user's work.
 *
 * **Every premise in this file is built by this file.** No test here reads the
 * developer's `~/.potsherd`, and no test asserts anything about a project that
 * happens to exist on the machine running it: each one plants its own index in
 * its own temp root, writes its own `config.json`, and then asks what the
 * engine does. That matters more here than usual — the feature under test is a
 * rule about the *machine's* directory names, and a test that borrowed one
 * would pass on exactly one laptop.
 *
 * Three properties are load-bearing and each has a test that would fail if it
 * were quietly dropped:
 *
 *   1. nothing is ignored by default;
 *   2. nothing is ever hidden silently — every surface reports a count;
 *   3. `ask` honours the list through `recall`, with nobody passing it a root.
 */

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmrf(dir);
});

function scratch(): string {
  const dir = tempDir('potsherd-ignore-test-');
  created.push(dir);
  return dir;
}

const MINE = '/tmp/potsherd-ignore-mine/event-bus';
const THEIRS = '/tmp/potsherd-ignore-theirs/potsherd';
const WORKTREE = '/tmp/potsherd-ignore-theirs/potsherd/wt/w3';

/**
 * Three sessions and one ghost across three projects: one the user cares
 * about, and two under a directory they would want to stop seeing.
 *
 * The two "theirs" projects are deliberately a checkout and a worktree *under*
 * it, because that is the shape the feature exists for and the shape a
 * whole-path match would get wrong.
 */
function seed(): { root: string; db: ReturnType<typeof store.open> } {
  const root = scratch();
  const db = store.open({ root });
  const session = db.prepare(
    `INSERT INTO sessions (id, harness, title, project, project_slug, source_path, status,
        is_sidechain, started_at, ended_at, user_prompts, assistant_turns, bytes, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const rows: [string, string, string][] = [
    ['s-mine', 'the pooler decision', MINE],
    ['s-theirs', 'worker brief for the ignore list', THEIRS],
    ['s-worktree', 'a second worker on the same build', WORKTREE],
  ];
  let day = 1;
  for (const [id, title, project] of rows) {
    const when = `2026-08-0${String(day++)}T09:00:00.000Z`;
    session.run(id, 'claude', title, project, project.replace(/\//g, '-'),
      `${project}/x.jsonl`, 'live', 0, when, when, 1, 1, 100, '2026-08-09T00:00:00.000Z');
  }
  const exchange = db.prepare(
    `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text, files_touched)
     VALUES (?,?,?,?,?,?,?)`,
  );
  exchange.run('e-mine', 's-mine', 1, '2026-08-01T09:00:00.000Z',
    'the pooler is 500ing on deploy',
    'pgbouncer in transaction mode cannot carry prepared statements, so we set ' +
      'statement_cache_size=0 on the client.',
    '[]');
  exchange.run('e-theirs', 's-theirs', 1, '2026-08-02T09:00:00.000Z',
    'write the pgbouncer test fixture',
    'pgbouncer appears in the fixture only as a search term.',
    '[]');
  exchange.run('e-worktree', 's-worktree', 1, '2026-08-03T09:00:00.000Z',
    'check pgbouncer again',
    'pgbouncer, once more, in a worktree of the same build.',
    '[]');
  db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");

  db.prepare(
    `INSERT INTO ghosts (session_id, harness, project, first_ts, last_ts, prompt_count,
        first_prompt, title) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('g-theirs', 'claude', THEIRS, '2026-08-04T09:00:00.000Z', '2026-08-04T09:30:00.000Z',
    1, 'a deleted session in their build', 'a deleted session in their build');
  db.prepare(
    'INSERT INTO ghost_prompts (id, session_id, seq, ts, text) VALUES (?,?,?,?,?)',
  ).run('gp1', 'g-theirs', 1, '2026-08-04T09:00:00.000Z', 'a deleted session in their build');
  db.exec("INSERT INTO ghost_prompts_fts(ghost_prompts_fts) VALUES('rebuild')");
  return { root, db };
}

// --------------------------------------------------------------- storage

describe('the ignore list, stored', () => {
  it('is empty on a fresh install, and nothing ships in it', () => {
    const root = scratch();
    expect(readIgnoreList(root)).toEqual([]);
    expect(fs.existsSync(configPath(root))).toBe(false);
    // The point of the assertion is the *absence of a default*. A shipped list
    // — or a "this looks like a build directory" guess — would be potsherd
    // deciding which of somebody's work did not count.
    const { db } = seed();
    const listed = listSessions(db, {}, { limit: 10, root });
    expect(listed.ignored.entries).toEqual([]);
    expect(listed.ignored.hidden).toBe(0);
    expect(listed.sessions).toHaveLength(4);
    db.close();
  });

  it('writes config.json, is idempotent, and takes an entry back', () => {
    const root = scratch();
    const added = addIgnored(root, 'potsherd');
    expect(added.changed).toBe(true);
    expect(added.list).toEqual(['potsherd']);
    expect(JSON.parse(fs.readFileSync(configPath(root), 'utf8'))).toEqual({
      ignore: ['potsherd'],
    });

    const again = addIgnored(root, 'potsherd');
    expect(again.changed).toBe(false);
    expect(again.list).toEqual(['potsherd']);

    const gone = removeIgnored(root, 'potsherd');
    expect(gone.changed).toBe(true);
    expect(gone.list).toEqual([]);
    expect(removeIgnored(root, 'potsherd').changed).toBe(false);
  });

  it('leaves every key it does not own alone', () => {
    const root = scratch();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      configPath(root),
      JSON.stringify({ cardOnEnd: true, theme: { width: 100 } }, null, 2),
    );
    addIgnored(root, 'scratch');
    const after = JSON.parse(fs.readFileSync(configPath(root), 'utf8')) as Record<string, unknown>;
    expect(after['cardOnEnd']).toBe(true);
    expect(after['theme']).toEqual({ width: 100 });
    expect(after['ignore']).toEqual(['scratch']);
  });

  it('says a config it cannot read is unreadable rather than reporting an empty list', () => {
    const root = scratch();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(configPath(root), '{ this is not json');
    const config = readIgnoreConfig(root);
    expect(config.list).toEqual([]);
    expect(config.error).toBeTruthy();

    // Same for a well-formed file with the wrong shape under our own key: "you
    // ignore nothing" and "I could not read your settings" are different facts.
    fs.writeFileSync(configPath(root), JSON.stringify({ ignore: 'potsherd' }));
    expect(readIgnoreConfig(root).error).toBeTruthy();
  });

  it('normalises what the user typed, once, on the way in', () => {
    expect(normalizeIgnoreEntry('  potsherd/  ')).toBe('potsherd');
    expect(normalizeIgnoreEntry('~/code/potsherd')).toBe(
      path.join(process.env['HOME'] ?? '~', 'code', 'potsherd'),
    );
    const root = scratch();
    // Case and a trailing slash are not two different entries.
    expect(writeIgnoreList(root, ['Potsherd', 'potsherd/', 'randomness'])).toEqual([
      'Potsherd',
      'randomness',
    ]);
  });
});

// ------------------------------------------------------------- predicate

describe('what an entry matches', () => {
  it('matches a whole path segment, anywhere in the path', () => {
    expect(matchesIgnoreEntry('/home/dev/potsherd', 'potsherd')).toBe(true);
    expect(matchesIgnoreEntry('/home/dev/potsherd/wt/w3', 'potsherd')).toBe(true);
    expect(matchesIgnoreEntry('/home/dev/randomness/potsherd', 'randomness')).toBe(true);
    expect(matchesIgnoreEntry('/home/dev/POTSHERD', 'potsherd')).toBe(true);
  });

  it('never matches half a segment', () => {
    // `ignore core` hiding `core-app` would be a filter the user cannot see
    // and cannot predict. The segment has to be the whole segment.
    expect(matchesIgnoreEntry('/home/dev/core-app', 'core')).toBe(false);
    expect(matchesIgnoreEntry('/home/dev/potsherd-notes', 'potsherd')).toBe(false);
    expect(matchesIgnoreEntry('/home/dev/notpotsherd', 'potsherd')).toBe(false);
  });

  it('treats an entry with a slash in it as a path, and only that path', () => {
    expect(matchesIgnoreEntry('/home/dev/work/scratch', '/home/dev/work/scratch')).toBe(true);
    expect(matchesIgnoreEntry('/home/dev/work/scratch/sub', '/home/dev/work/scratch')).toBe(true);
    expect(matchesIgnoreEntry('/home/dev/spare/work/scratch', '/home/dev/work/scratch')).toBe(false);
    // and not as a segment: a path entry is exact about where it is
    expect(matchesIgnoreEntry('/elsewhere/scratch', '/home/dev/work/scratch')).toBe(false);
  });

  it('never matches a project it was not given', () => {
    expect(matchesIgnoreEntry(null, 'potsherd')).toBe(false);
    expect(matchesIgnoreEntry('', 'potsherd')).toBe(false);
    expect(matchesIgnoreEntry('/home/dev/potsherd', '')).toBe(false);
    expect(isIgnoredProject('/home/dev/app', [])).toBe(false);
  });
});

describe('finding the config beside an open database', () => {
  it('answers with the database file own directory', () => {
    const { root, db } = seed();
    expect(rootForDb(db)).toBe(fs.realpathSync(root));
    db.close();
  });

  it('answers null for a database with no file, rather than guessing', () => {
    const db = store.open({ file: ':memory:' });
    expect(rootForDb(db)).toBe(null);
    db.close();
  });
});

// ------------------------------------------------------------------- ls

describe('ls honours the list, and says that it did', () => {
  it('drops the ignored projects, counts what it dropped, and --all brings them back', () => {
    const { root, db } = seed();
    addIgnored(root, 'potsherd');

    const hidden = listSessions(db, {}, { limit: 10, root });
    expect(hidden.sessions.map((s) => s.id)).toEqual(['s-mine']);
    expect(hidden.ignored.entries).toEqual(['potsherd']);
    // Both the checkout and the worktree under it, from one entry.
    expect(hidden.ignored.projects).toEqual([THEIRS, WORKTREE]);
    // Two sessions and one ghost: a ghost is a row in this list like any other,
    // so it is a row this list hid.
    expect(hidden.ignored.hidden).toBe(3);
    expect(hidden.total).toBe(1);

    const all = listSessions(db, {}, { limit: 10, root, all: true });
    expect(all.sessions).toHaveLength(4);
    expect(all.ignored.hidden).toBe(0);
    // `--all` still reports the list it chose not to apply, so the flag does
    // not quietly become a different command.
    expect(all.ignored.entries).toEqual(['potsherd']);
    db.close();
  });

  it('counts rows this listing lost, not the size of the ignored projects', () => {
    const { root, db } = seed();
    addIgnored(root, 'potsherd');
    // Only one of the three ignored rows is inside the window, so only one was
    // hidden *from this listing*. Reporting 3 here would be a true number about
    // something the user did not ask.
    const since = listSessions(db, { since: '2026-08-03' }, { limit: 10, root });
    expect(since.ignored.hidden).toBe(2);
    db.close();
  });

  it('does not argue with a user who named the project', () => {
    const { root, db } = seed();
    addIgnored(root, 'potsherd');
    const named = listSessions(db, { project: THEIRS }, { limit: 10, root });
    expect(named.sessions.map((s) => s.id).sort()).toEqual(['g-theirs', 's-theirs']);
    expect(named.ignored.hidden).toBe(0);
    db.close();
  });

  it('takes an entry back', () => {
    const { root, db } = seed();
    addIgnored(root, 'potsherd');
    removeIgnored(root, 'potsherd');
    expect(listSessions(db, {}, { limit: 10, root }).sessions).toHaveLength(4);
    db.close();
  });
});

// ----------------------------------------------------------------- find

describe('find honours the list', () => {
  it('leaves the ignored projects out of the results and says so', async () => {
    const { root, db } = seed();
    const before = await recall(db, 'pgbouncer', {}, { root });
    expect(before.sessions.map((s) => s.id).sort()).toEqual(['s-mine', 's-theirs', 's-worktree']);
    expect(before.ignored.hidden).toBe(0);

    addIgnored(root, 'potsherd');
    const after = await recall(db, 'pgbouncer', {}, { root });
    expect(after.sessions.map((s) => s.id)).toEqual(['s-mine']);
    // `find` reports what it did not search, not what it dropped: two sessions
    // and one ghost in the two ignored projects.
    expect(after.ignored.hidden).toBe(3);
    expect(after.ignored.projects).toEqual([THEIRS, WORKTREE]);

    const all = await recall(db, 'pgbouncer', {}, { root, all: true });
    expect(all.sessions).toHaveLength(3);
    expect(all.ignored.hidden).toBe(0);
    db.close();
  });

  it('finds the config with no root passed at all', async () => {
    // The mechanism `ask` depends on. `ask` calls `recall` and never passes an
    // ignore option; when it has no `root` either, the list still has to be
    // found — from the file the connection actually opened.
    const { root, db } = seed();
    addIgnored(root, 'potsherd');
    const found = await recall(db, 'pgbouncer', {}, {});
    expect(found.sessions.map((s) => s.id)).toEqual(['s-mine']);
    db.close();
  });
});

// ------------------------------------------------------------------ ask

describe('ask honours the list, through recall', () => {
  it('never hands an ignored session to a reader', async () => {
    const { root, db } = seed();
    const seen: string[] = [];
    const readerFn: AskReaderFn = async (input) => {
      seen.push(input.sessionId);
      return { found: false, quotes: [], answer_fragment: '' };
    };

    const before = await ask(db, 'pgbouncer', {
      root,
      readerFn,
      openThreads: false,
    });
    expect(seen.sort()).toEqual(['s-mine', 's-theirs', 's-worktree']);
    expect(before.searched).toBe(3);

    seen.length = 0;
    addIgnored(root, 'potsherd');
    const after = await ask(db, 'pgbouncer', {
      root,
      readerFn,
      openThreads: false,
    });
    // The whole claim: `ask` grew no ignore option of its own. It shortlists
    // through `recall`, and `recall` applies the list — so an ignored project
    // is out of the readers' reach, not merely off the `find` screen.
    expect(seen).toEqual(['s-mine']);
    expect(after.searched).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------- stats

describe('stats honours the list, and says that it did', () => {
  it('leaves ignored projects out of the counts, and --all puts them back', () => {
    const { root, db } = seed();
    const before = stats(db, { root, freshness: false });
    expect(before.totals.sessions).toBe(3);
    expect(before.totals.ghosts).toBe(1);
    expect(before.totals.exchanges).toBe(3);
    expect(before.ignored.hidden).toBe(0);

    addIgnored(root, 'potsherd');
    const after = stats(db, { root, freshness: false });
    expect(after.totals.sessions).toBe(1);
    expect(after.totals.ghosts).toBe(0);
    // The exchange count moves with the session count. A card whose sessions
    // row excluded a project and whose exchanges row did not would fail its
    // own arithmetic.
    expect(after.totals.exchanges).toBe(1);
    expect(after.ignored.hidden).toBe(3);

    const all = stats(db, { root, freshness: false, all: true });
    expect(all.totals.sessions).toBe(3);
    expect(all.ignored.hidden).toBe(0);
    expect(all.ignored.entries).toEqual(['potsherd']);
    db.close();
  });

  it('leaves index health alone — ignoring is a view of your history, not of potsherd', () => {
    const { root, db } = seed();
    addIgnored(root, 'potsherd');
    const report = stats(db, { root, freshness: true });
    // `indexed` is every row in `sessions`, ignored or not: a user chasing a
    // stale index needs the whole of it.
    expect(report.freshness.indexed).toBe(3);
    db.close();
  });
});

// --------------------------------------------------------------- helpers

describe('resolving the list against an index', () => {
  it('names the projects that are actually there, and counts their sessions', () => {
    const { root, db } = seed();
    expect(ignoredProjectsInIndex(db, ['potsherd'])).toEqual([THEIRS, WORKTREE]);
    expect(ignoredProjectsInIndex(db, ['nothing-called-this'])).toEqual([]);
    expect(countIgnoredSessions(db, [THEIRS, WORKTREE])).toBe(3);
    expect(countIgnoredSessions(db, [])).toBe(0);

    // An entry that names nothing in the index applies nothing — and says why,
    // so a typo is not indistinguishable from a working filter.
    const miss = applyIgnore(db, {}, { root, entries: ['nothing-called-this'] });
    expect(miss.applied).toBe(false);
    expect(miss.reason).toBe('no-match');
    expect(applyIgnore(db, {}, { root, entries: ['potsherd'], all: true }).reason).toBe('all');
    expect(applyIgnore(db, { project: THEIRS }, { root, entries: ['potsherd'] }).reason).toBe(
      'named-project',
    );
    db.close();
  });
});
