/**
 * Result shaping.
 *
 * Adapted from obra/episodic-memory@1075769 `src/search.ts`
 * (MIT, (c) 2025 Jesse Vincent), whose snippet is "first 200 characters of the
 * user message, whitespace collapsed, ellipsis if truncated". That is kept as
 * {@link leadSnippet}. `03` §7 additionally wants "the best snippet with the
 * match highlighted", which upstream has no equivalent of, so
 * {@link matchSnippet} centres the window on the first match instead of taking
 * the head. T1.5 chooses between them.
 */

export const SNIPPET_CHARS = 200;

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

/**
 * A window centred on the first case-insensitive occurrence of `query`, with
 * the offsets the renderer needs to highlight it. Falls back to the head of
 * the text when the query does not literally appear (a vector-only hit).
 */
export function matchSnippet(text: string, query: string, max = SNIPPET_CHARS): MatchSnippet {
  const needle = query.trim().toLowerCase();
  if (!needle) return { text: leadSnippet(text, max) };

  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return { text: leadSnippet(text, max) };

  const half = Math.max(0, Math.floor((max - needle.length) / 2));
  const rawStart = Math.max(0, at - half);
  const rawEnd = Math.min(text.length, rawStart + max);
  const slice = text.slice(rawStart, rawEnd);

  const lead = rawStart > 0 ? '…' : '';
  const tail = rawEnd < text.length ? '…' : '';
  const collapsed = collapse(slice);

  // Whitespace collapsing moves the match, so locate it again in the result.
  const found = collapsed.toLowerCase().indexOf(needle);
  const out = lead + collapsed + tail;
  return found === -1
    ? { text: out }
    : { text: out, match: { start: lead.length + found, end: lead.length + found + needle.length } };
}
