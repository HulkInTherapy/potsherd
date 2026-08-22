import type { Harness } from './adapters/types.js';
import type { Db } from './db.js';
import { makeGate } from './cards/gate.js';
import {
  loadGhostTranscript,
  loadSessionTranscript,
  renderUnit,
  type Transcript,
  type TranscriptUnit,
} from './cards/transcript.js';
import {
  ASK_MODEL,
  Budget,
  BudgetError,
  CARD_MODEL,
  Llm,
  type Spend,
} from './llm.js';
import {
  openThreadCandidates,
  type OpenThread,
} from './open-threads.js';
// T6.6 D0b — the model pass is its own module now (see `open-threads-confirm.ts`).
import { confirmOpenThreads } from './open-threads-confirm.js';
import { idTag, projectName, recall, type RecallSession } from './recall.js';
import type { SearchFilters } from './search/filters.js';

/**
 * `potsherd ask` — the differentiator verb (`03` §8, phase-4 T4.1).
 *
 * ```
 *   recall ──▶ excerpts ──▶ readers ──▶ synthesizer ──▶ CITATION FILTER ──▶ answer
 *   (no model)  (no model)  (haiku,      (sonnet,        (no model)
 *                            parallel)    one call)
 * ```
 *
 * ## The filter is the product
 *
 * Everything above the last box is a model being asked to be careful. The last
 * box is the only part that is load-bearing, and it is arithmetic:
 *
 *   1. **A quote is kept only if it occurs.** Every evidence line the
 *      synthesizer proposes names a `(sessionId, seq)`. That pair is looked up
 *      in the *excerpt the reader was actually shown* — not the whole session,
 *      not the whole index — and the quote must appear in it verbatim after
 *      {@link normaliseQuote}. A paraphrase does not appear. A quote attributed
 *      to the wrong seq does not appear. A seq that was never in the excerpt
 *      does not resolve. All three are dropped.
 *   2. **A sentence is kept only if a surviving line still backs it.** After
 *      step 1, each sentence's citations are re-checked against what survived.
 *      A sentence left citing nothing goes to {@link AskResult.dropped} and is
 *      never part of {@link AskResult.answer}.
 *   3. **`answer` is `sentences.map(s => s.text).join(' ')`.** There is no
 *      second copy of the model's prose anywhere in this module, so there is no
 *      path by which an unfiltered sentence reaches a user. That is the reason
 *      the field is computed rather than carried.
 *   4. **Evidence nothing cites is dropped too**, and what remains is
 *      renumbered so `cites` stays 1-based and dense.
 *
 * This is `cards/verify.ts`'s discipline applied one layer up, and for the same
 * stated reason: a model asked "is this claim supported?" is the same machinery
 * that produced the claim, with the same willingness to be agreeable. The
 * cheapest honest check over a fixed seq lookup is string containment. It costs
 * no tokens, cannot be prompt-injected by the transcript it is checking, and
 * gives the same answer twice.
 *
 * A run where nothing is ever dropped is a bug report about this file.
 *
 * ## What it does not do
 *
 * It does not check that the quote *supports* the sentence — only that the
 * quote is real and is where the model said it was. Nothing here can stop a
 * model quoting accurately and reasoning badly. What it does stop is the
 * failure mode `05`'s honesty contract names: a fluent paragraph about your own
 * history with citations that do not exist. Under `--strict` an answer with
 * fewer than two surviving evidence lines is refused outright rather than
 * shown.
 */

// ------------------------------------------------------------------ knobs

/** `03` §8 / phase-4 risks: sessions read by default. `--k` is the knob. */
export const ASK_K = 6;

/**
 * The default ceiling, in dollars.
 *
 * `plans/phases/phase-4-ask-and-graft.md` proposed `--max-usd 0.10`. Five real
 * `k=6` runs measured **$0.037–$0.123** api-equivalent, so 0.10 fired *on
 * correct usage* — it aborted a normal run before the synthesizer, having
 * already paid for six readers. A cap that trips on the thing it is meant to
 * permit teaches users to pass `--max-usd` blindly, which is worse than no cap.
 *
 * Raised to 0.50 on that measurement (`04-DECISIONS.md`, 21 aug 2026): above
 * every run we have seen with real headroom, still a genuine ceiling.
 *
 * Note that on the subscription path this is an **estimate of api-equivalent
 * spend**, not money charged — the agent SDK reports a constant
 * `input_tokens: 10`, which `llm.ts` discards and labels `est.`
 */
export const ASK_MAX_USD = 0.5;

/** Model calls in flight at once. Concurrency 6 realises ~4.9x (`03` §12). */
export const ASK_CONCURRENCY = 6;

/** phase-4 T4.1: "capped at ~8k chars per session". */
export const ASK_SESSION_CHARS = 8_000;

/** Top-n exchanges per session, by hybrid score, before the ±1 neighbours. */
export const ASK_TOP_EXCHANGES = 4;

// ------------------------------------------------------- the cheap path
//
// 8.7. The default path is not narrowed to hit a number: `k = 6` is what the
// quality gate was measured at and `03` §12 records the wall-time miss as a
// miss rather than re-tuning `k` to fit. `--cheap` is a **second** path, chosen
// per question, that trades coverage for latency and is required to say so on
// every screen it prints (see `render/ask.ts`'s `cheapNote`).
//
// Three levers, in the order they matter:
//
//   1. **k = 3.** Wall time is dominated by one round of the reader fan-out,
//      not by the number of readers — concurrency 6 realises ~4.9x — so k
//      alone buys little. It is here because it also shrinks the synthesizer's
//      prompt, and because reading half as much is the honest half of the
//      trade the note has to disclose.
//   2. **a haiku-class synthesizer.** `ASK_MODEL` is sonnet-class; the
//      synthesizer is one serial call on the critical path *after* every
//      reader has returned, so its latency is added, never overlapped.
//   3. **cards-first.** Where a session already has a card, the reader is
//      handed the card plus the top-2 exchanges instead of an
//      {@link ASK_SESSION_CHARS}-character slice. The card is the expensive
//      reading already done once; re-reading 8 kB of transcript to rediscover
//      it is the part of the wait that was already paid for. Applied only
//      when it is genuinely smaller — see `loadTarget`, which costs both
//      forms and takes the cheaper, because on short sessions a 900-character
//      card added to a 1 kB slice sends *more* than the path it replaces.
//
// What does **not** change: the reader contract, {@link filterAnswer}, and the
// rule that a quote is checked against the excerpt the reader was shown. The
// card is context and is never citable — a quote from it resolves to no unit
// and is dropped like any other unsourced line. That is why `--cheap` can be
// faster without being a different product: it reads less, and what it does
// say is grounded the same way.

/** `--cheap`: sessions read. Never lower than this. */
export const ASK_CHEAP_K = 3;

/** `--cheap`: the synthesizer, haiku-class rather than {@link ASK_MODEL}. */
export const ASK_CHEAP_MODEL = CARD_MODEL;

/** `--cheap`: exchanges per session when a card carries the context. */
export const ASK_CHEAP_TOP_EXCHANGES = 2;

/**
 * `--cheap`: the slice a carded session gets, in characters.
 *
 * Only ever applied **with** a card, and only when card plus slice comes to
 * less than the full slice would have. A session with no card keeps the full
 * {@link ASK_SESSION_CHARS} slice under `--cheap` too, because there is then
 * nothing standing in for what the cut would remove, and a reader given a
 * third of a transcript and no summary of the rest is the shape of a miss the
 * user cannot see. See `loadTarget` for why the size check is there.
 */
export const ASK_CHEAP_SESSION_CHARS = 3_000;

/** The card block handed to a reader, capped. Context, never citable. */
export const ASK_CARD_CHARS = 900;

/** How deep recall looks so `matching` can be reported honestly. */
export const ASK_SCAN = 50;

/**
 * phase-4 T4.1: the word ceiling for ANSWER, **enforced in code**.
 *
 * It was prompt-only for the whole of T4.1: the number appeared in the
 * synthesizer's instructions and nowhere else, and `tests/ask.test.ts` pinned
 * the literal with `toBe(150)` without anything checking an answer against it.
 * A real run came back at **163 words**, a 17-line ANSWER block and 40 lines
 * total, against `05`'s "legible whole at 80x24".
 *
 * Asking a model nicely is not how any other rule in this file works. A
 * sentence without a resolving citation is dropped by {@link filterAnswer},
 * not by the prompt, for exactly the reason `plans/08` rule 1 gives: the model
 * is not the thing that makes the claim true. So this is enforced the same
 * way, by {@link trimToWordBudget}, and the prompt keeps the number only as a
 * hint that saves a round trip.
 */
export const ANSWER_MAX_WORDS = 150;

/** `--strict` refuses below this many surviving evidence lines. */
export const STRICT_MIN_EVIDENCE = 2;

/**
 * The shortest run of characters that may be offered as a quote.
 *
 * Without a floor the filter is trivially satisfiable: `"the"` occurs in every
 * exchange ever written, so a synthesizer could cite one word per sentence and
 * clear every check in this file. Sixteen characters is long enough that a
 * match is about the passage rather than about English.
 */
export const MIN_QUOTE_CHARS = 16;

// ------------------------------------------------------------------ types

export interface AskEvidence {
  /** 1-based; what an ANSWER sentence cites. Dense after filtering. */
  index: number;
  sessionId: string;
  id8: string;
  project: string;
  harness: Harness;
  seq: number;
  ts: string;
  /** Full here; the renderer truncates to ~90 characters. */
  quote: string;
  isSidechain: boolean;
  isGhost: boolean;
}

/** `cites` index into {@link AskResult.evidence}. Never empty on a kept sentence. */
export interface AskSentence {
  text: string;
  cites: number[];
}

export interface AskReaderReport {
  sessionId: string;
  id8: string;
  found: boolean;
  quotes: number;
  ms: number;
  /**
   * Present when the reader never answered — a timeout, a dead backend, a
   * budget ceiling. Such a reader reports `found: false` and the run
   * continues (phase-4 ruling: one dead reader must not fail the verb), but
   * "did not answer" and "read it and found nothing" are different facts and
   * a receipt that conflates them is lying about coverage.
   */
  error?: string;
}

/**
 * Why a run refused, when it did. `null` on a run that answered.
 *
 * `refused` on its own is not enough to print an honest line. Three different
 * things set it — `--strict` with too little evidence, the `--max-usd` ceiling
 * reached by the readers alone, and a shortlist nothing answered — and they
 * are **not distinguishable from the rest of `AskResult`**: a strict refusal
 * blanks `sentences` and `evidence`, which is exactly what a cost abort leaves
 * behind too. The first version of the renderer guessed, and told a user whose
 * run had stopped at ten cents that "fewer than 2 quotes survived the citation
 * check" — a sentence about their archive that was not true. So the reason is
 * carried rather than inferred.
 */
export type AskRefusal =
  /** `--strict` and fewer than {@link STRICT_MIN_EVIDENCE} lines survived. */
  | 'strict'
  /** The readers alone reached `--max-usd`; the synthesizer never ran. */
  | 'budget'
  /** Sessions were read and none of them addressed the question. */
  | 'no-answer'
  /** Nothing in the index matched at all. */
  | 'no-match';

export interface AskResult {
  question: string;
  /** `sentences.map(s => s.text).join(' ')`. Computed, never carried. */
  answer: string;
  sentences: AskSentence[];
  /** Sentences the code dropped for want of a citation. Never in `answer`. */
  dropped: string[];
  /**
   * Whole sentences cut from the tail to hold {@link ANSWER_MAX_WORDS}, in the
   * order they were written. Separate from {@link AskResult.dropped} because
   * the two are not the same event and the render says so: a dropped sentence
   * failed the citation check, a trimmed one passed it and did not fit.
   */
  trimmed: string[];
  evidence: AskEvidence[];
  openThreads: OpenThread[];
  /** Sessions actually read by a reader. */
  searched: number;
  /** Sessions that matched before the k cap. */
  matching: number;
  readers: AskReaderReport[];
  /** `--strict` and fewer than {@link STRICT_MIN_EVIDENCE} lines survived. */
  refused: boolean;
  /** Why, when `refused`. See {@link AskRefusal}. */
  refusal: AskRefusal | null;
  strict: boolean;
  spend: Spend;
  /** True if any figure in `spend` is `est.` (`05` honesty contract). */
  estimated: boolean;
  /**
   * 8.7: this run took the `--cheap` path and read less of the archive.
   *
   * Carried on the result rather than left to the caller to remember, for the
   * same reason {@link AskResult.refusal} is: the renderer must print the
   * trade-off line on **every** `--cheap` screen, including the ones that
   * refuse or find nothing, and a screen that cannot tell whether it was a
   * narrow read is a screen that will eventually forget to say so.
   */
  cheap: boolean;
  ms: number;
}

// ------------------------------------------------------------ reader seam

/** One session's excerpts, as a reader sees them. */
export interface AskReaderInput {
  question: string;
  sessionId: string;
  id8: string;
  project: string;
  harness: Harness;
  isSidechain: boolean;
  /**
   * True when the excerpts are prompts only because Claude Code's sweep
   * deleted the assistant's side. A reader that is not told this will write
   * "we decided X" about a conversation whose reply nobody has.
   */
  isGhost: boolean;
  /** `[seq n · date]` + text, in seq order, already capped and redacted at rest. */
  excerpts: string;
  /** The seq numbers in `excerpts`, so a caller can check what it may cite. */
  seqs: number[];
  /**
   * 8.7 cards-first: this session's card, as context, when `--cheap` found one.
   *
   * **Not citable, and that is structural rather than a request.** A card is
   * the model's own prose about the transcript; it has no `seq`, so a quote
   * taken from it resolves to no unit in {@link filterAnswer} and is dropped
   * with the sentence that leaned on it. The reader is told so in the prompt
   * only to save the round trip, not because the prompt is what enforces it.
   *
   * Absent on the default path and on any session that has no card.
   */
  card?: string;
}

export interface AskReaderQuote {
  seq: number;
  ts: string | null;
  text: string;
}

export interface AskReaderOutput {
  found: boolean;
  quotes: AskReaderQuote[];
  answer_fragment: string;
}

/**
 * T4.4 — the seam that lets the phase-5 Claude Code plugin run the readers with
 * the native Agent tool instead of the SDK, at zero marginal cost.
 *
 * `ask()` calls this once per shortlisted session, in parallel, and treats a
 * rejected promise exactly as it treats a dead backend: that session reports
 * `found: false` with an `error`, and the run continues. An implementation is
 * therefore free to fail loudly.
 *
 * The contract is the plan's, verbatim: *given one session's excerpts with seq
 * numbers, answer the question using only quotes from the excerpts; if the
 * excerpts do not address the question, `found: false` and nothing else.* An
 * implementation cannot loosen it — every quote it returns is re-checked
 * against the excerpt by {@link filterAnswer} before a user sees it.
 */
export type AskReaderFn = (input: AskReaderInput) => Promise<AskReaderOutput>;

// ---------------------------------------------------------------- options

export type AskStep = 'shortlist' | 'read' | 'synthesize' | 'filter' | 'threads';

export interface AskProgress {
  step: AskStep;
  done: number;
  total: number;
  /** Running spend, so the CLI can show cost live without its own arithmetic. */
  spend: Spend;
  detail?: string;
  /**
   * 8.7: on `step: 'read'`, the reader that just returned — id, verdict and
   * its own elapsed time.
   *
   * The counters above say *how many* have come back; a user waiting 40 to 180
   * seconds on six model calls is watching for *which*, and for whether the
   * archive is producing evidence or silence. `done`/`total` alone is a
   * spinner with numbers on it. This field is what lets the CLI print one line
   * per reader as evidence arrives, and it carries the report rather than a
   * pre-rendered string so the renderer owns the shape, the width and the
   * `--ascii` fold.
   *
   * Emitted for every reader, including one that failed: `error` set is the
   * difference between "read it and found nothing" and "never answered", and
   * a progress line that conflates them is the same lie the `nothing()`
   * renderer was fixed for.
   */
  reader?: AskReaderReport;
}

export type AskDropReason =
  /** The line named a session no reader was given. */
  | 'unknown-session'
  /** The seq is not in that session's excerpt. */
  | 'unresolved-seq'
  /** The seq resolves and does not contain the quote: a paraphrase, or a mis-attribution. */
  | 'not-a-quote'
  /** Shorter than {@link MIN_QUOTE_CHARS} after normalisation. */
  | 'too-short'
  /** Real, resolved, and no surviving sentence cites it. */
  | 'uncited'
  /** A sentence left citing nothing that survived. */
  | 'no-citation'
  /** A whole sentence cut from the tail to hold {@link ANSWER_MAX_WORDS}. */
  | 'over-budget';

export interface AskDrop {
  kind: 'evidence' | 'sentence';
  reason: AskDropReason;
  text: string;
  sessionId?: string;
  seq?: number;
}

export interface AskOptions {
  filters?: SearchFilters;
  k?: number;
  /**
   * 8.7 `--cheap`: {@link ASK_CHEAP_K} sessions, a haiku-class synthesizer, and
   * cards-first excerpts. An explicit `k`, `model` or `readerModel` still
   * wins — this only moves the defaults.
   */
  cheap?: boolean;
  strict?: boolean;
  maxUsd?: number;
  /** Synthesizer model. Default {@link ASK_MODEL} (sonnet-class). */
  model?: string;
  /** Reader model. Default {@link CARD_MODEL} (haiku-class). */
  readerModel?: string;
  concurrency?: number;
  /** potsherd root, so the embedding model is found under `--potsherd-dir`. */
  root?: string;
  vectors?: boolean | 'auto';
  /** Share one budget across readers and synthesizer. Made here otherwise. */
  budget?: Budget;
  /** Test seam / caller-owned backends. Closed by the caller, not by `ask`. */
  llm?: Llm;
  readerLlm?: Llm;
  /** T4.4: run the readers somewhere else. See {@link AskReaderFn}. */
  readerFn?: AskReaderFn;
  /** Off for tests that are measuring something else. */
  openThreads?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: AskProgress) => void;
  onDrop?: (d: AskDrop) => void;
}

// ------------------------------------------------------------ quote checks

/**
 * The normalisation a quote survives, and nothing more.
 *
 * Three things are folded, and each one is a *rendering* difference rather
 * than a wording difference — which is the whole test for whether a fold is
 * allowed here:
 *
 *   - **whitespace**, because a model retyping a quote out of a transcript
 *     re-wraps it, and the plan names this fold explicitly;
 *   - **case**, because `"We disabled"` at the start of a sentence and
 *     `"we disabled"` mid-paragraph are the same words;
 *   - **the typographic glyphs an editor substitutes** — curly quotes,
 *     en/em dashes, the ellipsis — because a model that renders `'` as `’` has
 *     not changed what was said.
 *
 * Nothing else is folded. Punctuation stays, word order stays, and every word
 * stays, so a paraphrase cannot survive this and neither can a summary. If a
 * fourth fold is ever added it has to pass the same test, or the filter stops
 * meaning what this file says it means.
 */
export function normaliseQuote(s: string): string {
  return normaliseIndexed(s).text;
}

/**
 * The folds. Each one is a **rendering** difference rather than a wording
 * difference, which is the whole test for whether a fold may be here:
 *
 *   - **whitespace**, because a model retyping a quote out of a transcript
 *     re-wraps it, and the plan names this fold explicitly;
 *   - **case**, because `"We disabled"` at the start of a sentence and
 *     `"we disabled"` mid-paragraph are the same words;
 *   - **the typographic glyphs an editor substitutes** — curly quotes, the
 *     dash family, the ellipsis — because a model that renders `'` as `’` has
 *     not changed what was said.
 *
 * Nothing else is folded. Punctuation stays, word order stays, every word
 * stays, so neither a paraphrase nor a summary can survive it.
 *
 * **Folding is only ever used to find the passage.** What is then emitted as
 * the evidence quote is the transcript's own bytes at that span, never the
 * model's retyping of them — see {@link matchSpan}. A tool that lowercases
 * somebody's quote has changed the record even when it changed no words.
 */
const GLYPH_FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
  '―': '-', '−': '-',
  '…': '...',
};

interface Indexed {
  text: string;
  /** For each character of `text`, where the source character starts. */
  from: number[];
  /** ...and where it ends. Two arrays, so a surrogate pair is never cut. */
  to: number[];
}

function normaliseIndexed(s: string): Indexed {
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  let pendingSpace = false;
  for (const ch of s) {
    const start = i;
    i += ch.length;
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(' ');
      from.push(start);
      to.push(start);
      pendingSpace = false;
    }
    const folded = GLYPH_FOLD[ch] ?? ch.toLowerCase();
    for (const c of folded) {
      out.push(c);
      from.push(start);
      to.push(i);
    }
  }
  return { text: out.join(''), from, to };
}

/**
 * Where `quote` occurs in `text`, as a span of **the original string**.
 *
 * The search runs over the folded forms; the answer is in source coordinates,
 * so the caller can slice the transcript's own bytes back out. That is what
 * makes the emitted evidence a quotation rather than a rendering of one, and
 * it is the difference between `"We set statement_cache_size=0"` and
 * `"we set statement_cache_size=0"` on the screen.
 */
export function matchSpan(quote: string, text: string): { start: number; end: number } | null {
  const q = normaliseIndexed(quote);
  if (q.text.length < MIN_QUOTE_CHARS) return null;
  const hay = normaliseIndexed(text);
  const at = hay.text.indexOf(q.text);
  if (at < 0) return null;
  const start = hay.from[at]!;
  const end = hay.to[at + q.text.length - 1]!;
  return { start, end };
}

/** Does `quote` actually occur in `text`? The whole filter, in one line. */
export function quoteOccursIn(quote: string, text: string): boolean {
  return matchSpan(quote, text) !== null;
}

/**
 * The text a quote is checked against, and sliced out of.
 *
 * `unitText()` labels the two sides of an exchange — `user: …\n\nassistant: …`
 * — because that is what a model reads well. The **index** holds them as two
 * columns, and any later check of a citation (the ask evals do exactly this)
 * looks them up as `user_text + "\n" + assistant_text` with no labels at all.
 * If the quote were taken from the labelled form, a quote that happened to
 * span the join would carry the word `assistant:` — text that is in no
 * exchange — and would fail every downstream check while being, in every sense
 * that matters, a real quotation.
 *
 * So the labels are removed before matching. What comes out is a literal
 * substring of the stored exchange.
 */
export function quotableText(unitText: string): string {
  return unitText.replace(/^user:[ \t]*/, '').replace(/\n\nassistant:[ \t]*/, '\n');
}

/** `cards/transcript.ts`'s marker for a unit whose middle was cut. */
const ELIDED_MIDDLE = /characters elided\]/;

// ----------------------------------------------------------- the filter

/** What the synthesizer proposed, before any of it was checked. */
export interface ProposedEvidence {
  /** The number the synthesizer's sentences cite. Not necessarily dense. */
  index: number;
  sessionId: string;
  seq: number;
  quote: string;
  ts?: string | null;
}

export interface ProposedSentence {
  text: string;
  cites: number[];
}

/** Everything the filter needs to know about a session it may cite. */
export interface EvidenceSource {
  sessionId: string;
  id8: string;
  project: string;
  harness: Harness;
  isSidechain: boolean;
  isGhost: boolean;
  /** The excerpt units the reader was shown. Nothing else is citable. */
  units: readonly TranscriptUnit[];
}

export interface FilterOutput {
  sentences: AskSentence[];
  dropped: string[];
  /** See {@link AskResult.trimmed}. */
  trimmed: string[];
  evidence: AskEvidence[];
  drops: AskDrop[];
}

/** Words, the way a reader counts them: runs of non-space. */
export function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}

/**
 * Hold {@link ANSWER_MAX_WORDS} by dropping **whole trailing sentences**.
 *
 * The choice, and why it is the only honest one available here:
 *
 *   - **Truncating mid-thought is its own dishonesty.** "We moved the pooler
 *     to transaction mode because prepared statements were" is a sentence that
 *     says something different from the one the evidence supports, and it
 *     would carry a citation while doing it. Every other rule in this file
 *     exists to stop the printed text saying more than the transcript does;
 *     a cut sentence makes it say something else entirely.
 *   - **A trailing sentence is individually droppable.** Each one carries its
 *     own `cites`, was already checked against a resolving quote on its own,
 *     and is not depended on by the sentences before it. Dropping one leaves
 *     the rest exactly as true as it was.
 *   - **Trailing, not best-fit.** Taking sentences out of the middle to fit
 *     more in would reorder an argument the model built in sequence. The tail
 *     is where a synthesizer puts its recap, so the tail is the cheapest cut.
 *
 * **The first sentence is never dropped.** If one sentence alone exceeds the
 * budget, the answer is one over-long sentence rather than nothing: an empty
 * ANSWER block is a silent refusal, and `05`'s honesty contract has a real
 * refusal path (`--strict`) that says so out loud instead. This is a cap on
 * how much is said, not a licence to say nothing.
 */
export function trimToWordBudget(
  sentences: readonly AskSentence[],
  maxWords: number = ANSWER_MAX_WORDS,
): { kept: AskSentence[]; trimmed: string[] } {
  const kept: AskSentence[] = [];
  const trimmed: string[] = [];
  let words = 0;
  for (const s of sentences) {
    // Once the budget is spent the rest of the tail goes with it, including a
    // short sentence that would have squeezed in. A six-word recap that
    // survives because it is short, printed straight after the sentence that
    // was supposed to explain it, reads as a non-sequitur — and "the answer
    // stops here" is easier to trust than "the answer stops here except for
    // the short bits".
    if (trimmed.length > 0) {
      trimmed.push(s.text);
      continue;
    }
    const n = wordCount(s.text);
    // `kept.length === 0`: the first sentence goes in whatever it costs.
    if (kept.length > 0 && words + n > maxWords) {
      trimmed.push(s.text);
      continue;
    }
    kept.push(s);
    words += n;
  }
  return { kept, trimmed };
}

/**
 * The code-level citation filter. No model, no database, no clock.
 *
 * Pure on purpose: this is the function the product's central claim rests on,
 * so it has to be testable with a hand-written adversarial fixture and no
 * backend at all. `tests/ask.test.ts` drives it directly with a fabricated
 * seq, a fabricated quote, a paraphrase, and a synthesizer that cites nothing.
 */
export function filterAnswer(
  proposedSentences: readonly ProposedSentence[],
  proposedEvidence: readonly ProposedEvidence[],
  sources: readonly EvidenceSource[],
): FilterOutput {
  const drops: AskDrop[] = [];
  const bySession = new Map<string, { src: EvidenceSource; units: Map<number, TranscriptUnit> }>();
  for (const s of sources) {
    const units = new Map<number, TranscriptUnit>();
    for (const u of s.units) units.set(u.seq, u);
    bySession.set(s.sessionId, { src: s, units });
  }

  // ---- 1. every proposed line, against the excerpt the reader was shown.
  //
  // `survivors` is keyed by the synthesizer's own numbering so the sentences
  // can be re-checked against it. A duplicate index is a malformed reply and
  // the first one wins; the second is simply not addressable.
  const survivors = new Map<number, AskEvidence>();
  for (const p of proposedEvidence) {
    const hit = bySession.get(p.sessionId);
    const note = (reason: AskDropReason): void => {
      drops.push({
        kind: 'evidence',
        reason,
        text: p.quote,
        sessionId: p.sessionId,
        seq: p.seq,
      });
    };
    if (!hit) {
      note('unknown-session');
      continue;
    }
    const src = hit.src;
    const unit = hit.units.get(p.seq);
    if (!unit) {
      note('unresolved-seq');
      continue;
    }
    if (normaliseQuote(p.quote).length < MIN_QUOTE_CHARS) {
      note('too-short');
      continue;
    }
    const body = quotableText(unit.text);
    const span = matchSpan(p.quote, body);
    if (!span) {
      note('not-a-quote');
      continue;
    }
    // The transcript's own bytes, not the model's retyping of them. Anything
    // the model changed on the way — the case of the first letter, a curly
    // apostrophe, a re-wrap — is undone here rather than forgiven, so the
    // printed quote is a literal substring of the stored exchange and stays
    // one for anybody who checks it later.
    const exact = body.slice(span.start, span.end);
    // A unit long enough to have had its middle cut carries a marker where the
    // cut is (`cards/transcript.ts`). A span that swallowed the marker is a
    // quote of two passages with a hole between them presented as one, which
    // is a fabrication the arithmetic would otherwise wave through.
    if (ELIDED_MIDDLE.test(exact)) {
      note('not-a-quote');
      continue;
    }
    if (survivors.has(p.index)) continue;
    survivors.set(p.index, {
      index: p.index,
      sessionId: src.sessionId,
      id8: src.id8,
      project: src.project,
      harness: src.harness,
      seq: p.seq,
      // The transcript's timestamp, not the model's. A model that invents a
      // date beside a real quote is still inventing, and the store has the
      // real one.
      ts: unit.ts ?? p.ts ?? '',
      quote: exact.replace(/\s+/g, ' ').trim(),
      isSidechain: src.isSidechain,
      isGhost: src.isGhost,
    });
  }

  // ---- 2. every sentence, against what survived step 1.
  const kept: { text: string; cites: number[] }[] = [];
  const dropped: string[] = [];
  for (const s of proposedSentences) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const cites = dedupe(s.cites.filter((c) => survivors.has(c)));
    if (cites.length === 0) {
      dropped.push(text);
      drops.push({ kind: 'sentence', reason: 'no-citation', text });
      continue;
    }
    kept.push({ text, cites });
  }

  // ---- 2b. the word budget, in code.
  //
  // Before step 3 on purpose. Trimming after the renumbering would leave the
  // EVIDENCE block carrying quotes for sentences that are no longer printed —
  // the citations would outlive the claims, the numbering would have gaps, and
  // the block would be longer than the answer it belongs to. Cutting here
  // means a trimmed sentence's evidence falls out through the `uncited` path
  // below like any other evidence nothing cites, and the receipt shrinks with
  // the answer instead of contradicting it.
  const budget = trimToWordBudget(kept);
  for (const text of budget.trimmed) {
    drops.push({ kind: 'sentence', reason: 'over-budget', text });
  }
  // A new binding rather than mutating `kept` in place. Emptying and refilling
  // the array is correct only while `trimToWordBudget` returns a fresh one, and
  // that is an invariant living in another function — it aliased on the first
  // attempt at this and silently produced an empty answer.
  const within = budget.kept;

  // ---- 3. evidence nothing cites, and the renumbering.
  const citedOld = new Set<number>();
  for (const s of within) for (const c of s.cites) citedOld.add(c);
  for (const [oldIndex, ev] of survivors) {
    if (!citedOld.has(oldIndex)) {
      drops.push({
        kind: 'evidence',
        reason: 'uncited',
        text: ev.quote,
        sessionId: ev.sessionId,
        seq: ev.seq,
      });
    }
  }

  // Order is the order the answer first refers to them, so a reader following
  // [1] then [2] down the EVIDENCE block reads them in the order the prose
  // used them rather than in whatever order the model happened to list them.
  const order: number[] = [];
  for (const s of within) for (const c of s.cites) if (!order.includes(c)) order.push(c);

  const remap = new Map<number, number>();
  const evidence: AskEvidence[] = order.map((oldIndex, i) => {
    remap.set(oldIndex, i + 1);
    return { ...survivors.get(oldIndex)!, index: i + 1 };
  });

  const sentences: AskSentence[] = within.map((s) => ({
    text: s.text,
    cites: dedupe(s.cites.map((c) => remap.get(c)!)).sort((a, b) => a - b),
  }));

  return { sentences, dropped, trimmed: budget.trimmed, evidence, drops };
}

function dedupe(ns: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of ns) {
    if (Number.isInteger(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// ------------------------------------------------------------- excerpts

/**
 * One session's slice: the top-scoring exchanges, each with its neighbours,
 * capped at {@link ASK_SESSION_CHARS}.
 *
 * The ±1 neighbour is not padding. A decision is routinely stated in the reply
 * to the exchange that raised it, and a hit on "should we disable prepared
 * statements" with the answer cut off is the shape of a citation that resolves
 * and says nothing.
 */
export function excerptUnits(
  transcript: Transcript,
  seqs: readonly number[],
  o: { top?: number; maxChars?: number } = {},
): TranscriptUnit[] {
  const top = o.top ?? ASK_TOP_EXCHANGES;
  const maxChars = o.maxChars ?? ASK_SESSION_CHARS;
  const byIndex = new Map<number, number>();
  transcript.units.forEach((u, i) => byIndex.set(u.seq, i));

  // Hits first, then neighbours. The order is the whole budget policy: with a
  // flat "hit, its neighbours, next hit, its neighbours" order, one 8 kB
  // opening prompt fills the slice and the second and third matching
  // exchanges never reach the reader at all. Measured on the reference
  // corpus: a session whose hits were seqs 2, 13 and 20 sent seq 2 alone.
  const hits: number[] = [];
  for (const seq of seqs.slice(0, top)) {
    const i = byIndex.get(seq);
    if (i !== undefined && !hits.includes(i)) hits.push(i);
  }
  const neighbours: number[] = [];
  for (const i of hits) {
    for (const j of [i - 1, i + 1]) {
      if (j >= 0 && j < transcript.units.length && !hits.includes(j) && !neighbours.includes(j)) {
        neighbours.push(j);
      }
    }
  }
  // A session that matched on its title or its card has no exchange seq at
  // all. Reading its opening is better than reading nothing, and the reader
  // is free to answer `found: false`.
  if (hits.length === 0) {
    for (let i = 0; i < Math.min(3, transcript.units.length); i++) hits.push(i);
  }

  const priority = [...hits, ...neighbours];
  const admitted = new Map<number, TranscriptUnit>();
  let remaining = maxChars;
  let left = priority.length;
  for (const i of priority) {
    const u = transcript.units[i]!;
    // Each remaining unit's fair share of what is left, floored so that a long
    // tail of neighbours cannot squeeze a unit down to nothing. A unit shorter
    // than its share hands the difference to the ones after it.
    const share = Math.max(MIN_UNIT_CHARS, Math.floor(remaining / Math.max(1, left)));
    const body = u.text.length > share ? renderUnitBody(u, share) : u.text;
    left -= 1;
    if (body.length + UNIT_HEADER_CHARS > remaining && admitted.size > 0) continue;
    admitted.set(i, body === u.text ? u : { ...u, text: body });
    remaining -= body.length + UNIT_HEADER_CHARS;
    if (remaining <= 0) break;
  }

  return [...admitted.keys()].sort((a, b) => a - b).map((i) => admitted.get(i)!);
}

/** The floor on one unit's share of the slice. Below this an excerpt is noise. */
export const MIN_UNIT_CHARS = 700;

/** `[seq 12 · 2026-08-21]\n` — what `unitHeader` costs, budgeted for. */
const UNIT_HEADER_CHARS = 24;

function renderUnitBody(u: TranscriptUnit, maxChars: number): string {
  // `renderUnit` prepends the `[seq n · date]` header; the body is what the
  // filter matches against, so the header is stripped back off.
  const rendered = renderUnit(u, maxChars);
  return rendered.slice(rendered.indexOf('\n') + 1);
}

/** The excerpt block a reader is handed. */
export function excerptText(units: readonly TranscriptUnit[]): string {
  return units.map((u) => renderUnit(u)).join('\n\n');
}

// -------------------------------------------------------------- prompts

/**
 * phase-4 T4.1's reader contract. The first paragraph is the plan's wording,
 * verbatim; the rest calibrates it, and the calibration was earned.
 *
 * The first version of this prompt was the plan's paragraph plus the penalty
 * for a bad quote — *"a quote that does not appear is discarded by code and
 * the claim goes with it"*. Measured on the reference corpus, that reads as an
 * instruction to be silent: six readers over a question whose answer sat in
 * exchange 16 of session 819606f3 returned `found: false` six times, one of
 * them after 3,596 output tokens of deliberation. A reader that refuses is
 * indistinguishable, on the screen, from a corpus that has nothing — which is
 * the one confusion `05`'s honesty contract cannot afford, because it turns a
 * timid model into a false statement about the user's own history.
 *
 * So the middle paragraph says out loud when `found: false` is correct and
 * when it is not. The penalty stays, because it is true, but it is no longer
 * the last thing the model reads.
 *
 * None of this is a guarantee and it is not meant to be. The guarantee is
 * {@link filterAnswer}, which re-checks every quote this produces.
 */
export const READER_SYSTEM =
  'You are given one session\'s excerpts with seq numbers. Answer the question using only ' +
  'quotes from the excerpts. Output json {found: bool, quotes:[{seq, ts, text}], ' +
  'answer_fragment}. If the excerpts do not address the question, found=false and nothing else.\n\n' +
  'Set found=true whenever any excerpt bears on the question at all — a partial answer, a ' +
  'related decision, the question being raised and left open, or evidence that the question\'s ' +
  'premise is wrong. Quote what is there and say what is missing in answer_fragment; do not ' +
  'withhold a real quote because it is not the whole answer. found=false is for excerpts that ' +
  'are about a different subject.\n\n' +
  'Every quote must be copied character for character from an excerpt and must carry the seq ' +
  'number of the excerpt it was copied from. Do not paraphrase inside a quote. Do not quote ' +
  'from memory. A quote that does not appear in the excerpts is discarded by code before ' +
  'anyone reads it, and the claim it was meant to support is discarded with it. Two to four ' +
  'short quotes is the right size for an answer.';

/**
 * 8.7 cards-first: what a reader is told about the card block.
 *
 * The card is context and is not evidence. A reader that quotes it produces a
 * line {@link filterAnswer} cannot resolve — a card has no `seq` — and the
 * sentence leaning on it is dropped with it, so a reader that treats the card
 * as quotable simply answers less. Saying so here saves that round trip; it is
 * not what makes it true.
 */
export const READER_CARD_NOTE =
  'A CARD for this session is included above the excerpts. It is a previously written summary ' +
  'of the whole session and it is CONTEXT ONLY: use it to understand what the session was ' +
  'about and which exchange to look in. Never quote from the card. Every quote must come from ' +
  'the numbered excerpts, which are the only citable text. If the card names a decision whose ' +
  'exchange is not in the excerpts, say so in answer_fragment rather than quoting the card.';

export const READER_GHOST_NOTE =
  'These excerpts are PROMPTS ONLY. This session was deleted by Claude Code\'s 30-day sweep and ' +
  'rebuilt from history; the assistant\'s replies are gone and are not recoverable. You may say ' +
  'what was asked. You may not say, or imply, what was answered or what was done.';

export const SYNTH_SYSTEM =
  'You are given what several readers found in separate sessions of one person\'s coding-agent ' +
  'history, each quote carrying the session it came from and its seq number.\n\n' +
  'Write an ANSWER of at most ' +
  ANSWER_MAX_WORDS +
  ' words, as a list of sentences. Build an EVIDENCE list first: each entry is one verbatim ' +
  'quote copied from a reader, with the session_id and seq that reader gave it. Then write the ' +
  'sentences, and give every sentence the evidence numbers that support it.\n\n' +
  'Rules that are enforced by code after you reply, not by trust:\n' +
  '  - a quote is checked against the exchange it names. A quote that was paraphrased, ' +
  'shortened in the middle, or attributed to the wrong seq is deleted.\n' +
  '  - a sentence whose evidence was all deleted is itself deleted and never shown.\n' +
  '  - so: assert nothing you cannot quote, and quote nothing you did not receive.\n' +
  'Prefer fewer, well-supported sentences over a complete-sounding answer. If the readers do ' +
  'not settle the question, say so in one sentence and cite what they did find. Where the only ' +
  'evidence is from a ghost session (prompts only), say that the assistant\'s side is not ' +
  'recoverable rather than implying it is known.';

const SYNTH_SCHEMA =
  '{"evidence":[{"n":1,"session_id":"<the session_id given with the quote>",' +
  '"seq":<number>,"quote":"<verbatim>"}],' +
  '"answer":[{"text":"<one sentence>","cites":[1,2]}]}';

const READER_SCHEMA =
  '{"found":true|false,"quotes":[{"seq":<number>,"ts":"<the ts given>","text":"<verbatim>"}],' +
  '"answer_fragment":"<one or two sentences, or empty when found is false>"}';

// ------------------------------------------------------------------- ask


/**
 * What a run cost, summed across every backend handle it used.
 *
 * Not `Budget.spend` directly, and the difference is not cosmetic. `ask` opens
 * two handles — haiku for the readers, sonnet for the synthesizer — and a
 * caller (the eval harness, the phase-5 plugin, a test) may pass in either or
 * both already open with a budget of its own. Reading one `Budget` would then
 * report zero for a run that spent, and summing every handle's budget would
 * double-count the common case where the two share one. So: distinct `Budget`
 * objects, each measured as a **delta** from where it stood when `ask` started,
 * which is also what makes the figure a cost for *this question* rather than a
 * running total for the process.
 */
class SpendMeter {
  private readonly bases = new Map<Budget, Spend>();

  track(llm: Llm): void {
    if (!this.bases.has(llm.budget)) this.bases.set(llm.budget, { ...llm.budget.spend });
  }

  get total(): Spend {
    const out: Spend = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      ms: 0,
      estimatedInputCalls: 0,
    };
    for (const [budget, base] of this.bases) {
      const now = budget.spend;
      out.calls += now.calls - base.calls;
      out.inputTokens += now.inputTokens - base.inputTokens;
      out.outputTokens += now.outputTokens - base.outputTokens;
      out.usd += now.usd - base.usd;
      out.ms += now.ms - base.ms;
      out.estimatedInputCalls += now.estimatedInputCalls - base.estimatedInputCalls;
    }
    return out;
  }
}

interface Target {
  sessionId: string;
  id8: string;
  project: string;
  harness: Harness;
  isSidechain: boolean;
  isGhost: boolean;
  units: TranscriptUnit[];
  score: number;
  /** 8.7 cards-first: set only when `--cheap` found a card for this session. */
  card?: string;
}

export async function ask(db: Db, question: string, o: AskOptions = {}): Promise<AskResult> {
  const started = Date.now();
  const q = question.trim();
  const strict = Boolean(o.strict);
  const cheap = Boolean(o.cheap);
  // `--cheap` moves the *defaults* and nothing else. A caller that passed `--k`
  // or `--model` asked for a number, and a flag that silently overrode it
  // would make `ask --cheap --k 8` a lie on the screen: the footer prints `k`
  // from the shortlist it actually built.
  const k = Math.max(1, Math.floor(o.k ?? (cheap ? ASK_CHEAP_K : ASK_K)));
  const budget = o.budget ?? new Budget({ maxUsd: o.maxUsd ?? ASK_MAX_USD });
  const maxUsd = o.maxUsd ?? ASK_MAX_USD;
  const meter = new SpendMeter();
  const drop = (d: AskDrop): void => o.onDrop?.(d);

  // ---- 1. shortlist. No model.
  //
  // Two departures from `find`'s call, each with a reason:
  //
  // `candidates` is pinned to what `find --limit k` would have used. `recall`
  // derives its per-list candidate depth from `limit`, so asking for 50 blocks
  // to count `matching` would silently deepen every list and **reorder the top
  // six**. Measured on the reference corpus: at depth 500 the top block for one
  // question was a ghost about website copy at 0.0098; at depth 60 it was the
  // session that actually discussed the question. `ask` must read what `find`
  // shows, so the depth is the shortlist's, and the wider `limit` only counts.
  //
  // `vectors` defaults to **on**, where `find` defaults to `auto`. `find`
  // defaults to auto because `03` §12 gives it 150 ms and the embedding
  // forward pass is ~350 ms of that. `ask` spends two and a half minutes and
  // ten cents; 350 ms is free, and the shortlist is the single largest lever
  // on whether the answer is any good (`05`: *ask is as good as the shortlist
  // and can miss*). `--vectors auto|off` still overrides.
  const found = await recall(db, q, o.filters ?? {}, {
    limit: Math.max(k, ASK_SCAN),
    candidates: Math.max(k * 10, 60),
    ...(o.root !== undefined ? { root: o.root } : {}),
    vectors: o.vectors ?? true,
  });
  // `matching` counts **readable sessions**, not recall blocks. A block is a
  // conversation — `recall` clusters a parent with its subagents into one — so
  // counting blocks against a `searched` that counts sessions printed
  // "6 of 5 sessions read" on a corpus with two subagents in it. Both numbers
  // now come out of the same expansion.
  const { targets, candidates } = shortlist(db, found.sessions, k, cheap);
  const matching = candidates;
  o.onProgress?.({
    step: 'shortlist',
    done: targets.length,
    total: matching,
    spend: meter.total,
  });

  const empty = (extra: Partial<AskResult> = {}): AskResult => ({
    question: q,
    answer: '',
    sentences: [],
    trimmed: [],
    dropped: [],
    evidence: [],
    openThreads: [],
    searched: 0,
    matching,
    readers: [],
    refused: strict,
    refusal: strict ? (targets.length === 0 ? 'no-match' : 'no-answer') : null,
    strict,
    spend: meter.total,
    estimated: meter.total.estimatedInputCalls > 0,
    cheap,
    ms: Date.now() - started,
    ...extra,
  });

  if (targets.length === 0) return empty();

  // ---- 2. readers, in parallel.
  //
  // Two Llm handles over **one** Budget: the readers are haiku-class and the
  // synthesizer is sonnet-class (`03` §8), and a single ceiling has to hold
  // across both or `--max-usd` is a per-model limit wearing a run-level name.
  const ownReader = o.readerFn ? null : o.readerLlm ?? openLlm(o.readerModel ?? CARD_MODEL, budget, o);
  if (ownReader) meter.track(ownReader);
  const readerFn: AskReaderFn = o.readerFn ?? sdkReader(ownReader!, o.signal);

  const gate = makeGate(Math.max(1, Math.floor(o.concurrency ?? ASK_CONCURRENCY)));
  const readers: AskReaderReport[] = new Array(targets.length);
  const outputs: (AskReaderOutput | null)[] = new Array(targets.length).fill(null);
  let done = 0;

  try {
    await Promise.all(
      targets.map((t, i) =>
        gate(async () => {
          const at = Date.now();
          try {
            const out = await readerFn(readerInput(q, t));
            outputs[i] = out;
            readers[i] = {
              sessionId: t.sessionId,
              id8: t.id8,
              found: Boolean(out.found) && out.quotes.length > 0,
              quotes: out.quotes.length,
              ms: Date.now() - at,
            };
          } catch (err) {
            // phase-4 ruling: one dead reader must not fail the verb. A
            // timeout, a budget ceiling, a backend that went away — all of
            // them are "this session contributed nothing", recorded as such.
            readers[i] = {
              sessionId: t.sessionId,
              id8: t.id8,
              found: false,
              quotes: 0,
              ms: Date.now() - at,
              error: message(err),
            };
          } finally {
            done += 1;
            // `done` is the count of readers that have *returned*, so the
            // ordinal on the printed line is arrival order rather than
            // shortlist order. That is the honest one: the user is watching a
            // race, and `reader 3/6` next to a session that came third is what
            // they saw happen.
            const report = readers[i];
            o.onProgress?.({
              step: 'read',
              done,
              total: targets.length,
              spend: meter.total,
              detail: report?.error ? 'failed' : report?.found ? 'found' : 'nothing',
              ...(report ? { reader: report } : {}),
            });
          }
        }),
      ),
    );

    const answered = outputs
      .map((out, i) => ({ out, t: targets[i]! }))
      .filter((x): x is { out: AskReaderOutput; t: Target } => Boolean(x.out?.found));

    const base = (extra: Partial<AskResult>): AskResult =>
      empty({ searched: targets.length, readers: readers.filter(Boolean), ...extra });

    if (answered.length === 0) {
      return base({ refused: strict, refusal: strict ? 'no-answer' : null });
    }

    // ---- 3. the ceiling, checked before the expensive call.
    //
    // phase-4 ruling: if the readers alone exceeded `--max-usd`, abort *before*
    // the synthesizer and return what there is. An abort that still prints an
    // ungrounded answer is worse than an error, so nothing below this line
    // runs and `answer` stays empty.
    if (meter.total.usd >= maxUsd) {
      return base({ refused: true, refusal: 'budget' });
    }

    // ---- 4. synthesizer, one call.
    o.onProgress?.({ step: 'synthesize', done: 0, total: 1, spend: meter.total });
    const ownSynth =
      o.llm ?? openLlm(o.model ?? (cheap ? ASK_CHEAP_MODEL : ASK_MODEL), budget, o);
    meter.track(ownSynth);
    let proposed: SynthReply;
    try {
      proposed = await synthesize(ownSynth, q, answered, cardSummaries(db, targets), o.signal);
    } catch (err) {
      if (!(err instanceof BudgetError)) throw err;
      return base({ refused: true, refusal: 'budget' });
    } finally {
      if (!o.llm) await ownSynth.close().catch(() => {});
    }

    // ---- 5. the filter. No model runs past this line.
    o.onProgress?.({ step: 'filter', done: 0, total: 1, spend: meter.total });
    const filtered = filterAnswer(proposed.answer, proposed.evidence, targets);
    for (const d of filtered.drops) drop(d);

    const refused = strict && filtered.evidence.length < STRICT_MIN_EVIDENCE;

    // ---- 6. open threads, advisory, and never allowed to fail the verb.
    let openThreads: OpenThread[] = [];
    if (o.openThreads !== false && !refused) {
      openThreads = await tryOpenThreads(db, targets, ownSynth === o.llm ? o.llm : null, budget, o);
      o.onProgress?.({
        step: 'threads',
        done: openThreads.length,
        total: openThreads.length,
        spend: meter.total,
      });
    }

    // `answer` is derived here and nowhere else. There is no branch in this
    // function that assigns it from model output.
    const sentences = refused ? [] : filtered.sentences;
    return {
      question: q,
      answer: sentences.map((s) => s.text).join(' '),
      sentences,
      dropped: filtered.dropped,
      trimmed: refused ? [] : filtered.trimmed,
      evidence: refused ? [] : filtered.evidence,
      openThreads,
      searched: targets.length,
      matching,
      readers: readers.filter(Boolean),
      refused,
      refusal: refused ? 'strict' : null,
      strict,
      spend: meter.total,
      estimated: meter.total.estimatedInputCalls > 0,
      cheap,
      ms: Date.now() - started,
    };
  } finally {
    if (ownReader && ownReader !== o.readerLlm) await ownReader.close().catch(() => {});
  }
}

function openLlm(model: string, budget: Budget, o: AskOptions): Llm {
  return Llm.open({ model, budget, ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}) });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -------------------------------------------------------------- shortlist

/**
 * Recall's session blocks into reader targets.
 *
 * **The per-hit `sessionId`, never the block's** (phase-3 handoff item 2).
 * `recall` clusters a parent with its subagents into one conversation, because
 * that is the right unit to *show* a person. It is the wrong unit to read: a
 * subagent is indexed as its own session holding exactly one exchange, and the
 * hit that actually matched may belong to it rather than to the 120-exchange
 * parent it is filed under. Taking the block's id would hand a reader the
 * wrong transcript and cite the wrong session id on the answer.
 */
function shortlist(
  db: Db,
  sessions: readonly RecallSession[],
  k: number,
  cheap = false,
): { targets: Target[]; candidates: number } {
  // Recall's block order is kept — it is the ranking `find` shows and the one
  // phase 3 measured — and each block is expanded into the distinct sessions
  // its hits actually came from, best hit first. So a parent and the subagent
  // that matched inside it are both readable, in the order the fusion put
  // them, and neither is read as the other.
  const order: string[] = [];
  const seqs = new Map<string, number[]>();
  const scores = new Map<string, number>();

  for (const s of sessions) {
    const inBlock: string[] = [];
    for (const h of s.hits) {
      const id = h.sessionId;
      if (!seqs.has(id)) {
        seqs.set(id, []);
        inBlock.push(id);
      }
      const list = seqs.get(id)!;
      if (h.seq !== undefined && h.seq !== null && !list.includes(h.seq)) list.push(h.seq);
      scores.set(id, Math.max(scores.get(id) ?? 0, h.score));
    }
    // A block that matched only on its title or its card has no hit row with a
    // seq; it is still a session worth reading, and its opening is the excerpt.
    if (!seqs.has(s.id)) {
      seqs.set(s.id, []);
      scores.set(s.id, s.score);
      inBlock.push(s.id);
    }
    inBlock.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
    order.push(...inBlock);
  }

  const targets: Target[] = [];
  // One query for the whole shortlist rather than one per target: `loadTarget`
  // is called for candidates that may not survive `units.length > 0`, and a
  // per-target lookup would run `k` statements to answer a question one
  // statement answers. Empty on the default path — cards-first is `--cheap`'s.
  const cards = cheap ? cardBriefs(db, order.slice(0, Math.max(k * 3, k))) : new Map<string, string>();
  for (const sessionId of order) {
    if (targets.length >= k) break;
    const t = loadTarget(
      db,
      sessionId,
      seqs.get(sessionId) ?? [],
      scores.get(sessionId) ?? 0,
      cards.get(sessionId),
    );
    if (t && t.units.length > 0) targets.push(t);
  }
  return { targets, candidates: order.length };
}

/**
 * 8.7 cards-first: one compact context block per carded session.
 *
 * What goes in is what a reader cannot reconstruct from two exchanges — the
 * shape of the session and what it concluded — and nothing that would read as
 * quotable prose. Decisions carry their `evidence_seq` so a reader that wants
 * to quote one knows which exchange to look for rather than quoting the
 * card's paraphrase of it, which {@link filterAnswer} would drop.
 *
 * The text is already redacted: cards are extracted from the index, and the
 * index is redacted at ingest (L2). It is redacted **again** on the way out by
 * `llm.ts`, which masks every outgoing prompt and system string and has no
 * flag that turns it off. `tests/ask-cheap.test.ts` asserts the second pass on
 * the wire rather than trusting the first.
 */
function cardBriefs(db: Db, sessionIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (sessionIds.length === 0) return out;
  try {
    const rows = db
      .prepare(
        `SELECT session_id, title, summary, decisions, outcome FROM cards
          WHERE session_id IN (${sessionIds.map(() => '?').join(',')})`,
      )
      .all(...sessionIds) as {
      session_id: string;
      title: string | null;
      summary: string | null;
      decisions: string | null;
      outcome: string | null;
    }[];
    for (const r of rows) {
      const brief = cardBrief(r);
      if (brief) out.set(r.session_id, brief);
    }
  } catch {
    // A corpus with no `cards` table is not an error, it is a corpus nobody
    // has run `card` on. Cards-first then degrades to the ordinary slice,
    // which is the default path's behaviour and is correct.
    return out;
  }
  return out;
}

function cardBrief(r: {
  title: string | null;
  summary: string | null;
  decisions: string | null;
  outcome: string | null;
}): string {
  const parts: string[] = [];
  if (r.title?.trim()) parts.push(`title: ${r.title.trim()}`);
  if (r.summary?.trim()) parts.push(`summary: ${r.summary.trim()}`);
  const decisions = parseDecisions(r.decisions);
  if (decisions.length > 0) {
    parts.push(
      'decisions:\n' +
        decisions
          .slice(0, 4)
          .map((d) => {
            const seqs = d.evidence_seq.length ? ` [seq ${d.evidence_seq.join(', ')}]` : '';
            return `  - ${d.what}${d.why ? ` — ${d.why}` : ''}${seqs}`;
          })
          .join('\n'),
    );
  }
  if (r.outcome?.trim()) parts.push(`outcome: ${r.outcome.trim()}`);
  const text = parts.join('\n').trim();
  if (!text) return '';
  return text.length > ASK_CARD_CHARS ? `${text.slice(0, ASK_CARD_CHARS).trimEnd()}…` : text;
}

function parseDecisions(raw: string | null): { what: string; why: string; evidence_seq: number[] }[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        what: typeof x['what'] === 'string' ? x['what'] : '',
        why: typeof x['why'] === 'string' ? x['why'] : '',
        evidence_seq: Array.isArray(x['evidence_seq'])
          ? x['evidence_seq'].map(Number).filter(Number.isInteger)
          : [],
      }))
      .filter((x) => x.what.trim().length > 0);
  } catch {
    return [];
  }
}

function loadTarget(
  db: Db,
  sessionId: string,
  seqs: readonly number[],
  score: number,
  card?: string,
): Target | null {
  const transcript =
    loadSessionTranscript(db, sessionId) ?? loadGhostTranscript(db, sessionId);
  if (!transcript) return null;
  // Cards-first, and only where it actually costs less to send.
  //
  // Two conditions, and the second was found by measurement rather than by
  // reasoning. The first is obvious: no card, no substitution — there would be
  // nothing standing in for what the cut removed, so an uncarded session keeps
  // its full slice even under `--cheap`.
  //
  // The second: **the substitution has to be smaller than what it replaces.**
  // The trade assumes the default slice is near its 8 kB ceiling, and on a
  // long session it is. On a short one it is not: measured on the synthetic
  // demo corpus, three shortlisted sessions had default slices of 1,048 /
  // 1,023 / 257 characters, and adding a 900-character card to each made the
  // `--cheap` fan-out send **more** than the default path it was meant to be
  // cheaper than (4,518 characters against 3,032). A latency flag that
  // enlarges the prompt is not a slower version of the trade, it is the
  // opposite of it. So both forms are costed here and the smaller wins; a
  // session with nothing to trade away is read exactly as the default path
  // reads it, and `AskReaderInput.card` is absent so the screen and the
  // recorded reader file both say so.
  const full = excerptUnits(transcript, seqs);
  const narrow = card
    ? excerptUnits(transcript, seqs, {
        top: ASK_CHEAP_TOP_EXCHANGES,
        maxChars: ASK_CHEAP_SESSION_CHARS,
      })
    : null;
  const worthIt =
    narrow !== null && excerptText(narrow).length + card!.length < excerptText(full).length;
  const units = worthIt ? narrow! : full;
  return {
    sessionId,
    id8: idTag(sessionId),
    project: projectName(transcript.project),
    harness: transcript.harness,
    isSidechain: transcript.isSidechain,
    isGhost: transcript.kind === 'ghost',
    units,
    score,
    ...(worthIt ? { card: card! } : {}),
  };
}

function readerInput(question: string, t: Target): AskReaderInput {
  return {
    question,
    sessionId: t.sessionId,
    id8: t.id8,
    project: t.project,
    harness: t.harness,
    isSidechain: t.isSidechain,
    isGhost: t.isGhost,
    excerpts: excerptText(t.units),
    seqs: t.units.map((u) => u.seq),
    ...(t.card ? { card: t.card } : {}),
  };
}

/** The default reader: one agent-sdk subagent per session, haiku-class. */
function sdkReader(llm: Llm, signal?: AbortSignal): AskReaderFn {
  return async (input) => {
    const prompt =
      `Question: ${input.question}\n\n` +
      `Session ${input.id8} (${input.project}, ${input.harness}` +
      `${input.isSidechain ? ', subagent transcript' : ''}` +
      `${input.isGhost ? ', GHOST — prompts only' : ''}).\n` +
      // The card goes above the excerpts and is labelled as not citable, so
      // the last thing the model reads before the question's evidence is the
      // evidence itself.
      (input.card ? `\nCard (context only, NOT citable):\n${input.card}\n` : '') +
      `\nCitable seq numbers: ${input.seqs.join(', ')}\n\n` +
      `Excerpts:\n${input.excerpts}`;
    const r = await llm.json<AskReaderOutput>({
      prompt,
      system: readerSystem(input),
      schema: READER_SCHEMA,
      label: `reader ${input.id8}`,
      fallback: { found: false, quotes: [], answer_fragment: '' },
      validate: validateReader,
      ...(signal ? { signal } : {}),
    });
    return r.value;
  };
}

/**
 * The reader's system prompt, with the notes this session's shape earns.
 *
 * Both notes are additive and both are about what may **not** be said: a ghost
 * has no assistant side, a card is not a transcript. A session that is both
 * gets both, in that order, because the ghost note is the stronger claim.
 */
function readerSystem(input: AskReaderInput): string {
  const parts = [READER_SYSTEM];
  if (input.isGhost) parts.push(READER_GHOST_NOTE);
  if (input.card) parts.push(READER_CARD_NOTE);
  return parts.join('\n\n');
}

function validateReader(v: unknown): AskReaderOutput | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const quotes = Array.isArray(o['quotes']) ? o['quotes'] : [];
  return {
    found: o['found'] === true,
    quotes: quotes
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        seq: Number(x['seq']),
        ts: typeof x['ts'] === 'string' ? x['ts'] : null,
        text: typeof x['text'] === 'string' ? x['text'] : '',
      }))
      .filter((x) => Number.isInteger(x.seq) && x.text.length > 0),
    answer_fragment: typeof o['answer_fragment'] === 'string' ? o['answer_fragment'] : '',
  };
}

// ----------------------------------------------------------- synthesizer

interface SynthReply {
  evidence: ProposedEvidence[];
  answer: ProposedSentence[];
}

async function synthesize(
  llm: Llm,
  question: string,
  answered: readonly { out: AskReaderOutput; t: Target }[],
  summaries: string,
  signal?: AbortSignal,
): Promise<SynthReply> {
  const blocks = answered.map(({ out, t }) => {
    const quotes = out.quotes
      .map((qq) => `    seq ${qq.seq} ${qq.ts ?? ''} "${qq.text.replace(/\s+/g, ' ').trim()}"`)
      .join('\n');
    return (
      `session_id: ${t.sessionId}   (${t.project}/${t.id8}` +
      `${t.isGhost ? ', GHOST — prompts only, the assistant side is not recoverable' : ''}` +
      `${t.isSidechain ? ', subagent transcript' : ''})\n` +
      `  reader said: ${out.answer_fragment.replace(/\s+/g, ' ').trim()}\n` +
      `  quotes:\n${quotes}`
    );
  });

  const r = await llm.json<SynthReply>({
    prompt:
      `Question: ${question}\n\n` +
      `Readers:\n\n${blocks.join('\n\n')}\n\n` +
      (summaries ? `Card summaries for these sessions:\n${summaries}\n\n` : '') +
      'Use only the session_id values printed above. Copy each quote exactly as printed, ' +
      'including its seq.',
    system: SYNTH_SYSTEM,
    schema: SYNTH_SCHEMA,
    label: 'synthesizer',
    maxOutputTokens: 2_000,
    fallback: { evidence: [], answer: [] },
    validate: validateSynth,
    ...(signal ? { signal } : {}),
  });
  return r.value;
}

function validateSynth(v: unknown): SynthReply | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const evRaw = Array.isArray(o['evidence']) ? o['evidence'] : [];
  const ansRaw = Array.isArray(o['answer']) ? o['answer'] : [];
  const evidence: ProposedEvidence[] = evRaw
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x, i) => ({
      index: Number.isInteger(Number(x['n'])) ? Number(x['n']) : i + 1,
      sessionId: String(x['session_id'] ?? ''),
      seq: Number(x['seq']),
      quote: typeof x['quote'] === 'string' ? x['quote'] : '',
    }))
    .filter((x) => x.sessionId.length > 0 && Number.isInteger(x.seq) && x.quote.length > 0);
  const answer: ProposedSentence[] = ansRaw
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      text: typeof x['text'] === 'string' ? x['text'] : '',
      cites: Array.isArray(x['cites']) ? x['cites'].map(Number).filter(Number.isInteger) : [],
    }))
    .filter((x) => x.text.trim().length > 0);
  if (evidence.length === 0 && answer.length === 0) return null;
  return { evidence, answer };
}

/** Card summaries for the shortlisted sessions, when any have been carded. */
function cardSummaries(db: Db, targets: readonly Target[]): string {
  if (targets.length === 0) return '';
  try {
    const rows = db
      .prepare(
        `SELECT session_id, title, summary FROM cards
          WHERE session_id IN (${targets.map(() => '?').join(',')})`,
      )
      .all(...targets.map((t) => t.sessionId)) as {
      session_id: string;
      title: string | null;
      summary: string | null;
    }[];
    return rows
      .filter((r) => r.summary?.trim())
      .map((r) => `  ${idTag(r.session_id)}  ${r.title ?? ''} — ${r.summary}`)
      .join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------- open threads

/**
 * T4.2's verb, called and never trusted to be there.
 *
 * `open-threads.ts` is another worker's file and both of its functions throw
 * until that worker lands. An `ask` that failed because an *advisory* section
 * is not built yet would be an `ask` that fails for a reason the user cannot
 * act on and did not ask about — so the whole section degrades to an empty
 * array with nothing shown. The same catch covers the shipped case where a
 * corpus has no cards to compare (the reference corpus has 0), which is not an
 * error either.
 */
async function tryOpenThreads(
  db: Db,
  targets: readonly Target[],
  llm: Llm | null,
  budget: Budget,
  o: AskOptions,
): Promise<OpenThread[]> {
  try {
    const cands = openThreadCandidates(
      db,
      targets.map((t) => t.sessionId),
    );
    if (cands.length === 0) return [];
    const confirmed = await confirmOpenThreads(cands, {
      ...(llm ? { llm } : {}),
      ...(o.model ? { model: o.model } : { model: o.cheap ? ASK_CHEAP_MODEL : ASK_MODEL }),
      budget,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    // `open-threads.ts`: "confirmed:false candidates are dropped by the
    // caller." This is the caller.
    return confirmed.filter((c) => c.confirmed);
  } catch {
    return [];
  }
}
