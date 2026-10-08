/** Local calendar parts of epoch milliseconds in a time zone, memoized per 15 minutes. */
export interface LocalParts {
  /** YYYY-MM-DD */
  day: string;
  /** YYYY-MM */
  month: string;
  /** 0..23 */
  hour: number;
  /** 0=Mon .. 6=Sun */
  dow: number;
  minute: number;
}

const WEEKDAY: Record<string, number> = {Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6};

export function localClock(timezone: string): (at: number) => LocalParts {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const memo = new Map<number, LocalParts>();
  return at => {
    const slot = Math.floor(at / 900_000);
    let hit = memo.get(slot);
    if (hit) return {...hit, minute: hit.minute + Math.floor((at - slot * 900_000) / 60_000)};
    const parts: Record<string, string> = {};
    for (const p of format.formatToParts(new Date(slot * 900_000))) parts[p.type] = p.value;
    const hour = Number(parts.hour) % 24;
    hit = {day: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}`, hour, dow: WEEKDAY[parts.weekday!] ?? 0, minute: Number(parts.minute)};
    memo.set(slot, hit);
    return {...hit, minute: hit.minute + Math.floor((at - slot * 900_000) / 60_000)};
  };
}

export const HOUR_NAME = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** '2026-03' -> 'Mar 2026' (or 'Mar' without year, 'March' long). */
export function monthName(month: string, style: 'short' | 'year' | 'long' = 'year'): string {
  const [y, m] = month.split('-');
  const i = Number(m) - 1;
  return style === 'long' ? MONTHS_LONG[i]! : style === 'short' ? MONTHS[i]! : `${MONTHS[i]} ${y}`;
}
/** '2026-03-07' -> 'Mar 7' (with year: 'Mar 7, 2026'; long: 'March 7'). */
export function dayName(day: string, style: 'short' | 'year' | 'long' = 'short'): string {
  const [y, m, d] = day.split('-');
  const i = Number(m) - 1;
  if (style === 'long') return `${MONTHS_LONG[i]} ${Number(d)}`;
  return style === 'year' ? `${MONTHS[i]} ${Number(d)}, ${y}` : `${MONTHS[i]} ${Number(d)}`;
}
/** Whole days between two YYYY-MM-DD dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
/** ISO week key 'YYYY-Www' and its Monday (YYYY-MM-DD) for a local day. */
const weekMemo = new Map<string, {key: string; monday: string}>();
export function isoWeek(day: string): {key: string; monday: string} {
  let hit = weekMemo.get(day);
  if (!hit) { hit = computeIsoWeek(day); if (weekMemo.size > 5000) weekMemo.clear(); weekMemo.set(day, hit); }
  return hit;
}
function computeIsoWeek(day: string): {key: string; monday: string} {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - dow * 86_400_000);
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000);
  const week = 1 + Math.round((monday.getTime() - week1.getTime()) / (7 * 86_400_000));
  return {key: `${year}-W${String(week).padStart(2, '0')}`, monday: monday.toISOString().slice(0, 10)};
}
