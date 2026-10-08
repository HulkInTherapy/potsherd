/**
 * A cell buffer: one character, foreground, background and attributes per terminal cell.
 * Half-block pixels (`px`) give two square pixels per cell with independent colours.
 *
 * Wide graphemes occupy two cells; the second cell holds '' and is skipped by the renderer.
 */
import { C, DEFAULT, fade, type Rgb } from './color.js';
import { sanitize } from '../text.js';

export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDERLINE = 8;

export interface Style {
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  /** 0..1 fade-in from the background. */
  alpha?: number;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const WIDE = /[\p{Emoji_Presentation}\p{Regional_Indicator}ᄀ-ᅟ〈〉⺀-꓏가-힣豈-﫿︐-︙︰-﹯！-｠￠-￦]/u;
const MARK_ONLY = /^\p{Mark}+$/u;

export function graphemeCells(grapheme: string): number {
  if (WIDE.test(grapheme) || grapheme.includes('️')) return 2;
  if (MARK_ONLY.test(grapheme)) return 0;
  return 1;
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), part => part.segment);
}

/** Pixel layer marker: no pixel drawn in this half. */
const NO_PX = -2;

export class Canvas {
  readonly ch: string[];
  readonly fg: Int32Array;
  readonly bg: Int32Array;
  readonly at: Uint8Array;
  private readonly top: Int32Array;
  private readonly bot: Int32Array;

  constructor(readonly w: number, readonly h: number, readonly base: Rgb = DEFAULT) {
    const n = Math.max(0, w * h);
    this.ch = new Array<string>(n).fill(' ');
    this.fg = new Int32Array(n).fill(DEFAULT);
    this.bg = new Int32Array(n).fill(base);
    this.at = new Uint8Array(n);
    this.top = new Int32Array(n).fill(NO_PX);
    this.bot = new Int32Array(n).fill(NO_PX);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  /** Put one single-width character. `bg` undefined keeps what is there. */
  put(x: number, y: number, ch: string, fg: Rgb, bg?: Rgb, attr = 0): void {
    x = Math.round(x); y = Math.round(y);
    if (!this.inside(x, y) || typeof ch !== 'string') return;
    const i = y * this.w + x;
    // Overwriting half of a wide glyph blanks the other half.
    if (this.ch[i] === '' && x > 0) this.ch[i - 1] = ' ';
    if (i + 1 < this.ch.length && x + 1 < this.w && this.ch[i + 1] === '' ) this.ch[i + 1] = ' ';
    this.ch[i] = ch;
    this.fg[i] = fg;
    if (bg !== undefined) this.bg[i] = bg;
    this.at[i] = attr;
    this.top[i] = NO_PX;
    this.bot[i] = NO_PX;
  }

  /** Write text; returns the number of cells used. Clips at `maxW` and at the canvas edge. */
  text(x: number, y: number, text: string, style: Style = {}, maxW = Infinity): number {
    x = Math.round(x); y = Math.round(y);
    if (y < 0 || y >= this.h) return 0;
    const alpha = style.alpha ?? 1;
    // Fully transparent text is not drawn at all (16-colour terminals would show it as black).
    if (alpha <= 0.02) return Math.min(maxW, textWidth(text));
    const fg = style.fg === undefined ? C.cream : fade(style.fg, alpha);
    const attr = (style.bold ? BOLD : 0) | (style.dim ? DIM : 0) | (style.italic ? ITALIC : 0) | (style.underline ? UNDERLINE : 0);
    let used = 0;
    for (const grapheme of graphemes(sanitize(text))) {
      const size = graphemeCells(grapheme);
      if (size === 0) continue;
      if (used + size > maxW || x + used + size > this.w) break;
      const cx = x + used;
      if (cx >= 0) {
        this.put(cx, y, grapheme, fg, style.bg, attr);
        if (size === 2) this.put(cx + 1, y, '', fg, style.bg, attr);
      }
      used += size;
    }
    return used;
  }

  fill(x: number, y: number, w: number, h: number, ch = ' ', style: Style = {}): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      this.put(xx, yy, ch, style.fg === undefined ? C.cream : fade(style.fg, style.alpha ?? 1), style.bg ?? this.base);
    }
  }

  /** Set one half-block pixel. `py` is in pixel rows (two per cell). Colour -1 erases. */
  px(x: number, py: number, color: Rgb): void {
    x = Math.round(x); py = Math.round(py);
    const y = py >> 1;
    if (!this.inside(x, y)) return;
    const i = y * this.w + x;
    const prevTop = this.top[i]!;
    const prevBot = this.bot[i]!;
    // Starting from a text cell: its background shows through both halves.
    let topColor = prevTop === NO_PX ? this.bg[i]! : prevTop;
    let botColor = prevBot === NO_PX ? this.bg[i]! : prevBot;
    if (color === DEFAULT) color = this.base;
    if (py & 1) botColor = color; else topColor = color;
    this.setPixels(i, topColor, botColor);
  }

  private setPixels(i: number, topColor: Rgb, botColor: Rgb): void {
    const base = this.base;
    this.top[i] = topColor;
    this.bot[i] = botColor;
    this.at[i] = 0;
    if (topColor === botColor) {
      if (topColor === base || topColor === DEFAULT) { this.ch[i] = ' '; this.fg[i] = DEFAULT; this.bg[i] = topColor; }
      else { this.ch[i] = '█'; this.fg[i] = topColor; this.bg[i] = base; }
    } else if (botColor === base || botColor === DEFAULT) {
      this.ch[i] = '▀'; this.fg[i] = topColor; this.bg[i] = botColor;
    } else if (topColor === base || topColor === DEFAULT) {
      this.ch[i] = '▄'; this.fg[i] = botColor; this.bg[i] = topColor;
    } else {
      this.ch[i] = '▀'; this.fg[i] = topColor; this.bg[i] = botColor;
    }
  }

  /** Copy another canvas onto this one at (x, y). Cells with the source base background and a blank are skipped when `transparent`. */
  blit(src: Canvas, x: number, y: number, transparent = true): void {
    for (let sy = 0; sy < src.h; sy++) for (let sx = 0; sx < src.w; sx++) {
      const si = sy * src.w + sx;
      const ch = src.ch[si]!;
      if (transparent && ch === ' ' && src.bg[si] === src.base) continue;
      const tx = x + sx, ty = y + sy;
      if (!this.inside(tx, ty)) continue;
      const ti = ty * this.w + tx;
      this.ch[ti] = ch;
      this.fg[ti] = src.fg[si]!;
      this.bg[ti] = src.bg[si] === src.base ? this.bg[ti]! : src.bg[si]!;
      this.at[ti] = src.at[si]!;
      this.top[ti] = NO_PX;
      this.bot[ti] = NO_PX;
    }
  }

  /** Plain text of one row (for tests and --plain). */
  row(y: number): string {
    let out = '';
    for (let x = 0; x < this.w; x++) out += this.ch[y * this.w + x]!;
    return out;
  }

  toText(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.h; y++) rows.push(this.row(y).trimEnd());
    return rows.join('\n');
  }
}

/** Cell width of text after sanitising. */
export function textWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemes(sanitize(text))) width += graphemeCells(grapheme);
  return width;
}
