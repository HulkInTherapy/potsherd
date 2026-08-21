import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  db as store,
  fallbackTitle,
  ftsQuery,
  idTag,
  indexAll,
  listSessions,
  recall,
  rescue,
  resolveSession,
  resumeCommand,
  sessionStats,
  showSession,
  type Db,
} from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * L6 — `find`, `ls`, `show`, `stats`.
 *
 * These run against `evals/fixture/claude`, the same invented corpus the
 * recall eval scores itself on, indexed here from scratch. Sharing it is
 * deliberate: the eval says "the right session comes back", these tests say
 * "and here is *why* it comes back and what the flags do to it", and neither
 * can drift from the other's idea of what is in the corpus.
 *
 * What the corpus holds, and why each piece is there:
 *   8 sessions      one of them untitled, so the `<slug>-<id8>` fallback is exercised
 *   2 sidechains    a subagent transcript whose text exists nowhere else
 *   3 ghosts        prompts only, from history.jsonl — no assistant side at all
 *   4 projects      so `--project` has something to be wrong about
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'evals', 'fixture', 'claude');

/** Known ids from `evals/fixture` — see `evals/queries.jsonl`. */
const ID = {
  pgbouncer: '0a2fbf9b',
  csv: 'a82ceb72',
  untitled: 'a0c57a31',
  bundle: '4ae3102b',
  fusion: 'cbcfda7e',
  ghostPrinter: 'e6aa5ba7',
  ghostBilling: '4ddd4b1f',
} as const;

let root: string;
let db: Db;
const dirs: string[] = [];

beforeAll(async () => {
  root = tempDir('potsherd-recall-');
  dirs.push(root);
  await rescue({ claudeDir: FIXTURE, root, ghostsOnly: true, quiet: true });
  await indexAll({ root, claudeDir: FIXTURE, harnesses: ['claude'], embed: false, full: true });
  db = store.open({ root });
}, 60_000);

afterAll(() => {
  db?.close();
  while (dirs.length) rmrf(dirs.pop()!);
});

const ids = (r: { sessions: { id: string }[] }): string[] => r.sessions.map((s) => s.id);
const has = (r: { sessions: { id: string }[] }, prefix: string): boolean =>
  ids(r).some((id) => id.startsWith(prefix));

describe('ftsQuery', () => {
  it('treats fts5 operators as words, not as syntax', () => {
    // Every one of these is a MATCH operator. If any reached fts5 unquoted the
    // query would either throw or mean something the user did not type.
    const q = ftsQuery('NEAR/3 AND OR NOT "unbalanced ^caret -minus *star');
    expect(q.and).toContain('"near"');
    expect(q.and).toContain('"and"');
    expect(q.and).not.toMatch(/(^| )NEAR\//);
    expect(q.and).not.toContain('^');
    expect(q.and).not.toContain('-minus');
  });

  it('never lets a quote out of the tokenizer', () => {
    // `"` is not a word character, so it can only ever be a separator. The
    // doubling in `ftsQuery` is belt and braces for the day the tokenizer
    // changes; what matters today is that no quote survives into the MATCH.
    expect(ftsQuery('a"b').and).toBe('"a" AND "b"');
    expect(ftsQuery('say "hi" now').and).toBe('"say" AND "hi" AND "now"');
  });

  it('runs an operator-only query without throwing', async () => {
    const r = await recall(db, 'AND OR NEAR', {}, { vectors: false });
    expect(Array.isArray(r.sessions)).toBe(true);
  });

  it('is empty for a query with no word characters', async () => {
    expect(ftsQuery('!!! ...').tokens).toEqual([]);
    const r = await recall(db, '!!!', {}, { vectors: false });
    expect(r.sessions).toEqual([]);
  });
});

describe('recall: what is in by default', () => {
  it('finds a subagent transcript — the words are nowhere else', async () => {
    const r = await recall(db, 'tree shaking icon set', {}, { vectors: false });
    expect(has(r, ID.bundle)).toBe(true);
    const hit = r.sessions.find((s) => s.id.startsWith(ID.bundle))!;
    expect(hit.isSidechain || hit.hits.some((h) => h.isSidechain)).toBe(true);
  });

  it('finds a ghost — a session with no transcript left at all', async () => {
    const r = await recall(db, 'brother laser printer driver', {}, { vectors: false });
    expect(has(r, ID.ghostPrinter)).toBe(true);
    expect(r.sessions[0]!.status).toBe('ghost');
    expect(r.sessions[0]!.resume).toBeNull();
  });

  it('finds an untitled session by its body', async () => {
    const r = await recall(db, 'webhook rate limited by the gateway', {}, { vectors: false });
    expect(has(r, ID.untitled)).toBe(true);
    const s = r.sessions.find((x) => x.id.startsWith(ID.untitled))!;
    expect(s.title).toBeNull();
    expect(s.displayTitle).toBe(fallbackTitle(s.project, s.id));
    expect(s.displayTitle).toMatch(/^potsherd-eval-api-a0c57a31$/);
  });

  it('finds a session by its title even when the body never says those words', async () => {
    const r = await recall(db, 'pin the prepared-statement setting', {}, { vectors: false });
    expect(has(r, ID.pgbouncer)).toBe(true);
  });
});

describe('recall: the tri-state filters', () => {
  it('--sidechains exclude drops the subagent answer', async () => {
    const on = await recall(db, 'tree shaking icon set', { sidechains: 'include' }, { vectors: false });
    const off = await recall(db, 'tree shaking icon set', { sidechains: 'exclude' }, { vectors: false });
    expect(on.hits.some((h) => h.isSidechain)).toBe(true);
    expect(on.relaxed).toBe(false);
    // Without the subagent nothing in the corpus says "tree shaking", so the
    // exchange list has to fall back to any-word matching to answer at all.
    expect(off.hits.every((h) => !h.isSidechain)).toBe(true);
    expect(off.relaxed).toBe(true);
  });

  it('--sidechains only returns nothing but subagents', async () => {
    const r = await recall(db, 'the', { sidechains: 'only' }, { vectors: false });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.isSidechain)).toBe(true);
    expect(r.sessions.every((s) => s.kind === 'session')).toBe(true);
  });

  it('--ghosts only searches the deleted sessions and nothing else', async () => {
    const r = await recall(db, 'billing cron nightly backup', { ghosts: 'only' }, { vectors: false });
    expect(has(r, ID.ghostBilling)).toBe(true);
    expect(r.sessions.every((s) => s.status === 'ghost')).toBe(true);
  });

  it('--ghosts exclude loses the answer that only a ghost has', async () => {
    const r = await recall(db, 'brother laser printer driver', { ghosts: 'exclude' }, { vectors: false });
    expect(has(r, ID.ghostPrinter)).toBe(false);
  });

  it('--status ghost means the same as --ghosts only', async () => {
    const a = await recall(db, 'ppd file missing', { status: 'ghost' }, { vectors: false });
    const b = await recall(db, 'ppd file missing', { ghosts: 'only' }, { vectors: false });
    expect(ids(a)).toEqual(ids(b));
  });

  it('--project narrows to one project', async () => {
    const r = await recall(
      db,
      'the',
      { project: '/tmp/potsherd-eval-infra' },
      { vectors: false, limit: 20 },
    );
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.sessions.every((s) => s.project === '/tmp/potsherd-eval-infra')).toBe(true);
  });

  it('--since and --until bound the window', async () => {
    const all = await recall(db, 'the', {}, { vectors: false, limit: 50 });
    const june = await recall(db, 'the', { since: '2026-06-01' }, { vectors: false, limit: 50 });
    // The ghosts are from April; the sessions from June.
    expect(june.sessions.every((s) => s.status !== 'ghost')).toBe(true);
    expect(all.sessions.length).toBeGreaterThan(june.sessions.length);
  });

  it('rejects a date that is not a date', async () => {
    await expect(recall(db, 'x', { since: 'last tuesday' }, { vectors: false })).rejects.toThrow(
      /--since/,
    );
  });
});

describe('recall: fusion', () => {
  it('keeps at most three hits from one session (03 §7 diversification)', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    const perSession = new Map<string, number>();
    for (const h of r.hits) perSession.set(h.sessionId, (perSession.get(h.sessionId) ?? 0) + 1);
    expect(Math.max(...perSession.values())).toBeLessThanOrEqual(3);
  });

  it('honours a lower diversification cap', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20, perSession: 1 });
    const seen = new Set(r.hits.map((h) => h.sessionId));
    expect(seen.size).toBe(r.hits.length);
  });

  it('reports which list every hit came from', async () => {
    const r = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: false });
    expect(r.lists.map((l) => l.list)).toContain('exchanges_fts');
    expect(r.hits[0]!.from.length).toBeGreaterThan(0);
    expect(r.hits[0]!.from[0]!.rank).toBeGreaterThan(0);
  });

  it('relaxes to any-word matching only when the exact words find nothing', async () => {
    const exact = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: false });
    expect(exact.relaxed).toBe(false);
    const loose = await recall(db, 'pgbouncer kubernetes checkout', {}, { vectors: false });
    expect(loose.relaxed).toBe(true);
    expect(loose.sessions.length).toBeGreaterThan(0);
  });

  it('never scores a session above 1.5x its own best hit', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    for (const s of r.sessions) {
      const best = Math.max(...s.hits.map((h) => h.score));
      expect(s.score).toBeLessThanOrEqual(best * 1.5 + 1e-9);
    }
  });
});

describe('recall: vectors are optional', () => {
  it('degrades to bm25 with a printable reason rather than erroring', async () => {
    const r = await recall(db, 'pgbouncer', {}, { vectors: false });
    expect(r.vectors.used).toBe(false);
    expect(r.vectors.reason).toBeTruthy();
    expect(r.sessions.length).toBeGreaterThan(0);
  });

  it('says so when the index was built with --no-embed', async () => {
    // This index has no vectors at all: `indexAll({ embed: false })` above.
    const r = await recall(db, 'pgbouncer', {}, { vectors: true });
    expect(r.vectors.used).toBe(false);
    expect(r.vectors.available).toBe(false);
    expect(r.sessions.length).toBeGreaterThan(0);
  });

  it('does not wake the model when the words already matched', async () => {
    const r = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: 'auto' });
    expect(r.lists.some((l) => l.list === 'vec_exchanges')).toBe(false);
  });
});

describe('resume commands', () => {
  it('gives the harness command for a live session', () => {
    expect(resumeCommand('claude', 'abc')).toBe('claude --resume abc');
    expect(resumeCommand('codex', 'abc')).toBe('codex resume abc');
  });

  it('offers nothing for a session the harness can no longer open', () => {
    expect(resumeCommand('claude', 'abc', 'archived')).toBeNull();
    expect(resumeCommand('claude', 'abc', 'ghost')).toBeNull();
    expect(resumeCommand('cursor', 'abc')).toBeNull();
  });

  it('resumes a subagent by resuming the conversation that spawned it', () => {
    expect(resumeCommand('claude', 'parent:agent-a1b2', 'live', 'parent')).toBe(
      'claude --resume parent',
    );
    // No parent recorded: potsherd will not offer an id claude cannot open.
    expect(resumeCommand('claude', 'parent:agent-a1b2', 'live')).toBeNull();
  });

  it('names a subagent by the half of its id that is its own', () => {
    expect(idTag('4c9339e0-b186-4006-b5c1-e7537c8b9353')).toBe('4c9339e0');
    expect(idTag('4c9339e0-b186-4006-b5c1-e7537c8b9353:agent-a02db260b621e9897')).toBe('a02db260');
  });
});

describe('ls', () => {
  it('lists sessions and ghosts together, newest first', () => {
    const r = listSessions(db, {}, { limit: 50 });
    expect(r.sessions.length).toBeGreaterThan(0);
    const when = r.sessions.map((s) => s.endedAt ?? s.startedAt ?? '');
    expect([...when].sort().reverse()).toEqual(when);
    expect(r.ghosts).toBe(3);
  });

  it('rolls subagents up under their parent instead of listing them flat', () => {
    const rolled = listSessions(db, {}, { limit: 50 });
    expect(rolled.sessions.every((s) => !s.isSidechain)).toBe(true);
    expect(rolled.rolledUp).toBe(2);
    const parent = rolled.sessions.find((s) => s.id.startsWith(ID.bundle))!;
    expect(parent.subagents).toBe(1);

    const only = listSessions(db, { sidechains: 'only' }, { limit: 50 });
    expect(only.sessions.length).toBe(2);
    expect(only.sessions.every((s) => s.isSidechain)).toBe(true);
  });

  it('gives an untitled session a name that is not a uuid', () => {
    const r = listSessions(db, {}, { limit: 50 });
    const untitled = r.sessions.find((s) => s.id.startsWith(ID.untitled))!;
    expect(untitled.title).toBeNull();
    expect(untitled.displayTitle).toContain('potsherd-eval-api');
  });

  it('names a ghost by its first real prompt, not by its id', () => {
    const r = listSessions(db, { ghosts: 'only' }, { limit: 50 });
    const ghost = r.sessions.find((s) => s.id.startsWith(ID.ghostPrinter))!;
    expect(ghost.displayTitle).toContain('brother laser printer');
  });

  it('--ghosts exclude leaves only what is still on disk', () => {
    const r = listSessions(db, { ghosts: 'exclude' }, { limit: 50 });
    expect(r.sessions.every((s) => s.status !== 'ghost')).toBe(true);
    expect(r.ghosts).toBe(0);
  });

  it('--project filters both tables', () => {
    const r = listSessions(db, { project: '/tmp/potsherd-eval-devices' }, { limit: 50 });
    expect(r.sessions.length).toBe(1);
    expect(r.sessions[0]!.status).toBe('ghost');
  });
});

describe('show', () => {
  it('resolves a full id, and an unambiguous prefix', () => {
    const byPrefix = resolveSession(db, ID.pgbouncer)!;
    expect(byPrefix.ambiguous).toBeUndefined();
    const byFull = resolveSession(db, byPrefix.id)!;
    expect(byFull.id).toBe(byPrefix.id);
  });

  it('prefers the conversation over the subagents that share its prefix', () => {
    const found = resolveSession(db, ID.bundle)!;
    expect(found.ambiguous).toBeUndefined();
    expect(found.id).not.toContain(':');
  });

  it('finds a subagent by the tag ls prints for it', () => {
    const parent = showSession(db, resolveSession(db, ID.bundle)!.id)!;
    const child = parent.children[0]!;
    const found = resolveSession(db, idTag(child.id))!;
    expect(found.id).toBe(child.id);
  });

  it('returns null for a reference that matches nothing', () => {
    expect(resolveSession(db, 'zzzzzzzz')).toBeNull();
  });

  it('lists the candidates rather than guessing on a real collision', () => {
    // One character is a prefix of many uuids and of at least two top-level
    // sessions, so there is no single conversation it could mean.
    const found = resolveSession(db, 'a')!;
    expect(found.ambiguous).toBeDefined();
    expect(found.ambiguous!.length).toBeGreaterThan(1);
  });

  it('reads a window of exchanges, numbered the way --from addresses them', () => {
    const id = resolveSession(db, ID.csv)!.id;
    const all = showSession(db, id)!;
    expect(all.total).toBe(3);
    const window = showSession(db, id, { from: 2, to: 3 })!;
    expect(window.exchanges.length).toBe(2);
    expect(window.from).toBe(2);
    expect(window.exchanges[0]!.userText).toBe(all.exchanges[1]!.userText);
  });

  it('shows a ghost as prompts with no assistant side', () => {
    const id = resolveSession(db, ID.ghostPrinter)!.id;
    const r = showSession(db, id)!;
    expect(r.exchanges).toEqual([]);
    expect(r.ghostPrompts!.length).toBe(5);
    expect(r.session.resume).toBeNull();
  });

  it('lists the subagents a session spawned', () => {
    const r = showSession(db, resolveSession(db, ID.bundle)!.id)!;
    expect(r.children.length).toBe(1);
    expect(r.children[0]!.agentName).toBe('bundle-auditor');
  });

  it('carries the files an exchange touched', () => {
    const r = showSession(db, resolveSession(db, ID.pgbouncer)!.id)!;
    expect(r.exchanges[0]!.filesTouched.join(' ')).toContain('pool.ts');
    expect(r.exchanges[0]!.toolCalls[0]!.name).toBe('Edit');
  });
});

describe('stats', () => {
  it('counts sessions, subagents and ghosts per harness', () => {
    const r = sessionStats(db, { root });
    const claude = r.harnesses.find((h) => h.harness === 'claude')!;
    expect(claude.sessions).toBe(8);
    expect(claude.sidechains).toBe(2);
    expect(claude.ghosts).toBe(3);
    expect(claude.exchanges).toBeGreaterThan(0);
  });

  it('agrees with the tables it counted', () => {
    const r = sessionStats(db, { root });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number };
    expect(r.totals.exchanges).toBe(rows.n);
    const ghostPrompts = db.prepare('SELECT COUNT(*) AS n FROM ghost_prompts').get() as { n: number };
    expect(r.totals.ghostPrompts).toBe(ghostPrompts.n);
  });

  it('reports freshness against the files it actually read', () => {
    const r = sessionStats(db, { root });
    expect(r.freshness.indexed).toBe(10);
    expect(r.freshness.missing).toBe(0);
    expect(r.freshness.stale).toBe(0);
    expect(r.freshness.lastIndexedAt).toBeTruthy();
  });

  it('says the index has no vectors when it was built without them', () => {
    const r = sessionStats(db, { root });
    expect(r.freshness.vectors).toBe(0);
  });
});
