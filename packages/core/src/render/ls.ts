import { INDENT, fitLine, table } from '../render.js';
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
  const rows = [header, ...result.sessions.map((s) => row(s, t, now))];

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
  if (fl.pinned) parts.push('pinned');
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

function row(s: BrowseSession, t: Theme, now: Date): string[] {
  const when = s.endedAt ?? s.startedAt;
  // `↳12` after the title, not a column: a session that spawned twelve
  // subagents is still one conversation, and the twelve are one flag away.
  const kids = s.subagents > 0 ? `  ${t.g('↳', '>')}${f.num(s.subagents)}` : '';
  const title = marker(s, t) + s.displayTitle + kids;
  return [
    when ? f.shortDate(when, now) : '—',
    s.harness,
    s.projectName,
    title,
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
  if (r.ghosts > 0) parts.push(`${f.num(r.ghosts)} ghosts, prompts only`);
  return f.joinFit(parts, t.width - INDENT.length, ` ${t.sep} `, t.ellip);
}
