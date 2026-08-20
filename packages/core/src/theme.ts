import process from 'node:process';

/**
 * The terminal design system, in code (plans/05-SHAREABLE-EXPERIENCE.md).
 *
 * Rules this module enforces so no verb can break them:
 *   - never more than three colours on screen: accent, warn, ok. Everything
 *     else is `dim` or default.
 *   - NO_COLOR and --no-color are honoured; a non-TTY stdout is never coloured.
 *   - --ascii replaces every non-ASCII glyph, so the output survives a terminal
 *     with no unicode font and a screenshot taken on Windows.
 */

export interface ThemeOptions {
  color?: boolean;
  ascii?: boolean;
  width?: number;
}

const CSI = '\u001b[';

export class Theme {
  readonly color: boolean;
  readonly ascii: boolean;
  readonly width: number;

  constructor(opts: ThemeOptions = {}) {
    this.color = opts.color ?? detectColor();
    this.ascii = opts.ascii ?? detectAscii();
    this.width = opts.width ?? detectWidth();
  }

  private wrap(code: string, s: string): string {
    return this.color ? `${CSI}${code}m${s}${CSI}0m` : s;
  }

  /** The single most important number on the screen. Exactly one per card. */
  accent(s: string): string { return this.wrap('38;5;209', s); }
  /** Urgency: something is about to be lost. */
  warn(s: string): string { return this.wrap('38;5;214', s); }
  /** Done, saved, safe. */
  ok(s: string): string { return this.wrap('38;5;71', s); }
  /** Secondary text: units, notes, sources. */
  dim(s: string): string { return this.wrap('2', s); }
  bold(s: string): string { return this.wrap('1', s); }

  /** Pick a glyph, with an ASCII fallback for --ascii / non-unicode terminals. */
  g(unicode: string, fallback: string): string {
    return this.ascii ? fallback : unicode;
  }

  get arrow(): string { return this.g('→', '->'); }
  get mid(): string { return this.g('·', '.'); }
  get sep(): string { return this.g('·', '|'); }
  get ellip(): string { return this.g('…', '...'); }
  get star(): string { return this.g('★', '*'); }
  get le(): string { return this.g('≤', '<='); }
  get bullet(): string { return this.g('•', '-'); }

  /** Visible width, ignoring ANSI escapes. */
  static len(s: string): number {
    return stripAnsi(s).length;
  }
}

const ANSI_RE = new RegExp('\\u001b\\[[0-9;]*m', 'g');

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function detectColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

function detectAscii(): boolean {
  if (process.env.POTSHERD_ASCII === '1') return true;
  const enc = `${process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? ''}`;
  if (enc && !/utf-?8/i.test(enc)) return true;
  return false;
}

function detectWidth(): number {
  const cols = process.stdout.columns;
  if (!cols || cols < 40) return 80;
  return Math.min(cols, 100);
}
