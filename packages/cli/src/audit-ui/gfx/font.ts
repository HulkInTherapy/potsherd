/**
 * A 5-pixel-tall block font drawn with half-blocks (3 cell rows per line of text at scale 1).
 * Used for hero numbers and the archetype title. Each glyph is a list of pixel rows.
 */
import { Canvas } from './canvas.js';
import { type Rgb } from './color.js';

const G: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['##.', '.#.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '$': ['.', '.', '.', '.', '.'],
  ',': ['.', '.', '.', '#', '#'],
  '.': ['.', '.', '.', '.', '#'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '×': ['...', '#.#', '.#.', '#.#', '...'],
  '#': ['.#.#.', '#####', '.#.#.', '#####', '.#.#.'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '-': ['...', '...', '###', '...', '...'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  ':': ['.', '#', '.', '#', '.'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['###', '..#', '.##', '...', '.#.'],
  "'": ['#', '#', '.', '.', '.'],
  '’': ['#', '#', '.', '.', '.'],
  '“': ['#.#', '#.#', '...', '...', '...'],
  '”': ['#.#', '#.#', '...', '...', '...'],
  '"': ['#.#', '#.#', '...', '...', '...'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
  '…': ['.....', '.....', '.....', '.....', '#.#.#'],
  ' ': ['..', '..', '..', '..', '..'],
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '#.#', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
};

const glyph = (ch: string) => G[ch] ?? G[ch.toUpperCase()] ?? null;

/** Width in cells of `text` at `scale`, including 1-pixel gaps between glyphs. */
export function bigWidth(text: string, scale = 1): number {
  let w = 0;
  let first = true;
  for (const ch of text) {
    const g = glyph(ch);
    if (!g) continue;
    w += (first ? 0 : 1) + g[0]!.length;
    first = false;
  }
  return w * scale;
}

/** Height in cells at `scale` (5 pixels → 3 rows at scale 1, 5 rows at scale 2). */
export const bigHeight = (scale = 1) => Math.ceil((5 * scale) / 2);

export function bigSupported(text: string): boolean {
  return [...text].every(ch => glyph(ch) !== null);
}

export interface BigOptions {
  scale?: number;
  /** Colour per pixel: (pixelX, pixelY, glyphIndex) → colour, or -1 to skip. */
  color: (px: number, py: number, index: number) => Rgb;
  /** Only draw the first n glyphs (typewriter / assemble effects). */
  limit?: number;
  /** Per-glyph vertical offset in pixels (drop-in effects). */
  dy?: (index: number) => number;
}

/** Draw `text` with its top-left at cell (x, y). Returns the width in cells. */
export function drawBig(canvas: Canvas, x: number, y: number, text: string, options: BigOptions): number {
  const scale = Math.max(1, Math.round(options.scale ?? 1));
  let cx = 0;
  let index = 0;
  let first = true;
  for (const ch of text) {
    const g = glyph(ch);
    if (!g) continue;
    if (!first) cx += 1;
    first = false;
    if (ch === '$') {
      // Superscript dollar sign: price-tag typography reads better than a 3×5 squiggle.
      if (options.limit === undefined || index < options.limit) {
        const color = options.color(cx * scale, 0, index);
        if (color >= 0) canvas.text(x + cx * scale, y, '$', { fg: color, bold: true });
      }
      cx += 1;
      index++;
      continue;
    }
    if (options.limit !== undefined && index >= options.limit) { cx += g[0]!.length; index++; continue; }
    const dy = Math.round(options.dy?.(index) ?? 0);
    g.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== '#') continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const px = (cx + rx) * scale + sx;
          const py = ry * scale + sy;
          const color = options.color(px, py, index);
          if (color < 0) continue;
          canvas.px(x + px, y * 2 + py + dy, color);
        }
      }
    });
    cx += g[0]!.length;
    index++;
  }
  return cx * scale;
}
