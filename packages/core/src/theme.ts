import process from 'node:process';

/**
 * The terminal design system, in code (plans/05-SHAREABLE-EXPERIENCE.md).
 *
 * Rules this module enforces so no verb can break them:
 *   - never more than three colours on screen: accent, warn, ok. Everything
 *     else is `dim` or default.
 *   - NO_COLOR and --no-color are honoured; a non-TTY stdout is never coloured.
 *   - --ascii replaces every non-ASCII glyph, so the output survives a terminal
 *     with no unicode font and a screenshot taken on Windows. Two mechanisms,
 *     because one was demonstrably forgettable: {@link Theme.g} picks the
 *     fallback where the glyph is chosen, and {@link Theme.asciiLine} folds
 *     whatever still got through — an em dash typed into a note, a `·` an
 *     adapter wrote, an emoji in someone's own prompt. `render.ts` runs every
 *     line it emits through the fold, so no verb can opt out by forgetting.
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
  /** The em dash that stands in for "no number here". */
  get dash(): string { return this.g('—', '-'); }

  /**
   * Fold one rendered line to pure ASCII, when `--ascii` is on.
   *
   * Applied at the very end, after the line has been fitted to the terminal
   * width, so **every substitution is exactly one character wide or narrower**.
   * That is the whole design constraint: `…` → `...` here would push a line
   * that just fitted 80 columns to 82. The three-character ellipsis comes from
   * {@link ellip}, which the width arithmetic sees; this is only the net.
   */
  asciiLine(s: string): string {
    return this.ascii ? toAscii(s) : s;
  }

  /** Visible width, ignoring ANSI escapes. */
  static len(s: string): number {
    return stripAnsi(s).length;
  }
}

/**
 * The glyphs the design system uses, and their one-character ASCII stand-ins.
 * Anything not listed is decomposed (`é` → `e`) and, failing that, becomes a
 * single `?` — never silently dropped, because a vanished character is a
 * vanished fact.
 */
const ASCII_FOLD: Record<string, string> = {
  '…': '.', '·': '.', '•': '*', '‧': '.', '∙': '.',
  '—': '-', '–': '-', '‒': '-', '−': '-', '―': '-',
  '→': '>', '⇒': '>', '←': '<', '⇐': '<', '↑': '^', '↓': 'v',
  '≤': '<', '≥': '>', '≠': '!', '±': '~', '×': 'x', '÷': '/',
  '★': '*', '☆': '*', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x',
  '‹': '<', '›': '>', '«': '<', '»': '>',
  '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '‚': "'",
  '█': '#', '▇': '#', '▓': '#', '▒': '+', '░': '.', '■': '#', '□': '.',
  '│': '|', '─': '-', '┌': '+', '┐': '+', '└': '+', '┘': '+', '├': '+',
  '┤': '+', '┬': '+', '┴': '+', '┼': '+', '°': 'o', '§': 'S', '¶': 'P',
  '\u00a0': ' ', '\u2007': ' ', '\u2009': ' ', '\u202f': ' ', '\ufeff': '',
};

/**
 * Every non-ASCII code point replaced by one that is, without ever making the
 * string longer (measured in characters, which is what a terminal column is).
 * Surrogate pairs count as the one character they display as.
 */
export function toAscii(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128 && ch.length === 1) { out += ch; continue; }
    const mapped = ASCII_FOLD[ch];
    if (mapped !== undefined) { out += mapped; continue; }
    // `é` is `e` plus a combining acute; drop the accent and keep the letter.
    const bare = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // eslint-disable-next-line no-control-regex
    out += bare.length === 1 && !/[^\x00-\x7F]/.test(bare) ? bare : '?';
  }
  return out;
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
