import { resolveSession, type SessionCandidate } from './browse.js';
import type { Db } from './db.js';

/**
 * L1½ — the fork/resume chain, and the one place a session's date is decided.
 *
 * ## Why this file exists
 *
 * A Claude Code session is not a document. `claude --resume <id>` writes a
 * **new** transcript whose head is a byte-for-byte copy of the old one, and
 * the work continues in the new file. potsherd indexed each file as an
 * independent session with no pointer to the other, and the agent audit
 * (`docs/AGENT-AUDIT-2026-08-23.md`, F4) caught both halves of what that costs:
 *
 *   - `graft` on the session someone worked in yesterday returned **4
 *     exchanges**, because the other 119 are filed under the id the fork
 *     copied them from.
 *   - `show` printed a header dating the session **eight days before the first
 *     exchange it then printed on the same screen** — the fork point, inherited
 *     from records the session did not write.
 *
 * The dedup is not the bug and is not touched here: the shared records belong
 * to the session that had them first, and they stay there. What was missing is
 * the **pointer** between the two files, and a rule that dates a session by
 * what it actually holds.
 *
 * ## The two questions, and the two answers
 *
 * **Which sessions are one thread?** {@link deriveThreads}, from evidence the
 * index already stores: the harness's own record ids (`session_record_ids`) and
 * the parent it declares on its records (`session_declared_parents`), both
 * written by `ingest.ts` at index time. No flag, no `link`, no model.
 *
 * **When did a session happen?** {@link sessionDate} and
 * {@link contentStartedAt}. `graft.ts` was already right about this and every
 * other verb was wrong, so the rule was promoted out of `graft` to here and
 * deleted there: *a session's date is the end of the work it did itself.*
 *
 * ## What this file does not claim
 *
 * Only Claude Code writes record identity into its transcripts on this
 * machine, so only Claude Code sessions can be chained (see
 * {@link LINEAGE_HARNESSES}). Codex, Cursor, pi, gemini, opencode and copilot
 * get no chains — not an empty result dressed up as a measurement, and not an
 * invented one. `threadReport()` says so per harness.
 */

// ------------------------------------------------------------- the rule

/**
 * How much of the smaller session has to sit inside the larger one before the
 * two are one thread. **A stopping rule, not an argmax.**
 *
 * The measure is *containment* — `shared / min(|a|, |b|)` — because a resume
 * copies the parent's history **whole**, so the parent's record set ends up a
 * near-subset of the child's. Jaccard would punish exactly the case this
 * exists to catch: a child that went on to do 1,660 records of new work scores
 * worse the more work it did.
 *
 * On the reference archive (35 top-level Claude transcripts with more than 20
 * records, 433 MB) the distribution is bimodal and **there is nothing in
 * between**:
 *
 * | pair | containment | shared |
 * |---|---:|---:|
 * | chain 1 | 0.988 | 1,660 |
 * | chain 2 | 0.960 | 194 |
 * | every other one of the 595 pairs | **0.000** | 0 |
 *
 * So the honest thing to say is not "0.75 is optimal" — every value in
 * (0, 0.96] gives the same two chains on this corpus, and an argmax over a gap
 * that wide is a number invented to look measured. 0.75 is where we **stop
 * looking**: three quarters of one file being a copy of another is the point at
 * which "one of these is a fork of the other" stops being arguable, and it is
 * far from both walls of the only gap there is.
 *
 * `tests/threads.test.ts` pins it from both sides: a fixture pair at 0.80
 * chains and a fixture pair at 0.70 does not, so moving this constant in
 * either direction fails the suite.
 */
export const OVERLAP_THRESHOLD = 0.75;

/**
 * Records two sessions must share before containment is allowed to speak.
 *
 * Two four-record sessions sharing all four is containment 1.0 and no evidence
 * of anything: harnesses reuse ids, fixtures repeat, and a ratio over a tiny
 * denominator is noise with a decimal point on it. Ten is small enough that
 * the reference archive's smaller chain (194 shared) clears it by a factor of
 * nineteen, and large enough that no accident does.
 */
export const MIN_SHARED_RECORDS = 10;

/**
 * Harnesses whose transcripts carry a per-record identity potsherd can read.
 *
 * Claude Code writes `uuid` on every conversational record and rewrites
 * `sessionId` (but *not* the record's original `session_id`) when it copies a
 * history forward. Both were verified by reading the raw JSONL of the
 * reference archive, not from any format document.
 *
 * The other six adapters are absent from this list because no record-identity
 * field has been **verified** in their formats on a real transcript — not
 * because they are known to lack one. A chain nobody measured is a chain
 * nobody should print.
 */
export const LINEAGE_HARNESSES: readonly string[] = ['claude'];

// ------------------------------------------------------------ the dating

/**
 * A session's date — **the promoted function**.
 *
 * This computation lived inline in `graft.ts` (`s.endedAt ?? s.startedAt`) and
 * was the only correct one in the codebase: on the audit's fixture `graft`
 * printed `2026-08-20` while `show`, `ls` and `find` printed `12 aug`. It is
 * here now, and the copy in `graft.ts` is gone.
 *
 * It prefers the **end** of the session for the same reason the bug existed:
 * the head of a forked transcript is inherited and the tail never is. The
 * matching half of the fix is {@link contentStartedAt}, which stops the start
 * being inherited in the first place, so that the two ends of a session's range
 * are now both its own and every verb can read either.
 */
export function sessionDate(s: {
  startedAt?: string | null;
  endedAt?: string | null;
}): string | null {
  return s.endedAt ?? s.startedAt ?? null;
}

/** {@link sessionDate} as the `YYYY-MM-DD` a brief's `source:` line carries. */
export function sessionDay(
  s: { startedAt?: string | null; endedAt?: string | null },
  fallback = 'unknown date',
): string {
  const when = sessionDate(s);
  return when ? when.slice(0, 10) : fallback;
}

/**
 * When this session's **own** work starts, from the exchanges it holds.
 *
 * `sessions.started_at` used to be the timestamp of the first *record in the
 * file*, and on a forked transcript that record was written by a different
 * session, eight days earlier. `show` printed it as the session's date and
 * then printed the session's first exchange four lines below, contradicting
 * itself on one screen.
 *
 * The first exchange potsherd attributes to a session is, by construction,
 * the first work the session did — the shared prefix is attributed to whoever
 * had it first. So the header date and the first exchange's date are now the
 * same number because they are computed from the same rows, rather than
 * because two derivations happened to agree.
 *
 * Null when the session holds no timestamped exchange (a transcript that is
 * all tool traffic, an empty sidechain); the caller keeps whatever it had.
 */
export function contentStartedAt(db: Db, sessionId: string): string | null {
  const row = db
    .prepare(
      `SELECT MIN(ts) AS t FROM exchanges
        WHERE session_id = ? AND ts IS NOT NULL AND TRIM(ts) <> ''`,
    )
    .get(sessionId) as { t: string | null } | undefined;
  return row?.t ?? null;
}

/**
 * Re-date one session from its own content.
 *
 * Called by `ingest.ts` inside the same transaction that wrote the exchanges,
 * so no reader ever observes a session whose header disagrees with its body.
 * Returns true when the stored value changed.
 */
export function redateFromContent(db: Db, sessionId: string): boolean {
  const start = contentStartedAt(db, sessionId);
  if (!start) return false;
  const info = db
    .prepare('UPDATE sessions SET started_at = ? WHERE id = ? AND started_at IS NOT ?')
    .run(start, sessionId, start);
  return (info.changes ?? 0) > 0;
}

// ------------------------------------------------------------ the chains

export interface ThreadEdge {
  child: string;
  parent: string;
  /** Which signal named the parent: the harness's own pointer, or overlap. */
  via: 'declared' | 'overlap';
  shared: number;
  /** `shared / min(|child|, |parent|)` — see {@link OVERLAP_THRESHOLD}. */
  overlap: number;
}

export interface Thread {
  /** The root of the chain: the session nothing was forked from. */
  id: string;
  /** Root first, head last. One entry for a session that is its own thread. */
  sessions: string[];
  /** The newest link — the transcript `--resume` would continue. */
  head: string;
}

export interface ThreadRow {
  sessionId: string;
  threadId: string;
  parentId: string | null;
  head: boolean;
  depth: number;
  via: 'declared' | 'overlap' | null;
  shared: number;
  overlap: number;
}

/** A declared parent the evidence refused to corroborate — reported, not used. */
export interface RefusedParent {
  child: string;
  declared: string;
  records: number;
  shared: number;
  why: 'no-shared-records' | 'below-threshold' | 'parent-not-indexed';
}

export interface ThreadReport {
  threads: Thread[];
  edges: ThreadEdge[];
  refused: RefusedParent[];
  /** Harnesses with sessions in the index but no record identity to read. */
  withoutLineage: string[];
  /** Sessions whose record ids the index holds, i.e. the candidate pool. */
  candidates: number;
}

interface Sizes {
  size: Map<string, number>;
  ended: Map<string, string>;
}

function sessionSizes(db: Db): Sizes {
  const size = new Map<string, number>();
  for (const r of db
    .prepare('SELECT session_id AS id, COUNT(*) AS n FROM session_record_ids GROUP BY session_id')
    .all() as { id: string; n: number }[]) {
    size.set(r.id, r.n);
  }
  const ended = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT id, COALESCE(ended_at, started_at, '') AS w FROM sessions
        WHERE id IN (SELECT session_id FROM session_record_ids)`,
    )
    .all() as { id: string; w: string }[]) {
    ended.set(r.id, r.w);
  }
  return { size, ended };
}

/**
 * Every pair of sessions that shares at least one record, with the count.
 *
 * One `GROUP BY` over the records that appear more than once, rather than
 * `n²` set intersections: on the reference archive 70,000 stored record ids
 * produce 1,854 shared ones and four ordered pairs, and the whole pass is a
 * single scan of an index.
 */
function sharedCounts(db: Db): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT record_id, session_id FROM session_record_ids
        WHERE record_id IN (
          SELECT record_id FROM session_record_ids GROUP BY record_id HAVING COUNT(*) > 1)
        ORDER BY record_id`,
    )
    .all() as { record_id: string; session_id: string }[];

  const pairs = new Map<string, number>();
  let at = 0;
  while (at < rows.length) {
    let end = at;
    while (end < rows.length && rows[end]!.record_id === rows[at]!.record_id) end += 1;
    const group = rows.slice(at, end).map((r) => r.session_id);
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
    at = end;
  }
  return pairs;
}

/**
 * Which of two sessions inherited from the other.
 *
 * The child is the one whose own work is **later**: a resume copies the
 * history and then adds to it, so the copy's tail always postdates the
 * original's. Verified on both chains of the reference archive — the derived
 * session's unshared records begin after the last shared one, in both cases.
 *
 * Ties (identical last-activity, which only fixtures produce) fall to the
 * larger record set and then to the id, so a re-index never reverses a chain.
 */
function orient(a: string, b: string, sizes: Sizes): { child: string; parent: string } {
  const wa = sizes.ended.get(a) ?? '';
  const wb = sizes.ended.get(b) ?? '';
  if (wa !== wb) return wa > wb ? { child: a, parent: b } : { child: b, parent: a };
  const sa = sizes.size.get(a) ?? 0;
  const sb = sizes.size.get(b) ?? 0;
  if (sa !== sb) return sa > sb ? { child: a, parent: b } : { child: b, parent: a };
  return a > b ? { child: a, parent: b } : { child: b, parent: a };
}

/**
 * Derive every fork/resume chain in the index, and write them down.
 *
 * Runs once at the end of `index`, over **stored** evidence only — never over
 * whatever this run happened to re-read. That is what makes a cold re-index and
 * an incremental one produce the same chains: an incremental pass that opens
 * one transcript still re-derives from all 328 sessions' record ids, because
 * the ids of the 327 it skipped are still in the table.
 *
 * ## Declared beats inferred, but corroborated beats declared
 *
 * Claude Code's own pointer is preferred where it exists, per the phase ruling.
 * It is **not** trusted alone, and the reference archive says why: twelve
 * sessions there declare a foreign `session_id`, and eight of them share
 * **zero** records with the session they name — one declares 2,097 records
 * inherited from a transcript that contains 98. That field is sticky across a
 * `/clear`, so on its own it merges conversations that have nothing in common.
 * A declared parent is therefore used when the records back it up, recorded in
 * {@link ThreadReport.refused} when they do not, and overlap alone is the
 * fallback for a fork the harness never pointed at.
 */
export function deriveThreads(db: Db): ThreadReport {
  const sizes = sessionSizes(db);
  const shared = sharedCounts(db);

  const declared = new Map<string, { parent: string; records: number }[]>();
  for (const r of db
    .prepare('SELECT session_id, parent_id, records FROM session_declared_parents')
    .all() as { session_id: string; parent_id: string; records: number }[]) {
    const list = declared.get(r.session_id) ?? [];
    list.push({ parent: r.parent_id, records: r.records });
    declared.set(r.session_id, list);
  }

  // Candidate edges, keyed by child. A session can only have inherited from
  // one predecessor, so the strongest candidate wins.
  const best = new Map<string, ThreadEdge>();
  const refused: RefusedParent[] = [];
  const consider = (edge: ThreadEdge): void => {
    const held = best.get(edge.child);
    if (
      !held ||
      (edge.via === 'declared' && held.via === 'overlap') ||
      (edge.via === held.via && edge.overlap > held.overlap)
    ) {
      best.set(edge.child, edge);
    }
  };

  for (const [key, count] of shared) {
    const [a, b] = key.split('\u0000') as [string, string];
    const smaller = Math.min(sizes.size.get(a) ?? 0, sizes.size.get(b) ?? 0);
    if (smaller === 0) continue;
    const overlap = count / smaller;
    if (count < MIN_SHARED_RECORDS || overlap < OVERLAP_THRESHOLD) continue;
    const { child, parent } = orient(a, b, sizes);
    // The harness's own pointer outranks the timestamps when both are present
    // and they disagree about which way the copy went.
    const declaresChild = (declared.get(child) ?? []).some((d) => d.parent === parent);
    const declaresParent = (declared.get(parent) ?? []).some((d) => d.parent === child);
    const via: ThreadEdge['via'] = declaresChild || declaresParent ? 'declared' : 'overlap';
    const flip = declaresParent && !declaresChild;
    consider({
      child: flip ? parent : child,
      parent: flip ? child : parent,
      via,
      shared: count,
      overlap,
    });
  }

  for (const [child, list] of declared) {
    for (const d of list) {
      const key = child < d.parent ? `${child}\u0000${d.parent}` : `${d.parent}\u0000${child}`;
      const count = shared.get(key) ?? 0;
      const edge = best.get(child);
      if (edge && edge.parent === d.parent) continue;
      if (!sizes.size.has(d.parent)) {
        refused.push({ child, declared: d.parent, records: d.records, shared: 0, why: 'parent-not-indexed' });
      } else if (count === 0) {
        refused.push({ child, declared: d.parent, records: d.records, shared: 0, why: 'no-shared-records' });
      } else {
        refused.push({ child, declared: d.parent, records: d.records, shared: count, why: 'below-threshold' });
      }
    }
  }

  const parentOf = new Map<string, ThreadEdge>();
  for (const [child, edge] of best) parentOf.set(child, edge);

  // Walk to the root, refusing to loop. A cycle cannot arise from the
  // orientation rule (it is a strict order), but a hand-edited database can
  // hold one and an index run must not hang on it.
  const rootOf = (id: string): { root: string; depth: number } => {
    const seen = new Set<string>([id]);
    let at = id;
    let depth = 0;
    for (;;) {
      const edge = parentOf.get(at);
      if (!edge || seen.has(edge.parent)) return { root: at, depth };
      seen.add(edge.parent);
      at = edge.parent;
      depth += 1;
    }
  };

  const members = new Map<string, string[]>();
  const rows: ThreadRow[] = [];
  const all = new Set<string>([...parentOf.keys(), ...[...parentOf.values()].map((e) => e.parent)]);
  for (const id of all) {
    const { root, depth } = rootOf(id);
    const edge = parentOf.get(id) ?? null;
    rows.push({
      sessionId: id,
      threadId: root,
      parentId: edge?.parent ?? null,
      head: false, // decided once the whole chain is known, below
      depth,
      via: edge?.via ?? null,
      shared: edge?.shared ?? 0,
      overlap: edge?.overlap ?? 0,
    });
    const list = members.get(root) ?? [];
    list.push(id);
    members.set(root, list);
  }

  // The head is the deepest link; a tie (a session forked twice) falls to the
  // latest last-activity, then the id, so the choice is stable across runs.
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  const threads: Thread[] = [];
  for (const [root, ids] of members) {
    const ordered = [...ids].sort(
      (x, y) =>
        (byId.get(x)!.depth - byId.get(y)!.depth) ||
        (sizes.ended.get(x) ?? '').localeCompare(sizes.ended.get(y) ?? '') ||
        x.localeCompare(y),
    );
    const head = ordered[ordered.length - 1]!;
    byId.get(head)!.head = true;
    threads.push({ id: root, sessions: ordered, head });
  }
  threads.sort((a, b) => a.id.localeCompare(b.id));

  const write = db.transaction(() => {
    db.prepare('DELETE FROM session_threads').run();
    const ins = db.prepare(
      `INSERT INTO session_threads
         (session_id, thread_id, parent_id, head, depth, via, shared, overlap)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(r.sessionId, r.threadId, r.parentId, r.head ? 1 : 0, r.depth, r.via, r.shared, r.overlap);
    }
  });
  write();

  const withoutLineage = (
    db
      .prepare(
        `SELECT DISTINCT harness FROM sessions
          WHERE id NOT IN (SELECT session_id FROM session_record_ids) ORDER BY harness`,
      )
      .all() as { harness: string }[]
  )
    .map((r) => r.harness)
    .filter((h) => !LINEAGE_HARNESSES.includes(h));

  refused.sort((a, b) => b.records - a.records || a.child.localeCompare(b.child));
  return {
    threads,
    edges: [...parentOf.values()].sort((a, b) => a.child.localeCompare(b.child)),
    refused,
    withoutLineage,
    candidates: sizes.size.size,
  };
}

// ------------------------------------------------------------- the query

/**
 * The thread one session belongs to, root first.
 *
 * A session with no derived chain is its own thread of one, so every caller
 * can treat "the thread" as the unit without asking whether there is one.
 */
export function threadOf(db: Db, sessionId: string): Thread {
  const row = db
    .prepare('SELECT thread_id FROM session_threads WHERE session_id = ?')
    .get(sessionId) as { thread_id: string } | undefined;
  if (!row) return { id: sessionId, sessions: [sessionId], head: sessionId };
  const rows = db
    .prepare(
      `SELECT session_id, depth, head FROM session_threads
        WHERE thread_id = ? ORDER BY depth, session_id`,
    )
    .all(row.thread_id) as { session_id: string; depth: number; head: number }[];
  const sessions = rows.map((r) => r.session_id);
  const head = rows.find((r) => r.head === 1)?.session_id ?? sessions[sessions.length - 1]!;
  return { id: row.thread_id, sessions, head };
}

/** Every derived thread, root first — what `deriveThreads` last wrote. */
export function storedThreads(db: Db): Thread[] {
  const rows = db
    .prepare(
      `SELECT session_id, thread_id, depth, head FROM session_threads
        ORDER BY thread_id, depth, session_id`,
    )
    .all() as { session_id: string; thread_id: string; depth: number; head: number }[];
  const byThread = new Map<string, { sessions: string[]; head: string }>();
  for (const r of rows) {
    const t = byThread.get(r.thread_id) ?? { sessions: [], head: r.session_id };
    t.sessions.push(r.session_id);
    if (r.head === 1) t.head = r.session_id;
    byThread.set(r.thread_id, t);
  }
  return [...byThread.entries()]
    .map(([id, t]) => ({ id, sessions: t.sessions, head: t.head }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** True when this session is a link in a chain rather than a thread of one. */
export function inThread(db: Db, sessionId: string): boolean {
  return (
    db.prepare('SELECT 1 AS ok FROM session_threads WHERE session_id = ? LIMIT 1').get(sessionId) !==
    undefined
  );
}

export interface ThreadTotals {
  sessions: number;
  exchanges: number;
  prompts: number;
  bytes: number;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * What the whole thread holds — the numbers `ls` and `graft` print for it.
 *
 * The range is the thread's, not the head's: a chain that began on 12 august
 * and was last worked on the 20th started on the 12th, and saying so is not
 * the same mistake as dating the *session* by a record it did not write.
 */
export function threadTotals(db: Db, thread: Thread): ThreadTotals {
  const marks = thread.sessions.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(s.user_prompts), 0) AS prompts,
              COALESCE(SUM(s.bytes), 0) AS bytes,
              MIN(s.started_at) AS started_at,
              MAX(COALESCE(s.ended_at, s.started_at)) AS ended_at,
              (SELECT COUNT(*) FROM exchanges e WHERE e.session_id IN (${marks})) AS exchanges
         FROM sessions s WHERE s.id IN (${marks})`,
    )
    .get(...thread.sessions, ...thread.sessions) as {
    sessions: number;
    prompts: number;
    bytes: number;
    started_at: string | null;
    ended_at: string | null;
    exchanges: number;
  };
  return {
    sessions: row.sessions,
    exchanges: row.exchanges,
    prompts: row.prompts,
    bytes: row.bytes,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/**
 * A thread addressed the way a caller types it: by any member's id8.
 *
 * Everything here already existed — {@link threadOf} has the chain,
 * {@link threadTotals} has the arithmetic, `resolveSession` turns eight
 * characters into an id. What did not exist was one function joining them, and
 * the MCP package had been asking for it by name since T10.6: `tools/thread.ts`
 * probed `core.resolveThread`, found `undefined`, and degraded to the single
 * session it was handed — so `potsherd_read` on the audit's own F4 fixture
 * returned the head's exchanges and told the model *"this build of potsherd
 * does not model fork/resume chains yet"*, in the release that had just built
 * the chain. `potsherd_read` is one of the archaeologist's two tools. F4
 * reproduced at the model door.
 *
 * Resolution is `resolveSession`'s, not a second one, for the same reason
 * lineage is derived once at index time: `potsherd show <id8>` and
 * `potsherd_read {"thread":"<id8>"}` cannot be allowed to mean two different
 * sessions.
 *
 * **Never a thread of nothing.** A session no fork touched resolves to a chain
 * of one, so a caller may treat "the thread" as the unit without first asking
 * whether there is one. `null` means only that the reference named nothing.
 *
 * {@link ThreadResolution.ambiguous} carries `resolveSession`'s candidate list
 * through rather than swallowing it: showing someone the wrong conversation,
 * confidently, is the one failure a memory tool cannot recover from, and the
 * caller — CLI or MCP — is the layer that knows how to say so.
 */
export interface ThreadResolution {
  /** The root of the chain. Stable whichever member was named. */
  threadId: string;
  /** Root first, head last. One entry for a session that is its own thread. */
  sessionIds: string[];
  /** The thread's range: the earliest link's start, the latest link's end. */
  startedAt: string | null;
  endedAt: string | null;
  /** Exchanges across every link — the number F4 says `graft` should print. */
  exchanges: number;
  /** Set when the reference matched more than one thread it could mean. */
  ambiguous?: SessionCandidate[];
  /**
   * The subagent transcripts this reference also matched, when a parent uuid
   * was taken over its own children. VERIFICATION-8 C8-1: carried through for
   * the same reason {@link ThreadResolution.ambiguous} is — the caller is the
   * layer that knows how to say it, and saying nothing is what made
   * `show`'s *"any unambiguous prefix"* false.
   */
  collapsed?: SessionCandidate[];
}

export function resolveThread(db: Db, ref: string): ThreadResolution | null {
  const found = resolveSession(db, ref?.trim() ?? '');
  if (!found) return null;
  const thread = threadOf(db, found.id);
  const totals = threadTotals(db, thread);
  return {
    threadId: thread.id,
    sessionIds: thread.sessions,
    startedAt: totals.startedAt,
    endedAt: totals.endedAt,
    exchanges: totals.exchanges,
    ...(found.ambiguous ? { ambiguous: found.ambiguous } : {}),
    ...(found.collapsed ? { collapsed: found.collapsed } : {}),
  };
}
