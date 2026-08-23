import { z } from 'zod';
import { recall } from '@potsherd/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { parseFilters, parseLimit, type FilterFlags } from '../../../cli/src/filters.js';
import { UserError } from '../../../cli/src/output.js';
import { withIndexAsync, type ServerContext } from '../context.js';
import { RECALL_DESCRIPTION } from '../descriptions.js';
import { guarded, jsonResult } from '../result.js';
import {
  AGENT_FLOOR,
  MIN_CONFIDENCE_FIELD,
  SCOPE,
  WANT,
  belowFloorOf,
  calibrationOf,
  confidenceOf,
  minConfidenceOf,
  type Confidence,
  type ScopeArg,
} from './shapes.js';
import { mintCitation } from './sources.js';
import { threadIdOf } from './thread.js';

/**
 * `potsherd_recall` — the one door the main-loop agent opens.
 *
 * Audit §4.5 and plan §B7 pin the signature:
 * `potsherd_recall(query, scope?, want: "hits"|"context")`. It replaces
 * `potsherd_find` and `potsherd_ls`, and the reason is F7 rather than tidiness:
 *
 * > Six tools with overlapping descriptions cost me a decision every time; two
 * > with disjoint jobs cost me none.
 *
 * `ls` is not lost. `ls` was *browse by period, project or label*, which is
 * this tool with a `scope` and no interesting query — and the auditor's own
 * measurement (F8) is that the short, distinctive query is the one that wins
 * anyway. What is lost is the decision between two tools that search the same
 * table.
 *
 * Three things this surface owes the agent that `find` did not give it.
 *
 * **A cliff, not a ranking (F1).** `confidence` is read off the core result —
 * see `shapes.ts` for why it is read and never computed here — and put on the
 * envelope and on every row. When it is `none` this returns **zero rows** and
 * says `no match`, because the auditor asked for exactly that:
 *
 * > An honest empty result buys more trust than a full page of maybes, and
 * > trust is what determines whether I call you again.
 *
 * **A citation the model cannot compose (F3).** Every row carries a `citation`
 * minted by {@link mintCitation} from index rows. The agent copies it; it never
 * writes one. A `SOURCES` line that was not minted is refused by
 * `verifySources`, which is the same discipline `filterAnswer` runs on quotes.
 *
 * **The windows themselves (F5).** `want: "context"` returns the matching
 * exchanges — seq, ts, text — instead of snippets. They are relevance-selected
 * and **discontiguous** by construction, because they are the diversified hits
 * `recall` already ranked, up to three from anywhere in a session. That is the
 * auditor's item 3 verbatim: *five 200-token windows from across a long session
 * beat one 1,300-token window from its opening.*
 */

/** Chars per token, for the `want: "context"` budget. `est.`, not measured. */
export const CHARS_PER_TOKEN = 4;

/** The context budget when the caller names none, in tokens. */
export const DEFAULT_CONTEXT_BUDGET = 6_000;

export const recallInput = {
  query: z
    .string()
    .min(1)
    .describe(
      'what to look for. Two to four distinctive nouns beat a whole sentence: the index is keyword-first and a long question dilutes into stopwords',
    ),
  scope: SCOPE,
  want: WANT,
  budget: z
    .number()
    .int()
    .min(200)
    .optional()
    .describe(
      `want: "context" only — token ceiling on the windows returned. Default ${DEFAULT_CONTEXT_BUDGET}`,
    ),
};

export type RecallArgs = z.infer<z.ZodObject<typeof recallInput>>;

export interface RecallWindow {
  thread: string;
  sessionId: string;
  id8: string;
  seq: number | null;
  ts: string | null;
  kind: string;
  isSidechain: boolean;
  confidence: Confidence | null;
  /** T10.1's `{ score, coverage, strength, agreement }`, passed through. */
  calibration: unknown;
  citation: string;
  text: string;
}

export async function runRecall(
  ctx: ServerContext,
  args: RecallArgs,
): Promise<Record<string, unknown>> {
  const query = args.query?.trim();
  if (!query) {
    throw new UserError(
      'recall needs something to look for',
      'potsherd_recall {"query":"pgbouncer transaction pooling"}',
    );
  }
  const want = args.want ?? 'hits';
  const scope = args.scope ?? {};

  return withIndexAsync(ctx, async (db, root) => {
    const filters = parseFilters(db, toFlags(scope));
    const limit = parseLimit(scope.limit, 10);

    /**
     * **The floor.** The single most important line in this file.
     *
     * `packages/cli/src/commands/find.ts` searches at `minConfidence: 'weak'`
     * so the human view returns zero rows and `no match` rather than ten
     * confident-looking rows scored 0.0110. This door searches at the same
     * floor, from the same constant, because a model path that returned rows
     * the human path withheld would put the agent back exactly where audit F1
     * found it:
     *
     * > I have no way to distinguish "the archive contains your answer" from
     * > "the archive contains nothing and I am showing you the ten least-bad
     * > rows." So the agent does the rational thing: it treats the whole result
     * > set as unreliable and falls back to a source it *can* verify — the repo
     * > in front of it.
     *
     * The cast is scaffolding, not a design choice: this worktree was cut
     * before T10.1 landed and may not fetch, so its `RecallOptions` does not
     * declare the field yet. At integration the cast becomes a no-op and can
     * be deleted; the field name is a constant either way.
     */
    const options = {
      limit,
      root,
      vectors: 'auto',
      [MIN_CONFIDENCE_FIELD]: AGENT_FLOOR,
    } as Parameters<typeof recall>[3];

    const result = await recall(db, query, filters, options);

    // T10.1's label, read — never re-derived. `null` means this build of core
    // does not carry one yet, and `null` is not `none`: see `shapes.ts`.
    const confidence = confidenceOf(result);
    const calibrated = confidence !== null;
    // The floor the search actually ran at, and how many rows it withheld —
    // read off the result rather than echoed from the argument, so a core that
    // clamps or ignores the floor is visible here instead of being covered up.
    const minConfidence = minConfidenceOf(result);
    const belowFloor = belowFloorOf(result);

    /**
     * The honest empty.
     *
     * T10.1 makes `recall` itself return zero rows on `none`. This is not a
     * second implementation of that rule — it computes no score and moves no
     * threshold — it is the surface refusing to print rows the core has already
     * labelled `none`, so the two can never disagree in the direction that
     * matters. If core returns zero rows, this changes nothing.
     */
    const noMatch = confidence === 'none';

    const sessions = noMatch ? [] : result.sessions;
    const hits = noMatch ? [] : result.hits;
    const threads = groupThreads(sessions);

    const envelope: Record<string, unknown> = {
      query: result.query,
      want,
      scope: filters,
      // ---------------------------------------------------------- the cliff
      confidence,
      calibrated,
      minConfidence,
      /**
       * Rows the floor withheld.
       *
       * Reported rather than hidden, because "nothing matched" and "eleven
       * things matched and none of them well enough to show you" are different
       * answers and the agent should be able to say which one it got.
       */
      belowFloor,
      noMatch,
      /**
       * `05`'s honesty contract, and audit item 9: *tell me what you can't do,
       * at the top.* One line, on every reply, saying what this search was
       * actually able to do — read off `result.vectors`, which is core's own
       * single source of truth for it.
       */
      capability: capabilityLine(result.vectors),
      vectors: result.vectors,
      note: noMatch
        ? 'no match. The archive does not contain this' +
          (belowFloor ? `, though ${String(belowFloor)} rows were withheld below the ${String(minConfidence ?? AGENT_FLOOR)} floor` : '') +
          '. Say so — do not widen into a guess, and do not answer from the repository in ' +
          'front of you.'
        : calibrated
          ? null
          : 'this build of potsherd does not calibrate its scores yet, so "confidence" is null ' +
            'rather than a measurement. Treat a low-scoring row as unproven.',
      ignored: result.ignored,
      lists: result.lists,
      relaxed: result.relaxed,
      relaxedLists: result.relaxedLists,
      k: result.k,
      weights: result.weights,
      ms: result.ms,
      threads,
    };

    if (want === 'context') {
      const budget = Math.max(200, Math.floor(args.budget ?? DEFAULT_CONTEXT_BUDGET));
      const { windows, truncated, tokens } = windowsFrom(sessions, budget);
      envelope['windows'] = windows;
      envelope['windowBudget'] = budget;
      envelope['windowTokens'] = tokens;
      envelope['windowsTruncated'] = truncated;
      envelope['readMore'] =
        windows.length === 0
          ? null
          : 'these windows are discontiguous and relevance-selected. potsherd_read the thread for ' +
            'the exchanges around any of them.';
    } else {
      envelope['hits'] = hits.map((h) => hitJson(h, sessions));
    }

    return envelope;
  });
}

type Result = Awaited<ReturnType<typeof recall>>;
type Session = Result['sessions'][number];
type Hit = Result['hits'][number];

/**
 * Sessions, grouped into the threads T10.3 is building.
 *
 * The grouping key is read off the core row ({@link threadIdOf}); when this
 * build carries none, every session is its own thread of one and `threadOf`
 * says `session`. No uuid overlap is computed here — see `thread.ts` for why a
 * second lineage implementation at this surface would be worse than none.
 */
function groupThreads(sessions: readonly Session[]): Record<string, unknown>[] {
  const order: string[] = [];
  const byThread = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = threadIdOf(s) ?? s.id;
    if (!byThread.has(key)) {
      byThread.set(key, []);
      order.push(key);
    }
    byThread.get(key)!.push(s);
  }

  return order.map((key) => {
    const members = byThread.get(key)!;
    const lead = members[0]!;
    const exchanges = members.reduce((n, m) => n + m.exchanges, 0);
    const prompts = members.reduce((n, m) => n + m.prompts, 0);
    const started = members.map((m) => m.startedAt).filter(Boolean).sort()[0] ?? null;
    const ended =
      members
        .map((m) => m.endedAt)
        .filter(Boolean)
        .sort()
        .pop() ?? null;
    return {
      thread: key,
      id8: key.slice(0, 8),
      threadOf: threadIdOf(lead) === null ? 'session' : 'chain',
      links: members.map((m) => ({ sessionId: m.id, id8: m.id.slice(0, 8), exchanges: m.exchanges })),
      confidence: confidenceOf(lead),
      calibration: calibrationOf(lead),
      kind: lead.kind,
      harness: lead.harness,
      title: lead.title,
      displayTitle: lead.displayTitle,
      // `project` is the short name the pretty view shows, not the absolute
      // path `--json` used to hand back (audit F9: an agent parsing JSON got a
      // strictly worse object than a human reading the terminal).
      project: lead.projectName,
      projectPath: lead.project,
      startedAt: started,
      endedAt: ended,
      status: lead.status,
      isSidechain: lead.isSidechain,
      parentSessionId: lead.parentSessionId,
      agentName: lead.agentName,
      pinned: lead.pinned,
      prompts,
      exchanges,
      resume: lead.resume,
      score: lead.score,
      /** Minted here. Copy it; do not compose one. See `sources.ts`. */
      citation: mintCitation({
        sessionId: key,
        kind: lead.kind,
        harness: lead.harness,
        project: lead.projectName,
        exchanges,
        prompts,
        date: (ended ?? started)?.slice(0, 10) ?? null,
      }),
    };
  });
}

function hitJson(h: Hit, sessions: readonly Session[]): Record<string, unknown> {
  const owner = sessions.find((s) => s.id === h.sessionId);
  return {
    thread: (owner ? threadIdOf(owner) : null) ?? h.sessionId,
    sessionId: h.sessionId,
    id8: h.sessionId.slice(0, 8),
    kind: h.kind,
    isSidechain: h.isSidechain,
    seq: h.seq ?? null,
    ts: h.ts ?? null,
    confidence: confidenceOf(h),
    calibration: calibrationOf(h),
    score: h.score,
    from: h.from,
    snippet: h.snippet.text,
    match: h.snippet.match ?? null,
    // A card is a routing aid, never evidence (audit F6, plan §B8). Named on
    // the row so a model cannot quote one as a transcript.
    evidence: h.kind === 'card' || h.kind === 'title' ? 'not-a-transcript' : 'transcript',
  };
}

/**
 * `want: "context"` — the windows, budgeted.
 *
 * Round-robin across threads rather than draining the best one first, because
 * F5's failure was six sessions each handed one contiguous opening. One window
 * from each of five threads is a better first page than five from one.
 */
function windowsFrom(
  sessions: readonly Session[],
  budgetTokens: number,
): { windows: RecallWindow[]; truncated: boolean; tokens: number } {
  const queues = sessions.map((s) => ({ s, hits: [...s.hits] }));
  const windows: RecallWindow[] = [];
  let chars = 0;
  const ceiling = budgetTokens * CHARS_PER_TOKEN;
  let truncated = false;

  for (let round = 0; ; round++) {
    let any = false;
    for (const q of queues) {
      const h = q.hits[round];
      if (!h) continue;
      any = true;
      // A card hit has no exchange behind it, so it has no window to return.
      if (h.kind === 'card' || h.kind === 'title') continue;
      const text = [h.userText, h.assistantText].filter(Boolean).join('\n\n').trim();
      if (!text) continue;
      if (chars + text.length > ceiling) {
        truncated = true;
        continue;
      }
      chars += text.length;
      windows.push({
        thread: threadIdOf(q.s) ?? q.s.id,
        sessionId: h.sessionId,
        id8: h.sessionId.slice(0, 8),
        seq: h.seq ?? null,
        ts: h.ts ?? null,
        kind: h.kind,
        isSidechain: h.isSidechain,
        confidence: confidenceOf(h),
        calibration: calibrationOf(h),
        citation: mintCitation({
          sessionId: h.sessionId,
          kind: q.s.kind,
          harness: q.s.harness,
          project: q.s.projectName,
          exchanges: q.s.exchanges,
          prompts: q.s.prompts,
          date: (q.s.endedAt ?? q.s.startedAt)?.slice(0, 10) ?? null,
        }),
        text,
      });
    }
    if (!any) break;
  }

  return {
    windows,
    truncated,
    // `est.` — chars divided by CHARS_PER_TOKEN, not a tokeniser's count.
    tokens: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

/** Audit item 9, on every reply rather than once in `doctor`. */
export function capabilityLine(v: Result['vectors']): string {
  if (v.used) return `keyword + semantic search${v.vectors ? ` · ${String(v.vectors)} vectors` : ''}`;
  if (!v.available)
    return `SEMANTIC SEARCH UNAVAILABLE — results are keyword-only${v.reason ? ` (${v.reason})` : ''}`;
  return `keyword search answered this one${v.reason ? ` (${v.reason})` : ''}`;
}

/** The contract's field names, in the words `parseFilters` already speaks. */
export function toFlags(scope: NonNullable<ScopeArg> | Record<string, never>): FilterFlags {
  const s = scope as {
    project?: string;
    harness?: string;
    since?: string;
    until?: string;
    tag?: string;
    sidechains?: string;
    ghosts?: string;
    pinned?: boolean;
  };
  return {
    ...(s.project ? { project: s.project } : {}),
    ...(s.harness ? { harness: s.harness } : {}),
    ...(s.since ? { since: s.since } : {}),
    ...(s.until ? { until: s.until } : {}),
    ...(s.tag ? { tag: s.tag } : {}),
    ...(s.sidechains ? { sidechains: s.sidechains } : {}),
    ...(s.ghosts ? { ghosts: s.ghosts } : {}),
    ...(s.pinned ? { pinned: true } : {}),
  };
}

export function registerRecall(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'potsherd_recall',
    {
      title: 'Search past coding sessions',
      description: RECALL_DESCRIPTION,
      inputSchema: recallInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => guarded(async () => jsonResult(await runRecall(ctx, args as RecallArgs))),
  );
}
