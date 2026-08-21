/**
 * Typography for the terminal design system (plans/05).
 *
 *   numbers   1,030            thousands separators, always
 *   dates     21 aug 2026      lowercase, no punctuation
 *   ranges    nov 2025 -> aug 2026
 *   durations 41ms / 11.4s / 3m 12s
 *   money     $0.021
 *   bytes     344 MB
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function num(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

export function date(d: Date | string | number): string {
  const dt = toDate(d);
  if (!dt) return '?';
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

export function monthYear(d: Date | string | number): string {
  const dt = toDate(d);
  if (!dt) return '?';
  return `${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** `2026-08-21T09:14:03Z` -> `21 aug 09:14` (year shown only when not this year). */
export function shortDateTime(d: Date | string | number, now = new Date()): string {
  const dt = toDate(d);
  if (!dt) return '?';
  const y = dt.getFullYear() === now.getFullYear() ? '' : ` ${dt.getFullYear()}`;
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}${y} ${hh}:${mm}`;
}

/** `21 aug` / `21 aug 2025` — the `ls` and `find` column. */
export function shortDate(d: Date | string | number, now = new Date()): string {
  const dt = toDate(d);
  if (!dt) return '?';
  const y = dt.getFullYear() === now.getFullYear() ? '' : ` ${dt.getFullYear()}`;
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}${y}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(v) : v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${s} ${units[i]}`;
}

/** Elide in the middle, never at the end: `.../Second-Brain/85ef9531`. */
export function elideMiddle(s: string, max: number, ellip = '…'): string {
  if (s.length <= max) return s;
  if (max <= ellip.length) return ellip.slice(0, max);
  const keep = max - ellip.length;
  const right = Math.ceil(keep / 2);
  const left = keep - right;
  return s.slice(0, left) + ellip + s.slice(s.length - right);
}

/**
 * Elide at the end, collapsing whitespace. For titles, prompts and any other
 * text that arrived from a transcript and may contain newlines.
 */
export function elide(s: string, max: number, ellip = '…'): string {
  return clip(s.replace(/\s+/g, ' ').trim(), max, ellip);
}

/**
 * Elide at the end without touching the spacing. Used for text potsherd wrote
 * itself, where the double space in `run  potsherd rescue  to ...` is the
 * design, not an accident.
 */
export function clip(s: string, max: number, ellip = '…'): string {
  if (s.length <= max) return s;
  if (max <= ellip.length) return ellip.slice(0, max);
  return s.slice(0, max - ellip.length).trimEnd() + ellip;
}

/** Join items with a separator, dropping the tail that does not fit. */
export function joinFit(items: string[], max: number, sepChar = ' · ', ellip = '…'): string {
  if (items.length === 0) return '';
  let out = '';
  let shown = 0;
  for (const item of items) {
    const next = out ? out + sepChar + item : item;
    if (next.length > max) break;
    out = next;
    shown++;
  }
  if (shown === 0) return elide(items[0]!, max, ellip);
  if (shown < items.length) {
    const withEllip = out + sepChar + ellip;
    if (withEllip.length <= max) return withEllip;
  }
  return out;
}

/**
 * Soft-wrap prose to a width, breaking on spaces and never mid-word unless a
 * single word is longer than the line.
 *
 * The design system says a *table* never wraps (plans/05) — a wrapped table is
 * unreadable and unscreenshottable. Prose is the opposite: `potsherd show` is a
 * reader, and clipping someone's own prompt at column 78 would throw away the
 * half they were looking for. So tables clip and prose wraps, and this is the
 * only place that wraps.
 */
export function wrap(s: string, width: number): string[] {
  const max = Math.max(8, width);
  const out: string[] = [];
  for (const paragraph of s.replace(/\r/g, '').split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= max) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > max) {
        out.push(line.slice(0, max));
        line = line.slice(max);
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return n === 1 ? one : many;
}

/** `2026-08-21T09:14:03.000Z` for every timestamp potsherd writes. */
export function iso(d: Date | string | number = new Date()): string {
  const dt = toDate(d);
  return (dt ?? new Date()).toISOString();
}

function toDate(d: Date | string | number): Date | null {
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}
