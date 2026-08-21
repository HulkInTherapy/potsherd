import fs from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';

import {
  ASK_CONCURRENCY,
  ASK_K,
  ASK_MAX_USD,
  NoBackendError,
  VERSION,
  ask,
  detectBackend,
  format as f,
  redactOutgoing,
  renderAsk,
  type AskDrop,
  type AskOptions,
  type AskReaderFn,
  type AskReaderInput,
  type AskReaderOutput,
  type AskResult,
} from '@potsherd/core';
import {
  Progress,
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
  /** T5.6: record the reader inputs to this path and stop. No model call. */
  readersOut?: string;
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

  // A verb that is about to spend money says so before it spends it, and says
  // what would fix it when it cannot. `card --dry-run` is allowed to work with
  // no backend because it makes no call; `ask` always makes one —
  // **except under `--readers-out`**, which cannot make one (see
  // {@link recorder}). Demanding a backend for a run that structurally makes no
  // call would be this file telling the user something untrue about it, and it
  // would put a `claude` binary between a skill and the one path that does not
  // need a model at all.
  if (!readersOut) {
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
  const progress = new Progress('reading', !o.json && !o.quiet && Boolean(process.stderr.isTTY));

  try {
    const filters = parseFilters(db, o);
    const k = positive(o.k, ASK_K, '--k');
    // One options object for every path below, so the shortlist a
    // `--readers-out` run records, the shortlist a `--readers-in` run checks
    // against, and the shortlist a normal run reads are the same shortlist
    // built from the same inputs. Anything that diverges here is a stale-file
    // bug that no amount of validation downstream can see.
    const base: AskOptions = {
      filters,
      root,
      k,
      strict: Boolean(o.strict),
      maxUsd: money(o.maxUsd),
      concurrency: positive(o.concurrency, ASK_CONCURRENCY, '--concurrency'),
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

    const result = await ask(db, question, {
      ...base,
      onProgress: (p) => {
        if (p.step !== 'read') return;
        // Cost and time, live, on stderr — so `ask --json > f` still shows it
        // and the json stays parseable. `est.` is inherited from the result,
        // never guessed here.
        progress.update(
          p.done,
          p.total,
          `${f.money(p.spend.usd)}${p.spend.estimatedInputCalls > 0 ? ' est.' : ''}`,
        );
      },
    });
    progress.done();

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
    progress.done();
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
//
// This commit is `--readers-out` — the recording half. `--readers-in` reads
// the same envelope back and is the next commit; the `outputs` field below is
// declared here because the format is one format, defined by the flag that
// writes it.

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
      targets: file.targets.length,
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
  const targets = rec.seen.map((input) => ({ ...input, excerpts: redactOutgoing(input.excerpts).text }));
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
    lines.push(
      `    ${target.id8}  ${target.project}${target.isGhost ? t.dim('  ghost') : ''}` +
        `${target.isSidechain ? t.dim('  subagent') : ''}  ${t.dim(`seq ${target.seqs.join(', ')}`)}`,
    );
  }
  lines.push('');
  // The claim this flag exists to make, stated where the user can check it.
  lines.push(`  ${t.dim(`no model call was made (${probe.spend.calls}). the excerpts are redacted, as sent.`)}`);
  lines.push('');
  lines.push('  run your readers and add an "outputs" array to the file.');
  return lines.join('\n');
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
