import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store, indexAll, stripAnsi, type Db } from '@potsherd/core';
import {
  MAX_NOTE_FIELD,
  addNote,
  cleanAuthor,
  cleanNoteField,
  countNotes,
  countThreadNotes,
  currentNote,
  noteCountsForSessions,
  notesForSession,
  searchNotes,
  threadNotes,
} from '../packages/core/src/notes.js';
import { threadOf } from '../packages/core/src/threads.js';
import { runNote } from '../packages/cli/src/commands/note.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * T10.8 — the notes lane: `potsherd note`, the one verb that writes.
 *
 * `docs/AGENT-AUDIT-2026-08-23.md` §4.7 and `plans/phases/phase-10-agent-audit.md`
 * §B9. Four properties are the whole reason this file exists, and none of them
 * is a rendering detail:
 *
 *   **the transcript is never touched.** Asserted by hashing every `.jsonl` in
 *   the fixture before the write and after it, and comparing the digests. Not
 *   "the test did not notice a change" — the bytes, twice.
 *
 *   **append-only.** A second note on a thread is a second row. The first is
 *   read back afterwards and compared field by field, so a future
 *   "supersede" that quietly rewrites it fails here.
 *
 *   **the unit is the thread.** A note left against the parent of a
 *   fork/resume chain is found from the child, and the other way round. This
 *   is the F4 fix (T10.3) doing the work it was built for: an agent notes the
 *   id it happens to be holding, and the note lands on the chain.
 *
 *   **a note is not transcript.** Its words reach `notes_fts` and reach
 *   nothing else — asserted against `exchanges_fts` directly, because the
 *   failure this guards is exactly "the assertion lane leaked into the
 *   evidence lane".
 *
 * Every id below is visibly invented: three distinct hex digits and no more,
 * the rule `scripts/check-privacy.py`'s entropy test enforces.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

const PROJECT = '/tmp/potsherd-notes';
const SLUG = '-tmp-potsherd-notes';

const ID = {
  parent: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
  child: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  lone: 'cccccccc-2222-4222-8222-cccccccccccc',
} as const;

type Rec = Record<string, unknown>;

function scratch(): { claudeDir: string; root: string } {
  const base = tempDir('potsherd-notes-');
  dirs.push(base);
  return { claudeDir: path.join(base, 'claude'), root: path.join(base, 'potsherd') };
}

function pair(sessionId: string, n: number, day: string, tag: string): Rec[] {
  const base = { sessionId, cwd: PROJECT, version: '2.1.238', gitBranch: 'main' };
  const at = (m: number): string =>
    `${day}T0${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:00.000Z`;
  return [
    {
      ...base,
      type: 'user',
      promptId: `${tag}-p${n}`,
      uuid: `${tag}-u${n}`,
      timestamp: at(n * 2),
      message: { role: 'user', content: `${tag} question ${n} about the connection pooler` },
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

/** A parent and a resume of it, exactly the shape `threads.test.ts` writes. */
function writeChain(claudeDir: string): void {
  const parent: Rec[] = [];
  for (let n = 1; n <= 10; n += 1) parent.push(...pair(ID.parent, n, '2026-08-12', 'p'));
  const child: Rec[] = parent.slice(0, 20).map((r) => {
    const copy: Rec = { ...r, sessionId: ID.child, session_id: ID.parent };
    delete copy.promptId;
    return copy;
  });
  for (let n = 1; n <= 3; n += 1) child.push(...pair(ID.child, n, '2026-08-20', 'pc'));
  const lone: Rec[] = [];
  for (let n = 1; n <= 6; n += 1) lone.push(...pair(ID.lone, n, '2026-07-01', 'q'));
  writeSession(claudeDir, ID.parent, parent);
  writeSession(claudeDir, ID.child, child);
  writeSession(claudeDir, ID.lone, lone);
}

async function indexed(): Promise<{ db: Db; claudeDir: string; root: string }> {
  const { claudeDir, root } = scratch();
  writeChain(claudeDir);
  await indexAll({ claudeDir, root, harnesses: ['claude'], embed: false });
  return { db: store.open({ root }), claudeDir, root };
}

/** Every transcript under a directory, digested. The proof, not a proxy. */
function digests(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

/** Capture everything a verb prints, the way a terminal would see it. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: chunks.join('') };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

// ------------------------------------------------------- the thread is the unit

describe('a note attaches to the thread, not to the id that was typed', () => {
  it('is found from either end of a fork/resume chain', async () => {
    const { db } = await indexed();
    try {
      const chain = threadOf(db, ID.parent);
      expect(chain.sessions).toEqual([ID.parent, ID.child]);

      // Noted against the *parent* — the id an agent holding the older
      // transcript would have.
      addNote(db, {
        sessionId: ID.parent,
        decided: 'the pooler stays in transaction mode',
        at: '2026-08-20T10:00:00.000Z',
      });

      // Read back from the child, which is the transcript `--resume` writes.
      const fromChild = notesForSession(db, ID.child);
      expect(fromChild).toHaveLength(1);
      expect(fromChild[0]!.decided).toBe('the pooler stays in transaction mode');
      // Both columns are kept: what it was told, and what that meant.
      expect(fromChild[0]!.sessionId).toBe(ID.parent);
      expect(fromChild[0]!.threadId).toBe(chain.id);
    } finally {
      db.close();
    }
  });

  it('a session that is nobody\'s fork is a thread of one', async () => {
    const { db } = await indexed();
    try {
      addNote(db, { sessionId: ID.lone, next: 'unblock the disk alert' });
      expect(threadNotes(db, ID.lone)).toHaveLength(1);
      // and it did not leak onto the chain
      expect(notesForSession(db, ID.parent)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('accepts every id form the other verbs accept, through the verb itself', async () => {
    const { db, root } = await indexed();
    db.close();
    // An 8-character prefix (what `ls` prints), then the whole id.
    const first = await capture(() =>
      runNote({
        potsherdDir: root,
        json: true,
        session: ID.child.slice(0, 8),
        decided: ['prefix form works'],
      }),
    );
    const second = await capture(() =>
      runNote({ potsherdDir: root, json: true, session: ID.parent, next: ['whole-id form works'] }),
    );
    const a = JSON.parse(first.out) as { wrote: { threadId: string } };
    const b = JSON.parse(second.out) as { wrote: { threadId: string }; earlier: number };
    expect(a.wrote.threadId).toBe(b.wrote.threadId);
    expect(b.earlier).toBe(1);
  });

  it('refuses a ref that resolves to nothing, and names the fix', async () => {
    const { db, root } = await indexed();
    db.close();
    await expect(
      runNote({ potsherdDir: root, session: 'ffffffff', decided: ['nope'] }),
    ).rejects.toThrow(/no session in the index/);
  });
});

// ------------------------------------------------ the transcript is never touched

describe('append-only, and the archive is never mutated', () => {
  it('leaves every transcript byte-identical', async () => {
    const { db, claudeDir, root } = await indexed();
    const before = digests(claudeDir);
    expect(before.size).toBe(3);

    addNote(db, {
      sessionId: ID.parent,
      decided: 'notes are append-only',
      open: 'whether ls should mark a noted thread',
      next: 'wire notes_fts into recall',
    });
    db.close();

    // …and through the verb as well, since the CLI is the path a user takes.
    await capture(() =>
      runNote({
        potsherdDir: root,
        session: ID.child.slice(0, 8),
        decided: ['written through the CLI'],
      }),
    );

    const after = digests(claudeDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, hash] of before) {
      expect(after.get(file), `${path.basename(file)} changed on disk`).toBe(hash);
    }
  });

  it('a second note appends; the first is still there, unchanged', async () => {
    const { db } = await indexed();
    try {
      const one = addNote(db, {
        sessionId: ID.parent,
        decided: 'we ship the lane',
        at: '2026-08-20T10:00:00.000Z',
      });
      const two = addNote(db, {
        sessionId: ID.child,
        decided: 'on reflection, we ship it behind a flag',
        at: '2026-08-20T16:00:00.000Z',
      });

      expect(two.previous).toBe(1);
      const all = threadNotes(db, one.note.threadId);
      expect(all).toHaveLength(2);
      // Newest first, and the older row is byte-for-byte what it was.
      expect(all[0]!.id).toBe(two.note.id);
      expect(all[1]).toEqual(one.note);
      expect(currentNote(db, one.note.threadId)!.id).toBe(two.note.id);
      expect(countThreadNotes(db, one.note.threadId)).toBe(2);
      expect(countNotes(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  it('never issues an UPDATE or a DELETE against notes', () => {
    // The property is a promise about the module, so it is checked against the
    // module. A behavioural test can only ever show that today's code paths do
    // not delete; this shows that no code path exists that could.
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/core/src/notes.ts'),
      'utf8',
    );
    const statements = src.match(/\b(UPDATE|DELETE)\s+(FROM\s+)?notes\b/gi) ?? [];
    expect(statements).toEqual([]);
    const cli = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/cli/src/commands/note.ts'),
      'utf8',
    );
    expect(cli.match(/\b(UPDATE|DELETE)\b/g) ?? []).toEqual([]);
  });
});

// --------------------------------------------------------------- its own lane

describe('a note is searchable, in a lane of its own', () => {
  it('reaches notes_fts and comes back labelled kind: note', async () => {
    const { db } = await indexed();
    try {
      addNote(db, {
        sessionId: ID.parent,
        decided: 'the pgbouncer pool size is pinned at sixteen',
        next: 'measure the p99 again next week',
      });
      const hits = searchNotes(db, '"pgbouncer"');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.kind).toBe('note');
      expect(hits[0]!.decided).toContain('pgbouncer');
      expect(hits[0]!.threadId).toBe(threadOf(db, ID.parent).id);
      // Its own field weights, its own ranking: a real bm25 number.
      expect(Number.isFinite(hits[0]!.rank)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('does not leak into the transcript lane', async () => {
    const { db } = await indexed();
    try {
      addNote(db, { sessionId: ID.parent, decided: 'quenepa is the marker word' });
      // The word exists in exactly one place, and that place is not a
      // transcript index. This is the assertion/evidence boundary, checked at
      // the level where it would actually break.
      const inTranscripts = db
        .prepare(`SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH '"quenepa"'`)
        .get() as { n: number };
      expect(inTranscripts.n).toBe(0);
      const inNotes = db
        .prepare(`SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH '"quenepa"'`)
        .get() as { n: number };
      expect(inNotes.n).toBe(1);
      // And nothing was written into the transcript tables at all.
      const exchanges = db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number };
      addNote(db, { sessionId: ID.parent, next: 'another note' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number }).n).toBe(
        exchanges.n,
      );
    } finally {
      db.close();
    }
  });

  it('counts per session, for a listing that has one line per row', async () => {
    const { db } = await indexed();
    try {
      addNote(db, { sessionId: ID.parent, decided: 'one' });
      addNote(db, { sessionId: ID.parent, decided: 'two' });
      const counts = noteCountsForSessions(db, [ID.parent, ID.child, ID.lone]);
      // Both ends of the chain report the chain's notes.
      expect(counts.get(ID.parent)).toBe(2);
      expect(counts.get(ID.child)).toBe(2);
      expect(counts.has(ID.lone)).toBe(false);
    } finally {
      db.close();
    }
  });
});

// ----------------------------------------------------------- nothing inferred

describe('a note records what it was told and nothing else', () => {
  it('does not guess an author', async () => {
    const { db } = await indexed();
    try {
      const anon = addNote(db, { sessionId: ID.parent, decided: 'no --by given' });
      expect(anon.note.author).toBe('unknown');
      expect(anon.note.via).toBe('cli');
      const said = addNote(db, {
        sessionId: ID.parent,
        decided: 'stated',
        author: 'agent',
        via: 'mcp',
      });
      expect(said.note.author).toBe('agent');
      expect(said.note.via).toBe('mcp');
    } finally {
      db.close();
    }
  });

  it('keeps the words as typed, and keeps repeats', () => {
    expect(cleanNoteField(['  spaces trimmed  '], 'decided')).toBe('spaces trimmed');
    // Case, punctuation and internal spacing survive — a note is prose, not a
    // key, so `tags.ts`'s slugging would be a lie about what was said.
    expect(cleanNoteField(['Pin PgBouncer to 16 — measured, not guessed.'], 'decided')).toBe(
      'Pin PgBouncer to 16 — measured, not guessed.',
    );
    // Two `--decided` flags keep both; commander's last-wins would drop one.
    expect(cleanNoteField(['first', 'second'], 'decided')).toBe('first; second');
    expect(cleanNoteField(['a\r\nb'], 'decided')).toBe('a\nb');
    expect(cleanAuthor(undefined)).toBe('unknown');
    expect(cleanAuthor('  Claude   Opus 5 ')).toBe('Claude Opus 5');
  });

  it('refuses rather than truncating', async () => {
    const { db } = await indexed();
    try {
      expect(() =>
        addNote(db, { sessionId: ID.parent, decided: 'x'.repeat(MAX_NOTE_FIELD + 1) }),
      ).toThrow(/limit is 2000/);
      // Nothing partial was written.
      expect(countNotes(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('refuses an empty note, and names the flags that fix it', async () => {
    const { db } = await indexed();
    try {
      expect(() => addNote(db, { sessionId: ID.parent })).toThrow(/--decided/);
    } finally {
      db.close();
    }
  });
});

// ------------------------------------------------------------------- the verb

describe('the verb, judged against plans/05', () => {
  it('writes a receipt inside 80 columns whose last line names the next verb', async () => {
    const { db, root } = await indexed();
    db.close();
    const { code, out } = await capture(() =>
      runNote({
        potsherdDir: root,
        width: 80,
        color: false,
        session: ID.child.slice(0, 8),
        decided: ['the notes lane is append-only; the transcript is never rewritten'],
        open: ['whether ls should mark a thread that already carries a note'],
        next: ['wire notes_fts into recall as its own lane'],
        by: 'agent',
      }),
    );
    expect(code).toBe(0);
    const lines = stripAnsi(out).trimEnd().split('\n');
    for (const line of lines) expect(line.length, `too wide: ${line}`).toBeLessThanOrEqual(80);
    expect(lines[lines.length - 1]).toMatch(/potsherd graft/);
    const text = lines.join('\n');
    expect(text).toMatch(/decided/);
    expect(text).toMatch(/the transcript was not touched/);
    expect(text).toMatch(/by agent/);
  });

  it('says how many earlier notes survived a second write', async () => {
    const { db, root } = await indexed();
    db.close();
    await capture(() =>
      runNote({ potsherdDir: root, width: 80, session: ID.parent, decided: ['first'] }),
    );
    const { out } = await capture(() =>
      runNote({ potsherdDir: root, width: 80, color: false, session: ID.parent, decided: ['second'] }),
    );
    expect(stripAnsi(out)).toMatch(/1 earlier note on this thread is still there/);
  });

  it('with no field flags it reads the lane back', async () => {
    const { db, root } = await indexed();
    db.close();
    const empty = await capture(() =>
      runNote({ potsherdDir: root, width: 80, color: false, session: ID.lone }),
    );
    expect(stripAnsi(empty.out)).toMatch(/no notes on this thread yet/);

    await capture(() =>
      runNote({ potsherdDir: root, session: ID.lone, decided: ['read me back'], by: 'agent' }),
    );
    const listed = await capture(() =>
      runNote({ potsherdDir: root, width: 80, color: false, session: ID.lone }),
    );
    const text = stripAnsi(listed.out);
    expect(text).toMatch(/read me back/);
    // The label that keeps the lane honest on a human screen.
    expect(text).toMatch(/assertions/);
    expect(text.trimEnd().split('\n').pop()).toMatch(/potsherd graft/);
  });

  it('--json carries the same data, on both the write and the read', async () => {
    const { db, root } = await indexed();
    db.close();
    const wrote = JSON.parse(
      (
        await capture(() =>
          runNote({
            potsherdDir: root,
            json: true,
            session: ID.parent,
            decided: ['json write'],
            next: ['json next'],
            by: 'agent',
          }),
        )
      ).out,
    ) as {
      lane: string;
      appended: boolean;
      superseded: null;
      transcriptTouched: boolean;
      thread: { id: string; sessions: string[] };
      wrote: Record<string, unknown>;
      notes: Record<string, unknown>[];
    };

    expect(wrote.lane).toBe('notes');
    expect(wrote.appended).toBe(true);
    expect(wrote.superseded).toBeNull();
    expect(wrote.transcriptTouched).toBe(false);
    expect(wrote.thread.sessions).toEqual([ID.parent, ID.child]);
    expect(wrote.wrote).toMatchObject({
      kind: 'note',
      citable: false,
      decided: 'json write',
      next: 'json next',
      author: 'agent',
      via: 'cli',
    });

    const read = JSON.parse(
      (await capture(() => runNote({ potsherdDir: root, json: true, session: ID.child }))).out,
    ) as { lane: string; current: Record<string, unknown>; notes: Record<string, unknown>[] };
    expect(read.lane).toBe('notes');
    expect(read.notes).toHaveLength(1);
    // Same object shape from both directions — `05`'s "--json on everything,
    // identical data to the human view" also means identical between verbs.
    expect(read.current).toEqual(wrote.wrote);
    // Every note object says what it is, on its own, without the envelope.
    for (const n of read.notes) {
      expect(n['kind']).toBe('note');
      expect(n['citable']).toBe(false);
    }
  });
});
