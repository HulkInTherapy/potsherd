import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  db as store,
  indexAll,
  listSessions,
  renderLs,
  renderShow,
  showSession,
  Theme,
  type Db,
} from '@potsherd/core';
import { stripAnsi } from '../packages/core/src/theme.js';
import {
  MIN_SHARED_RECORDS,
  OVERLAP_THRESHOLD,
  deriveThreads,
  sessionDate,
  storedThreads,
  resolveThread,
  threadOf,
  threadTotals,
} from '../packages/core/src/threads.js';
import { collectSource, graft } from '../packages/core/src/graft.js';
import { makeContext } from '../packages/mcp/src/context.js';
import { runRead } from '../packages/mcp/src/tools/read.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * F4 — the fork/resume chain (`docs/AGENT-AUDIT-2026-08-23.md`, phase-10 §B5).
 *
 * Every fixture here is written by this file. The shape it writes is the shape
 * `claude --resume` actually produces, read off the reference archive rather
 * than off any format document:
 *
 *   - the resumed transcript's records are **copied whole**, keeping their
 *     `uuid`;
 *   - `sessionId` on every copied record is rewritten to the new transcript;
 *   - `session_id` — a different field — keeps naming the transcript the
 *     record was first written in;
 *   - `promptId` does **not** survive the copy, which is why the parser opens
 *     no exchange for a copied prompt and why the derived session indexes as a
 *     stub while its parent keeps all the work.
 *
 * That last point is the audit's own correction to itself, and it is asserted
 * here: the dedup is right, and nothing in this phase is allowed to "fix" F4
 * by moving records off the session that had them first.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

function scratch(): { claudeDir: string; root: string } {
  const base = tempDir('potsherd-threads-');
  dirs.push(base);
  return { claudeDir: path.join(base, 'claude'), root: path.join(base, 'potsherd') };
}

const PROJECT = '/tmp/potsherd-threads';
const SLUG = '-tmp-potsherd-threads';

/** Ids that are visibly invented: three distinct hex digits and no more. */
const ID = {
  parent: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  child: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
  lone: 'cccccccc-1111-4111-8111-cccccccccccc',
  near: 'dddddddd-1111-4111-8111-dddddddddddd',
  far: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
  claimant: 'ffffffff-1111-4111-8111-ffffffffffff',
} as const;

type Rec = Record<string, unknown>;

/**
 * One prompt and the reply to it: two records, two uuids.
 *
 * `promptId` is what makes the first record a *human prompt* to the parser, so
 * it is the field the copy has to lose for the fixture to behave like a real
 * fork.
 */
function pair(sessionId: string, n: number, day: string, tag: string): Rec[] {
  const base = { sessionId, cwd: PROJECT, version: '2.1.238', gitBranch: 'main' };
  const at = (m: number): string => `${day}T0${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:00.000Z`;
  return [
    {
      ...base,
      type: 'user',
      promptId: `${tag}-p${n}`,
      uuid: `${tag}-u${n}`,
      timestamp: at(n * 2),
      message: { role: 'user', content: `${tag} question ${n} about the pooler` },
    },
    {
      ...base,
      type: 'assistant',
      uuid: `${tag}-a${n}`,
      timestamp: at(n * 2 + 1),
      message: { role: 'assistant', content: [{ type: 'text', text: `${tag} answer ${n}` }] },
    },
  ];
}

function writeSession(claudeDir: string, id: string, records: Rec[]): string {
  const file = path.join(claudeDir, 'projects', SLUG, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

/**
 * The copy a resume makes: same records, same uuids, new `sessionId`, the old
 * one left behind in `session_id`, and no `promptId`.
 */
function resumeCopy(records: Rec[], childId: string, parentId: string): Rec[] {
  return records.map((r) => {
    const copy: Rec = { ...r, sessionId: childId, session_id: parentId };
    delete copy.promptId;
    return copy;
  });
}

/** A parent, and a resume of it that then did `own` more exchanges. */
function writeChain(
  claudeDir: string,
  o: {
    parentId: string;
    childId: string;
    parentPairs: number;
    copiedRecords: number;
    ownPairs: number;
    tag?: string;
  },
): { parent: Rec[]; child: Rec[] } {
  const tag = o.tag ?? 'p';
  const parent: Rec[] = [];
  for (let n = 1; n <= o.parentPairs; n += 1) parent.push(...pair(o.parentId, n, '2026-08-12', tag));
  const child: Rec[] = resumeCopy(parent.slice(0, o.copiedRecords), o.childId, o.parentId);
  for (let n = 1; n <= o.ownPairs; n += 1) {
    child.push(...pair(o.childId, n, '2026-08-20', `${tag}c`));
  }
  writeSession(claudeDir, o.parentId, parent);
  writeSession(claudeDir, o.childId, child);
  return { parent, child };
}

async function index(
  claudeDir: string,
  root: string,
  o: { full?: boolean } = {},
): Promise<{ db: Db; threads: ReturnType<typeof storedThreads> }> {
  const report = await indexAll({
    claudeDir,
    root,
    harnesses: ['claude'],
    embed: false,
    ...(o.full ? { full: true } : {}),
  });
  const db = store.open({ root });
  return { db, threads: report.threads.threads };
}

// ------------------------------------------------------------ derivation

describe('the chain is derived at index time, with no flag typed', () => {
  it('finds the fork/resume pair and nothing else', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    // Two sessions that have nothing to do with each other or with the chain.
    const lone: Rec[] = [];
    for (let n = 1; n <= 6; n += 1) lone.push(...pair(ID.lone, n, '2026-07-01', 'q'));
    writeSession(claudeDir, ID.lone, lone);

    const { db, threads } = await index(claudeDir, root);
    try {
      expect(threads).toHaveLength(1);
      expect(threads[0]!.sessions).toEqual([ID.parent, ID.child]);
      expect(threads[0]!.head).toBe(ID.child);
      // The stub is the head, because the head is the transcript `--resume`
      // continues — not the one with the most work in it.
      expect(threadOf(db, ID.parent).head).toBe(ID.child);
      // A session nothing was forked from is its own thread of one, so no
      // caller needs to ask whether there is a thread.
      expect(threadOf(db, ID.lone)).toEqual({
        id: ID.lone,
        sessions: [ID.lone],
        head: ID.lone,
      });
    } finally {
      db.close();
    }
  });

  it('orients the chain by which session did the later work', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const row = db
        .prepare('SELECT parent_id, via, shared, overlap FROM session_threads WHERE session_id = ?')
        .get(ID.child) as { parent_id: string; via: string; shared: number; overlap: number };
      expect(row.parent_id).toBe(ID.parent);
      // The harness names the parent on the copied records, so the declared
      // pointer is what fired; overlap corroborated it.
      expect(row.via).toBe('declared');
      expect(row.shared).toBe(20);
      expect(row.overlap).toBeCloseTo(1, 5);
    } finally {
      db.close();
    }
  });
});

// ------------------------------------------------------------- threshold

describe('the overlap threshold', () => {
  /**
   * The constant, pinned from both sides.
   *
   * The behavioural pair below is the real test — 0.80 chains and 0.70 does
   * not — and this is the sentence that says why moving the number is a
   * decision and not a tweak. Between them, `OVERLAP_THRESHOLD` cannot move in
   * either direction without a failure.
   */
  it('is a stopping rule, and this suite fails if it moves', () => {
    expect(OVERLAP_THRESHOLD).toBeGreaterThan(0.7);
    expect(OVERLAP_THRESHOLD).toBeLessThanOrEqual(0.8);
    expect(MIN_SHARED_RECORDS).toBe(10);
  });

  it('chains a pair at 0.80 containment and refuses one at 0.70', async () => {
    const { claudeDir, root } = scratch();
    // 20 parent records, 16 of them copied, 10 records of its own:
    // shared 16 / min(26, 20) = 0.80.
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 16,
      ownPairs: 5,
      tag: 'n',
    });
    // The same shape one notch down: 14 / 20 = 0.70.
    writeChain(claudeDir, {
      parentId: ID.near,
      childId: ID.far,
      parentPairs: 10,
      copiedRecords: 14,
      ownPairs: 5,
      tag: 'f',
    });

    const { db, threads } = await index(claudeDir, root);
    try {
      expect(threads.map((t) => t.sessions)).toEqual([[ID.parent, ID.child]]);
      expect(threadOf(db, ID.far).sessions).toEqual([ID.far]);
      const row = db
        .prepare('SELECT overlap FROM session_threads WHERE session_id = ?')
        .get(ID.child) as { overlap: number };
      expect(row.overlap).toBeCloseTo(0.8, 5);
    } finally {
      db.close();
    }
  });

  it('refuses a small pair that shares everything it has', async () => {
    const { claudeDir, root } = scratch();
    // Containment 1.0 over 4 records. A ratio with a denominator that small is
    // noise with a decimal point on it, and `MIN_SHARED_RECORDS` is why it is
    // not allowed to speak.
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 2,
      copiedRecords: 4,
      ownPairs: 2,
      tag: 's',
    });
    const { db, threads } = await index(claudeDir, root);
    try {
      expect(threads).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// -------------------------------------------------- declared vs inferred

describe('a declared parent is preferred, and corroborated before it is used', () => {
  it('refuses a declared parent the records do not back up, and says so', async () => {
    const { claudeDir, root } = scratch();
    const lone: Rec[] = [];
    for (let n = 1; n <= 8; n += 1) lone.push(...pair(ID.lone, n, '2026-07-01', 'q'));
    writeSession(claudeDir, ID.lone, lone);

    // A transcript that names `lone` on every record it wrote and shares not
    // one record id with it. This is the reference archive's common case: the
    // field is sticky across a `/clear`, and eight of the twelve sessions
    // there that declare a foreign parent share **zero** records with it —
    // one of them declaring 2,097 records inherited from a transcript that
    // holds 98.
    const claimant: Rec[] = [];
    for (let n = 1; n <= 8; n += 1) claimant.push(...pair(ID.claimant, n, '2026-07-05', 'r'));
    writeSession(
      claudeDir,
      ID.claimant,
      claimant.map((r) => ({ ...r, session_id: ID.lone })),
    );

    const { db } = await index(claudeDir, root);
    try {
      const report = deriveThreads(db);
      expect(report.threads).toEqual([]);
      expect(report.refused).toEqual([
        { child: ID.claimant, declared: ID.lone, records: 16, shared: 0, why: 'no-shared-records' },
      ]);
    } finally {
      db.close();
    }
  });

  it('chains on overlap alone when no parent is declared', async () => {
    const { claudeDir, root } = scratch();
    const { parent } = writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    // Rewrite the child without the harness's pointer: same records, same
    // uuids, no `session_id`. A fork potsherd was never told about.
    const child = resumeCopy(parent, ID.child, ID.parent).map((r) => {
      const copy = { ...r };
      delete copy.session_id;
      return copy;
    });
    for (let n = 1; n <= 3; n += 1) child.push(...pair(ID.child, n, '2026-08-20', 'pc'));
    writeSession(claudeDir, ID.child, child);

    const { db, threads } = await index(claudeDir, root, { full: true });
    try {
      expect(threads.map((t) => t.sessions)).toEqual([[ID.parent, ID.child]]);
      const row = db
        .prepare('SELECT via FROM session_threads WHERE session_id = ?')
        .get(ID.child) as { via: string };
      expect(row.via).toBe('overlap');
    } finally {
      db.close();
    }
  });

  it('names the harnesses it cannot read a chain out of', async () => {
    const { claudeDir, root } = scratch();
    const lone: Rec[] = [];
    for (let n = 1; n <= 4; n += 1) lone.push(...pair(ID.lone, n, '2026-07-01', 'q'));
    writeSession(claudeDir, ID.lone, lone);
    const { db } = await index(claudeDir, root);
    try {
      const report = deriveThreads(db);
      // Claude is readable, so it is never on this list; a harness with
      // sessions and no record identity would be, by name, rather than
      // silently returning no chains as if it had looked.
      expect(report.withoutLineage).not.toContain('claude');
      expect(report.candidates).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ------------------------------------------------------------- the dedup

describe('the dedup is right and stays right', () => {
  it('leaves shared records with the session that had them first', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const parent = showSession(db, ID.parent)!;
      const child = showSession(db, ID.child)!;
      // Every one of the parent's ten exchanges is still the parent's, and the
      // resume holds only the three it did itself. The audit initially called
      // this a parser bug and corrected itself; nothing in this phase is
      // allowed to "fix" F4 by moving these rows.
      expect(parent.total).toBe(10);
      expect(child.total).toBe(3);

      const parentTexts = parent.exchanges.map((e) => e.userText);
      const childTexts = child.exchanges.map((e) => e.userText);
      for (const text of parentTexts) expect(childTexts).not.toContain(text);
      expect(parentTexts[0]).toContain('p question 1');
      expect(childTexts[0]).toContain('pc question 1');

      // The *evidence* is on both — that is what makes the chain derivable —
      // even though the *attribution* is on one.
      const shared = db
        .prepare(
          `SELECT COUNT(*) AS n FROM session_record_ids a
             JOIN session_record_ids b ON a.record_id = b.record_id
            WHERE a.session_id = ? AND b.session_id = ?`,
        )
        .get(ID.parent, ID.child) as { n: number };
      expect(shared.n).toBe(20);
    } finally {
      db.close();
    }
  });
});

// -------------------------------------------------------------- the date

describe('a session is dated by its own content', () => {
  it('show’s header and show’s first exchange are the same day', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const child = showSession(db, ID.child)!;
      // The audit's sharpest artifact, as an assertion: the header used to say
      // 12 august over a first exchange stamped the 20th.
      expect(child.session.startedAt).toBe(child.exchanges[0]!.ts);
      expect(child.session.startedAt!.slice(0, 10)).toBe('2026-08-20');
      // Not the first record in the file, which is the parent's and is copied.
      expect(child.session.startedAt).not.toContain('2026-08-12');
    } finally {
      db.close();
    }
  });

  it('ls, show and graft print one date for the session, and it is the content date', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const shown = showSession(db, ID.child)!;
      const src = await collectSource(db, ID.child, {});
      const listed = listSessions(db, {}, { limit: 10 }).sessions.find((s) => s.id === ID.child)!;

      expect(src.date).toBe('2026-08-20');
      expect(sessionDate(shown.session)!.slice(0, 10)).toBe(src.date);
      expect(sessionDate(listed)!.slice(0, 10)).toBe(src.date);

      // `find` renders `startedAt` off the stored row (`recall.ts`
      // `fromSessionRow`) and has no thread logic of its own, which is the
      // whole point of fixing the data rather than each renderer: the column
      // itself is now the content date, so `find` prints the 20th without
      // knowing what a thread is.
      const stored = db
        .prepare('SELECT started_at, ended_at FROM sessions WHERE id = ?')
        .get(ID.child) as { started_at: string; ended_at: string };
      expect(stored.started_at.slice(0, 10)).toBe('2026-08-20');
      expect(sessionDate({ startedAt: stored.started_at, endedAt: stored.ended_at })!.slice(0, 10))
        .toBe('2026-08-20');
      // The `ls` row is the *thread*, so its interval opens where the work
      // opened. That is a different claim from dating the session, and it is
      // the one the row is making.
      expect(listed.startedAt!.slice(0, 10)).toBe('2026-08-12');
    } finally {
      db.close();
    }
  });

  it('--until stops claiming a session was alive before its first exchange', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const before16 = listSessions(db, { until: '2026-08-15' }, { limit: 10 });
      const ids = before16.sessions.map((s) => s.id);
      // The resume did all of its work on the 20th, so it is not a session
      // that was alive on the 15th. The link that *was* keeps its row rather
      // than being folded into a head this filter dropped.
      expect(ids).toContain(ID.parent);
      expect(ids).not.toContain(ID.child);
    } finally {
      db.close();
    }
  });
});

// ------------------------------------------------------------ the unit

describe('the thread is the unit', () => {
  it('ls shows one row for the chain, carrying the chain’s work', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const result = listSessions(db, {}, { limit: 10 });
      expect(result.sessions.map((s) => s.id)).toEqual([ID.child]);
      expect(result.threaded).toBe(1);
      const row = result.sessions[0]!;
      expect(row.exchanges).toBe(13);
      expect(row.thread).toEqual({
        id: ID.parent,
        sessions: [ID.parent, ID.child],
        head: ID.child,
        isHead: true,
        exchanges: 13,
      });
      // The row's range is the chain's; the date it sorts and prints on is
      // still the last activity, which is the session's own.
      expect(row.startedAt!.slice(0, 10)).toBe('2026-08-12');
      expect(row.endedAt!.slice(0, 10)).toBe('2026-08-20');
    } finally {
      db.close();
    }
  });

  /**
   * **VERIFICATION-5 C-3, pinned** — and the reason it is pinned here is the
   * fifth verifier's most damning measurement: its own two-line CLI/MCP fix
   * left 1,931 tests passing *before and after*, because nothing asserted the
   * field it changed. C-3 was in exactly that position — `ls` printed
   * `1 session` where `doctor` and `stats` printed `31`, on three published
   * screenshots, and the only guard on the fix was the CI screen diff.
   *
   * The screen diff is a good guard and it is not this one: it pins the demo
   * corpus, at one width, in one shape. This pins the *rule* — a listing that
   * folds rows into a thread says how many sessions its rows stand for — on a
   * two-session chain, where the number is small enough to read.
   */
  it('ls says how many sessions the one row stands for', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const result = listSessions(db, {}, { limit: 10 });
      // The premise, established rather than assumed: one row, one folded.
      expect(result.sessions).toHaveLength(1);
      expect(result.threaded).toBe(1);

      const screen = stripAnsi(renderLs(result, new Theme({ width: 80, color: false })));
      // 1 row for 2 sessions — the number `doctor` and `stats` count.
      expect(screen).toContain('1 of 2 sessions');
      // And not the sentence that was wrong: `1 session` as a whole claim,
      // which is what silently dropped the folded one.
      expect(screen).not.toMatch(/\n\s+1 session\b/);
    } finally {
      db.close();
    }
  });

  /**
   * The other half of the same rule: an archive with nothing folded must print
   * exactly what it always printed. `n of n sessions` on every listing would be
   * a worse screen than the one this replaced.
   */
  it('says nothing about threads when no row folds one', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 0,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const result = listSessions(db, {}, { limit: 10 });
      expect(result.threaded).toBe(0);
      const screen = stripAnsi(renderLs(result, new Theme({ width: 80, color: false })));
      expect(screen).toContain('2 sessions');
      expect(screen).not.toContain(' of ');
    } finally {
      db.close();
    }
  });

  it('show still renders one transcript, and names the rest of the chain', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const child = showSession(db, ID.child)!;
      expect(child.total).toBe(3);
      expect(child.session.thread!.sessions).toEqual([ID.parent, ID.child]);
      expect(child.session.thread!.exchanges).toBe(13);
      const parent = showSession(db, ID.parent)!;
      expect(parent.session.thread!.isHead).toBe(false);
    } finally {
      db.close();
    }
  });

  it('graft carries the whole chain, cited per transcript', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const report = await graft(db, ID.child, { llm: null, write: false });
      expect(report.exchanges).toBe(13);
      expect(report.sessions).toBe(2);
      expect(report.threadId).toBe(ID.parent);
      expect(report.brief).toContain('123 exchanges'.replace('123', '13'));
      expect(report.brief.trim().split('\n').pop()).toContain('13 exchanges across 2 sessions');
      // Both transcripts are quoted, and each bullet cites the one it came
      // from. A citation that named the transcript the user typed would not
      // resolve, and the pass below would delete the line with it.
      const id8s = new Set(
        [...report.brief.matchAll(/\[([0-9a-f]{8})@\d+\]/g)].map((m) => m[1]!),
      );
      expect([...id8s].sort()).toEqual([ID.parent.slice(0, 8), ID.child.slice(0, 8)].sort());
      expect(report.citations.every((c) => c.resolves)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('totals the chain rather than one file', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      const totals = threadTotals(db, threadOf(db, ID.child));
      expect(totals).toMatchObject({ sessions: 2, exchanges: 13, prompts: 13 });
      expect(totals.startedAt!.slice(0, 10)).toBe('2026-08-12');
      expect(totals.endedAt!.slice(0, 10)).toBe('2026-08-20');
    } finally {
      db.close();
    }
  });
});

// -------------------------------------------------- cold vs incremental

describe('cold and incremental derive the same chains', () => {
  it('re-indexing an unchanged archive keeps the chain', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });

    const cold = await indexAll({ claudeDir, root, harnesses: ['claude'], embed: false, full: true });
    const incremental = await indexAll({ claudeDir, root, harnesses: ['claude'], embed: false });
    // The second run opened nothing, and still derived the chain: the
    // derivation reads the *stored* record ids, not whatever this pass
    // happened to re-read.
    expect(incremental.harnesses[0]!.parsed).toBe(0);
    expect(incremental.threads.threads).toEqual(cold.threads.threads);

    const db = store.open({ root });
    try {
      expect(storedThreads(db)).toEqual(cold.threads.threads);
    } finally {
      db.close();
    }
  });

  it('a resume that appears later chains against a parent indexed weeks ago', async () => {
    const { claudeDir, root } = scratch();
    const parent: Rec[] = [];
    for (let n = 1; n <= 10; n += 1) parent.push(...pair(ID.parent, n, '2026-08-12', 'p'));
    writeSession(claudeDir, ID.parent, parent);

    const first = await indexAll({ claudeDir, root, harnesses: ['claude'], embed: false });
    expect(first.threads.threads).toEqual([]);

    const child = resumeCopy(parent, ID.child, ID.parent);
    for (let n = 1; n <= 3; n += 1) child.push(...pair(ID.child, n, '2026-08-20', 'pc'));
    writeSession(claudeDir, ID.child, child);

    const second = await indexAll({ claudeDir, root, harnesses: ['claude'], embed: false });
    // One file parsed, and the chain is complete — because the parent's record
    // ids were already on disk from the run three weeks ago.
    expect(second.harnesses[0]!.parsed).toBe(1);
    expect(second.threads.threads.map((t) => t.sessions)).toEqual([[ID.parent, ID.child]]);
  });
  /**
   * Audit F4, the half `show` still owed after T10.3.
   *
   * The audit's complaint was not only that the DATE was wrong. It was that a
   * session holding a stub of a much longer chain gave *"no hint that 1,660
   * records of context live one hop away"*. Threads fixed `graft`, `ls` and the
   * dating; `show` still printed this file's exchange count and stopped.
   *
   * The count is deliberately NOT changed — `show` prints this file's
   * transcript, and a header number that disagreed with the exchanges under it
   * would trade one lie for another. The thread is named beside it, with the
   * verb that opens the whole chain.
   */
  it('show names the thread beside this file, and the verb that opens it', async () => {
    const { claudeDir, root } = scratch();
    const parent: Rec[] = [];
    for (let n = 1; n <= 10; n += 1) parent.push(...pair(ID.parent, n, '2026-08-12', 'p'));
    writeSession(claudeDir, ID.parent, parent);
    const child = resumeCopy(parent, ID.child, ID.parent);
    for (let n = 1; n <= 3; n += 1) child.push(...pair(ID.child, n, '2026-08-20', 'pc'));
    writeSession(claudeDir, ID.child, child);
    await indexAll({ claudeDir, root, harnesses: ['claude'], embed: false });

    const db = store.open({ root });
    try {
      const shown = showSession(db, ID.child)!;
      // The chain is bigger than the file, which is the whole condition.
      expect(shown.session.thread).not.toBeNull();
      expect(shown.session.thread!.exchanges).toBeGreaterThan(shown.total);
      expect(shown.session.thread!.sessions.length).toBe(2);

      const out = renderShow(shown, new Theme({ color: false, width: 80 }));
      expect(out).toContain('thread');
      expect(out).toContain(String(shown.session.thread!.exchanges));
      // The verb, not just the diagnosis. `plans/05`: a line that reports a gap
      // names the thing that closes it.
      expect(out).toContain(`potsherd graft ${ID.child.slice(0, 8)}`);
      for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(80);

      // The PARENT names the chain too, and that is correct rather than
      // sloppy: it holds ten of the thread's thirteen exchanges, so it is a
      // fragment as well and a reader landing on it has the same gap. What
      // must not happen is the line appearing where there is nothing to say.
      const alone = showSession(db, ID.parent)!;
      const soloOut = renderShow(alone, new Theme({ color: false, width: 80 }));
      expect(soloOut).toContain(`potsherd graft ${ID.parent.slice(0, 8)}`);
    } finally {
      db.close();
    }
  });
});

// -------------------------------------------------------- the model's door

/**
 * D1 — `potsherd_read` on a fork/resume child.
 *
 * The chain above is derived at index time and `show`, `ls` and `graft` all
 * read it. The MCP surface did not: `tools/thread.ts` probed core for an
 * export named `resolveThread` that was never written, found nothing, and
 * degraded politely — `via: "session-only"`, a note telling the model *"this
 * build of potsherd does not model fork/resume chains yet"*, and the head's
 * three exchanges where the thread has thirteen.
 *
 * `potsherd_read` is one of the archaeologist's two tools and the stated
 * replacement for filesystem `Read`, so that degradation reproduced audit F4
 * verbatim at the model door, in the release that claims to have fixed it.
 * These two tests are the door: the core export, and the tool that asks for it.
 */
describe('the chain reaches the model, not just the CLI', () => {
  it('core resolves a thread from any member id8, chain order oldest first', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    try {
      // Any member id8 resolves the thread — the head's, and the root's.
      for (const ref of [ID.child.slice(0, 8), ID.parent.slice(0, 8), ID.child]) {
        const t = resolveThread(db, ref)!;
        expect(t).not.toBeNull();
        expect(t.threadId).toBe(ID.parent);
        expect(t.sessionIds).toEqual([ID.parent, ID.child]);
        expect(t.exchanges).toBe(13);
        expect(t.ambiguous).toBeUndefined();
      }
      // A session nothing forked from is a thread of one, never null: every
      // caller may treat "the thread" as the unit without asking first.
      const lone: Rec[] = [];
      for (let n = 1; n <= 4; n += 1) lone.push(...pair(ID.lone, n, '2026-07-01', 'q'));
      writeSession(claudeDir, ID.lone, lone);
      await indexAll({ claudeDir, root, harnesses: ['claude'], embed: false });
      const solo = resolveThread(db, ID.lone.slice(0, 8))!;
      expect(solo.sessionIds).toEqual([ID.lone]);
      // A reference that names nothing is null, not a guess.
      expect(resolveThread(db, '0f0f0f0f')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('potsherd_read on the fork child returns the whole chain, via core', async () => {
    const { claudeDir, root } = scratch();
    writeChain(claudeDir, {
      parentId: ID.parent,
      childId: ID.child,
      parentPairs: 10,
      copiedRecords: 20,
      ownPairs: 3,
    });
    const { db } = await index(claudeDir, root);
    db.close();

    const ctx = makeContext({ potsherdDir: root, env: {} });
    const page = runRead(ctx, { thread: ID.child.slice(0, 8), from: 1, to: 200 });

    const thread = page['thread'] as {
      id: string;
      via: string;
      note: string | null;
      links: { sessionId: string; total: number; offset: number }[];
    };
    // The whole chain, not the head. This is the number audit F4 is about.
    expect(page['total']).toBe(13);
    expect(thread.via).toBe('core');
    expect(thread.note).toBeNull();
    expect(thread.links.map((l) => l.sessionId)).toEqual([ID.parent, ID.child]);
    expect(thread.links.map((l) => l.total)).toEqual([10, 3]);
    expect(thread.links.map((l) => l.offset)).toEqual([1, 11]);

    // Every exchange in the chain, from both links, thread-positioned once.
    const rows = page['exchanges'] as { position: number; sessionId: string; seq: number }[];
    expect(rows).toHaveLength(13);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(new Set(rows.map((r) => r.sessionId))).toEqual(new Set([ID.parent, ID.child]));
    // `seq` stays session-local, because `<id8>@<seq>` is what a citation means
    // everywhere else in this product. The child's three restart at 1.
    expect(rows.filter((r) => r.sessionId === ID.child).map((r) => r.seq)).toEqual([1, 2, 3]);
    // One citation per link, so a source line for the parent's evidence exists.
    expect((page['citations'] as { sessionId: string }[]).map((c) => c.sessionId)).toEqual([
      ID.parent,
      ID.child,
    ]);
  });
});
