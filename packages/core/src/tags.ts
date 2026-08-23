import type { Db } from './db.js';
import { iso } from './format.js';

/**
 * Tags, pins and links — the three things the *user* says about a session,
 * as opposed to everything else in the index, which the machine said.
 *
 * `03 §8` calls them "plain writes", and they are: three tables that existed
 * in migration 1 and were empty until now. What is not plain is the shape of
 * the reads, and two decisions here are worth more than the SQL:
 *
 * **A tag is normalised on the way in, never on the way out.** `--tag
 * Postgres`, `+POSTGRES` and `+postgres ` have to be one tag or the filter is
 * a lottery; the same {@link normalizeTag} runs on the write side and on the
 * `--tag` flag, so they cannot disagree. Normalising on the *read* side
 * instead would mean the stored rows were whatever anyone typed, and
 * `SELECT DISTINCT tag` would be a mess nobody could tidy.
 *
 * **A link is undirected in meaning and directed in storage.** The row records
 * who typed it: `link A B` is `(A, B)`, because "I linked this to that" is a
 * fact about what the user did. But every read has to see it from both ends —
 * `ls --linked-to B` must find A — and forgetting one side is the bug this
 * kind of table always ships with. So there is exactly one place that knows
 * the OR: {@link LINKED_TO_SQL}, used by the filter builder and by
 * {@link sessionLinks} alike, and a test asserts both directions.
 *
 * Nothing here touches `sessions` or `ghosts`. A ghost has no row in
 * `sessions`, so none of these tables can carry a foreign key to it and still
 * hold a pin on a deleted session — which is the pin most worth having. The
 * caller checks that the id exists (`resolveSession`) before writing.
 */

/** Longest tag we store. Long enough for `infra/postgres-connection-pool`. */
export const MAX_TAG_LENGTH = 32;

export interface TagChange {
  sessionId: string;
  /** The session's tags after the change, sorted. */
  tags: string[];
  added: string[];
  removed: string[];
  /** Asked for and already true — reported, not silently swallowed. */
  unchanged: string[];
}

export interface PinChange {
  sessionId: string;
  pinned: boolean;
  pinnedAt: string | null;
  /** False when the session was already in that state. */
  changed: boolean;
}

export interface SessionLink {
  /** The session on the other end of the link. */
  sessionId: string;
  note: string | null;
  createdAt: string | null;
  /**
   * `out` when this session is the `a` side (the user typed it first), `in`
   * when it is the `b` side. Meaning is identical; provenance is not.
   */
  direction: 'out' | 'in';
}

export interface LinkChange {
  a: string;
  b: string;
  note: string | null;
  createdAt: string | null;
  /** False when the pair was already linked (the note is then updated). */
  created: boolean;
  /** True when the pair was already linked the other way round. */
  reversed: boolean;
}

/**
 * `+Postgres` -> `postgres`. Returns null when nothing usable is left, which
 * is the caller's cue to raise a real error rather than store an empty tag.
 *
 * The character class is deliberately small — letters, digits, `-`, `.`, `_`
 * and `/` — because a tag ends up in `ls` output, in a `--tag` flag and in a
 * card's yaml frontmatter, and a tag with a space or a quote in it breaks one
 * of the three. Spaces and underscores become hyphens rather than being
 * dropped, so `+"open threads"` is `open-threads` and not `openthreads`.
 */
export function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim().replace(/^[+-]+/, '');
  const cleaned = trimmed
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9./-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_TAG_LENGTH).replace(/[-./]+$/, '') || null;
}

/**
 * Split `+postgres -infra rls` into what to add and what to remove.
 *
 * A bare word means add: `potsherd tag 9c4d2f18 postgres` is what people type
 * the first time, and refusing it to insist on a `+` would be pedantry. Only
 * a leading `-` removes.
 *
 * Invalid entries come back in `rejected` with the text as typed, so the CLI
 * can say which word it could not use instead of quietly tagging four of five.
 */
export function parseTagArgs(args: readonly string[]): {
  add: string[];
  remove: string[];
  rejected: string[];
} {
  const add: string[] = [];
  const remove: string[] = [];
  const rejected: string[] = [];
  for (const raw of args) {
    const arg = raw.trim();
    if (!arg) continue;
    const tag = normalizeTag(arg);
    if (!tag) {
      rejected.push(arg);
      continue;
    }
    if (arg.startsWith('-')) remove.push(tag);
    else add.push(tag);
  }
  return { add: unique(add), remove: unique(remove), rejected };
}

// --------------------------------------------------------------------- tags

export function sessionTags(db: Db, sessionId: string): string[] {
  return (
    db
      .prepare('SELECT tag FROM tags WHERE session_id = ? ORDER BY tag')
      .all(sessionId) as { tag: string }[]
  ).map((r) => r.tag);
}

/**
 * Tags for a page of sessions, in one query rather than one per row.
 *
 * `ls` renders tags after every title, so the per-row version would be
 * fifteen statements for a screen that already ran three.
 */
export function tagsForSessions(db: Db, ids: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT session_id, tag FROM tags WHERE session_id IN (${ids.map(() => '?').join(',')})
        ORDER BY session_id, tag`,
    )
    .all(...ids) as { session_id: string; tag: string }[];
  for (const r of rows) {
    const list = out.get(r.session_id);
    if (list) list.push(r.tag);
    else out.set(r.session_id, [r.tag]);
  }
  return out;
}

/** Every tag in the index with the number of sessions carrying it. */
export function allTags(db: Db): { tag: string; sessions: number }[] {
  return db
    .prepare(
      `SELECT tag, COUNT(*) AS sessions FROM tags GROUP BY tag
        ORDER BY sessions DESC, tag`,
    )
    .all() as { tag: string; sessions: number }[];
}

/**
 * Add and remove in one statement pair, inside one transaction.
 *
 * `potsherd tag <id> +postgres -mysql` is one edit from the user's side, and a
 * crash between the two writes would leave a session tagged neither way round.
 */
export function applyTags(
  db: Db,
  sessionId: string,
  change: { add?: readonly string[]; remove?: readonly string[] },
): TagChange {
  const add = unique((change.add ?? []).map(String));
  const remove = new Set(unique((change.remove ?? []).map(String)));
  const before = new Set(sessionTags(db, sessionId));

  const added = add.filter((t) => !before.has(t) && !remove.has(t));
  const removed = [...remove].filter((t) => before.has(t));
  const unchanged = [
    ...add.filter((t) => before.has(t)),
    ...[...remove].filter((t) => !before.has(t)).map((t) => `-${t}`),
  ];

  if (added.length || removed.length) {
    const insert = db.prepare('INSERT OR IGNORE INTO tags (session_id, tag) VALUES (?, ?)');
    const del = db.prepare('DELETE FROM tags WHERE session_id = ? AND tag = ?');
    db.transaction(() => {
      for (const t of added) insert.run(sessionId, t);
      for (const t of removed) del.run(sessionId, t);
    })();
  }

  return { sessionId, tags: sessionTags(db, sessionId), added, removed, unchanged };
}

// --------------------------------------------------------------------- pins

export function isPinned(db: Db, sessionId: string): { pinned: boolean; pinnedAt: string | null } {
  const row = db.prepare('SELECT pinned_at FROM pins WHERE session_id = ?').get(sessionId) as
    | { pinned_at: string | null }
    | undefined;
  return { pinned: Boolean(row), pinnedAt: row?.pinned_at ?? null };
}

export function pinSession(db: Db, sessionId: string, at = iso()): PinChange {
  const existing = isPinned(db, sessionId);
  if (existing.pinned) {
    return { sessionId, pinned: true, pinnedAt: existing.pinnedAt, changed: false };
  }
  db.prepare('INSERT OR REPLACE INTO pins (session_id, pinned_at) VALUES (?, ?)').run(
    sessionId,
    at,
  );
  return { sessionId, pinned: true, pinnedAt: at, changed: true };
}

export function unpinSession(db: Db, sessionId: string): PinChange {
  const existing = isPinned(db, sessionId);
  if (!existing.pinned) return { sessionId, pinned: false, pinnedAt: null, changed: false };
  db.prepare('DELETE FROM pins WHERE session_id = ?').run(sessionId);
  return { sessionId, pinned: false, pinnedAt: existing.pinnedAt, changed: true };
}

export function pinnedSessionIds(db: Db): string[] {
  return (
    db.prepare('SELECT session_id FROM pins ORDER BY pinned_at DESC').all() as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

// -------------------------------------------------------------------- links

/**
 * The one place that knows a link reads from both ends.
 *
 * Takes the id twice, because sqlite positional parameters cannot be reused
 * and a named parameter here would have to be threaded through
 * `buildSessionFilters`, which speaks positional. Two `?` and a comment beat a
 * second convention.
 */
export const LINKED_TO_SQL = (column: string): string =>
  `EXISTS (SELECT 1 FROM links l
             WHERE (l.a_session_id = ${column} AND l.b_session_id = ?)
                OR (l.b_session_id = ${column} AND l.a_session_id = ?))`;

/**
 * Record that two sessions belong together.
 *
 * Linking a pair that is already linked the other way round **updates that
 * row** rather than writing a mirror. `(A,B)` and `(B,A)` both satisfy the
 * primary key, so without this check `link A B` followed by `link B A` leaves
 * two rows saying one thing, and `potsherd show A` lists its neighbour twice.
 */
export function linkSessions(
  db: Db,
  a: string,
  b: string,
  note?: string | null,
  at = iso(),
): LinkChange {
  const existing = db
    .prepare(
      `SELECT a_session_id, b_session_id, note, created_at FROM links
        WHERE (a_session_id = ? AND b_session_id = ?) OR (a_session_id = ? AND b_session_id = ?)`,
    )
    .get(a, b, b, a) as
    | { a_session_id: string; b_session_id: string; note: string | null; created_at: string | null }
    | undefined;

  if (existing) {
    const kept = note ?? existing.note;
    if (kept !== existing.note) {
      db.prepare('UPDATE links SET note = ? WHERE a_session_id = ? AND b_session_id = ?').run(
        kept,
        existing.a_session_id,
        existing.b_session_id,
      );
    }
    return {
      a: existing.a_session_id,
      b: existing.b_session_id,
      note: kept,
      createdAt: existing.created_at,
      created: false,
      reversed: existing.a_session_id !== a,
    };
  }

  db.prepare(
    'INSERT INTO links (a_session_id, b_session_id, note, created_at) VALUES (?, ?, ?, ?)',
  ).run(a, b, note ?? null, at);
  return { a, b, note: note ?? null, createdAt: at, created: true, reversed: false };
}

export function unlinkSessions(db: Db, a: string, b: string): boolean {
  const info = db
    .prepare(
      `DELETE FROM links
        WHERE (a_session_id = ? AND b_session_id = ?) OR (a_session_id = ? AND b_session_id = ?)`,
    )
    .run(a, b, b, a);
  return info.changes > 0;
}

/** Everything linked to this session, from whichever side it was recorded on. */
export function sessionLinks(db: Db, sessionId: string): SessionLink[] {
  const rows = db
    .prepare(
      `SELECT b_session_id AS other, note, created_at, 'out' AS direction FROM links
         WHERE a_session_id = ?
       UNION ALL
       SELECT a_session_id AS other, note, created_at, 'in' AS direction FROM links
         WHERE b_session_id = ?
       ORDER BY created_at DESC, other`,
    )
    .all(sessionId, sessionId) as {
    other: string;
    note: string | null;
    created_at: string | null;
    direction: 'out' | 'in';
  }[];
  return rows.map((r) => ({
    sessionId: r.other,
    note: r.note,
    createdAt: r.created_at,
    direction: r.direction,
  }));
}

/** Just the ids, for `ls --linked-to` to report what it is showing. */
export function linkedSessionIds(db: Db, sessionId: string): string[] {
  return sessionLinks(db, sessionId).map((l) => l.sessionId);
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}
