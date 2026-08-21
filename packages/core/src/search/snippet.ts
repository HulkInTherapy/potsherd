/**
 * Result shaping.
 *
 * Adapted from obra/episodic-memory@1075769 `src/search.ts`
 * (MIT, (c) 2025 Jesse Vincent), whose snippet is "first 200 characters of the
 * user message, whitespace collapsed, ellipsis if truncated". That is kept as
 * {@link leadSnippet}. `03` §7 additionally wants "the best snippet with the
 * match highlighted", which upstream has no equivalent of.
 *
 * ## What T1.7b changed, and why
 *
 * The first version of {@link matchSnippet} centred a fixed 200-character
 * window on the **first** occurrence of the query and cut it at whatever
 * character fell 100 places away. On a real corpus that produced three
 * separate failures, all of them visible in one screenshot:
 *
 *   1. snippets that began mid-word — `"wn) that book consultations via …"` —
 *      which read as corrupted text rather than as an excerpt;
 *   2. snippets whose only content was machine boilerplate, e.g.
 *      `[Image: source: /var/folders/x7/…/T/clipboard-…]`, so the block never
 *      showed *why* the session was in the results at all;
 *   3. the *first* occurrence rather than the *best* one, so a query of five
 *      words was evidenced by the one place a single common word appeared.
 *
 * {@link denseSnippet} replaces all three: it scores every candidate window by
 * how many of the query's words fall inside it, rejects windows that are
 * mostly boilerplate while a better window exists in the same text, and snaps
 * both edges to word — preferably sentence — boundaries. The invariant the
 * renderer relies on is: **a snippet never starts or ends mid-word, and when
 * the text contains a query term the snippet contains one too, with offsets
 * saying where to highlight it.**
 */

export const SNIPPET_CHARS = 200;

/** How much text before the first match to keep, so a snippet reads as prose. */
const LEAD_CONTEXT = 32;

/** How far to look for a sentence edge before settling for a word edge. */
const SENTENCE_REACH = 48;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Upstream's snippet, verbatim in behaviour. */
export function leadSnippet(text: string, max = SNIPPET_CHARS): string {
  const collapsed = collapse(text.substring(0, max));
  return collapsed + (text.length > max ? '…' : '');
}

export interface MatchSnippet {
  text: string;
  /** Character offsets of the match within `text`, for the highlighter. */
  match?: { start: number; end: number };
}

// ------------------------------------------------------------------- words

export interface WordSpan {
  start: number;
  end: number;
  /** Lower-cased, for comparison against the query's tokens. */
  word: string;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

/** Every word in `text` with the offsets it occupies. */
export function wordSpans(text: string): WordSpan[] {
  const out: WordSpan[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, word: m[0].toLowerCase() });
    if (out.length > 20_000) break;
  }
  return out;
}

/**
 * Does this word in the text count as an occurrence of a query token?
 *
 * fts5's default tokenizer does not stem, so `find "icons"` and a transcript
 * that says `icon` are two different tokens to the *ranker*. To the reader
 * they are the same word, and a snippet that highlighted nothing because the
 * plural differed would look broken. A four-character prefix either way is the
 * cheapest rule that covers plurals and simple inflections without matching
 * `cat` to `catastrophe`.
 */
export function wordMatchesToken(word: string, token: string): boolean {
  if (word === token) return true;
  if (token.length >= 4 && word.startsWith(token)) return true;
  if (word.length >= 4 && token.startsWith(word)) return true;
  return false;
}

// -------------------------------------------------------------- boilerplate

/**
 * Spans a transcript contains that are not anybody's words.
 *
 * A pasted screenshot, a tool-result envelope, a bare absolute path, a
 * content hash: all of them are real text in `user_text`, all of them are
 * useless as evidence, and one of them was the *only* snippet a top-three
 * result showed in the T1.7 review. They are not deleted from the index —
 * they are legitimately searchable — they are only ranked last when choosing
 * what to quote.
 */
const BOILERPLATE: readonly RegExp[] = [
  /\[Image:[^\]]*\]?/giu,
  /\[Pasted text[^\]]*\]?/giu,
  /\[Request interrupted[^\]]*\]?/giu,
  /<\/?(?:system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|command-args|tool_use_error|user-prompt-submit-hook)>/giu,
  /Caveat: The messages below were generated[^\n]*/giu,
  /\bdata:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/giu,
  /(?:[A-Za-z]:)?(?:\/[\w.@+-]+){2,}\/?/gu,
  /\b[0-9a-f]{16,}\b/giu,
];

/** `text` with every boilerplate span blanked out. */
export function stripBoilerplate(text: string): string {
  let out = text;
  for (const re of BOILERPLATE) out = out.replace(re, ' ');
  return out;
}

/**
 * True when what is left after the machine text is removed is not a sentence.
 *
 * Four words is the threshold: `[Image: …/clipboard-1.png]` leaves nothing,
 * `ok` leaves one, and any span short enough to leave three is not worth a
 * line of a screenshot either.
 */
export function isMostlyBoilerplate(text: string): boolean {
  const rest = stripBoilerplate(text);
  const words = rest.match(/[\p{L}]{2,}/gu) ?? [];
  return words.length < 4;
}

// ----------------------------------------------------------------- windows

/** Snap `at` back to a word edge so no snippet ever starts in mid-word. */
function snapStart(spans: WordSpan[], at: number): number {
  if (at <= 0) return 0;
  for (const s of spans) {
    if (s.end <= at) continue;
    // `at` fell inside this word (or just before it): begin at the word.
    return s.start;
  }
  return at;
}

function snapEnd(text: string, spans: WordSpan[], at: number): number {
  if (at >= text.length) return text.length;
  let end = at;
  for (const s of spans) {
    if (s.start >= at) break;
    end = s.end <= at ? s.end : s.start;
  }
  if (end <= 0) return at;
  // Keep the punctuation the sentence ended on; a snippet stopping at "so" is
  // worse than one stopping at "so." by exactly one character.
  while (end < text.length && end < at + 2 && /[.,;:!?)\]}"']/.test(text[end]!)) end++;
  return end;
}

/** The nearest sentence edge at or before `at`, or -1 when there is none near. */
function sentenceStartNear(text: string, at: number, reach: number): number {
  const from = Math.max(0, at - reach);
  let best = -1;
  for (let i = from; i < at; i++) {
    if (/[.!?\n]/.test(text[i]!) && /\s/.test(text[i + 1] ?? ' ')) best = i + 1;
  }
  if (best === -1) return -1;
  while (best < at && /\s/.test(text[best]!)) best++;
  return best;
}

/**
 * Cut `text` at `max` characters without splitting the last word.
 *
 * `format.clip` cuts at the character, which is right for a path and wrong for
 * a sentence. This is the sentence version, and it is exported because the
 * `find` renderer has to re-cut a snippet a second time to fit the terminal.
 */
export function clipToWords(text: string, max: number, ellip = '…'): string {
  if (text.length <= max) return text;
  if (max <= ellip.length) return ellip.slice(0, max);
  const room = max - ellip.length;
  let cut = room;
  // Only snap back while a word edge is plausibly near; a 300-character token
  // (a url, a hash, `xxxx…`) has none, and losing it entirely is worse.
  const floor = Math.max(0, room - Math.ceil(room / 3));
  while (cut > floor && !/\s/.test(text[cut] ?? ' ')) cut--;
  // `cut === floor` is not the same as "no edge here": the search may have
  // stopped exactly on one. Ask the character, not the counter.
  if (!/\s/.test(text[cut] ?? '')) cut = room;
  return text.slice(0, cut).trimEnd() + ellip;
}

// ---------------------------------------------------------------- snippets

/**
 * A window centred on the first case-insensitive occurrence of `query`, with
 * the offsets the renderer needs to highlight it. Falls back to the head of
 * the text when the query does not literally appear (a vector-only hit).
 *
 * Kept for the single-phrase case and for callers outside `find`;
 * {@link denseSnippet} is what `recall` uses, and it handles multi-word
 * queries, boilerplate and word edges that this does not.
 */
export function matchSnippet(text: string, query: string, max = SNIPPET_CHARS): MatchSnippet {
  const needle = query.trim().toLowerCase();
  if (!needle) return { text: leadSnippet(text, max) };

  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return { text: leadSnippet(text, max) };

  const spans = wordSpans(text);
  const half = Math.max(0, Math.floor((max - needle.length) / 2));
  let rawStart = Math.max(0, at - half);
  rawStart = Math.min(rawStart, at);
  rawStart = snapStart(spans, rawStart);
  const rawEnd = snapEnd(text, spans, Math.min(text.length, rawStart + max));
  const slice = text.slice(rawStart, Math.max(rawEnd, at + needle.length));

  const lead = rawStart > 0 ? '…' : '';
  const tail = rawStart + slice.length < text.length ? '…' : '';
  const collapsed = collapse(slice);

  // Whitespace collapsing moves the match, so locate it again in the result.
  const found = collapsed.toLowerCase().indexOf(needle);
  const out = lead + collapsed + tail;
  return found === -1
    ? { text: out }
    : { text: out, match: { start: lead.length + found, end: lead.length + found + needle.length } };
}

interface Candidate {
  start: number;
  end: number;
  /** Query words inside the window. */
  density: number;
  /** Distinct query tokens inside the window. */
  distinct: number;
  boilerplate: boolean;
  /** The word to highlight. */
  pick: WordSpan;
}

/**
 * The best window of `text` for a multi-word query.
 *
 * "Best" is, in order: contains query words at all; is not machine
 * boilerplate; contains the most *distinct* query words; contains the most
 * occurrences; comes earliest. The highlighted word is the longest query token
 * present, because the rarest word is the one that explains the ranking — a
 * result that matched on `pgbouncer` should not point at `the`.
 */
export function denseSnippet(
  text: string,
  tokens: readonly string[],
  max = SNIPPET_CHARS,
): MatchSnippet {
  if (!text) return { text: '' };
  const wanted = [...new Set(tokens.map((t) => t.toLowerCase()).filter(Boolean))];
  const spans = wordSpans(text);
  if (wanted.length === 0 || spans.length === 0) return cleanLead(text, spans, max);

  const hits: { span: WordSpan; token: string }[] = [];
  for (const span of spans) {
    // Longest token first, so the highlight lands on the rarest word.
    let best: string | null = null;
    for (const token of wanted) {
      if (!wordMatchesToken(span.word, token)) continue;
      if (best === null || token.length > best.length) best = token;
    }
    if (best !== null) hits.push({ span, token: best });
  }
  if (hits.length === 0) return cleanLead(text, spans, max);

  // The whole text fits: quote all of it. A window is a compromise, and
  // opening a 54-character prompt with "…rows land in the ledger" when
  // "two rows land in the ledger" was available is the compromise made for no
  // reason at all.
  if (text.length <= max) {
    const pick = hits.reduce((a, b) => (b.token.length > a.token.length ? b : a));
    return cut(text, 0, text.length, pick.span);
  }

  const candidates: Candidate[] = [];
  // One candidate window per match is quadratic in the number of matches; a
  // 2,000-character exchange cannot hold more than a few dozen, and a pasted
  // log that does is not worth scanning past its first hundred.
  const considered = hits.slice(0, 120);
  for (let i = 0; i < considered.length; i++) {
    const first = considered[i]!;
    let start = snapStart(
      spans,
      Math.max(0, Math.min(first.span.start - LEAD_CONTEXT, text.length - max)),
    );
    if (start > first.span.start) start = first.span.start;
    const sentence = sentenceStartNear(text, first.span.start, SENTENCE_REACH);
    if (sentence >= 0 && sentence <= first.span.start && first.span.start - sentence <= max / 2) {
      start = sentence;
    }
    let end = snapEnd(text, spans, Math.min(text.length, start + max));
    if (end <= first.span.end) end = Math.min(text.length, first.span.end);
    const inside = hits.filter((h) => h.span.start >= start && h.span.end <= end);
    if (inside.length === 0) continue;
    const distinct = new Set(inside.map((h) => h.token)).size;
    // Highlight the longest matched token in the window, earliest occurrence.
    const pick = inside.reduce((a, b) =>
      b.token.length > a.token.length ? b : a,
    );
    candidates.push({
      start,
      end,
      density: inside.length,
      distinct,
      boilerplate: isMostlyBoilerplate(text.slice(start, end)),
      pick: pick.span,
    });
  }
  if (candidates.length === 0) return cleanLead(text, spans, max);

  const clean = candidates.filter((c) => !c.boilerplate);
  const pool = clean.length > 0 ? clean : candidates;
  pool.sort(
    (a, b) => b.distinct - a.distinct || b.density - a.density || a.start - b.start,
  );
  const chosen = pool[0]!;

  return cut(text, chosen.start, chosen.end, chosen.pick);
}

/** The head of the text, skipping a boilerplate opening when prose follows. */
function cleanLead(text: string, spans: WordSpan[], max: number): MatchSnippet {
  let start = 0;
  if (isMostlyBoilerplate(text.slice(0, max))) {
    // Walk forward a window at a time looking for something a person wrote.
    for (let at = max; at < text.length; at += max) {
      const from = snapStart(spans, at);
      if (!isMostlyBoilerplate(text.slice(from, from + max))) {
        start = from;
        break;
      }
    }
  }
  const end = snapEnd(text, spans, Math.min(text.length, start + max));
  const lead = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return { text: lead + collapse(text.slice(start, end)) + tail };
}

/** Slice, collapse, and re-locate the highlight inside the collapsed text. */
function cut(text: string, start: number, end: number, pick: WordSpan): MatchSnippet {
  const lead = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  const body = collapse(text.slice(start, end));
  const before = text
    .slice(start, pick.start)
    .replace(/\s+/g, ' ')
    .replace(/^\s+/, '');
  const at = before.length;
  const word = text.slice(pick.start, pick.end);
  if (body.slice(at, at + word.length).toLowerCase() !== word.toLowerCase()) {
    // Defensive: never report offsets that do not point at the word.
    const found = body.toLowerCase().indexOf(word.toLowerCase());
    if (found === -1) return { text: lead + body + tail };
    return {
      text: lead + body + tail,
      match: { start: lead.length + found, end: lead.length + found + word.length },
    };
  }
  return {
    text: lead + body + tail,
    match: { start: lead.length + at, end: lead.length + at + word.length },
  };
}
