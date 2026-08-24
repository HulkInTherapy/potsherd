/**
 * T6.6 — `potsherd link --suggest`: propose cross-project links from card
 * topic/file overlap, **for the user to accept**.
 *
 * `plans/phases/phase-6-ecosystem.md` deliverable 4 says *rule-based from
 * phase 4 T4.2*, and that is meant literally: this file computes nothing. The
 * overlap engine is {@link openThreadCandidates} in `open-threads.ts`, which
 * phase 4 built, measured and documented, and which is imported here and not
 * reimplemented. A second overlap engine with a second set of thresholds would
 * be two answers to one question, drifting apart from the day it landed.
 *
 * ## The number this feature has to say out loud
 *
 * Phase 4 measured its own rule pass at n = 8 and reported the result
 * honestly: 8 of 8 genuinely absent from the other project, 1–2 of the 8 worth
 * raising. **T10.13 re-measured it at n = 109** over 46 cards and 15 projects,
 * every candidate judged one at a time, and the shape held while one half of
 * it got worse: **99 of 108 genuinely absent (91.7%, one undecided) and 18 of
 * 100 worth raising**. The rule pass is *mostly correct* and *mostly not
 * useful*. That is the same pass this feature stands on.
 *
 * The figure this file carries and prints is {@link MEASURED_PRECISION}, and
 * it is now **this verb's own** re-measurement rather than the open-thread
 * one, because `link --suggest` asks a weaker question and gets a better
 * answer: at the shipped {@link DEFAULT_LIMIT} it raised 5 of 20 considered
 * and **all 5 were worth accepting** — but all 5 were the *same project
 * relationship*, because {@link suggestLinks} de-duplicates on the session
 * pair and not the project pair. Over 18 rows the figure is 12 accepted across
 * only 6 distinct relationships. Both numbers are in
 * `phases/phase-10/T10.13-REPORT.md` §5; the disclosure below prints the
 * cautious one and the caveat, never the flattering one alone.
 *
 * For `ask`'s open threads, phase 4 handled that with a model pass that drops
 * unconfirmed candidates. This verb deliberately does **not** take that route,
 * for two reasons:
 *
 *   1. A link is a proposal the user accepts, not a claim the tool makes. The
 *      cost of a bad suggestion is one glance, not a false statement in an
 *      answer. A low-precision suggester is tolerable here **if it says so**.
 *   2. `--suggest` should be instant and offline. A haiku-class call through
 *      the agent SDK is 60–160 s (`llm.ts` `CALL_PROFILES`), which is the
 *      wrong shape for "show me some candidates".
 *
 * So the honesty is paid in the output instead: {@link SuggestResult.precision}
 * carries the measured figure to the renderer, which must print it. A
 * suggester that shows eight rows and implies eight good ones is worse than no
 * suggester, because it spends the user's attention at a rate it did not
 * disclose.
 *
 * ## What this file will not do
 *
 * **It never writes a link.** `linkSessions` is not imported. The result is
 * data plus the exact command that would create each link, and the user types
 * it. `00-README.md` gives every write a consent gate, and a suggester that
 * quietly acted on a 1-in-4 rule pass would be the worst place in the product
 * to skip one.
 */
import { openThreadCandidates, type OpenThreadCandidate } from './open-threads.js';
import type { Db } from './db.js';

/**
 * The measured precision of this verb, from T10.13's re-measurement: over 18
 * suggestions raised from 46 cards, 18 named a pair that was really two
 * different projects, and 12 of the 18 were worth accepting.
 *
 * Was phase 4's 8 raised / 8 absent / 1–2 worth, which was the **open-thread**
 * rule pass measured at n = 8. Two things made that the wrong figure to print
 * here. It was replaced rather than adjusted, and the replacement is this
 * verb's own.
 *
 *   - **n = 8 is an anecdote with a fraction in front of it.** T10.13 judged
 *     109 open-thread candidates and 18 link suggestions one at a time, and
 *     the open-thread absence figure fell from 8/8 to 99/108.
 *   - **A link is not an open thread.** This verb asks *are these two sessions
 *     worth connecting*, which survives a bad decision text as long as the
 *     pair is right; open threads assert an absence, which does not. Printing
 *     the open-thread number here understated a verb that measures better.
 *
 * The caveat in {@link Precision.note} is not decoration. At
 * {@link DEFAULT_LIMIT} the measured run raised 5 of 20 considered and all 5
 * were worth accepting — and all 5 were the **same project relationship**,
 * because {@link suggestLinks} de-duplicates on the session pair rather than
 * the project pair. A user who accepts the whole screen gets five links into
 * one relationship. The 12-of-18 figure printed here is the cautious one.
 *
 * Carried as a value rather than a comment so the renderer prints it and
 * `tests/stack.test.ts` asserts it reached the output. It is a **measurement
 * on one corpus**, not a guarantee, and {@link Precision.note} says so.
 */
export interface Precision {
  /** How many suggestions the measured run raised. */
  raised: number;
  /** How many named a pair that really was two different projects. */
  absent: number;
  /** How many were judged worth accepting, as a low–high range. */
  worthLow: number;
  worthHigh: number;
  note: string;
}

export const MEASURED_PRECISION: Precision = {
  raised: 18,
  absent: 18,
  worthLow: 12,
  worthHigh: 12,
  note:
    'measured in phase 10 (T10.13) over 46 cards and 15 projects, on this verb. ' +
    'expect a screenful to cover fewer relationships than rows.',
};

/** One proposed link, with everything the user needs to judge it in one line. */
export interface LinkSuggestion {
  /** The session the overlap was raised from. */
  a: string;
  a8: string;
  aProject: string;
  aTs: string;
  /** The session on the other end, in a different project. */
  b: string;
  b8: string;
  bProject: string;
  /** What the two have in common. The whole reason to look. */
  overlap: { files: readonly string[]; topics: readonly string[] };
  /** The decision in A that the overlap hangs on, verbatim from its card. */
  what: string;
  /** The rule pass's own ordering. Higher is more overlap. */
  score: number;
  /** The command that would create this link. Never run here. */
  command: string;
}

export interface SuggestResult {
  suggestions: LinkSuggestion[];
  /** Always {@link MEASURED_PRECISION}. The renderer must print it. */
  precision: Precision;
  /** How many candidates the rule pass raised before already-linked pairs were dropped. */
  considered: number;
  /** How many were dropped because that pair is already linked. */
  alreadyLinked: number;
  /** How many cards the rule pass had to work with. Zero explains an empty result. */
  cards: number;
}

export interface SuggestOptions {
  /**
   * How many suggestions to return. Default 5, not 8.
   *
   * Chosen when the measured rate was 1–2 worth having in 8. T10.13 measured
   * this verb at 12 of 18 worth accepting, which would argue for a bigger
   * screen — except that the same measurement found the 18 rows covered only 6
   * project relationships and the first 5 covered **one**. Raising the default
   * would spend the extra rows on the relationship the user already has.
   * Unchanged, and the reason is now the measured one.
   */
  limit?: number;
  /**
   * Only raise from these sessions. Default: every carded session in the
   * index, which is what a bare `link --suggest` means.
   */
  sessionIds?: readonly string[];
}

export const DEFAULT_LIMIT = 5;

/**
 * Propose links. Rule-based, offline, and it writes nothing.
 *
 * Each candidate from the phase-4 pass names one project B and a list of B's
 * sessions that share the files or topics. A *link* is between two sessions,
 * so the highest-signal member of that list is chosen — the first, which
 * {@link openThreadCandidates} orders — and the rest are dropped rather than
 * fanned out into one suggestion per session. Fanning out would turn a single
 * weak signal into five rows and make the screen look five times as
 * informative as it is.
 *
 * Pairs that are **already linked** are dropped, in either direction, using
 * the same both-orders predicate `linkSessions` writes against. Suggesting a
 * link the user already made is the fastest way to teach them the feature is
 * noise.
 */
export function suggestLinks(db: Db, o: SuggestOptions = {}): SuggestResult {
  const limit = Math.max(0, o.limit ?? DEFAULT_LIMIT);
  const cards = countCards(db);

  if (limit === 0 || cards === 0) {
    return {
      suggestions: [],
      precision: MEASURED_PRECISION,
      considered: 0,
      alreadyLinked: 0,
      cards,
    };
  }

  const ids = o.sessionIds ?? cardedSessionIds(db);
  if (ids.length === 0) {
    return { suggestions: [], precision: MEASURED_PRECISION, considered: 0, alreadyLinked: 0, cards };
  }

  // Ask for more than `limit`, because already-linked pairs are dropped after
  // the fact and a user who has accepted three suggestions should still see a
  // full screen on the fourth run. Capped so a huge archive cannot turn a
  // "show me some candidates" into a long synchronous scan.
  const candidates = openThreadCandidates(db, ids, { limit: Math.min(limit * 4, 40) });

  // The same both-orders predicate `linkSessions` uses to decide whether a
  // pair is already stored. Written out rather than borrowed from
  // `LINKED_TO_SQL`, which builds a fragment for filtering *sessions* by a
  // link and takes its parameters in the other shape.
  const linked = db.prepare(
    `SELECT 1 FROM links
       WHERE (a_session_id = ? AND b_session_id = ?)
          OR (a_session_id = ? AND b_session_id = ?) LIMIT 1`,
  );

  const suggestions: LinkSuggestion[] = [];
  let alreadyLinked = 0;
  const seen = new Set<string>();

  for (const c of candidates) {
    const b = c.otherSessionIds[0];
    if (!b) continue;

    // One row per pair, whichever order it was raised in.
    const key = c.sessionId < b ? `${c.sessionId}|${b}` : `${b}|${c.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (isLinked(linked, c.sessionId, b)) {
      alreadyLinked++;
      continue;
    }

    suggestions.push(toSuggestion(c, b));
    if (suggestions.length >= limit) break;
  }

  return {
    suggestions,
    precision: MEASURED_PRECISION,
    considered: candidates.length,
    alreadyLinked,
    cards,
  };
}

function toSuggestion(c: OpenThreadCandidate, b: string): LinkSuggestion {
  const b8 = b.slice(0, 8);
  return {
    a: c.sessionId,
    a8: c.id8,
    aProject: c.project,
    aTs: c.ts,
    b,
    b8,
    bProject: c.otherProject,
    overlap: { files: c.overlap.files, topics: c.overlap.topics },
    what: c.what,
    score: c.score,
    command: `potsherd link ${c.id8} ${b8}`,
  };
}

/** `(a,b)` or `(b,a)`: a link is undirected in meaning, directed in storage. */
function isLinked(stmt: { get(...p: unknown[]): unknown }, a: string, b: string): boolean {
  return stmt.get(a, b, b, a) !== undefined;
}

/** How many cards the rule pass can see. A zero here is the whole explanation. */
function countCards(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Every session with a card, newest first: the default set to raise from. */
function cardedSessionIds(db: Db): string[] {
  const rows = db
    .prepare('SELECT session_id FROM cards ORDER BY rowid DESC')
    .all() as { session_id: string }[];
  return rows.map((r) => r.session_id);
}

// -------------------------------------------------------------------- render

/**
 * The human view, as lines, for `potsherd link --suggest`.
 *
 * It lives in core beside the rule rather than in `commands/link.ts` for one
 * reason: the measured-precision disclosure is not a piece of formatting, it
 * is the condition on which this feature is allowed to exist. Keeping it in
 * the same file as {@link MEASURED_PRECISION} means the integrator's change to
 * `link.ts` is an import and a branch, and there is no version of wiring this
 * up that quietly leaves the disclosure out.
 *
 * `05`: 80 columns, degrades to 60, no emoji, and the last line is the next
 * verb — which here is `show`, not `link`. The user should read one before
 * accepting it, and the output says so.
 */
export function renderSuggestions(
  r: SuggestResult,
  t: {
    width: number;
    sep: string;
    arrow: string;
    dim(s: string): string;
    bold(s: string): string;
    warn(s: string): string;
    accent(s: string): string;
  },
  wrap: (s: string, width: number) => string[],
): string[] {
  const L: string[] = [];
  const p = r.precision;
  const worth = p.worthLow === p.worthHigh ? `${p.worthLow}` : `${p.worthLow}-${p.worthHigh}`;

  L.push('');
  L.push(
    `potsherd link --suggest ${t.sep} ${r.suggestions.length} of ${r.considered} ` +
      `candidates ${t.sep} ${r.cards} cards`,
  );
  L.push('');

  if (r.cards === 0) {
    L.push('  no cards in the index, so there is nothing to compare.');
    L.push('');
    L.push(`  ${t.dim('run')}  ${t.bold('potsherd card')}   ${t.dim('build cards, then ask again')}`);
    L.push('');
    return L;
  }

  if (r.suggestions.length === 0) {
    L.push('  nothing to propose. no decision in one project overlapped another');
    L.push('  project closely enough to be worth your attention.');
    if (r.alreadyLinked > 0) {
      L.push('');
      L.push(t.dim(`  ${r.alreadyLinked} candidate(s) were pairs you have already linked.`));
    }
    L.push('');
    L.push(`  ${t.dim('run')}  ${t.bold('potsherd ask')}   ${t.dim('the same overlap, as an answer')}`);
    L.push('');
    return L;
  }

  for (const l of wrap('proposals. nothing was written; you accept each one by hand.', t.width - 4)) {
    L.push(t.dim(`  ${l}`));
  }
  L.push('');

  let n = 0;
  for (const s of r.suggestions) {
    n++;
    // The header is the one line that cannot wrap — an id and a project on
    // each side of an arrow — so the two project names share whatever the
    // terminal has left after the fixed parts, and each takes half.
    const fixed = 3 + 8 + 2 + 4 + 2 + 8 + 2 + 2; // indent, ids, arrow, gaps
    const proj = Math.max(8, Math.floor((t.width - fixed) / 2));
    L.push(
      `  ${n}  ${s.a8}  ${clip(s.aProject, proj)}  ${t.arrow}  ${s.b8}  ${clip(s.bProject, proj)}`,
    );
    const shares = [...s.overlap.files, ...s.overlap.topics].slice(0, 4).join(` ${t.sep} `);
    if (shares) L.push(...field('shares', shares, t, wrap));
    // (`field` wraps at the terminal width; nothing below this line is fixed.)
    L.push(...field('from', `"${s.what}"`, t, wrap));
    L.push(`     ${t.dim('accept  ')}${s.command}`);
    L.push('');
  }

  // The disclosure. Not a footnote and not behind a flag: at the measured rate
  // a full screen of these holds one or two the user wants, and a suggester
  // that does not say so is spending attention it did not ask for.
  const measured =
    `measured: on the reference corpus this verb raised ${p.raised} suggestions. ` +
    `${p.absent} of ${p.raised} named a pair that really was two different projects, and ` +
    `${worth} of ${p.raised} were worth accepting. a screenful covers fewer ` +
    `relationships than it has rows, so expect repeats of the strongest pair.`;
  for (const l of wrap(measured, t.width - 4)) L.push(t.warn(`  ${l}`));
  L.push('');
  L.push(`  ${t.dim('run')}  ${t.bold('potsherd show <id8>')}   ${t.dim('read one before you accept it')}`);
  L.push('');
  return L;
}

/**
 * `shares  a · b · c` with continuation lines hanging under the value.
 *
 * The label is printed once. Repeating `from` down the left of a wrapped
 * quotation reads as four separate quotations, which is what the first run of
 * this renderer did.
 */
function field(
  label: string,
  value: string,
  t: { width: number; dim(s: string): string },
  wrap: (s: string, width: number) => string[],
): string[] {
  const w = 8;
  const lines = wrap(value, Math.max(24, t.width - 5 - w));
  return lines.map(
    (l, i) => `     ${t.dim(i === 0 ? label.padEnd(w) : ' '.repeat(w))}${l}`,
  );
}

/**
 * Keep the **tail** of a project path, not the head.
 *
 * A project is identified by its last path segment; clipping from the right
 * turns two sibling checkouts whose names differ only in the last few
 * characters into two strings that look identical and name different things.
 */
function clip(s: string, max: number): string {
  return s.length <= max ? s : '…' + s.slice(s.length - (max - 1));
}
