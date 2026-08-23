import type { Db } from './db.js';
import { threadOf, type Thread } from './threads.js';

/**
 * L6½ — the notes lane. **The only place potsherd writes prose.**
 *
 * ## Why this file exists
 *
 * `docs/AGENT-AUDIT-2026-08-23.md` §4.7: *"Every verb is read-only, so the
 * archive never learns. Let me leave a marker at the end of a session: this
 * thread decided X, left Y open, next step Z. Cheap for me (I already know it,
 * it costs one tool call) … This is also how you get card coverage above 10%
 * without a 677 MB dependency — I write the cards, as I go, for free."*
 *
 * The measurement behind that sentence is F6: 32 of 353 sessions had a card,
 * because `card` needs a model. A note needs nobody's model. It is written by
 * the agent or the human that just lived the thread, and it costs one tool
 * call.
 *
 * ## What a note is, and what it is not
 *
 * A note is an **assertion by whoever wrote it**. It is not a transcript, it
 * is not a quotation, and it is not evidence. `tags.ts`'s opening line calls
 * tags, pins and links "the three things the *user* says about a session, as
 * opposed to everything else in the index, which the machine said" — a note is
 * the fourth, and the only one with sentences in it, which is exactly what
 * makes it dangerous. `03`'s Bet 02, restated by the audit's §6: *"If a card
 * can be cited as evidence, you have rebuilt the hallucination problem inside
 * the tool that exists to prevent it."* Everything a card is barred from, a
 * note is barred from twice over, because a card at least had a transcript in
 * front of it.
 *
 * Three things keep it in its lane, and only the first two are code:
 *
 *   1. **Its own table and its own fts index.** Nothing here writes to
 *      `exchanges`, `exchanges_fts`, `cards` or any transcript file. A note is
 *      unreachable from every query that reads transcript text.
 *   2. **No `seq`.** `ask.ts`'s `filterAnswer` resolves every proposed quote to
 *      a `(sessionId, seq)` pair in `EvidenceSource.units`, which is built from
 *      `exchanges` rows and nothing else. A note has no seq and no exchange, so
 *      a quote lifted from one is dropped as `unresolved-seq` before a user
 *      sees it — the same structural stop that makes a card uncitable, and for
 *      the same reason.
 *   3. **Labelling in the surfaces.** `kind: 'note'` and the word `assertion`
 *      on the human line. That part is convention today: it stops a *reader*
 *      confusing the two, not a *program*, and `T10.8-REPORT.md` says so
 *      plainly rather than claiming a guarantee this file does not provide.
 *
 * ## Append-only, and why that is not a slogan
 *
 * There is no `UPDATE` and no `DELETE` in this file. Not "no user-facing
 * delete" — none at all. A second `note` on the same thread writes a **second
 * row**; the first is still readable afterwards, byte for byte, and
 * {@link threadNotes} returns both. Superseding would have meant writing to a
 * row that had already been written, and refusing would have meant failing at
 * the exact moment the agent has something new to say. The archive is allowed
 * to grow and is not allowed to shrink, so an agent that changes its mind at
 * 4pm leaves a record that it changed its mind, which is more information than
 * either alternative preserves.
 *
 * "Which note is current" is therefore **derived** (`MAX(id)`, and
 * {@link threadNotes} returns newest first) rather than stored. A derived
 * answer cannot go stale, and cannot be left wrong by a write that stopped
 * halfway.
 *
 * ## The unit is the thread, not the session
 *
 * `threads.ts` (T10.3) is what makes this verb worth having: the session
 * someone worked in yesterday is a 4-exchange stub whose other 1,660 records
 * live under the id the fork copied them from, so a note filed against the id
 * the agent happens to be holding would land on the stub. {@link addNote}
 * resolves the ref to its chain and files the note against the **thread**,
 * while still recording the session id it was handed — see migration 12 for
 * why both columns exist.
 */

/**
 * Longest a single field may be, in characters.
 *
 * Long enough for a real paragraph of verdict and far short of a transcript.
 * Over the cap {@link cleanNoteField} **refuses** rather than truncating: this
 * is the write path, and silently storing 2,000 of someone's 2,400 characters
 * is data loss dressed up as success. The error names the fix.
 */
export const MAX_NOTE_FIELD = 2000;

/** Longest `--by` value stored. A name or a role, not a sentence. */
export const MAX_AUTHOR = 64;

/** Where the note came in from. Known for certain; never guessed. */
export type NoteVia = 'cli' | 'mcp' | 'api';

/** What one note says. At least one of the three has to be non-empty. */
export interface NoteInput {
  /** The ref the caller named, already resolved to a real id. */
  sessionId: string;
  /** "this thread decided X". Repeats are joined, never dropped. */
  decided?: readonly string[] | string | null;
  /** "left Y open". */
  open?: readonly string[] | string | null;
  /** "next step Z". */
  next?: readonly string[] | string | null;
  /**
   * Who wrote it, **as stated**. `undefined` stores `'unknown'`.
   *
   * potsherd cannot tell an agent running `potsherd note` from a human running
   * the same command — a terminal is a terminal. Rather than guess from an
   * environment variable and record the guess as a fact, the column says
   * `unknown` until somebody says otherwise. {@link NoteRow.via} is the half
   * that *is* certain.
   */
  author?: string | null;
  via?: NoteVia;
  /** Injected by tests; production always passes the real clock. */
  at?: string;
}

export interface NoteRow {
  id: number;
  threadId: string;
  sessionId: string;
  decided: string;
  open: string;
  next: string;
  author: string;
  via: string;
  writtenAt: string;
}

export interface NoteWrite {
  note: NoteRow;
  /** The chain the note was filed against, from `threads.ts`. */
  thread: Thread;
  /**
   * How many notes this thread already carried. `> 0` is the second-write
   * case, and the receipt says so rather than pretending the note is the
   * first.
   */
  previous: number;
}

/** A `notes_fts` match, shaped so a fusion can treat it as one more list. */
export interface NoteHit {
  kind: 'note';
  noteId: number;
  threadId: string;
  sessionId: string;
  decided: string;
  open: string;
  next: string;
  author: string;
  writtenAt: string;
  /** bm25. Lower is better, as everywhere else in `recall.ts`. */
  rank: number;
}

/** Raised by {@link cleanNoteField}; carries the one command that fixes it. */
export class NoteFieldError extends Error {
  constructor(message: string, public readonly fix: string) {
    super(message);
    this.name = 'NoteFieldError';
  }
}

/**
 * Normalise one field on the way in — **and normalise almost nothing.**
 *
 * `tags.ts` lowercases, strips punctuation and collapses a tag to a slug,
 * because a tag is a key that has to match another key. A note is not a key.
 * It is a sentence somebody wrote, it is going to be read back to them, and
 * every "helpful" transformation is a small lie about what they said. So this
 * does exactly three things, all of them reversible-looking to a reader:
 *
 *   - normalises line endings (`\r\n` -> `\n`), because a `\r` in a terminal
 *     rewrites the line it is on and would make the receipt print wrong;
 *   - trims leading and trailing whitespace, including of each joined part;
 *   - joins repeats with `; `, so `--decided a --decided b` keeps both. The
 *     alternative — commander's last-wins — silently discards the first, which
 *     is the failure mode this whole file is built to not have.
 *
 * Anything over {@link MAX_NOTE_FIELD} raises rather than truncates.
 */
export function cleanNoteField(
  raw: readonly string[] | string | null | undefined,
  flag: string,
): string {
  const parts = (Array.isArray(raw) ? raw : raw == null ? [] : [raw as string])
    .map((s) => String(s).replace(/\r\n?/g, '\n').trim())
    .filter((s) => s.length > 0);
  const joined = parts.join('; ');
  if (joined.length > MAX_NOTE_FIELD) {
    throw new NoteFieldError(
      `--${flag} is ${joined.length} characters; the limit is ${MAX_NOTE_FIELD}`,
      'shorten it, or leave two notes — the lane is append-only, so both are kept',
    );
  }
  return joined;
}

/** `--by` as stated, trimmed and capped. Never invented. */
export function cleanAuthor(raw: string | null | undefined): string {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_AUTHOR)
    .trim();
  return cleaned || 'unknown';
}

/**
 * Append one note to a thread.
 *
 * The only write in this file, and it is an `INSERT` into two tables inside one
 * transaction — the same shape and the same reason as `cards/write.ts`: a note
 * present in `notes` but absent from `notes_fts` is a note nothing can find,
 * which is worse than not having written it.
 *
 * Throws {@link NoteFieldError} when all three fields are empty. An empty note
 * is not a cheap no-op: it would occupy the newest-first slot and make the
 * thread look answered.
 */
export function addNote(db: Db, input: NoteInput): NoteWrite {
  const decided = cleanNoteField(input.decided, 'decided');
  const open = cleanNoteField(input.open, 'open');
  const next = cleanNoteField(input.next, 'next');

  if (!decided && !open && !next) {
    throw new NoteFieldError(
      'a note needs something to say — give at least one of --decided, --open, --next',
      `potsherd note ${input.sessionId.slice(0, 8)} --decided "..." --next "..."`,
    );
  }

  const thread = threadOf(db, input.sessionId);
  const author = cleanAuthor(input.author);
  const via = input.via ?? 'cli';
  const writtenAt = input.at ?? new Date().toISOString();
  const previous = countThreadNotes(db, thread.id);

  const write = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO notes (thread_id, session_id, decided, open, next_step, author, via, written_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(thread.id, input.sessionId, decided, open, next, author, via, writtenAt);
    const id = Number(info.lastInsertRowid);
    // External-content fts5: the row id is the note's own rowid, and because
    // nothing here ever deletes or updates a note, the 'delete' command form
    // `cards/write.ts` has to issue before every rewrite has no counterpart.
    db.prepare(
      `INSERT INTO notes_fts (rowid, decided, open, next_step) VALUES (?, ?, ?, ?)`,
    ).run(id, decided, open, next);
    return id;
  });

  const id = write();
  return {
    note: {
      id,
      threadId: thread.id,
      sessionId: input.sessionId,
      decided,
      open,
      next,
      author,
      via,
      writtenAt,
    },
    thread,
    previous,
  };
}

// --------------------------------------------------------------------- reads

const SELECT_NOTE = `SELECT id, thread_id, session_id, decided, open, next_step, author, via, written_at
                       FROM notes`;

interface NoteDbRow {
  id: number;
  thread_id: string;
  session_id: string;
  decided: string;
  open: string;
  next_step: string;
  author: string;
  via: string;
  written_at: string;
}

function toNote(r: NoteDbRow): NoteRow {
  return {
    id: r.id,
    threadId: r.thread_id,
    sessionId: r.session_id,
    decided: r.decided,
    open: r.open,
    next: r.next_step,
    author: r.author,
    via: r.via,
    writtenAt: r.written_at,
  };
}

/**
 * Every note on a thread, **newest first**.
 *
 * Ordered by `id` and not by `written_at`, because `written_at` is a value the
 * caller may supply and two notes a second apart can carry the same string.
 * `id` is the order the rows were actually accepted in, which is the only
 * ordering the store can vouch for.
 */
export function threadNotes(db: Db, threadId: string): NoteRow[] {
  return (
    db.prepare(`${SELECT_NOTE} WHERE thread_id = ? ORDER BY id DESC`).all(threadId) as NoteDbRow[]
  ).map(toNote);
}

/** The notes on the thread this session belongs to, newest first. */
export function notesForSession(db: Db, sessionId: string): NoteRow[] {
  return threadNotes(db, threadOf(db, sessionId).id);
}

/** The current verdict on a thread: the newest note, or null. */
export function currentNote(db: Db, threadId: string): NoteRow | null {
  const row = db.prepare(`${SELECT_NOTE} WHERE thread_id = ? ORDER BY id DESC LIMIT 1`).get(
    threadId,
  ) as NoteDbRow | undefined;
  return row ? toNote(row) : null;
}

export function countThreadNotes(db: Db, threadId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM notes WHERE thread_id = ?').get(threadId) as {
    n: number;
  };
  return row.n;
}

/** How many notes the whole index carries — what `stats` and `doctor` want. */
export function countNotes(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n;
}

/**
 * Notes per session, in one query — the `ls` shape, borrowed from
 * {@link import('./tags.js').tagsForSessions} for the same reason: a listing
 * that renders a marker per row must not run a statement per row.
 *
 * Keyed by **session** id even though notes are stored per thread, because
 * that is what a listing has in its hand. Every session in a chain reports the
 * chain's notes, which is the point of filing against the thread.
 */
export function noteCountsForSessions(
  db: Db,
  ids: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  // One statement, one pass: map each requested id to its thread, then count
  // notes per thread. `session_threads` is missing for a session that is a
  // thread of one, so `COALESCE` falls back to the session's own id — exactly
  // what `threadOf` does, expressed in SQL rather than in a loop of queries.
  const placeholders = ids.map(() => '?').join(',');
  const counted = db
    .prepare(
      `SELECT r.id AS session_id, COUNT(n.id) AS n
         FROM (SELECT s.id AS id,
                      COALESCE(t.thread_id, s.id) AS thread_id
                 FROM sessions s
                 LEFT JOIN session_threads t ON t.session_id = s.id
                WHERE s.id IN (${placeholders})) r
         LEFT JOIN notes n ON n.thread_id = r.thread_id
        GROUP BY r.id`,
    )
    .all(...ids) as { session_id: string; n: number }[];
  for (const r of counted) if (r.n > 0) out.set(r.session_id, r.n);
  // A ghost has no row in `sessions`, so the query above cannot see it. Its
  // thread is itself.
  const missing = ids.filter((id) => !counted.some((r) => r.session_id === id));
  if (missing.length > 0) {
    const rows2 = db
      .prepare(
        `SELECT thread_id, COUNT(*) AS n FROM notes
          WHERE thread_id IN (${missing.map(() => '?').join(',')})
          GROUP BY thread_id`,
      )
      .all(...missing) as { thread_id: string; n: number }[];
    for (const r of rows2) if (r.n > 0) out.set(r.thread_id, r.n);
  }
  return out;
}

/**
 * bm25 over `notes_fts` — **its own list, and its own `kind`.**
 *
 * Deliberately not joined to `sessions`: a note can be filed against a ghost,
 * a thread whose head was swept, or a session id that has since been
 * re-indexed under a new chain, and a join would silently hide all three. The
 * caller filters if it wants to; this returns what the lane holds.
 *
 * `kind: 'note'` is set here rather than by the caller so that no fusion can
 * accidentally file these rows under `exchange`. It is the label the human
 * view and `--json` both read.
 */
export function searchNotes(db: Db, match: string, limit = 20): NoteHit[] {
  if (!match.trim()) return [];
  const rows = db
    .prepare(
      `SELECT n.id AS id, n.thread_id AS thread_id, n.session_id AS session_id,
              n.decided AS decided, n.open AS open, n.next_step AS next_step,
              n.author AS author, n.written_at AS written_at,
              bm25(notes_fts, 1.4, 1.0, 1.2) AS rank
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, limit) as (NoteDbRow & { rank: number })[];
  return rows.map((r) => ({
    kind: 'note' as const,
    noteId: r.id,
    threadId: r.thread_id,
    sessionId: r.session_id,
    decided: r.decided,
    open: r.open,
    next: r.next_step,
    author: r.author,
    writtenAt: r.written_at,
    rank: r.rank,
  }));
}

/** True when the index has been migrated far enough to hold notes. */
export function notesTableExists(db: Db): boolean {
  return (
    db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
      .get() !== undefined
  );
}

/**
 * One line summarising a note, for a listing that has one line to spend.
 *
 * The `decided` field first because it is the one that answers "what happened
 * here"; `next` when there was no decision, because a thread with only a next
 * step is a thread that was interrupted.
 */
export function noteHeadline(n: Pick<NoteRow, 'decided' | 'open' | 'next'>): string {
  return (n.decided || n.next || n.open || '').replace(/\s+/g, ' ').trim();
}
