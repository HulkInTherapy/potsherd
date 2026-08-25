import { fitLine, format as fmt, idTag, Theme } from '@potsherd/core';
// `notes.ts` is not in core's barrel (`packages/core/src/index.ts` belongs to
// the orchestrator this phase), so it is imported by path. The subgraph that
// comes with it — `notes.ts` and `threads.ts` — holds no module-level state and
// imports `Db` as a type only, so there is no second copy of the driver or of
// the connection cache. `T10.8-REPORT.md` carries the one-line barrel export to
// fold in afterwards, at which point this line becomes a normal one.
import {
  NoteFieldError,
  addNote,
  countThreadNotes,
  noteHeadline,
  notesTableExists,
  threadNotes,
  type NoteRow,
  type NoteVia,
} from '../../../core/src/notes.js';
import { openIndex } from '../filters.js';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { mustResolve } from '../session-ref.js';

/**
 * `potsherd note <thread> --decided … --open … --next …`
 *
 * **The one verb that writes.** Twenty-odd verbs read the archive; this is the
 * only one that adds to it, which is why every choice below is the timid one.
 *
 * The audit (`docs/AGENT-AUDIT-2026-08-23.md` §4.7) asked for exactly this and
 * gave the reason: *"Every verb is read-only, so the archive never learns."*
 * The measurement behind it is F6 — 32 of 353 sessions carried a card, because
 * a card costs a model call. A note costs nothing, and the agent that just
 * lived the thread already knows what it says.
 *
 * Three rules the output holds to, all of them from `plans/05`:
 *
 *   - the receipt says what it wrote and **what it did not touch**;
 *   - a second note says how many earlier ones are still there, because the
 *     one question a writer has at that moment is "did I just overwrite
 *     something";
 *   - the last line names the next verb, and for a note that is `graft` — the
 *     note exists so the *next* session can pick the thread up.
 *
 * With no field flags it reads the lane back instead of writing, the same way
 * `potsherd tag <id>` with no operands lists the tags. A write verb that has a
 * safe no-argument form is a write verb people are willing to type.
 */
export interface NoteCommandOptions extends GlobalOptions {
  /** Any ref the other verbs take: an 8-character prefix, or a whole id. */
  session: string;
  decided?: string[];
  open?: string[];
  next?: string[];
  /** `--by`. Recorded verbatim; never inferred. */
  by?: string;
  /** Set by the MCP server; `cli` from a terminal. */
  via?: NoteVia;
}

const LABEL_W = 9;

export async function runNote(o: NoteCommandOptions): Promise<number> {
  const { db } = openIndex(o);
  try {
    if (!notesTableExists(db)) {
      // Migration 12 creates it, and `open()` runs migrations — so this can
      // only be an index a *newer* potsherd wrote and an older one opened, or
      // a migration that declined. Either way, say the command that fixes it.
      throw new UserError(
        'this index has no notes lane yet',
        'potsherd index    # migration 12 creates it',
      );
    }

    const found = mustResolve(db, o.session, 'note');
    const t = themeFrom(o);

    const writing =
      (o.decided?.length ?? 0) > 0 || (o.open?.length ?? 0) > 0 || (o.next?.length ?? 0) > 0;

    if (!writing) {
      return readBack(db, o, t, found);
    }

    const result = addNote(db, {
      sessionId: found.id,
      decided: o.decided ?? [],
      open: o.open ?? [],
      next: o.next ?? [],
      author: o.by ?? null,
      via: o.via ?? 'cli',
    });

    if (o.json) {
      printJson({
        lane: 'notes',
        appended: true,
        // Nothing was rewritten and nothing was deleted — the two facts a
        // machine reading this needs in order to trust the lane.
        superseded: null,
        transcriptTouched: false,
        thread: result.thread,
        earlier: result.previous,
        wrote: jsonNote(result.note),
        notes: threadNotes(db, result.thread.id).map(jsonNote),
      });
      return 0;
    }

    print(receipt(t, found, result.note, result.thread.sessions.length, result.previous));
    return 0;
  } catch (err) {
    if (err instanceof NoteFieldError) throw new UserError(err.message, err.fix);
    throw err;
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------- read

function readBack(
  db: ReturnType<typeof openIndex>['db'],
  o: NoteCommandOptions,
  t: Theme,
  found: { id: string; kind: string; title: string },
): number {
  const { threadOfRef, notes } = laneFor(db, found.id);

  if (o.json) {
    printJson({
      lane: 'notes',
      session: { id: found.id, kind: found.kind, title: found.title },
      thread: threadOfRef,
      current: notes[0] ? jsonNote(notes[0]) : null,
      notes: notes.map(jsonNote),
    });
    return 0;
  }

  print(listing(t, found, threadOfRef.sessions.length, notes));
  return 0;
}

function laneFor(
  db: ReturnType<typeof openIndex>['db'],
  sessionId: string,
): { threadOfRef: { id: string; sessions: string[]; head: string }; notes: NoteRow[] } {
  // `notesForSession` would do this in one call, but the thread itself is
  // wanted for the header, and deriving it twice would let the two disagree.
  const row = db
    .prepare('SELECT thread_id FROM session_threads WHERE session_id = ?')
    .get(sessionId) as { thread_id: string } | undefined;
  const threadId = row?.thread_id ?? sessionId;
  const sessions = row
    ? (
        db
          .prepare(
            'SELECT session_id FROM session_threads WHERE thread_id = ? ORDER BY depth, session_id',
          )
          .all(threadId) as { session_id: string }[]
      ).map((r) => r.session_id)
    : [sessionId];
  return {
    threadOfRef: { id: threadId, sessions, head: sessions[sessions.length - 1] ?? sessionId },
    notes: threadNotes(db, threadId),
  };
}

// ------------------------------------------------------------------ render

function heading(t: Theme, found: { id: string; title: string }, chain: number): string {
  const unit = chain > 1 ? `thread of ${chain} sessions` : 'thread of 1 session';
  return t.dim(
    fmt.clip(`potsherd note ${t.sep} ${idTag(found.id)} ${t.sep} ${unit}`, t.width, t) +
      '\n' +
      fmt.clip(`  ${found.title}`, t.width, t),
  );
}

/**
 * The line that says what this text is.
 *
 * A note is a claim by whoever typed it, sitting in a store whose other rows
 * are verbatim transcript. `plans/05` bans banners, so this is one dim line and
 * it is on every screen the verb prints — the human half of "a note can never
 * masquerade as something the transcript says".
 */
function provenance(t: Theme, n: NoteRow): string {
  const who = n.author === 'unknown' ? 'author not stated' : `by ${n.author}`;
  const left = `note ${n.id} ${t.sep} ${who} ${t.sep} via ${n.via}`;
  const right = fmt.date(n.writtenAt);
  const gap = Math.max(1, t.width - 2 - Theme.len(left) - Theme.len(right));
  return t.dim(`  ${left}${' '.repeat(gap)}${right}`);
}

function fields(t: Theme, n: NoteRow): string[] {
  const out: string[] = [];
  const body = Math.max(20, t.width - 2 - LABEL_W);
  for (const [label, text] of [
    ['decided', n.decided],
    ['open', n.open],
    ['next', n.next],
  ] as const) {
    if (!text) continue;
    const lines = fmt.wrap(text, body);
    lines.forEach((line, i) => {
      const head = i === 0 ? t.dim(label.padEnd(LABEL_W)) : ' '.repeat(LABEL_W);
      out.push(`  ${head}${line}`);
    });
  }
  return out;
}

function receipt(
  t: Theme,
  found: { id: string; title: string },
  n: NoteRow,
  chain: number,
  previous: number,
): string {
  const id8 = idTag(found.id);
  const lines = [heading(t, found, chain), '', provenance(t, n), '', ...fields(t, n), ''];

  // The two sentences that make this safe to type. Never "saved" alone: what a
  // writer wants to know is what did *not* change.
  lines.push(
    fitLine(
      t,
      t.ok('appended') + t.dim('  the transcript was not touched; notes are never rewritten'),
      t.ok('appended') + t.dim('  the transcript was not touched'),
    ),
  );
  if (previous > 0) {
    lines.push(
      fitLine(
        t,
        t.dim(
          `${fmt.num(previous)} earlier ${fmt.plural(previous, 'note')} on this thread ${fmt.plural(previous, 'is', 'are')} still there`,
        ),
        t.dim(`${fmt.num(previous)} earlier ${fmt.plural(previous, 'note')} kept`),
      ),
    );
  }

  lines.push('');
  lines.push(
    fitLine(
      t,
      `${t.dim('run')}  potsherd graft ${id8}  ${t.dim('to carry this thread into a new session')}`,
      `${t.dim('run')}  potsherd graft ${id8}  ${t.dim('to carry it forward')}`,
      `${t.dim('run')}  potsherd graft ${id8}`,
    ),
  );
  return lines.join('\n');
}

function listing(
  t: Theme,
  found: { id: string; title: string },
  chain: number,
  notes: NoteRow[],
): string {
  const id8 = idTag(found.id);
  const lines = [heading(t, found, chain), ''];

  if (notes.length === 0) {
    lines.push(`  ${t.dim('no notes on this thread yet.')}`);
    lines.push('');
    lines.push(
      fitLine(
        t,
        `${t.dim('run')}  potsherd note ${id8} --decided "..." --next "..."`,
        `${t.dim('run')}  potsherd note ${id8} --decided "..."`,
      ),
    );
    return lines.join('\n');
  }

  notes.forEach((n, i) => {
    if (i > 0) lines.push('');
    lines.push(provenance(t, n));
    lines.push(...fields(t, n));
  });

  lines.push('');
  lines.push(
    fitLine(
      t,
      t.dim(
        `${fmt.num(notes.length)} ${fmt.plural(notes.length, 'note')}, newest first ${t.sep} assertions by their authors, not transcript`,
      ),
      t.dim(`${fmt.num(notes.length)} ${fmt.plural(notes.length, 'note')} ${t.sep} assertions, not transcript`),
      t.dim(`${fmt.num(notes.length)} ${fmt.plural(notes.length, 'note')}`),
    ),
  );
  lines.push('');
  lines.push(
    fitLine(
      t,
      `${t.dim('run')}  potsherd graft ${id8}  ${t.dim('to carry this thread into a new session')}`,
      `${t.dim('run')}  potsherd graft ${id8}`,
    ),
  );
  return lines.join('\n');
}

/**
 * One note, for `--json`.
 *
 * `kind` and `citable` are on **every** note object rather than once at the top
 * of the payload, because a consumer that merges lanes keeps the objects and
 * throws the envelope away. `citable: false` is the machine-readable half of
 * the dim line the human view prints.
 */
function jsonNote(n: NoteRow): Record<string, unknown> {
  return {
    kind: 'note',
    citable: false,
    id: n.id,
    threadId: n.threadId,
    sessionId: n.sessionId,
    decided: n.decided,
    open: n.open,
    next: n.next,
    headline: noteHeadline(n),
    author: n.author,
    via: n.via,
    writtenAt: n.writtenAt,
  };
}

/** Exported for `ls`/`stats`, which want the count without the rendering. */
export { countThreadNotes };
