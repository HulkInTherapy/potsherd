import type { Transcript, TranscriptUnit } from './cards/transcript.js';
import { renderUnit } from './cards/transcript.js';

/**
 * F5 — discontiguous relevance windows.
 *
 * ## The measurement this file exists to overturn
 *
 * `docs/AGENT-AUDIT-2026-08-23.md` §2 F5 recorded what six readers were
 * actually handed for a real question over a real archive: **one contiguous
 * run per session**, and for four of the six the run was exchanges 1–3 — the
 * opening of the conversation. The question was *what is left to build*. The
 * answer lived in the last day of an eight-day, 119-exchange session. Handing
 * a reader day one cannot produce it, however good the reader is.
 *
 * The auditor's rule, and the rule this module implements:
 *
 * > *five 200-token windows from across a long session beat one 1,300-token
 * > window from its opening, every time.*
 *
 * ## What a window is
 *
 * A **seed** exchange, chosen by relevance, plus its immediate neighbours —
 * {@link WINDOW_NEIGHBOURS} either side, for the reason `excerptUnits` already
 * gives: a decision is routinely stated in the exchange after the one that
 * raised it, and a hit whose answer is cut off is a citation that resolves and
 * says nothing.
 *
 * Windows are chosen so that they **cannot touch**: a second seed within
 * {@link WINDOW_SEPARATION} of one already chosen is skipped, because two
 * windows that abut are one window with a misleading label on it.
 *
 * ## The three things that are not negotiable
 *
 *   1. **The budget does not grow.** `n` windows share the same
 *      `ASK_SESSION_CHARS` one contiguous slice had. Five windows are not five
 *      times the tokens; they are the same tokens taken from five places. The
 *      only new spend is the gap markers, which are ~60 characters each.
 *   2. **A gap is always visible.** {@link windowText} emits a marker between
 *      any two consecutive shown exchanges that are **not adjacent in the
 *      transcript** — computed from positions, never from seq arithmetic, and
 *      never from window boundaries. A window whose neighbour did not fit in
 *      the budget therefore still prints the gap. There is no path through
 *      this file that splices two non-adjacent exchanges into prose that reads
 *      as continuous.
 *   3. **A short session is left alone.** Below {@link WINDOW_MIN_EXCHANGES}
 *      the whole transcript fits inside one slice, so windowing it could only
 *      remove text and add markers. {@link windowCount} returns 1 there and
 *      `ask` takes the old contiguous path unchanged — byte for byte.
 *
 * ## What this file does not do
 *
 * It does not rank. The seeds are handed in, and `ask.ts` gets them from
 * `recall` — the ranker the rest of the product already uses and the evals
 * already measure. The only judgement made here is *where to look when
 * relevance ran out of seeds*, and that judgement is deliberately dull:
 * {@link seedIndices} takes the **tail** first (`graft.ts`'s documented rule —
 * *"the tail of the session is what a brief with no topic is being asked
 * for"*) and then spreads over the widest unread stretches. Neither is a
 * score. Both are coverage.
 */

// ------------------------------------------------------------------ knobs

/**
 * Windows a long session's reader is given, by default.
 *
 * **Five, and the number is the audit's, not ours.** §4 item 3 asks for
 * `--windows 5`; §2 F5 argues it. What we can add is that five is also what
 * the existing budget pays for without lowering any floor:
 *
 * ```
 *   ASK_SESSION_CHARS / n            the share one window gets
 *   8,000 / 5 = 1,600 characters     ≈ 400 tokens
 *   1,600 / (MIN_UNIT_CHARS + 24)    ≈ 2.2 exchanges per window
 * ```
 *
 * So at five, each window holds its seed **and** at least one neighbour at the
 * existing 700-character floor, and the reader sees five separate places in
 * the conversation. At eight the share is 1,000 and a window is one exchange
 * with no context around it — the neighbour rule dies. At three the shares are
 * fat and the coverage is thin, which is the failure the audit measured, only
 * three times instead of once.
 *
 * Measured on the reference archive (see `phases/phase-10/T10.5-REPORT.md`):
 * at `--windows 5` the long link of the audit's own thread was handed
 * exchanges from five separated places spanning eight days, at 6.6 k
 * characters — **less** than the 8.0 k its single contiguous slice had cost.
 */
export const ASK_WINDOWS = 5;

/**
 * The short-session boundary: below this many exchanges, one window is right.
 *
 * **Derived, not chosen.** One reader's slice is `ASK_SESSION_CHARS` = 8,000
 * characters and no exchange may be cut below `MIN_UNIT_CHARS` = 700 plus its
 * 24-character `[seq n · date]` header. So a slice holds at most
 * `8,000 / 724 = 11.0` exchanges, and a session of eleven exchanges or fewer
 * **fits in the budget whole**.
 *
 * That settles the boundary rather than estimating it: if the whole session
 * fits, windowing it cannot add information and can only add gap markers for
 * text the reader could have had. Twelve is the first size at which something
 * must be left out, and therefore the first size at which *which* part is left
 * out is a decision worth making.
 *
 * `tests/windows.test.ts` pins the constant and both sides of the boundary: a
 * transcript of 11 exchanges gets one window, one of 12 gets more.
 */
export const WINDOW_MIN_EXCHANGES = 12;

/** Exchanges taken either side of a seed. `excerptUnits`'s ±1, kept. */
export const WINDOW_NEIGHBOURS = 1;

/**
 * The closest two seeds may be before the second is dropped.
 *
 * `2 * WINDOW_NEIGHBOURS + 2` = 4. At exactly `2n+1` the two windows would be
 * adjacent — [4,5,6] and [7,8,9] — which is a six-exchange contiguous run
 * printed as two windows, i.e. a lie with extra formatting. One more than that
 * guarantees at least one unshown exchange between any two windows, which is
 * what makes {@link windowText}'s marker always have something to report.
 */
export const WINDOW_SEPARATION = 2 * WINDOW_NEIGHBOURS + 2;

/** The floor on one unit's share of a slice. Below this an excerpt is noise. */
export const MIN_UNIT_CHARS = 700;

/** `[seq 12 · 2026-08-21]\n` — what `unitHeader` costs, budgeted for. */
export const UNIT_HEADER_CHARS = 24;

// ----------------------------------------------------------------- shapes

/** Why an exchange was picked as the centre of a window. */
export type WindowVia =
  /** `recall` scored it against the question. */
  | 'hit'
  /** The last exchange of the session: *where did we leave off*. */
  | 'tail'
  /** Coverage: the middle of the widest stretch nobody had looked at. */
  | 'spread';

export interface ExcerptWindow {
  /** Position in `transcript.units` of the seed. */
  seed: number;
  via: WindowVia;
  /** The units admitted for this window, in transcript order. */
  units: TranscriptUnit[];
}

export interface WindowPlan {
  windows: ExcerptWindow[];
  /** Every admitted unit, in transcript order. What the reader may cite. */
  units: TranscriptUnit[];
  /** Exchanges in the whole session. */
  exchanges: number;
  /** How many windows were asked for, after {@link windowCount}. */
  requested: number;
}

// ------------------------------------------------------------- the count

/**
 * How many windows this session gets.
 *
 * Three ceilings, and the smallest wins:
 *
 *   - **the ask** — `--windows n`, or {@link ASK_WINDOWS};
 *   - **the material** — one window per {@link WINDOW_MIN_EXCHANGES}
 *     exchanges. Asking for five windows over a twenty-exchange session is
 *     asking for more places than there are places;
 *   - **the budget** — a window that cannot afford one exchange at the floor
 *     is a header with nothing under it.
 *
 * Returns 1 for anything below the boundary, which is the caller's signal to
 * take the old contiguous path untouched.
 */
export function windowCount(
  exchanges: number,
  requested: number,
  maxChars: number,
): number {
  if (exchanges < WINDOW_MIN_EXCHANGES) return 1;
  const asked = Math.max(1, Math.floor(requested));
  const byMaterial = Math.floor(exchanges / WINDOW_MIN_EXCHANGES);
  const byBudget = Math.floor(maxChars / (MIN_UNIT_CHARS + UNIT_HEADER_CHARS));
  return Math.max(1, Math.min(asked, byMaterial, byBudget));
}

// -------------------------------------------------------------- the seeds

/**
 * Where to centre `n` windows.
 *
 * Relevance first, in the order `recall` returned it, skipping any seed that
 * would land inside a window already placed — then the **tail**, then a
 * **spread** over whatever stretch is still unread.
 *
 * ## One window is reserved for the end of the session
 *
 * When there is more than one window, relevance may fill only `n - 1` of them
 * and the last is held for the final exchange. This is not a hedge against a
 * bad ranker; it is `graft.ts`'s rule, which already says out loud why:
 *
 * > *the tail of the session is what a brief with no topic is being asked
 * > for: where did I leave off.*
 *
 * The questions F5 exists for — *what is left to build*, *what did we decide
 * to do next* — are questions about **when**, and a word-matching ranker has
 * nothing to say about when. Measured on the reference archive, the five
 * purely relevance-chosen windows of a 119-exchange session landed on seqs 1,
 * 5–6, 11–12, 55–56 and 93–94: five separate places, all of them before the
 * last quarter, for a question whose answer is in the last day.
 *
 * The reservation costs one window in five — 20% of one reader's slice — and
 * costs nothing at all when a relevance hit already lands in the tail, because
 * `free()` then rejects the tail seed and the held slot goes straight back to
 * relevance at step 3.
 *
 * ## When relevance produces nothing
 *
 * On the audit's own corpus four of six sessions had *no* seq-bearing hit at
 * all — they matched on a title or a card — and the old code answered that
 * with `units[0..2]`, the opening of the conversation, for a question about
 * the end of it. With no hits this function returns the tail and `n - 1`
 * evenly spread windows, which is the honest reading of "we do not know where
 * in this session the answer is."
 */
export function seedIndices(
  total: number,
  hits: readonly number[],
  n: number,
): { index: number; via: WindowVia }[] {
  const chosen: { index: number; via: WindowVia }[] = [];
  const free = (i: number): boolean =>
    i >= 0 &&
    i < total &&
    chosen.every((c) => Math.abs(c.index - i) >= WINDOW_SEPARATION);

  // 1. relevance, holding one slot back for the tail.
  const held = n > 1 ? 1 : 0;
  for (const i of hits) {
    if (chosen.length >= n - held) break;
    if (free(i)) chosen.push({ index: i, via: 'hit' });
  }
  // 2. the end of the session, unless a relevance window already covers it.
  if (chosen.length < n && free(total - 1)) {
    chosen.push({ index: total - 1, via: 'tail' });
  }
  // 3. the held slot, returned to relevance when the tail did not need it.
  for (const i of hits) {
    if (chosen.length >= n) break;
    if (free(i)) chosen.push({ index: i, via: 'hit' });
  }
  // Spread: repeatedly split the widest gap between placed seeds (counting the
  // two ends of the transcript as walls). Deterministic, and it degrades to
  // "evenly spaced" when there is nothing else to go on.
  while (chosen.length < n) {
    const sorted = [...chosen].sort((a, b) => a.index - b.index);
    let best = -1;
    let bestWidth = -1;
    const edges = [-1, ...sorted.map((c) => c.index), total];
    for (let e = 0; e < edges.length - 1; e++) {
      const lo = edges[e]! + 1;
      const hi = edges[e + 1]! - 1;
      if (hi < lo) continue;
      const mid = Math.floor((lo + hi) / 2);
      const width = hi - lo + 1;
      if (width > bestWidth && free(mid)) {
        bestWidth = width;
        best = mid;
      }
    }
    if (best < 0) break;
    chosen.push({ index: best, via: 'spread' });
  }
  return chosen.sort((a, b) => a.index - b.index);
}

// -------------------------------------------------------------- the plan

/**
 * `n` windows over one transcript, inside one budget.
 *
 * The budget walk is `excerptUnits`'s, one level down: each window takes its
 * fair share of what is **left**, floored at {@link MIN_UNIT_CHARS} so a long
 * tail of neighbours cannot squeeze an exchange down to noise, and a window
 * that comes in under its share hands the difference to the ones after it.
 * Inside a window the seed is admitted before its neighbours, so a window that
 * can only afford one exchange affords the one that was chosen.
 */
export function planWindows(
  transcript: Transcript,
  hits: readonly number[],
  o: { windows: number; maxChars: number },
): WindowPlan {
  const total = transcript.units.length;
  const n = Math.max(1, Math.floor(o.windows));
  const seeds = seedIndices(total, hits, n);

  const windows: ExcerptWindow[] = [];
  let remaining = o.maxChars;
  let left = seeds.length;

  for (const seed of seeds) {
    const share = Math.max(MIN_UNIT_CHARS, Math.floor(remaining / Math.max(1, left)));
    left -= 1;
    const admitted = new Map<number, TranscriptUnit>();
    // Seed first, then outwards. `unitPriority` is [seed, seed-1, seed+1, …].
    const candidates = unitPriority(seed.index, total);
    let windowLeft = share;
    let unitsLeft = candidates.length;
    for (const i of candidates) {
      const u = transcript.units[i]!;
      const per = Math.max(MIN_UNIT_CHARS, Math.floor(windowLeft / Math.max(1, unitsLeft)));
      const body = u.text.length > per ? renderUnitBody(u, per) : u.text;
      unitsLeft -= 1;
      const cost = body.length + UNIT_HEADER_CHARS;
      if (cost > windowLeft && admitted.size > 0) continue;
      admitted.set(i, body === u.text ? u : { ...u, text: body });
      windowLeft -= cost;
      if (windowLeft <= 0) break;
    }
    const units = [...admitted.keys()].sort((a, b) => a - b).map((i) => admitted.get(i)!);
    if (units.length === 0) continue;
    windows.push({ seed: seed.index, via: seed.via, units });
    // A window that overshot its share (one seed longer than the floor) pays
    // for it out of the windows after it, exactly as `excerptUnits` does.
    remaining -= share - windowLeft;
    if (remaining <= 0) break;
  }

  return {
    windows,
    units: windows.flatMap((w) => w.units),
    exchanges: total,
    requested: n,
  };
}

/** Seed, then its neighbours, outwards. */
function unitPriority(seed: number, total: number): number[] {
  const out = [seed];
  for (let d = 1; d <= WINDOW_NEIGHBOURS; d++) {
    if (seed - d >= 0) out.push(seed - d);
    if (seed + d < total) out.push(seed + d);
  }
  return out.filter((i) => i >= 0 && i < total);
}

function renderUnitBody(u: TranscriptUnit, maxChars: number): string {
  const rendered = renderUnit(u, maxChars);
  return rendered.slice(rendered.indexOf('\n') + 1);
}

// ------------------------------------------------------------ the render

/**
 * The line a reader sees where the transcript was cut.
 *
 * Exported so the test that guarantees "no silent splice" can look for it
 * rather than for a shape that a later edit could change out from under it.
 */
export const WINDOW_GAP_MARK = '⋯';

/** Upper bound on the preamble {@link windowText} writes above the excerpts. */
export const WINDOW_PREAMBLE_CHARS = 200;

/** Upper bound on one `⋯ n exchanges (seq a–b) not shown ⋯` line, with its join. */
export const WINDOW_GAP_CHARS = 56;

/**
 * What the markers cost, reserved out of the slice before any text is chosen.
 *
 * The alternative — budget the exchanges to the full slice and let the markers
 * push past it — is how the first run of this came in at 8,268 characters
 * against a 8,000-character ceiling. Honesty about a cut is part of the cut,
 * so it is paid for out of the same budget.
 *
 * `windows + 1` gaps: one before the first window, one after the last, and one
 * between each adjacent pair.
 */
export function windowOverhead(windows: number): number {
  return WINDOW_PREAMBLE_CHARS + (Math.max(1, windows) + 1) * WINDOW_GAP_CHARS;
}

/**
 * The excerpt block for a windowed session.
 *
 * **The gap is computed from positions in the transcript, not from the window
 * list.** That is the whole safety argument: if the budget dropped a window's
 * neighbour, or two windows merged, or a future edit reorders anything, the
 * marker still appears wherever two shown exchanges are not adjacent — because
 * the renderer asks the transcript, not the plan.
 *
 * A leading marker is emitted when the first shown exchange is not the first
 * exchange of the session, and a trailing one when the last shown is not the
 * last. A reader that is handed the middle of a conversation must not be able
 * to mistake it for the whole of one.
 */
export function windowText(
  transcript: Transcript,
  units: readonly TranscriptUnit[],
): string {
  if (units.length === 0) return '';
  const at = new Map<number, number>();
  transcript.units.forEach((u, i) => at.set(u.seq, i));
  const total = transcript.units.length;

  // The window count is **counted from the positions the markers use**, never
  // taken from the plan, so the sentence and the marks cannot disagree.
  let runs = 0;
  let last: number | null = null;
  for (const u of units) {
    const i = at.get(u.seq);
    if (i === undefined || last === null || i !== last + 1) runs += 1;
    last = i ?? null;
  }
  const shown = units.length;
  const parts: string[] = [
    `${runs} separated window${runs === 1 ? '' : 's'} from a ${total}-exchange session, ` +
      `chosen by relevance to the question; ${shown} exchange${shown === 1 ? '' : 's'} shown. ` +
      `The stretches marked ${WINDOW_GAP_MARK} are NOT included — do not read across a mark.`,
  ];

  let previous: number | null = null;
  for (const u of units) {
    const i = at.get(u.seq);
    if (i === undefined) {
      // A unit the transcript does not hold cannot have its position checked,
      // so it is fenced rather than trusted.
      parts.push(`${WINDOW_GAP_MARK} position in the transcript unknown ${WINDOW_GAP_MARK}`);
      parts.push(renderUnit(u));
      previous = null;
      continue;
    }
    const from = previous === null ? 0 : previous + 1;
    const missing = i - from;
    if (missing > 0) {
      parts.push(
        gap(
          transcript.units[from]?.seq ?? null,
          transcript.units[i - 1]?.seq ?? null,
          missing,
          previous === null ? 'earlier' : '',
        ),
      );
    }
    parts.push(renderUnit(u));
    previous = i;
  }
  const after = previous === null ? 0 : total - 1 - previous;
  if (after > 0) {
    parts.push(
      gap(
        transcript.units[previous! + 1]?.seq ?? null,
        transcript.units[total - 1]?.seq ?? null,
        after,
        'later',
      ),
    );
  }
  return parts.join('\n\n');
}

function gap(from: number | null, to: number | null, n: number, when = ''): string {
  const where = from !== null && to !== null ? (from === to ? ` (seq ${from})` : ` (seq ${from}–${to})`) : '';
  const many = n === 1 ? 'exchange' : 'exchanges';
  const word = when ? `${when} ` : '';
  const count = n > 0 ? `${n} ${word}${many}` : 'exchanges';
  return `${WINDOW_GAP_MARK} ${count}${where} not shown ${WINDOW_GAP_MARK}`;
}
