import { Theme } from './theme.js';
import { clip, elide, elideMiddle } from './format.js';

/**
 * One monospace grid, used by every verb. A "card" is:
 *
 *   <heading line>
 *   <blank>
 *     label ...............   value   note
 *     label ...............   value   note
 *   <blank>
 *     prose line
 *     next-verb line
 *
 * Columns: 2-space indent, label left, value right-aligned so the digits form a
 * column, note left. At 80 cols the value column ends at 35 and notes get 43
 * characters; at 60 cols the note column shrinks and elides rather than wraps.
 * Nothing in this module ever wraps a row.
 */

export const INDENT = '  ';
const LABEL_W = 25;
const VALUE_W = 7;
const GAP = 3;

export interface Row {
  label: string;
  value?: string;
  note?: string;
  /** Colour applied to the value (and, for `accent`, to the note too). */
  tone?: 'accent' | 'warn' | 'ok' | 'dim' | 'none';
}

/** The width a row's note column gets at this terminal width. */
export function noteWidth(t: Theme): number {
  const labelW = t.width >= 74 ? LABEL_W : Math.max(16, LABEL_W - (74 - t.width));
  return Math.max(0, t.width - INDENT.length - labelW - VALUE_W - GAP);
}

export class Card {
  private lines: string[] = [];

  constructor(private readonly t: Theme) {}

  /**
   * `potsherd audit · ~/.claude · 21 aug 2026`. Middle parts are paths, so
   * they elide in the middle when the terminal is narrow: the last segment of
   * a path identifies it, the middle rarely does.
   */
  heading(verb: string, ...parts: string[]): this {
    const head = `potsherd ${verb}`;
    const rest = parts.filter(Boolean);
    const sep = ` ${this.t.sep} `;
    let budget = this.t.width - head.length - sep.length * rest.length;
    const shown = rest.map((p) => {
      const share = Math.max(8, Math.floor(budget / Math.max(1, rest.length)));
      const out = p.length > share ? elideMiddle(p, share, this.t.ellip) : p;
      budget -= out.length;
      return out;
    });
    this.lines.push(this.t.dim([head, ...shown].join(sep)));
    return this;
  }

  blank(): this {
    this.lines.push('');
    return this;
  }

  raw(line = ''): this {
    this.lines.push(line);
    return this;
  }

  /** An indented prose line, clipped (never wrapped) to the terminal width. */
  text(s: string, tone: Row['tone'] = 'none'): this {
    const max = Math.max(20, this.t.width - INDENT.length);
    this.lines.push(INDENT + this.tone(clip(s, max), tone));
    return this;
  }

  row(r: Row): this {
    const labelW = this.labelWidth();
    const noteW = Math.max(0, this.t.width - INDENT.length - labelW - VALUE_W - GAP);
    const label = r.label.length > labelW ? elide(r.label, labelW) : r.label.padEnd(labelW);
    const rawValue = r.value ?? '';
    const value = rawValue.length > VALUE_W ? rawValue : rawValue.padStart(VALUE_W);
    const note = r.note ? clip(r.note, noteW) : '';
    const coloured = this.tone(value, r.tone);
    const line = `${INDENT}${label}${coloured}${note ? '   ' + this.noteTone(note, r.tone) : ''}`;
    this.lines.push(line.trimEnd());
    return this;
  }

  rows(rs: Row[]): this {
    for (const r of rs) this.row(r);
    return this;
  }

  /** Every verb's last line is the next verb. */
  next(command: string, why: string): this {
    this.lines.push(`${INDENT}${this.t.dim('run')}  ${command}  ${this.t.dim(why)}`);
    return this;
  }

  toString(): string {
    return this.lines.join('\n');
  }

  print(out: NodeJS.WritableStream = process.stdout): void {
    out.write(this.toString() + '\n');
  }

  private labelWidth(): number {
    // At 60 cols the label column gives ground before the value column does.
    return this.t.width >= 74 ? LABEL_W : Math.max(16, LABEL_W - (74 - this.t.width));
  }

  /** Exposed so callers can pre-fit a note (a project list, say) themselves. */
  noteWidth(): number {
    return noteWidth(this.t);
  }

  private tone(s: string, tone: Row['tone']): string {
    switch (tone) {
      case 'accent': return this.t.accent(s);
      case 'warn': return this.t.warn(s);
      case 'ok': return this.t.ok(s);
      case 'dim': return this.t.dim(s);
      default: return s;
    }
  }

  private noteTone(s: string, tone: Row['tone']): string {
    // The note inherits accent/warn (they are one statement), but a plain row's
    // note is always secondary.
    if (tone === 'accent') return this.t.accent(s);
    if (tone === 'warn') return this.t.warn(s);
    return this.t.dim(s);
  }
}

/**
 * A left-aligned column table for list output (`ls`, `find`). Columns size to
 * their content, the last column absorbs the remaining width and elides.
 */
export function table(
  t: Theme,
  rows: string[][],
  opts: { align?: ('left' | 'right')[]; gap?: number; indent?: string } = {},
): string[] {
  if (rows.length === 0) return [];
  const gap = opts.gap ?? 2;
  const indent = opts.indent ?? INDENT;
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...rows.map((r) => Theme.len(r[c] ?? '')));
  }
  const budget = t.width - indent.length - gap * (cols - 1);
  const fixed = widths.slice(0, -1).reduce((a, b) => a + b, 0);
  const lastMax = Math.max(8, budget - fixed);
  widths[cols - 1] = Math.min(widths[cols - 1] ?? 0, lastMax);

  return rows.map((r) =>
    (indent +
      r
        .map((cell, c) => {
          const w = widths[c] ?? 0;
          const len = Theme.len(cell);
          const clipped = len > w ? elide(cell, w) : cell;
          const pad = ' '.repeat(Math.max(0, w - Theme.len(clipped)));
          return opts.align?.[c] === 'right' ? pad + clipped : clipped + pad;
        })
        .join(' '.repeat(gap))
    ).trimEnd(),
  );
}
