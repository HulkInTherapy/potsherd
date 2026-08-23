import { INDENT } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { idTag } from '../recall.js';
import {
  clipToWords,
  isMostlyBoilerplate,
  maskAt,
  maskSpans,
  offMask,
  type MaskSpan,
} from '../search/snippet.js';
import { explain, type Explain, type HitExplain, type SessionExplain } from '../search/explain.js';
import type { RecallHit, RecallResult, RecallSession } from '../recall.js';

/**
 * `potsherd find` — one block per session, exactly as `03` §7 specifies it:
 * title (or `<slug>-<id8>`), harness, project, date, status, sidechain marker,
 * the best matching snippet with the match highlighted, the score, and **the
 * resume command for that harness**.
 *
 * The resume command is the point of the whole verb. Every other search tool
 * ends at "here is a match"; this one ends at `claude --resume 9c4d2f18-…`,
 * which is the difference between finding a conversation and re-entering it.
 * Where a session cannot be resumed — archived, ghost, or a harness with no
 * command-line resume — the block says so and offers `potsherd show` instead,
 * because printing a command that would fail is worse than printing none.
 *
 * Ghost blocks carry the honesty line from plans/05: *the assistant side of
 * deleted sessions is not recoverable*. The tool states its limitation on the
 * screen where the limitation bites.
 */
export interface FindRenderOptions {
  /** `--explain`: the fusion arithmetic in place of the snippets. */
  explain?: boolean;
}

export function renderFind(
  result: RecallResult,
  t: Theme = new Theme(),
  now = new Date(),
  opts: FindRenderOptions = {},
): string {
  // An empty result has no arithmetic to show, so `--explain` falls through to
  // the normal "nothing matches" block — which already says what to do next.
  if (opts.explain && result.sessions.length > 0) return renderExplain(result, t);
  const lines: string[] = [];
  lines.push(t.dim(headline(result, t)));
  lines.push('');

  if (result.sessions.length === 0) {
    lines.push(
      INDENT +
        f.clip(
          result.belowFloor > 0
            ? `nothing in the index answers ${JSON.stringify(result.query)}.`
            : `nothing in the index matches ${JSON.stringify(result.query)}.`,
          t.width - 2,
          t,
        ),
    );
    lines.push('');
    // The honest empty, and the reason it is honest is on the screen. "Nothing
    // matches" and "six things matched and not one of them enough" are
    // different facts about the archive, and an agent that is told the first
    // when the second is true will widen a query that did not need widening.
    // The escape hatch is named here rather than in `--help`, because this is
    // the one screen where a human's "show me anything" is a reasonable thing
    // to want and an agent's is not.
    lines.push(...withheldNote(result, t));
    if (!result.vectors.available && result.vectors.reason) {
      lines.push(INDENT + t.dim(f.clip(`text search only ${t.dash} ${result.vectors.reason}`, t.width - 2, t)));
    }
    // An empty `--ghosts only` on a directory that was indexed but never
    // rescued reads as "you have no deleted sessions", which is the one thing
    // potsherd exists to disprove: `index` does not build ghosts, `rescue`
    // does. `index` says so on its own receipt (T1.7a); this is the other
    // screen the same person hits, so it says the same thing.
    if (result.ghostsOnly && result.indexedGhosts === 0) {
      lines.push(
        INDENT + t.dim('no ghosts indexed yet') + '  ' + t.dim(`${t.sep} run  potsherd rescue`),
      );
      lines.push(...ignoreNote(result, t));
      return lines.join('\n');
    }
    lines.push(...ignoreNote(result, t));
    lines.push(nextVerbOnEmpty(result, t));
    return lines.join('\n');
  }

  result.sessions.forEach((s, i) => {
    if (i > 0) lines.push('');
    lines.push(...block(s, result, t, now));
  });

  lines.push('');
  const notes = footer(result, t);
  if (notes) lines.push(INDENT + t.dim(notes));
  // Why there were no vectors is a fact about this machine, not about this
  // search, so it gets its own line rather than competing with the counts for
  // room on theirs. It used to be the third item in the same joinFit and it
  // never once fitted: every committed `find` screen ends `3 ghost hits · 1
  // from subagents · …`, an ellipsis standing in for the one note on the line
  // that tells the reader something they can act on.
  if (!result.vectors.used && result.vectors.reason) {
    for (const line of f.wrap(`text search only ${t.dash} ${result.vectors.reason}`, t.width - INDENT.length)) {
      lines.push(INDENT + t.dim(line));
    }
  }
  lines.push(...ignoreNote(result, t));
  lines.push(nextVerb(t));
  return lines.join('\n');
}

/**
 * What the floor withheld, and the one flag that overrides it.
 *
 * Printed only when something was actually withheld. `find` reports what it
 * did not show for the same reason {@link ignoreNote} reports what it did not
 * search: a ranking cannot say what it would have returned without being run
 * again, and "these rows scored below the floor" is the fact the reader needs
 * either way.
 */
function withheldNote(result: RecallResult, t: Theme): string[] {
  const n = result.belowFloor;
  if (n <= 0) return [];
  const what = `${f.num(n)} ${f.plural(n, 'session')} matched some of those words and none of them enough`;
  const flag = '--min-confidence none';
  const wide = `${what}  ${t.sep}  ${flag}`;
  const out: string[] = [];
  if (Theme.len(INDENT + wide) <= t.width) {
    out.push(INDENT + t.dim(wide));
  } else {
    // The flag gets its own line rather than being dropped. `ignoreNote` may
    // lose its `--all` at 60 columns because the *count* is the fact that
    // matters there; here the escape hatch is the fact that matters, and a
    // screen that withholds rows without saying how to see them is the same
    // silent degradation this task exists to remove.
    for (const line of f.wrap(what, t.width - INDENT.length)) out.push(INDENT + t.dim(line));
    out.push(INDENT + t.dim(`${flag}  shows them anyway`));
  }
  out.push('');
  return out;
}

/**
 * The last line of an empty screen, and the reason the archaeologist's
 * instructions became reachable.
 *
 * `agents/session-archaeologist.md` says *"if nothing comes back, widen once —
 * then once more… two widenings is the limit"*. Before the floor existed
 * nothing ever came back empty, so that path was dead code and `NOT FOUND`
 * could never be correctly emitted. Now that a search can honestly come back
 * with nothing, the screen has to say which of the two empties it is: a query
 * whose rows were all withheld is one to **narrow** to its distinctive words,
 * and a query that matched nothing at all is one where there may be nothing to
 * index yet.
 */
function nextVerbOnEmpty(result: RecallResult, t: Theme): string {
  if (result.belowFloor > 0) {
    const long = 'with two or three distinctive words, or  potsherd ls';
    const wide = INDENT + t.dim('run') + '  potsherd find  ' + t.dim(long);
    return Theme.len(wide) <= t.width
      ? wide
      : INDENT + t.dim('run') + '  potsherd find  ' + t.dim('with fewer words');
  }
  // Two variants, because "run potsherd ls to see what is indexed, or
  // potsherd index to add more" is 77 characters and the terminal may be 60.
  const long = 'to see what is indexed, or  potsherd index  to add more';
  const wide = INDENT + t.dim('run') + '  potsherd ls  ' + t.dim(long);
  return Theme.len(wide) <= t.width
    ? wide
    : INDENT + t.dim('run') + '  potsherd ls  ' + t.dim('or  potsherd index');
}

/**
 * "not searching 47 sessions in 2 ignored projects  ·  --all".
 *
 * `find` reports what it did not look at rather than what it dropped: a
 * ranking cannot say what it would have returned without being run a second
 * time, and "these projects were not searched" is the fact the reader needs
 * either way. It prints under an empty result as well as under a full one —
 * an empty `find` with an ignore list in force is exactly where the line earns
 * itself, because "nothing matches" would otherwise be false.
 *
 * Counts, never names: the projects are directories off the user's machine and
 * `find` is a screenshot surface. `doctor` and `--json` carry the names.
 */
function ignoreNote(result: RecallResult, t: Theme): string[] {
  const n = result.ignored.hidden;
  if (n <= 0) return [];
  const p = result.ignored.projects.length;
  const what = `not searching ${f.num(n)} ${f.plural(n, 'session')} in ${f.num(p)} ignored ${f.plural(p, 'project')}`;
  const wide = `${what}  ${t.sep}  --all`;
  const text = Theme.len(INDENT + wide) <= t.width ? wide : what;
  return f.wrap(text, t.width - INDENT.length).map((line) => INDENT + t.dim(line));
}

/**
 * `05`: "every verb ends with the next verb. audit -> rescue -> ls -> find ->
 * ask -> graft."
 *
 * `find` was the only verb on a full page of results that did not. Its footer
 * printed `run  potsherd show <id8>  to read one whole` **only when it had no
 * other note to make** -- so the moment a search turned up a ghost or a
 * subagent hit, which is the interesting case and the one worth screenshotting,
 * the line teaching the next verb was the thing that got dropped to make room.
 * `docs/screens/09-find.txt` and `13-find-redacted.txt` both end that way and
 * are the only two of the fifteen committed screens with no next verb on them.
 *
 * So it is its own line now, always printed, and it names both directions: the
 * one result you want to read, and the verb that answers the question instead
 * of listing places the answer might be.
 */
function nextVerb(t: Theme): string {
  const long = 'to read one, or  potsherd ask <words>';
  const wide = INDENT + t.dim('run') + '  potsherd show <id8>  ' + t.dim(long);
  return Theme.len(wide) <= t.width
    ? wide
    : INDENT + t.dim('run') + '  potsherd show <id8>  ' + t.dim('or  potsherd ask <words>');
}

/**
 * The one line an agent reads before deciding whether to read anything else.
 *
 * `no match` when the page is empty — including when it is empty *because* the
 * floor withheld everything — and otherwise the envelope confidence, in the
 * same three words `--json` uses. `05`: the header carries what the screen is,
 * and the last line carries what to do next.
 */
function headline(r: RecallResult, t: Theme): string {
  const fixed: string[] = [];
  if (r.sessions.length === 0) {
    fixed.push('no match');
  } else {
    fixed.push(`${f.num(r.sessions.length)} ${f.plural(r.sessions.length, 'session')}`);
    fixed.push(r.confidence);
  }
  fixed.push(r.vectors.used ? 'bm25 + vectors' : 'bm25');
  fixed.push(f.duration(r.ms));
  // The query is the only variable-length field on the line, so it is the one
  // that gives way — elided in the middle, per `05`. Clipping the whole line
  // instead took the duration off the end the moment a query ran long, which
  // is the wrong thing to lose: a reader can reconstruct the words they just
  // typed and cannot reconstruct how confident the answer is.
  const sep = ` ${t.sep} `;
  const rest = fixed.join(sep);
  const room = Math.max(12, t.width - Theme.len(rest) - sep.length);
  const verb = f.elide(`potsherd find ${JSON.stringify(r.query)}`, room, t);
  return f.clip([verb, rest].join(sep), t.width, t);
}

function block(s: RecallSession, r: RecallResult, t: Theme, now: Date): string[] {
  const lines: string[] = [];
  const width = t.width - INDENT.length;

  // line 1 — the name, and what kind of thing it is.
  const right = [s.harness, statusWord(s)].join(` ${t.sep} `);
  const titleRoom = Math.max(12, width - right.length - 2);
  const title = markerFor(s, t) + f.elide(s.displayTitle, titleRoom - markerLen(s), t);
  lines.push(
    INDENT +
      title +
      ' '.repeat(Math.max(1, width - Theme.len(title) - right.length)) +
      tone(right, s, t),
  );

  // line 2 — where and when, and the score.
  const meta: string[] = [s.projectName];
  const when = s.startedAt ?? s.endedAt;
  if (when) meta.push(f.shortDate(when, now));
  meta.push(
    s.kind === 'ghost'
      ? `${f.num(s.prompts)} prompts recovered`
      : `${f.num(s.exchanges)} ${f.plural(s.exchanges, 'exchange')}`,
  );
  if (s.gitBranch) meta.push(s.gitBranch);
  if (s.agentName) meta.push(s.agentName);
  // The confidence sits where the eye already goes for the score, and in front
  // of it, because the score is the thing F1 found to be uninformative: a true
  // topic and an absent one are 1.12x apart in this column. The word is not a
  // restatement of the number beside it — it is computed from evidence the
  // number no longer contains (`calibration.ts`), and `--json` carries the
  // identical word on the identical row.
  const score = `${s.confidence}  ${s.score.toFixed(4)}`;
  const metaLine = f.clip(meta.join(` ${t.sep} `), Math.max(10, width - score.length - 2), t);
  lines.push(
    INDENT +
      t.dim(metaLine) +
      ' '.repeat(Math.max(1, width - metaLine.length - score.length)) +
      t.dim(score),
  );

  // line 3+ — the snippets, with the match picked out. A `title` hit has no
  // body behind it and its text is the heading two lines up, so it is evidence
  // for the ranking but never a snippet: printing it would repeat the title
  // back at the reader in the space meant for what the session actually said.
  const quotable = s.hits.filter((h) => h.kind !== 'title' && h.snippet.text.trim().length > 0);
  const ordered = quotableOrder(quotable);
  // Evidence only. If *any* hit in this session can show a matched word, the
  // ones that cannot are not printed at all — a second line quoting a sentence
  // with none of the query in it was the third of the T1.7 review's
  // complaints, and one good line beats a good line plus a puzzling one.
  const evidence = ordered.filter((h) => h.snippet.match);
  for (const hit of withMember(evidence.length > 0 ? evidence : ordered, s)) {
    // Which member of the conversation said this. A block is a conversation,
    // so its two snippet lines can come from the parent *or* from a subagent
    // it spawned — and with nothing to mark the difference the reader is told
    // the parent said something only the subagent ever said. Sidechains are
    // the one thing no other tool surfaces; burying them under a parent's
    // heading with no attribution is the same as not surfacing them.
    const mark = memberMark(s, hit, t) + laneMark(hit, t);
    const rendered = snippetLine(hit, t, width - 2 - Theme.len(mark));
    if (rendered) lines.push(INDENT + '  ' + mark + rendered);
  }
  // F6 — the block says, in its own words, that nothing under it is a
  // transcript. The snippet above it is a model's paragraph about the session,
  // and it is highlighted and quoted exactly like a sentence somebody typed;
  // without this line a reader has no way to tell the two apart, which is the
  // whole of the finding. The word "routing" is on the line because it is also
  // the instruction: this is a thread to open, not a fact to repeat.
  if (s.lane === 'routing') {
    lines.push(INDENT + '  ' + t.dim(f.clip(CARD_ONLY_NOTE, width - 2, t)));
  }
  // Why is this block on the screen? A snippet with a highlighted word answers
  // that by itself. When no snippet carries one — the title matched, or the
  // vector half found a conversation that shares no words with the query — the
  // block has to say so in words, or the reader is left looking at a paragraph
  // with no visible connection to what they typed. That was the T1.7 review's
  // sharpest complaint and it is a one-line fix.
  if (s.hits.length > 0 && !quotable.some((h) => h.snippet.match) && s.lane !== 'routing') {
    lines.push(INDENT + '  ' + t.dim(f.clip(unmatchedReason(s, r), width - 2, t)));
  }

  // last line — the one command that puts them back inside it.
  lines.push(INDENT + '  ' + t.dim(action(s, t, width - 2)));
  return lines;
}

/**
 * Evidence first.
 *
 * The hits arrive in fused-score order, which is the right order for *ranking*
 * and the wrong one for *quoting*: the best-scoring exchange in a session can
 * easily be one whose prompt is a pasted image and whose snippet therefore
 * shows the reader nothing. So among the hits of one session, the ones that
 * can actually show a matched word come first, then the ones that are not
 * machine boilerplate, and score breaks the remaining ties. Nothing is
 * dropped — the order only decides which two get the two lines.
 */
function quotableOrder(hits: RecallHit[]): RecallHit[] {
  return hits
    .map((hit, i) => ({ hit, i }))
    .sort((a, b) => {
      const am = a.hit.snippet.match ? 0 : 1;
      const bm = b.hit.snippet.match ? 0 : 1;
      if (am !== bm) return am - bm;
      const ab = isMostlyBoilerplate(a.hit.snippet.text) ? 1 : 0;
      const bb = isMostlyBoilerplate(b.hit.snippet.text) ? 1 : 0;
      if (ab !== bb) return ab - bb;
      return a.i - b.i;
    })
    .map((x) => x.hit);
}

/**
 * Two snippet lines, and one of them belongs to the other member when there
 * is one.
 *
 * A block is a *conversation*, and the two lines went to whichever hits quoted
 * best — which for a parent with a hundred exchanges and a subagent with one
 * is the parent's, twice, on volume alone. So the distinct result, the line
 * only the subagent ever said, lost both lines to the session that merely
 * spawned it. If the conversation has a hit from a member other than the one
 * heading the block, that member gets the second line.
 */
function withMember(pool: readonly RecallHit[], s: RecallSession): RecallHit[] {
  const top = pool.slice(0, 2);
  if (top.some((h) => h.sessionId !== s.id)) return top;
  const other = pool.find((h) => h.sessionId !== s.id);
  if (!other) return top;
  return top.length < 2 ? [...top, other] : [top[0]!, other];
}

/**
 * Who earned this line, when it was not the session heading the block.
 *
 * `↳ subagent p4a` in front of a snippet the sidechain matched, `↑ parent
 * 4ae3102b` in front of one the spawning session matched under a subagent's
 * heading. Empty for the session named two lines up, which needs no label.
 * The word is spelled out rather than left to a glyph: the reader has to be
 * able to tell that the subagent, not its parent, is what matched.
 */
function memberMark(s: RecallSession, hit: RecallHit, t: Theme): string {
  if (hit.sessionId === s.id) return '';
  const who = hit.isSidechain
    ? `${t.g('↳', '>')} subagent ${idTag(hit.sessionId)}`
    : `${t.g('↑', '^')} parent ${idTag(hit.sessionId)}`;
  return t.dim(`${who} `);
}

/**
 * What a card-only block says about itself, in the human view.
 *
 * Exported because `tests/cards-lane.test.ts` asserts the screen carries it
 * and because a second spelling of this sentence somewhere else would be a
 * second thing to keep true. `--json` does not carry the sentence — it carries
 * `lane: "routing"` on the block and on the hit, so nothing has to parse
 * prose to filter on it.
 */
export const CARD_ONLY_NOTE =
  'card only — routing, not evidence: this is a summary of that session, not its transcript';

/**
 * `card` in front of a snippet cut from one.
 *
 * A card hit's snippet is the card's title and summary, and it is windowed,
 * highlighted and printed in exactly the space a transcript quote occupies. On
 * the audit's screen three of those sat above the real transcripts, quoting
 * sentences no human ever typed, with nothing on the line to say so — `find`
 * only admitted it when *nothing* in the block could show a match
 * ({@link unmatchedReason}), which is the case that does not arise when the
 * card matched well.
 */
function laneMark(hit: RecallHit, t: Theme): string {
  return hit.kind === 'card' ? t.dim('card ') : '';
}

/** One line saying why a block with no quotable match is in the results. */
function unmatchedReason(s: RecallSession, r: RecallResult): string {
  if (s.hits.some((h) => h.kind === 'card')) {
    // The honest note the audit quoted approvingly — kept, and no longer the
    // only thing standing between a summary and a citation. A `routing` block
    // prints {@link CARD_ONLY_NOTE} instead, which says the same thing and
    // also says what to do with it.
    return s.lane === 'routing'
      ? CARD_ONLY_NOTE
      : 'the session card matched; the transcript does not use those words';
  }
  if (s.hits.some((h) => h.kind === 'title')) {
    return 'the session title matched; the body does not use those words';
  }
  if (r.vectors.used) return 'no words in common — this one matched on meaning';
  if (r.relaxed) return 'matched some of those words, not all of them';
  return 'matched elsewhere in the session than the lines shown';
}

/**
 * The snippet, one line, with the matched span in the accent colour.
 *
 * The window is cut in `search/snippet.ts` (200 characters centred on the
 * match); this only has to fit it to the terminal without cutting the match
 * back out again — so it shifts the window rather than clipping it away.
 */
export function snippetLine(hit: RecallHit, t: Theme, width: number): string {
  const text = hit.snippet.text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const masks = maskSpans(text);
  // A mask is one atom, and the highlight can land *inside* one: `find
  // "redacted aws"` matches the word `redacted` in the middle of
  // `‹redacted:basic-auth:201b2d22›`, and every window this function builds is
  // then centred on eight characters of a thirty-character marker. Widening
  // the match to the whole marker is what makes the rest of the arithmetic
  // come out right — the window is sized around an atom instead of around a
  // fragment of one — and it is also the more honest highlight: what matched
  // is the mask, not a word inside it.
  const m = widenToMask(hit.snippet.match, masks);
  // The `…` the cutter marks its own edges with is left alone: `Theme.asciiLine`
  // folds it to a single `.` at the boundary, which is width-preserving, and
  // expanding it to `...` here would push the line past the column it was just
  // measured against.
  if (!m || m.end > text.length) return t.dim(clipToWords(text, width, t.ellip));

  let start = 0;
  let end = text.length;
  let lead = '';
  let trail = '';
  if (text.length > width) {
    // Keep the match visible: centre the visible window on it, and say with an
    // ellipsis that the sentence continues — a snippet that begins mid-word
    // with no mark reads as corrupted text rather than as an excerpt.
    // Two ellipses, at whatever width this terminal renders one: `…` is a
    // column, `...` is three, and reserving two for both overflows `--ascii`
    // by four at the moment it matters most.
    const room = width - 2 * t.ellip.length;
    const half = Math.max(0, Math.floor((room - (m.end - m.start)) / 2));
    start = Math.max(0, Math.min(m.start - half, text.length - room));
    end = Math.min(text.length, start + room);
    // …and an ellipsis is not enough on its own. `…wn) that book consultations`
    // still reads as a broken string, so both edges move to the nearest space
    // — inwards, never outwards, so the line can only get shorter than `room`.
    ({ start, end } = wordEdges(text, start, end, m, masks));
    // `start > 0` means this window already cut past whatever the snippet's
    // own leading ellipsis was, so one is owed here — testing
    // `text.startsWith('…')` instead (as the first version did) dropped the
    // mark exactly when it was most needed and left the line beginning
    // mid-sentence with nothing to say so.
    lead = start > 0 ? t.ellip : '';
    trail = end < text.length ? t.ellip : '';
  }
  const head = text.slice(start, Math.max(m.start, start));
  const hit_ = text.slice(Math.max(m.start, start), Math.max(Math.min(m.end, end), start));
  const tail = text.slice(Math.max(Math.min(m.end, end), start), end);
  return t.dim(lead + head) + t.accent(hit_) + t.dim(tail + trail);
}

/**
 * The match, widened to the whole mask when it fell inside one.
 *
 * `find "redacted aws"` highlights the literal word `redacted` — which, in a
 * redacted exchange, is eight characters in the middle of
 * `‹redacted:basic-auth:201b2d22›`. Every window below is then built around a
 * fragment, and {@link wordEdges} duly pulls the window's end back to exactly
 * `m.end`, which is the middle of the marker. That is how
 * `docs/screens/13-find-redacted.txt` came to publish
 * `postgres://ingest:‹redacted…` and fail the screenshot script's own
 * assertion that a mask is visible on it.
 */
function widenToMask(
  m: { start: number; end: number } | undefined,
  masks: readonly MaskSpan[],
): { start: number; end: number } | undefined {
  if (!m) return m;
  const span = maskAt(masks, m.start) ?? maskAt(masks, m.end);
  if (!span) return m;
  return { start: Math.min(m.start, span.start), end: Math.max(m.end, span.end) };
}

/**
 * Move a character-counted window in to the nearest word edges, without ever
 * pushing the highlighted match out of it — and without ever leaving an edge
 * inside a redaction mask.
 *
 * The mask pass runs *after* the word pass rather than instead of it, because
 * a word edge inside a marker is a legal word edge:
 * `‹redacted:basic-auth:201b2d22›` is four words to `wordSpans`, and the
 * search below will happily stop at any of their boundaries.
 */
function wordEdges(
  text: string,
  start: number,
  end: number,
  m: { start: number; end: number },
  masks: readonly MaskSpan[] = [],
): { start: number; end: number } {
  let s = start;
  let e = end;
  if (s > 0 && !/\s/.test(text[s - 1] ?? ' ')) {
    let at = s;
    while (at < m.start && !/\s/.test(text[at - 1] ?? ' ')) at++;
    if (at <= m.start) s = at;
  }
  if (e < text.length && !/\s/.test(text[e] ?? ' ')) {
    let at = e;
    while (at > m.end && !/\s/.test(text[at] ?? ' ')) at--;
    if (at >= m.end) e = at;
  }
  while (s < e && /\s/.test(text[s] ?? '')) s++;
  while (e > s && /\s/.test(text[e - 1] ?? '')) e--;
  // `keep` is the match: an edge that has to move off a mask moves the way
  // that keeps the reason this line is on the screen inside the window.
  s = offMask(masks, s, 'forward', m);
  e = offMask(masks, e, 'back', m);
  return { start: s, end: Math.max(e, s) };
}

function action(s: RecallSession, t: Theme, width: number): string {
  if (s.resume) return f.clip(`run  ${s.resume}`, width, t);
  const show = `potsherd show ${idTag(s.id)}`;
  if (s.status === 'ghost') {
    // plans/05, the honesty contract: say the limitation before anyone finds it.
    const long = `assistant side not recoverable ${t.sep} ${show}`;
    return long.length <= width ? long : show;
  }
  if (s.status === 'archived') {
    const long = `only potsherd has this transcript ${t.sep} ${show}`;
    return long.length <= width ? long : show;
  }
  return `run  ${show}`;
}

function statusWord(s: RecallSession): string {
  if (s.status === 'ghost') return 'ghost';
  if (s.isSidechain) return 'sidechain';
  return s.status;
}

function tone(right: string, s: RecallSession, t: Theme): string {
  return s.status === 'ghost' ? t.accent(right) : t.dim(right);
}

function markerFor(s: RecallSession, t: Theme): string {
  if (s.pinned) return `${t.star} `;
  if (s.isSidechain) return `${t.g('↳', '>')} `;
  return '';
}

function markerLen(s: RecallSession): number {
  return s.pinned || s.isSidechain ? 2 : 0;
}

function footer(r: RecallResult, t: Theme): string {
  const parts: string[] = [];
  const ghosts = r.sessions.filter((s) => s.status === 'ghost').length;
  // A conversation counts as a subagent result when a subagent earned a line
  // in it, whether or not the block is headed by the subagent — otherwise the
  // footer says "0 from subagents" on a page whose answer came from one.
  const sidechains = r.sessions.filter(
    (s) => s.isSidechain || s.hits.some((h) => h.isSidechain && h.sessionId !== s.id),
  ).length;
  // F6 — how much of this page is not evidence, counted rather than described.
  // It goes first, ahead of the ghost and subagent counts, because it is the
  // one number on the line that changes what the reader should do with the
  // rows above it.
  const routing = r.sessions.filter((s) => s.lane === 'routing').length;
  if (routing) parts.push(`${f.num(routing)} card-only ${t.dash} routing, not evidence`);
  if (ghosts) parts.push(`${f.num(ghosts)} ghost ${f.plural(ghosts, 'hit')}`);
  if (sidechains) parts.push(`${f.num(sidechains)} from subagents`);
  if (r.relaxed) parts.push('relaxed to any-word matching');
  if (parts.length === 0) return '';
  // joinFit, not clip: a footer that ends "(--v…" has lost a whole clause to
  // save two characters. Drop the last note instead of cutting one in half.
  return f.joinFit(parts, t.width - INDENT.length, ` ${t.sep} `, t);
}

// ------------------------------------------------------------------ explain

/**
 * `find --explain` — the ledger.
 *
 * Every number on this screen is a term in one sum, and the sums add up:
 *
 * ```
 *   1  0.0248  the pooler decision                        0a2fbf9b
 *      exchange 12                                          0.0164
 *        exchanges_fts   r1   bm25 -8.41   x1.00  0.0164   100%
 *      exchange 7                                           0.0084
 *        vec_exchanges   r2   cos 0.71     x0.50  0.0081    96%
 *      0.0248 = 0.0164 best + 0.0084 corroboration
 * ```
 *
 * Read it inwards. The **detail rows** are one per (hit, list): where that list
 * ranked the row, the score the list itself gave it (bm25, negative and lower
 * is better; or cosine similarity), the weight `recall` applies to that list,
 * and the product — `weight / (k + rank)` — which is what the list actually
 * contributed, with its share of the hit beside it. The **hit line** above them
 * carries their total. The **session line** carries `best + min(rest/2,
 * best/2)`, spelled out underneath, which is the number the page is sorted by.
 *
 * That is enough to answer "why is this one above that one" without leaving the
 * terminal, and the closing line answers it out loud for the top two.
 *
 * The raw column is dropped below 72 columns rather than the pattern being
 * broken: at 60 the reader still gets rank, weight, contribution and share,
 * which is the part the arithmetic needs.
 */
export function renderExplain(result: RecallResult, t: Theme = new Theme()): string {
  const e = explain(result);
  const width = t.width - INDENT.length;
  const lines: string[] = [];
  lines.push(t.dim(headline(result, t)));
  lines.push('');
  lines.push(INDENT + t.dim(f.joinFit(explainNotes(e, result), width, ` ${t.sep} `, t)));
  lines.push('');

  for (const s of e.sessions) {
    lines.push(...sessionLedger(s, t, width));
    lines.push('');
  }
  lines.push(...tail(e, t, width));
  return lines.join('\n');
}

function explainNotes(e: Explain, r: RecallResult): string[] {
  const ran = e.lists.filter((l) => l.candidates > 0).length;
  const notes = [
    `rrf 1/(k+rank), k=${e.k}`,
    `${f.num(ran)}/${f.num(e.lists.length)} lists matched`,
  ];
  // Both of these change how a number on the screen should be read, so they
  // come before the decorative ones and are short enough to survive `--width 60`.
  if (r.relaxed) notes.push('lighter weight = that list relaxed');
  if (e.weights.some((w) => w.relaxed)) notes.push('~ = that list relaxed');
  return notes;
}

/** One session: its line, its hits, their detail rows, and the formula. */
function sessionLedger(s: SessionExplain, t: Theme, width: number): string[] {
  const lines: string[] = [];
  const place = `${s.place}`;
  const score = s.score.toFixed(4);
  const id = idTag(s.id);
  const room = Math.max(8, width - place.length - score.length - id.length - 6);
  const title = f.elide(s.title, room, t);
  const left = `${place}  ${t.accent(score)}  ${title}`;
  const pad = Math.max(1, width - Theme.len(left) - id.length);
  lines.push(INDENT + left + ' '.repeat(pad) + t.dim(id));

  for (const hit of s.hits) lines.push(...hitLedger(hit, t, width));

  const formula =
    `${score} = ${s.best.toFixed(4)} best` +
    (s.hits.length > 1
      ? ` + ${s.corroboration.toFixed(4)} corroboration${s.capped ? ' (capped)' : ''}`
      : '');
  lines.push(INDENT + '   ' + t.dim(f.clip(formula, width - 3, t)));
  return lines;
}

function hitLedger(hit: HitExplain, t: Theme, width: number): string[] {
  const lines: string[] = [];
  const score = hit.score.toFixed(4);
  const label = f.elide(hit.label, Math.max(8, width - 3 - score.length - 2), t);
  const pad = Math.max(1, width - 3 - Theme.len(label) - score.length);
  lines.push(INDENT + '   ' + label + ' '.repeat(pad) + t.dim(score));
  for (const l of hit.lists) lines.push(INDENT + '     ' + detailRow(l, t, width - 5));
  return lines;
}

/** `exchanges_fts     r1   bm25 -8.41   x1.00  0.0164  100%`, fitted. */
function detailRow(l: HitExplain['lists'][number], t: Theme, width: number): string {
  const times = t.g('×', 'x');
  const name = l.list.padEnd(LIST_COL);
  const rank = `r${l.rank}`.padEnd(4);
  const weight = `${times}${l.weight.toFixed(2)}${l.relaxed ? '~' : ''}`.padEnd(7);
  const contribution = l.contribution.toFixed(4);
  const share = `${Math.round(l.share * 100)}%`.padStart(4);
  const raw = rawColumn(l).padEnd(12);
  const wide = `${name} ${rank} ${raw} ${weight} ${contribution} ${share}`;
  const narrow = `${name} ${rank} ${weight} ${contribution} ${share}`;
  const line = Theme.len(wide) <= width ? wide : narrow;
  return t.dim(f.clip(line, width, t));
}

/** The widest list name (`ghost_prompts_fts`), so the columns line up. */
const LIST_COL = 17;

/**
 * What the list itself scored the row, in the list's own units — and the units
 * are the point. bm25 is negative and lower is better; cosine is [-1, 1] and
 * higher is better. Printing both in one column without saying which is which
 * would be the exact confusion RRF exists to avoid.
 */
function rawColumn(l: HitExplain['lists'][number]): string {
  if (l.list === 'vec_exchanges' || l.list === 'vec_cards' || l.list === 'vec_ghost_prompts')
    return `cos ${l.raw.toFixed(2)}`;
  if (l.list === 'titles') return 'title match';
  return `bm25 ${l.raw.toFixed(2)}`;
}

/** The closing lines: why the first result is first, and what it cost. */
function tail(e: Explain, t: Theme, width: number): string[] {
  const lines: string[] = [];
  if (e.margin && e.sessions.length >= 2) {
    const m = e.margin;
    const gap = `#1 leads #2 by ${m.by.toFixed(4)}`;
    // Naming the *reason* rather than the biggest number is the whole value of
    // this line: "its best hit is weaker" is a sentence no reader would arrive
    // at from a ranked list, and it is true surprisingly often.
    const because =
      m.reason === 'corroboration'
        ? `${f.num(m.firstHits)} hits against ${f.num(m.secondHits)}, not a better one`
        : m.list && m.firstRank !== null && m.secondRank !== null
          ? `${m.list} ranked them ${m.firstRank} and ${m.secondRank}`
          : m.list
            ? `${m.list} found #1 and not #2`
            : '';
    lines.push(INDENT + t.dim(f.joinFit([gap, because].filter(Boolean), width, ` ${t.sep} `, t)));
  }
  const slowest = [...e.lists].sort((a, b) => b.ms - a.ms)[0];
  if (slowest) {
    lines.push(
      INDENT +
        t.dim(
          f.joinFit(
            [`slowest list ${slowest.list} ${f.duration(slowest.ms)}`, 'the same numbers are in --json'],
            width,
            ` ${t.sep} `,
            t,
          ),
        ),
    );
  }
  return lines;
}
