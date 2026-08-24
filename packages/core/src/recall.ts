import type { Db } from './db.js';
import type { Harness, SessionStatus } from './adapters/types.js';
import {
  buildExchangeFilters,
  buildGhostFilters,
  buildSessionFilters,
  knnCandidates,
  validateISODate,
  type SearchFilters,
} from './search/filters.js';
import { RRF_K, rrfScore, l2DistanceToCosineSimilarity } from './search/similarity.js';
import {
  denseSnippet,
  isMostlyBoilerplate,
  matchSnippet,
  wordMatchesToken,
  wordSpans,
  type MatchSnippet,
} from './search/snippet.js';
import {
  KEYPHRASE_RULE,
  NO_KEYPHRASE,
  keyphrase as extractKeyphrase,
  type Keyphrase,
} from './keyphrase.js';
import { vecStatus, vecTablesExist } from './vec.js';
import { holder as lockHolder } from './lock.js';
import {
  EMBEDDING_VERSION,
  embeddingToBlob,
  generateQueryEmbedding,
  isModelCached,
} from './embeddings.js';
import { modelsDir, potsherdDir } from './paths.js';
import { applyIgnore, countIgnoredSessions, type IgnoreReport } from './ignore.js';
import {
  atLeastConfident,
  KEY_TERMS_REQUIRED,
  ROUTING_CEILING,
  calibrate,
  coveredTerms,
  maxConfidence,
  relativeStrength,
  type Calibrated,
  type Confidence,
} from './calibration.js';

/**
 * L6 — recall.
 *
 * `03` §7: `find(query, filters)` = rrf( bm25(exchanges_fts), bm25(cards_fts),
 * bm25(ghosts_fts), vec(exchanges), vec(cards) ), k=60, with session
 * diversification (max 3 exchanges per session in the top list).
 *
 * All of them are fused here from T2.2 on. The two `cards` lists were named in
 * {@link LISTS} and switched off through phase 1 rather than faked, because a
 * list with no rows behind it is not a list — it is a way to make a fusion look
 * richer than it is. `potsherd card` fills them, and they still leave the set
 * at query time on an index that has never run it.
 *
 * **Nothing here is upstream's.** obra/episodic-memory has no fts5 and no bm25
 * — its text search is `LIKE '%q%'` (`src/search.ts:180-190`) — so there was no
 * hybrid to port. What is inherited is the arithmetic underneath: the
 * distance→similarity identity, the injection-safe filter builder and the
 * snippet shaping, all in `search/`.
 *
 * ## Three properties this module is built around
 *
 * 1. **Vectors are optional.** With `--no-embed`, with sqlite-vec unavailable,
 *    or on a machine where the 34 MB model was never fetched, recall degrades
 *    to bm25 alone and *says so* in {@link RecallResult.vectors}. It never
 *    throws, and it never silently returns a worse answer without a reason the
 *    caller can print.
 * 2. **Sidechains and ghosts are in by default.** They are the reason potsherd
 *    exists: 197 subagent transcripts and 299 deleted sessions on the reference
 *    machine that every other tool hides. `filters.sidechains` and
 *    `filters.ghosts` both default to `include`.
 * 3. **The fusion is rank-based, so the lists never need a common scale.** bm25
 *    returns a negative log-odds-ish number, cosine returns [-1, 1]; RRF only
 *    reads their *order*, which is the entire reason it is the right fusion for
 *    a hybrid with no training data to calibrate on.
 */

// ------------------------------------------------------------------- shapes

export type ListName =
  | 'titles'
  | 'exchanges_fts'
  | 'ghosts_fts'
  | 'ghost_prompts_fts'
  | 'vec_exchanges'
  | 'vec_ghost_prompts'
  | 'cards_fts'
  | 'vec_cards';

/**
 * The five-then-seven lists of `03` §7.
 *
 * `cards_fts` and `vec_cards` were named here through phase 1 and switched
 * off, because a list with no rows is not a list — it is a way to make a
 * fusion look richer than it is. T2.2 fills them, so they are on. Both still
 * disappear from the set at query time when the table is missing or empty,
 * which is what makes `find` work on an index that has never seen a model.
 */
export const LISTS: readonly ListName[] = [
  'titles',
  'exchanges_fts',
  'cards_fts',
  'ghosts_fts',
  'ghost_prompts_fts',
  'vec_exchanges',
  'vec_ghost_prompts',
  'vec_cards',
];

/**
 * The two lanes of `03` §7 as F6 restates them: **cards are routing, never
 * evidence.**
 *
 * ## The measurement
 *
 * For the query *"where did we leave off on <project> what is left to build"*,
 * three of the top five hits were card-only matches on sessions belonging to
 * other projects, and they outranked every real transcript for the project the
 * question named. A generated summary beat primary evidence. `find` even
 * printed an honest note when it happened — *"the session card matched; the
 * transcript does not use those words"* — which is the right instinct wired to
 * the wrong ranking.
 *
 * ## Why this is a partition and not a weight
 *
 * The tempting fix is to drop {@link WEIGHTS}.cards_fts until cards stop
 * winning. That is a fix that holds for one corpus. RRF's contribution is
 * `weight / (k + rank)`, so whether a card at rank 1 beats a transcript hit at
 * rank 3 is arithmetic about *this* query on *this* index: change the corpus,
 * the query length, the relax state or `k`, and a weight that behaved
 * yesterday stops behaving. And the audit's complaint was never that cards
 * scored slightly too high. It was that a card can be read as evidence at all:
 *
 * > If a card can be cited as evidence, you have rebuilt the hallucination
 * > problem inside the tool that exists to prevent it.
 *
 * So the ordering is **partitioned**, not re-weighted. {@link LANES} is the
 * first term of every comparator that decides what a caller sees, and the
 * fused score is consulted only *within* a lane. No assignment of
 * {@link WEIGHTS} can invert it, because no value of any weight ever reaches
 * the comparison: `LANES[a.lane] - LANES[b.lane]` is evaluated first and, when
 * the lanes differ, alone. That is what makes "a card-only hit never outranks
 * a transcript hit" a property of the ranking rather than a number that
 * happens to come out right.
 *
 * ## And cards are still on
 *
 * Demoted, not silenced. Cards are the one list that can find a conversation
 * whose transcript never uses the words the user typed, which is exactly the
 * routing job Bet 02 was restated to keep. A card-only block still appears; it
 * appears **after** everything with transcript evidence behind it, labelled,
 * capped at {@link ROUTING_CEILING}, and never citable in a `SOURCES` block.
 * `--no-cards` turns the two lists off for the caller who wants transcripts or
 * nothing.
 */
export type Lane = 'evidence' | 'routing';

/**
 * The lane order, and the constant this whole task reduces to.
 *
 * Lower sorts first. It is a `Record`, not a boolean, so that the ordering
 * rule is a *value* the tests can read and pin rather than a comparison
 * spelled out inside a sort callback where nothing can see it.
 * `tests/cards-lane.test.ts` fails in both directions when it moves
 * (`plans/08` rule 3): it asserts the pair, and it asserts the ordering the
 * pair produces — set `routing` to 0 and the comparator collapses to
 * score-only, which is the v1.1.0 behaviour the ordering test reproduces and
 * refuses.
 */
export const LANES: Readonly<Record<Lane, number>> = { evidence: 0, routing: 1 };

/**
 * Hit kinds that are a *statement about* a conversation rather than text *from*
 * one.
 *
 * Only `card` today. `title` is deliberately not here: a title is not evidence
 * either, but it is not the artefact of a model call over the transcript, it
 * has never been citable, and widening this set would be re-litigating a
 * different finding under F6's name. See `T10.7-REPORT.md` for the one
 * laundering path that observation leaves open.
 */
export const ROUTING_KINDS: ReadonlySet<RecallHit['kind']> = new Set(['card']);

/**
 * Hit kinds whose text is a **summary of a conversation**, not a line from one.
 *
 * FIX-F C3, and it is deliberately a *different* set from {@link ROUTING_KINDS}
 * rather than a widening of it.
 *
 * ## why not just add `title` to ROUTING_KINDS
 *
 * That set is the **lane**, and the lane governs six things, all of which were
 * measured for cards and none of which was measured for titles:
 *
 *  1. `laneOfHit` / `laneOfSession` → the published `lane` field, on every hit
 *     and every block, at `find --json` and at `potsherd_recall`.
 *  2. {@link byLane}, the comparator that orders blocks and hits.
 *  3. The two-pass budget in `recall()`: evidence hits take {@link PER_SESSION}
 *     (3) slots, routing hits take {@link ROUTING_PER_SESSION} (1) — a **shared**
 *     one, so a session with both a card and a title hit would show only one of
 *     them, and which one would be decided by fused rank.
 *  4. {@link CARDS_SCORE_EVIDENCE_BLOCKS} and `counted`: what feeds a block's
 *     coverage. A title is *already* folded into every evidence block's
 *     calibration text by name (`m.displayTitle`), so moving the title *hit*
 *     into the routing lane would not remove the title from the calculation —
 *     it would only make the two disagree.
 *  5. The separate build budget (`limit` routing blocks vs `limit * 3`).
 *  6. `--no-cards`, which drops `cards_fts` and `vec_cards` and would **not**
 *     drop the `titles` list — so `lane: 'routing'` rows would keep appearing
 *     on a search that had asked for transcripts only.
 *
 * `tests/cards-lane.test.ts` pins `laneOfHit('title') === 'evidence'` in both
 * directions. So the lane is left exactly where T10.7 put it, and the *other*
 * property — is this row a model's summary or a person's and a model's actual
 * words — is named here, separately, and used for the three things C3 is
 * about: the confidence cap, the ordering against transcript evidence, and
 * citability at the model door.
 *
 * ## why `title` is in it
 *
 * `T10.7-REPORT.md §5` scoped titles out on the grounds that "a title … has
 * never been citable". That is not true of this build: `groupThreads` at
 * `packages/mcp/src/tools/recall.ts` mints a citation for every thread whose
 * lane is `evidence`, and a title-only thread's lane is `evidence`. And a
 * Claude Code title is not a filename: it is an `ai-title` record, a model's
 * six words written mid-session, of which `doctor` counts eighty in the
 * reference archive. A search that matches one has matched a **summary**, and
 * F6 is one sentence — *a generated summary beat primary evidence.*
 */
export const SUMMARY_KINDS: ReadonlySet<RecallHit['kind']> = new Set(['card', 'title']);

/** Whether this hit's text is a summary of a conversation rather than from one. */
export function isSummaryHit(kind: RecallHit['kind']): boolean {
  return SUMMARY_KINDS.has(kind);
}

/**
 * Whether anything in this set of hits is actual transcript text.
 *
 * The question `citable` should always have been asking, and the question the
 * ordering asks first: a block with one exchange hit and one title hit has
 * something a reader can quote, and a block with two title hits has not.
 */
export function hasTranscriptEvidence(hits: readonly { kind: RecallHit['kind'] }[]): boolean {
  return hits.some((h) => !isSummaryHit(h.kind));
}

/**
 * How many routing hits one conversation may put on the page.
 *
 * One. A card is one row per session by construction (`cards.session_id` is
 * unique), so this only binds when a conversation's parent and one of its
 * subagents are both carded — and two summaries of the same conversation are
 * not two pieces of evidence about anything.
 */
export const ROUTING_PER_SESSION = 1;

/**
 * Whether a card may contribute to the **rank** of a block that already has
 * transcript evidence of its own.
 *
 * `true`, and it was measured rather than assumed. The stricter reading of
 * "cards are routing, never evidence" says a card should add nothing to any
 * ordering anywhere; T10.7 built that, ran `pnpm evals`, and it cost four
 * points of recall@5 (hybrid 22/25 -> 18/25) with seven queries losing their
 * answer, including two whose answer session is a real transcript the card was
 * merely *pointing at*. With this `true` the same eval is 22/25 and 10/25 —
 * identical to the fusion before the lane existed, with the bm25 half a point
 * better.
 *
 * The line the numbers drew is the same one Bet 02 draws in words. A card that
 * lifts a conversation the transcript lists also found is **routing working**:
 * the reader gets transcript text, and the summary only decided which thread
 * to open. A card that puts a conversation on the page *by itself* is a
 * summary being read as evidence, and that is the case {@link LANES} refuses
 * outright.
 *
 * What is switched off regardless of this constant, because it is the case an
 * agent acts on: a card contributes nothing to a block's **coverage** or its
 * **confidence**. Rank is a suggestion; `strong` is a licence to stop reading.
 *
 * `tests/cards-lane.test.ts` pins both halves.
 */
export const CARDS_SCORE_EVIDENCE_BLOCKS = true;

/** Which lane a hit belongs to. */
export function laneOfHit(kind: RecallHit['kind']): Lane {
  return ROUTING_KINDS.has(kind) ? 'routing' : 'evidence';
}

/**
 * Which lane a *block* belongs to: `routing` when nothing in it is transcript
 * text.
 *
 * The block is the unit `find` prints and `--json` iterates, so the block is
 * where the demotion has to bite. A conversation with one exchange hit and one
 * card hit is an evidence block — it has something quotable — and its card
 * still contributes nothing to its rank or its coverage; see `recall()`.
 */
export function laneOfSession(hits: readonly { kind: RecallHit['kind'] }[]): Lane {
  return hits.some((h) => laneOfHit(h.kind) === 'evidence') ? 'evidence' : 'routing';
}

/**
 * 0 when these hits include transcript text, 1 when they are all summary.
 *
 * The first term of both comparators below — FIX-F C3. It is a function of the
 * hits' `kind` alone, so it cannot be inverted by a weight, a corpus or a
 * score, which is what makes "a summary never outranks a transcript" a property
 * of the ranking rather than an arithmetic that happens to come out right.
 */
export function summaryRank(hits: readonly { kind: RecallHit['kind'] }[]): 0 | 1 {
  return hasTranscriptEvidence(hits) ? 0 : 1;
}

/** Evidence before routing, then the fused score. The comparator, once. */
export function byLane<T extends { lane?: Lane; score: number }>(a: T, b: T): number {
  return (LANES[a.lane ?? 'evidence'] - LANES[b.lane ?? 'evidence']) || b.score - a.score;
}

/** The three words, best first. Not a `Confidence`-keyed lookup by accident: a
 * `Record` is a value a test can read, the way {@link LANES} is. */
const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { strong: 0, weak: 1, none: 2 };

/**
 * The label's own order — FIX-D's C5a rule, moved here so there is one of it.
 *
 * ## the defect this closes
 *
 * FIX-D wrote this rule at `packages/mcp/src/tools/recall.ts` as
 * `orderByLabel`, because that was the door the third verifier was reading.
 * `find` never got it: {@link byLane} is *lane, then the fused RRF score*, so
 * the confidence word was never a sort key on the CLI path and
 * `find --json`'s `sessions[0]` — the row every `jq -r '.sessions[0].resume'`
 * example in `find --help` takes — could be the weakest row on the page. The
 * fifth verifier measured it on the real archive at ★★★★★, and on the
 * synthetic demo corpus `untangle token refresh` put a row calibrating 0.546
 * first on a page whose best row calibrates 0.567.
 *
 * So the rule lives in core, where both doors already read their rows from,
 * and the model door no longer keeps a copy of it. That is the whole shape of
 * the fix: not two comparators that agree today, one comparator.
 *
 * ## the keys, and why the first one is a word
 *
 * `summaryRank` is applied by the callers, ahead of this, and stays there
 * (FIX-F C3): a summary never outranks a transcript, whatever it scores. Under
 * it:
 *
 *   1. `confidence` — **the word, not the number**, and this is FIX-D's
 *      load-bearing reasoning rather than a stylistic choice. A row's
 *      `calibration.score` is deliberately *not* rewritten when
 *      {@link ROUTING_CEILING} caps its label, so a routing row scoring 0.9 is
 *      labelled `weak` and sorting on the number alone would put a card back
 *      on top of a `strong` transcript. Sorting on the word cannot: the cap is
 *      in the word.
 *   2. `calibration.score`, within a band — the number that carries the
 *      meaning, once the cap has been respected.
 *   3. {@link byLane}: the lane, then the fused score, which is the merge
 *      order and the last thing left to say when both axes are silent.
 *
 * ## what it does not do
 *
 * **Nothing is rescored and no row is added or dropped.** This reads the
 * `confidence` and `calibration.score` `recall()` has already computed and
 * moves rows; the floor, `belowFloor` and the `noMatch` cliff are untouched,
 * and `pnpm evals` is the check on that (`FIX-I-REPORT §3`).
 *
 * A row whose build carries no confidence word compares equal on that key
 * rather than being ranked as `none`, for {@link byLane}'s reason: absent is
 * not a measurement.
 */
export function byLabel<
  T extends { confidence?: Confidence; calibration?: { score?: number } | null; lane?: Lane; score: number },
>(a: T, b: T): number {
  const wa = a.confidence, wb = b.confidence;
  const word = wa && wb ? CONFIDENCE_RANK[wa] - CONFIDENCE_RANK[wb] : 0;
  return word || (b.calibration?.score ?? 0) - (a.calibration?.score ?? 0) || byLane(a, b);
}

/**
 * Whether a block may be quoted as evidence — F6, decided once.
 *
 * The predicate was spelled twice: `packages/cli/src/commands/find.ts` asked
 * only `lane === 'evidence'`, and `packages/mcp/src/tools/recall.ts` asked that
 * **and** whether the block had any transcript behind it. `title` is in
 * {@link SUMMARY_KINDS} and deliberately not in {@link ROUTING_KINDS}, so
 * `laneOfHit('title')` is `evidence` and the CLI's half of the test could never
 * return false for a title-only block: one index, one query, one thread, and
 * `find --json` said an agent may quote a model-written session title while
 * `potsherd_recall` said it may not.
 *
 * So it is computed here, published on the row as {@link RecallSession.citable},
 * and both doors read the field instead of deriving it. The two conditions are
 * both necessary and they are asking different questions — *is this block a
 * routing aid* (the lane) and *is there anything in it a reader could quote*
 * (the kinds) — which is why {@link laneOfSession} alone was never enough.
 */
export function citableBlock(hits: readonly { kind: RecallHit['kind'] }[], lane?: Lane): boolean {
  return (lane ?? laneOfSession(hits)) === 'evidence' && hasTranscriptEvidence(hits);
}

export interface RecallHit {
  /**
   * `exchange` has both sides; `ghost` has the prompt side only; `title` is the
   * session's own name matching, which has no body text behind it; `card` is
   * the verified summary of a whole session (`03` §6), which has no single
   * exchange behind it either but does have text worth quoting.
   */
  kind: 'exchange' | 'ghost' | 'title' | 'card';
  sessionId: string;
  /** `exchanges.id`, or `ghost_prompts.id`. Absent for a `ghosts_fts` hit. */
  id?: string;
  seq?: number;
  ts?: string | null;
  /** The text the snippet was cut from. */
  userText: string;
  assistantText?: string;
  snippet: MatchSnippet;
  isSidechain: boolean;
  /** Fused score. Bigger is better; RRF scores are small (~0.016 at rank 1). */
  score: number;
  /**
   * Which lists put this row where, for `--json` and for debugging recall.
   *
   * `contribution` is what that list actually added to {@link score}:
   * `effectiveWeight(list) * 1/(k + rank)`. It is recorded rather than
   * recomputed because `--explain` used to *solve* for it from the totals,
   * which meant the debugger's arithmetic and the ranker's arithmetic were two
   * separate implementations that could disagree — and did, whenever a list
   * relaxed.
   */
  from: { list: ListName; rank: number; raw: number; contribution: number }[];
  /**
   * F1 — the second axis, and **not** {@link score} rescaled.
   *
   * `score` is reciprocal rank fusion: a function of rank alone, which is why
   * a true topic and a topic the archive has never heard of come out 1.12x
   * apart. `calibration` is computed from the evidence RRF discards —
   * `from[].raw`, how many of the query's distinctive words this row can
   * actually show, and how many lists independently found it. See
   * `calibration.ts` for the arithmetic and for why coverage is a ceiling.
   */
  calibration: Calibrated;
  /** {@link Calibrated.confidence}, lifted for callers that only want the word. */
  confidence: Confidence;
  /**
   * F6 — `routing` for a card, `evidence` for anything cut from a transcript.
   *
   * A machine-readable label, not prose: `--json` carries it on every hit and
   * `packages/mcp` filters on it, so no caller has to parse the sentence the
   * human view prints to find out that what it is looking at is a summary.
   *
   * **Optional in the type, always set by {@link recall}.** `browse.ts`
   * derives `BrowseSession` from `RecallSession` with its own `Omit`, and that
   * file is another worker's this phase; a required field here would not
   * compile there. `T10.7-REPORT.md` carries the two-line change that makes it
   * required.
   */
  lane?: Lane;
}

export interface RecallSession {
  id: string;
  kind: 'session' | 'ghost';
  harness: Harness;
  title: string | null;
  /** `title`, or `<slug>-<id8>` when the harness never wrote one. */
  displayTitle: string;
  project: string | null;
  /** Last path segment of `project` — what a table column can hold. */
  projectName: string;
  startedAt: string | null;
  endedAt: string | null;
  status: SessionStatus;
  isSidechain: boolean;
  parentSessionId: string | null;
  agentName: string | null;
  gitBranch: string | null;
  pinned: boolean;
  /** User prompts (a session) or recovered prompts (a ghost). */
  prompts: number;
  exchanges: number;
  /** Subagent transcripts that name this session as their parent. */
  subagents: number;
  bytes: number;
  /** `claude --resume <id>` / `codex resume <id>`, or null when not resumable. */
  resume: string | null;
  score: number;
  /**
   * The block's own confidence, over the union of its hits **and its title**.
   *
   * Measured on the block rather than on any one hit because the block is what
   * `find` prints and what a `--json` consumer iterates: a conversation that
   * says "privacy" in one exchange and "redaction" in another has covered both
   * words, and a per-hit-only reading would call it half an answer twice.
   */
  calibration: Calibrated;
  confidence: Confidence;
  /**
   * F6 — `routing` when **nothing** in this block is transcript text: the only
   * thing that matched was a card, which is the artefact of a model call and
   * not something the user or the assistant ever said.
   *
   * A routing block is still returned — a card is often the only list that can
   * find a conversation whose words differ from the query's, and that is the
   * job Bet 02 was restated to keep — but it sorts after every evidence block
   * whatever the scores are, it is labelled on screen and in `--json`, its
   * confidence is capped at {@link ROUTING_CEILING}, and it is not citable.
   *
   * Optional for the same compilation reason as {@link RecallHit.lane}, and
   * set on every block {@link recall} returns.
   */
  lane?: Lane;
  /**
   * F6, as a published permission rather than a rule each door re-derives —
   * {@link citableBlock}.
   *
   * `true` when this block is in the evidence lane **and** something in it is
   * transcript text a reader could quote. A title-only block is `false`: a
   * Claude Code title is an `ai-title` record, six words a model wrote
   * mid-session, and an agent told it may quote one as evidence is being told
   * it may cite a summary — the audit's F6, in a machine-readable field.
   *
   * Optional for the same compilation reason as {@link lane}, and set on every
   * block {@link recall} returns.
   */
  citable?: boolean;
  hits: RecallHit[];
}

export interface VectorState {
  /** True when the vec list actually contributed to this result. */
  used: boolean;
  available: boolean;
  /** One line, printable, when `used` is false. */
  reason?: string;
  vectors?: number;
  /**
   * Whether an embedding worker is alive and holding the embed lane — FIX-F C2.
   *
   * The same fact `VectorReport.working` carries, read from the same file by
   * the same function ({@link lockHolder}), and published here because this
   * object is what `potsherd_recall` puts on the envelope: an agent told
   * `no embeddings in the index yet` has no way, otherwise, to tell *yet* from
   * *never*. `undefined` when there was no root to ask about.
   */
  working?: boolean;
}

export interface RecallResult {
  query: string;
  sessions: RecallSession[];
  /** Every hit that survived diversification, best first. */
  hits: RecallHit[];
  vectors: VectorState;
  lists: { list: ListName; candidates: number; ms: number }[];
  /**
   * The fusion's own parameters, reported rather than reconstructed, because
   * `find --explain` has to be able to say *why* a hit scored what it scored.
   *
   * `k` is RRF's constant; `weights` is what each list was **actually** worth
   * on this query, after title-coverage scaling and {@link RELAXED_PENALTY} —
   * not the static table; `relaxedLists` names the lists that had to fall back
   * to any-word matching and therefore took that penalty.
   */
  k: number;
  weights: Partial<Record<ListName, number>>;
  relaxedLists: ListName[];
  /** True when the exact-AND pass found too little and the OR pass was run. */
  relaxed: boolean;
  /** True when the search was restricted to ghosts (`--ghosts only`). */
  ghostsOnly: boolean;
  /**
   * Ghosts in the index, counted **only** when the search came back empty —
   * `null` otherwise, because a result with hits in it never needs to explain
   * itself and the count would be a query for nothing.
   *
   * An empty `find --ghosts only` on a directory that was indexed but never
   * rescued is the one silence potsherd cannot afford: `index` does not build
   * ghosts, `rescue` does, and "no results" reads as "you have no deleted
   * sessions" — the exact belief the tool exists to correct.
   */
  indexedGhosts: number | null;
  /**
   * The ignore list, and what it removed from this search.
   *
   * `hidden` counts the **sessions** the list took out of the candidate set,
   * measured by running the same shortlist without the exclusion. `find` puts
   * it on screen and `--json` carries it, because "nothing matches pgbouncer"
   * and "nothing matches pgbouncer outside the projects you ignore" are
   * different answers and only one of them is true.
   *
   * `ask` shortlists through this function, so an ignored project is out of
   * the readers' reach as well as off the `find` screen — one list, one
   * behaviour, whichever verb asked.
   */
  ignored: IgnoreReport;
  /**
   * The best confidence on the page, and `none` when the page is empty.
   *
   * The envelope and every row carry the same vocabulary and the same values,
   * in the human view and in `--json` alike, because an agent that has to
   * reconcile two spellings of "did you find it" will trust neither.
   */
  confidence: Confidence;
  /** The floor this call was run at. See {@link RecallOptions.minConfidence}. */
  minConfidence: Confidence;
  /**
   * Session blocks that matched and were then withheld for scoring below
   * {@link minConfidence}.
   *
   * `find` prints it on the `no match` screen, because "nothing in the index
   * matches" and "six things matched and none of them well enough" are
   * different facts and only one of them is true. Counted over the blocks that
   * were built, which is at most `limit * 3`.
   */
  belowFloor: number;
  /**
   * F8 — the distinctive words this query was narrowed to, and every content
   * word it had. Empty `terms` means no narrowing happened: the query was
   * already distinctive, or none of its words is in the index.
   *
   * Reported for the same reason `weights` and `relaxedLists` are: a ranking
   * that silently searched for a *subset* of what the user typed owes the
   * caller the subset.
   */
  keyphrase: Keyphrase;
  /**
   * The lists that were answered by the keyphrase pass rather than by the
   * query as typed. A subset of {@link relaxedLists}, because narrowing to the
   * distinctive words *is* a relaxation of the exact-AND pass and takes the
   * same {@link RELAXED_PENALTY}.
   */
  keyphraseLists: ListName[];
  ms: number;
}

export interface RecallOptions {
  /** Sessions to return. Default 10. */
  limit?: number;
  /** RRF's k. `03` §7 fixes it at 60; the knob exists for the evals. */
  k?: number;
  /** Which lists to fuse. Default {@link LISTS}, minus whatever is unavailable. */
  lists?: readonly ListName[];
  /** Session diversification: exchange hits kept per session. Default 3. */
  perSession?: number;
  /** Candidate depth per list. Default `max(limit * 10, 60)`. */
  candidates?: number;
  /**
   * Per-list weight overrides, merged over {@link WEIGHTS}. `03` §7 asks for
   * configurable weights; this is the knob, and it is what the eval sweeps.
   */
  weights?: Partial<Record<ListName, number>>;
  /**
   * How much a session's *second and later* hits can add, as a fraction of its
   * best hit. Default {@link CORROBORATION}.
   */
  corroboration?: number;
  /**
   * The vector half of the hybrid.
   *
   *   `true`   — always run it.
   *   `false`  — never (`--no-vec`, and what `--no-embed` leaves you with).
   *   `'auto'` — the default: run it only when the words did not already
   *              settle the question.
   *
   * `'auto'` exists because the two halves have costs three orders of
   * magnitude apart. bm25 over `exchanges_fts` is a single index seek —
   * sub-millisecond, and the reason `03` §12 can ask for a p50 under 150 ms
   * end to end. The vector half needs a forward pass through bge-small to
   * embed the query, which is ~350 ms on the reference machine and dominates
   * everything else the verb does.
   *
   * And it buys nothing when the text index already returned a full page of
   * exact matches: RRF would reorder results the user is about to be happy
   * with. Where it earns its cost is exactly where bm25 struggles — a query
   * whose words are not the words in the transcript, which is precisely the
   * case `recall` detects when the AND pass comes back thin and has to relax.
   * So: run the cheap list first, and pay for the expensive one only when the
   * cheap one asked for help.
   */
  vectors?: boolean | 'auto';
  /** potsherd root, so the embedding model is found under `--potsherd-dir`. */
  root?: string;
  /** `--all`: search the projects the ignore list hides. */
  all?: boolean;
  /** The ignore list, instead of reading it. Tests, and cached callers. */
  ignore?: readonly string[];
  /**
   * The confidence floor: blocks scoring below it are withheld.
   *
   * **The default is `none`, which withholds nothing**, and that is deliberate
   * rather than timid. `recall()` is the shortlist builder for `ask` and for
   * `graft` as well as the engine behind `find`, and those two hand their rows
   * to a *reader* — a model that opens the transcript and can see for itself
   * that a row is noise. `find` hands its rows to whoever typed the query, and
   * for an agent an unlabelled least-bad row is indistinguishable from an
   * answer, so `find` sets the floor to `weak`. One number, set by the caller
   * who knows who is reading.
   *
   * Every row is labelled at every floor. Only whether they are *returned*
   * changes.
   */
  minConfidence?: Confidence;
  /**
   * `--no-cards`: run the search over transcripts only.
   *
   * **Default true**, and that is the point of the whole finding rather than a
   * timid default. Cards are demoted, not switched off: a query whose words
   * exist only in a summary still has to find its thread, because routing is
   * the job cards are kept for. This flag is for the caller who has decided
   * that even a labelled, last-in-the-page summary is more than they want —
   * a script that wants transcript rows or nothing.
   *
   * It removes `cards_fts` and `vec_cards` from the fusion outright, which is
   * strictly stronger than the lane: with it on there is nothing in the
   * routing lane to demote.
   */
  cards?: boolean;
}

/** Max exchange hits from one session in the top list (`03` §7). */
export const PER_SESSION = 3;

/**
 * How much corroboration is worth, as a fraction of a session's best hit.
 *
 * **This number was the sidechain bug.** A subagent transcript is indexed as
 * its own session holding exactly *one* exchange, so it can never have a
 * second hit to corroborate the first — while a 120-exchange distractor
 * collects three automatically. At the old value (0.5) that handed every
 * multi-hit session a standing +50%, which is more than the whole gap between
 * rank 1 and rank 30 in an RRF list: on the eval corpus the subagent that was
 * the **nearest vector in the index** to "the thing quietly eating most of the
 * cloud bill" came back as session block #29, behind twenty-eight sessions
 * whose best evidence was worse than its own and whose only advantage was
 * having said something three times.
 *
 * At 0.12 the rule reads the way the docstring above always claimed it did:
 * the strongest single piece of evidence decides, and repetition breaks ties
 * *within* that — it can no longer overturn a strictly better match.
 *
 * The other case that motivated the cap — a long session repeating a query
 * word outranking the short session actually **named** after it — is
 * unaffected, because that one is fixed by the `titles` weight and not by
 * this. Both were measured on the reference corpus, whose sessions run to a
 * hundred and fifty exchanges. **Neither reproduces on the committed eval
 * corpus**, whose sessions are one to three exchanges each: at that size no
 * session has enough hits for corroboration to move an order, and re-scoring
 * every eval query at 0.12 and at 0.5 gives the identical ranking. So this
 * constant's evidence is a run over a corpus that is not in this repository,
 * cited by shape rather than by content (`scripts/check-privacy.py`), and the
 * thing that holds it in place here is `tests/recall.test.ts`, not the eval
 * set.
 */
export const CORROBORATION = 0.12;

/**
 * Per-list weight in the fusion. RRF's own formula has none — every list is
 * `1/(k+rank)` — and for lists of comparable trustworthiness that is right.
 *
 * The vector list is not comparable. A bm25 hit at rank 1 means *this
 * conversation contains the words you typed*; a cosine hit at rank 1 means
 * *this is the nearest of 1,406 points in a 384-dimensional space*, and on a
 * corpus this size the nearest point to almost any query is something. Equal
 * weights let one semantic near-miss outrank an exact quotation, which is what
 * it did on the reference corpus before this line existed.
 *
 * At 0.5 a top vector hit scores below a third-place bm25 hit: vectors add
 * sessions the words missed and break ties among the ones they found, and they
 * do not overturn a literal match. That is the job.
 */
/**
 * What a list's hits are worth once that list had to loosen the query.
 *
 * A hit found by the words as typed is stronger evidence than one found only
 * after falling back to any-word matching, and because the lists relax
 * independently the two kinds routinely appear side by side. On the reference
 * corpus, "canon printer driver" appears verbatim in a deleted session's
 * prompts and nowhere in any surviving transcript — so `ghost_prompts_fts`
 * answers exactly while `exchanges_fts` relaxes, and without this the relaxed
 * list's top three still outrank the exact one.
 */
const RELAXED_PENALTY = 0.6;



/**
 * What {@link titleMatches} returns: the ranked titles, and *how much of the
 * query* the best of them actually covered.
 *
 * The coverage is the correction T1.7b's eval set forced. `titles` is weighted
 * at 1.5 because a session named after what you asked is stronger evidence
 * than a paragraph mentioning it — but only when the title is named after what
 * you asked. `titleMatches` keeps whichever titles matched *best*, and when
 * nothing matches well "best" can be one common word out of six: on the new
 * eval set, `find "stop counting the same event twice in the rollup"` filled
 * the whole first page with sessions whose titles contain `twice`, and pushed
 * the untitled session containing `event`, `twice` **and** `rollup` to sixth.
 *
 * Multiplying the list's weight by the fraction of the query the best title
 * covered says the thing rank alone cannot: one word out of six is a hint
 * (0.25), five out of six is an answer (1.25). It costs nothing when the title
 * really is the answer, which is the case the weight was added for.
 */
interface TitleList {
  hits: RawHit[];
  /** Query words the best title matched, over query words asked for. */
  coverage: number;
}

export const WEIGHTS: Record<ListName, number> = {
  // A title is a statement about the *whole* session — Claude Code's own
  // `ai-title`, or codex's thread name. One paragraph out of four hundred
  // mentioning a word, and a session *named* after that word, are not the same
  // evidence, and rank alone cannot say so.
  //
  // Measurable on the committed eval corpus: `potsherd find "timezone drift"`
  // returns session `9a4e7c26`, "Timezone drift in the daily rollup", and
  // nothing else — `exchanges_fts` contributes zero, because that session's
  // body does not contain either word. The whole 0.0246 it scores is
  // `titles r1 title match x1.50`. Drop this weight to 1.0 and the answer is
  // still first; drop the list and there is no answer at all.
  //
  // Scaled by coverage at fusion time; see {@link TitleList}.
  titles: 1.5,
  // A card is a statement about the whole session, like a title, but unlike a
  // title it has been checked against the transcript (`cards/verify.ts`) and
  // carries the session's topics and decisions rather than six words a model
  // wrote before the session was over.
  //
  // **This number no longer decides whether a card can beat a transcript.**
  // It used to be the only thing that did, and F6 is the transcript of that
  // going wrong. Since T10.7 the two lanes are partitioned (see {@link Lane}):
  // a card-only block sorts after every block with transcript evidence at any
  // weight, and a card contributes nothing at all to the rank of a block that
  // *does* have transcript evidence. What this weight still decides is the
  // order of card-only blocks **among themselves** — which thread the routing
  // lane offers first — and nothing else. Left at 1.2 because changing it now
  // would move that ordering for no reason; it is not load-bearing for the
  // safety property, which is exactly the change T10.7 made.
  cards_fts: 1.2,
  exchanges_fts: 1,
  ghosts_fts: 1,
  ghost_prompts_fts: 1,
  vec_exchanges: 1.5,
  // The ghosts' half of the semantic list (schema 8). Same weight as the
  // exchange vectors, because it is the same model over the same kind of text
  // — a prompt someone typed — and the only difference is that the answer to
  // this one no longer exists. Weighting it lower would re-create by hand the
  // exact disadvantage the table was added to remove.
  vec_ghost_prompts: 1.5,
  // Card vectors are the semantic half of the same statement. Same weight as
  // the exchange vectors: rank-based fusion needs no common scale, but a list
  // that answers "about the same thing" still should not outvote one that
  // answers "says these words". Since T10.7 it, too, only orders the routing
  // lane internally — see `cards_fts` above.
  vec_cards: 1.5,
};

// -------------------------------------------------------------- fts5 syntax

export interface FtsQuery {
  tokens: string[];
  /** All tokens required. Precise, and the pass that runs first. */
  and: string;
  /** Any token, prefix-matched. The relaxation when AND found too little. */
  or: string;
}

/**
 * Turn a user's words into an fts5 MATCH expression.
 *
 * Every token is wrapped in double quotes, which in fts5 means "a literal
 * string, not syntax" — so `AND`, `NEAR/3`, `*`, `^`, `-` and an unbalanced
 * quote are all just words. That is the whole injection surface of MATCH, and
 * closing it here means no caller has to think about it. (The `"` inside a
 * token is doubled, fts5's own escape.)
 */
export function ftsQuery(query: string): FtsQuery {
  const tokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()).slice(0, 24);
  const quote = (t: string): string => `"${t.replace(/"/g, '""')}"`;
  // Stopwords are dropped from the OR pass only. In the AND pass "the" costs
  // nothing — every document that has the other four words probably has it
  // too. In the OR pass it is actively harmful: `"the"* OR "pod"` ranks a
  // ghost prompt that merely contains "there" alongside the one exchange that
  // is about the pod, and RRF cannot tell them apart because both are rank 1
  // in their own list. Measured on the eval set: this alone is the difference
  // between the kubernetes query landing at #7 and at #1.
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  const orTokens = meaningful.length > 0 ? meaningful : tokens;
  return {
    tokens,
    and: tokens.map(quote).join(' AND '),
    // Prefix matching, but only on tokens long enough for the extension to be
    // an inflection rather than a different word. `"driver"*` reaching
    // "drivers" is what a user means; `"canon"*` reaching `canonicalJson` is
    // not, and on the reference corpus that one match put a session about an
    // unrelated build system above the ghost that was actually about a Canon
    // printer. Six characters is where the extensions stop being surprising.
    or: orTokens.map((t) => (t.length >= PREFIX_MIN ? `${quote(t)}*` : quote(t))).join(' OR '),
  };
}

/**
 * The smallest closed-class list that does the job. Deliberately not a full
 * English stopword list: fts5's own tokenizer keeps everything, potsherd
 * searches technical prose where "not", "no" and "off" carry meaning, and a
 * long list would start eating words people search for on purpose.
 */
/** Shortest token the OR pass will prefix-match. See {@link ftsQuery}. */
const PREFIX_MIN = 6;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'is', 'it', 'this', 'that', 'be', 'was', 'are', 'as', 'by', 'we', 'i',
]);

/**
 * The longer list, used **only** to decide what a snippet quotes and
 * highlights — never to rank.
 *
 * {@link STOPWORDS} is deliberately short because potsherd searches technical
 * prose where "not", "no" and "off" carry meaning, and dropping them from the
 * *query* would lose real matches. Quoting is the opposite problem: a snippet
 * exists to show the reader why a session is on the screen, and `up`, `its`
 * and `about` never do. When every token in a query is on this list the
 * shorter one is used instead, so a query that really is all function words
 * still gets a highlight.
 *
 * Not filtered by length: `eu` and `k` are two characters and both are real
 * queries against this corpus.
 */
export const QUOTE_STOPWORDS: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  'about', 'after', 'again', 'all', 'also', 'any', 'because', 'been', 'before',
  'being', 'but', 'can', 'could', 'did', 'do', 'does', 'down', 'each', 'even',
  'ever', 'every', 'few', 'from', 'had', 'has', 'have', 'he', 'her', 'him',
  'his', 'how', 'if', 'into', 'its', 'just', 'may', 'me', 'might', 'more',
  'most', 'much', 'must', 'my', 'no', 'not', 'now', 'off', 'one', 'only',
  'other', 'our', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some',
  'still', 'such', 'than', 'them', 'their', 'then', 'there', 'these', 'they',
  'those', 'through', 'too', 'two', 'under', 'until', 'up', 'us', 'very',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will',
  'would', 'yet', 'you', 'your',
]);

// ------------------------------------------------------------------ helpers

/** The command that puts the user back inside that session, when there is one. */
export function resumeCommand(
  harness: Harness,
  id: string,
  status: SessionStatus = 'live',
  parentSessionId?: string | null,
): string | null {
  // An archived or ghost session has no transcript where the harness looks for
  // one, so its own resume command would fail. Printing it anyway would be the
  // worst kind of wrong: a command that looks like the fix and is not.
  if (status !== 'live') return null;
  // A subagent transcript is not resumable — `9c4d2f18-…:agent-a02db260…` is
  // potsherd's id for a file, not a session claude will reopen. What the user
  // actually wants is the conversation that spawned it, so that is what is
  // offered. This is the difference between a command that works and a
  // command that looks like it should.
  const target = parentSessionId || id;
  if (target.includes(':')) return null;
  switch (harness) {
    case 'claude':
      return `claude --resume ${target}`;
    case 'codex':
      return `codex resume ${target}`;
    default:
      // cursor and pi resume from their own UI, not from an id on a command
      // line. `potsherd show` is the honest next step there.
      return null;
  }
}

/** `/home/dev/infra-terraform` -> `infra-terraform`. */
export function projectName(project: string | null | undefined): string {
  if (!project) return '—';
  const parts = project.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? project;
}

/**
 * The eight characters of a session id that identify *this* session.
 *
 * Normally the first eight, which is what `--resume` and `potsherd show` take.
 * A claude subagent transcript is different: its id is
 * `<parent-uuid>:agent-<hash>`, so the first eight characters are the
 * *parent's* and every one of the 197 subagents on the reference machine would
 * be labelled identically. The distinguishing half is on the right, so that is
 * the half taken.
 */
export function idTag(id: string): string {
  const colon = id.lastIndexOf(':');
  if (colon === -1) return id.slice(0, 8);
  return id.slice(colon + 1).replace(/^agent-/, '').slice(0, 8);
}

/**
 * What `ls` shows for a session the harness never titled — sdk sessions, and
 * every codex thread before it is named. `03` §7 calls it `<slug>-<id8>`; the
 * slug used is the project's last segment rather than claude's own
 * `-Users-dev-event-bus` form, because the point is a name that fits a column.
 */
export function fallbackTitle(
  project: string | null | undefined,
  id: string,
  harness: Harness = 'claude',
): string {
  const slug = project ? projectName(project) : harness;
  return `${slug}-${idTag(id)}`;
}

export function displayTitleOf(
  title: string | null | undefined,
  project: string | null | undefined,
  id: string,
  harness: Harness = 'claude',
): string {
  const clean = title?.replace(/\s+/g, ' ').trim();
  return clean ? clean : fallbackTitle(project, id, harness);
}

/**
 * The snippet, and which half of the exchange to cut it from.
 *
 * An exchange is a prompt *and* an answer, and the words the user is now
 * searching for are as often in one as in the other. The first version always
 * cut from `user_text` and only looked at `assistant_text` when the prompt was
 * empty — which is how the T1.7 review got a top-three result whose entire
 * snippet was `[Image: source: /var/folders/…/clipboard-…]`: that *was* the
 * prompt. Someone pasted a screenshot, and the answer underneath — the part
 * that actually matched — was never considered.
 *
 * So both sides are scored, by how many distinct query words each contains
 * after machine boilerplate is discounted, and the winner is quoted. Ties go
 * to the prompt, because a person recognises their own question faster than
 * they recognise an answer they have forgotten.
 */
export function bestSnippet(
  userText: string,
  assistantText: string | undefined,
  query: string,
  tokens: readonly string[],
): MatchSnippet {
  const sides = [userText ?? '', assistantText ?? ''].filter((s) => s.trim().length > 0);
  if (sides.length === 0) return { text: '' };

  const exact = query.trim().toLowerCase();
  const scored = sides.map((text) => {
    const lower = text.toLowerCase();
    const distinct = new Set(
      wordSpans(text)
        .map((s) => tokens.find((t) => wordMatchesToken(s.word, t)))
        .filter((t): t is string => Boolean(t)),
    ).size;
    return {
      text,
      // The whole phrase, verbatim, beats any count of scattered words.
      phrase: exact.length > 0 && lower.includes(exact) ? 1 : 0,
      distinct,
      boilerplate: isMostlyBoilerplate(text) ? 1 : 0,
    };
  });
  scored.sort(
    (a, b) =>
      b.phrase - a.phrase ||
      b.distinct - a.distinct ||
      a.boilerplate - b.boilerplate ||
      sides.indexOf(a.text) - sides.indexOf(b.text),
  );
  const chosen = scored[0]!;
  if (chosen.phrase === 1 && chosen.distinct <= 1) return matchSnippet(chosen.text, query);
  return denseSnippet(chosen.text, tokens);
}

// -------------------------------------------------------------------- lists

interface RawHit {
  key: string;
  kind: 'exchange' | 'ghost' | 'title' | 'card';
  sessionId: string;
  id?: string;
  seq?: number;
  ts?: string | null;
  userText: string;
  assistantText?: string;
  isSidechain: boolean;
  raw: number;
}

/**
 * Whether a table has anything in it, without ever throwing.
 *
 * `vec_cards` is a vec0 virtual table and counting it on a connection that has
 * not loaded the extension raises "no such module"; an index written by an
 * older build may not have the table at all. Either way the answer a caller
 * wants is "no rows", not an exception in the middle of a search.
 */
function countRows(db: Db, name: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

function tableExists(db: Db, name: string): boolean {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?`)
      .get(name) as { n: number };
    return row.n > 0;
  } catch {
    return false;
  }
}

/**
 * The session's own title, matched by hand rather than by fts5.
 *
 * `03` §3 puts titles in `cards_fts`, which phase 2 fills. Until then
 * `sessions.title` — the string `ls` prints, the string the user just read and
 * is now typing back — is in **no** search index at all. On the reference
 * corpus that is worth three of ten queries: "session context search and
 * memory tool" is the exact title of the most recent session and bm25 over the
 * bodies did not return it in the top ten, because the body of a session about
 * search says "search" four hundred times and so does everything else.
 *
 * There are only a few hundred titles, so this needs no index: one `LIKE` per
 * token (bound, never concatenated), then ranked in JS by how many of the
 * query's words the title actually contains and how little else it says. It
 * joins the fusion as one more ranked list, which is exactly what RRF is for —
 * and when `cards_fts` arrives it becomes one more list beside this one rather
 * than a replacement for it.
 */
function titleMatches(
  db: Db,
  allTokens: string[],
  filters: SearchFilters,
  depth: number,
): TitleList {
  // Stopwords out: a title is a handful of words, so "the" matching is not
  // evidence of anything, and with the weight this list carries it would be
  // actively misleading.
  const meaningful = allTokens.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : allTokens;
  if (tokens.length === 0) return { hits: [], coverage: 0 };
  const likes = tokens.map(() => 'LOWER(s.title) LIKE ?').join(' OR ');
  const params = tokens.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const f = buildSessionFilters(filters);
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.title AS title, s.started_at AS ts, s.is_sidechain AS is_sidechain
         FROM sessions s
        WHERE s.title IS NOT NULL AND (${likes}) ${f.sql}
        LIMIT ?`,
    )
    .all(...params, ...f.params, depth * 2) as {
    id: string;
    title: string;
    ts: string | null;
    is_sidechain: number;
  }[];

  if (rows.length === 0) return { hits: [], coverage: 0 };
  const scored = rows.map((r) => {
    const lower = r.title.toLowerCase();
    const matched = tokens.filter((t) => lower.includes(t)).length;
    return { r, matched, len: r.title.length };
  });
  // Only the titles that match the query *best* stay. A list that also carried
  // every title sharing one word with the query would be mostly noise, and
  // noise weighted at 1.5 is worse than no list at all — the question this
  // list answers is "is a session named after what you asked", and a title
  // matching one word out of four is not an answer to it.
  const bestMatched = Math.max(...scored.map((x) => x.matched));
  const strongest = scored.filter((x) => x.matched === bestMatched);
  // Among equals, the title that says least else. Two titles that match the
  // same query words are not equally good answers if one of them is six words
  // long and the other is a sentence that happens to contain them: the short
  // one is *about* the thing, the long one mentions it on the way past. Length
  // is the only signal available at this point that separates them, and it is
  // a tie-break, not a ranking — everything here already matched equally well.
  strongest.sort((a, b) => a.len - b.len);
  return {
    coverage: bestMatched / tokens.length,
    hits: strongest.slice(0, depth).map(({ r }) => ({
      key: `t:${r.id}`,
      kind: 'title' as const,
      sessionId: r.id,
      ts: r.ts,
      userText: r.title,
      isSidechain: r.is_sidechain === 1,
      raw: 0,
    })),
  };
}

function bm25Exchanges(db: Db, match: string, filters: SearchFilters, depth: number): RawHit[] {
  const f = buildExchangeFilters(filters);
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.session_id AS session_id, e.seq AS seq, e.ts AS ts,
              e.user_text AS user_text, e.assistant_text AS assistant_text,
              e.is_sidechain AS is_sidechain,
              bm25(exchanges_fts, 2.0, 1.0) AS rank
         FROM exchanges_fts
         JOIN exchanges e ON e.rowid = exchanges_fts.rowid
         JOIN sessions  s ON s.id = e.session_id
        WHERE exchanges_fts MATCH ?
          ${f.sql}
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, ...f.params, depth) as {
    id: string;
    session_id: string;
    seq: number;
    ts: string | null;
    user_text: string;
    assistant_text: string;
    is_sidechain: number;
    rank: number;
  }[];
  return rows.map((r) => ({
    key: `e:${r.id}`,
    kind: 'exchange' as const,
    sessionId: r.session_id,
    id: r.id,
    seq: r.seq,
    ts: r.ts,
    userText: r.user_text,
    assistantText: r.assistant_text,
    isSidechain: r.is_sidechain === 1,
    raw: r.rank,
  }));
}

/**
 * bm25 over `cards_fts`.
 *
 * The card's own words, which are not the session's words: a session that says
 * "pgbouncer" four hundred times and a card that says *"switched the pooler to
 * transaction mode because prepared statements were leaking"* are different
 * evidence, and this is the list that carries the second kind.
 *
 * Joined to `sessions`, so `--project`, `--since`, `--branch` and the rest
 * filter cards exactly as they filter exchanges. **T2.3 note:** ghost cards
 * live in the same table with no `sessions` row, so this join hides them; when
 * ghost cards land, this needs the ghost half too (a second query against
 * `ghosts`, fused as the same list — not a LEFT JOIN, which would defeat the
 * filter builder's bound-parameter guarantee).
 */
interface CardHitRow {
  session_id: string;
  title: string | null;
  summary: string | null;
  ts: string | null;
  is_sidechain: number;
  rank: number;
}

function cardHit(r: CardHitRow): RawHit {
  return {
    key: `c:${r.session_id}`,
    kind: 'card' as const,
    sessionId: r.session_id,
    ts: r.ts,
    userText: r.title ?? '',
    assistantText: r.summary ?? '',
    isSidechain: r.is_sidechain === 1,
    raw: r.rank,
  };
}

/**
 * `cards_fts`, over both kinds of card.
 *
 * **Two queries, not a `LEFT JOIN`.** A card's session lives in `sessions` if
 * it survived and in `ghosts` if the sweep took it, and the two are filtered by
 * different column names (`s.started_at` against `g.last_ts`, and so on) by two
 * different bound-parameter builders. A single query over an outer join would
 * have to hand-roll that clause and would lose the parameter binding with it —
 * which is the whole safety property of `search/filters.ts`.
 *
 * Skipping the second query is not an option and was the near-miss of T2.3: on
 * the reference machine 299 of 330 sessions are ghosts, so a `cards_fts` that
 * only joins `sessions` writes 200 ghost cards correctly and then finds none
 * of them.
 */
function bm25Cards(db: Db, match: string, filters: SearchFilters, depth: number): RawHit[] {
  const hits: RawHit[] = [];

  if (sessionCardsInScope(filters)) {
    const f = buildSessionFilters(filters);
    hits.push(
      ...(db
        .prepare(
          `SELECT c.session_id AS session_id, c.title AS title, c.summary AS summary,
                  s.started_at AS ts, s.is_sidechain AS is_sidechain,
                  bm25(cards_fts, 2.0, 1.5, 1.0, 1.0, 1.0) AS rank
             FROM cards_fts
             JOIN cards c    ON c.rowid = cards_fts.rowid
             JOIN sessions s ON s.id = c.session_id
            WHERE cards_fts MATCH ?
              ${f.sql}
            ORDER BY rank
            LIMIT ?`,
        )
        .all(match, ...f.params, depth) as CardHitRow[]
      ).map(cardHit),
    );
  }

  if (ghostCardsInScope(filters)) {
    const f = buildGhostFilters(filters);
    hits.push(
      ...(db
        .prepare(
          `SELECT c.session_id AS session_id, c.title AS title, c.summary AS summary,
                  g.last_ts AS ts, 0 AS is_sidechain,
                  bm25(cards_fts, 2.0, 1.5, 1.0, 1.0, 1.0) AS rank
             FROM cards_fts
             JOIN cards c  ON c.rowid = cards_fts.rowid
             JOIN ghosts g ON g.session_id = c.session_id
            WHERE cards_fts MATCH ?
              ${f.sql}
            ORDER BY rank
            LIMIT ?`,
        )
        .all(match, ...f.params, depth) as CardHitRow[]
      ).map(cardHit),
    );
  }

  // Both halves came back ranked; the fusion downstream reads position, so the
  // merged list has to be one ranking rather than two concatenated ones.
  return hits.sort((a, b) => a.raw - b.raw).slice(0, depth);
}

/**
 * Whether a surviving session's card can satisfy these filters.
 *
 * The same tri-state reasoning `recall()` applies to whole lists, asked one
 * level down: `cards` holds both kinds now, so the *list* stays in play under
 * `--ghosts only` and each half decides for itself.
 */
function sessionCardsInScope(filters: SearchFilters): boolean {
  if (filters.status === 'ghost') return false;
  return (filters.ghosts ?? 'include') !== 'only';
}

/** And the mirror image, for a card written from a deleted session's prompts. */
function ghostCardsInScope(filters: SearchFilters): boolean {
  if (filters.status === 'ghost') return true;
  if ((filters.ghosts ?? 'include') === 'exclude') return false;
  // A ghost has no assistant side, no subagents and no recorded file edits.
  if ((filters.sidechains ?? 'include') === 'only') return false;
  if (filters.file) return false;
  if (filters.status) return false;
  return true;
}

/** KNN over `vec_cards` — `title + summary + topics`, one vector per session. */
function vecCards(db: Db, embedding: number[], filters: SearchFilters, depth: number): RawHit[] {
  const wanted = knnCandidates(depth, filters);
  const near = db
    .prepare(
      `SELECT session_id, distance FROM vec_cards
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(embeddingToBlob(embedding), wanted) as { session_id: string; distance: number }[];
  if (near.length === 0) return [];

  const order = new Map(near.map((n, i) => [n.session_id, i]));
  // Carried through so `--explain` can print the cosine it ranked on. It used
  // to hard-code 0, and a ledger row reading `cos 0.00` beside the hit that
  // *won* the query is worse than no column at all.
  const similarity = new Map(
    near.map((n) => [n.session_id, l2DistanceToCosineSimilarity(n.distance)]),
  );
  const placeholders = near.map(() => '?').join(',');
  const ids = near.map((n) => n.session_id);
  // Same two-query rule as `bm25Cards`, for the same reason: half the cards on
  // a real machine belong to sessions that no longer have a `sessions` row.
  const rows: CardHitRow[] = [];

  if (sessionCardsInScope(filters)) {
    const f = buildSessionFilters(filters);
    rows.push(
      ...(db
        .prepare(
          `SELECT c.session_id AS session_id, c.title AS title, c.summary AS summary,
                  s.started_at AS ts, s.is_sidechain AS is_sidechain, 0 AS rank
             FROM cards c
             JOIN sessions s ON s.id = c.session_id
            WHERE c.session_id IN (${placeholders})
              ${f.sql}`,
        )
        .all(...ids, ...f.params) as CardHitRow[]),
    );
  }
  if (ghostCardsInScope(filters)) {
    const f = buildGhostFilters(filters);
    rows.push(
      ...(db
        .prepare(
          `SELECT c.session_id AS session_id, c.title AS title, c.summary AS summary,
                  g.last_ts AS ts, 0 AS is_sidechain, 0 AS rank
             FROM cards c
             JOIN ghosts g ON g.session_id = c.session_id
            WHERE c.session_id IN (${placeholders})
              ${f.sql}`,
        )
        .all(...ids, ...f.params) as CardHitRow[]),
    );
  }

  return rows
    .sort((a, b) => (order.get(a.session_id) ?? 0) - (order.get(b.session_id) ?? 0))
    .slice(0, depth)
    .map((r) => ({ ...cardHit(r), raw: similarity.get(r.session_id) ?? 0 }));
}

function bm25Ghosts(db: Db, match: string, filters: SearchFilters, depth: number): RawHit[] {
  const f = buildGhostFilters(filters);
  const rows = db
    .prepare(
      `SELECT g.session_id AS session_id, g.first_prompt AS first_prompt, g.title AS title,
              g.first_ts AS ts, bm25(ghosts_fts, 1.0, 2.0) AS rank
         FROM ghosts_fts
         JOIN ghosts g ON g.rowid = ghosts_fts.rowid
        WHERE ghosts_fts MATCH ?
          ${f.sql}
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, ...f.params, depth) as {
    session_id: string;
    first_prompt: string | null;
    title: string | null;
    ts: string | null;
    rank: number;
  }[];
  return rows.map((r) => ({
    key: `g:${r.session_id}`,
    kind: 'ghost' as const,
    sessionId: r.session_id,
    seq: 0,
    ts: r.ts,
    userText: r.first_prompt ?? r.title ?? '',
    isSidechain: false,
    raw: r.rank,
  }));
}

function bm25GhostPrompts(db: Db, match: string, filters: SearchFilters, depth: number): RawHit[] {
  const f = buildGhostFilters(filters);
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.session_id AS session_id, p.seq AS seq, p.ts AS ts, p.text AS text,
              bm25(ghost_prompts_fts) AS rank
         FROM ghost_prompts_fts
         JOIN ghost_prompts p ON p.rowid = ghost_prompts_fts.rowid
         JOIN ghosts g ON g.session_id = p.session_id
        WHERE ghost_prompts_fts MATCH ?
          ${f.sql}
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, ...f.params, depth) as {
    id: string;
    session_id: string;
    seq: number;
    ts: string | null;
    text: string;
    rank: number;
  }[];
  return rows.map((r) => ({
    key: `gp:${r.id}`,
    kind: 'ghost' as const,
    sessionId: r.session_id,
    id: r.id,
    seq: r.seq,
    ts: r.ts,
    userText: r.text,
    isSidechain: false,
    raw: r.rank,
  }));
}

function vecExchanges(
  db: Db,
  embedding: number[],
  filters: SearchFilters,
  depth: number,
): RawHit[] {
  // vec0 applies its KNN cut *before* WHERE, so a filtered search has to ask
  // for more neighbours than it wants and trim afterwards (`knnCandidates`).
  const wanted = knnCandidates(depth, filters);
  const near = db
    .prepare(
      `SELECT id, distance FROM vec_exchanges
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(embeddingToBlob(embedding), wanted) as { id: string; distance: number }[];
  if (near.length === 0) return [];

  const order = new Map(near.map((n, i) => [n.id, i]));
  const similarity = new Map(near.map((n) => [n.id, l2DistanceToCosineSimilarity(n.distance)]));
  const f = buildExchangeFilters(filters);
  const placeholders = near.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.session_id AS session_id, e.seq AS seq, e.ts AS ts,
              e.user_text AS user_text, e.assistant_text AS assistant_text,
              e.is_sidechain AS is_sidechain
         FROM exchanges e
         JOIN sessions s ON s.id = e.session_id
        WHERE e.id IN (${placeholders})
          ${f.sql}`,
    )
    .all(...near.map((n) => n.id), ...f.params) as {
    id: string;
    session_id: string;
    seq: number;
    ts: string | null;
    user_text: string;
    assistant_text: string;
    is_sidechain: number;
  }[];

  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .slice(0, depth)
    .map((r) => ({
      key: `e:${r.id}`,
      kind: 'exchange' as const,
      sessionId: r.session_id,
      id: r.id,
      seq: r.seq,
      ts: r.ts,
      userText: r.user_text,
      assistantText: r.assistant_text,
      isSidechain: r.is_sidechain === 1,
      raw: similarity.get(r.id) ?? 0,
    }));
}

/**
 * The ghosts' vector list (schema 8).
 *
 * Shaped to produce the same `key` as {@link bm25GhostPrompts} — `gp:<id>` —
 * so that a prompt found by both halves fuses into one hit with two votes
 * rather than appearing twice, which is the whole point of doing this at the
 * row level instead of the session level.
 */
function vecGhostPrompts(
  db: Db,
  embedding: number[],
  filters: SearchFilters,
  depth: number,
): RawHit[] {
  const wanted = knnCandidates(depth, filters);
  const near = db
    .prepare(
      `SELECT id, distance FROM vec_ghost_prompts
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(embeddingToBlob(embedding), wanted) as { id: string; distance: number }[];
  if (near.length === 0) return [];

  const order = new Map(near.map((n, i) => [n.id, i]));
  const similarity = new Map(near.map((n) => [n.id, l2DistanceToCosineSimilarity(n.distance)]));
  const f = buildGhostFilters(filters);
  const placeholders = near.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.session_id AS session_id, p.seq AS seq, p.ts AS ts, p.text AS text
         FROM ghost_prompts p
         JOIN ghosts g ON g.session_id = p.session_id
        WHERE p.id IN (${placeholders})
          ${f.sql}`,
    )
    .all(...near.map((n) => n.id), ...f.params) as {
    id: string;
    session_id: string;
    seq: number;
    ts: string | null;
    text: string;
  }[];

  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .slice(0, depth)
    .map((r) => ({
      key: `gp:${r.id}`,
      kind: 'ghost' as const,
      sessionId: r.session_id,
      id: r.id,
      seq: r.seq,
      ts: r.ts,
      userText: r.text,
      isSidechain: false,
      raw: similarity.get(r.id) ?? 0,
    }));
}

// ------------------------------------------------------------------ vectors

/** Can this database answer a vector query at all, and if not, why not. */
export function vectorState(db: Db, root?: string): VectorState {
  // `vecStatus` is what actually loads vec0 into this connection; without it
  // `vec_exchanges` is a row in sqlite_master that no query can read.
  const ext = vecStatus(db);
  // FIX-F C2 — *yet* and *never* are different answers, and every string below
  // used to give the first one unconditionally.
  //
  // `working` is the same read `vec.vecStatus` makes, from the same lock file,
  // through the same function: the background embedder holds `.lock.embed` for
  // the whole pass and writes its pid into it, and `lock.holder` already
  // answers `null` for a lock whose owner is gone. Two calls, one file, one
  // rule — they cannot disagree. Without a root there is nothing to ask, and
  // then nothing is claimed in either direction.
  const working = root === undefined ? undefined : lockHolder({ root, lane: 'embed' }) !== null;
  const stopped = working === false;
  if (!ext.available) {
    return {
      used: false,
      available: false,
      ...(working === undefined ? {} : { working }),
      reason: `no vector index — ${ext.reason ?? 'sqlite-vec did not load'}`,
    };
  }
  if (!vecTablesExist(db)) {
    return { used: false, available: false, reason: 'no vector index — never built' };
  }
  let vectors = 0;
  try {
    vectors = (db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges').get() as { n: number }).n;
  } catch {
    return { used: false, available: false, reason: 'no vector index — vec_exchanges unreadable' };
  }
  if (vectors === 0) {
    return {
      used: false,
      available: false,
      vectors: 0,
      ...(working === undefined ? {} : { working }),
      // NOT `run potsherd index --embed`. This string reaches `potsherd_recall`,
      // whose caller has no shell, and `render/find.ts:229` and `render/stats.ts:158`
      // both record that the instruction is false anyway: `index` embeds by default
      // now, so there is nothing for anyone to run.
      //
      // FIX-F C2 — and `yet` is a promise. It is true while an embedder is
      // running and false after `index --no-embed`, on a machine that cannot
      // fetch the runtime, and after a pass was killed. The agent reading this
      // at the model door is being told the other half of its answer is on its
      // way; on those three indexes it is not, and the word that says so is
      // the only thing standing between it and a pointless retry.
      reason: stopped
        ? 'no embeddings in the index, and nothing is embedding them'
        : 'no embeddings in the index yet',
    };
  }
  const cache = modelsDir(potsherdDir(root));
  if (!isModelCached(cache)) {
    return {
      used: false,
      available: false,
      vectors,
      ...(working === undefined ? {} : { working }),
      reason: 'embedding model not downloaded — run  potsherd index  once online',
    };
  }
  return { used: false, available: true, vectors, ...(working === undefined ? {} : { working }) };
}

// -------------------------------------------------------------------- fusion

/**
 * The whole of `find`'s ranking. Runs each list, fuses by RRF, diversifies by
 * session, and groups into the blocks the renderer prints.
 */
export async function recall(
  db: Db,
  query: string,
  requested: SearchFilters = {},
  options: RecallOptions = {},
): Promise<RecallResult> {
  const started = Date.now();
  // The ignore list, folded into the filters once, before any list runs — so
  // every one of the six lists, the vector KNN's candidate depth and the
  // clustering all see the same archive. `ask` calls this function and passes
  // no ignore option of its own, which is the point: honouring the list here
  // is what makes `ask` honour it.
  const ignore = applyIgnore(db, requested, {
    ...(options.all !== undefined ? { all: options.all } : {}),
    ...(options.root !== undefined ? { root: options.root } : {}),
    ...(options.ignore !== undefined ? { entries: options.ignore } : {}),
  });
  const filters = ignore.filters;
  const ignored: IgnoreReport = {
    entries: ignore.entries,
    projects: ignore.projects,
    // Sessions in the ignored projects, not hits withheld: a search cannot
    // report what it would have found without running twice, and a number
    // that took 150 ms to earn would be a strange price for a caveat. What
    // this says on screen is "these projects were not searched", which is
    // exactly what it counts.
    hidden: ignore.applied ? countIgnoredSessions(db, ignore.projects) : 0,
  };
  const limit = Math.max(1, options.limit ?? 10);
  const k = options.k ?? RRF_K;
  const perSession = Math.max(1, options.perSession ?? PER_SESSION);
  const baseWeights: Partial<Record<ListName, number>> = { ...WEIGHTS, ...options.weights };
  const corroboration = options.corroboration ?? CORROBORATION;
  const minConfidence: Confidence = options.minConfidence ?? 'none';
  const depth = Math.max(options.candidates ?? Math.max(limit * 10, 60), limit);
  // `--status ghost` is `--ghosts only` said the other way round; a ghost has
  // no row in `sessions`, so there is nothing else it could mean.
  const ghosts = filters.status === 'ghost' ? 'only' : (filters.ghosts ?? 'include');
  const sidechains = filters.sidechains ?? 'include';

  // Validated once, here, rather than inside each list. Every list wraps its
  // own query in a try/catch so a corrupt fts index cannot take the whole
  // search down — which would also swallow a bad `--since` and answer "no
  // results" to a question the user never actually asked.
  if (filters.since) validateISODate(filters.since, '--since');
  if (filters.until) validateISODate(filters.until, '--until');

  const fts = ftsQuery(query);
  // F8 — the distinctive half of what was typed, extracted **here, in code**,
  // from the index the search is about to run against. The caller still passes
  // the user's own words; nothing about the query the agent sends changes.
  //
  // Computed once per search rather than once per list, because a keyphrase is
  // a property of the question and not of the table: `exchanges_fts` and
  // `ghost_prompts_fts` narrowing to different words would make two lists
  // whose ranks RRF is about to compare answers to two different questions.
  //
  // It never throws — `documentFrequency` swallows a missing table per table —
  // but the whole call is guarded anyway, because a search must not be able to
  // fail on the way to being *narrowed*.
  let key: Keyphrase = NO_KEYPHRASE;
  try {
    key = extractKeyphrase(db, fts.tokens, QUOTE_STOPWORDS);
  } catch {
    key = NO_KEYPHRASE;
  }
  const listReports: RecallResult['lists'] = [];
  const empty = (vectors: VectorState): RecallResult => ({
    query,
    sessions: [],
    hits: [],
    vectors,
    lists: listReports,
    k,
    weights: {},
    relaxedLists: [],
    relaxed: false,
    ghostsOnly: ghosts === 'only',
    indexedGhosts: countGhosts(db),
    ignored,
    confidence: 'none',
    minConfidence,
    belowFloor: 0,
    keyphrase: key,
    keyphraseLists: [],
    ms: Date.now() - started,
  });

  const vecMode: boolean | 'auto' = options.vectors ?? 'auto';
  const vectors: VectorState =
    vecMode === false
      ? {
          used: false,
          available: false,
          reason: 'vectors off (--no-vec)',
          // FIX-F C2 — whether anybody is embedding this index is a fact about
          // the index, not about this search's flags. `--no-vec` says the
          // caller does not want the vector half *now*; it does not make
          // `warming` true, and the renderer needs the fact either way.
          ...(options.root === undefined
            ? {}
            : { working: lockHolder({ root: options.root, lane: 'embed' }) !== null }),
        }
      : vectorState(db, options.root);

  if (fts.tokens.length === 0) return empty(vectors);

  // Which lists are in play. A tri-state filter switches whole lists off:
  // `--ghosts only` is not "search everything then drop the non-ghosts", it is
  // "do not run the exchange lists at all", which is also why it is fast.
  const wanted = new Set<ListName>(options.lists ?? LISTS);
  if (ghosts === 'only') {
    wanted.delete('titles');
    wanted.delete('exchanges_fts');
    wanted.delete('vec_exchanges');
    // The card lists stay. From T2.3 on `cards` holds ghost cards too — on the
    // reference machine most of them are — and `bm25Cards`/`vecCards` narrow
    // to the ghost half themselves. Dropping the lists here would make
    // `--ghosts only` the one search that cannot see a ghost's card.
  }
  // A ghost is a row from history.jsonl: prompts only, never a subagent. So
  // `--ghosts exclude` and `--sidechains only` both mean the same thing here.
  if (
    ghosts === 'exclude' ||
    sidechains === 'only' ||
    (filters.status && filters.status !== 'ghost') ||
    filters.file
  ) {
    wanted.delete('ghosts_fts');
    wanted.delete('ghost_prompts_fts');
    wanted.delete('vec_ghost_prompts');
  }
  if (!vectors.available) {
    wanted.delete('vec_exchanges');
    wanted.delete('vec_ghost_prompts');
  }
  // Schema 8, and it declines on a machine without `sqlite-vec`. An index
  // rescued before this release has the table and no rows in it; running a KNN
  // against an empty vec0 table per search is a cost with no answer attached.
  if (!tableExists(db, 'vec_ghost_prompts') || countRows(db, 'vec_ghost_prompts') === 0) {
    wanted.delete('vec_ghost_prompts');
  }
  // `--no-cards`, and it comes before every other card test because it is the
  // only one that is a decision rather than a fact about the index: the caller
  // asked for transcripts. Removing the lists here rather than filtering their
  // hits later is what makes the flag free — two fewer queries and, when
  // `vec_cards` was the only reason to embed, one fewer forward pass.
  if (options.cards === false) {
    wanted.delete('cards_fts');
    wanted.delete('vec_cards');
  }
  // The card lists are real from T2.2 on, and still leave the set the moment
  // there is nothing behind them: an index that has never run `potsherd card`
  // has an empty `cards` table, and running two extra queries per search to
  // find that out again is a cost with no answer attached.
  if (!tableExists(db, 'cards_fts') || countRows(db, 'cards') === 0) {
    wanted.delete('cards_fts');
  }
  if (!vectors.available || !tableExists(db, 'vec_cards') || countRows(db, 'vec_cards') === 0) {
    wanted.delete('vec_cards');
  }

  let relaxed = false;
  const relaxedLists = new Set<ListName>();
  const keyphraseLists = new Set<ListName>();

  /**
   * The keyphrase as an fts5 OR expression, or `''` when there is no narrowing
   * to do.
   *
   * Built with the *same* quoting and the *same* {@link PREFIX_MIN} rule as
   * {@link ftsQuery}'s own OR pass, so the only difference between the two
   * passes is which words are in them. That is deliberate: if the keyphrase
   * pass also changed how a word is matched, a measurement of it would be a
   * measurement of two things.
   *
   * Empty when the keyphrase is not a **strict** subset of what the OR pass
   * would have used anyway. This is what makes the short-query guarantee
   * structural rather than a threshold: `find "pgbouncer"` has one content
   * word, its keyphrase is that same word, the subset is not strict, and the
   * expression is never built — so the ladder below is byte-for-byte the
   * v1.1.0 ladder for every query that was already distinctive.
   */
  const quoteTerm = (t: string): string => `"${t.replace(/"/g, '""')}"`;
  const distinctMeaningful = new Set(fts.tokens.filter((t) => !STOPWORDS.has(t))).size;
  const keyOr =
    key.terms.length > 0 && key.terms.length < distinctMeaningful
      ? key.terms
          .map((t) => (t.length >= PREFIX_MIN ? `${quoteTerm(t)}*` : quoteTerm(t)))
          .join(' OR ')
      : '';

  /**
   * Exact first, then relaxed — **per list**, not globally.
   *
   * `AND` is what someone typing five words means, and where it works it
   * should not be second-guessed. But the lists have very different shapes: an
   * `exchanges` row is a prompt plus a whole assistant turn and easily holds
   * five words, while a `ghost_prompts` row is one sentence out of
   * `history.jsonl` and almost never does. Relaxing globally therefore either
   * starves the ghosts (never relax) or floods the exchanges with any-word
   * noise (always relax).
   *
   * Relaxing each list only when *that list* found nothing gives both: the
   * precise answer keeps its rank, and the deleted session still surfaces.
   */
  const textList = (list: ListName, fn: (match: string) => RawHit[]): RawHit[] => {
    if (!wanted.has(list)) return [];
    const t0 = Date.now();
    let hits: RawHit[] = [];
    let usedOr = false;
    let usedKeyphrase = false;
    const anyWord = (): RawHit[] =>
      fts.or && fts.or !== fts.and ? fn(fts.or) : [];
    try {
      hits = fn(fts.and);
      // F8 — the second rung, and the first responder. It runs only when the
      // words *as typed* found nothing, which is the exact case the audit
      // measured: a long question whose AND pass is empty and whose OR pass
      // then drifts to whatever session holds the most common words.
      if (hits.length === 0 && keyOr && keyOr !== fts.and && keyOr !== fts.or) {
        usedOr = true;
        usedKeyphrase = true;
        hits = fn(keyOr);
      }
      // The third rung, unchanged, and the reason nothing is thrown away: when
      // the distinctive words find nothing, every token the user typed is
      // tried again, prefix-matched, exactly as before this rung existed.
      if (hits.length === 0) {
        const rest = anyWord();
        if (fts.or && fts.or !== fts.and) usedOr = true;
        usedKeyphrase = false;
        hits = rest;
      }
    } catch {
      // A malformed external-content index or a missing table must not take
      // the whole query down; the other lists still have an answer.
      hits = [];
    }
    if (usedOr) {
      relaxedLists.add(list);
      if (usedKeyphrase) keyphraseLists.add(list);
      if (hits.length > 0) relaxed = true;
    }
    listReports.push({ list, candidates: hits.length, ms: Date.now() - t0 });
    return hits;
  };

  const titles = wanted.has('titles')
    ? titled(db, fts.tokens, filters, depth, listReports)
    : { hits: [], coverage: 0 };
  const lists: Record<string, RawHit[]> = {
    titles: titles.hits,
    exchanges_fts: textList('exchanges_fts', (m) => bm25Exchanges(db, m, filters, depth)),
    cards_fts: textList('cards_fts', (m) => bm25Cards(db, m, filters, depth)),
    ghosts_fts: textList('ghosts_fts', (m) => bm25Ghosts(db, m, filters, depth)),
    ghost_prompts_fts: textList('ghost_prompts_fts', (m) =>
      bm25GhostPrompts(db, m, filters, depth),
    ),
  };

  // The question `auto` asks is not "did we fill the page" but "did the words
  // work". If the user's exact words appear together in some conversation, the
  // text index has already answered and a 350 ms forward pass through
  // bge-small can only reorder an answer they are about to be happy with.
  // Semantic search earns its cost in the other case: when the words appear
  // nowhere and `exchanges_fts` had to fall back to any-word matching.
  const settled = !relaxedLists.has('exchanges_fts') && (lists['exchanges_fts']?.length ?? 0) > 0;
  if (vecMode === 'auto' && settled) {
    wanted.delete('vec_exchanges');
    wanted.delete('vec_cards');
    wanted.delete('vec_ghost_prompts');
    // Which upgrade to offer depends on whether there is a vector index to
    // turn on. Before 8.6 there almost always was, because `index` embedded by
    // default; 8.6 made text-only the default, so on a new machine this line
    // ran with zero embeddings and told the reader to pass `--vectors on`,
    // which cannot work until a model has been fetched. The FIRST `find` a
    // stranger runs is exactly the case it was wrong for.
    const state = vectorState(db, options.root);
    vectors.reason =
      state.vectors === 0 || !state.available
        // FIX-F C2 — `as vectors land` is the same promise one field over, and
        // it is the one the verifier caught live at the model door. Vectors
        // land when a worker is embedding; when the embed lane is empty they
        // do not land at all.
        ? state.working === false
          ? 'the words matched; semantic search is not running, so nothing will be added'
          : 'the words matched; semantic search adds to this as vectors land'
        // NOT `--vectors on`. This string reaches `potsherd_recall`, whose
        // schema is `query, scope, want, budget` — an agent reading it is being
        // told to pass a flag it has no way to pass, which is the "documented
        // and does nothing" failure this project has now recorded eight times.
        // The condition is also not a user's to change: vectors are already on
        // and this branch means the query's own words carried the result.
        : 'the words matched, so the vector half was not needed';
  }

  // One forward pass, two lists. The query embedding is the expensive part
  // (~350 ms); `vec_exchanges` and `vec_cards` are two KNN seeks against it,
  // so a search that pays for the vector half should get both halves of it.
  if (wanted.has('vec_exchanges') || wanted.has('vec_cards') || wanted.has('vec_ghost_prompts')) {
    try {
      const embedding = await generateQueryEmbedding(query, {
        cacheDir: modelsDir(potsherdDir(options.root)),
      });
      let used = false;
      if (wanted.has('vec_exchanges')) {
        const t0 = Date.now();
        const hits = vecExchanges(db, embedding, filters, depth);
        listReports.push({ list: 'vec_exchanges', candidates: hits.length, ms: Date.now() - t0 });
        lists['vec_exchanges'] = hits;
        used ||= hits.length > 0;
      }
      if (wanted.has('vec_ghost_prompts')) {
        const t0 = Date.now();
        const hits = vecGhostPrompts(db, embedding, filters, depth);
        listReports.push({
          list: 'vec_ghost_prompts',
          candidates: hits.length,
          ms: Date.now() - t0,
        });
        lists['vec_ghost_prompts'] = hits;
        used ||= hits.length > 0;
      }
      if (wanted.has('vec_cards')) {
        const t0 = Date.now();
        const hits = vecCards(db, embedding, filters, depth);
        listReports.push({ list: 'vec_cards', candidates: hits.length, ms: Date.now() - t0 });
        lists['vec_cards'] = hits;
        used ||= hits.length > 0;
      }
      vectors.used = used;
    } catch (err) {
      vectors.used = false;
      vectors.reason = `vectors unavailable: ${firstLine((err as Error)?.message ?? String(err))}`;
    }
  }

  // Function words do not make a snippet. `find "key on a replayed request"`
  // that highlights `on`, or `find "the ci runner filled up its disk"` that
  // points at `up` in a session about refunds, has picked the one word in the
  // query that explains nothing — and a block that cannot show a real match is
  // better off *saying* so, which is what the renderer does when this list
  // comes back empty-handed. The full token list still drives the **ranking**;
  // only the quoting uses this half.
  const quotable = fts.tokens.filter((t) => !QUOTE_STOPWORDS.has(t));
  const meaningfulTokens = fts.tokens.filter((t) => !STOPWORDS.has(t));
  const quotableTokens =
    quotable.length > 0 ? quotable : meaningfulTokens.length > 0 ? meaningfulTokens : fts.tokens;

  // F8's second half — the terms a row must be able to show before it may
  // carry a label at all. The *most selective* of the query's distinctive
  // terms, because `coveredTerms` counts every word the user typed as worth
  // the same and the floor's promise is about the words that make the question
  // what it is. See `calibration.ts`'s {@link KEY_TERMS_REQUIRED}.
  const requiredTerms = key.terms.slice(0, KEY_TERMS_REQUIRED);

  // ---- reciprocal rank fusion
  const fused = new Map<string, RawHit & { score: number; from: RecallHit['from'] }>();
  const effectiveWeights: Partial<Record<ListName, number>> = {};
  for (const [name, hits] of Object.entries(lists)) {
    const weight =
      (baseWeights[name as ListName] ?? 1) *
      (name === 'titles' ? titles.coverage : 1) *
      (relaxedLists.has(name as ListName) ? RELAXED_PENALTY : 1);
    // Recorded for every list that ran, empty one included: `--explain` has to
    // be able to say "cards_fts was worth 1.2 and still found nothing".
    if (wanted.has(name as ListName)) effectiveWeights[name as ListName] = weight;
    hits.forEach((hit, i) => {
      const rank = i + 1;
      const contribution = weight * rrfScore(rank, k);
      const seen = fused.get(hit.key);
      if (seen) {
        seen.score += contribution;
        seen.from.push({ list: name as ListName, rank, raw: hit.raw, contribution });
        // A vec hit carries no better text than an fts hit of the same row, but
        // it may be the only one that has it.
        if (!seen.assistantText && hit.assistantText) seen.assistantText = hit.assistantText;
      } else {
        fused.set(hit.key, {
          ...hit,
          score: contribution,
          from: [{ list: name as ListName, rank, raw: hit.raw, contribution }],
        });
      }
    });
  }

  const ranked = [...fused.values()].sort(
    (a, b) => b.score - a.score || (a.seq ?? 0) - (b.seq ?? 0),
  );

  // ---- calibration inputs
  //
  // F1. Everything below this comment is the *second* axis and touches the
  // order of nothing: `ranked` is already final and is not re-sorted.
  //
  // `bestRaw` is each list's own strongest magnitude **for this query** —
  // the most negative bm25, the highest cosine. It is the denominator that
  // makes `from[].raw` mean something without an absolute scale, and it is
  // computed over the full candidate list rather than the page, so a row
  // being 40% of its list's best is a fact about the list and not about how
  // many rows happened to survive diversification.
  const bestRaw = new Map<ListName, number>();
  for (const [name, hits] of Object.entries(lists)) {
    if (hits.length === 0) continue;
    const kind = rawKind(name as ListName);
    if (kind === 'flat') continue;
    let best = hits[0]!.raw;
    for (const h of hits) best = kind === 'bm25' ? Math.min(best, h.raw) : Math.max(best, h.raw);
    bestRaw.set(name as ListName, best);
  }
  const strengthOf = (from: RecallHit['from']): number => {
    let best = 0;
    for (const f of from) {
      const kind = rawKind(f.list);
      best = Math.max(best, relativeStrength(f.raw, bestRaw.get(f.list) ?? 0, kind));
    }
    return best;
  };

  // ---- one conversation, one block
  //
  // A subagent transcript is not a separate conversation. potsherd already
  // says so everywhere else — `resumeCommand` resumes the *parent* because
  // `<parent>:agent-<hash>` is an id for a file rather than something claude
  // will reopen, and `RecallSession.subagents` counts them on the parent — but
  // the ranker used to treat the two as rivals, and they are rivals about the
  // same topic, which is the worst possible pairing.
  //
  // Concretely: a subagent holds *one* exchange. It can never be corroborated,
  // it can never fill the three-hit diversification budget, and its parent —
  // which is about the same thing, and has a card and a hundred exchanges —
  // outranks it every time. On phase 3's eval set the subagent that was the
  // single nearest vector in the whole index to "the thing quietly eating most
  // of the cloud bill" came back below its own parent, so the answer on the
  // screen was the session that *spawned* the work rather than the transcript
  // that did it. Both spellings point at the same conversation; showing them as
  // two results is also just a duplicate on the page.
  //
  // So: cluster by conversation, diversify per conversation (which is what
  // `03` §7's "max 3 exchanges per session" meant when sessions had no
  // children), and let the cluster be *represented* by whichever member
  // actually earned the top hit — so a query whose only answer is in the
  // subagent still shows the subagent, and a query the parent answers better
  // shows the parent with the subagent's line underneath it.
  //
  // **F6 — evidence fills the budget first.** The three-hit budget used to be
  // handed out in fused order, so a card could take one of a conversation's
  // three slots away from an exchange that actually said the words. Two
  // passes: transcript hits take the {@link PER_SESSION} budget, then cards
  // take a separate {@link ROUTING_PER_SESSION} budget of their own. A card
  // can therefore no longer cost a transcript its line, and it can no longer
  // be the reason a page is full.
  const conversationOf = conversationKeys(db, ranked.map((h) => h.sessionId));
  const perSessionCount = new Map<string, number>();
  const routingCount = new Map<string, number>();
  const kept: RecallHit[] = [];
  const take = (hit: (typeof ranked)[number]): void => {
    const lane = laneOfHit(hit.kind);
    // Coverage is counted over the text this row can actually *show* — the
    // same string `bestSnippet` cuts from — so the label and the highlighted
    // words on the screen are two readings of one measurement.
    const hitText = `${hit.userText} ${hit.assistantText ?? ''}`;
    const calibration = calibrate({
      covered: coveredTerms(quotableTokens, hitText),
      terms: quotableTokens.length,
      strength: strengthOf(hit.from),
      lists: new Set(hit.from.map((f) => f.list)).size,
      // F8's second half. Coverage above is a uniform partition over every
      // word the user typed; this says which of those words the question was
      // actually *about*. A row that shows none of them is not an answer to
      // it, whatever the other four numbers say. See `calibration.ts`.
      keyCovered: coveredTerms(requiredTerms, hitText),
      keyTerms: requiredTerms.length,
      // A card's text is a model's paragraph about the session, so full
      // coverage of the query inside it means the *summary* used those words
      // — which is the one thing an agent must not be allowed to read as "the
      // archive answers this". See `calibration.ts`.
      //
      // FIX-F C3 — and a Claude Code title is a model's *six* words about the
      // session, which is the same thing with less of it. The cap is keyed on
      // {@link SUMMARY_KINDS} rather than on the lane, because the lane governs
      // five other things this must not move; see that constant. Measured on
      // the reference archive: `potsherd_recall` on one word returned 28 hits
      // of which the first 18 were titles, every one of them labelled
      // `strong`, with the first transcript hit at index 18.
      ...(isSummaryHit(hit.kind) ? { ceiling: ROUTING_CEILING } : {}),
    });
    kept.push({
      kind: hit.kind,
      sessionId: hit.sessionId,
      ...(hit.id ? { id: hit.id } : {}),
      ...(hit.seq !== undefined ? { seq: hit.seq } : {}),
      ts: hit.ts ?? null,
      userText: hit.userText,
      ...(hit.assistantText !== undefined ? { assistantText: hit.assistantText } : {}),
      snippet: bestSnippet(hit.userText, hit.assistantText, query, quotableTokens),
      isSidechain: hit.isSidechain,
      score: hit.score,
      from: hit.from,
      calibration,
      confidence: calibration.confidence,
      lane,
    });
  };
  for (const hit of ranked) {
    if (laneOfHit(hit.kind) !== 'evidence') continue;
    const conversation = conversationOf(hit.sessionId);
    const n = perSessionCount.get(conversation) ?? 0;
    if (n >= perSession) continue;
    perSessionCount.set(conversation, n + 1);
    take(hit);
  }
  for (const hit of ranked) {
    if (laneOfHit(hit.kind) === 'evidence') continue;
    const conversation = conversationOf(hit.sessionId);
    const n = routingCount.get(conversation) ?? 0;
    if (n >= ROUTING_PER_SESSION) continue;
    routingCount.set(conversation, n + 1);
    take(hit);
  }

  // ---- group into session blocks
  const order: string[] = [];
  const grouped = new Map<string, RecallHit[]>();
  for (const hit of kept) {
    const conversation = conversationOf(hit.sessionId);
    if (!grouped.has(conversation)) {
      grouped.set(conversation, []);
      order.push(conversation);
    }
    grouped.get(conversation)!.push(hit);
  }

  // The block is headed by the member that earned the best hit, not by the
  // parent on principle: `find "tree shaking icon set"` where only the subagent
  // ever said the words must show the subagent.
  const represents = new Map<string, string>();
  for (const [conversation, hits] of grouped) {
    const best = hits.reduce((a, b) => (b.score > a.score ? b : a));
    represents.set(conversation, best.sessionId);
  }
  const meta = sessionMeta(db, [...represents.values()]);
  const sessions: RecallSession[] = [];
  // Two budgets, because one budget is a silencer.
  //
  // The build used to stop at `limit * 3` conversations outright. With the
  // lanes partitioned, `order` is every evidence conversation followed by
  // every routing one — so on a query that relaxes to any-word matching and
  // turns up thirty mediocre transcript blocks, a single card-only block
  // would never be *built*, and "demoted" would have quietly become "deleted".
  // Reserving the routing lane its own budget is what keeps F6's second half
  // true: cards still route, they just route last. `sessionMeta` has already
  // been read for every representative above, so the extra passes cost a map
  // lookup each.
  let evidenceBuilt = 0;
  let routingBuilt = 0;
  for (const conversation of order) {
    const id = represents.get(conversation) ?? conversation;
    const m = meta.get(id);
    if (!m) continue;
    // A session can hold the same text twice — a re-sent prompt, a `/model`
    // typed at both ends of a session — and two identical snippet lines under
    // one heading read as a rendering bug rather than as data.
    const seenText = new Set<string>();
    const hits = grouped.get(conversation)!.filter((h) => {
      const key = h.snippet.text.trim();
      if (!key) return true;
      if (seenText.has(key)) return false;
      seenText.add(key);
      return true;
    });
    // The block's own calibration, over the union of everything it can show
    // *and* its title. A conversation that says "privacy" in one exchange and
    // "redaction" in another has covered both words; reading each hit alone
    // would call it half an answer twice. The title is in because a session
    // named after the query is evidence — it is a whole list in the fusion.
    //
    // **F6 — and a card is not part of that union.** Coverage is the ceiling
    // in `calibrate`, so any text folded in here can lift a block's
    // confidence. A card's summary is a model's paragraph *about* the session;
    // letting it count would mean a conversation could be called `strong`
    // because a summary of it used the query's words, which is the laundering
    // the whole finding is about. So an evidence block is calibrated over its
    // evidence, and a routing block over its card — under the
    // {@link ROUTING_CEILING}, which is what stops the second case being the
    // first case by another route.
    const lane = laneOfSession(hits);
    const counted = lane === 'evidence' ? hits.filter((h) => h.lane === 'evidence') : hits;
    const blockText = (lane === 'evidence' ? [m.displayTitle, m.title ?? ''] : [])
      .concat(counted.map((h) => `${h.userText} ${h.assistantText ?? ''}`))
      .join(' ');
    // FIX-F C3. A block with nothing but summaries in it is capped exactly as a
    // card-only block is, and for the identical reason: `strong` is a licence
    // to stop reading, and there is nothing here to read. The title is still
    // folded into `blockText` above — a session *named* after the query is a
    // real signal and the `titles` list is weighted 1.5 for it — but it can now
    // only lift a block that has transcript evidence of its own to show for it.
    const transcript = hasTranscriptEvidence(hits);
    const calibration = calibrate({
      covered: coveredTerms(quotableTokens, blockText),
      terms: quotableTokens.length,
      keyCovered: coveredTerms(requiredTerms, blockText),
      keyTerms: requiredTerms.length,
      strength: Math.max(0, ...counted.map((h) => h.calibration.strength)),
      lists: new Set(counted.flatMap((h) => h.from.map((f) => f.list))).size,
      ...(lane === 'routing' || !transcript ? { ceiling: ROUTING_CEILING } : {}),
    });
    if (lane === 'evidence' ? evidenceBuilt >= limit * 3 : routingBuilt >= limit) continue;
    if (lane === 'evidence') evidenceBuilt++;
    else routingBuilt++;
    sessions.push({
      ...m,
      // Rank. A routing block is scored by its card, which is all it has, and
      // then sorts behind every evidence block regardless of the number. An
      // evidence block includes its card here — see
      // {@link CARDS_SCORE_EVIDENCE_BLOCKS} for the measurement that decided
      // it — and excludes it from `calibration` below, which is the half an
      // agent is allowed to act on.
      score: sessionScore(
        CARDS_SCORE_EVIDENCE_BLOCKS ? hits : counted,
        corroboration,
      ),
      calibration,
      confidence: calibration.confidence,
      lane,
      // F6 as a field, not as a rule two doors each re-derive. See
      // {@link citableBlock}: `transcript` is the same value the ceiling above
      // is applied from, so the cap and the permission cannot disagree.
      citable: citableBlock(hits, lane),
      hits,
    });
    // Three times the page, then sort by the *session's* total and cut. A
    // session whose best single hit ranks eleventh but which matched five
    // times is a better answer than one that matched once at rank ten, and
    // cutting at `limit` before the aggregation would never let it say so.
    if (evidenceBuilt >= limit * 3 && routingBuilt >= limit) break;
  }
  // ---- the floor
  //
  // The cliff. A block whose calibration says the archive does not answer the
  // question is withheld rather than ranked, because ten rows scored 0.0110
  // are worse than no rows at all: a human glances at the titles and knows, an
  // agent cannot, and an agent that cannot tell a match from noise stops
  // calling the tool. `belowFloor` survives so the `no match` screen can say
  // *six matched and none of them well enough* rather than the false
  // *nothing in the index matches*.
  const built = sessions.length;
  const surviving = sessions.filter((s) => atLeastConfident(s.confidence, minConfidence));
  const belowFloor = built - surviving.length;
  sessions.length = 0;
  sessions.push(...surviving);
  // The partition. `byLane` compares the lane first and the fused score only
  // when the lanes are equal, so no weight and no corpus can put a card-only
  // block above a block with transcript evidence in it. See {@link Lane}.
  //
  // FIX-F C3 — and the same sentence, applied to the other kind of summary.
  // `plans/phases/phase-10-agent-audit.md §B8` asks for "never outranking a
  // transcript hit"; the lane delivers that for cards and delivered nothing for
  // titles, because a title hit's lane is `evidence`. On the reference archive
  // five of ten threads matched **only** on their title and all five ranked
  // above the one thread whose transcript actually used the words. So the first
  // term of the comparator is now "does this block have anything quotable in
  // it", and the lane is the second — a strict refinement: nothing that `byLane`
  // ordered is reordered *within* a group, and a card-only block is
  // summary-only by construction, so the two terms never disagree.
  //
  // FIX-I C-1 — and the second term is now {@link byLabel} rather than
  // {@link byLane}. The lane and the fused score are still in it, at the end;
  // what is in front of them is the confidence word and the calibration score,
  // so the page's first row is its best row on the axis its own header
  // reports. Before this, `find --json`'s `sessions[0]` could be the sixth
  // best-calibrated row on the page while `potsherd_recall`, which applied
  // FIX-D's rule at its own door, returned the same nine blocks in a different
  // order. It is a strict refinement: within a confidence band and a
  // calibration score, `byLane`'s order is untouched.
  sessions.sort((a, b) => summaryRank(a.hits) - summaryRank(b.hits) || byLabel(a, b));
  sessions.length = Math.min(sessions.length, limit);
  const confidence = sessions.reduce<Confidence>(
    (best, s) => maxConfidence(best, s.confidence),
    'none',
  );

  // The flat list is every hit that is on the page, in fused order. It used to
  // be filtered by the *representative* session's id, which quietly threw away
  // exactly the hits clustering exists to keep: a subagent's match shown under
  // its parent's block was in `sessions[i].hits` and missing from `hits`, so
  // anything counting the flat array — a `--json` consumer, and two of this
  // repo's own tests — undercounted a clustered conversation and never saw a
  // sidechain. Take the blocks' own hits instead, so the two views cannot
  // disagree and every hit still names the session it came from.
  // FIX-I C-1, the same comparator on the flat list — which is what
  // `potsherd_recall`'s `hits[]` is built from, so the model door's rows and
  // the human door's rows are ordered by one function and not by two.
  const flat = [...sessions.flatMap((s) => s.hits)].sort(
    (a, b) => summaryRank([a]) - summaryRank([b]) || byLabel(a, b),
  );
  return {
    query,
    sessions,
    hits: flat,
    vectors,
    lists: listReports,
    k,
    weights: effectiveWeights,
    relaxedLists: [...relaxedLists],
    relaxed,
    ghostsOnly: ghosts === 'only',
    indexedGhosts: sessions.length === 0 ? countGhosts(db) : null,
    ignored,
    confidence,
    minConfidence,
    belowFloor,
    keyphrase: key,
    keyphraseLists: [...keyphraseLists],
    ms: Date.now() - started,
  };
}

/**
 * What kind of number a list's `raw` is, so it can be normalised against its
 * own list's best rather than against an absolute scale.
 *
 * `titles` is `flat`: {@link titleMatches} has already dropped every title
 * that did not match the query as well as the best one did, so every title hit
 * that reaches here is by construction the strongest of its kind and has no
 * magnitude left to compare.
 */
function rawKind(list: ListName): 'bm25' | 'cosine' | 'flat' {
  if (list === 'titles') return 'flat';
  return list.startsWith('vec_') ? 'cosine' : 'bm25';
}

// -------------------------------------------------------------- session meta

type SessionMeta = Omit<RecallSession, 'score' | 'hits' | 'calibration' | 'confidence'>;

/**
 * `sessionId -> conversationId`, where a subagent transcript's conversation is
 * the session that spawned it.
 *
 * One query for the whole candidate set rather than one per hit, and it
 * degrades to identity when `sessions` cannot answer — an id that is a ghost's,
 * or a subagent whose parent transcript was never indexed, is its own
 * conversation, which is the truthful answer in both cases.
 */
function conversationKeys(db: Db, ids: readonly string[]): (id: string) => string {
  const distinct = [...new Set(ids)];
  const parents = new Map<string, string>();
  if (distinct.length > 0) {
    try {
      const rows = db
        .prepare(
          `SELECT c.id AS id, c.parent_session_id AS parent
             FROM sessions c
             JOIN sessions p ON p.id = c.parent_session_id
            WHERE c.id IN (${distinct.map(() => '?').join(',')})
              AND c.parent_session_id IS NOT NULL`,
        )
        .all(...distinct) as { id: string; parent: string }[];
      for (const r of rows) parents.set(r.id, r.parent);
    } catch {
      // A conversation is a grouping, not an answer. If the lookup fails the
      // search still returns every hit it found, one block per session.
    }
  }
  return (id: string): string => parents.get(id) ?? id;
}

/**
 * Metadata for a mixed set of ids, some of which are sessions and some ghosts.
 * One query per table rather than one per id, because a `find` for a common
 * word touches thirty of them.
 */
export function sessionMeta(db: Db, ids: readonly string[]): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');

  const sessions = db
    .prepare(
      `SELECT s.id, s.harness, s.title, s.project, s.started_at, s.ended_at, s.status,
              s.is_sidechain, s.parent_session_id, s.agent_name, s.git_branch,
              s.user_prompts, s.assistant_turns, s.bytes,
              (SELECT c.title FROM cards c WHERE c.session_id = s.id) AS card_title,
              (SELECT COUNT(*) FROM exchanges e WHERE e.session_id = s.id) AS exchanges,
              (SELECT COUNT(*) FROM sessions c WHERE c.parent_session_id = s.id) AS subagents,
              (SELECT COUNT(*) FROM pins p WHERE p.session_id = s.id) AS pinned
         FROM sessions s WHERE s.id IN (${placeholders})`,
    )
    .all(...ids) as SessionRow[];
  for (const r of sessions) out.set(r.id, fromSessionRow(r));

  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const ghostRows = db
      .prepare(
        `SELECT g.session_id, g.harness, g.title, g.first_prompt, g.project,
                g.first_ts, g.last_ts, g.prompt_count, g.git_branch,
                (SELECT p.text FROM ghost_prompts p WHERE p.session_id = g.session_id
                   AND p.text NOT LIKE '/%' AND length(trim(p.text)) > 3
                 ORDER BY p.seq LIMIT 1) AS best_prompt,
                (SELECT COUNT(*) FROM pins p WHERE p.session_id = g.session_id) AS pinned
           FROM ghosts g WHERE g.session_id IN (${missing.map(() => '?').join(',')})`,
      )
      .all(...missing) as GhostRow[];
    for (const r of ghostRows) out.set(r.session_id, fromGhostRow(r));
  }
  return out;
}

export interface SessionRow {
  id: string;
  harness: Harness;
  title: string | null;
  /**
   * `cards.title`, when the session has been carded.
   *
   * Preferred over `sessions.title` wherever a session is named, which is
   * `phase-2` deliverable 4 read literally: *"card title preferred over
   * ai-title in all listings"*. The harness's own title is written a few turns
   * in, from what the session looked like it was going to be about; the card's
   * is written from the whole transcript and then checked against it. When
   * both exist the second one is the better name, and `browse.ts` has said so
   * since T2.4 — this makes `find` agree with `ls`.
   */
  card_title?: string | null;
  project: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: SessionStatus;
  is_sidechain: number;
  parent_session_id: string | null;
  agent_name: string | null;
  git_branch: string | null;
  user_prompts: number;
  assistant_turns: number;
  bytes: number;
  exchanges: number;
  subagents: number;
  pinned: number;
}

export interface GhostRow {
  session_id: string;
  harness: Harness;
  title: string | null;
  first_prompt?: string | null;
  /** The first prompt that is not a slash command — see `fromGhostRow`. */
  best_prompt?: string | null;
  project: string | null;
  first_ts: string | null;
  last_ts: string | null;
  prompt_count: number;
  git_branch: string | null;
  pinned: number;
}

export function fromSessionRow(r: SessionRow): SessionMeta {
  const carded = r.card_title?.replace(/\s+/g, ' ').trim();
  const title = carded || r.title;
  return {
    id: r.id,
    kind: 'session',
    harness: r.harness,
    title,
    displayTitle: displayTitleOf(title, r.project, r.id, r.harness),
    project: r.project,
    projectName: projectName(r.project),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    isSidechain: r.is_sidechain === 1,
    parentSessionId: r.parent_session_id,
    agentName: r.agent_name,
    gitBranch: r.git_branch,
    pinned: r.pinned > 0,
    prompts: r.user_prompts,
    exchanges: r.exchanges,
    subagents: r.subagents ?? 0,
    bytes: r.bytes,
    resume: resumeCommand(r.harness, r.id, r.status, r.parent_session_id),
  };
}

export function fromGhostRow(r: GhostRow): SessionMeta {
  return {
    id: r.session_id,
    kind: 'ghost',
    harness: r.harness,
    title: r.title,
    // Only 19 of the 299 ghosts on the reference machine ever got a title —
    // `sessions-index.json` is swept along with the transcript. What survives
    // in `history.jsonl` is the prompt the user typed, and "fix the canon
    // printer driver on macos" identifies a deleted session far better than
    // `macos_canon_driver-f7ac67c0` does. Untitled *sessions* keep the
    // `<slug>-<id8>` form (`03` T1.2) because they have an assistant side that
    // phase 2's card writer will name properly; a ghost never will.
    //
    // `best_prompt` skips the opening `/model`, `/login` and `/resume` — a
    // slash command is what the user typed *at* Claude Code, not *to* it, and
    // twelve ghosts all called `/model` is no better than twelve uuids.
    displayTitle: displayTitleOf(
      r.title ?? firstPromptTitle(r.best_prompt) ?? firstPromptTitle(r.first_prompt),
      r.project,
      r.session_id,
      r.harness,
    ),
    project: r.project,
    projectName: projectName(r.project),
    startedAt: r.first_ts,
    endedAt: r.last_ts,
    status: 'ghost',
    isSidechain: false,
    parentSessionId: null,
    agentName: null,
    gitBranch: r.git_branch,
    pinned: r.pinned > 0,
    prompts: r.prompt_count,
    exchanges: 0,
    subagents: 0,
    bytes: 0,
    resume: null,
  };
}

/** A ghost's opening prompt, cut to something a table column can hold. */
function firstPromptTitle(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 3) return null;
  return clean.length > 120 ? clean.slice(0, 120) : clean;
}

/**
 * A session's score from its hits: the best one, plus half of what the others
 * add.
 *
 * Neither extreme survives contact with a real corpus. Taking the **max**
 * ignores corroboration — a session that answers the question in five places
 * ranks level with one that mentions it once. Taking the **sum** rewards
 * volume: measured on the reference corpus, a 155-exchange session that
 * mentions a query word three times in passing outranked the two-exchange
 * session *named* after that word, which is the wrong answer by any human
 * reading. The corpus is not in this repository and the session is not
 * nameable here, so what is recorded is the shape and the two numbers; the
 * behaviour itself is pinned by `tests/recall.test.ts`.
 *
 * Halving the tail, and capping it at half the best hit, is the smallest thing
 * that says both: the strongest single piece of evidence decides, and
 * repetition breaks ties within that. A session can never score more than 1.5x
 * its own best hit.
 */
function sessionScore(hits: RecallHit[], cap: number = CORROBORATION): number {
  if (hits.length === 0) return 0;
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const best = sorted[0]!.score;
  const rest = sorted.slice(1).reduce((n, h) => n + h.score, 0);
  return best + Math.min(rest / 2, best * cap);
}

function titled(
  db: Db,
  tokens: string[],
  filters: SearchFilters,
  depth: number,
  reports: RecallResult['lists'],
): TitleList {
  const t0 = Date.now();
  let list: TitleList = { hits: [], coverage: 0 };
  try {
    list = titleMatches(db, tokens, filters, depth);
  } catch {
    list = { hits: [], coverage: 0 };
  }
  reports.push({ list: 'titles', candidates: list.hits.length, ms: Date.now() - t0 });
  return list;
}

/** How many ghosts the index holds. Zero means `rescue` has not run. */
function countGhosts(db: Db): number {
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM ghosts').get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}

/** Kept honest against `embeddings.EMBEDDING_VERSION` by the index. */
export const RECALL_EMBEDDING_VERSION = EMBEDDING_VERSION;
