import {
  resolveThread,
  showSession,
  type ThreadResolution,
  type db as dbNs,
} from '@potsherd/core';

import { UserError } from '../../../cli/src/output.js';

type Db = dbNs.Db;

/**
 * T10.6 — the thread, resolved against the core that now models one.
 *
 * Audit F4 and plan §B5: *"Claude Code sessions form chains — fork, resume,
 * compact — and potsherd treats each link as an independent document with no
 * pointer to the others."* The consequence the auditor measured is the one
 * sentence the positioning document should lead with: the session they were
 * working in three days ago indexes as **4 exchanges**, and its other 1,660
 * records live under a different id with no link between them.
 *
 * ## What this file used to do, and why it was the worst defect of the phase
 *
 * T10.3 built the chain at index time and this module could not wait for it,
 * so it **probed**: it read `core.resolveThread` at runtime, and when the name
 * was absent it fell back to a thread of exactly the session it was handed,
 * labelled `via: "session-only"`, with a note explaining the gap *to the model*.
 *
 * The name was never written. The probe therefore never once succeeded, and
 * two separate alarms failed to ring: the fallback was silent by design, and
 * `threadsAvailable()` — the function whose whole job was to report the
 * capability missing — had no callers. So `potsherd_read`, one of the
 * archaeologist's two tools and the stated replacement for filesystem `Read`,
 * reported the audit's own F4 fixture as its head's handful of exchanges while
 * `potsherd_graft` on the same id in the same second reported the whole chain.
 *
 * The probe and the fallback are gone. {@link resolveThread} is a normal
 * import from the core barrel: if it ever disappears again the build fails,
 * loudly, instead of the model being told in prose that lineage is unmodelled.
 * `via` is retained on the reply and is now always `core` — it is what tells a
 * reader that the chain came from the index rather than from the caller's
 * reference, and `tests/threads.test.ts` pins it, so a reintroduced fallback
 * cannot pass the suite quietly.
 *
 * No lineage is re-derived here. A second uuid-overlap threshold living at the
 * MCP surface would be a second answer to "which sessions are the same work",
 * and `read` and `ls` disagreeing about that is exactly the class of defect F4
 * is.
 */

/** The field a `recall` row is read for its thread id. See {@link threadIdOf}. */
export const THREAD_ID_FIELD = 'threadId';

/** The thread id a core row carries, or null when the row carries none. */
export function threadIdOf(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const v = (row as Record<string, unknown>)[THREAD_ID_FIELD];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface ThreadLink {
  sessionId: string;
  id8: string;
  kind: 'session' | 'ghost';
  /** Exchanges (or recovered prompts) this link holds. */
  total: number;
  /** Where this link starts in the thread's own 1-based numbering. */
  offset: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ResolvedThread {
  /** The root of the chain, whichever member the caller named. */
  threadId: string;
  links: ThreadLink[];
  /** Exchanges across every link. */
  total: number;
  /**
   * How the chain was established. `core` — the only value — means the index's
   * derived lineage, never the caller's reference standing in for a chain.
   */
  via: 'core';
  /** Reserved for a caveat this path no longer has. Always null. */
  note: string | null;
}

/**
 * The thread a reference names, with every link measured.
 *
 * Resolution is the same `resolveSession` `show`, `graft` and `tag` use, so
 * `potsherd_read <id8>` and `potsherd_graft <id8>` cannot mean two
 * different things. What is added on top is the chain and the arithmetic that
 * makes it one addressable run of exchanges.
 */
export function resolveThreadRef(db: Db, ref: string, verb = 'read'): ResolvedThread {
  const needle = ref?.trim() ?? '';
  if (!needle) {
    throw new UserError(
      `${verb} needs a thread — the first eight characters of any session id in it`,
      'potsherd_recall {"query":"<what you are looking for>"}    # every row carries one',
    );
  }

  const thread: ThreadResolution | null = resolveThread(db, needle);
  if (!thread) {
    throw new UserError(
      `no thread in the index starts with "${needle}"`,
      'potsherd_recall {"query":"<what you are looking for>"}    # the ids come from there',
    );
  }
  if (thread.ambiguous) {
    throw new UserError(
      `"${needle}" matches ${thread.ambiguous.length} threads: ${thread.ambiguous
        .slice(0, 5)
        .map((c) => c.id)
        .join(', ')}`,
      `potsherd_read {"thread":"${thread.ambiguous[0]!.id}"}`,
    );
  }
  const ids = thread.sessionIds;
  const threadId = thread.threadId;

  const links: ThreadLink[] = [];
  let offset = 1;
  for (const id of ids) {
    const probe = showSession(db, id, { from: 1, to: 1 });
    if (!probe) continue;
    const total = probe.total;
    links.push({
      sessionId: id,
      id8: id.slice(0, 8),
      kind: probe.session.kind,
      total,
      offset,
      startedAt: probe.session.startedAt,
      endedAt: probe.session.endedAt,
    });
    offset += total;
  }

  if (links.length === 0) {
    throw new UserError(
      `thread ${threadId.slice(0, 8)} is in the index but has no body`,
      'potsherd index --full',
    );
  }

  return {
    threadId,
    links,
    total: links.reduce((n, l) => n + l.total, 0),
    // Always `core`: the chain is read from `session_threads`, derived at index
    // time from the harness's own record identity. There is no other path to
    // this value any more, and a test fails if one reappears.
    via: 'core',
    note: null,
  };
}
