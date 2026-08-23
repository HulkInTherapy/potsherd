import * as core from '@potsherd/core';
import { resolveSession, showSession, type db as dbNs } from '@potsherd/core';

import { UserError } from '../../../cli/src/output.js';

type Db = dbNs.Db;

/**
 * T10.6 — the thread, resolved, against a core that is still growing one.
 *
 * Audit F4 and plan §B5: *"Claude Code sessions form chains — fork, resume,
 * compact — and potsherd treats each link as an independent document with no
 * pointer to the others."* The consequence the auditor measured is the one
 * sentence the positioning document should lead with: the session they were
 * working in three days ago indexes as **4 exchanges**, and its other 1,660
 * records live under a different id with no link between them.
 *
 * T10.3 is building that chain at index time. This package cannot wait for it
 * and must not re-derive it — a second uuid-overlap threshold living at the MCP
 * surface would be a second answer to "which sessions are the same work", and
 * `read` and `ls` disagreeing about that is exactly the class of defect F4 is.
 *
 * So: **probe once, fall back honestly.** {@link CORE_THREAD_RESOLVER} names
 * the single core export this module wants. When it is there, it decides.
 * When it is not, a thread is the one session named, `via` says
 * `session-only`, and `note` says so in words that reach the model — because a
 * tool that silently returns one link of a chain and calls it a thread is the
 * v1.1.0 behaviour with a new label on it.
 */

/**
 * The core export this module looks for.
 *
 * The signature it is called with, verbatim, is in `T10.6-REPORT.md` under
 * "core signatures I owe you". Changing this constant is the whole integration.
 */
export const CORE_THREAD_RESOLVER = 'resolveThread';

/** The field a `recall` row is read for its thread id. See {@link threadIdOf}. */
export const THREAD_ID_FIELD = 'threadId';

export interface CoreThread {
  threadId: string;
  /** Chain order, oldest link first. */
  sessionIds: string[];
  startedAt?: string | null;
  endedAt?: string | null;
  exchanges?: number;
}

type CoreThreadResolver = (db: Db, ref: string) => CoreThread | null;

function coreResolver(): CoreThreadResolver | null {
  const fn = (core as unknown as Record<string, unknown>)[CORE_THREAD_RESOLVER];
  return typeof fn === 'function' ? (fn as CoreThreadResolver) : null;
}

/** True when this build of core models threads at all. One place asks. */
export function threadsAvailable(): boolean {
  return coreResolver() !== null;
}

/** The thread id a core row carries, or null when this build carries none. */
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
  /** The id the thread is addressed by. The link the caller named, when core has no chain. */
  threadId: string;
  links: ThreadLink[];
  /** Exchanges across every link. */
  total: number;
  /** `core` when core resolved the chain; `session-only` when it could not. */
  via: 'core' | 'session-only';
  /** One line, printable, when `via` is not `core`. */
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

  const fn = coreResolver();
  let ids: string[] | null = null;
  let threadId = '';
  let via: ResolvedThread['via'] = 'session-only';

  if (fn) {
    const t = fn(db, needle);
    if (t && t.sessionIds.length > 0) {
      ids = t.sessionIds;
      threadId = t.threadId;
      via = 'core';
    }
  }

  if (!ids) {
    const found = resolveSession(db, needle);
    if (!found) {
      throw new UserError(
        `no thread in the index starts with "${needle}"`,
        'potsherd_recall {"query":"<what you are looking for>"}    # the ids come from there',
      );
    }
    if (found.ambiguous) {
      throw new UserError(
        `"${needle}" matches ${found.ambiguous.length} threads: ${found.ambiguous
          .slice(0, 5)
          .map((c) => c.id)
          .join(', ')}`,
        `potsherd_read {"thread":"${found.ambiguous[0]!.id}"}`,
      );
    }
    ids = [found.id];
    threadId = found.id;
  }

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
    via,
    note:
      via === 'core'
        ? null
        : 'this build of potsherd does not model fork/resume chains yet, so this thread is the ' +
          'one session you named. If the work continued under another id, it is not in this reply.',
  };
}
