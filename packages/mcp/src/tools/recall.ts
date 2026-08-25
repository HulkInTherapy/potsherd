import { z } from 'zod';
import { SUMMARY_KINDS, format, recall, vecStatus, type VecStatus } from '@potsherd/core';
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
 * What a row is: a line from a transcript, or a statement about one.
 *
 * The word an agent reads before it decides whether it may quote something.
 * `SUMMARY_KINDS` is core's (`packages/core/src/recall.ts`) — FIX-F round 2
 * put it on the barrel, so this door and the ranker that demotes those rows
 * now read one set. It was spelled here as well for one round, because this
 * package reaches core through the barrel and the constant was not on it.
 *
 * This door already knew the fact and spelled it inline twice — `hitJson`
 * labelled a row `not-a-transcript`, `windowsFrom` skipped a hit with no
 * exchange behind it — and then `groupThreads` minted a citation for the
 * thread anyway, because citability was keyed on `lane` and a title's lane is
 * `evidence`. The fact was on the row and not on the thread, which is how a
 * session an agent had only ever seen six model-written words of came back
 * with a syntactically perfect, index-resolvable citation attached.
 */
export function evidenceOf(kind: string): 'transcript' | 'not-a-transcript' {
  // Widened rather than narrowed: `kind` arrives here off a JSON row, and a
  // build of core that adds a kind this one has never heard of must fall
  // through to `transcript` rather than fail to compile or throw.
  return (SUMMARY_KINDS as ReadonlySet<string>).has(kind) ? 'not-a-transcript' : 'transcript';
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
  /**
   * C-1 step 3 — the control the CLI has had since T10.1 and this door did not.
   *
   * ## Why a schema field and not a better note
   *
   * The tool's description tells the caller, in capitals, to trust an empty
   * reply. `belowFloor` then tells it that thirty rows were withheld. Until
   * this field existed there was **no way to ask for them**: the agent was
   * instructed to trust a silence it could neither check nor override, while
   * the human at the CLI was shown `--min-confidence none` on the same screen.
   * One door had the escape hatch and the other had the instruction to believe.
   *
   * That asymmetry is not survivable given what the floor actually does.
   * Measured on the product's own 60-query benchmark (C-1 step 1): the floor
   * withholds the correct answer on 50 of 60 queries, 44 of them ranked in the
   * top five, and it is *structurally* unable to do otherwise for a question
   * asked in words the transcript does not use — `calibrate()`'s score can
   * never exceed the fraction of the query's literal terms the row contains,
   * whatever the semantic lane says. So `none` does not mean *the archive does
   * not contain this*. It means *nothing here repeats enough of your wording*.
   * An agent has to be able to look.
   *
   * ## Why the default does not move
   *
   * `undefined` is {@link AGENT_FLOOR}, byte for byte the behaviour of every
   * build since T10.1: an absent topic and a nonsense query still come back
   * with zero rows and `noMatch: true`, at this door and at the CLI, and F1 is
   * untouched. This field only lets a caller that has already been told
   * something was withheld ask to see it — and the reply then says, in `note`,
   * that what it is holding is below the floor and is not an answer.
   */
  minConfidence: z
    .enum(['strong', 'weak', 'none'])
    .optional()
    .describe(
      `the confidence floor rows must clear to be returned. Default ${AGENT_FLOOR}. ` +
        'Pass "none" to see the rows a "no match" reply withheld — belowFloor says how many ' +
        'there are. They come back labelled "none": they are the closest text in the archive, ' +
        'not an answer to your question, and must not be cited as one. Worth doing when your ' +
        'query was a sentence rather than two to four distinctive nouns, because the floor is ' +
        'computed from how many of your literal words a thread repeats',
    ),
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
  // C-1 step 3. The floor this call was asked to run at, resolved once so the
  // search, the row-withholding and the note cannot disagree about it.
  const requestedFloor: Confidence = args.minConfidence ?? AGENT_FLOOR;
  /**
   * The caller has explicitly asked to see below the floor.
   *
   * Not `requestedFloor === 'none'` by accident: it is the *asking* that
   * matters. This surface refuses to print rows core has labelled `none`
   * (see `noMatch` below), which is right when nobody asked — an agent told
   * to trust an empty must not be handed rows underneath it — and wrong when
   * somebody did, because then the refusal would make the new field a no-op
   * and leave the door exactly where C-1 found it.
   */
  const askedBelowFloor = args.minConfidence === 'none';

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
      // C-1 step 3. `undefined` is AGENT_FLOOR, so the default path is
      // unchanged; a caller may raise the floor or ask to see below it. See
      // `recallInput.minConfidence`.
      [MIN_CONFIDENCE_FIELD]: requestedFloor,
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

    // C-1 step 3 — and the envelope's answer and the rows are now two facts.
    //
    // `noMatch` stays what it has always been: the archive's best label for
    // this question is `none`. That is the cliff and it does not move. What
    // changes is that a caller who passed `minConfidence: "none"` — having
    // been told by `belowFloor` that there was something under there — is
    // handed the rows instead of a second empty. They arrive labelled `none`,
    // and `note` says in words that they are not an answer.
    const withhold = noMatch && !askedBelowFloor;
    const sessions = withhold ? [] : result.sessions;
    const hits = withhold ? [] : result.hits;
    // C5a's order, and FIX-I C-1 is that it is no longer applied here.
    //
    // FIX-D wrote the rule at this door as `orderByLabel` — confidence word,
    // then calibration score, then the fused score, under a summary/transcript
    // partition. `find` never got it, because core sorted by lane and RRF
    // alone. Two comparators, one of them updated: exactly the defect this
    // whole family is. The rule now lives in `packages/core/src/recall.ts` as
    // `byLabel`, `recall()` applies it to `sessions` and to `hits`, and this
    // door takes the order it is given.
    //
    // `groupThreads` preserves it: it emits threads in order of first
    // appearance and each thread's lead is its first member, so the leads are
    // a subsequence of an ordered list and are ordered. `tests/mcp.test.ts`
    // pins that the published `threads[]` and `hits[]` are monotone in
    // (`evidence`, `confidence`, `calibration.score`), which is the property
    // FIX-D's fences asserted about the helper — asserted now about the reply.
    const threads = groupThreads(sessions);

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
      /**
       * C-1 step 3 — what silence means, said truthfully.
       *
       * The sentence this note used to open with was *"no match. The archive
       * does not contain this"*, and on the product's own 60-query benchmark
       * that claim is false on 50 of the 60 queries the floor withholds an
       * answer for. The floor is not a statement about the archive's contents.
       * `calibrate()`'s score can never exceed the fraction of the query's
       * **literal** terms a thread repeats, so a question asked in different
       * words than the transcript used scores `none` over an index that has
       * the answer at rank 1. C-1 §1 has the measurement.
       *
       * So the note now says the two things that are true and the one thing
       * the caller can do about it, and it distinguishes the two empties that
       * used to read identically:
       *
       *   * `belowFloor > 0` — something is under there. The archive may well
       *     contain this. Look, or ask again with distinctive nouns.
       *   * `belowFloor === 0` — nothing in the index matched at all. That is
       *     the strong empty, and it is the one the old sentence described.
       *
       * The instruction that was always right is kept and kept first: do not
       * fill an empty result from the repository in front of you.
       */
      note: withhold
        ? ((belowFloor ?? 0) > 0
            ? 'no match: nothing cleared the confidence floor'
            : 'no match: nothing in the index matched these words at all') +
          // FIX-F C7 — `1 rows were withheld`, live at the model door. The
          // project singularises everywhere else through `f.plural`; this was
          // the one call site that built the clause by concatenation instead.
          (belowFloor
            ? `. ${String(belowFloor)} ${format.plural(belowFloor, 'row')} ` +
              `${format.plural(belowFloor, 'was', 'were')} withheld below the ` +
              `${String(minConfidence ?? AGENT_FLOOR)} floor. The floor measures how many of ` +
              'your literal words a thread repeats, not whether the archive holds the answer, ' +
              'so a question phrased differently from the transcript scores none over an index ' +
              'that has it. Call again with minConfidence: "none" to see those rows — they are ' +
              'the closest text, not an answer, and may not be cited as one — or with two to ' +
              'four distinctive nouns instead of a sentence'
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
          // What was always right, kept and kept last, because it is the
          // instruction the caller has to leave holding: an empty reply is
          // never a licence to answer from the repo.
          '. Do not widen into a guess, and do not answer from the repository in front of you' +
          (belowFloor ? '.' : '. Saying the archive does not have this is a real answer.')
        : noMatch
          ? // C-1 step 3. Rows below the floor, because the caller asked for
            // them. `noMatch` is still true and still means what it means, so
            // the one thing this note must do is stop the caller reading the
            // rows as the answer the envelope has just said it does not have.
            `these ${String(sessions.length)} ${format.plural(sessions.length, 'row')} are ` +
            'below the confidence floor and are labelled none: they are the closest text in ' +
            'the archive to your words, not an answer to your question. Read them to judge ' +
            'for yourself, do not cite them as a source, and do not report them to the user ' +
            'as what was decided.'
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
      // FIX-I C-1: labelled, and not re-ordered. `result.hits` arrives from
      // core in `byLabel` order, `map` preserves it, and `evidence` is a
      // rendering of the same `kind` the core comparator's first key reads —
      // so the label and the order come out of one function.
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
    // Computed once: four fields below read it, and it walks every hit.
    const evidence = threadEvidence(members);
    // F6's permission, read off the lead block rather than re-derived — FIX-I
    // C-2. The lead is the thread's best member by the ordering below, and
    // `summaryRank` is that ordering's first key, so a thread whose lead is
    // summary-only has no member that is not: `lead.citable` and this thread's
    // own `evidence` cannot disagree. `=== true` for the reason
    // `packages/cli/src/commands/find.ts` gives: a permission that is absent is
    // withheld.
    const citable = lead.citable === true;
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
      evidence,
      // FIX-I C-2. This was the same two conditions spelled out again, and it
      // was the copy that was right while `find --json`'s copy was wrong. Both
      // doors now read the field core publishes (`citableBlock` in
      // `packages/core/src/recall.ts`), so there is one predicate and not two
      // that agree. `citation` is minted off the same boolean rather than off
      // a second spelling of the condition, so a thread cannot be uncitable
      // and carry a citation.
      citable,
      citation: citable
        ? mintCitation({
            sessionId: key,
            kind: lead.kind,
            harness: lead.harness,
            project: lead.projectName,
            exchanges,
            prompts,
            date: (ended ?? started)?.slice(0, 10) ?? null,
          })
        : null,
      // Why there is no citation, in the words the human view uses for the
      // same row. A `null` field an agent cannot explain is a field it works
      // around; this one says what would have to happen for a citation to
      // exist, and `potsherd_read` is a tool it actually has.
      ...(evidence === 'not-a-transcript'
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

/**
 * C5a's rule, and where it went — FIX-I C-1.
 *
 * FIX-D added `orderByLabel` here, with `CONFIDENCE_RANK`, `evidenceRank`,
 * `calibrationScoreOf` and `scoreOf` beside it, because the third verifier
 * caught `hit0 score 0.016393 conf weak` sitting **above** `hit1 score
 * 0.016393 conf strong` at this door. The rule was right and it was in the
 * wrong package: `packages/cli/src/commands/find.ts` reads the same core rows
 * through a different projection and never imported it, so `find --json`'s
 * `sessions[0]` went on being whatever RRF's merge order put there. Two
 * implementations, one of them updated, is the whole of the family this fix
 * belongs to.
 *
 * The rule is now `byLabel` in `packages/core/src/recall.ts`, applied by
 * `recall()` to `sessions` and to `hits`, under the `summaryRank` partition
 * that FIX-F C3 put in front of it. Every reason FIX-D gave for it survives
 * verbatim in that docstring — in particular that the first key is the
 * confidence **word** and not `calibration.score`, because a routing row's
 * score is deliberately not rewritten when `ROUTING_CEILING` caps its label.
 *
 * What is left at this door is the labelling, and nothing that re-orders. The
 * fences moved with the rule: `tests/mcp.test.ts` asserts that the reply's
 * `threads[]` and `hits[]` come out monotone in (`evidence`, `confidence`,
 * `calibration.score`) — a property of what the agent is handed rather than of
 * a helper this file could stop calling — and `tests/recall.test.ts` pins the
 * comparator itself. A test that fails when the two doors drift is the
 * standing requirement; the two doors now have one comparator to drift from.
 */
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
      if (evidenceOf(h.kind) === 'not-a-transcript') continue;
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
