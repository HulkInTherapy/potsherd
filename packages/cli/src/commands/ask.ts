import fs from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';

import {
  ASK_CHEAP_K,
  ASK_CONCURRENCY,
  ASK_K,
  ASK_MAX_USD,
  NoBackendError,
  VERSION,
  ask,
  detectBackend,
  readerLine,
  redactOutgoing,
  renderAsk,
  vecStatus,
  type AskDrop,
  type AskOptions,
  type AskProgress,
  type AskReaderFn,
  type AskReaderInput,
  type AskReaderOutput,
  type AskResult,
  idTag,
} from '@potsherd/core';
import {
  UserError,
  print,
  printJson,
  themeFrom,
  type GlobalOptions,
} from '../output.js';
import { openIndex, parseFilters, type FilterFlags } from '../filters.js';

/**
 * `potsherd ask` — interrogation with citations (`03` §8).
 *
 * This file does four things and deliberately not a fifth: it parses the
 * flags, opens the index, shows cost and time while the readers run, and
 * prints `AskResult`. **Every judgement about what a user is allowed to read
 * lives in `core/ask.ts`'s filter**, above this layer, so that the library
 * entry point and the CLI cannot diverge — the phase-5 plugin will call `ask()`
 * directly with its own reader function and must get the same guarantees this
 * command gets.
 *
 * The exit codes are part of the interface:
 *
 * ```
 *   0   an answer, grounded
 *   1   nothing matched, or nothing survived the filter without --strict
 *   2   --strict and fewer than two evidence lines survived   (phase-4 T4.1 §4)
 * ```
 */

export interface AskCommandOptions extends GlobalOptions, FilterFlags {
  question: string;
  k?: unknown;
  strict?: boolean;
  maxUsd?: unknown;
  model?: string;
  readerModel?: string;
  concurrency?: unknown;
  vectors?: string;
  vec?: boolean;
  /**
   * T10.5 F5 `--windows n`: separated excerpt windows per long session.
   *
   * Unset means {@link ASK_WINDOWS}, applied in `core/ask.ts` — the same rule
   * `--k` follows, and for the same reason: a commander default would make
   * every run look as if the user had typed the number.
   */
  windows?: unknown;
  /** T5.6: record the reader inputs to this path and stop. No model call. */
  readersOut?: string;
  /** T5.6: replay reader outputs from this path instead of running readers. */
  readersIn?: string;
  /** T10.2: write the synthesis prompt to this path and stop. No model call. */
  synthesisOut?: string;
  /** T10.2: filter a host-written answer from this path. No model call. */
  filterIn?: string;
  /** 8.7: k 3, a haiku-class synthesizer, and cards-first excerpts. */
  cheap?: boolean;
}

// ===================================================== the wait, made legible
//
// 8.7. What `ask` printed while it worked was a 24-cell progress bar and a
// running cost, redrawn in place on stderr, and only when stderr was a TTY.
// Everywhere else — piped, redirected, under `--json`, in CI, in the cast
// recorder — it printed nothing at all for up to three minutes.
//
// The replacement is one line per reader, written once, as that reader
// returns. `packages/core/src/render/ask.ts`'s `readerLine` owns the shape;
// this file owns two decisions the renderer must not make.
//
// **Where it goes: stderr, always, on every path.** `ask --json` writes an
// `AskResult` to stdout and the eval harness pipes it into `jq`. A progress
// line on stdout would corrupt that, and it would corrupt it *intermittently*
// — only on runs slow enough to print one — which is the worst version of the
// bug. So the stream is decided once, here, and {@link askProgress} takes its
// sink as an argument so a test can prove where each byte went instead of
// inspecting a terminal.
//
// **When it is silent: `--quiet`, and nothing else.** Not `--json` (stderr is
// not stdout and a person watching a redirect still deserves to see the
// readers arrive), and *not* "stdout is not a TTY", which is what the old bar
// keyed on: a run whose output is being piped into a file is exactly the run
// whose wait is otherwise invisible.

/** Where a progress line is written. `process.stderr` in production. */
export interface ProgressSink {
  write(chunk: string): unknown;
}

/**
 * The `onProgress` handler `ask()` is given, and the whole of what the CLI
 * prints while the readers run.
 *
 * Only `step: 'read'` events carry a reader, and only those print. The other
 * steps — shortlist, synthesize, filter, threads — are single events with
 * nothing per-item to show; the synthesizer is one serial call and a line
 * saying so would be the spinner again with different words.
 *
 * The theme is the one the *answer* will be rendered with, which keys colour
 * off stdout. So `ask > f` prints these uncoloured even when stderr is still a
 * terminal. That is the conservative direction and it is deliberate: the cost
 * is a monochrome progress line on one uncommon setup, and the alternative
 * risks writing escape codes into a stream somebody is capturing.
 */
export function askProgress(
  t: ReturnType<typeof themeFrom>,
  sink: ProgressSink,
  enabled: boolean,
): (p: AskProgress) => void {
  return (p) => {
    if (!enabled) return;
    if (p.step !== 'read' || !p.reader) return;
    sink.write(
      `${readerLine(p.reader, p.done, p.total, t, {
        usd: p.spend.usd,
        // `est.` is inherited from what the backend reported, never guessed
        // here: the agent SDK returns a constant `input_tokens: 10`, which
        // `llm.ts` discards, so on the subscription path every call is an
        // api-equivalent estimate and the line says so.
        estimated: p.spend.estimatedInputCalls > 0,
      })}\n`,
    );
  };
}

export async function runAsk(o: AskCommandOptions): Promise<number> {
  const question = o.question?.trim();
  if (!question) {
    throw new UserError(
      'ask needs a question',
      'potsherd ask "how did we handle pgbouncer with prepared statements?"',
    );
  }

  const readersOut = flagPath(o.readersOut);
  const readersIn = flagPath(o.readersIn);
  const synthesisOut = flagPath(o.synthesisOut);
  const filterIn = flagPath(o.filterIn);
  if (readersOut && readersIn) {
    throw new UserError(
      '--readers-out and --readers-in are the two halves of one round trip, not two flags for one run',
      'potsherd ask "…" --readers-out r.json   # then run your readers, then --readers-in r.json',
    );
  }
  if (synthesisOut && filterIn) {
    throw new UserError(
      '--synthesis-out and --filter-in are the two halves of one round trip, not two flags for one run',
      'potsherd ask "…" --readers-in r.json --synthesis-out s.json   # then answer it, then --filter-in s.json',
    );
  }
  if (filterIn && (readersOut || readersIn)) {
    throw new UserError(
      '--filter-in carries its own reader outputs — it does not take a reader file as well',
      'potsherd ask "…" --filter-in s.json',
    );
  }
  if (readersOut && synthesisOut) {
    throw new UserError(
      '--readers-out stops before the readers have run, so there is no synthesis prompt to write yet',
      'potsherd ask "…" --readers-out r.json   # run your readers, then --readers-in r.json --synthesis-out s.json',
    );
  }
  // FIX-G C5. `--help` says of this flag: *"write the synthesis prompt to this
  // file; makes no model call"*. On its own that sentence was false. With no
  // recorded readers there is nothing to build a prompt out of, so the run
  // shortlists k sessions and sends **one reader call per session** before it
  // has a prompt to write — six calls, measured, on a machine whose backend
  // could not even answer them. On a machine that can, those six are spent.
  //
  // `--readers-out`'s identical clause is true because that flag returns
  // before a reader runs. This one was not, and the code already knew: the
  // `modelless` expression below read `(synthesisOut && readersIn)`, i.e. the
  // composition is free and the bare flag is not.
  //
  // Two honest repairs: qualify the sentence, or make it true. Qualifying it
  // means editing the `.option()` line in `packages/cli/src/index.ts`, which
  // is reserved to another worker this phase — the exact patch is in
  // `phases/phase-10/FIX-G-REPORT.md` §1 for whoever owns it. Making it true
  // is this guard, and it is the better of the two anyway: the flag belongs to
  // the seam, the seam's second leg is `--readers-in … --synthesis-out …`, and
  // the paying composition was never a documented shape. Its own receipt would
  // have printed `no model call was made (6)`.
  //
  // **This changes what the flag does.** `ask "…" --synthesis-out s.json` used
  // to run the readers and now refuses. That is stated plainly in the report,
  // and the refusal names the two commands that do the same work for free.
  if (synthesisOut && !readersIn) {
    throw new UserError(
      '--synthesis-out makes no model call only when the readers are already recorded; on its own ' +
        'it would spend one reader call per shortlisted session before it had a prompt to write',
      `potsherd ask "${question}" --readers-out r.json   # run your readers, then --readers-in r.json --synthesis-out ${synthesisOut}`,
    );
  }

  // The runs that **structurally cannot** call a model, and the exact reason
  // each one cannot, since this list is the whole of `A1` rung 1 from the
  // CLI's side:
  //
  //   --readers-out           the recorder answers every reader itself, so
  //                           `ask()` returns before the synthesizer exists.
  //   --synthesis-out         only reachable with `--readers-in` (guard above):
  //                           the readers are recorded and the synthesizer is
  //                           a capture function; `ask()` opens neither.
  //   --filter-in             both halves are recorded; the only work left is
  //                           `filterAnswer`, which is arithmetic.
  //
  // A verb that is about to spend money says so before it spends it. Demanding
  // a backend for a run that cannot use one would be this file telling the
  // user something untrue about it — and it would put a `claude` binary
  // between a skill and the one path that needs no model at all.
  //
  // FIX-G C5: this used to read `(synthesisOut && readersIn)`. The guard above
  // now makes the two spellings equivalent, and one name per free run is the
  // shape a reader can check against `--help`.
  const modelless = Boolean(readersOut || filterIn || synthesisOut);
  if (!modelless) {
    try {
      detectBackend({ ...(o.model ? { model: o.model } : {}) });
    } catch (err) {
      if (err instanceof NoBackendError) throw new UserError(err.message, err.fix);
      throw err;
    }
  }

  const { db, root } = openIndex(o);
  const t = themeFrom(o);
  const drops: AskDrop[] = [];
  const onProgress = askProgress(t, process.stderr, !o.quiet);

  try {
    const filters = parseFilters(db, o);
    const cheap = Boolean(o.cheap);
    // `--k` still wins over `--cheap`, so the default is chosen here rather
    // than in `positive()`: `ask --cheap --k 6` reads six sessions and the
    // footer's counts say six, which is the only reading that is not a lie.
    const k = positive(o.k, cheap ? ASK_CHEAP_K : ASK_K, '--k');
    // One options object for every path below, so the shortlist a
    // `--readers-out` run records, the shortlist a `--readers-in` run checks
    // against, and the shortlist a normal run reads are the same shortlist
    // built from the same inputs. Anything that diverges here is a stale-file
    // bug that no amount of validation downstream can see.
    const base: AskOptions = {
      filters,
      root,
      k,
      cheap,
      strict: Boolean(o.strict),
      maxUsd: money(o.maxUsd),
      concurrency: positive(o.concurrency, ASK_CONCURRENCY, '--concurrency'),
      // Only when it was typed. `positive()` would substitute the default and
      // core could no longer tell 'unset' from 'five'; today those agree, and
      // a flag whose forwarding depends on that staying true is a trap.
      ...(o.windows !== undefined && o.windows !== null && o.windows !== ''
        ? { windows: positive(o.windows, 1, '--windows') }
        : {}),
      ...(vectorMode(o) !== undefined ? { vectors: vectorMode(o) } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(o.readerModel ? { readerModel: o.readerModel } : {}),
      onDrop: (d) => drops.push(d),
    };

    if (readersOut) {
      // `await`, not a bare `return`: this function's `finally` closes the db,
      // and in an async function a `try { return p }` runs `finally` before `p`
      // settles. Without it the recording pass reads from a closed handle.
      return await recordReaders(db, question, base, readersOut, o, t);
    }

    if (synthesisOut) {
      return await recordSynthesis(db, question, base, synthesisOut, readersIn, o, t, onProgress);
    }

    const result = filterIn
      ? await filterHostAnswer(db, question, base, filterIn, (line) => {
          // Same rule as `--readers-in`'s provenance below: above the answer,
          // and never on stdout under `--json`.
          if (!o.json && !o.quiet) print(`  ${t.dim(line)}`);
        })
      : readersIn
        ? await replayReaders(db, question, base, readersIn, (line) => {
            // Provenance goes above the answer, not below it: a reader who has
            // already read the ANSWER block has already acted on it. `--json`
            // carries the same facts on the file's own `index` object.
            if (!o.json && !o.quiet) print(`  ${t.dim(line)}`);
          })
        : await ask(db, question, { ...base, onProgress });

    if (o.debug) reportDrops(drops);

    if (o.json) {
      // `AskResult` verbatim, as `phases/phase-4/WAVE.md` pins it. Nothing is
      // reshaped, renamed or summarised on the way out — the eval harness and
      // the human view are reading the same object.
      printJson(result);
      return exitCode(result);
    }

    print(renderAsk(result, t, new Date()));
    return exitCode(result);
  } finally {
    db.close();
  }
}

// =========================================================== the reader file
//
// T5.6, specified by T5.2 §2. `AskOptions.readerFn` (T4.4) lets a *program*
// run the readers somewhere else; a SKILL.md is not a program and cannot hand
// a closure to a `node` process it did not write. These two flags are the
// file-shaped form of that same seam, and they are the whole of it: the
// recorded outputs re-enter `ask()` through `readerFn` and everything after
// the readers — the synthesizer, `filterAnswer`, evidence renumbering,
// `--strict`, open threads — runs untouched. There is no second answer path.
//
// `packages/core/src/ask.ts` is not edited by any of this, and does not need
// to be. That was T5.2's claim and it holds; the two line references that
// carry it are in `recorder()` below.

/** The envelope's discriminator. A file without it is not one of ours. */
export const READERS_FILE_KIND = 'potsherd.ask.readers';

/**
 * The envelope's own version, bumped when a field changes meaning.
 *
 * Separate from `potsherd`, which records the binary that wrote the file: the
 * format can be stable across many releases and a mismatch in the two means
 * different things.
 */
export const READERS_FILE_VERSION = 1;

/**
 * The shape `outputs` must come back in — FIX-I C-5.
 *
 * Written the way `SYNTH_SCHEMA` is written in `packages/core/src/ask.ts`: one
 * JSON literal with the types in the slots, because that is the register the
 * other half of this seam already uses and an agent that has read one file
 * should not have to learn a second notation. It names the whole array rather
 * than one entry, because `outputs` is what the agent adds and "one entry per
 * target" is part of the shape.
 *
 * It is checked against {@link readerOutput}, which is the authority, by
 * `tests/synthesis-seam.test.ts`: a file built from nothing but this string
 * completes the round trip, and the two fields the verifier could not guess —
 * `text` rather than `quote`, and `sessionId` copied off the target — are the
 * two the test would lose first if this string and that function drifted.
 *
 * `ts` is spelled `"<the ts given>"|null` because {@link readerOutput} accepts
 * either and a reader quoting a ghost prompt genuinely has none.
 */
export const READERS_SCHEMA =
  '{"outputs":[{"sessionId":"<the sessionId of this entry in targets>",' +
  '"found":true|false,' +
  '"quotes":[{"seq":<number, one of this entry\'s seqs>,"ts":"<the ts given>"|null,' +
  '"text":"<verbatim, character for character out of this entry\'s excerpts>"}],' +
  '"answer_fragment":"<one or two sentences, or empty when found is false>"}]}';

/**
 * What the host agent is told to do with this file, in the file.
 *
 * FIX-I C-5, and written under FIX-G C4(c)'s finding: *"add **it** to the file
 * as `reply`"* failed because "it" resolved two ways, so nothing here refers
 * to anything by a pronoun. The array is named, its shape is named, the fact
 * that it is a JSON **array** and not the text of one is stated — this file's
 * reader is stricter than the synthesis file's, which parses a JSON string for
 * you — and the case an agent is most likely to get wrong, a reader that found
 * nothing, is spelled out rather than left to inference.
 *
 * It does not repeat `schema`; it says where the shape is, which is the
 * register {@link REPLY_INSTRUCTION} uses for the same job.
 */
export const READERS_INSTRUCTION =
  'run one reader per entry in "targets" — each entry carries its own "question" and ' +
  '"excerpts" — and add their answers to this file as "outputs", in the shape of "schema". ' +
  '"outputs" is the JSON array itself, one entry per target, not the JSON text of it. ' +
  'A reader that found nothing records {"found":false,"quotes":[]} rather than being left out. ' +
  'Then: potsherd ask "<this file\'s question>" --readers-in <this file>';

/**
 * What `--readers-out` writes and `--readers-in` reads.
 *
 * One shape for both directions on purpose. A skill reads the file, fans its
 * own readers out over `targets`, adds `outputs`, and hands the *same file*
 * back — rather than transcribing six session ids from one format into
 * another, which is a step that can go wrong silently.
 *
 * `question`, `k` and `sessionIds` are the mismatch detectors, and they are
 * not decoration. A recording is only replayable against the shortlist it was
 * recorded from: replay it against another question and every quote is
 * evidence for something nobody asked.
 */
export interface ReadersFile {
  kind: string;
  version: number;
  /** The binary that wrote it. Informational; not checked. */
  potsherd: string;
  /**
   * {@link READERS_SCHEMA} — the shape `outputs` must come back in.
   *
   * FIX-I C-5. The synthesis file has carried a `schema` since T10.2 and an
   * `instruction` since FIX-G; this file — the **first** leg of the same seam,
   * and the one an agent meets with no prior — carried neither, so the quote
   * shape `{seq, text}` was discoverable only by getting it wrong. The fifth
   * verifier guessed `{seq, quote}`, which is the natural reading, and learned
   * the answer from an error message.
   *
   * Informational, exactly as the synthesis file's is: `--readers-in` neither
   * reads it back nor checks it. {@link readerOutput} remains the authority on
   * what is accepted, and `tests/synthesis-seam.test.ts` pins that a file built
   * to nothing but this string passes it.
   */
  schema: string;
  /**
   * {@link READERS_INSTRUCTION}, in the file, for the agent that only ever sees
   * the file. Informational, like {@link schema}.
   */
  instruction: string;
  /** Redacted exactly as `llm.ts` would redact it on the way to a model. */
  question: string;
  k: number;
  /** The shortlist, in shortlist order. The replay checks this set. */
  sessionIds: string[];
  /** `AskReaderInput` verbatim, one per shortlisted session (T4.4). */
  targets: AskReaderInput[];
  /** Added by whoever ran the readers. Absent in a fresh recording. */
  outputs?: RecordedOutput[];
  /**
   * The index as it was when this shortlist was built — FIX-B D4.
   *
   * `sessionIds` says *which* sessions; this says *why those*, in the only
   * terms that move on their own. The embedding pass keeps landing vectors
   * while a host agent runs the readers, and the ranking a question produces
   * is a function of how much of the index carries one — which is why the two
   * halves of a round trip run seconds apart could produce two different
   * shortlists, and why the replay used to refuse.
   *
   * It is recorded so the replay can say what moved instead of guessing, and
   * so `matching` — the count printed under the answer — belongs to the run
   * that built the shortlist rather than to the run that replayed it. Optional
   * because a file written by an older build has none, and such a file is
   * replayable: the pin only needs `sessionIds`.
   */
  index?: {
    /** Rows carrying a current vector when the shortlist was built. */
    vectorsEmbedded: number;
    /** Rows in the index then, embedded or not. */
    vectorsTotal: number;
    /** Readable sessions the question matched then. `AskResult.matching`. */
    matching: number;
  };
}

export type RecordedOutput = AskReaderOutput & { sessionId: string };

/**
 * The `--readers-out` reader: records, reports nothing, and by doing so makes
 * the run structurally incapable of calling a model.
 *
 * This is the load-bearing part of T5.2's design and it is worth stating
 * precisely, because "we skip the model calls" and "there is no model call to
 * skip" are different products. In `packages/core/src/ask.ts` at **line 1047**,
 * `ask()` opens a reader backend only when no `readerFn` was supplied —
 * `const ownReader = o.readerFn ? null : …` — so passing one means no reader
 * `Llm` is constructed at all. Every reader then reports `found: false`, so at
 * **line 1104** `answered.length === 0` returns before **line 1116**, which is
 * the only line in the function that opens the synthesizer's `Llm`. The
 * synthesizer, the citation filter and the open-thread pass are all below it.
 *
 * So there is no branch to get wrong and no flag to forget: on this path the
 * function never reaches an expression that could construct a backend. The
 * test for it is a transport that throws when it is sent anything.
 *
 * `concurrency: 1` is set by the caller so the recording order is the
 * shortlist order and the file is byte-stable between runs.
 */
function recorder(): { fn: AskReaderFn; seen: AskReaderInput[] } {
  const seen: AskReaderInput[] = [];
  const fn: AskReaderFn = async (input) => {
    seen.push(input);
    return { found: false, quotes: [], answer_fragment: '' };
  };
  return { fn, seen };
}

async function recordReaders(
  db: Parameters<typeof ask>[0],
  question: string,
  base: AskOptions,
  path: string,
  o: AskCommandOptions,
  t: ReturnType<typeof themeFrom>,
): Promise<number> {
  const { file, abs, probe } = await writeReadersFile(db, question, base, path);

  if (o.json) {
    printJson({
      kind: READERS_FILE_KIND,
      version: READERS_FILE_VERSION,
      path: abs,
      // FIX-I C-5, and the same reasoning FIX-G gave for putting
      // `instruction` on the synthesis file's `--json` receipt: `--json` is
      // what an agent reads, and it was the surface on which the shape of
      // `outputs` was least well stated — it was not stated anywhere.
      schema: READERS_SCHEMA,
      instruction: READERS_INSTRUCTION,
      question: file.question,
      k: file.k,
      sessionIds: file.sessionIds,
      // The same per-session facts the receipt prints, so `--json` is the
      // human view and not a summary of it (`06`: every verb's `--json`
      // carries the same data). The excerpts themselves stay in the file —
      // `--json` names the path rather than printing a second copy of the
      // transcript to a terminal.
      targets: file.targets.map((x) => ({
        sessionId: x.sessionId,
        id8: x.id8,
        project: x.project,
        harness: x.harness,
        isGhost: x.isGhost,
        isSidechain: x.isSidechain,
        seqs: x.seqs,
        // T10.5: the two numbers that make F5 measurable from outside. A
        // reader handed `windows: 1` out of `exchanges: 119` is the audit's
        // finding, printed, on any archive, with no model call.
        ...(x.windows !== undefined ? { windows: x.windows } : {}),
        ...(x.exchanges !== undefined ? { exchanges: x.exchanges } : {}),
      })),
      matching: probe.matching,
      modelCalls: probe.spend.calls,
    });
  } else {
    print(readersOutReceipt(file, abs, probe, t));
  }
  // `1` is `ask`'s own "nothing matched". A recording with no targets in it is
  // that, not a success with an empty file.
  return file.targets.length > 0 ? 0 : 1;
}

/**
 * The whole of `--readers-out`, without the printing, so a test can drive it.
 *
 * Returns the `AskResult` of the recording pass alongside the file. It is an
 * empty result by construction — that is the proof, not a side effect — and
 * `probe.spend.calls` is the number the receipt prints.
 */
export async function writeReadersFile(
  db: Parameters<typeof ask>[0],
  question: string,
  base: AskOptions,
  path: string,
): Promise<{ file: ReadersFile; abs: string; probe: AskResult }> {
  const rec = recorder();
  const probe = await ask(db, question, {
    ...base,
    concurrency: 1,
    openThreads: false,
    readerFn: rec.fn,
  });

  // Belt and braces, and not only that. `llm.ts` runs `redactOutgoing` over
  // every outgoing string immediately before a transport sees it, and its own
  // comment says that pass is "identical to the ingest path, deliberately:
  // what a model sees and what the index holds are the same text". Excerpts
  // reach `readerFn` already masked, because redaction is L2 and runs before
  // anything is written to the index — so this call is a no-op today, and
  // `tests/ask.test.ts` asserts that it is. It is here so that the file a user
  // names can never hold a byte that a model would not have been sent, even if
  // the two rule sets ever drift. Running it also keeps the two paths
  // *identical*: a native reader quoting this text quotes what an SDK reader
  // would have been shown.
  // The card block goes through the same pass as the excerpts, for the same
  // reason and with the same result: it is redacted at rest (a card is
  // extracted from the index, and the index is redacted at ingest), `llm.ts`
  // redacts it again on the wire, and this third pass keeps the recorded file
  // byte-identical to what a model would have been sent. Present only on a
  // `--cheap` recording of a carded session.
  const targets = rec.seen.map((input) => ({
    ...input,
    excerpts: redactOutgoing(input.excerpts).text,
    ...(input.card ? { card: redactOutgoing(input.card).text } : {}),
  }));
  const q = redactOutgoing(question).text;
  const file: ReadersFile = {
    kind: READERS_FILE_KIND,
    version: READERS_FILE_VERSION,
    potsherd: VERSION,
    // FIX-I C-5. Ahead of `question`, so the two fields that say what to do
    // with this file are the first thing in it that is not the envelope —
    // the same place the synthesis file puts `schema`, relative to its prompt.
    schema: READERS_SCHEMA,
    instruction: READERS_INSTRUCTION,
    question: q,
    k: base.k ?? ASK_K,
    sessionIds: targets.map((x) => x.sessionId),
    targets: targets.map((x) => ({ ...x, question: q })),
    // Deliberately no timestamp. Two recordings of one question over one
    // index are byte-identical — `tests/ask.test.ts` pins it, and the reason
    // it is worth pinning is that a diff of two recordings is then a diff of
    // the *index*. A clock in the envelope would make every diff non-empty and
    // that property worthless. Everything here is a function of the index.
    index: { ...indexState(db, base.root), matching: probe.matching },
  };

  const abs = nodePath.resolve(path);
  fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return { file, abs, probe };
}

function readersOutReceipt(
  file: ReadersFile,
  abs: string,
  probe: AskResult,
  t: ReturnType<typeof themeFrom>,
): string {
  const lines: string[] = [];
  const n = file.targets.length;
  if (n === 0) {
    lines.push(`  nothing matched — no reader inputs written to ${abs}`);
    return lines.join('\n');
  }
  lines.push(`  ${t.accent(`${n} reader input${n === 1 ? '' : 's'}`)} → ${abs}`);
  lines.push(`  of ${probe.matching} matching session${probe.matching === 1 ? '' : 's'}, k ${file.k}`);
  lines.push('');
  for (const target of file.targets) {
    // T10.5: `5 windows of 119` after the seqs, and only when there is more
    // than one — on a short session the sentence would be noise, and `05`'s
    // rule is that a line earns its width.
    const shape =
      target.windows !== undefined && target.windows > 1
        ? t.dim(`  ${target.windows} windows of ${target.exchanges ?? '?'}`)
        : '';
    lines.push(
      `    ${target.id8}  ${target.project}${target.isGhost ? t.dim('  ghost') : ''}` +
        `${target.isSidechain ? t.dim('  subagent') : ''}  ${t.dim(`seq ${target.seqs.join(', ')}`)}` +
        shape,
    );
  }
  lines.push('');
  // The claim this flag exists to make, stated where the user can check it.
  lines.push(`  ${t.dim(`no model call was made (${probe.spend.calls}). the excerpts are redacted, as sent.`)}`);
  // FIX-B D4. The half of the round trip a user cannot see is the half that
  // used to fail: `--readers-in` rebuilt the shortlist and refused when it had
  // moved, and it moves on its own while the embedding pass runs. It is pinned
  // now, and the receipt says so here rather than leaving the reader to
  // discover it from an error — or to find the `--no-vec`-on-both-halves
  // workaround, which was never written down anywhere and is no longer needed.
  lines.push(
    `  ${t.dim(`these ${n} ${n === 1 ? 'session is' : 'sessions are'} the shortlist. --readers-in reads exactly ${n === 1 ? 'it' : 'them'}, however much the index has embedded since.`)}`,
  );
  lines.push('');
  // FIX-I C-5. The old two lines were `run your readers, add an "outputs"
  // array to the file` and the command — which never said what an entry of
  // that array looks like, on any surface. The shape is in the file now, as
  // `schema`; this says so, and states the one field the fifth verifier had to
  // learn from an error message.
  lines.push('  run one reader per target, then add an "outputs" array to the file —');
  lines.push('  one entry per target, in the shape of the file\'s own "schema" field:');
  lines.push(
    `  ${t.dim('{ "sessionId": …, "found": true|false, "quotes": [{ "seq": n, "text": "…" }], "answer_fragment": "…" }')}`,
  );
  lines.push('  then:');
  lines.push(`    potsherd ask "${file.question}" --readers-in ${abs}`);
  return lines.join('\n');
}


/**
 * `--readers-in`: hand `ask()` the recorded outputs and let it do the rest.
 *
 * Two passes, and the first one is the point.
 *
 * `ask()` cannot skip the shortlist even here, and should not: `filterAnswer`
 * checks every quote against the *live* transcript bytes at the `(sessionId,
 * seq)` it names, so the shortlist is what makes the guarantee enforceable
 * rather than a thing the file asserts about itself. T5.2's §2 says
 * `--readers-in` "skips shortlist and readers"; it skips the readers, and it
 * must not skip the shortlist.
 *
 * Given that, the recorded session ids and the live shortlist can disagree —
 * the index moved, a session was indexed or dropped, a filter differs. Finding
 * that out *after* `ask()` returns would mean paying for the synthesizer to
 * learn the answer was built on a stale file. So pass one is the
 * `--readers-out` recorder again, over the identical options: zero model calls
 * by the same construction, and it yields the live shortlist to check the file
 * against. It costs one extra `recall` (no model, no network beyond the local
 * embedding pass) and it buys a failure that happens before any money does.
 *
 * Reusing the recorder rather than re-deriving the shortlist is deliberate.
 * `ask()`'s `recall` call is tuned — candidate depth pinned to `find --limit
 * k`, vectors defaulted on — with measured reasons in its own comments. A
 * second copy of that call in this file would drift, and the drift would look
 * exactly like a stale file.
 */
export async function replayReaders(
  db: Parameters<typeof ask>[0],
  question: string,
  base: AskOptions,
  path: string,
  onNote?: (line: string) => void,
): Promise<AskResult> {
  const staged = await stageReaders(db, question, base, path);
  for (const line of staged.notes) onNote?.(line);
  // ---- pass two: the real run, with the recorded readers in place of the SDK.
  return ask(db, question, { ...base, pin: staged.pin, readerFn: staged.readerFn });
}

/**
 * Everything `--readers-in` does *except* the answering run: validate the
 * file, prove it against the live shortlist at zero model calls, and hand
 * back the reader function it implies.
 *
 * Split out because T10.2 gave the same file a second consumer.
 * `--readers-in --synthesis-out` needs the recorded readers in order to build
 * the synthesis prompt, and it must reject a stale file for exactly the
 * reasons {@link matchOrFail} gives — but it must not then run a synthesizer.
 * Two copies of this validation would be two chances for one of them to get
 * quietly weaker, on the path whose whole purpose is that the guarantee is
 * kept by code.
 */
async function stageReaders(
  db: Parameters<typeof ask>[0],
  question: string,
  base: AskOptions,
  path: string,
): Promise<{
  readerFn: AskReaderFn;
  outputs: RecordedOutput[];
  live: string[];
  abs: string;
  pin: NonNullable<AskOptions['pin']>;
  notes: string[];
}> {
  const abs = nodePath.resolve(path);
  const file = readReadersFile(abs);
  const q = redactOutgoing(question).text;

  if (file.question !== q) {
    throw new UserError(
      `${abs} was recorded against a different question — replaying it would answer ` +
        `"${file.question}" and print it under "${q}"`,
      `potsherd ask "${q}" --readers-out ${abs}    # record this question, then run your readers`,
    );
  }
  const k = base.k ?? ASK_K;
  if (file.k !== k) {
    throw new UserError(
      `${abs} was recorded with --k ${file.k} and this run asked for --k ${k}, ` +
        'which is a different shortlist',
      `potsherd ask "${q}" --k ${file.k} --readers-in ${abs}`,
    );
  }
  const outputs = file.outputs;
  if (!outputs) {
    throw new UserError(
      `${abs} has no "outputs" — it is a --readers-out recording that nobody has read yet`,
      'run one reader per entry in "targets", then add ' +
        '"outputs": [{ "sessionId": …, "found": …, "quotes": […], "answer_fragment": … }]',
    );
  }

  // The recording is only replayable against outputs that cover it, and that
  // is a property of the file alone — checked before anything touches the
  // index, so a file nobody has finished reading fails the same way whatever
  // the index has been doing.
  matchOrFail(abs, q, '"outputs"', outputs.map((x) => x.sessionId), file.sessionIds);

  const pin: NonNullable<AskOptions['pin']> = {
    sessionIds: file.sessionIds,
    ...(file.index ? { matching: file.index.matching } : {}),
  };

  // ---- pass one: the recorded shortlist, resolved against the live index, at
  // zero model calls.
  //
  // This used to build the shortlist the question produces *now* and demand it
  // equal the recorded one. It refused on three of four round trips run
  // seconds apart, because the embedding pass keeps landing vectors and the
  // ranking is a function of how many have landed — nothing was stale, the
  // shortlist had got better. So the recorded ids are pinned instead, and what
  // this pass answers is the question that was actually worth asking: can this
  // index still read every session the recording was made from?
  //
  // An id that has been deleted, or whose transcript no longer yields a single
  // readable unit, does not come back — and that is the staleness the check
  // was always about, because `filterAnswer` is about to hold every quote
  // against the live bytes at the `(sessionId, seq)` it names.
  const rec = recorder();
  await ask(db, question, { ...base, pin, concurrency: 1, openThreads: false, readerFn: rec.fn });
  const live = rec.seen.map((x) => x.sessionId);

  goneOrFail(abs, q, file.sessionIds, live);

  const notes = replayNotes(db, base, file, abs);

  const byId = new Map<string, AskReaderOutput>();
  for (const out of outputs) byId.set(out.sessionId, out);

  // ---- pass two: the real run, with the recorded readers in place of the SDK.
  const readerFn: AskReaderFn = async (input) => {
    const out = byId.get(input.sessionId);
    // Unreachable: `matchOrFail` proved the sets equal against the shortlist
    // this same options object produces. Kept because `ask()` turns a thrown
    // reader into `found: false` and a quietly thinner answer, and a thinner
    // answer is the one failure this flag exists to prevent.
    if (!out) throw new Error(`no recorded output for ${input.sessionId}`);
    return out;
  };
  return { readerFn, outputs, live, abs, pin, notes };
}

/**
 * What a replay says out loud about the file it is answering from.
 *
 * FIX-B D4's other half: the pin makes the round trip work, and this is what
 * stops it working *silently*. The answer below these lines was built from a
 * shortlist that may no longer be the one this question produces, and the
 * reader is entitled to know that before they act on it — including the one
 * number that explains why, which is how much of the index carried a vector
 * then against now.
 *
 * Nothing here is a warning and nothing here is a flag to type. The old advice
 * — run both halves with `--no-vec` and they will agree — was a workaround for
 * a check that has been fixed, and repeating it would send people to turn off
 * the retrieval that makes `ask` worth running.
 */
function replayNotes(
  db: Parameters<typeof ask>[0],
  base: AskOptions,
  file: ReadersFile,
  abs: string,
): string[] {
  const n = file.sessionIds.length;
  const head = `answered over the ${n} ${n === 1 ? 'session' : 'sessions'} recorded in ${abs}`;
  const then = file.index;
  const tail = ', not the shortlist this question produces now';
  if (!then) return [`${head}${tail}`];
  const now = indexState(db, base.root);
  if (now.vectorsTotal === 0 || now.vectorsEmbedded === then.vectorsEmbedded) {
    return [`${head}${tail}`];
  }
  return [
    `${head}${tail}`,
    `  semantic search moved in between: ${then.vectorsEmbedded} of ${then.vectorsTotal} embedded then, ` +
      `${now.vectorsEmbedded} of ${now.vectorsTotal} now — re-record to ask the index as it is`,
  ];
}

/**
 * The vector state, from `vecStatus(db, root)` — the one call `index`,
 * `doctor`, `find` and `stats` make.
 *
 * Never throws and never blocks: a recording that could not read the state is
 * a recording with a zeroed one, and a replay that cannot compare simply says
 * less. Neither is worth failing a round trip over.
 */
function indexState(
  db: Parameters<typeof ask>[0],
  root: string | undefined,
): { vectorsEmbedded: number; vectorsTotal: number } {
  if (!root) return { vectorsEmbedded: 0, vectorsTotal: 0 };
  try {
    const report = vecStatus(db as never, root).report;
    return { vectorsEmbedded: report?.embedded ?? 0, vectorsTotal: report?.total ?? 0 };
  } catch {
    return { vectorsEmbedded: 0, vectorsTotal: 0 };
  }
}

/**
 * Every session the recording named, still readable in this index — or refuse.
 *
 * The half of the freshness check that survives FIX-B D4, and the half that
 * was always the point. A recorded session the index can no longer read means
 * `filterAnswer` is about to check quotes against transcript bytes that have
 * moved or gone, and the answer would come out quietly thinner with no line
 * anywhere saying why. Re-recording is the only honest repair, so it is the
 * fix on the error.
 *
 * A session that merely *dropped out of the live ranking* is no longer an
 * error: the shortlist is pinned, so the ranking has no vote.
 */
function goneOrFail(
  abs: string,
  question: string,
  recorded: readonly string[],
  resolved: readonly string[],
): void {
  const have = new Set(resolved);
  const gone = recorded.filter((id) => !have.has(id));
  if (gone.length === 0) return;
  throw new UserError(
    `${abs} was recorded from ${gone.length} ${gone.length === 1 ? 'session' : 'sessions'} this ` +
      `index can no longer read (${id8s(gone)}). answering from it would check quotes against ` +
      'a transcript that is not there any more',
    `potsherd ask "${question}" --readers-out ${abs}    # re-record, then run your readers again`,
  );
}

// ======================================================== the synthesis file
//
// T10.2, audit fix 2. `--readers-out` / `--readers-in` moved six of `ask`'s
// seven model calls onto the host agent and left the seventh — the
// synthesizer — where it was. So the free path was free for six sevenths of
// its work and then demanded 677 MB of npm to finish. These two flags remove
// that last call, and with it the last reason potsherd needs model access of
// its own:
//
//   potsherd ask "q" --readers-out r.json                  0 calls
//   …the host answers each entry in r.json's "targets"…
//   potsherd ask "q" --readers-in r.json --synthesis-out s.json     0 calls
//   …the host answers s.json's "prompt"…
//   potsherd ask "q" --filter-in s.json                    0 calls, cited answer
//
// **What is not delegated is the guarantee.** The host's reply is run through
// `validateSynth` and then `filterAnswer`, in `packages/core/src/ask.ts`,
// against the transcript bytes on disk at the `(sessionId, seq)` each quote
// names. A fabricated quote from a host agent is deleted by exactly the code
// that deletes a fabricated quote from a backend, and the sentence that leaned
// on it goes with it. `tests/synthesis-seam.test.ts` plants one and proves the
// two paths drop it identically.

/** The envelope's discriminator. A file without it is not one of ours. */
export const SYNTHESIS_FILE_KIND = 'potsherd.ask.synthesis';

/** The envelope's own version. See {@link READERS_FILE_VERSION}. */
export const SYNTHESIS_FILE_VERSION = 1;

/**
 * What the host agent is told to put in `reply`, in the file and on the screen.
 *
 * FIX-G C4(c). The old sentence was *"answer "prompt" in the shape of "schema",
 * add it to the file as "reply""* — and "it" is the ambiguity. A model answers
 * a prompt with **text**; a host agent that captured that text and stored it
 * verbatim wrote `"reply": "{\"evidence\":…}"`, which is a string, and which
 * the seam then reported as *"the readers found nothing that answers the
 * question"*. The instruction is part of that defect: `schema` is itself a
 * JSON string in the file, so "the shape of schema" does not obviously mean
 * "a JSON value, not the text of one".
 *
 * So the shape is named rather than referred to, the two spellings potsherd
 * accepts are both stated, and the one it does not accept — prose — is stated
 * too. The same string is written **into** the file, because the agent that
 * gets handed a path never sees the terminal receipt.
 *
 * This is FIX-C's D7 in the other direction: there, a prompt and a filter
 * disagreed and a model that obeyed produced output the code rejected. Here a
 * prompt was vague and a model that obeyed one reading of it produced output
 * the code silently discarded.
 */
export const REPLY_INSTRUCTION =
  'answer "prompt" in the shape of "schema" and store that answer here as "reply". ' +
  '"reply" is the JSON object itself — {"evidence":[…],"answer":[…]} — or the JSON text ' +
  'of that object, which potsherd will parse. Prose, or a JSON value that is not that ' +
  'object, is refused rather than read as an empty answer.';

/** The `AskSynthInput` `ask()` hands a host synthesizer, without importing the name. */
type SynthInput = Parameters<NonNullable<AskOptions['synthFn']>>[0];

/**
 * What `--synthesis-out` writes and `--filter-in` reads.
 *
 * One file for both directions, and it carries the **reader outputs** as well
 * as the prompt. That is the difference between a three-file round trip and a
 * two-file one, and it matters for a reason beyond tidiness: `--filter-in`
 * runs the whole of `ask()` — shortlist, readers, synthesizer, filter — with
 * the readers and the synthesizer both supplied from this file. If the reader
 * outputs lived somewhere else, the answer and the evidence it is checked
 * against could come from two files recorded at two different times.
 */
export interface SynthesisFile {
  kind: string;
  version: number;
  /** The binary that wrote it. Informational; not checked. */
  potsherd: string;
  /** Redacted exactly as `llm.ts` would redact it on the way to a model. */
  question: string;
  k: number;
  /** The shortlist, in shortlist order. The replay checks this set. */
  sessionIds: string[];
  /** The synthesizer's system prompt, verbatim. */
  system: string;
  /** The reply shape the host must produce. */
  schema: string;
  /** The user prompt, verbatim — the quotes the answer is built from. */
  prompt: string;
  /** The citable set: which seqs each session's quotes may name. */
  sessions: SynthInput['sessions'];
  /** The reader outputs this prompt was built from. */
  readers: RecordedOutput[];
  /**
   * {@link REPLY_INSTRUCTION}, in the file, for the agent that only ever sees
   * the file. Informational: `--filter-in` neither reads it back nor checks it.
   */
  instruction: string;
  /** Added by whoever answered `prompt`. Absent in a fresh recording. */
  reply?: unknown;
}

/**
 * The `--synthesis-out` synthesizer: captures, returns nothing, and by doing
 * so makes the run structurally incapable of calling a model.
 *
 * The same trick as {@link recorder} and for the same reason. `ask()` opens a
 * synthesizer `Llm` only when no `synthFn` was supplied, so passing one means
 * no synthesizer backend is constructed at all; returning an empty reply means
 * `filterAnswer` has nothing to keep and the run ends with an empty answer,
 * which is the honest description of a recording pass.
 */
function synthCapture(): {
  fn: NonNullable<AskOptions['synthFn']>;
  seen: { input: SynthInput | null };
} {
  const seen: { input: SynthInput | null } = { input: null };
  const fn: NonNullable<AskOptions['synthFn']> = async (input) => {
    seen.input = input;
    return { evidence: [], answer: [] };
  };
  return { fn, seen };
}

/**
 * The whole of `--synthesis-out`, without the printing, so a test can drive it.
 *
 * `readersPath` is the `--readers-in` file. With it, the run costs zero model
 * calls end to end.
 *
 * It used to be optional, and without it the readers ran on whatever rung of
 * the ladder this machine reached. That was defended here as "a legitimate
 * thing to want (a bare terminal recording a prompt for a colleague's agent)",
 * with `probe.spend.calls` printed so the difference was never hidden — but
 * `--help` said the flag *makes no model call*, and a receipt reading
 * `no model call was made (6)` hides it by contradicting itself. FIX-G C5:
 * `runAsk` now refuses `--synthesis-out` without `--readers-in`, so every run
 * that reaches here is the free one. This function still takes the path as an
 * argument rather than assuming it, because it is exported and driven directly
 * by tests, and {@link synthesisOutReceipt} still reads the real call count
 * rather than printing a zero it has assumed.
 */
export async function writeSynthesisFile(
  db: Parameters<typeof ask>[0],
  question: string,
  base: AskOptions,
  path: string,
  readersPath: string,
  onProgress?: (p: AskProgress) => void,
): Promise<{ file: SynthesisFile | null; abs: string; probe: AskResult; notes: string[] }> {
  const staged = readersPath ? await stageReaders(db, question, base, readersPath) : null;
  const cap = synthCapture();
  const probe = await ask(db, question, {
    ...base,
    // FIX-B D4. The pin belongs on every pass that consumes a recording, not
    // only on `replayReaders`. Without it this pass built the live shortlist
    // and looked recorded outputs up by session id against it, so a shortlist
    // that had moved produced `found: false` for whatever it no longer
    // contained — a quietly thinner synthesis prompt, with nothing anywhere
    // saying the recording had been half ignored.
    ...(staged ? { pin: staged.pin, readerFn: staged.readerFn } : {}),
    ...(onProgress && !staged ? { onProgress } : {}),
    synthFn: cap.fn,
    openThreads: false,
  });

  const abs = nodePath.resolve(path);
  // No reader found anything, so there is nothing to synthesize and no file
  // worth writing. `ask()` reports that itself; writing an empty prompt here
  // would hand the host agent a question with no evidence under it, which is
  // the one shape that produces a confident answer from nothing.
  const notes = staged?.notes ?? [];
  if (!cap.seen.input) return { file: null, abs, probe, notes };

  const input = cap.seen.input;
  const q = redactOutgoing(question).text;
  const file: SynthesisFile = {
    kind: SYNTHESIS_FILE_KIND,
    version: SYNTHESIS_FILE_VERSION,
    potsherd: VERSION,
    question: q,
    k: base.k ?? ASK_K,
    // THE FULL SHORTLIST, not the synthesizer's inputs.
    //
    // `--filter-in` re-derives the live shortlist and refuses when this list
    // does not cover it, because answering from a stale file would print the
    // live run's counts over recorded content. The synthesizer, though, only
    // ever sees the sessions whose readers found something — four of six here
    // is an ordinary result, not a degenerate one. Recording the subset made
    // the freshness check fire on the happy path: every seam round trip in
    // which any reader reported `found: false` was refused, which is almost
    // all of them. `staged.live` is the same list `--filter-in` will compute.
    sessionIds: staged ? staged.live : input.sessions.map((s) => s.sessionId),
    system: input.system,
    schema: input.schema,
    // Redacted on the way out for the reason `writeReadersFile` gives: `llm.ts`
    // masks every outgoing string immediately before a transport sees it, so a
    // file a user names must not be able to hold a byte a model would not have
    // been sent. It is a no-op today and the test asserts that it is.
    prompt: redactOutgoing(input.prompt).text,
    sessions: input.sessions,
    readers: staged ? staged.outputs : [],
    instruction: REPLY_INSTRUCTION,
  };
  fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return { file, abs, probe, notes };
}

async function recordSynthesis(
  db: Parameters<typeof ask>[0],
  question: string,
  base: AskOptions,
  path: string,
  readersPath: string,
  o: AskCommandOptions,
  t: ReturnType<typeof themeFrom>,
  onProgress: (p: AskProgress) => void,
): Promise<number> {
  const { file, abs, probe, notes } = await writeSynthesisFile(
    db,
    question,
    base,
    path,
    readersPath,
    onProgress,
  );
  // Provenance before the receipt: this prompt was built from a recorded
  // shortlist, and the reader is owed that before they hand it to a model.
  if (!o.json && !o.quiet) for (const line of notes) print(`  ${t.dim(line)}`);

  if (o.json) {
    printJson({
      kind: SYNTHESIS_FILE_KIND,
      version: SYNTHESIS_FILE_VERSION,
      path: abs,
      question: file?.question ?? redactOutgoing(question).text,
      k: file?.k ?? base.k ?? ASK_K,
      sessionIds: file?.sessionIds ?? [],
      sessions: file?.sessions ?? [],
      promptChars: file?.prompt.length ?? 0,
      // FIX-G C4(c). The `--json` receipt is what an agent reads, and it is
      // the surface on which the shape of `reply` was least well stated: the
      // instruction only ever existed in the human receipt.
      instruction: REPLY_INSTRUCTION,
      matching: probe.matching,
      searched: probe.searched,
      modelCalls: probe.spend.calls,
    });
  } else {
    print(synthesisOutReceipt(file, abs, probe, t));
  }
  return file ? 0 : 1;
}

function synthesisOutReceipt(
  file: SynthesisFile | null,
  abs: string,
  probe: AskResult,
  t: ReturnType<typeof themeFrom>,
): string {
  const lines: string[] = [];
  if (!file) {
    lines.push(`  no reader found anything — no synthesis prompt written to ${abs}`);
    return lines.join('\n');
  }
  const n = file.sessions.length;
  lines.push(`  ${t.accent('1 synthesis prompt')} → ${abs}`);
  lines.push(
    `  built from ${n} session${n === 1 ? '' : 's'} of ${probe.searched} read ${t.sep} ` +
      `${file.prompt.length.toLocaleString('en-US')} chars`,
  );
  lines.push('');
  for (const s of file.sessions) {
    lines.push(
      `    ${s.id8}  ${s.project}${s.isGhost ? t.dim('  ghost') : ''}` +
        `${s.isSidechain ? t.dim('  subagent') : ''}  ${t.dim(`seq ${s.seqs.join(', ')}`)}`,
    );
  }
  lines.push('');
  // FIX-G C5, the second half. `no model call was made (N)` is a sentence that
  // contradicts its own parenthesis whenever N is not zero, and before the
  // guard in `runAsk` this path could print it with N = 6. The guard makes that
  // unreachable from the CLI; this makes the sentence true by construction
  // rather than true by precondition, for any caller of the exported
  // `writeSynthesisFile` that reaches this renderer.
  const calls = probe.spend.calls;
  lines.push(
    `  ${t.dim(
      calls === 0
        ? 'no model call was made (0). the prompt is redacted, as sent.'
        : `${calls} model ${calls === 1 ? 'call was' : 'calls were'} made — the readers ran here. ` +
          'the prompt is redacted, as sent.',
    )}`,
  );
  lines.push('');
  // FIX-G C4(c). See {@link REPLY_INSTRUCTION} for why "add it to the file as
  // reply" was not a specific enough sentence to be obeyed.
  lines.push('  answer "prompt" in the shape of "schema" and add that answer to the file as "reply" —');
  lines.push('  the JSON object {"evidence":[…],"answer":[…]}, or the JSON text of it. then:');
  lines.push(`    potsherd ask "${file.question}" --filter-in ${abs}`);
  return lines.join('\n');
}

/**
 * `--filter-in`: the host answered, and now **code** decides what it may say.
 *
 * This is the step the whole seam exists for, so it is worth being exact about
 * what is and is not trusted here.
 *
 * *Not trusted:* the answer, every quote in it, every seq it names, and the
 * file's own claim about which sessions it covers. The reply is validated into
 * shape by `validateSynth` and then checked, quote by quote, against the
 * transcript bytes at the `(sessionId, seq)` it names — the **live** bytes, in
 * the index, not the copy in the file. A quote that was paraphrased, trimmed
 * in the middle, or attributed to the wrong exchange is deleted, and a
 * sentence whose evidence was all deleted is deleted with it. That is
 * `filterAnswer`, unchanged, on the same code path a backend's reply takes.
 *
 * *Trusted:* nothing else needs to be. The shortlist is rebuilt live and
 * checked against the file's, at zero model calls, for the reasons
 * {@link matchOrFail} sets out — a file that no longer covers what this
 * question shortlists would print the live counts over stale evidence.
 *
 * Open threads are off. That section is advisory and makes its own model call;
 * running it here would turn a zero-call path into a one-call path for a
 * section nobody asked for.
 */
export async function filterHostAnswer(
  db: Parameters<typeof ask>[0],
  question: string,
  base: AskOptions,
  path: string,
  onNote?: (line: string) => void,
): Promise<AskResult> {
  const abs = nodePath.resolve(path);
  const file = readSynthesisFile(abs);
  const q = redactOutgoing(question).text;

  if (file.question !== q) {
    throw new UserError(
      `${abs} was recorded against a different question — replaying it would answer ` +
        `"${file.question}" and print it under "${q}"`,
      `potsherd ask "${file.question}" --filter-in ${abs}`,
    );
  }
  const k = base.k ?? ASK_K;
  if (file.k !== k) {
    throw new UserError(
      `${abs} was recorded with --k ${file.k} and this run asked for --k ${k}, ` +
        'which is a different shortlist',
      `potsherd ask "${q}" --k ${file.k} --filter-in ${abs}`,
    );
  }
  // FIX-G C4. Every shape of `reply` that this run cannot use is refused here,
  // by name, before `ask()` is entered. See {@link hostReply}.
  const { reply, note: replyNote } = hostReply(abs, file.reply);

  // ---- pass one: the recorded shortlist, resolved against the live index, at
  // zero model calls.
  //
  // FIX-B D4, the third leg. This used to rebuild the shortlist and refuse
  // when it had moved, which is the same failure `--readers-in` had and the
  // same reason: the embedding pass keeps landing vectors while a host agent
  // answers a prompt, and the ranking is a function of how many have landed.
  // The shortlist recorded in the synthesis file is pinned, so what is checked
  // is the only thing that can still make the answer wrong — whether this
  // index can still read every session the prompt was built from.
  const pin: NonNullable<AskOptions['pin']> = { sessionIds: file.sessionIds };
  const rec = recorder();
  await ask(db, question, { ...base, pin, concurrency: 1, openThreads: false, readerFn: rec.fn });
  const live = rec.seen.map((x) => x.sessionId);
  goneOrFail(abs, q, file.sessionIds, live);

  // The readers are a *subset*: only sessions that found something reach the
  // synthesizer, and the rest legitimately contributed nothing. So this one is
  // checked the other way round — every recorded reader must still be
  // shortlisted, and a shortlisted session with no recorded reader is the
  // ordinary `found: false`.
  const known = new Set(file.sessionIds);
  const orphans = file.readers.map((r) => r.sessionId).filter((id) => !known.has(id));
  if (orphans.length > 0) {
    throw new UserError(
      `${abs}'s "readers" name ${orphans.length} session${orphans.length === 1 ? '' : 's'} ` +
        `this question no longer shortlists (${id8s(orphans)}), so its answer rests on evidence ` +
        'that is no longer in scope',
      `potsherd ask "${q}" --readers-out r.json    # re-record, then run the round trip again`,
    );
  }

  const byId = new Map<string, AskReaderOutput>();
  for (const out of file.readers) byId.set(out.sessionId, out);
  const readerFn: AskReaderFn = async (input) =>
    byId.get(input.sessionId) ?? { found: false, quotes: [], answer_fragment: '' };

  // ---- pass two: the real run. Both halves recorded, so `ask()` contains no
  // expression that can construct a backend, and `filterAnswer` does the work.
  // The parse is provenance, not decoration: an answer built from a string this
  // command turned into an object is a fact the reader is owed before they act
  // on it. It goes through `onNote` rather than onto `AskResult`, because
  // `--json` prints `AskResult` verbatim and a field that appears only on the
  // seam path would make the two paths' JSON differ for no reason a consumer
  // could use. `replayReaders` reports its provenance the same way.
  if (replyNote) onNote?.(replyNote);

  return ask(db, question, {
    ...base,
    pin,
    readerFn,
    synthFn: async () => reply,
    openThreads: false,
  });
}

// ============================================ the reply, before it is believed
//
// FIX-G C4. `filterHostAnswer` used to check `reply === undefined || null` and
// hand whatever else it found to `synthFn`. Everything downstream of that is
// tolerant by design — `validateSynth` returns `null` for a value it cannot
// read, `hostSynthesize` turns that `null` into `{evidence:[],answer:[]}`, and
// `filterAnswer` correctly keeps nothing out of nothing — so a `reply` that
// was a **JSON string**, which is what a model returns and what the
// instruction as written invited, came out the far end as:
//
//     no grounded answer in 6 sessions searched
//     the readers found nothing that answers the question.
//     6 of 6 sessions read · 1 answered · 323ms
//
// A capability failure wearing the honest empty's clothes, contradicted by the
// count on the line below it. The honest empty is the one signal this release
// asks an agent to trust — the MCP tool description says *TRUST ITS SILENCE* —
// so a run that cannot use its input must say that, in those words, and must
// not be reachable through the same exit as a run that read the archive and
// found nothing.

/** {@link hostReply}'s answer: the value `synthFn` will return, and why. */
interface HostReply {
  /** The reply as an object, parsed out of a JSON string when it was one. */
  reply: unknown;
  /** Provenance to print, when this run had to parse. Empty otherwise. */
  note: string;
}

/**
 * What a value is, said without printing it.
 *
 * Deliberate: this repository is public, `reply` is a model's prose about the
 * user's own transcripts, and an error message that echoed it would put a
 * sentence from a private session into a terminal, a CI log or a bug report.
 * The type is enough to fix the mistake.
 */
function shapeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

/**
 * The two necessary conditions {@link ProposedEvidence} and
 * {@link ProposedSentence} are built from, copied from `validateSynth`'s own
 * filters in `packages/core/src/ask.ts`.
 *
 * This is a **usability probe, not a second validator**, and the distinction
 * is the one `readSynthesisFile`'s docstring insists on. It never decides what
 * is valid — `validateSynth` still does that, unchanged, on the same call it
 * always did. It decides only whether there is anything here for that function
 * to keep, because "nothing to keep" is the case that was being rendered as an
 * empty archive. Being a strict subset of `validateSynth`'s conditions, it
 * cannot refuse a reply the binary path would have accepted.
 */
function usableEvidence(x: unknown): boolean {
  if (!isRecord(x)) return false;
  return (
    String(x['session_id'] ?? '').length > 0 &&
    Number.isInteger(Number(x['seq'])) &&
    typeof x['quote'] === 'string' &&
    x['quote'].length > 0
  );
}

function usableSentence(x: unknown): boolean {
  return isRecord(x) && typeof x['text'] === 'string' && x['text'].trim().length > 0;
}

/**
 * The exit code every one of these refusals carries, and why it is not 1.
 *
 * `ask`'s codes are `0` a grounded answer, `1` the archive was read and had
 * nothing, `2` potsherd declined to answer (`--strict`, phase-4 T4.1 §4). The
 * whole of C4 is that a broken input was being reported in the vocabulary of
 * `1`, so `1` is the one code these must not use: a caller that branches on
 * the exit status would go on treating a file it must fix as a fact about the
 * user's archive. `2` already means *this run declined to answer, and that is
 * not a statement about your corpus*, which is exactly what this is. Both
 * refusals about the `reply` field share it — a missing reply and an unusable
 * one are the same problem at two stages, and giving them two codes would be a
 * distinction with nothing behind it.
 */
const REPLY_EXIT = 2;

/**
 * Turn the recorded `reply` into the object `synthFn` must return, or refuse.
 *
 * Accepted, in order:
 *
 *   - **the object** — `{"evidence":[…],"answer":[…]}`, the documented shape.
 *   - **a JSON string of that object** — what a model produces when a host
 *     agent captures its text and stores it. Parsed. A ```` ```json ```` fence
 *     around it is stripped first, because that is what a model produces when
 *     it is being helpful, and stripping it is still an explicit parse: if
 *     what is inside is not JSON the run refuses, loudly, below.
 *   - **an object with both arrays empty** — the host's own honest empty. A
 *     synthesizer that read the evidence and concluded nothing is supportable
 *     is answering, not failing, and it must keep reaching the empty-answer
 *     render. This is the one case where an empty result is the truth.
 *
 * Refused, each naming what was found and how to fix it:
 *
 *   - a string that is not JSON (prose, a fenced block that is not JSON, an
 *     empty string).
 *   - a JSON string that parses to something other than an object.
 *   - any other non-object: a number, a boolean, an array.
 *   - an object carrying neither an `evidence` array nor an `answer` array.
 *   - an object carrying an `evidence` array and **no `answer` array** — FIX-I
 *     C-7. Not an empty answer: an unfinished one. See the comment at the
 *     check for why that is a refusal rather than the honest empty, and why
 *     the mirror shape (`answer` with no `evidence`) is still accepted.
 *   - an object whose arrays hold entries but **not one** of which meets the
 *     schema's necessary conditions — the case that would reach
 *     `validateSynth`, come back `null`, and print as an empty archive.
 *
 * The ruling this was written under: if accepting the string form would let
 * something through that the object form catches, reject it loudly instead. It
 * does not. The parsed value re-enters at exactly the point the object form
 * enters — `validateSynth`, then `filterAnswer`, against the transcript bytes —
 * so a fabricated quote inside a JSON string dies in the same line of code as a
 * fabricated quote inside an object. `tests/synthesis-seam.test.ts` plants the
 * same fabrication in both spellings and compares the two results field for
 * field.
 */
export function hostReply(abs: string, raw: unknown): HostReply {
  const fix = 'answer its "prompt" in the shape of its "schema", then store that object as "reply"';
  if (raw === undefined || raw === null) {
    throw new UserError(
      `${abs} has no "reply" — it is a --synthesis-out recording that nobody has answered yet`,
      fix,
      REPLY_EXIT,
    );
  }

  let value = raw;
  let note = '';
  if (typeof raw === 'string') {
    const text = unfence(raw).trim();
    if (text === '') {
      throw new UserError(
        `${abs}'s "reply" is an empty string, so there is no answer in it to filter — ` +
          'that is a file nobody has answered, not an archive with nothing in it',
        fix,
        REPLY_EXIT,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The parser's own message is **not** printed, and this is the one place
      // in the file where that rule bites. `JSON.parse` reports a failure as
      // `Unexpected token 'T', "The alloca"… is not valid JSON` — ten
      // characters of the value, quoted back. For `readSynthesisFile` that is
      // the head of an envelope potsherd wrote itself; here it is a model's
      // prose about the user's own transcripts, on its way into a terminal, a
      // CI log or a pasted bug report. The fix line says what to do, and the
      // ten characters add nothing to it.
      throw new UserError(
        `${abs}'s "reply" is a string and it is not JSON. potsherd will parse a JSON string ` +
          'for you, but this is prose, and prose carries no quote it can check',
        fix,
        REPLY_EXIT,
      );
    }
    if (!isRecord(parsed)) {
      throw new UserError(
        `${abs}'s "reply" is a JSON string containing ${shapeOf(parsed)}, and the shape ` +
          '"schema" asks for is an object',
        fix,
        REPLY_EXIT,
      );
    }
    value = parsed;
    note = 'the recorded "reply" was a JSON string; parsed it into the object the filter checks.';
  }

  if (!isRecord(value)) {
    throw new UserError(
      `${abs}'s "reply" is ${shapeOf(value)}, and the shape "schema" asks for is an object`,
      fix,
      REPLY_EXIT,
    );
  }

  const ev = Array.isArray(value['evidence']) ? value['evidence'] : null;
  const ans = Array.isArray(value['answer']) ? value['answer'] : null;
  if (ev === null && ans === null) {
    throw new UserError(
      `${abs}'s "reply" is an object with neither an "evidence" array nor an "answer" array, ` +
        'so there is nothing in it for the citation filter to check',
      fix,
      REPLY_EXIT,
    );
  }
  // FIX-I C-7 — the shape between the two FIX-G decided.
  //
  // FIX-G refuses an object carrying **neither** array and allows
  // `{"evidence":[],"answer":[]}`, because that is the host synthesizer's own
  // honest empty. An object with real evidence in it and **no `answer` key at
  // all** fell between them: it passed, `validateSynth` built nothing out of
  // it, and it printed *byte-identically* to the honest empty at exit 1 —
  // "the readers found material, and the answer built from it was empty".
  //
  // **It is a refusal, and here is the argument.** Exit 1 is a claim about the
  // user's archive: *it was read and it had nothing.* The honest empty is the
  // one signal this release asks an agent to trust — the tool description says
  // TRUST ITS SILENCE — so the bar for reaching it is that the host actually
  // said the answer was empty. `"answer": []` says that, in four characters, and
  // a synthesizer that has produced evidence has manifestly not stopped for
  // lack of anything to say. An absent key is not a value: it is a reply
  // nobody finished writing, which is C4's own sentence one shape further out,
  // and C4's ruling is that a broken input must not be reported in the
  // vocabulary of an empty corpus.
  //
  // The reverse shape — an `answer` array with no `evidence` key — is
  // deliberately still accepted. It reaches `filterAnswer`, every sentence
  // fails to resolve a citation, and the receipt says
  // `N sentences dropped · no citation that resolves`: a different sentence
  // from the honest empty, naming what went wrong. Nothing is silent there, so
  // there is nothing for this to fix.
  if (ans === null) {
    throw new UserError(
      `${abs}'s "reply" has an "evidence" array and no "answer" array, so there is no answer in ` +
        'it to filter — that is a reply nobody finished, not an archive with nothing in it. ' +
        'A synthesizer that concluded nothing is supportable writes "answer": []',
      fix,
      REPLY_EXIT,
    );
  }
  const n = (ev?.length ?? 0) + (ans?.length ?? 0);
  if (n > 0 && !(ev ?? []).some(usableEvidence) && !(ans ?? []).some(usableSentence)) {
    throw new UserError(
      `${abs}'s "reply" holds ${ev?.length ?? 0} evidence ${
        (ev?.length ?? 0) === 1 ? 'entry' : 'entries'
      } and ${ans?.length ?? 0} ${(ans?.length ?? 0) === 1 ? 'sentence' : 'sentences'}, and not ` +
        'one of them is usable: evidence needs "session_id", an integer "seq" and a "quote"; ' +
        'a sentence needs "text"',
      fix,
      REPLY_EXIT,
    );
  }

  return { reply: value, note };
}

/**
 * Strip one ```` ``` ```` fence, when the whole string is inside it.
 *
 * A model asked for JSON very often returns it fenced, and a host agent that
 * captured the text verbatim stored the fence with it. Nothing is guessed
 * here: what comes out still has to parse as JSON or the run refuses. Only a
 * fence wrapping the *entire* value is removed, so a fence inside a JSON
 * string cannot be disturbed.
 */
function unfence(s: string): string {
  const m = /^\s*```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(s);
  return m ? (m[1] ?? '') : s;
}

/**
 * Read and validate the envelope, to the same standard {@link readReadersFile}
 * holds — with one deliberate hole. `reply` is **not** shape-checked here.
 *
 * It is checked by `validateSynth` in `packages/core/src/ask.ts`, which is the
 * same function that checks a backend's reply, and a second validator in this
 * file could only ever be a weaker or a stricter copy of it. Weaker would let
 * something through on the seam path that the binary path rejects; stricter
 * would refuse a host answer that a model is allowed to give. Both are the
 * same bug — the two paths disagreeing — so there is one validator and it
 * lives beside the filter it feeds.
 *
 * FIX-G C4 leaves that ruling exactly as it is. {@link hostReply} runs in
 * `filterHostAnswer`, not here, and it decides one question `validateSynth`
 * does not answer for a caller — *is there anything here at all* — because the
 * answer `null` was being rendered as a fact about the archive. What counts as
 * valid is still decided in one place.
 */
function readSynthesisFile(abs: string): SynthesisFile {
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new UserError(`cannot read ${abs}`, `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UserError(
      `${abs} is not JSON — ${err instanceof Error ? err.message : String(err)}`,
      `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new UserError(`${abs} is not a synthesis file — expected a JSON object`, `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}`);
  }
  if (parsed['kind'] !== SYNTHESIS_FILE_KIND) {
    throw new UserError(
      `${abs} is not a synthesis file — "kind" is ${JSON.stringify(parsed['kind'] ?? null)}, ` +
        `expected "${SYNTHESIS_FILE_KIND}"`,
      parsed['kind'] === READERS_FILE_KIND
        ? `potsherd ask "…" --readers-in ${abs} --synthesis-out s.json    # that is the reader file`
        : `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}`,
    );
  }
  const v = parsed['version'];
  if (v !== SYNTHESIS_FILE_VERSION) {
    throw new UserError(
      typeof v === 'number'
        ? `${abs} is a v${String(v)} synthesis file and this potsherd (${VERSION}) reads v${String(SYNTHESIS_FILE_VERSION)}`
        : `${abs} has no "version" — this potsherd (${VERSION}) reads v${String(SYNTHESIS_FILE_VERSION)} synthesis files`,
      `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}    # re-record with this build`,
    );
  }
  const question = parsed['question'];
  if (typeof question !== 'string' || question.trim() === '') {
    throw new UserError(
      `${abs} has no "question" — a synthesis file that cannot say what it was recorded for is not replayable`,
      `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}`,
    );
  }
  const k = parsed['k'];
  if (typeof k !== 'number' || !Number.isFinite(k) || k < 1) {
    throw new UserError(`${abs} has no usable "k"`, `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}`);
  }
  const sessionIds = parsed['sessionIds'];
  if (!Array.isArray(sessionIds) || sessionIds.some((x) => typeof x !== 'string' || x === '')) {
    throw new UserError(`${abs} has no usable "sessionIds"`, `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}`);
  }
  const rawReaders = parsed['readers'];
  if (!Array.isArray(rawReaders)) {
    throw new UserError(
      `${abs} has no "readers" array — the answer would be filtered against nothing`,
      `potsherd ask "…" --readers-in r.json --synthesis-out ${abs}`,
    );
  }
  const readers = rawReaders.map((entry, i) => readerOutput(abs, entry, i));

  return {
    kind: SYNTHESIS_FILE_KIND,
    version: SYNTHESIS_FILE_VERSION,
    potsherd: typeof parsed['potsherd'] === 'string' ? parsed['potsherd'] : '',
    question,
    k,
    sessionIds: sessionIds as string[],
    system: typeof parsed['system'] === 'string' ? parsed['system'] : '',
    schema: typeof parsed['schema'] === 'string' ? parsed['schema'] : '',
    prompt: typeof parsed['prompt'] === 'string' ? parsed['prompt'] : '',
    sessions: Array.isArray(parsed['sessions']) ? (parsed['sessions'] as SynthesisFile['sessions']) : [],
    readers,
    // Read back for completeness only. It is advice to the host agent, not an
    // input to anything here, so a file written by an older build that has no
    // `instruction` is read without complaint.
    instruction: typeof parsed['instruction'] === 'string' ? parsed['instruction'] : '',
    ...(parsed['reply'] !== undefined ? { reply: parsed['reply'] } : {}),
  };
}

/**
 * The stale-file check, and the ruling on a partial match: **any difference is
 * an error.**
 *
 * The tempting alternative is to answer from the overlap. It is wrong, and
 * specifically it is wrong in a way the user cannot see. `AskResult.searched`
 * and `AskResult.matching` are printed as "n of m sessions read", and on a
 * partial replay they would be the live shortlist's numbers over a file that
 * covers less than it. The answer would read as a full sweep of the corpus
 * while a session the live shortlist ranked *into* the top k contributed
 * nothing — and `filterAnswer` cannot see that, because it checks the quotes
 * it is given and has no view of the ones nobody produced. That is precisely
 * "silently answer from a stale file", arrived at one session at a time.
 *
 * The mismatch also always has the same cause — the index moved between the
 * recording and the replay — and always the same one-command fix. So the error
 * names both directions, because they fail differently and only one of them is
 * dangerous: a session in the file and not in the shortlist is merely unused,
 * while a session in the shortlist and not in the file is the hole.
 */
function matchOrFail(
  abs: string,
  question: string,
  what: string,
  recorded: readonly string[],
  live: readonly string[],
): void {
  const have = new Set(recorded);
  const want = new Set(live);
  const missing = live.filter((id) => !have.has(id));
  const extra = recorded.filter((id) => !want.has(id));
  if (missing.length === 0 && extra.length === 0 && recorded.length === live.length) return;

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${missing.length} shortlisted session${missing.length === 1 ? '' : 's'} it does not cover (${id8s(missing)})`);
  }
  if (extra.length > 0) {
    parts.push(`${extra.length} session${extra.length === 1 ? '' : 's'} no longer shortlisted (${id8s(extra)})`);
  }
  if (parts.length === 0) parts.push('a duplicated session id');
  throw new UserError(
    `${abs}'s ${what} does not match the shortlist this question produces now: ${parts.join(', ')}. ` +
      'answering from it would print the live shortlist\'s counts over a stale file',
    `potsherd ask "${question}" --readers-out ${abs}    # re-record, then run your readers again`,
  );
}

function id8s(ids: readonly string[]): string {
  return ids
    .slice(0, 4)
    .map((id) => idTag(id))
    .join(' ')
    .concat(ids.length > 4 ? ` +${ids.length - 4}` : '');
}

/**
 * Read and validate the envelope.
 *
 * Every failure here is a `UserError` naming the file and the field. A reader
 * file is written by a skill, by hand, or by an agent that may have got the
 * shape wrong; the failure mode to design against is a file that parses into
 * something plausible and empty, because `ask()` would then answer "no reader
 * found anything" about a corpus that had plenty.
 */
function readReadersFile(abs: string): ReadersFile {
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new UserError(`cannot read ${abs}`, `potsherd ask "…" --readers-out ${abs}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UserError(`${abs} is not JSON — ${err instanceof Error ? err.message : String(err)}`, `potsherd ask "…" --readers-out ${abs}`);
  }
  if (!isRecord(parsed)) throw new UserError(`${abs} is not a reader file — expected a JSON object`, `potsherd ask "…" --readers-out ${abs}`);
  if (parsed['kind'] !== READERS_FILE_KIND) {
    throw new UserError(
      `${abs} is not a reader file — "kind" is ${JSON.stringify(parsed['kind'] ?? null)}, expected "${READERS_FILE_KIND}"`,
      `potsherd ask "…" --readers-out ${abs}`,
    );
  }
  if (parsed['version'] !== READERS_FILE_VERSION) {
    // D12: `String(undefined)` is `"undefined"`, and this read
    // `is a vundefined reader file` for the commonest case of all — a file
    // that has `kind` right and no `version` at all, which is what a
    // hand-edited or half-written recording looks like. A missing field and a
    // field from the future are different problems and get different
    // sentences; only a number is ever printed after a `v`.
    const v = parsed['version'];
    throw new UserError(
      typeof v === 'number'
        ? `${abs} is a v${String(v)} reader file and this potsherd (${VERSION}) reads v${String(READERS_FILE_VERSION)}`
        : `${abs} has no "version" — this potsherd (${VERSION}) reads v${String(READERS_FILE_VERSION)} reader files` +
          `${v === undefined ? '' : `, and "version" here is ${JSON.stringify(v)}`}`,
      `potsherd ask "…" --readers-out ${abs}    # re-record with this build`,
    );
  }
  const question = parsed['question'];
  if (typeof question !== 'string' || question.trim() === '') {
    throw new UserError(`${abs} has no "question" — a reader file that cannot say what it was recorded for is not replayable`, `potsherd ask "…" --readers-out ${abs}`);
  }
  const k = parsed['k'];
  if (typeof k !== 'number' || !Number.isFinite(k) || k < 1) {
    throw new UserError(`${abs} has no usable "k"`, `potsherd ask "…" --readers-out ${abs}`);
  }
  const sessionIds = parsed['sessionIds'];
  if (!Array.isArray(sessionIds) || sessionIds.some((x) => typeof x !== 'string' || x === '')) {
    throw new UserError(`${abs} has no usable "sessionIds"`, `potsherd ask "…" --readers-out ${abs}`);
  }
  const targets = Array.isArray(parsed['targets']) ? (parsed['targets'] as AskReaderInput[]) : [];

  const rawOutputs = parsed['outputs'];
  let outputs: RecordedOutput[] | undefined;
  if (rawOutputs !== undefined && rawOutputs !== null) {
    if (!Array.isArray(rawOutputs)) throw new UserError(`${abs}: "outputs" must be an array`, 'one entry per session in "targets"');
    outputs = rawOutputs.map((entry, i) => readerOutput(abs, entry, i));
  }

  return {
    kind: READERS_FILE_KIND,
    version: READERS_FILE_VERSION,
    potsherd: typeof parsed['potsherd'] === 'string' ? parsed['potsherd'] : '',
    // Read, never enforced — FIX-I C-5, and the same rule `readSynthesisFile`
    // applies to its own two: these say what the agent was asked to produce,
    // and `readerOutput` below is what decides whether it did. A file written
    // by a build that had neither carries `''` and replays exactly as before.
    schema: typeof parsed['schema'] === 'string' ? parsed['schema'] : '',
    instruction: typeof parsed['instruction'] === 'string' ? parsed['instruction'] : '',
    question,
    k,
    sessionIds: sessionIds as string[],
    targets,
    ...(outputs ? { outputs } : {}),
    ...(indexBlock(parsed['index']) ? { index: indexBlock(parsed['index'])! } : {}),
  };
}

/**
 * The recorded index state, when the file has a usable one.
 *
 * Never throws and never refuses a file over it. It is a **provenance** field,
 * not a mismatch detector: a recording written by an older build has none, and
 * one that is malformed tells a replay nothing rather than making it fail —
 * the round trip's job is to answer, and a half-typed number in a field whose
 * only consumer is one printed sentence is not a reason to stop.
 */
function indexBlock(raw: unknown): ReadersFile['index'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const n = (k: string): number | undefined =>
    typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined;
  const embedded = n('vectorsEmbedded');
  const total = n('vectorsTotal');
  const matching = n('matching');
  if (embedded === undefined || total === undefined || matching === undefined) return undefined;
  return {
    vectorsEmbedded: embedded,
    vectorsTotal: total,
    matching,
  };
}

/**
 * One `AskReaderOutput`, checked to the same shape the SDK reader is validated
 * to in `ask.ts`. Loose here would mean a quote with no `seq`, which
 * `filterAnswer` drops — correctly, but for a reason the user would read as
 * "the model made it up" rather than "the file was malformed".
 */
function readerOutput(abs: string, entry: unknown, i: number): RecordedOutput {
  const where = `${abs}: outputs[${i}]`;
  if (!isRecord(entry)) throw new UserError(`${where} is not an object`, 'each entry is { sessionId, found, quotes, answer_fragment }');
  const sessionId = entry['sessionId'];
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new UserError(`${where} has no "sessionId"`, 'copy it from the matching entry in "targets"');
  }
  if (typeof entry['found'] !== 'boolean') {
    throw new UserError(`${where} ("${idTag(sessionId)}") has no boolean "found"`, 'a reader that found nothing records "found": false — it is not omitted');
  }
  const rawQuotes = entry['quotes'];
  if (!Array.isArray(rawQuotes)) throw new UserError(`${where} ("${idTag(sessionId)}") has no "quotes" array`, '"quotes": [] when found is false');
  const quotes = rawQuotes.map((qq, j) => {
    if (!isRecord(qq)) throw new UserError(`${where}.quotes[${j}] is not an object`, '{ "seq": n, "ts": "…"|null, "text": "…" }');
    const seq = qq['seq'];
    if (typeof seq !== 'number' || !Number.isInteger(seq)) {
      throw new UserError(`${where}.quotes[${j}] has no integer "seq"`, 'the seq must be one of that session\'s "seqs" in "targets"');
    }
    const text = qq['text'];
    if (typeof text !== 'string') throw new UserError(`${where}.quotes[${j}] has no "text"`, 'copied character for character out of that session\'s excerpts');
    const ts = qq['ts'];
    return { seq, ts: typeof ts === 'string' ? ts : null, text };
  });
  const fragment = entry['answer_fragment'];
  return {
    sessionId,
    found: entry['found'],
    quotes,
    answer_fragment: typeof fragment === 'string' ? fragment : '',
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function flagPath(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim();
}

/**
 * `--strict` refusing is not an error in the shell sense of "something broke",
 * but it must be distinguishable from an answer, or `potsherd ask … --strict &&
 * do-something` would act on a refusal. phase-4 T4.1 §4 fixes it at 2.
 */
function exitCode(r: AskResult): number {
  if (r.refused) return 2;
  return r.sentences.length > 0 ? 0 : 1;
}

/**
 * What the filter threw away, under `--debug` only.
 *
 * On stderr, so it can never contaminate `--json`. This is the audit trail for
 * the one claim the product makes that nobody should take on trust: a run that
 * drops nothing on an adversarial question is a bug, and without this there is
 * no way to see it from outside.
 */
function reportDrops(drops: readonly AskDrop[]): void {
  if (drops.length === 0) {
    process.stderr.write('  filter: nothing dropped\n');
    return;
  }
  process.stderr.write(`  filter: ${drops.length} dropped\n`);
  for (const d of drops) {
    const where = d.sessionId ? `${idTag(d.sessionId)}@${d.seq}` : '';
    const text = d.text.replace(/\s+/g, ' ').slice(0, 90);
    process.stderr.write(`    ${d.kind.padEnd(8)} ${d.reason.padEnd(16)} ${where.padEnd(14)} ${text}\n`);
  }
}

function positive(value: unknown, fallback: number, flag: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new UserError(`${flag} takes a positive number — not "${String(value)}"`, `potsherd ask "…" ${flag} ${fallback}`);
  }
  return Math.floor(n);
}

function money(value: unknown): number {
  if (value === undefined || value === null || value === '') return ASK_MAX_USD;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UserError(
      `--max-usd takes a positive number — not "${String(value)}"`,
      `potsherd ask "…" --max-usd ${ASK_MAX_USD}`,
    );
  }
  return n;
}

/**
 * `--vectors on|auto|off`, or **nothing at all**.
 *
 * Returning `undefined` when the user did not choose is the whole point and it
 * cost a day to learn: `find` registers `--vectors` with `.default('auto')`,
 * and copying that here meant the CLI passed `'auto'` on every run and
 * silently overrode `ask`'s own default of vectors-on. Every real run then
 * shortlisted on bm25 alone, and on the reference corpus that is the
 * difference between the six sessions that discuss the question and six that
 * tie at 0.0098 because the AND pass relaxed. Four consecutive runs came back
 * `0 answered` and the readers were blamed for it.
 *
 * So the flag has no default here. Unset means "the library decides", and the
 * library's reasoning is in `ask.ts` beside the `recall` call.
 */
function vectorMode(o: AskCommandOptions): boolean | 'auto' | undefined {
  if (o.vec === false) return false;
  switch (o.vectors) {
    case 'on':
      return true;
    case 'auto':
      return 'auto';
    case 'off':
      return false;
    default:
      return undefined;
  }
}
