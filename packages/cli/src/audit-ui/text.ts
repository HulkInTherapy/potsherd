/** Terminal text primitives: sanitising, cell widths, clipping and padding. */

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

const WIDE = /[\p{Emoji_Presentation}\p{Regional_Indicator}⃣ᄀ-ᅟ〈〉⺀-꓏가-힣豈-﫿︐-︙︰-﹯！-｠￠-￦]/u;
const MARK_ONLY = /^\p{Mark}+$/u;

/** Remove terminal control sequences and control characters from untrusted text. */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), part => part.segment);
}

function graphemeWidth(grapheme: string): number {
  if (WIDE.test(grapheme) || grapheme.includes('\ufe0f')) return 2;
  if (MARK_ONLY.test(grapheme)) return 0;
  return 1;
}

/** Display width in terminal cells (after sanitising). */
export function cellWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemes(sanitize(text))) width += graphemeWidth(grapheme);
  return width;
}

/** Clip to at most `width` cells without splitting a grapheme. */
export function clip(text: string, width: number): string {
  let result = '';
  let used = 0;
  for (const grapheme of graphemes(sanitize(text))) {
    const size = graphemeWidth(grapheme);
    if (used + size > Math.max(0, width)) break;
    result += grapheme;
    used += size;
  }
  return result;
}

/** Clip with a trailing ellipsis when the text does not fit. */
export function ellipsize(text: string, width: number, ascii = false): string {
  const clean = sanitize(text);
  if (cellWidth(clean) <= width) return clean;
  const mark = ascii ? '...' : '…';
  if (width <= cellWidth(mark)) return clip(clean, width);
  return clip(clean, width - cellWidth(mark)).trimEnd() + mark;
}

export function padEnd(text: string, width: number): string {
  const value = clip(text, width);
  return value + ' '.repeat(Math.max(0, width - cellWidth(value)));
}

export function padStart(text: string, width: number): string {
  const value = clip(text, width);
  return ' '.repeat(Math.max(0, width - cellWidth(value))) + value;
}

/** Word-wrap to `width` cells; long words are hard-split. */
export function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of sanitize(paragraph).split(' ')) {
      if (!word) continue;
      const candidate = line ? `${line} ${word}` : word;
      if (cellWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) rows.push(line);
      let rest = word;
      while (cellWidth(rest) > width) {
        const head = clip(rest, width);
        if (!head) break;
        rows.push(head);
        rest = rest.slice(head.length);
      }
      line = rest;
    }
    rows.push(line);
  }
  return rows;
}

const ASCII_MAP: Record<string, string> = {
  '━': '=', '─': '-', '░': '.', '▁': '_', '▂': '_', '▃': '-', '▄': '-', '▅': '=', '▆': '=', '▇': '#', '█': '#',
  '▀': '"', '▌': '|', '▐': '|', '★': '*', '·': '|', '“': '"', '”': '"', '…': '...', '—': '-', '–': '-', '×': 'x',
  '←': '<', '→': '>', '⠋': '-', '⠙': '\\', '⠹': '|', '⠸': '/', '⠼': '-', '⠴': '\\', '⠦': '|', '⠧': '/', '⠇': '-', '⠏': '\\',
};

/** Replace box/block glyphs for terminals that cannot draw them. */
export function toAscii(text: string): string {
  let out = '';
  for (const char of text) out += ASCII_MAP[char] ?? (char.charCodeAt(0) < 128 ? char : '?');
  return out;
}
