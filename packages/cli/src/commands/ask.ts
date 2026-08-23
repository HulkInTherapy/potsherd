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
  type AskDrop,
  type AskOptions,
  type AskProgress,
  type AskReaderFn,
  type AskReaderInput,
  type AskReaderOutput,
  type AskResult,
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

  // The runs that **structurally cannot** call a model, and the exact reason
  // each one cannot, since this list is the whole of `A1` rung 1 from the
  // CLI's side:
  //
  //   --readers-out           the recorder answers every reader itself, so
  //                           `ask()` returns before the synthesizer exists.
  //   --readers-in + --out    the readers are recorded and the synthesizer is
  //                           a capture function; `ask()` opens neither.
  //   --filter-in             both halves are recorded; the only work left is
  //                           `filterAnswer`, which is arithmetic.
  //
  // A verb that is about to spend money says so before it spends it. Demanding
  // a backend for a run that cannot use one would be this file telling the
  // user something untrue about it — and it would put a `claude` binary
  // between a skill and the one path that needs no model at all.
  const modelless = Boolean(readersOut || filterIn || (synthesisOut && readersIn));
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
      ? await filterHostAnswer(db, question, base, filterIn)
      : readersIn
        ? await replayReaders(db, question, base, readersIn)
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
  /** Redacted exactly as `llm.ts` would redact it on the way to a model. */
  question: string;
  k: number;
  /** The shortlist, in shortlist order. The replay checks this set. */
  sessionIds: string[];
  /** `AskReaderInput` verbatim, one per shortlisted session (T4.4). */
  targets: AskReaderInput[];
  /** Added by whoever ran the readers. Absent in a fresh recording. */
  outputs?: RecordedOutput[];
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
    question: q,
    k: base.k ?? ASK_K,
    sessionIds: targets.map((x) => x.sessionId),
    targets: targets.map((x) => ({ ...x, question: q })),
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
  lines.push('');
  lines.push('  run your readers, add an "outputs" array to the file, then:');
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
): Promise<AskResult> {
  const staged = await stageReaders(db, question, base, path);
  // ---- pass two: the real run, with the recorded readers in place of the SDK.
  return ask(db, question, { ...base, readerFn: staged.readerFn });
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
): Promise<{ readerFn: AskReaderFn; outputs: RecordedOutput[]; live: string[]; abs: string }> {
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

  // ---- pass one: the live shortlist, at zero model calls.
  const rec = recorder();
  await ask(db, question, { ...base, concurrency: 1, openThreads: false, readerFn: rec.fn });
  const live = rec.seen.map((x) => x.sessionId);

  matchOrFail(abs, q, 'recorded shortlist', file.sessionIds, live);
  matchOrFail(abs, q, '"outputs"', outputs.map((x) => x.sessionId), live);

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
  return { readerFn, outputs, live, abs };
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
 * `readersPath` is the `--readers-in` file when there is one. With it, the run
 * costs zero model calls end to end. Without it the readers run on whatever
 * rung of the ladder this machine reached — which is a legitimate thing to
 * want (a bare terminal recording a prompt for a colleague's agent) and is why
 * it is allowed rather than refused. `probe.spend.calls` is the number the
 * receipt prints either way, so the difference is never hidden.
 */
export async function writeSynthesisFile(
  db: Parameters<typeof ask>[0],
  question: string,
  base: AskOptions,
  path: string,
  readersPath: string,
  onProgress?: (p: AskProgress) => void,
): Promise<{ file: SynthesisFile | null; abs: string; probe: AskResult }> {
  const staged = readersPath ? await stageReaders(db, question, base, readersPath) : null;
  const cap = synthCapture();
  const probe = await ask(db, question, {
    ...base,
    ...(staged ? { readerFn: staged.readerFn } : {}),
    ...(onProgress && !staged ? { onProgress } : {}),
    synthFn: cap.fn,
    openThreads: false,
  });

  const abs = nodePath.resolve(path);
  // No reader found anything, so there is nothing to synthesize and no file
  // worth writing. `ask()` reports that itself; writing an empty prompt here
  // would hand the host agent a question with no evidence under it, which is
  // the one shape that produces a confident answer from nothing.
  if (!cap.seen.input) return { file: null, abs, probe };

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
  };
  fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return { file, abs, probe };
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
  const { file, abs, probe } = await writeSynthesisFile(
    db,
    question,
    base,
    path,
    readersPath,
    onProgress,
  );

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
  lines.push(
    `  ${t.dim(`no model call was made (${probe.spend.calls}). the prompt is redacted, as sent.`)}`,
  );
  lines.push('');
  lines.push('  answer "prompt" in the shape of "schema", add it to the file as "reply", then:');
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
  if (file.reply === undefined || file.reply === null) {
    throw new UserError(
      `${abs} has no "reply" — it is a --synthesis-out recording that nobody has answered yet`,
      'answer its "prompt" in the shape of its "schema", then add the object as "reply"',
    );
  }

  // ---- pass one: the live shortlist, at zero model calls.
  const rec = recorder();
  await ask(db, question, { ...base, concurrency: 1, openThreads: false, readerFn: rec.fn });
  const live = rec.seen.map((x) => x.sessionId);
  matchOrFail(abs, q, 'recorded shortlist', file.sessionIds, live);

  // The readers are a *subset*: only sessions that found something reach the
  // synthesizer, and the rest legitimately contributed nothing. So this one is
  // checked the other way round — every recorded reader must still be
  // shortlisted, and a shortlisted session with no recorded reader is the
  // ordinary `found: false`.
  const known = new Set(live);
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
  return ask(db, question, {
    ...base,
    readerFn,
    synthFn: async () => file.reply,
    openThreads: false,
  });
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
    .map((id) => id.slice(0, 8))
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
    question,
    k,
    sessionIds: sessionIds as string[],
    targets,
    ...(outputs ? { outputs } : {}),
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
    throw new UserError(`${where} ("${sessionId.slice(0, 8)}") has no boolean "found"`, 'a reader that found nothing records "found": false — it is not omitted');
  }
  const rawQuotes = entry['quotes'];
  if (!Array.isArray(rawQuotes)) throw new UserError(`${where} ("${sessionId.slice(0, 8)}") has no "quotes" array`, '"quotes": [] when found is false');
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
    const where = d.sessionId ? `${d.sessionId.slice(0, 8)}@${d.seq}` : '';
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
