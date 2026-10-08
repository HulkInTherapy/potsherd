/**
 * Minimal diff renderer: keeps the last painted rows and rewrites only rows that changed.
 * Output is wrapped in synchronized-update markers so terminals that support them never
 * show a half-drawn frame.
 */
import type { Line, Style } from './layout.js';

type Rgb = readonly [number, number, number];
const PALETTE: Record<'orange' | 'white' | 'gray' | 'dark', { rgb: Rgb; ansi256: number }> = {
  orange: { rgb: [0xf2, 0xa4, 0x5e], ansi256: 215 },
  white: { rgb: [0xee, 0xea, 0xe4], ansi256: 255 },
  gray: { rgb: [0xa6, 0xa2, 0x9b], ansi256: 248 },
  dark: { rgb: [0x68, 0x66, 0x5f], ansi256: 241 },
};

const STYLES: Record<Style, { color: keyof typeof PALETTE; bold?: boolean }> = {
  brand: { color: 'orange', bold: true },
  accent: { color: 'orange' },
  title: { color: 'gray', bold: true },
  value: { color: 'white', bold: true },
  text: { color: 'white' },
  muted: { color: 'gray' },
  faint: { color: 'dark' },
};

export type ColorMode = 'none' | '256' | 'truecolor';

export function detectColorMode(env: NodeJS.ProcessEnv = process.env, enabled = true): ColorMode {
  if (!enabled || 'NO_COLOR' in env || env['TERM'] === 'dumb') return 'none';
  if (/truecolor|24bit/i.test(env['COLORTERM'] ?? '')) return 'truecolor';
  return '256';
}

function sgr(style: Style, mode: ColorMode): string {
  const spec = STYLES[style];
  const codes: string[] = [];
  if (spec.bold) codes.push('1');
  if (mode === 'truecolor') codes.push(`38;2;${PALETTE[spec.color].rgb.join(';')}`);
  else if (mode === '256') codes.push(`38;5;${PALETTE[spec.color].ansi256}`);
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

/** One line as an ANSI string (segments are already sanitised and clipped by the layout). */
export function lineToAnsi(line: Line, mode: ColorMode): string {
  let out = '';
  for (const part of line) {
    if (!part.text) continue;
    if (/^ +$/.test(part.text)) {
      out += part.text;
      continue;
    }
    const open = sgr(part.style, mode);
    out += open ? `${open}${part.text}\x1b[0m` : part.text;
  }
  return out;
}

export class DiffRenderer {
  private previous: string[] = [];

  constructor(private readonly mode: ColorMode) {}

  /** Forget what is on screen (after a resize or when re-entering the alt screen). */
  invalidate(): void {
    this.previous = [];
  }

  /** Escape sequence that turns the last painted frame into `lines`; empty when nothing changed. */
  frame(lines: readonly Line[], fullClear = false): string {
    const next = lines.map(line => lineToAnsi(line, this.mode));
    let out = '';
    if (fullClear) {
      out += '\x1b[H\x1b[2J';
      this.previous = [];
    }
    for (let row = 0; row < next.length; row++) {
      if (this.previous[row] === next[row]) continue;
      out += `\x1b[${row + 1};1H${next[row]}\x1b[K`;
    }
    for (let row = next.length; row < this.previous.length; row++) out += `\x1b[${row + 1};1H\x1b[K`;
    this.previous = next;
    return out ? `\x1b[?2026h${out}\x1b[?2026l` : '';
  }
}
