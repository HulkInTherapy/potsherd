/**
 * Terminal capabilities and the cell-diff renderer.
 *
 * Only cells that changed since the last frame are written; each frame is one string wrapped in
 * synchronized-output markers (DEC 2026), which terminals without support simply ignore.
 */
import { BOLD, Canvas, DIM, ITALIC, UNDERLINE } from './canvas.js';
import { C, channels, DEFAULT, to16, to256, type Rgb } from './color.js';

export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

export interface Caps {
  color: ColorDepth;
  /** Animate (false with --no-motion, NO_COLOR, SLOPIE_REDUCED_MOTION=1, or a dumb terminal). */
  motion: boolean;
  /** Box/block glyphs available (false with --ascii). */
  unicode: boolean;
}

export function detectCaps(env: NodeJS.ProcessEnv = process.env, options: { color?: boolean; motion?: boolean; ascii?: boolean } = {}): Caps {
  const noColor = options.color === false || 'NO_COLOR' in env || env['TERM'] === 'dumb';
  let color: ColorDepth;
  if (noColor) color = 'none';
  else if (/^(truecolor|24bit)$/i.test(env['COLORTERM'] ?? '') || /^(iTerm\.app|WezTerm|ghostty|vscode)$/i.test(env['TERM_PROGRAM'] ?? '') || env['WT_SESSION'] || /kitty|ghostty|alacritty|foot/i.test(env['TERM'] ?? '')) color = 'truecolor';
  else if (/256/.test(env['TERM'] ?? '') || env['TERM_PROGRAM'] === 'Apple_Terminal') color = '256';
  else color = '16';
  if (env['SLOPIE_COLOR'] && ['truecolor', '256', '16', 'none'].includes(env['SLOPIE_COLOR'])) color = env['SLOPIE_COLOR'] as ColorDepth;
  const motion = options.motion !== false && !noColor && env['SLOPIE_REDUCED_MOTION'] !== '1' && env['TERM'] !== 'dumb';
  return { color, motion, unicode: !options.ascii };
}

function fgCode(color: Rgb, depth: ColorDepth): string {
  if (color < 0 || depth === 'none') return '';
  if (depth === 'truecolor') return `;38;2;${channels(color).join(';')}`;
  if (depth === '256') return `;38;5;${to256(color)}`;
  return `;${to16(color)}`;
}

function bgCode(color: Rgb, depth: ColorDepth): string {
  if (color < 0 || depth === 'none') return '';
  if (depth === 'truecolor') return `;48;2;${channels(color).join(';')}`;
  if (depth === '256') return `;48;5;${to256(color)}`;
  // 16 colours: only paint backgrounds for strong fills (pixel art), never the card ink.
  if (color === C.ink) return '';
  return `;${to16(color) + 10}`;
}

export function sgrFor(fg: Rgb, bg: Rgb, attr: number, depth: ColorDepth): string {
  let codes = '0';
  if (attr & BOLD) codes += ';1';
  if (attr & DIM) codes += ';2';
  if (attr & ITALIC) codes += ';3';
  if (attr & UNDERLINE) codes += ';4';
  codes += fgCode(fg, depth) + bgCode(bg, depth);
  return `\x1b[${codes}m`;
}

export class CellRenderer {
  private prev: Canvas | null = null;

  constructor(readonly depth: ColorDepth) {}

  invalidate(): void {
    this.prev = null;
  }

  /** Escape sequence that turns the last painted frame into `next`; '' when nothing changed. */
  frame(next: Canvas, clear = false): string {
    const prev = clear || !this.prev || this.prev.w !== next.w || this.prev.h !== next.h ? null : this.prev;
    let out = prev ? '' : '\x1b[0m\x1b[H\x1b[2J';
    for (let y = 0; y < next.h; y++) {
      let x = 0;
      while (x < next.w) {
        const i = y * next.w + x;
        if (prev && same(prev, next, i)) { x++; continue; }
        // A run of changed cells (allowing small unchanged gaps to avoid cursor jumps).
        let end = x;
        let gap = 0;
        for (let k = x; k < next.w; k++) {
          const j = y * next.w + k;
          if (!prev || !same(prev, next, j)) { end = k; gap = 0; }
          else if (++gap > 4) break;
        }
        let start = x;
        if (next.ch[i] === '' && start > 0) start--;
        if (end + 1 < next.w && next.ch[y * next.w + end + 1] === '') end++;
        out += `\x1b[${y + 1};${start + 1}H`;
        let sgr = '';
        for (let k = start; k <= end; k++) {
          const j = y * next.w + k;
          const ch = next.ch[j]!;
          if (ch === '') continue;
          const want = sgrFor(next.fg[j]!, next.bg[j]!, next.at[j]!, this.depth);
          if (want !== sgr) { out += want; sgr = want; }
          out += ch;
        }
        x = end + 1;
      }
    }
    this.prev = snapshot(next);
    if (!out) return '';
    return `\x1b[?2026h${out}\x1b[0m\x1b[?2026l`;
  }
}

function same(a: Canvas, b: Canvas, i: number): boolean {
  return a.ch[i] === b.ch[i] && a.fg[i] === b.fg[i] && a.bg[i] === b.bg[i] && a.at[i] === b.at[i];
}

function snapshot(src: Canvas): Canvas {
  const copy = new Canvas(src.w, src.h, src.base);
  for (let i = 0; i < src.ch.length; i++) copy.ch[i] = src.ch[i]!;
  copy.fg.set(src.fg);
  copy.bg.set(src.bg);
  copy.at.set(src.at);
  return copy;
}

/** Whole canvas as ANSI (no diffing) — for tests, --plain previews and debugging. */
export function canvasToAnsi(canvas: Canvas, depth: ColorDepth): string {
  const rows: string[] = [];
  for (let y = 0; y < canvas.h; y++) {
    let row = '';
    let sgr = '';
    for (let x = 0; x < canvas.w; x++) {
      const i = y * canvas.w + x;
      const ch = canvas.ch[i]!;
      if (ch === '') continue;
      const want = sgrFor(canvas.fg[i]!, canvas.bg[i]!, canvas.at[i]!, depth);
      if (want !== sgr) { row += want; sgr = want; }
      row += ch;
    }
    rows.push(row + '\x1b[0m');
  }
  return rows.join('\n');
}

export { DEFAULT };
