import { INDENT, fitLine, table, type TableCellInput } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { sessionDate } from '../threads.js';
import type { BrowseSession, ListResult } from '../browse.js';

/**
 * The words the user actually typed for `--since` / `--until`.
 *
 * VERIFICATION-6 C-2: the heading is a **receipt of the reader's own input**,
 * and the only thing that can be quoted back with no chance of drift is the
 * input. The bound the CLI parsed out of it is an instant in a frame the
 * instant does not carry — `2026-08-15` is read in UTC, `today` in local time
 * (`search/when.ts`) — so re-rendering the instant was a second computation of
 * a fact that was already in hand, and it disagreed with the first one
 * everywhere except UTC.
 *
 * Empty for a caller with nothing to quote; then the heading says nothing
 * about dates rather than guessing at them. `--json` still carries the
 * resolved instants, and always did: it was never the surface that was wrong.
 */
export interface FilterEcho {
  since?: string | undefined;
  until?: string | undefined;
}

/**
 * `potsherd ls` — moment 3 of plans/05: "the archive, finally legible".
 *
 * This is the before/after screenshot: `ls ~/.claude/projects` is 300 lines of
 * uuid, and this is the same data with titles. So the rules are stricter here
 * than anywhere except the audit card:
 *
 *   - **titles, never uuids.** A session the harness never named gets
 *     `<project>-<id8>`, which still says *what* it was.
 *   - **one table, never wrapped.** The title column absorbs every spare
 *     character and elides with `…`; nothing else moves.
 *   - **ghosts sit in the list, not under it.** A deleted session is a row like
 *     any other, marked `ghost`, because the whole claim of the product is that
 *     they are still yours. They carry the one accent colour on screen.
 *   - **it has to make sense with no caption.** Hence the column header, the
 *     one-line summary underneath, and the next verb as the last line.
 */
export function renderLs(
  result: ListResult,
  t: Theme = new Theme(),
  now = new Date(),
  echo: FilterEcho = {},
): string {
  const lines: string[] = [];

  lines.push(t.dim(headline(result, t, echo)));
  lines.push('');

  if (result.sessions.length === 0) {
    lines.push(INDENT + 'nothing matches those filters.');
    lines.push('');
    lines.push(
      fitLine(
        t,
        `${t.dim('run')}  potsherd ls  ${t.dim('for everything potsherd has indexed.')}`,
        `${t.dim('run')}  potsherd ls`,
      ),
    );
    return lines.join('\n');
  }

  // `last active`, not `when` — VERIFICATION-6 C-6. The column is
  // {@link sessionDate}, the *end* of the session's interval, and `--since` /
  // `--until` are an interval **overlap** (`search/filters.ts`), so
  // `ls --until 15 aug` legitimately lists a row whose date is the 19th. Both
  // halves are right and the bare word `when` made them read as a broken
  // filter. Eleven characters, which is exactly the width the column already
  // had for `21 aug 2025`, so nothing else on the line moves.
  const header = ['last active', 'harness', 'project', 'title', 'status'].map((h) => t.dim(h));
  const rows: TableCellInput[][] = [header, ...result.sessions.map((s) => row(s, t, now))];

  lines.push(
    ...table(t, rows, {
      gap: 2,
      // The title is the column worth every spare character; `status` is five
      // — or twelve, on a listing that contains a carded ghost. `table()`
      // sizes a column to its content, so the extra four characters are taken
      // from the title only on the listings that have something to say with
      // them.
      grow: 3,
      max: [11, 7, 15, undefined, 12],
      // Dates are values, and values right-align (plans/05): `7 aug` under
      // `20 aug` reads as a column of days, not as ragged text.
      align: ['right'],
    }),
  );

  lines.push('');
  lines.push(INDENT + t.dim(summary(result, t)));
  // Its own line, not a fourth item in the summary's joinFit, because the
  // summary elides and this is the one line on the screen the user cannot be
  // allowed to miss: it is the difference between "this is my archive" and
  // "this is my archive minus what I told potsherd to skip". `05` gives every
  // line the command that acts on it, and here that command is the way back.
  for (const line of ignoreNote(result, t)) lines.push(line);
  lines.push(
    fitLine(
      t,
      `${t.dim('run')}  potsherd show <id8>  ${t.dim('to read one, or  potsherd find <words>')}`,
      `${t.dim('run')}  potsherd show <id8>  ${t.dim('to read one')}`,
      `${t.dim('run')}  potsherd show <id8>`,
    ),
  );
  return lines.join('\n');
}

function headline(r: ListResult, t: Theme, echo: FilterEcho): string {
  const parts = ['potsherd ls'];
  const fl = r.filters;
  if (fl.project) parts.push(shortProject(fl.project));
  if (fl.harness) parts.push(fl.harness);
  // The phrase, not the instant — see {@link FilterEcho}. `30d`, `last week`
  // and `2026-08-15` are all quoted exactly as typed, so this line is the same
  // line in every zone on earth, and nobody has to read
  // `2026-07-22T01:41:08.285Z` in a heading either.
  if (fl.since) parts.push(`since ${echo.since ?? fl.since}`);
  if (fl.until) parts.push(`until ${echo.until ?? fl.until}`);
  if (fl.branch) parts.push(fl.branch);
  if (fl.tag) parts.push(`#${fl.tag}`);
  if (fl.pinned) parts.push('pinned');
  // The eight characters the rest of the tool prints for a session, not the
  // uuid: the heading is read, not copied.
  if (fl.linkedTo) parts.push(`linked to ${fl.linkedTo.slice(0, 8)}`);
  if (fl.untitled) parts.push('untitled');
  if (fl.status) parts.push(fl.status);
  parts.push(
    r.total === r.sessions.length
      ? `${f.num(r.total)} ${f.plural(r.total, 'session')}`
      : `${f.num(r.sessions.length)} of ${f.num(r.total)}`,
  );
  return f.clip(parts.join(` ${t.sep} `), t.width);
}

function shortProject(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * The markers. A sidechain is a subagent's own transcript, which every other
 * tool hides; a pin is the user's own. Both are one glyph in front of the
 * title, so they cost the table no column.
 */
export function marker(s: BrowseSession, t: Theme): string {
  if (s.pinned) return `${t.star} `;
  if (s.isSidechain) return `${t.g('↳', '>')} `;
  return '';
}

/**
 * The user's own tags, after the title and inside the title column.
 *
 * Not a column of their own: most sessions have none, and a column that is
 * empty on fourteen rows out of fifteen is a column that costs the title
 * fourteen characters for nothing. `#postgres` is legible with no legend and
 * survives `--ascii` unchanged.
 *
 * Deliberately uncoloured. `table()` elides a cell that overruns its column
 * using character arithmetic, so an ANSI escape inside a cell that might be
 * cut is an escape that can be cut in half — and a half-written escape colours
 * the rest of the screenshot.
 */
function tagCell(s: BrowseSession): string {
  return s.tags.length > 0 ? '  ' + s.tags.map((tag) => `#${tag}`).join(' ') : '';
}

function row(s: BrowseSession, t: Theme, now: Date): TableCellInput[] {
  // {@link sessionDate}, not a copy of it. `threads.ts` calls itself "the
  // promoted function" and `graft` has read it since F4; this file and
  // `render/find.ts` each kept a spelling of the answer instead, and the two
  // spellings were opposite ends of the interval (VERIFICATION-6 C-6).
  const when = sessionDate(s);
  // `↳12` after the title, not a column: a session that spawned twelve
  // subagents is still one conversation, and the twelve are one flag away.
  const kids = s.subagents > 0 ? `  ${t.g('↳', '>')}${f.num(s.subagents)}` : '';
  return [
    when ? f.shortDate(when, now) : '—',
    s.harness,
    s.projectName,
    // `keep`: the title gives ground before the tags do. See `TableCell`.
    { text: marker(s, t) + s.displayTitle + kids, keep: tagCell(s) },
    statusCell(s, t),
  ];
}

/**
 * The status column, and the one place `ls` says a title is only half sourced.
 *
 * A carded ghost is the row that needs it. Its title is no longer the first
 * prompt truncated — it is a card title, written by a model, indistinguishable
 * on the page from the title of a session whose whole transcript survived. So
 * the row says `prompts-only` where an uncarded ghost says `ghost`: the same
 * accent, the same column, four more characters, and no reader has to know
 * that "ghost" implies the assistant's side is missing.
 */
function statusCell(s: BrowseSession, t: Theme): string {
  // Exactly one accent on the screen, and it is the thing that is gone.
  if (s.status === 'ghost') {
    return t.accent(s.cardSource === 'prompts-only' ? 'prompts-only' : 'ghost');
  }
  if (s.status === 'archived') return 'archived';
  return t.dim('live');
}

/**
 * "hiding 41 rows in 2 ignored projects · potsherd ls --all".
 *
 * Counts, never names. The projects are directory paths off the user's own
 * machine and this line is on the one screen `05` asks people to screenshot;
 * `potsherd doctor` and `--json` are where the names belong.
 */
function ignoreNote(r: ListResult, t: Theme): string[] {
  const n = r.ignored.hidden;
  if (n <= 0) return [];
  const p = r.ignored.projects.length;
  const what = `hiding ${f.num(n)} ${f.plural(n, 'row')} in ${f.num(p)} ignored ${f.plural(p, 'project')}`;
  const wide = `${INDENT}${t.dim(what)}  ${t.dim(t.sep)}  ${t.dim('potsherd ls --all')}`;
  const narrow = `${INDENT}${t.dim(what)}  ${t.dim(t.sep)} ${t.dim('--all')}`;
  return [Theme.len(wide) <= t.width ? wide : narrow];
}

/**
 * The one-line summary under the table — and the line VERIFICATION-5 C-3 is
 * about.
 *
 * ## the defect
 *
 * On the demo corpus this line said `1 session · 197 subagents inside them ·
 * 299 ghosts, prompts only` while `doctor` said `sessions on disk 31` and
 * `stats` said `sessions 31`, from the same index and the same capture run —
 * and all three are committed screenshots. Three verbs, three numbers, no way
 * to reconcile them on the page.
 *
 * The counts were not wrong. `--json` carries `threaded: 30`: thirty of the
 * thirty-one are earlier links of one fork/resume chain, folded into the head's
 * row, which is F4 working exactly as designed. What was wrong is that this
 * line **accounted for the 197 rolled-up subagents on the same line and said
 * nothing at all about the 30 folded siblings**, and then called the remainder
 * "sessions". A listing that quietly drops rows is lying about the archive —
 * which is the reason `ListResult.threaded` is counted in the first place, and
 * it was counted and then not printed.
 *
 * ## the shape
 *
 * `1 of 31 sessions`, and not a fourth item on the line. Three reasons:
 *
 *   - **It is the reconciliation.** `31` is the number the other two verbs
 *     print, sitting beside the number this one prints, so a reader closes the
 *     question on the screen rather than in `--json`.
 *   - **It cannot be elided.** {@link f.joinFit} drops items from the tail, so
 *     a fourth item at this width would have pushed `299 ghosts, prompts only`
 *     off `16-before-after.txt` (captured at `--width 76`, where the budget is
 *     74 and the existing three items already spend 64). Folding the fact into
 *     the first item costs seven characters and drops nothing.
 *   - **It is the idiom already on the screen.** The heading says `15 of 300`
 *     for rows; this says `1 of 31` for sessions. Same shape, one subject each.
 *
 * When nothing is threaded — every archive with no fork/resume chain in scope —
 * `threaded` is 0 and the line is exactly what it was.
 *
 * What it still does not say is *why* the other thirty are not rows. That is
 * `potsherd show <id8>`, which names the rest of the chain, and it is the verb
 * the last line of this screen already points at.
 */
function summary(r: ListResult, t: Theme): string {
  const parts: string[] = [];
  const top = r.total - r.ghosts - r.sidechains;
  if (top > 0) {
    const onDisk = top + r.threaded;
    parts.push(
      r.threaded > 0
        ? `${f.num(top)} of ${f.num(onDisk)} ${f.plural(onDisk, 'session')}`
        : `${f.num(top)} ${f.plural(top, 'session')}`,
    );
  }
  if (r.sidechains > 0) parts.push(`${f.num(r.sidechains)} sidechains`);
  if (r.rolledUp > 0) parts.push(`${f.num(r.rolledUp)} subagents inside them`);
  if (r.ghosts > 0) parts.push(`${f.num(r.ghosts)} ${f.plural(r.ghosts, 'ghost')}, prompts only`);
  const carded = r.sessions.filter((s) => s.cardSource === 'prompts-only').length;
  if (carded > 0) parts.push(`${f.num(carded)} carded from prompts alone`);
  return f.joinFit(parts, t.width - INDENT.length, ` ${t.sep} `, t.ellip);
}

// ------------------------------------------------------------- resume menu

/**
 * `potsherd ls --resume-menu` — T2.5, and the one place potsherd hands a title
 * back to the harness that lost it.
 *
 * The rejected design was `card --write-titles`, which would have written
 * potsherd's titles into `~/.claude`'s own files. potsherd does not write into
 * another tool's directory: those five directories are read-only inputs, a
 * user who uninstalls potsherd must get their machine back exactly as it was,
 * and a memory tool that edits the thing it is remembering has stopped being a
 * record of it. So the titles come out here instead, as shell.
 *
 * **Every line is valid shell.** Comments start with `#`, everything else is a
 * runnable command, so the whole block can be pasted into a terminal and only
 * the line you want does anything. That is the acceptance test for this verb,
 * and it is why the title moves to its own comment line at narrow widths
 * rather than being squeezed to four characters: a resume command may never be
 * elided, because half a uuid is a command that fails.
 */
export function renderResumeMenu(result: ListResult, t: Theme = new Theme(), now = new Date()): string {
  const lines: string[] = [];
  const resumable = result.sessions.filter((s) => s.resume);
  const stranded = result.sessions.length - resumable.length;

  lines.push(
    comment(
      t,
      `potsherd ls --resume-menu ${t.sep} ${f.num(resumable.length)} of ${f.num(result.total)} ${f.plural(result.total, 'session')} ${t.sep} ${f.date(now)}`,
      `potsherd ls --resume-menu ${t.sep} ${f.num(resumable.length)} resumable`,
    ),
  );
  lines.push(
    comment(
      t,
      'titles are potsherd\'s: it does not write into another tool\'s directory.',
      'potsherd never writes into ~/.claude.',
    ),
  );

  if (resumable.length === 0) {
    lines.push(
      comment(t, 'nothing here can be resumed — a deleted transcript has nothing to reopen.'),
    );
    lines.push(comment(t, 'run  potsherd show <id8>  to read one anyway'));
    return lines.join('\n');
  }

  for (const s of resumable) {
    const command = s.resume!;
    const title = titleFor(s, t);
    // Two spaces, `#`, one space — the gap that makes the comment read as a
    // note on the command rather than part of it.
    const budget = t.width - command.length - 4;
    if (budget >= 12) {
      lines.push(`${command}  ${t.dim(`# ${f.elide(title, budget, t)}`)}`);
    } else {
      // At 60 columns a 36-character uuid leaves no room for a title beside it.
      // The title goes above rather than being cut to nothing.
      lines.push(comment(t, title));
      lines.push(command);
    }
  }

  if (stranded > 0) {
    lines.push(
      comment(
        t,
        `${f.num(stranded)} more ${f.plural(stranded, 'session has', 'sessions have')} no transcript to reopen (ghosts, subagents).`,
        `${f.num(stranded)} more cannot be resumed.`,
      ),
    );
  }
  lines.push(comment(t, 'run  potsherd show <id8>  to read one instead of resuming it'));
  return lines.join('\n');
}

/** The title as `ls` would show it, pins and markers stripped: this is shell. */
function titleFor(s: BrowseSession, t: Theme): string {
  const kids = s.subagents > 0 ? ` ${t.g('↳', '>')}${f.num(s.subagents)}` : '';
  const tags = s.tags.length > 0 ? ' ' + s.tags.map((tag) => `#${tag}`).join(' ') : '';
  return (s.pinned ? `${t.star} ` : '') + s.displayTitle + kids + tags;
}

/**
 * A `#` comment that fits the terminal. Longest variant first, same rule as
 * {@link fitLine}: the phrasing gives ground, never the meaning.
 */
function comment(t: Theme, ...variants: string[]): string {
  for (const v of variants) {
    if (Theme.len(v) + 2 <= t.width) return t.dim(`# ${v}`);
  }
  const last = variants[variants.length - 1] ?? '';
  return t.dim(`# ${f.clip(last, Math.max(4, t.width - 2), t)}`);
}
