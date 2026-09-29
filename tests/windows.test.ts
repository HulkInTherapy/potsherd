import { afterEach, describe, expect, it } from 'vitest';
import { db as store } from '@potsherd/core';
import {
  ASK_SESSION_CHARS,
  ask,
  type AskReaderFn,
  type AskReaderInput,
} from '../packages/core/src/ask.js';
import {
  ASK_WINDOWS,
  MIN_UNIT_CHARS,
  UNIT_HEADER_CHARS,
  WINDOW_GAP_MARK,
  WINDOW_MIN_EXCHANGES,
  WINDOW_NEIGHBOURS,
  WINDOW_SEPARATION,
  planWindows,
  seedIndices,
  windowCount,
  windowOverhead,
  windowText,
} from '../packages/core/src/windows.js';
import type { Transcript, TranscriptUnit } from '../packages/core/src/cards/transcript.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * T10.5 F5 — discontiguous relevance windows.
 *
 * The regression fixture is the audit's own measurement
 * (`docs/AGENT-AUDIT-2026-08-23.md` §2 F5): six readers, one contiguous run
 * each, four of the six at exchanges 1–3, against a 119-exchange session whose
 * answer is in the last day. Every `it` below fails on v1.1.0 behaviour or
 * pins a constant whose movement would bring it back.
 *
 * The module under test is pure over a `Transcript`, so most of this file
 * needs neither a database nor a model. The two that do drive the real
 * `ask()` with a reader function that records what it was handed — the same
 * seam `--readers-out` uses, and the reason F5 was measurable at all.
 */

const created: string[] = [];
afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

function scratch(): string {
  const dir = tempDir('potsherd-windows-test-');
  created.push(dir);
  return dir;
}

// --------------------------------------------------------------- fixtures

const DAY = (i: number): string =>
  `2026-08-${String(1 + Math.floor(i / 10)).padStart(2, '0')}T09:00:00.000Z`;

function unit(seq: number, text: string): TranscriptUnit {
  return { seq, id: `u${seq}`, ts: DAY(seq), text };
}

/** `n` exchanges, each long enough that the budget has to make choices. */
function transcript(n: number, body = (i: number) => `exchange ${i} `.repeat(60)): Transcript {
  return {
    id: 'sess-long',
    kind: 'session',
    harness: 'claude',
    title: null,
    project: '/tmp/p',
    projectSlug: '-tmp-p',
    units: Array.from({ length: n }, (_, i) => unit(i + 1, body(i + 1))),
    chars: 0,
    isSidechain: false,
  };
}

/** Positions of the units in a rendered block, as the reader would read them. */
function seqsIn(text: string): number[] {
  return [...text.matchAll(/\[seq (\d+)/g)].map((m) => Number(m[1]));
}

// =========================================================== the constants
//
// Acceptance 7: "a constant encoding the window count or size has a test that
// FAILS when it moves." Three of them do, and each is paired with the
// behaviour it is supposed to buy, so a future edit cannot satisfy the pin by
// changing the number in two places.

describe('the constants', () => {
  it('pins the default window count at five', () => {
    expect(ASK_WINDOWS).toBe(5);
  });

  it('pins the short-session boundary at twelve exchanges', () => {
    expect(WINDOW_MIN_EXCHANGES).toBe(12);
  });

  it('derives that boundary from the budget it was derived from', () => {
    // One slice holds `ASK_SESSION_CHARS` characters and no exchange may be
    // cut below `MIN_UNIT_CHARS` plus its header. Eleven exchanges fit whole;
    // twelve are the first that cannot, and are therefore the first size at
    // which *which* part is left out is a decision worth making. If either
    // input moves, this fails and the boundary has to be re-derived rather
    // than re-typed.
    const fitsWhole = Math.floor(ASK_SESSION_CHARS / (MIN_UNIT_CHARS + UNIT_HEADER_CHARS));
    expect(fitsWhole).toBe(11);
    expect(WINDOW_MIN_EXCHANGES).toBe(fitsWhole + 1);
  });

  it('keeps five windows affordable at the existing floor', () => {
    // The argument for five: each window's share still pays for the seed *and*
    // at least one neighbour at `MIN_UNIT_CHARS`. At eight it would not, and
    // the ±1 neighbour rule would quietly stop working.
    const share = (ASK_SESSION_CHARS - windowOverhead(ASK_WINDOWS)) / ASK_WINDOWS;
    expect(share).toBeGreaterThanOrEqual(2 * (MIN_UNIT_CHARS + UNIT_HEADER_CHARS));
  });

  it('separates windows by more than their own width', () => {
    // At exactly `2n+1` two windows would abut and print as two blocks with
    // nothing missing between them — a contiguous run wearing a label.
    expect(WINDOW_SEPARATION).toBeGreaterThan(2 * WINDOW_NEIGHBOURS + 1);
  });
});

// ================================================================== count

describe('windowCount', () => {
  it('gives a short session one window, whatever is asked', () => {
    expect(windowCount(WINDOW_MIN_EXCHANGES - 1, 5, ASK_SESSION_CHARS)).toBe(1);
    expect(windowCount(3, 50, ASK_SESSION_CHARS)).toBe(1);
  });

  it('starts windowing at the boundary and not before', () => {
    expect(windowCount(11, 5, ASK_SESSION_CHARS)).toBe(1);
    expect(windowCount(12, 5, ASK_SESSION_CHARS)).toBe(1); // one window's worth of material
    expect(windowCount(24, 5, ASK_SESSION_CHARS)).toBe(2);
    expect(windowCount(119, 5, ASK_SESSION_CHARS)).toBe(5);
  });

  it('never asks for more windows than the material or the budget allows', () => {
    // 119 exchanges could hold nine windows; the ask is what caps it.
    expect(windowCount(119, 9, ASK_SESSION_CHARS)).toBe(9);
    // ...and the budget caps the ask, so `--windows 100` cannot produce 100
    // headers with nothing under them. The ceiling counts each window's own
    // gap marker, not only its exchange.
    expect(windowCount(10_000, 100, ASK_SESSION_CHARS)).toBe(9);
    expect(windowCount(10_000, 100, ASK_SESSION_CHARS)).toBeLessThan(
      Math.floor(ASK_SESSION_CHARS / (MIN_UNIT_CHARS + UNIT_HEADER_CHARS)),
    );
  });

  it('honours --windows 1 as the pre-F5 single contiguous run', () => {
    expect(windowCount(119, 1, ASK_SESSION_CHARS)).toBe(1);
  });
});

// ================================================================== seeds

describe('seedIndices', () => {
  it('takes the relevance hits, in the order recall returned them', () => {
    const got = seedIndices(100, [40, 10, 70], 5);
    expect(got.filter((s) => s.via === 'hit').map((s) => s.index)).toEqual([10, 40, 70]);
  });

  it('drops a hit that would land inside a window already placed', () => {
    // Seqs 30 and 31 are one window. The second is not a second place to look.
    const got = seedIndices(100, [30, 31, 70], 5);
    expect(got.some((s) => s.index === 31)).toBe(false);
  });

  it('always reserves the last exchange when there is more than one window', () => {
    // graft.ts's rule, and the whole of what "what is left to do" is asking.
    const got = seedIndices(120, [1, 5, 11, 55, 60, 65, 70, 75], 5);
    expect(got.some((s) => s.index === 119 && s.via === 'tail')).toBe(true);
    expect(got.filter((s) => s.via === 'hit')).toHaveLength(4);
  });

  it('gives the reserved slot back when a hit already covers the tail', () => {
    const got = seedIndices(120, [119, 10, 40, 70, 90], 5);
    expect(got.some((s) => s.via === 'tail')).toBe(false);
    expect(got.filter((s) => s.via === 'hit')).toHaveLength(5);
  });

  it('spreads when relevance produced nothing at all', () => {
    // The audit's four-of-six case: a session that matched on its title, whose
    // old excerpt was `units[0..2]` — the opening — for a question about the
    // end. Now it is the tail plus a spread, and never only the head.
    const got = seedIndices(100, [], 5);
    expect(got).toHaveLength(5);
    expect(got.some((s) => s.index === 99)).toBe(true);
    expect(got.every((s) => s.via !== 'hit')).toBe(true);
    // separated, and spanning the session rather than clustering in it
    for (let i = 1; i < got.length; i++) {
      expect(got[i]!.index - got[i - 1]!.index).toBeGreaterThanOrEqual(WINDOW_SEPARATION);
    }
    expect(got[0]!.index).toBeLessThan(40);
  });

  it('never returns two seeds that would render as one run', () => {
    for (const hits of [[], [0], [0, 1, 2, 3], [5, 6, 7, 50, 51, 99]]) {
      const got = seedIndices(100, hits, 5);
      for (let i = 1; i < got.length; i++) {
        expect(got[i]!.index - got[i - 1]!.index).toBeGreaterThanOrEqual(WINDOW_SEPARATION);
      }
    }
  });
});

// ================================================================== plan

describe('planWindows', () => {
  it('returns several separated windows for a long session', () => {
    const t = transcript(119);
    const plan = planWindows(t, [4, 10, 54], { windows: 5, maxChars: ASK_SESSION_CHARS });
    expect(plan.windows.length).toBeGreaterThanOrEqual(4);
    // Every window carries its own seq and timestamp — acceptance 1.
    for (const w of plan.windows) {
      expect(w.units.length).toBeGreaterThan(0);
      for (const u of w.units) expect(u.ts).toBeTruthy();
    }
  });

  it('is not the head of the transcript', () => {
    // The exact v1.1.0 failure: `[1, 2, 3]` for an eight-day session.
    const t = transcript(119);
    const plan = planWindows(t, [], { windows: 5, maxChars: ASK_SESSION_CHARS });
    const seqs = plan.units.map((u) => u.seq);
    expect(seqs).not.toEqual([1, 2, 3]);
    expect(Math.max(...seqs)).toBe(119);
  });

  it('keeps the seed and takes a neighbour with it', () => {
    const t = transcript(119);
    const plan = planWindows(t, [54], { windows: 5, maxChars: ASK_SESSION_CHARS });
    const first = plan.windows.find((w) => w.seed === 54)!;
    expect(first.units.map((u) => u.seq)).toContain(55); // seq is index + 1
    expect(first.units.length).toBeGreaterThan(1);
  });

  it('respects the budget it was given', () => {
    const t = transcript(200);
    for (const windows of [1, 3, 5, 9]) {
      const plan = planWindows(t, [10, 50, 90, 130, 170], {
        windows,
        maxChars: ASK_SESSION_CHARS - windowOverhead(windows),
      });
      const chars = plan.units.reduce((n, u) => n + u.text.length + UNIT_HEADER_CHARS, 0);
      expect(chars).toBeLessThanOrEqual(ASK_SESSION_CHARS);
    }
  });

  it('spends no more on five windows than one window is allowed to spend', () => {
    // Acceptance 4, stated as what is actually true rather than as what would
    // be nicer to say. The ceiling is per reader and does not move: five
    // windows are the same tokens taken from five places. What five windows
    // *do* change is how much of that ceiling gets used — a session whose one
    // hit was a 500-character exchange used to send 500 characters and leave
    // 7,500 unspent, and now sends five places instead. That is the whole
    // point, and it is why the run-level total in the report went up while no
    // reader's did.
    const t = transcript(200);
    const cost = (units: readonly TranscriptUnit[]): number =>
      units.reduce((n, u) => n + u.text.length + UNIT_HEADER_CHARS, 0);
    const five = planWindows(t, [10, 50, 90, 130, 170], {
      windows: 5,
      maxChars: ASK_SESSION_CHARS - windowOverhead(5),
    });
    expect(cost(five.units)).toBeLessThanOrEqual(ASK_SESSION_CHARS);
  });

  it('stays under the ceiling at every window count, on every unit size', () => {
    // The honest form of "five windows do not cost more than one". They can
    // cost more than one *did*, because one contiguous run routinely leaves
    // the slice half unspent — on the reference archive three of six readers
    // used 2.3–5.1 kB of an 8 kB allowance. What cannot happen is a reader
    // going over the allowance, at any `--windows n`, for any shape of
    // transcript. That is the invariant, and this is it.
    for (const size of [200, 800, 4_000, 40_000]) {
      const t = transcript(200, () => 'x'.repeat(size));
      for (const asked of [1, 2, 5, 11, 100]) {
        // Through `windowCount`, which is the only way `ask` ever gets here.
        const windows = windowCount(t.units.length, asked, ASK_SESSION_CHARS);
        const plan = planWindows(t, [10, 50, 90, 130, 170], {
          windows,
          maxChars: ASK_SESSION_CHARS - windowOverhead(windows),
        });
        const chars = plan.units.reduce((n, u) => n + u.text.length + UNIT_HEADER_CHARS, 0);
        expect(chars + windowOverhead(windows)).toBeLessThanOrEqual(ASK_SESSION_CHARS);
      }
    }
  });

  it('survives a transcript shorter than the windows asked for', () => {
    const plan = planWindows(transcript(3), [], { windows: 5, maxChars: ASK_SESSION_CHARS });
    expect(plan.units.length).toBeGreaterThan(0);
    expect(plan.windows.length).toBeLessThanOrEqual(3);
  });
});

// ================================================================ render

describe('windowText', () => {
  it('marks every discontinuity, and never splices two non-adjacent exchanges', () => {
    // Acceptance 5, checked structurally rather than by eye: walk the rendered
    // block and assert that between any two consecutive `[seq a]` `[seq b]`
    // with b > a + 1 there is a gap mark. This is the property the whole
    // module exists to keep, so it is checked over many shapes.
    const t = transcript(119);
    for (const hits of [[], [4], [4, 54], [0, 20, 40, 60, 80], [0, 1, 2]]) {
      const plan = planWindows(t, hits, { windows: 5, maxChars: ASK_SESSION_CHARS });
      const text = windowText(t, plan.units);
      const lines = text.split('\n').filter((l) => /^\[seq \d+/.test(l) || l.startsWith(WINDOW_GAP_MARK));
      let previous: number | null = null;
      for (const line of lines) {
        const m = /^\[seq (\d+)/.exec(line);
        if (!m) {
          previous = null; // a gap mark: the next seq may be anything
          continue;
        }
        const seq = Number(m[1]);
        if (previous !== null) expect(seq).toBe(previous + 1);
        previous = seq;
      }
    }
  });

  it('says how much is missing, and where', () => {
    const t = transcript(119);
    const plan = planWindows(t, [4, 54], { windows: 3, maxChars: ASK_SESSION_CHARS });
    const text = windowText(t, plan.units);
    expect(text).toMatch(/⋯ \d+ exchanges \(seq \d+–\d+\) not shown ⋯/);
  });

  it('tells the reader it is holding part of a session, not the whole of one', () => {
    const t = transcript(119);
    const plan = planWindows(t, [4, 54], { windows: 3, maxChars: ASK_SESSION_CHARS });
    const text = windowText(t, plan.units);
    expect(text).toContain('119-exchange session');
    expect(text).toContain('do not read across a mark');
  });

  it('counts the windows it prints from the marks it printed', () => {
    const t = transcript(119);
    const plan = planWindows(t, [], { windows: 4, maxChars: ASK_SESSION_CHARS });
    const text = windowText(t, plan.units);
    const runs = countRuns(seqsIn(text));
    expect(text.startsWith(`${runs} separated window`)).toBe(true);
  });

  it('fences a leading and a trailing cut', () => {
    const t = transcript(119);
    const plan = planWindows(t, [54], { windows: 2, maxChars: ASK_SESSION_CHARS });
    const text = windowText(t, plan.units);
    expect(text).toContain('earlier');
  });

  it('is empty for no units rather than a preamble about nothing', () => {
    expect(windowText(transcript(10), [])).toBe('');
  });
});

function countRuns(seqs: readonly number[]): number {
  let runs = 0;
  let last: number | null = null;
  for (const s of seqs) {
    if (last === null || s !== last + 1) runs += 1;
    last = s;
  }
  return runs;
}

// ============================================================ through ask
//
// The seam, used as a measuring instrument: `readerFn` records exactly what
// each reader was handed and makes the run structurally incapable of calling
// a model. This is how the before/after in `phases/phase-10/T10.5-REPORT.md`
// was measured on a real archive, at the same fidelity, with zero model calls.

const LONG = 'aaaaaaaa-0000-4000-8000-000000000001';
const SHORT = 'bbbbbbbb-0000-4000-8000-000000000002';
const FORK = 'cccccccc-0000-4000-8000-000000000003';

interface Seeded {
  root: string;
  db: ReturnType<typeof store.open>;
}

function seedDb(o: { longExchanges: number; withFork?: boolean } = { longExchanges: 60 }): Seeded {
  const root = scratch();
  const db = store.open({ root });
  const session = db.prepare(
    `INSERT INTO sessions (id, harness, title, project, project_slug, source_path, status,
        is_sidechain, started_at, ended_at, user_prompts, assistant_turns, bytes, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ins = db.prepare(
    `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text, files_touched)
     VALUES (?,?,?,?,?,?,?)`,
  );

  session.run(LONG, 'claude', 'the long one', '/tmp/Ledger', '-tmp-Ledger', '/tmp/a.jsonl', 'live', 0,
    '2026-08-01T09:00:00.000Z', '2026-08-08T09:00:00.000Z', o.longExchanges, o.longExchanges, 100,
    '2026-08-09T00:00:00.000Z');
  for (let i = 1; i <= o.longExchanges; i++) {
    // The word the question will use appears in the first exchange and in the
    // last, and nowhere between — the audit's shape exactly: a session that
    // opens with the topic and settles it eight days later.
    const topical = i === 1 || i === o.longExchanges;
    ins.run(`l${i}`, LONG, i, DAY(i),
      topical ? 'the pooler is 500ing on deploy' : `unrelated filler about topic ${i} `.repeat(30),
      topical
        ? 'pgbouncer in transaction mode cannot carry prepared statements, so we set ' +
          'statement_cache_size=0 on the client rather than moving the pooler to session mode.'
        : `assistant filler ${i} `.repeat(30),
      '[]');
  }

  session.run(SHORT, 'claude', 'the short one', '/tmp/Ledger', '-tmp-Ledger', '/tmp/b.jsonl', 'live', 0,
    '2026-08-02T09:00:00.000Z', '2026-08-02T10:00:00.000Z', 4, 4, 100, '2026-08-09T00:00:00.000Z');
  for (let i = 1; i <= 4; i++) {
    ins.run(`s${i}`, SHORT, i, DAY(i), 'the pooler again', `short answer ${i}`, '[]');
  }

  if (o.withFork) {
    // The audit's F4 shape: `claude --resume` writes a new transcript, the
    // work continues in it, and the words the question uses are in the
    // *parent*. Without the chain the fork is unreachable from this query.
    session.run(FORK, 'claude', 'the resume', '/tmp/Ledger', '-tmp-Ledger', '/tmp/c.jsonl', 'live', 0,
      '2026-08-09T09:00:00.000Z', '2026-08-09T10:00:00.000Z', 3, 3, 100, '2026-08-10T00:00:00.000Z');
    for (let i = 1; i <= 3; i++) {
      ins.run(`f${i}`, FORK, i, `2026-08-09T0${i}:00:00.000Z`,
        `what is still open after all that ${i}`, `still open: item ${i}`, '[]');
    }
    db.prepare(
      `INSERT INTO session_threads (session_id, thread_id, parent_id, head, depth, via, shared, overlap)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(LONG, LONG, null, 0, 0, null, 0, 0);
    db.prepare(
      `INSERT INTO session_threads (session_id, thread_id, parent_id, head, depth, via, shared, overlap)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(FORK, LONG, LONG, 1, 1, 'overlap', 40, 0.95);
  }

  db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
  return { root, db };
}

/** Runs `ask` with a recording reader. No model is constructed on this path. */
async function handed(
  seeded: Seeded,
  question: string,
  windows?: number,
): Promise<Map<string, AskReaderInput>> {
  const seen = new Map<string, AskReaderInput>();
  const readerFn: AskReaderFn = async (input) => {
    seen.set(input.sessionId, input);
    return { found: false, quotes: [], answer_fragment: '' };
  };
  await ask(seeded.db, question, {
    root: seeded.root,
    readerFn,
    openThreads: false,
    vectors: false,
    ...(windows !== undefined ? { windows } : {}),
  });
  return seen;
}

describe('what the readers are handed', () => {
  it('hands a long session several separated windows, not its opening', async () => {
    // The artifact, in miniature. On v1.1.0 this reader received `[1, 2, 3]`.
    const seeded = seedDb({ longExchanges: 60 });
    const seen = await handed(seeded, 'pgbouncer prepared statements pooler');
    const input = seen.get(LONG)!;
    expect(input).toBeDefined();
    expect(input.windows).toBeGreaterThan(1);
    expect(input.exchanges).toBe(60);
    expect(input.seqs).not.toEqual([1, 2, 3]);
    expect(countRuns(input.seqs)).toBe(input.windows);
    // ...and the last day is in it, which is the acceptance sentence.
    expect(input.seqs).toContain(60);
    seeded.db.close();
  });

  it('makes every discontinuity visible in the block the reader reads', async () => {
    const seeded = seedDb({ longExchanges: 60 });
    const seen = await handed(seeded, 'pgbouncer prepared statements pooler');
    const input = seen.get(LONG)!;
    expect(input.excerpts).toContain(WINDOW_GAP_MARK);
    const rendered = seqsIn(input.excerpts);
    expect(rendered).toEqual(input.seqs);
    // No two adjacent `[seq]` blocks may be non-consecutive without a mark.
    const lines = input.excerpts
      .split('\n')
      .filter((l) => /^\[seq \d+/.test(l) || l.startsWith(WINDOW_GAP_MARK));
    let previous: number | null = null;
    for (const line of lines) {
      const m = /^\[seq (\d+)/.exec(line);
      if (!m) {
        previous = null;
        continue;
      }
      if (previous !== null) expect(Number(m[1])).toBe(previous + 1);
      previous = Number(m[1]);
    }
    seeded.db.close();
  });

  it('leaves a short session exactly as it was', async () => {
    // Acceptance 6. Below the boundary the whole transcript fits in the slice,
    // so windowing could only remove text and add markers. The proof is that
    // the block carries neither a mark nor a preamble, and the seqs are the
    // contiguous run the pre-F5 code produced.
    const seeded = seedDb({ longExchanges: 60 });
    const seen = await handed(seeded, 'pooler again short answer');
    const input = seen.get(SHORT)!;
    expect(input).toBeDefined();
    expect(input.windows).toBe(1);
    expect(input.excerpts).not.toContain(WINDOW_GAP_MARK);
    expect(input.excerpts).not.toContain('separated window');
    expect(countRuns(input.seqs)).toBe(1);
    seeded.db.close();
  });

  it('--windows 1 restores the single contiguous run', async () => {
    const seeded = seedDb({ longExchanges: 60 });
    const seen = await handed(seeded, 'pgbouncer prepared statements pooler', 1);
    const input = seen.get(LONG)!;
    expect(input.windows).toBe(1);
    expect(countRuns(input.seqs)).toBe(1);
    expect(input.excerpts).not.toContain(WINDOW_GAP_MARK);
    seeded.db.close();
  });

  it('--windows n controls the count', async () => {
    const seeded = seedDb({ longExchanges: 120 });
    const three = await handed(seeded, 'pgbouncer prepared statements pooler', 3);
    const seven = await handed(seeded, 'pgbouncer prepared statements pooler', 7);
    expect(three.get(LONG)!.windows).toBe(3);
    expect(seven.get(LONG)!.windows).toBe(7);
    seeded.db.close();
  });

  it('keeps every reader inside the per-session budget', async () => {
    const seeded = seedDb({ longExchanges: 120 });
    for (const windows of [1, 5, 9]) {
      const seen = await handed(seeded, 'pgbouncer prepared statements pooler', windows);
      for (const input of seen.values()) {
        expect(input.excerpts.length).toBeLessThanOrEqual(ASK_SESSION_CHARS);
      }
    }
    seeded.db.close();
  });

  it('reads the other link of a fork/resume chain, and windows it too', async () => {
    // T10.3 made the thread an object; this is `ask` using it. The query's
    // words are in the parent only, so on the pre-T10.5 shortlist the resumed
    // transcript — which is where the work actually ended — was unreachable.
    const seeded = seedDb({ longExchanges: 60, withFork: true });
    const seen = await handed(seeded, 'pgbouncer prepared statements pooler');
    expect(seen.has(LONG)).toBe(true);
    expect(seen.has(FORK)).toBe(true);
    seeded.db.close();
  });
});
