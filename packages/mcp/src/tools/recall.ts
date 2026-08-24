import { z } from 'zod';
import { format, recall, vecStatus, type VecStatus } from '@potsherd/core';
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

/**
 * Hit kinds whose text is a **summary of** a conversation, not a line from one.
 *
 * FIX-F C3. This door already knew the fact — `hitJson` spelled
 * `h.kind === 'card' || h.kind === 'title'` to label a row `not-a-transcript`,
 * and `windowsFrom` spelled it again to skip a hit with no exchange behind it —
 * and then `groupThreads` minted a citation for the thread anyway, because
 * citability was keyed on `lane` and a title's lane is `evidence`. So the fact
 * was on the row and not on the thread, which is how a session an agent had
 * only ever seen six model-written words of came back with a syntactically
 * perfect, index-resolvable citation attached.
 *
 * It is named once here instead of spelled three times. The authority is
 * `SUMMARY_KINDS` in `packages/core/src/recall.ts`, which this must agree with;
 * it is not imported because it is not on the `@potsherd/core` barrel yet and
 * that file is not this branch's to edit — the one line that closes the gap is
 * in FIX-F-REPORT.md §4.
 */
const SUMMARY_KINDS: ReadonlySet<string> = new Set(['card', 'title']);

/**
 * What a row is: a line from a transcript, or a statement about one.
 *
 * The word an agent reads before it decides whether it may quote something.
 */
export function evidenceOf(kind: string): 'transcript' | 'not-a-transcript' {
  return SUMMARY_KINDS.has(kind) ? 'not-a-transcript' : 'transcript';
}

/** Chars per token, for the `want: "context"` budget. `est.`, not measured. */
export const CHARS_PER_TOKEN = 4;

/** The context budget when the caller names none, in tokens. */
export const DEFAULT_CONTEXT_BUDGET = 6_000;

/**
 * `scope`, plus the control the human has had since T10.7 and the agent has not.
 *
 * FIX-F C3. `plans/phases/phase-10-agent-audit.md §B8` asks for two things
 * about cards: that they never outrank a transcript hit, and that there is a
 * `--no-cards`. The CLI has `--no-cards  transcripts only — do not search
 * session cards`; `potsherd_recall`'s scope was
 * `project, harness, since, until, tag, sidechains, ghosts, pinned, limit` and
 * had no cards control at all — so the one caller the whole finding is about
 * was the one that could not switch it off.
 *
 * It is added here rather than in `shapes.ts` only because that file is not
 * this branch's to edit; the field belongs beside the other eight and the
 * move is a copy-paste. `false` is the only interesting value: `undefined`
 * and `true` both mean cards on, exactly as `find` reads its flag, so an
 * existing caller's object means what it has always meant.
 *
 * It removes `cards_fts` and `vec_cards` from the fusion outright, which is
 * strictly stronger than the demotion: with it on there is nothing in the
 * routing lane to demote. It does **not** switch off the `titles` list —
 * `--no-cards` has never meant that on either surface, a title is not a card,
 * and a title-only thread is now uncitable and ranked behind every transcript
 * anyway, which is the part of C3 that a flag should not have to buy.
 */
const SCOPE_WITH_CARDS = SCOPE.unwrap()
  .extend({
    cards: z
      .boolean()
      .optional()
      .describe(
        'false: search transcripts only, and do not search session cards (model-written summaries). Default true — a card can route you to a thread whose transcript never uses your words, and it is never citable',
      ),
  })
  .optional()
  .describe(SCOPE.description ?? '');

export const recallInput = {
  query: z
    .string()
    .min(1)
    .describe(
      'what to look for. Two to four distinctive nouns beat a whole sentence: the index is keyword-first and a long question dilutes into stopwords',
    ),
  scope: SCOPE_WITH_CARDS,
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
  /**
   * True when `text` is the head of a longer exchange, cut to fit `budget`.
   *
   * FIX-F C6. Named on the window rather than only counted on the envelope,
   * because the agent quoting from it has to know that what it is holding
   * stops mid-exchange.
   */
  clipped?: boolean;
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
      // FIX-F C3. `undefined` and `true` both mean cards on; only an explicit
      // `false` takes the two card lists out of the fusion. Same expression as
      // `cli/src/commands/find.ts`, so the two doors cannot mean different
      // things by the same word.
      cards: (scope as { cards?: boolean }).cards !== false,
      [MIN_CONFIDENCE_FIELD]: AGENT_FLOOR,
    } as Parameters<typeof recall>[3];

    const result = await recall(db, query, filters, options);

    /**
     * The denominator, from the one place that owns it.
     *
     * `VectorState` carries `vectors` (a numerator) and no total, so the count
     * this door printed could not be interpreted. `vecStatus(db, root).report`
     * is what `doctor`, `index`, `find` and `stats` all render, read here on
     * the same connection the search just used — wired, not recomputed, so the
     * model door and the human verbs cannot drift apart.
     */
    const vectorReport = vecStatus(db, root).report;

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
    // C5a again, on the list the agent actually chooses a thread from. The
    // verifier filed `hits[]`; `threads[]` carries the same two axes — a
    // block score that is RRF's and a `calibration`/`confidence` that is not —
    // so it is the same defect one field over, and leaving it would be fixing
    // the half that was named. Measured over nine queries on the demo corpus
    // this reorders nothing: core's block order and the block label already
    // agree there. This is the fence, not a change of ranking.
    const threads = orderByLabel(groupThreads(sessions));

    const envelope: Record<string, unknown> = {
      query: result.query,
      want,
      scope: filters,
      // F6 on the envelope, in the words `find --json` already uses: whether
      // the card lists ran at all, and how much of this page is a summary
      // rather than something quotable. A caller that asked for transcripts
      // only can confirm it took without walking `threads[]`, and a caller
      // that did not can see what it is holding. FIX-F C3.
      cards: (scope as { cards?: boolean }).cards !== false,
      routing: sessions.filter((s) => (s as { lane?: string }).lane === 'routing').length,
      summaryOnly: threads.filter((t) => t['evidence'] === 'not-a-transcript').length,
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
      capability: capabilityLine(result.vectors, vectorReport),
      vectors: result.vectors,
      note: noMatch
        ? 'no match. The archive does not contain this' +
          // FIX-F C7 — `1 rows were withheld`, live at the model door. The
          // project singularises everywhere else through `f.plural`; this was
          // the one call site that built the clause by concatenation instead.
          (belowFloor
            ? `, though ${String(belowFloor)} ${format.plural(belowFloor, 'row')} ` +
              `${format.plural(belowFloor, 'was', 'were')} withheld below the ` +
              `${String(minConfidence ?? AGENT_FLOOR)} floor`
            : '') +
          // Which half of the search returned the empty. "The archive does not
          // contain this" is a much stronger claim when both halves ran than
          // when only bm25 did, and the gap is measured: the verifier's query
          // answers 1 session with vectors on and 0 with them off.
          //
          // FIX-F C2 — and *did not* is not *has not yet*. An agent told the
          // semantic half is warming reads this whole note as "retry later";
          // on an index nothing is embedding, the retry returns the identical
          // empty. The clause that says so is the difference between a caller
          // that stops and a caller that loops.
          (result.vectors.used
            ? ''
            : '. Only keyword search ran; the semantic half did not' +
              (vectorReport?.working === false && vectorReport.phase !== 'ready'
                ? ', and nothing is embedding this index, so running the same search ' +
                  'again will not change that'
                : '')) +
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
      const { windows, truncated, tokens, clipped } = windowsFrom(sessions, budget);
      envelope['windows'] = windows;
      envelope['windowBudget'] = budget;
      envelope['windowTokens'] = tokens;
      envelope['windowsTruncated'] = truncated;
      envelope['windowsClipped'] = clipped;
      /**
       * FIX-F C6 — and it used to be `null` in exactly the case where it is the
       * only useful thing to say.
       *
       * `readMore` was `windows.length === 0 ? null : '…'`. An agent that asked
       * for context, was told `threads: 1` and `noMatch: false`, and got zero
       * windows and no `hits` key — because `want: "context"` replaces it — was
       * also denied the one sentence naming the tool that would have got it the
       * text. The empty page is the page that most needs the next step on it.
       *
       * So it is unconditional, and it says which of the three things happened:
       * a clipped window is a fragment, a truncated page is missing threads,
       * and an empty page is a page where `potsherd_read` is the whole answer.
       */
      envelope['readMore'] =
        noMatch
          ? // Nothing matched, so there is no thread to read and naming one
            // would be an instruction the caller cannot carry out — which is
            // the failure this whole phase is about. `note` has already said
            // what happened.
            null
          : windows.length === 0
          ? 'no window could be returned for this page. potsherd_read the thread to read it — ' +
            'threads[] names each one.'
          : (clipped > 0
              ? 'one window is the opening of an exchange longer than the whole budget, cut to ' +
                'fit and marked "clipped": do not read its end as the end of the exchange. '
              : '') +
            'these windows are discontiguous and relevance-selected. potsherd_read the thread for ' +
            'the exchanges around any of them.' +
            (truncated ? ' Some matching exchanges did not fit the budget.' : '');
    } else {
      // Labelled first, then ordered: `orderByLabel`'s first key is the
      // `evidence` field `hitJson` attaches, so ordering the raw core rows
      // would sort on a field that is not there yet. FIX-F C3.
      envelope['hits'] = orderByLabel(hits.map((h) => hitJson(h, sessions)));
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
      /**
       * F6 — a thread the agent has only seen a summary of gets no citation.
       *
       * `mintCitation` exists so a model copies a source line instead of
       * composing one. Minting one for a thread the agent has only ever seen a
       * *summary* of would hand it a syntactically perfect, index-resolvable
       * citation for a claim no transcript supports — and `verifySources`
       * would keep it, because the session really is in the index. Checking
       * the id is not checking the provenance, so the refusal has to happen
       * where the line is minted.
       *
       * **FIX-F C3 — and until now it never fired for a title.** The refusal
       * was keyed on `lane === 'routing'`, `ROUTING_KINDS` is `{card}`, and a
       * title hit's lane is `evidence`. On the reference archive, five of ten
       * threads returned by one query had matched **only** on their session
       * title, and every one came back `lane: "evidence"`, `citable: true`,
       * carrying `<id8> · <project> · claude · N exchanges · <date>`. A Claude
       * Code title is an `ai-title` record — a model's six words, written
       * mid-session — so that is the audit's F6 sentence reached through the
       * other door, and the human CLI printed *"the session title matched; the
       * body does not use those words"* on the identical query.
       *
       * So the question is no longer *which lane is this* but *has the agent
       * been shown anything it could quote*, which is what `citable` always
       * meant. Both are published: `lane` is core's routing decision, read and
       * never recomputed here, and `evidence` is this thread's own hits. A
       * build whose core predates the lane carries none and mints as before;
       * a build whose core carries no hits on the block does the same, because
       * an absent fact must not become a refusal.
       */
      lane: lead.lane ?? 'evidence',
      evidence: threadEvidence(members),
      citable: (lead.lane ?? 'evidence') === 'evidence' && threadEvidence(members) !== 'not-a-transcript',
      citation:
        (lead.lane ?? 'evidence') === 'routing' || threadEvidence(members) === 'not-a-transcript'
          ? null
          : mintCitation({
              sessionId: key,
              kind: lead.kind,
              harness: lead.harness,
              project: lead.projectName,
              exchanges,
              prompts,
              date: (ended ?? started)?.slice(0, 10) ?? null,
            }),
      // Why there is no citation, in the words the human view uses for the
      // same row. A `null` field an agent cannot explain is a field it works
      // around; this one says what would have to happen for a citation to
      // exist, and `potsherd_read` is a tool it actually has.
      ...(threadEvidence(members) === 'not-a-transcript'
        ? {
            citableNote:
              'nothing here is a transcript: the session title or its card matched, the body did ' +
              'not use those words. Not citable. potsherd_read the thread if you want to know ' +
              'what it actually says.',
          }
        : {}),
    };
  });
}

/**
 * Whether a thread has shown the agent any transcript text at all.
 *
 * `'transcript'` when at least one hit under this thread is a line somebody
 * actually wrote; `'not-a-transcript'` when every hit is a card or a title.
 * A thread whose core build attaches no hits answers `'transcript'` — the
 * pre-existing behaviour — because an absent fact is not evidence of absence
 * and this field must never invent a refusal.
 */
function threadEvidence(members: readonly Session[]): 'transcript' | 'not-a-transcript' {
  const hits = members.flatMap((m) => (m as { hits?: readonly { kind: string }[] }).hits ?? []);
  if (hits.length === 0) return 'transcript';
  return hits.some((h) => evidenceOf(h.kind) === 'transcript') ? 'transcript' : 'not-a-transcript';
}

/** The three words, best first. `null` is not a rank — see {@link orderByLabel}. */
const CONFIDENCE_RANK: Record<Confidence, number> = { strong: 0, weak: 1, none: 2 };

/**
 * C5a — the first row is the best row, by the number that carries the meaning.
 *
 * The third verifier caught `hit0 score 0.016393 conf weak` sitting **above**
 * `hit1 score 0.016393 conf strong`. Both numbers were right and they were
 * measuring different things:
 *
 *  - `score` is reciprocal rank fusion, `weight * 1/(k + rank)` — a function of
 *    rank alone (`core/recall.ts`). Two rows at rank 1 of two different lists
 *    are 0.016393 apart from nothing, and RRF is the *merge* order: it decides
 *    which candidates survive, not how good any of them is.
 *  - `calibration.score` — and the `confidence` word lifted off it — is
 *    computed from the evidence RRF discards: `from[].raw`, how many of the
 *    query's distinctive words the row can actually show, and how many lists
 *    found it independently.
 *
 * Every field an agent needs to re-sort was already on the row, so this was
 * never a hole. It was worse in one specific way: the reader at this door is a
 * model, and **the first row is the best row** is the assumption every consumer
 * of a ranked list makes before it reads a field. A default order that
 * contradicts the default label spends that assumption on nothing.
 *
 * So the order is the label's, and the label's own tie-break beneath it:
 *
 *   1. `confidence` — the word, not the number, because the number can be
 *      *capped*. A routing row scoring 0.9 is labelled `weak` by
 *      `ROUTING_CEILING`, and sorting on `calibration.score` alone would
 *      have put a `weak` card back above a `strong` transcript — the same
 *      defect with a different arithmetic behind it.
 *   2. `calibration.score`, within a band.
 *   3. the fused `score`, which is the merge order, as the last tie-break —
 *      so nothing here invents an order where the two axes are silent.
 *
 * F6 survives it. A card is capped at `weak` and can therefore never outrank a
 * `strong` transcript, whatever it scores.
 *
 * **Nothing is recomputed.** This reads `confidence` and `calibration.score`
 * off the rows core already labelled, exactly as the rest of this file does;
 * it moves rows, it does not score them. And it changes no membership: the same
 * hits come back, so the floor, `belowFloor` and the `noMatch` cliff are
 * untouched.
 */
export function orderByLabel<T>(rows: readonly T[]): T[] {
  const out = [...rows];
  // A build whose core carries no label has nothing for the order to
  // contradict, so the fused order stands untouched. `null` is not `none`.
  if (out.some((r) => confidenceOf(r) === null)) return out;
  return out
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) =>
        // FIX-F C3, and it is the first key rather than a tie-break.
        //
        // Core partitions its own two lists the same way (`recall.summaryRank`),
        // and this is the fence that stops the re-sort at this door undoing it:
        // `orderByLabel` reads only `confidence` and two scores, so a
        // summary-only row with a better `calibration.score` than a weak
        // transcript row would be lifted straight back over it. That is not
        // hypothetical — it is what a card could already do here, since the
        // {@link ROUTING_CEILING} only stops a card beating a *strong* row.
        //
        // It does not contradict the label, because core now caps a
        // summary-only row at `weak` (FIX-F C3): every row above the summaries
        // is at least as confident as every row below them, so `hits[]` and
        // `threads[]` stay monotone in the confidence word, which is the
        // property FIX-D's fences pin. A row carrying no `evidence` field —
        // any caller passing plain rows, and every unit test written before
        // this — counts as `transcript` and nothing about its order changes.
        evidenceRank(a.row) - evidenceRank(b.row) ||
        CONFIDENCE_RANK[confidenceOf(a.row)!] - CONFIDENCE_RANK[confidenceOf(b.row)!] ||
        calibrationScoreOf(b.row) - calibrationScoreOf(a.row) ||
        scoreOf(b.row) - scoreOf(a.row) ||
        // Explicit, rather than leaning on the runtime's sort being stable.
        a.i - b.i,
    )
    .map((r) => r.row);
}

/**
 * 0 for a row with transcript evidence behind it, 1 for a summary-only row.
 *
 * Read off the published `evidence` field — the one `hitJson` and
 * `groupThreads` already put on every row — rather than recomputed from
 * `kind`, so what the agent is shown and what the order is built from are one
 * value. An unlabelled row is 0: absent is not `not-a-transcript`.
 */
function evidenceRank(row: unknown): 0 | 1 {
  if (!row || typeof row !== 'object') return 0;
  return (row as { evidence?: unknown }).evidence === 'not-a-transcript' ? 1 : 0;
}

/** `calibration.score`, or 0 when this build's core attaches none. */
function calibrationScoreOf(row: unknown): number {
  const c = calibrationOf(row);
  if (!c || typeof c !== 'object') return 0;
  const s = (c as { score?: unknown }).score;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
}

/** The fused RRF score, or 0 when a row carries none. */
function scoreOf(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  const s = (row as { score?: unknown }).score;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
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
    evidence: evidenceOf(h.kind),
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
): { windows: RecallWindow[]; truncated: boolean; tokens: number; clipped: number } {
  const queues = sessions.map((s) => ({ s, hits: [...s.hits] }));
  const windows: RecallWindow[] = [];
  let chars = 0;
  const ceiling = budgetTokens * CHARS_PER_TOKEN;
  let truncated = false;
  let clipped = 0;
  /**
   * The one hit that would have been returned if anything fitted.
   *
   * FIX-F C6 — `want: "context"` could return `threads: 1`, `windows: 0`,
   * `windowTokens: 0` and no `hits` key, because the single matching exchange
   * was longer than the whole ceiling and the loop below `continue`d past it.
   * The agent asked for context, was told it matched, and got no text at all.
   *
   * The fix is a clip, and it is deliberately taken **only when the page would
   * otherwise be empty**. Clipping the first oversized window mid-round would
   * let one 139,000-token exchange — the reference archive has one — eat a
   * budget that F5 exists to spread across five threads. So the round-robin is
   * unchanged, and this is the floor underneath it: if nothing fitted, return
   * the best hit's opening rather than nothing, marked `clipped` so the agent
   * knows it is holding a fragment.
   */
  let firstSkipped: { q: (typeof queues)[number]; h: Session['hits'][number]; text: string } | null =
    null;

  for (let round = 0; ; round++) {
    let any = false;
    for (const q of queues) {
      const h = q.hits[round];
      if (!h) continue;
      any = true;
      // A summary hit has no exchange behind it, so it has no window to return.
      if (SUMMARY_KINDS.has(h.kind)) continue;
      const text = [h.userText, h.assistantText].filter(Boolean).join('\n\n').trim();
      if (!text) continue;
      if (chars + text.length > ceiling) {
        truncated = true;
        if (!firstSkipped) firstSkipped = { q, h, text };
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

  // The floor. Nothing fitted, and something matched: return the head of the
  // best hit rather than an empty page. `budgetTokens` is a ceiling on what
  // the caller wants to read, not a rule that it would rather read nothing.
  if (windows.length === 0 && firstSkipped) {
    const { q, h, text } = firstSkipped;
    clipped = 1;
    const cut = text.slice(0, ceiling);
    chars += cut.length;
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
      text: cut,
      clipped: true,
    });
  }

  return {
    windows,
    truncated,
    clipped,
    // `est.` — chars divided by CHARS_PER_TOKEN, not a tokeniser's count.
    tokens: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

/**
 * Audit item 9, on every reply rather than once in `doctor`.
 *
 * All three branches answer one question — *what could this search actually
 * do?* — and all three used to answer it in a way an agent could not act on:
 *
 *  - `used` printed `· 928 vectors`, a numerator with no denominator. Every
 *    human verb prints `of 4,725`, so `928` alone cannot be told apart from a
 *    finished index.
 *  - `!available` — **the branch every fresh install hits, at 0 vectors** —
 *    shouted `SEMANTIC SEARCH UNAVAILABLE` and carried `run potsherd index
 *    --embed` through `reason`. The command is one the caller has no shell to
 *    run, and "unavailable" is a claim about a permanent state that an index
 *    which is embedding right now does not have.
 *
 * The denominator is not on {@link VectorState}, so it is read from the report
 * {@link vecStatus} already computes — the same object `doctor`, `index`,
 * `find` and `stats` render — rather than counted again here. `report` is
 * optional because a caller without a connection genuinely does not have it,
 * and in that case this prints no count at all: silence beats a number that
 * cannot be interpreted.
 */
export function capabilityLine(v: Result['vectors'], report?: VecStatus['report']): string {
  const counts = report && report.total > 0
    ? ` (${format.num(report.embedded)} of ${format.num(report.total)} embedded)`
    : '';
  const because = (why?: string) => (why ? ` (${why})` : '');
  if (v.used) return `keyword + semantic search${counts}`;
  // `pending` is 0-embedded-with-work-queued and `warming` is partway through.
  // Both are transient and both are what `doctor-line.ts` calls warming.
  if (report && (report.phase === 'warming' || report.phase === 'pending')) {
    // FIX-F C2 — *transient* was an assumption, and on three ordinary indexes
    // it is false.
    //
    // `warming` tells this reader that the other half of its answer is on its
    // way, which is an instruction to retry: the same reply says *"The archive
    // does not contain this … do not widen into a guess"* and *"semantic search
    // is warming"*. After `index --no-embed`, on a machine that cannot fetch
    // the 46 MB runtime, and after an embedder was killed, no pass is running
    // and none will start — the phase is still `pending`, because the phase is
    // a fact about the rows and not about the work. `report.working` is the
    // fact about the work: a live holder of `<root>/.lock.embed`, whose pid the
    // lock carries and whose death `lock.isStale` already detects.
    //
    // Two states, two sentences, and the count in both — never one word
    // widened to cover both, which is `09 §9`. `undefined` keeps the old
    // sentence: a caller with no root cannot know, and must not guess.
    if (report.working === false)
      return `keyword search only — semantic search is not running${counts}`;
    return `keyword search only — semantic search is warming${counts}`;
  }
  if (!v.available)
    return `semantic search unavailable — results are keyword-only${because(v.reason)}`;
  return `keyword search answered this one${because(v.reason)}`;
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
