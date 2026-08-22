import { INDENT } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { MASK_RE } from '../redact.js';
import { ELISION_RE } from '../redact-elide.js';
import { OPEN_THREAD_LABEL, type OpenThread } from '../open-threads.js';
import { projectName } from '../recall.js';
import {
  ANSWER_MAX_WORDS,
  STRICT_MIN_EVIDENCE,
  type AskEvidence,
  type AskReaderReport,
  type AskResult,
} from '../ask.js';

/**
 * `potsherd ask` — moment 4 of `plans/05`: ANSWER / EVIDENCE / OPEN THREADS,
 * with a session id and a timestamp on every claim.
 *
 * The design constraint is that the whole thing is screenshottable at 80x24
 * with no caption, so the block is built to a budget rather than printed as it
 * comes: the answer wraps at the terminal width, evidence quotes truncate at
 * {@link QUOTE_CHARS}, and the counts that would be noise on a clean run
 * (dropped sentences, the k cap) appear only when they are non-zero.
 *
 * Three things here are load-bearing rather than decorative.
 *
 * **The citation markers are the accent.** `05` allows one accent colour for
 * the single most important thing on the screen. For `ask` that is not a
 * number, it is `[1]` — the mark that says this sentence survived the filter
 * in `ask.ts`. The `possible open thread` label takes the warn colour, because
 * it is the one advisory line in an otherwise evidenced block and it must read
 * as a suggestion. Nothing else is coloured.
 *
 * **A truncated quote never cuts a redaction mask in half.** See
 * {@link clipQuote}.
 *
 * **A refusal is not a shorter answer.** Under `--strict` with fewer than two
 * surviving evidence lines the block prints the refusal line the plan
 * specifies and no prose at all — the point of `--strict` is that a
 * plausible-sounding paragraph is the failure being prevented, so there is no
 * path here that renders `result.answer` when `result.refused` is set.
 */

/** `05`: "evidence quotes truncate at ~90 chars with `…`". */
export const QUOTE_CHARS = 90;

// -------------------------------------------------------- reader progress

/**
 * One reader, as it returns: `reader 3/6 · 9c4d2f18 · found · 12.1s`.
 *
 * The id here is the demo corpus's, not the one the phase file's example
 * used: that one is a real session on the reference machine, and this file
 * is vendored into both plugin bundles. `scripts/check-privacy.py`'s
 * id-inventory rule caught it in the same phase that introduced it.
 *
 * 8.7. `ask` is 44 to 180 seconds of one spinner, and a spinner is a claim
 * that something is happening rather than evidence that it is. The defect is
 * not the wall time — one agent-SDK call is 60 to 160 seconds and `03` §12
 * records that as structural — it is that the wait carries no information. Six
 * lines arriving over two minutes, each naming a session and saying whether it
 * had anything, turn the wait into the fan-out actually being watched.
 *
 * Four rules the shape obeys, and each one is a way it could have gone wrong:
 *
 *   - **It fits.** 42 columns of grid, plus a running-cost column that is
 *     dropped rather than clipped when the terminal cannot hold it, so the
 *     line survives 80, 60, and a phone screenshot of a terminal. Nothing
 *     here elides, because nothing here is long enough to need to.
 *   - **It is a line, not a redraw.** No `\r`, no cursor movement, no
 *     dependence on `isTTY`: piped, redirected or captured by CI it is the
 *     same six lines in arrival order. A progress *bar* has to be erased and
 *     an erase that does not happen is corruption; this cannot corrupt
 *     anything because it never goes back.
 *   - **The verdict is a word, not a colour.** `found` / `nothing` / `failed`
 *     read identically with `NO_COLOR`, on a monochrome terminal and in a
 *     screenshot. The colour is redundant with the word, which is the only
 *     safe way to use one.
 *   - **`failed` is its own word.** A reader that never answered and a reader
 *     that read the session and found nothing are different facts about the
 *     archive, and `render/ask.ts`'s {@link nothing} already carries the scar
 *     from conflating them once.
 *
 * The caller decides *where* this goes. It must never be stdout — see
 * `packages/cli/src/commands/ask.ts` — but that is a stream question, not a
 * rendering one, and this function does not know about streams.
 */
export function readerLine(
  r: AskReaderReport,
  done: number,
  total: number,
  t: Theme = new Theme(),
  spend?: { usd: number; estimated: boolean },
): string {
  // Four columns on one monospace grid (`05`): counter, session, verdict,
  // elapsed. Padded rather than joined, because six of these arrive one under
  // another over two or three minutes and a ragged column is the difference
  // between a table and a log. The widths are the widest each field can be:
  // `nothing` is 7, an id8 is 8, and a sidechain is 11: `idTag` returns the
  // suffix alone for an id like `<uuid>:agent-01`, which is `01` — correct in
  // `ls` and `find`, where the parent row is directly above it, and useless
  // here, where the line arrives on its own. `01` is not something a reader
  // can pass to `show`. So a sidechain names its parent and marks itself.
  const verdict = (r.error ? 'failed' : r.found ? 'found' : 'nothing').padEnd(7);
  const counter = `${String(done).padStart(String(total).length)}/${total}`;
  const sep = ` ${t.sep} `;
  // The plain line is built first and measured first. `f.clip` counts
  // characters, and an ANSI escape is characters — clipping the coloured
  // string would cut a 39-column line at 39 *bytes of escape codes* and leave
  // a dangling reset. So width is decided on the text, and colour is applied
  // only to a line that was going to fit anyway.
  // A sidechain reader prints `<parent>↳<tag>`; a top-level one is its own
  // id8. Padded to the sidechain width so the grid holds either way.
  const colon = r.sessionId.lastIndexOf(':');
  const id = (colon === -1 ? r.id8 : `${r.sessionId.slice(0, 8)}${t.g('\u21b3', '>')}${r.id8}`).padEnd(11);
  const took = f.duration(r.ms).padStart(6);
  // `03` §8 asks `ask` for a "cost cap and live cost display", and the bar
  // this replaced carried the running spend in its note. It is a fifth column
  // rather than a fifth line, and it is **dropped rather than clipped** when
  // the terminal is too narrow for it: the four columns above are the receipt
  // and the total is on the footer either way, so a 60-column terminal loses
  // the running figure instead of losing the end of the grid.
  const cost = spend ? `${f.money(spend.usd)}${spend.estimated ? ' est.' : ''}` : '';
  const head = `reader ${counter}${sep}${id}${sep}${verdict}${sep}${took}`;
  const room = t.width - INDENT.length;
  const withCost = cost && head.length + sep.length + cost.length <= room;
  const plain = withCost ? `${head}${sep}${cost}` : head;
  if (plain.length > room) return t.asciiLine(INDENT + f.clip(plain, room, t));
  const paint = r.error ? t.warn : r.found ? t.ok : t.dim;
  const coloured =
    t.dim(`reader ${counter}`) +
    t.dim(sep) +
    id +
    t.dim(sep) +
    paint.call(t, verdict) +
    t.dim(sep) +
    t.dim(took) +
    (withCost ? t.dim(sep) + t.dim(cost) : '');
  return t.asciiLine(INDENT + coloured);
}

/**
 * 8.7: the one line `--cheap` owes the user, on every screen, every time.
 *
 * `--cheap` reads three sessions instead of six and hands a reader a card in
 * place of most of a transcript. Both are real reductions in what was looked
 * at, so both can turn an answer into a miss — and a miss on this verb does
 * not look like a miss. It looks like an archive that had nothing, which is a
 * false statement about the user's own history, printed by the one verb whose
 * entire purpose is not making those.
 *
 * So the disclosure is not in `--help`, where it would be read once by people
 * who did not need it. It is in the footer of every `--cheap` render including
 * the refusals, it leads with the consequence rather than the mechanism, and
 * the consequence is the half that survives a clip to 60 columns.
 */
/**
 * The line every `--cheap` screen carries, refusals included.
 *
 * It states the trade in the order the user cares about and does not flatter
 * it. Measured over ten runs each of the same five questions on the reference
 * corpus: `--cheap` p50 **50.5 s** against the default's **45.0 s**, and
 * $0.065 a run against $0.139 — so it is 2.1x cheaper and, on this corpus,
 * fractionally SLOWER. It also answered 7 of 10 where the default answered 10.
 *
 * The flag was called `--fast` when it was written, which is why the numbers
 * are in this comment: the unit of latency here is a model call, not a token,
 * because each reader is a separate agent-SDK `query()` that spawns its own
 * process. Cutting a reader's prompt by 31% moved wall time not at all, and
 * fewer readers run in the same wall time as more readers do. Nothing that
 * only shrinks prompts can make this verb faster, so the flag says what it
 * actually does.
 */
export function cheapNote(r: AskResult, t: Theme): string {
  const read = `${f.num(r.searched || r.matching)} ${f.plural(r.searched || r.matching, 'session')}`;
  // Built in three lengths and CHOSEN by width, never clipped. The clause
  // that has to survive a narrow terminal is the one that warns, and clipping
  // cuts from the right — which is exactly where `and it can miss` sits in
  // the sentence that reads best. Two earlier wordings lost it: one at 80
  // columns, one at 60. So the cost clause is dropped first and the warning
  // is the last thing standing, the same way `readerLine` drops its running
  // cost rather than shortening the grid.
  const room = t.width - INDENT.length;
  const warn = `${read}, and it can miss`;
  const full = `--cheap ${t.sep} about half the cost, not faster ${t.sep} ${warn}`;
  const mid = `--cheap ${t.sep} ${warn}`;
  const bare = `--cheap ${t.sep} it can miss`;
  const line = full.length <= room ? full : mid.length <= room ? mid : bare;
  return INDENT + t.dim(f.clip(line, room, t));
}

/**
 * The height the whole block is built to fit, in rows.
 *
 * `05` asks for output "compact enough to screenshot whole" and specifies 80x24
 * for every screen in `docs/screens/`. `ask` was the one verb that did not
 * obey: real runs measured **25-33 rows**, because {@link ANSWER_MAX_WORDS} is
 * a word cap fitted against a *short* EVIDENCE block and no open threads, and
 * nothing downstream of it knew how many rows those two would take. A 150-word
 * answer is 11 wrapped lines at 80 columns; add eight evidence lines and one
 * open thread and the block is a third taller than the screen it was designed
 * for.
 *
 * So the answer is now held to a **row** budget rather than only a word one:
 * the evidence and the open threads are measured first, and the answer gets
 * what is left. See {@link fit} for the order things give way in, and why the
 * answer and the evidence are the last two things to be touched.
 */
export const ASK_ROWS = 24;

/**
 * The answer is never squeezed below this many wrapped lines.
 *
 * A budget that can drive the answer to one line has replaced "too long to
 * screenshot" with "too short to be an answer", and `05`'s honesty contract
 * already has a real path for having nothing to say (`--strict`). Below this
 * the block simply runs past 24 rows, and the footer says so.
 */
export const ASK_MIN_ANSWER_LINES = 3;

export interface AskRenderOptions {
  /** Shown under the counts when the caller has one. */
  next?: string;
  /**
   * Rows to fit the block into. Defaults to {@link ASK_ROWS}; `0` disables
   * fitting entirely, which is what the JSON path and the tests that assert on
   * an untrimmed block use.
   */
  rows?: number;
}

/** What {@link fit} decided to leave out, so the footer can say so. */
interface Budget {
  sentences: AskResult['sentences'];
  evidence: AskEvidence[];
  threads: OpenThread[];
  /** Sentences the *renderer* removed, on top of `r.trimmed` from `ask.ts`. */
  trimmedHere: number;
  /** Open threads not printed. */
  threadsHeld: number;
  /** False once the advisory notes have been dropped to make room. */
  notes: boolean;
  /** True when the block still does not fit and nothing more may be cut. */
  over: boolean;
}

export function renderAsk(
  r: AskResult,
  t: Theme = new Theme(),
  now = new Date(),
  opts: AskRenderOptions = {},
): string {
  const lines: string[] = [];
  const width = t.width - INDENT.length;

  if (r.refused) {
    lines.push(t.dim(headline(r, t)));
    lines.push('');
    lines.push(...refusal(r, t));
    lines.push(...footer(r, t, opts, null));
    return lines.join('\n');
  }

  if (r.sentences.length === 0) {
    lines.push(t.dim(headline(r, t)));
    lines.push('');
    lines.push(...nothing(r, t));
    lines.push(...footer(r, t, opts, null));
    return lines.join('\n');
  }

  const b = fit(r, t, now, opts);

  lines.push(t.dim(headline(r, t)));
  lines.push('');

  // ---- ANSWER
  lines.push('ANSWER');
  for (const line of f.wrap(answerText(b.sentences, t), width)) lines.push(INDENT + line);
  lines.push('');

  // ---- EVIDENCE
  lines.push('EVIDENCE');
  for (const e of b.evidence) lines.push(...evidenceLine(e, t, now));
  lines.push('');

  // ---- OPEN THREADS
  if (b.threads.length > 0) {
    lines.push('OPEN THREADS');
    for (const o of b.threads) lines.push(...threadLines(o, t, now, b.notes));
    lines.push('');
  }

  lines.push(...footer(r, t, opts, b));
  return lines.join('\n');
}

/**
 * Decide what fits in {@link ASK_ROWS}, and in what order things give way.
 *
 * The order is the whole design, so it is stated here rather than distributed
 * through the code:
 *
 *   1. **An open thread's note goes first.** It is the model's advisory prose
 *      about a claim the block already states, cites and dates on the three
 *      lines above it — the only text here that is neither the answer nor
 *      evidence for it. It is clipped to one line ({@link threadLines}).
 *   2. **Then open threads after the first**, counted in the footer. Phase 4
 *      measured that only 1-2 of 8 candidates are worth raising, so the second
 *      and third are the cheapest four rows on the screen. The *first* is not
 *      touched here: `05` calls that line "the moment people quote", and it is
 *      the one thing on this screen the user did not ask for and cannot get
 *      any other way.
 *   3. **Then trailing sentences of the answer**, by the same rule and for the
 *      same reasons as {@link trimToWordBudget}: whole sentences, from the
 *      tail, never the first one, never below {@link ASK_MIN_ANSWER_LINES}.
 *   4. **Then the last open thread**, once the answer is at its floor. Losing
 *      a finding is better than printing an answer too short to be one.
 *   5. **Evidence is never cut to save rows.** It is cut only when the trim in
 *      (3) leaves an entry that nothing cites any more — at which point
 *      printing it would be worse than dropping it, because a reader would look
 *      for the `[n]` that refers to it and not find one.
 *
 * The answer's own citations therefore always resolve on screen, which is the
 * product's central claim and the one thing a row budget is not allowed to buy
 * rows with. When even (4) is not enough the block runs long and the footer
 * says which rules bound it; nothing is ever cut silently.
 */
function fit(r: AskResult, t: Theme, now: Date, opts: AskRenderOptions): Budget {
  const rows = opts.rows ?? ASK_ROWS;
  const width = t.width - INDENT.length;

  let sentences = [...r.sentences];
  let threads = [...r.openThreads];
  let trimmedHere = 0;
  let notes = true;

  const evidenceFor = (kept: typeof sentences): AskEvidence[] => {
    const cited = new Set(kept.flatMap((s) => s.cites));
    return r.evidence.filter((e) => cited.has(e.index));
  };

  const height = (
    kept: typeof sentences,
    ev: AskEvidence[],
    th: OpenThread[],
    held: number,
    cut: number,
    withNotes: boolean,
  ): number => {
    let n = 2; // headline + blank
    n += 1 + f.wrap(answerText(kept, t), width).length + 1; // ANSWER + body + blank
    n += 1 + ev.reduce((a, e) => a + evidenceLine(e, t, now).length, 0) + 1;
    if (th.length > 0) n += 1 + th.reduce((a, o) => a + threadLines(o, t, now, withNotes).length, 0) + 1;
    n += footer(r, t, opts, {
      sentences: kept,
      evidence: ev,
      threads: th,
      trimmedHere: cut,
      threadsHeld: held,
      notes: withNotes,
      over: false,
    }).length;
    return n;
  };

  const budget = (): Budget => ({
    sentences,
    evidence: evidenceFor(sentences),
    threads,
    trimmedHere,
    threadsHeld: r.openThreads.length - threads.length,
    notes,
    over: false,
  });

  if (rows <= 0) return budget();

  const tooTall = (): boolean => {
    const b = budget();
    return height(b.sentences, b.evidence, b.threads, b.threadsHeld, b.trimmedHere, b.notes) > rows;
  };

  // (1b) the advisory notes, whole.
  if (tooTall()) notes = false;

  // (2) open threads after the first.
  while (tooTall() && threads.length > 1) threads = threads.slice(0, -1);

  // (3) trailing sentences, never the first, never below the line floor.
  while (tooTall() && sentences.length > 1) {
    const candidate = sentences.slice(0, -1);
    if (f.wrap(answerText(candidate, t), width).length < ASK_MIN_ANSWER_LINES) break;
    sentences = candidate;
    trimmedHere += 1;
  }

  // (4) the last open thread, only now.
  while (tooTall() && threads.length > 0) threads = threads.slice(0, -1);

  const b = budget();
  b.over = height(b.sentences, b.evidence, b.threads, b.threadsHeld, b.trimmedHere, b.notes) > rows;
  return b;
}

function headline(r: AskResult, t: Theme): string {
  const parts = [`potsherd ask ${JSON.stringify(r.question)}`];
  return f.clip(parts.join(` ${t.sep} `), t.width, t);
}

/** The second line: what was read, how long it took, what it cost. */
function counts(r: AskResult, t: Theme): string {
  const answered = r.readers.filter((x) => x.found).length;
  const parts = [
    `${f.num(r.searched)} of ${f.num(r.matching)} ${f.plural(r.matching, 'session')} read`,
    `${f.num(answered)} answered`,
    f.duration(r.ms),
  ];
  // `05` honesty contract: an estimate is labelled. `llm.ts` discards a
  // backend token count below a tenth of its own chars/3.6 figure, and on the
  // agent-sdk path that is every call — so most real runs print `est.` here,
  // and a run that does not is one where the backend counted honestly.
  if (r.spend.calls > 0) {
    parts.push(`${f.money(r.spend.usd)}${r.estimated ? ' est.' : ''}`);
  }
  return f.clip(INDENT + parts.join(` ${t.sep} `), t.width, t);
}

/**
 * The kept sentences, with their citation markers.
 *
 * Built from `r.sentences` and never from `r.answer`, so the accent colour is
 * applied to the markers rather than to a substring search over prose that
 * might contain `[1]` for its own reasons. `r.answer` is the same words; this
 * is the same words with the marks picked out.
 */
function answerText(sentences: AskResult['sentences'], t: Theme): string {
  return sentences
    .map((s) => `${s.text} ${s.cites.map((c) => t.accent(`[${c}]`)).join('')}`)
    .join(' ');
}

/**
 * `[1] project/id8   21 aug 14:02  "quote…"`
 *
 * Two lines when the quote will not fit beside the label at this width, which
 * at 60 columns is most of them. Never wrapped into a third: the design system
 * says a table does not wrap, and this is a table.
 */
function evidenceLine(e: AskEvidence, t: Theme, now: Date): string[] {
  const label = `[${e.index}]`;
  const where = `${e.project}/${e.id8}`;
  const when = e.ts ? f.shortDateTime(e.ts, now) : t.dash;
  const marks: string[] = [];
  if (e.isGhost) marks.push('ghost');
  if (e.isSidechain) marks.push('subagent');
  const head = `${label} ${where}  ${when}${marks.length ? `  ${marks.join(' ')}` : ''}`;

  // INDENT(2) + head + two spaces + the two quote marks = 6 columns of frame.
  const room = t.width - Theme.len(head) - 6;
  const quote = clipQuote(e.quote, Math.min(QUOTE_CHARS, room), t);
  if (room >= 32) {
    return [INDENT + head + '  ' + t.dim(`"${quote}"`)];
  }
  const wide = clipQuote(e.quote, Math.min(QUOTE_CHARS, t.width - INDENT.length - 6), t);
  return [INDENT + head, INDENT + '    ' + t.dim(`"${wide}"`)];
}

/**
 * `05`: open threads are advisory and are rendered with
 * {@link OPEN_THREAD_LABEL}, never stated as fact. The label carries the warn
 * colour so that the one unevidenced line in the block reads as the suggestion
 * it is, and the decision itself still carries its session and its date.
 */
function threadLines(o: OpenThread, t: Theme, now: Date, notes = true): string[] {
  const width = t.width - INDENT.length;
  // Both halves of the claim are load-bearing — "decided in A, **not seen in
  // B**" — so B must never be the half that falls off the end. Rendering the
  // raw absolute project paths overflowed 80 columns and tail-truncated B away
  // entirely, while the EVIDENCE lines three rows below used the short project
  // name for the very same projects. Same function, same output, and the line
  // now fits.
  const head =
    `${t.warn(OPEN_THREAD_LABEL)} ${t.sep} ` +
    `decided in ${projectName(o.project)}, not seen in ${projectName(o.otherProject)}`;
  const out = [INDENT + f.clip(head, t.width, t)];
  for (const line of f.wrap(o.what, width - 4)) out.push(INDENT + '    ' + line);
  // "Cited or dropped" has to survive the render, not just the rule pass. The
  // rule pass drops any decision whose evidence_seq does not resolve — and then
  // this line used to show no seq at all, so the one claim potsherd makes about
  // an *absence* was the one claim a reader could not go and check.
  const seqs = o.evidenceSeqs.length ? `@${o.evidenceSeqs.join(',')}` : '';
  const src = `${projectName(o.project)}/${o.id8}${seqs}  ${o.ts ? f.shortDateTime(o.ts, now) : t.dash}`;
  out.push(INDENT + '    ' + t.dim(f.clip(src, width - 4, t)));
  // The note is the model's advisory prose about a claim the three lines above
  // already state, cite and date -- the only text in this block that is neither
  // the answer nor evidence for it. It is the first thing to give way when the
  // block will not fit 24 rows (see `fit`), so it is held to one line here
  // rather than wrapped to three. `--json` carries it whole.
  const note = o.note.trim();
  if (notes && note) out.push(INDENT + '    ' + t.dim(f.clip(note, width - 4, t)));
  return out;
}

/**
 * phase-4 T4.1 §4, verbatim: the sentence `--strict` prints instead of a guess,
 * and — one line below it — **why**.
 *
 * The second line is not decoration. A run that stopped at `--max-usd` and a
 * run whose citations did not survive leave `AskResult` in the same state, and
 * the first version of this function guessed between them: it told a user
 * whose run had aborted at ten cents that fewer than two quotes had survived
 * the citation check. That is a false statement about their archive, printed
 * by the verb whose entire purpose is not making those. {@link AskResult.refusal}
 * exists so the line is read rather than inferred.
 */
function refusal(r: AskResult, t: Theme): string[] {
  const out = [
    INDENT +
      f.clip(
        `no grounded answer in ${f.num(r.searched)} ${f.plural(r.searched, 'session')} searched`,
        t.width - 2,
        t,
      ),
    '',
  ];
  const answered = r.readers.filter((x) => x.found).length;
  out.push(INDENT + t.dim(f.clip(why(r, answered, t), t.width - 2, t)));
  if (r.refusal === 'budget') {
    out.push(
      INDENT +
        t.dim(f.clip('raise --max-usd to let the synthesizer run, or lower --k', t.width - 2, t)),
    );
  }
  out.push('');
  return out;
}

function why(r: AskResult, answered: number, t: Theme): string {
  switch (r.refusal) {
    case 'budget':
      return (
        `stopped at the cost ceiling ${t.sep} the readers alone spent ` +
        `${f.money(r.spend.usd)}${r.estimated ? ' est.' : ''} and the synthesizer never ran.`
      );
    case 'no-match':
      return 'nothing in the index matches the question.';
    case 'no-answer':
      return 'no session read addressed the question.';
    case 'strict':
      return answered === 0
        ? 'no session read addressed the question.'
        : `${f.num(answered)} ${f.plural(answered, 'session')} answered, and fewer than ` +
          `${STRICT_MIN_EVIDENCE} quotes survived the citation check.`;
    default:
      return 'nothing survived the citation check.';
  }
}

/** Not strict, and everything the model wrote was dropped. */
function nothing(r: AskResult, t: Theme): string[] {
  const out: string[] = [];
  if (r.searched === 0) {
    out.push(INDENT + f.clip(`nothing in the index matches ${JSON.stringify(r.question)}.`, t.width - 2, t));
    out.push('');
    out.push(INDENT + t.dim('run') + '  potsherd find  ' + t.dim('to check the shortlist, or  potsherd index'));
    out.push('');
    return out;
  }
  out.push(
    INDENT +
      f.clip(
        `no grounded answer in ${f.num(r.searched)} ${f.plural(r.searched, 'session')} searched`,
        t.width - 2,
        t,
      ),
  );
  out.push('');
  // "Did not answer" and "read it and found nothing" are different facts, and
  // this line conflated them. A run where **every** reader errored — a dead
  // backend, a harness that is not logged in, a timeout — printed *"the readers
  // found nothing that answers the question"*, which is a statement about the
  // user's archive made by a verb that never read it. Found by recording the
  // demo cast under a relocated HOME, where `claude` is on PATH and not logged
  // in: six readers failed in 3.2 s and the screen said the archive had nothing.
  const failed = r.readers.filter((x) => x.error);
  const allFailed = r.readers.length > 0 && failed.length === r.readers.length;
  out.push(
    INDENT +
      t.dim(
        allFailed
          ? `no reader could run, so nothing was read: ${f.clip(failed[0]?.error ?? 'the backend did not answer', t.width - 30, t)}`
          : r.dropped.length > 0
            ? `every sentence was dropped for want of a citation that resolves (${f.num(r.dropped.length)}).`
            : 'the readers found nothing that answers the question.',
      ),
  );
  out.push('');
  return out;
}

function footer(
  r: AskResult,
  t: Theme,
  opts: AskRenderOptions,
  b: Budget | null,
): string[] {
  const out: string[] = [];
  out.push(counts(r, t));

  // Directly under the counts, so the number of sessions read and the reason
  // it is that number are one glance apart. Before the drop/trim notes,
  // because it qualifies every line below it as well as the counts above it.
  if (r.cheap) out.push(cheapNote(r, t));

  // Dropped sentences are printed as a count and never as text: `dropped`
  // exists so a person can audit the filter, and reprinting the prose it
  // removed on the same screen would hand back exactly what was taken away.
  if (r.dropped.length > 0 && r.sentences.length > 0) {
    out.push(
      INDENT +
        t.dim(
          `${f.num(r.dropped.length)} ${f.plural(r.dropped.length, 'sentence')} dropped ${t.sep} no citation that resolves`,
        ),
    );
  }
  // Trimmed sentences are counted, like dropped ones, and labelled with the
  // rule that took them rather than lumped in with the citation drops above.
  // The two are different events and a reader has to be able to tell them
  // apart: a dropped sentence could not be stood behind, a trimmed one could
  // and did not fit. Saying so is also the only thing that keeps the cap
  // honest — an answer that quietly stops is an answer pretending it finished.
  const trimmed = r.trimmed.length + (b?.trimmedHere ?? 0);
  if (trimmed > 0) {
    // Which rule bound matters: a word cap and a screen height are different
    // facts about the answer, and a reader deciding whether to re-run with
    // `--json` needs to know which one it hit.
    const rule = b && b.trimmedHere > 0
      ? `answer held to the ${f.num(opts.rows ?? ASK_ROWS)}-row screen`
      : `answer held to ${f.num(ANSWER_MAX_WORDS)} words`;
    out.push(
      INDENT + t.dim(`${f.num(trimmed)} ${f.plural(trimmed, 'sentence')} trimmed ${t.sep} ${rule}`),
    );
  }
  if (b && b.threadsHeld > 0) {
    out.push(
      INDENT +
        t.dim(
          `${f.num(b.threadsHeld)} more open ${f.plural(b.threadsHeld, 'thread')} ${t.sep} --json for all`,
        ),
    );
  }
  const failed = r.readers.filter((x) => x.error).length;
  if (failed > 0) {
    out.push(
      INDENT + t.dim(`${f.num(failed)} ${f.plural(failed, 'reader')} did not answer ${t.sep} not counted as searched`),
    );
  }
  // phase-4 risks. The k cap is disclosed, but not by restating the counts
  // line: that read `6 of 65 sessions read` and then, two lines below,
  // `searched 6 of 65 matching sessions` -- the same two numbers, the same
  // fact, twice, on a screen built to a row budget. The number a reader does
  // not already have is how many matches went unread, so that is the one
  // printed, and the actionable half of the old line survives with it.
  if (r.matching > r.searched) {
    const unread = r.matching - r.searched;
    out.push(
      INDENT +
        t.dim(
          `${f.num(unread)} matching ${f.plural(unread, 'session')} not read ${t.sep} raise --k to widen`,
        ),
    );
  }

  // `05`: every verb ends with the next verb -- and in the shape the other
  // twelve screens in `docs/screens/` use, which is `run  <command>  <gloss>`
  // on the line directly under the counts. `ask` was the only verb that said
  // `next` instead of `run` and the only one that put a blank line above it,
  // so it read as a different kind of thing on a page beside the others. It is
  // also the one verb whose block was too tall to screenshot, and the blank
  // was a row.
  const next = opts.next ?? (r.evidence[0] ? `potsherd graft ${r.evidence[0].id8}` : null);
  if (next) {
    // The gloss is the first thing to go at a narrow width, not the command:
    // a reader at 60 columns still needs something they can type.
    const gloss = opts.next ? '' : '  to carry it into the agent you are in';
    const line = INDENT + 'run  ' + next + gloss;
    out.push(
      Theme.len(line) <= t.width
        ? INDENT + t.dim('run') + '  ' + next + t.dim(gloss)
        : INDENT + t.dim('run') + '  ' + f.clip(next, t.width - INDENT.length - 5, t),
    );
  }
  return out;
}

// ------------------------------------------------------- mask-safe clipping

/**
 * Truncate a quote to `max` columns **without ever cutting a mask in half**.
 *
 * Redaction happens at index time, so the text a quote is drawn from can
 * contain `‹redacted:aws:9f2b1c04›` (redact.ts) or `‹elided:image/png:109362
 * bytes›` (redact-elide.ts). Both are one atom: the first is the *only* thing
 * a reader has telling them a secret was there, and `‹redacted:aws:9f2b…` is
 * not a shorter version of that fact — it is a fragment that reads like
 * corrupt output and, worse, invites the reader to think the tool leaked half
 * of something. The phase-2 screenshot script is currently failing its own
 * assertion for exactly this reason on a `find` snippet.
 *
 * So the cut point is pulled **back to the start of the mask** it would have
 * landed inside, and the ellipsis goes there instead. A quote whose only
 * content is a mask therefore renders as `…` rather than as half a mask, which
 * is the correct outcome: there was nothing quotable there.
 *
 * The patterns are imported from the two modules that own them rather than
 * rewritten here, so a new mask shape is recognised by this function the day
 * it is added.
 */
export function clipQuote(s: string, max: number, t: Theme | string = new Theme()): string {
  const ellip = typeof t === 'string' ? t : t.ellip;
  const flat = s.replace(/\s+/g, ' ').trim();
  const limit = Math.max(1, Math.floor(max));
  if (flat.length <= limit) return flat;
  if (limit <= ellip.length) return ellip.slice(0, limit);

  const cut = maskSafeCut(flat, limit - ellip.length);
  return flat.slice(0, cut).trimEnd() + ellip;
}

/**
 * The largest index `<= want` that does not fall strictly inside a mask or an
 * elision marker. Exported so a test can assert the property directly rather
 * than by eye.
 */
export function maskSafeCut(s: string, want: number): number {
  if (want <= 0) return 0;
  for (const re of [MASK_RE, ELISION_RE]) {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(s)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (want > start && want < end) return start;
      if (start >= want) break;
    }
  }
  return want;
}
