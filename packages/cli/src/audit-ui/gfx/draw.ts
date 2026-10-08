/** Drawing helpers on top of Canvas: rich text, wrapping, boxes, bars and pixel lines. */
import { Canvas, textWidth, type Style } from './canvas.js';
import { C, fade, type Rgb } from './color.js';

export interface Span { text: string; style: Style }
export interface Rect { x: number; y: number; w: number; h: number }

const NUMBERISH = /^[(\[]?[~<>]?[$£€#×]?\d[\d,.]*(?:[%×xKMBkh]|st|nd|rd|th|am|pm)?[)\].,!:;?]*$|^×\d+[.,]?$/i;

/**
 * Headline styling: numbers and money pop in orange, quoted phrases in peach italics.
 * Words are split on spaces; quotes may span words.
 */
export function rich(text: string, base: Style, accent: Style = { fg: C.orange, bold: true }, quote: Style = { fg: C.peach, italic: true }): Span[] {
  const spans: Span[] = [];
  let inQuote = false;
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    if (/^\s+$/.test(word)) { spans.push({ text: word, style: inQuote ? quote : base }); continue; }
    const opens = word.includes('“');
    const closes = word.includes('”');
    if (opens) inQuote = true;
    const style = inQuote ? { ...base, ...quote } : NUMBERISH.test(word) ? { ...base, ...accent } : base;
    spans.push({ text: word, style });
    if (closes) inQuote = false;
  }
  return spans;
}

/** Word-wrap spans to `width` cells. Long words are hard-split. */
export function wrapSpans(spans: Span[], width: number): Span[][] {
  const lines: Span[][] = [[]];
  let used = 0;
  const pushWord = (span: Span) => {
    const w = textWidth(span.text);
    if (/^\s+$/.test(span.text)) {
      if (used === 0) return;
      if (used + w > width) { lines.push([]); used = 0; return; }
      lines.at(-1)!.push(span); used += w; return;
    }
    if (used + w > width && used > 0) {
      const line = lines.at(-1)!;
      while (line.length && /^\s+$/.test(line.at(-1)!.text)) line.pop();
      lines.push([]); used = 0;
    }
    if (w > width) {
      let rest = span.text;
      while (textWidth(rest) > width) {
        const head = [...rest].slice(0, width).join('');
        lines.at(-1)!.push({ text: head, style: span.style });
        lines.push([]); used = 0;
        rest = rest.slice(head.length);
      }
      lines.at(-1)!.push({ text: rest, style: span.style }); used += textWidth(rest);
      return;
    }
    lines.at(-1)!.push(span); used += w;
  };
  for (const span of spans) pushWord(span);
  const last = lines.at(-1)!;
  while (last.length && /^\s+$/.test(last.at(-1)!.text)) last.pop();
  return lines.filter((line, i) => line.length || i === 0);
}

export function spansWidth(line: Span[]): number {
  return line.reduce((sum, span) => sum + textWidth(span.text), 0);
}

/** Draw one line of spans; `chars` limits how many characters are drawn (typewriter). */
export function drawSpans(canvas: Canvas, x: number, y: number, line: Span[], alpha = 1, chars = Infinity): number {
  let cx = x;
  let left = chars;
  for (const span of line) {
    if (left <= 0) break;
    const text = [...span.text].slice(0, left).join('');
    left -= [...span.text].length;
    cx += canvas.text(cx, y, text, { ...span.style, alpha: (span.style.alpha ?? 1) * alpha });
  }
  return cx - x;
}

/** Wrap plain text and clip to `maxLines`, adding an ellipsis on the last line if cut. */
export function wrapText(text: string, width: number, maxLines = Infinity): string[] {
  const lines = wrapSpans(rich(text, {}), width).map(line => line.map(s => s.text).join(''));
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept.at(-1)!;
  while (textWidth(last + '…') > width && last.length) last = last.slice(0, -1);
  kept[kept.length - 1] = last.trimEnd() + '…';
  return kept;
}

/** Letter-spaced small-caps label: "THE BILL" → "T H E   B I L L". */
export function spaced(text: string): string {
  return text.toUpperCase().split(' ').map(word => [...word].join(' ')).join('   ');
}

export function box(canvas: Canvas, r: Rect, color: Rgb, options: { rounded?: boolean; dashed?: boolean; fill?: Rgb; ascii?: boolean } = {}): void {
  if (r.w < 2 || r.h < 2) return;
  const [tl, tr, bl, br, hz, vt] = options.ascii ? ['+', '+', '+', '+', '-', '|']
    : options.rounded === false ? ['┌', '┐', '└', '┘', options.dashed ? '┄' : '─', options.dashed ? '┆' : '│']
      : ['╭', '╮', '╰', '╯', options.dashed ? '┄' : '─', options.dashed ? '┆' : '│'];
  const bg = options.fill;
  if (bg !== undefined) for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) canvas.put(x, y, ' ', C.cream, bg);
  canvas.put(r.x, r.y, tl, color, bg);
  canvas.put(r.x + r.w - 1, r.y, tr, color, bg);
  canvas.put(r.x, r.y + r.h - 1, bl, color, bg);
  canvas.put(r.x + r.w - 1, r.y + r.h - 1, br, color, bg);
  for (let x = r.x + 1; x < r.x + r.w - 1; x++) { canvas.put(x, r.y, hz, color, bg); canvas.put(x, r.y + r.h - 1, hz, color, bg); }
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) { canvas.put(r.x, y, vt, color, bg); canvas.put(r.x + r.w - 1, y, vt, color, bg); }
}

const EIGHTHS_H = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const EIGHTHS_V = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇'];

/** Horizontal bar with 1/8-cell precision. */
export function hbar(canvas: Canvas, x: number, y: number, width: number, frac: number, color: Rgb, ascii = false): number {
  const total = Math.max(0, Math.min(1, frac)) * width;
  const eighths = Math.round(total * 8);
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  for (let i = 0; i < full; i++) canvas.put(x + i, y, ascii ? '=' : '█', color);
  if (rest > 0 && full < width) canvas.put(x + full, y, ascii ? '-' : EIGHTHS_H[rest]!, color);
  return total;
}

/** Vertical bar growing up from `bottom` (inclusive) with 1/8-cell precision. */
export function vbar(canvas: Canvas, x: number, bottom: number, height: number, frac: number, color: Rgb, width = 1, ascii = false): void {
  const total = Math.max(0, Math.min(1, frac)) * height;
  const eighths = Math.round(total * 8);
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  for (let i = 0; i < full; i++) for (let k = 0; k < width; k++) canvas.put(x + k, bottom - i, ascii ? '#' : '█', color);
  if (rest > 0 && full < height) for (let k = 0; k < width; k++) canvas.put(x + k, bottom - full, ascii ? '.' : EIGHTHS_V[rest]!, color);
}

/** Bresenham line in pixel space (x in cells, y in half-cells). */
export function pxLine(canvas: Canvas, x0: number, y0: number, x1: number, y1: number, color: Rgb): void {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    canvas.px(x0, y0, color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Right-align text ending at column `right` (exclusive). */
export function textRight(canvas: Canvas, right: number, y: number, text: string, style: Style): void {
  canvas.text(right - textWidth(text), y, text, style);
}

export function textCenter(canvas: Canvas, cx: number, y: number, text: string, style: Style): void {
  canvas.text(Math.round(cx - textWidth(text) / 2), y, text, style);
}

export { fade, textWidth };
