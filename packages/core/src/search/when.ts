/**
 * The date phrases a person actually types.
 *
 * `03` §7 gives `find` a `--since` and an `--until`, and phase 3 deliverable 5
 * asks for the forms nobody thinks of as a date: `30d`, `last week`, `in july`.
 * A scripted caller writes `2026-08-01`; a human at a prompt writes "last
 * month", and a search tool that answers that with a regular expression it
 * would have accepted is a tool people stop using filters on.
 *
 * Two rules hold the whole module together.
 *
 * **A phrase is an interval, not an instant.** "in july" is thirty-one days
 * wide, and which end of it `--since` and `--until` want is opposite. So the
 * parser returns a range and the caller picks an edge — which is also why
 * `--until 2026-08-01` now means the *end* of that day rather than its first
 * millisecond, the one thing the earlier single-instant version got wrong for
 * every user who typed a bare date.
 *
 * **Absolute forms are read in UTC, relative ones in local time.** The store
 * holds UTC ISO strings and compares them as text, so `2026-08` has to become
 * `2026-08-01T00:00:00.000Z` or it would not line up with the column. But
 * "today" is a statement about the clock on the wall in front of the person
 * typing it, and resolving it in UTC would hand someone in Auckland yesterday's
 * sessions. Each form is documented with which rule it follows.
 *
 * Nothing here loosens {@link validateISODate}: this runs at the CLI edge and
 * hands `recall` an ISO string, so the injection-safe, ISO-only contract the
 * store enforces is untouched. `recall(db, q, { since: 'last tuesday' })` still
 * throws, and should.
 */

/** An interval, as the ISO strings the store compares against. */
export interface WhenRange {
  start: string;
  end: string;
  /** What the phrase was understood as, for `--explain` and for errors. */
  label: string;
}

/**
 * The forms, in the order an error should list them. Kept as data because the
 * error message and the `--help` text must never drift from what parses.
 */
export const WHEN_FORMS: readonly string[] = [
  '2026-08-01',
  '2026-08',
  '30d / 6w / 3m / 2y',
  'today',
  'yesterday',
  'last week',
  'last month',
  'in july',
  'july 2025',
  '3 days ago',
];

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

const UNIT_ALIASES: Record<string, 'h' | 'd' | 'w' | 'm' | 'y'> = {
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
  w: 'w', wk: 'w', wks: 'w', week: 'w', weeks: 'w',
  m: 'm', mo: 'm', mon: 'm', month: 'm', months: 'm',
  y: 'y', yr: 'y', yrs: 'y', year: 'y', years: 'y',
};

/**
 * `--since 30d` / `--until "in july"` -> one ISO string.
 *
 * `null` when nothing understood it, so the caller can raise the error in its
 * own voice with its own flag name in it.
 */
export function whenEdge(
  value: string,
  edge: 'since' | 'until',
  now: Date = new Date(),
): string | null {
  const range = parseWhen(value, now);
  if (!range) return null;
  return edge === 'since' ? range.start : range.end;
}

/** The interval a phrase names, or `null` if it names nothing. */
export function parseWhen(value: string, now: Date = new Date()): WhenRange | null {
  const raw = value.trim();
  if (!raw) return null;
  const v = raw.toLowerCase().replace(/\s+/g, ' ');

  return (
    absolute(raw, v) ??
    span(v, now) ??
    named(v, now) ??
    monthPhrase(v, now) ??
    weekday(v, now) ??
    null
  );
}

// ------------------------------------------------------------------ absolute

/**
 * `2026-08-01T09:00:00Z`, `2026-08-01`, `2026-08`, `2026`.
 *
 * Read in UTC, because these are the forms a script writes and the column they
 * are compared against is UTC. A bare date is a whole day: `--since` gets its
 * first millisecond and `--until` its last, which is what makes
 * `--since 2026-08-01 --until 2026-08-01` mean "that day" rather than "nothing".
 */
function absolute(raw: string, v: string): WhenRange | null {
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(raw)) {
    // A caller who typed a time meant that instant; it is both ends of itself.
    if (!Number.isFinite(new Date(raw.replace(' ', 'T')).getTime())) return null;
    return { start: raw, end: raw, label: raw };
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) {
    const y = Number(day[1]);
    const mo = Number(day[2]);
    const d = Number(day[3]);
    if (!validYmd(y, mo, d)) return null;
    return utcRange(Date.UTC(y, mo - 1, d), Date.UTC(y, mo - 1, d + 1), v);
  }
  const month = /^(\d{4})-(\d{2})$/.exec(v);
  if (month) {
    const y = Number(month[1]);
    const mo = Number(month[2]);
    if (mo < 1 || mo > 12) return null;
    return utcRange(Date.UTC(y, mo - 1, 1), Date.UTC(y, mo, 1), v);
  }
  const year = /^(\d{4})$/.exec(v);
  if (year) {
    const y = Number(year[1]);
    if (y < 1970 || y > 2999) return null;
    return utcRange(Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1), v);
  }
  return null;
}

function validYmd(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

// ---------------------------------------------------------------------- span

/**
 * `30d`, `6w`, `3 months`, `3 days ago`, `last 30 days`, `past 2 weeks`.
 *
 * A span is measured back from *now*, not from midnight: someone who typed
 * `--since 1d` at nine in the morning means the last twenty-four hours, and
 * rounding that to a day boundary would quietly widen it.
 */
function span(v: string, now: Date): WhenRange | null {
  const m =
    /^(?:last |past |the last |the past )?(\d+)\s*([a-z]+)(?: ago)?$/.exec(v) ??
    /^(\d+)([a-z])$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = UNIT_ALIASES[m[2] ?? ''];
  if (!unit || !Number.isFinite(n) || n <= 0 || n > 10_000) return null;
  const start = new Date(now);
  if (unit === 'h') start.setHours(start.getHours() - n);
  else if (unit === 'd') start.setDate(start.getDate() - n);
  else if (unit === 'w') start.setDate(start.getDate() - n * 7);
  else if (unit === 'm') start.setMonth(start.getMonth() - n);
  else start.setFullYear(start.getFullYear() - n);
  return { start: start.toISOString(), end: now.toISOString(), label: `the last ${n}${unit}` };
}

// --------------------------------------------------------------------- named

/**
 * `today`, `yesterday`, `this week`, `last week`, `this month`, `last month`,
 * `this year`, `last year`.
 *
 * Local time, all of them: these are statements about the calendar the person
 * is looking at. The week starts on Monday, which is what "last week" means
 * everywhere the ISO calendar is used and what a working week means anyway.
 */
function named(v: string, now: Date): WhenRange | null {
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  switch (v) {
    case 'now':
      return { start: now.toISOString(), end: now.toISOString(), label: 'now' };
    case 'today':
      return localRange(new Date(y, mo, d), new Date(y, mo, d + 1), 'today');
    case 'yesterday':
      return localRange(new Date(y, mo, d - 1), new Date(y, mo, d), 'yesterday');
    case 'this week':
      return localRange(mondayOf(now), new Date(+mondayOf(now) + WEEK), 'this week');
    case 'last week': {
      const monday = mondayOf(now);
      return localRange(new Date(+monday - WEEK), monday, 'last week');
    }
    case 'this month':
      return localRange(new Date(y, mo, 1), new Date(y, mo + 1, 1), 'this month');
    case 'last month':
      return localRange(new Date(y, mo - 1, 1), new Date(y, mo, 1), 'last month');
    case 'this year':
      return localRange(new Date(y, 0, 1), new Date(y + 1, 0, 1), 'this year');
    case 'last year':
      return localRange(new Date(y - 1, 0, 1), new Date(y, 0, 1), 'last year');
    default:
      return null;
  }
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Local midnight on the Monday of `d`'s week. */
function mondayOf(d: Date): Date {
  const day = (d.getDay() + 6) % 7; // monday = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

// --------------------------------------------------------------------- month

/**
 * `in july`, `july`, `jul`, `in july 2025`, `july 2025`.
 *
 * With no year, the most recent July that has already begun — asking "what did
 * I do in july" in August 2026 means this July, and in February 2026 it means
 * last July. Resolving forward instead would return an empty window every time,
 * which is the least useful reading available.
 */
function monthPhrase(v: string, now: Date): WhenRange | null {
  const m = /^(?:in |during )?([a-z]{3,9})(?: (\d{4}))?$/.exec(v);
  if (!m) return null;
  const name = m[1]!;
  const idx = MONTHS.findIndex((full) => full === name || full.slice(0, 3) === name);
  if (idx === -1) return null;
  let year = m[2] ? Number(m[2]) : now.getFullYear();
  if (!m[2] && idx > now.getMonth()) year -= 1;
  const label = `${MONTHS[idx]} ${year}`;
  return localRange(new Date(year, idx, 1), new Date(year, idx + 1, 1), label);
}

// ------------------------------------------------------------------- weekday

/**
 * `last tuesday`, `tuesday`.
 *
 * The most recent one that has already happened — today counts for a bare
 * weekday, and never for `last`, because "last tuesday" said on a Tuesday means
 * the one before this one.
 */
function weekday(v: string, now: Date): WhenRange | null {
  const m = /^(last |this |on )?([a-z]{3,9})$/.exec(v);
  if (!m) return null;
  const name = m[2]!;
  const idx = WEEKDAYS.findIndex((full) => full === name || full.slice(0, 3) === name);
  if (idx === -1) return null;
  const back = (m[1] ?? '').trim() === 'last';
  let delta = (now.getDay() - idx + 7) % 7;
  if (back && delta === 0) delta = 7;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - delta);
  return localRange(start, new Date(+start + 24 * 60 * 60 * 1000), `${WEEKDAYS[idx]} ${dayLabel(start)}`);
}

function dayLabel(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// ------------------------------------------------------------------- ranges

/**
 * A half-open interval `[start, end)` as the closed one the store wants.
 *
 * `--until` compares with `<=`, so the exclusive end has to come back one
 * millisecond — the smallest step an ISO string with milliseconds can express,
 * and therefore the only end that includes the last event of the last day
 * without also including the first of the next.
 */
function localRange(start: Date, endExclusive: Date, label: string): WhenRange {
  return {
    start: start.toISOString(),
    end: new Date(+endExclusive - 1).toISOString(),
    label,
  };
}

function utcRange(startMs: number, endExclusiveMs: number, label: string): WhenRange {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endExclusiveMs - 1).toISOString(),
    label,
  };
}
