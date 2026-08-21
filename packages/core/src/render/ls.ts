import { INDENT, fitLine, table, type TableCellInput } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import type { BrowseSession, ListResult } from '../browse.js';

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
export function renderLs(result: ListResult, t: Theme = new Theme(), now = new Date()): string {
  const lines: string[] = [];

  lines.push(t.dim(headline(result, t, now)));
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

  const header = ['when', 'harness', 'project', 'title', 'status'].map((h) => t.dim(h));
  const rows: TableCellInput[][] = [header, ...result.sessions.map((s) => row(s, t, now))];

  lines.push(
    ...table(t, rows, {
      gap: 2,
      // The title is the column worth every spare character; `status` is five.
      grow: 3,
      max: [11, 7, 15, undefined, 8],
      // Dates are values, and values right-align (plans/05): `7 aug` under
      // `20 aug` reads as a column of days, not as ragged text.
      align: ['right'],
    }),
  );

  lines.push('');
  lines.push(INDENT + t.dim(summary(result, t)));
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

function headline(r: ListResult, t: Theme, now: Date): string {
  const parts = ['potsherd ls'];
  const fl = r.filters;
  if (fl.project) parts.push(shortProject(fl.project));
  if (fl.harness) parts.push(fl.harness);
  // `--since 30d` arrives here as an ISO instant; nobody wants to read
  // `2026-07-22T01:41:08.285Z` in a heading.
  if (fl.since) parts.push(`since ${f.shortDate(fl.since, now)}`);
  if (fl.until) parts.push(`until ${f.shortDate(fl.until, now)}`);
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
  const when = s.endedAt ?? s.startedAt;
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

function statusCell(s: BrowseSession, t: Theme): string {
  // Exactly one accent on the screen, and it is the thing that is gone.
  if (s.status === 'ghost') return t.accent('ghost');
  if (s.status === 'archived') return 'archived';
  return t.dim('live');
}

function summary(r: ListResult, t: Theme): string {
  const parts: string[] = [];
  const top = r.total - r.ghosts - r.sidechains;
  if (top > 0) parts.push(`${f.num(top)} ${f.plural(top, 'session')}`);
  if (r.sidechains > 0) parts.push(`${f.num(r.sidechains)} sidechains`);
  if (r.rolledUp > 0) parts.push(`${f.num(r.rolledUp)} subagents inside them`);
  if (r.ghosts > 0) parts.push(`${f.num(r.ghosts)} ${f.plural(r.ghosts, 'ghost')}, prompts only`);
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
