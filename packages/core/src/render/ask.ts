import { INDENT } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { MASK_RE } from '../redact.js';
import { ELISION_RE } from '../redact-elide.js';
import { OPEN_THREAD_LABEL, type OpenThread } from '../open-threads.js';
import { projectName } from '../recall.js';
import { ANSWER_MAX_WORDS, STRICT_MIN_EVIDENCE, type AskEvidence, type AskResult } from '../ask.js';

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

export interface AskRenderOptions {
  /** Shown under the counts when the caller has one. */
  next?: string;
}

export function renderAsk(
  r: AskResult,
  t: Theme = new Theme(),
  now = new Date(),
  opts: AskRenderOptions = {},
): string {
  const lines: string[] = [];
  const width = t.width - INDENT.length;

  lines.push(t.dim(headline(r, t)));
  lines.push('');

  if (r.refused) {
    lines.push(...refusal(r, t));
    lines.push(...footer(r, t, opts));
    return lines.join('\n');
  }

  if (r.sentences.length === 0) {
    lines.push(...nothing(r, t));
    lines.push(...footer(r, t, opts));
    return lines.join('\n');
  }

  // ---- ANSWER
  lines.push('ANSWER');
  for (const line of f.wrap(answerText(r, t), width)) lines.push(INDENT + line);
  lines.push('');

  // ---- EVIDENCE
  lines.push('EVIDENCE');
  for (const e of r.evidence) lines.push(...evidenceLine(e, t, now));
  lines.push('');

  // ---- OPEN THREADS
  if (r.openThreads.length > 0) {
    lines.push('OPEN THREADS');
    for (const o of r.openThreads) lines.push(...threadLines(o, t, now));
    lines.push('');
  }

  lines.push(...footer(r, t, opts));
  return lines.join('\n');
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
function answerText(r: AskResult, t: Theme): string {
  return r.sentences
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
function threadLines(o: OpenThread, t: Theme, now: Date): string[] {
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
  if (o.note.trim()) {
    for (const line of f.wrap(o.note.trim(), width - 4)) out.push(INDENT + '    ' + t.dim(line));
  }
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
  out.push(
    INDENT +
      t.dim(
        r.dropped.length > 0
          ? `every sentence was dropped for want of a citation that resolves (${f.num(r.dropped.length)}).`
          : 'the readers found nothing that answers the question.',
      ),
  );
  out.push('');
  return out;
}

function footer(r: AskResult, t: Theme, opts: AskRenderOptions): string[] {
  const out: string[] = [];
  out.push(counts(r, t));

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
  if (r.trimmed.length > 0) {
    out.push(
      INDENT +
        t.dim(
          `${f.num(r.trimmed.length)} ${f.plural(r.trimmed.length, 'sentence')} trimmed ${t.sep} answer held to ${f.num(ANSWER_MAX_WORDS)} words`,
        ),
    );
  }
  const failed = r.readers.filter((x) => x.error).length;
  if (failed > 0) {
    out.push(
      INDENT + t.dim(`${f.num(failed)} ${f.plural(failed, 'reader')} did not answer ${t.sep} not counted as searched`),
    );
  }
  // phase-4 risks, verbatim.
  if (r.matching > r.searched) {
    out.push(
      INDENT +
        t.dim(
          `searched ${f.num(r.searched)} of ${f.num(r.matching)} matching sessions; raise --k to widen`,
        ),
    );
  }

  // `05`: every verb ends with the next verb.
  const next = opts.next ?? (r.evidence[0] ? `potsherd graft ${r.evidence[0].id8}` : null);
  if (next) {
    out.push('');
    out.push(INDENT + t.dim('next') + '  ' + next);
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
