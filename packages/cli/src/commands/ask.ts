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
  /** T5.6: replay reader outputs from this path instead of running readers. */
  readersIn?: string;
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
  if (readersOut && readersIn) {
    throw new UserError(
      '--readers-out and --readers-in are the two halves of one round trip, not two flags for one run',
      'potsherd ask "…" --readers-out r.json   # then run your readers, then --readers-in r.json',
    );
  }

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

    const result = readersIn
      ? await replayReaders(db, question, base, readersIn)
      : await ask(db, question, {
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
  return ask(db, question, { ...base, readerFn });
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
