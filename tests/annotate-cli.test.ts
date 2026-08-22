import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  db as store,
  indexAll,
  linkSessions,
  normalizeTag,
  parseTagArgs,
  rescue,
  sessionLinks,
  stripAnsi,
} from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * `tag`, `pin`, `unpin`, `link` and the `ls` filters they feed (phase-2 T2.4),
 * plus `ls --resume-menu` (T2.5), through the shipped binary.
 *
 * Three things are held here that nothing else can hold:
 *
 *   **round trips.** A tag, a pin and a link are only worth writing if the
 *   session can be found again through them, so every writer is tested by
 *   finding its subject again with `ls`, never by reading the table back.
 *
 *   **`--linked-to` from both ends.** `links` stores the pair as it was typed.
 *   Reading it from one column only is the bug this kind of table always
 *   ships, and it passes every test that links A to B and then looks for A.
 *
 *   **the filters compose.** Three at once has to mean all three.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');
const FIXTURE = path.join(repo, 'evals', 'fixture', 'claude');

/** Sessions and a ghost that exist in the eval fixture. */
const OFFLINE = 'c2f68b40'; // Offline queue replays stale writes  (claude, live)
const PUSH = '8d31f7c5'; // Push notifications arrive twice on android
const PGBOUNCER = '0a2fbf9b'; // Pin the pgbouncer pool size
const GHOST = 'e83f5c17'; // the ci runner is out of disk again    (ghost)

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

function json<T>(args: string[]): T {
  const r = run([...args, '--json']);
  expect(r.stderr, `stderr: ${r.stderr}`).toBe('');
  return JSON.parse(r.stdout) as T;
}

/**
 * The widest line, in **characters** after ANSI is stripped — the same count
 * `python3 len()` gives, and not the one `wc -c` or `awk` gives: `ls` prints
 * `·`, `↳`, `→`, `…` and `★`, every one of which is several bytes and one
 * column. A byte count passes a line that wraps.
 */
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

interface LsJson {
  total: number;
  shown: number;
  ghosts: number;
  filters: Record<string, unknown>;
  resumeMenu?: { id: string; title: string; command: string; line: string }[];
  sessions: {
    id: string;
    displayTitle: string;
    cardTitle: string | null;
    status: string;
    harness: string;
    pinned: boolean;
    tags: string[];
    resume: string | null;
  }[];
}

const ids = (j: LsJson): string[] => j.sessions.map((s) => s.id);

/**
 * The first user prompt of a session, read back through the shipped binary.
 *
 * `--untitled`'s new definition is about where a title came from, and a test
 * that decided that from the *shape* of the string would be asserting the
 * regex it was written against. This reads the session.
 */
function firstUserPrompt(id: string): string | null {
  const j = json<{ exchanges?: { userText?: string | null }[] }>(['show', id.slice(0, 8)]);
  for (const e of j.exchanges ?? []) {
    const t = (e.userText ?? '').trim();
    if (t) return t;
  }
  return null;
}

/**
 * `rescue.ts`'s stopping rule, restated here on purpose.
 *
 * A test that imported the rule would pass whatever the rule became; this file
 * asserts the *behaviour* the rule is supposed to produce, so it spells out
 * what `phase-8-hardening.md` §8.2 asked for — not a slash command, at least
 * eight characters, and not one of seven conversational stopwords — and will
 * fail if the shipped rule drifts away from it.
 */
function isNotSubstantive(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  const stop = new Set(['clear', 'continue', 'ok', 'yes', 'hi', 'y', 'n']);
  return (
    clean === '' || clean.startsWith('/') || [...clean].length < 8 || stop.has(clean.toLowerCase())
  );
}

beforeAll(async () => {
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
  root = tempDir('potsherd-annotate-');
  dirs.push(root);
  await rescue({ claudeDir: FIXTURE, root, ghostsOnly: true, quiet: true });
  await indexAll({ root, claudeDir: FIXTURE, harnesses: ['claude'], embed: false, full: true });
}, 120_000);

afterAll(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

describe('normalizeTag', () => {
  it('folds what people actually type onto one tag', () => {
    for (const raw of ['postgres', 'Postgres', '  POSTGRES ', '+postgres', '-postgres']) {
      expect(normalizeTag(raw)).toBe('postgres');
    }
    expect(normalizeTag('open threads')).toBe('open-threads');
    expect(normalizeTag('open_threads')).toBe('open-threads');
    expect(normalizeTag('infra/postgres')).toBe('infra/postgres');
  });

  it('refuses what cannot be a tag rather than storing an empty string', () => {
    for (const raw of ['', '   ', '+', '-', '!!!', '###']) expect(normalizeTag(raw)).toBeNull();
  });

  it('caps the length without leaving a trailing hyphen', () => {
    const tag = normalizeTag('a'.repeat(40) + '-' + 'b'.repeat(10))!;
    expect(tag.length).toBeLessThanOrEqual(32);
    expect(tag.endsWith('-')).toBe(false);
  });
});

describe('parseTagArgs', () => {
  it('reads +add, -remove and a bare word as add', () => {
    const parsed = parseTagArgs(['+postgres', '-mysql', 'rls']);
    expect(parsed.add).toEqual(['postgres', 'rls']);
    expect(parsed.remove).toEqual(['mysql']);
    expect(parsed.rejected).toEqual([]);
  });

  it('names what it could not use instead of silently dropping it', () => {
    expect(parseTagArgs(['+ok', '+!!!']).rejected).toEqual(['+!!!']);
  });
});

describe('tag', () => {
  it('adds tags and finds the session again through ls --tag', () => {
    expect(run(['tag', OFFLINE, '+postgres', '+infra']).code).toBe(0);
    const found = json<LsJson>(['ls', '--tag', 'postgres']);
    expect(found.sessions.length).toBe(1);
    expect(found.sessions[0]!.id.startsWith(OFFLINE)).toBe(true);
    expect(found.sessions[0]!.tags).toEqual(['infra', 'postgres']);
  });

  it('adds and removes in one invocation, with -tag surviving the argv parser', () => {
    // `-infra` is `-i -n -f -r -a` to any getopt-shaped parser, and `-v2` is
    // `--version`: both would have been eaten before the command ever ran.
    const r = run(['tag', OFFLINE, '-infra', '+rls', '-v2', '--width', '80']);
    expect(r.code).toBe(0);
    const j = json<{ tags: string[]; added: string[]; removed: string[] }>(['tag', OFFLINE]);
    expect(j.tags).toEqual(['postgres', 'rls']);
    expect(r.stdout).not.toMatch(/^\d+\.\d+\.\d+$/m);
  });

  it('lists what a session carries when given no +/- argument', () => {
    const r = run(['tag', OFFLINE, '--width', '80']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('#postgres');
    expect(r.stdout).toContain('#rls');
  });

  it('matches --tag whatever the case it was typed in, on both sides', () => {
    expect(ids(json<LsJson>(['ls', '--tag', 'PostGres']))).toEqual(
      ids(json<LsJson>(['ls', '--tag', 'postgres'])),
    );
  });

  it('tags a ghost — the sessions worth marking are the deleted ones', () => {
    expect(run(['tag', GHOST, '+ci']).code).toBe(0);
    const j = json<LsJson>(['ls', '--tag', 'ci']);
    expect(j.sessions.length).toBe(1);
    expect(j.sessions[0]!.status).toBe('ghost');
  });

  it('says so and names the fix when the session id is not there', () => {
    const r = run(['tag', 'zzzzzzzz', '+nope']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('potsherd ls');
    expect(r.stderr).not.toContain('    at ');
    expect(r.stdout).toBe('');
  });

  it('refuses a word with nothing tag-like in it', () => {
    const r = run(['tag', OFFLINE, '+!!!']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('letters, digits');
  });

  it('--json carries the tags, the change and what it ignored', () => {
    const j = json<{
      session: { id: string; title: string };
      tags: string[];
      added: string[];
      removed: string[];
      rejected: string[];
    }>(['tag', PGBOUNCER, '+pgbouncer']);
    expect(j.session.id).toMatch(/^0a2fbf9b-/);
    expect(j.added).toEqual(['pgbouncer']);
    expect(j.tags).toContain('pgbouncer');
    expect(j.rejected).toEqual([]);
    run(['tag', PGBOUNCER, '-pgbouncer']);
  });
});

describe('pin', () => {
  it('pins, marks the row with a star and finds it again through ls --pinned', () => {
    expect(run(['pin', PUSH]).code).toBe(0);
    const j = json<LsJson>(['ls', '--pinned']);
    expect(j.sessions.length).toBe(1);
    expect(j.sessions[0]!.pinned).toBe(true);
    expect(run(['ls', '--pinned', '--width', '80']).stdout).toContain('★');
  });

  it('is idempotent, and says it changed nothing rather than restamping it', () => {
    const first = json<{ pinnedAt: string; changed: boolean }>(['pin', PUSH]);
    const second = json<{ pinnedAt: string; changed: boolean }>(['pin', PUSH]);
    expect(second.changed).toBe(false);
    expect(second.pinnedAt).toBe(first.pinnedAt);
  });

  it('unpins again', () => {
    expect(run(['unpin', PUSH]).code).toBe(0);
    expect(json<LsJson>(['ls', '--pinned']).sessions.length).toBe(0);
    // Put it back: the composed-filter and width cases below want a pin.
    run(['pin', PUSH]);
  });

  it('pins a ghost, which has no row in `sessions` to key on', () => {
    expect(run(['pin', GHOST]).code).toBe(0);
    const j = json<LsJson>(['ls', '--pinned', '--ghosts', 'only']);
    expect(j.sessions.map((s) => s.status)).toEqual(['ghost']);
    run(['unpin', GHOST]);
  });

  it('says so and names the fix when the session id is not there', () => {
    const r = run(['pin', 'zzzzzzzz']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('potsherd ls');
    expect(r.stderr).not.toContain('    at ');
  });
});

describe('link', () => {
  it('links two sessions and finds each of them from the other side', () => {
    expect(run(['link', OFFLINE, PUSH, '--note', 'same offline sync bug']).code).toBe(0);

    // The half every implementation gets right.
    const forward = json<LsJson>(['ls', '--linked-to', OFFLINE]);
    expect(forward.sessions.length).toBe(1);
    expect(forward.sessions[0]!.id.startsWith(PUSH)).toBe(true);

    // The half that is the bug: the reference was recorded as the `b` column.
    const back = json<LsJson>(['ls', '--linked-to', PUSH]);
    expect(back.sessions.length).toBe(1);
    expect(back.sessions[0]!.id.startsWith(OFFLINE)).toBe(true);
  });

  it('links a ghost to a live session, and reads it from the ghost end', () => {
    expect(run(['link', GHOST, PGBOUNCER]).code).toBe(0);
    expect(ids(json<LsJson>(['ls', '--linked-to', GHOST]))[0]).toMatch(/^0a2fbf9b-/);
    const fromLive = json<LsJson>(['ls', '--linked-to', PGBOUNCER]);
    expect(fromLive.sessions[0]!.status).toBe('ghost');
  });

  it('refuses to link a session to itself', () => {
    const r = run(['link', OFFLINE, OFFLINE]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('itself');
  });

  it('records the pair once, whichever way round it is typed again', () => {
    const again = json<{ created: boolean; reversed: boolean }>([
      'link',
      PUSH,
      OFFLINE,
      '--note',
      'still the same bug',
    ]);
    expect(again.created).toBe(false);
    expect(again.reversed).toBe(true);
    // One link, not two rows saying one thing.
    expect(json<LsJson>(['ls', '--linked-to', OFFLINE]).sessions.length).toBe(1);
  });

  it('--remove takes it away from either side', () => {
    run(['link', PGBOUNCER, PUSH]);
    expect(json<LsJson>(['ls', '--linked-to', PUSH]).sessions.length).toBe(2);
    expect(run(['link', PUSH, PGBOUNCER, '--remove']).code).toBe(0);
    expect(json<LsJson>(['ls', '--linked-to', PUSH]).sessions.length).toBe(1);
  });

  it('names the candidates rather than guessing on an ambiguous prefix', () => {
    const r = run(['link', 'a', PUSH]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('matches');
    expect(r.stderr).not.toContain('    at ');
  });

  it('reads both directions at the library level too', () => {
    const db = store.open({ file: ':memory:' });
    try {
      linkSessions(db, 'A', 'B', 'because');
      expect(sessionLinks(db, 'A').map((l) => l.sessionId)).toEqual(['B']);
      expect(sessionLinks(db, 'B').map((l) => l.sessionId)).toEqual(['A']);
      expect(sessionLinks(db, 'B')[0]!.direction).toBe('in');
      // The mirror that must never become a second row.
      linkSessions(db, 'B', 'A');
      expect(sessionLinks(db, 'A').length).toBe(1);
    } finally {
      db.close();
    }
  });
});

/**
 * `--untitled` after 8.2, which is the flag's whole reason to keep existing.
 *
 * Until phase 8 the filter was "no card title and no `s.title`", and every row
 * it returned rendered as `<project-slug>-<id8>` — so `/-[0-9a-f]{8}$/` was a
 * complete description of the answer. `index` now names a session the harness
 * left unnamed after its first substantive prompt, and that regex stops being
 * true of anything.
 *
 * The flag did not therefore stop meaning something. `title_source` records
 * who wrote the title, and `--untitled` means **"nothing a card would not
 * improve"**: the sessions with no title at all, plus the ones potsherd named
 * itself. What it must never contain is a session somebody *else* named — the
 * harness, from the whole transcript, or a card.
 *
 * These tests establish that from both ends: every returned row is one of the
 * two admissible kinds, and every session with a harness title is absent.
 */
describe('ls --untitled', () => {
  it('lists the sessions nothing but potsherd has named, and no others', () => {
    const j = json<LsJson>(['ls', '--untitled', '--limit', '50']);
    expect(j.sessions.length).toBeGreaterThan(0);

    // The premise this file needs and does not get to assume: the derivation
    // ran on this corpus. Without a row whose title is a prompt rather than a
    // uuid, everything below would pass against the old behaviour too.
    const derived = j.sessions.filter((s) => !/-[0-9a-f]{8}$/.test(s.displayTitle));
    expect(derived.length, 'no session was named by its prompt').toBeGreaterThan(0);

    for (const s of j.sessions) {
      // A card is the one title `--untitled` is asking for and never has.
      expect(s.cardTitle, s.displayTitle).toBeNull();
      // Every row is either still nameless — the uuid fallback — or carries a
      // title potsherd derived. `show --json` says which, from the session's
      // own prompts rather than from the shape of the string.
      if (/-[0-9a-f]{8}$/.test(s.displayTitle)) {
        const first = firstUserPrompt(s.id);
        expect(
          first === null || isNotSubstantive(first),
          `${s.displayTitle} kept its uuid but opens with: ${first}`,
        ).toBe(true);
      } else {
        const first = firstUserPrompt(s.id);
        expect(first, s.displayTitle).not.toBeNull();
        // The stored title is the opening of that prompt, cut — not a summary
        // of it, and not some other exchange's words.
        expect(first!.replace(/\s+/g, ' ').startsWith(s.displayTitle)).toBe(true);
      }
    }
  });

  it('excludes the sessions the harness did name', () => {
    const untitled = new Set(ids(json<LsJson>(['ls', '--untitled', '--limit', '50'])));
    // "Named by the harness" cannot be read off `displayTitle` any more — a
    // derived title looks like prose too. It is read off the session: a
    // harness title is one no prompt in the transcript begins with.
    const all = json<LsJson>(['ls', '--limit', '50']).sessions;
    const harnessNamed = all.filter((s) => {
      if (/-[0-9a-f]{8}$/.test(s.displayTitle)) return false;
      const first = firstUserPrompt(s.id);
      return first === null || !first.replace(/\s+/g, ' ').startsWith(s.displayTitle);
    });
    expect(harnessNamed.length).toBeGreaterThan(0);
    for (const s of harnessNamed) expect(untitled.has(s.id), s.displayTitle).toBe(false);
  });

  it('does not list a ghost that its recovered prompts already name', () => {
    const j = json<LsJson>(['ls', '--untitled', '--ghosts', 'only', '--limit', '50']);
    // Every ghost in the fixture has a real opening prompt, which is a better
    // name than any uuid — so none of them is untitled.
    expect(j.sessions.length).toBe(0);
  });
});

describe('the filters compose', () => {
  it('three at once means all three', () => {
    // The pinned session carries no tags; the tagged one is not pinned. Each
    // pair is satisfiable, all three together are not — which is the only
    // shape that can tell an AND from a last-one-wins.
    const tagged = json<LsJson>(['ls', '--tag', 'postgres', '--harness', 'claude', '--since', '2020-01-01']);
    expect(tagged.sessions.length).toBe(1);
    expect(tagged.sessions[0]!.id.startsWith(OFFLINE)).toBe(true);

    const withPin = json<LsJson>(['ls', '--tag', 'postgres', '--pinned', '--harness', 'claude']);
    expect(withPin.sessions.length).toBe(0);

    const wrongHarness = json<LsJson>(['ls', '--tag', 'postgres', '--harness', 'codex', '--since', '2020-01-01']);
    expect(wrongHarness.sessions.length).toBe(0);
  });

  it('four at once, mixing a link with a tag, a date and a harness', () => {
    const j = json<LsJson>([
      'ls',
      '--linked-to', PUSH,
      '--tag', 'postgres',
      '--harness', 'claude',
      '--until', '2030-01-01',
    ]);
    expect(j.sessions.length).toBe(1);
    expect(j.sessions[0]!.id.startsWith(OFFLINE)).toBe(true);

    // Same link, a tag the other end does not carry: nothing.
    expect(
      json<LsJson>(['ls', '--linked-to', PUSH, '--tag', 'ci']).sessions.length,
    ).toBe(0);
  });

  it('reports the filters it applied, so the screenshot says what it shows', () => {
    const r = run(['ls', '--tag', 'postgres', '--pinned', '--untitled', '--width', '80']);
    expect(r.stdout).toContain('#postgres');
    expect(r.stdout).toContain('pinned');
    expect(r.stdout).toContain('untitled');
  });

  it('every filter reaches --json unchanged', () => {
    const j = json<LsJson>(['ls', '--tag', 'postgres', '--linked-to', PUSH, '--untitled']);
    expect(j.filters['tag']).toBe('postgres');
    expect(j.filters['untitled']).toBe(true);
    expect(String(j.filters['linkedTo'])).toMatch(/^8d31f7c5-/);
  });
});

describe('ls --resume-menu', () => {
  it('is paste-able into a shell: every line is a command or a comment', () => {
    const r = run(['ls', '--resume-menu', '--width', '80']);
    expect(r.code).toBe(0);
    const lines = stripAnsi(r.stdout).split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line.startsWith('#') || /^(claude --resume|codex resume) /.test(line), line).toBe(true);
    }
    // …and `sh` agrees it is a script.
    const file = path.join(root, 'resume-menu.sh');
    fs.writeFileSync(file, r.stdout);
    expect(() => execFileSync('sh', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });

  it('prints `claude --resume <id>  # <title>` with a real title', () => {
    const r = run(['ls', '--resume-menu', '--width', '80', '--limit', '6']);
    expect(r.stdout).toMatch(/claude --resume [0-9a-f-]{36} {2}# \S/);
    expect(r.stdout).toContain('Offline queue');
  });

  it('says why potsherd does not write the titles into ~/.claude instead', () => {
    expect(run(['ls', '--resume-menu', '--width', '80']).stdout).toContain('directory');
    // The same reason has to be in --help, where someone looks for it.
    const help = run(['ls', '--help']).stdout;
    expect(help).toContain('--resume-menu');
    expect(help).toContain("does not write into another tool's directory");
  });

  it('never truncates a resume command, even at 60 columns', () => {
    for (const width of ['80', '60']) {
      const out = stripAnsi(run(['ls', '--resume-menu', '--width', width, '--limit', '5']).stdout);
      for (const line of out.split('\n')) {
        if (line.startsWith('#') || !line.trim()) continue;
        // Half a uuid is a command that fails; the title gives ground instead.
        expect(line, `at ${width}: ${line}`).toMatch(
          /^(claude --resume|codex resume) [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}( {2}# .*)?$/,
        );
      }
    }
  });

  it('offers no command for a session that cannot be resumed, and says how many', () => {
    const r = run(['ls', '--resume-menu', '--ghosts', 'only', '--width', '80']);
    expect(r.stdout).not.toContain('claude --resume ');
    expect(r.stdout).toContain('nothing here can be resumed');
  });

  it('--json carries the same lines the human view printed', () => {
    const j = json<LsJson>(['ls', '--resume-menu', '--limit', '6']);
    expect(j.resumeMenu!.length).toBeGreaterThan(0);
    for (const entry of j.resumeMenu!) {
      expect(entry.line).toBe(`${entry.command}  # ${entry.title}`);
      expect(entry.command).toMatch(/^(claude --resume|codex resume) /);
    }
  });
});

describe('ls stays a screenshot with tags and pins on it', () => {
  const CASES: [string, string[]][] = [
    ['ls', ['ls']],
    ['ls --pinned', ['ls', '--pinned']],
    ['ls --tag postgres', ['ls', '--tag', 'postgres']],
    ['ls --linked-to', ['ls', '--linked-to', OFFLINE]],
    ['ls --untitled', ['ls', '--untitled']],
    ['ls --resume-menu', ['ls', '--resume-menu', '--limit', '6']],
    ['tag (listing)', ['tag', OFFLINE]],
    ['tag (change)', ['tag', OFFLINE, '+wide-tag-name-here', '-wide-tag-name-here']],
    ['pin', ['pin', PUSH]],
    ['link', ['link', OFFLINE, PUSH, '--note', 'a note long enough to need eliding at sixty columns']],
  ];

  for (const [name, args] of CASES) {
    for (const width of ['80', '60']) {
      it(`${name} fits ${width} columns`, () => {
        const r = run([...args, '--width', width]);
        expect(r.code).toBe(0);
        const { width: got, line } = widest(r.stdout);
        expect(got, `widest line (${got}): ${line}`).toBeLessThanOrEqual(Number(width));
      });

      it(`${name} is pure ASCII under --ascii at ${width}`, () => {
        const r = run([...args, '--width', width, '--ascii']);
        expect(r.code).toBe(0);
        // eslint-disable-next-line no-control-regex
        expect(stripAnsi(r.stdout), name).toMatch(/^[\x00-\x7f]*$/);
        const { width: got, line } = widest(r.stdout);
        expect(got, `widest --ascii line (${got}): ${line}`).toBeLessThanOrEqual(Number(width));
      });
    }
  }

  it('shows the tags after the title and a ★ in front of a pinned one', () => {
    const out = run(['ls', '--width', '80']).stdout;
    // The tags are the shortest, most exact thing on the row and the only part
    // the user wrote: the title gives ground before they do.
    expect(out).toMatch(/#postgres/);
    expect(out).toContain('★');
  });

  it('still fits an 80x24 screenshot with annotations on the rows', () => {
    expect(run(['ls', '--width', '80']).stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(24);
  });

  it('--json carries the tags, the pin and the card title slot', () => {
    const j = json<LsJson>(['ls', '--limit', '50']);
    const offline = j.sessions.find((s) => s.id.startsWith(OFFLINE))!;
    expect(offline.tags).toContain('postgres');
    expect(offline.cardTitle).toBeNull(); // no cards yet — the slot exists
    expect(j.sessions.find((s) => s.id.startsWith(PUSH))!.pinned).toBe(true);
  });
});
