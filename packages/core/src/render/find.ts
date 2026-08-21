import { INDENT } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { idTag } from '../recall.js';
import type { RecallHit, RecallResult, RecallSession } from '../recall.js';

/**
 * `potsherd find` — one block per session, exactly as `03` §7 specifies it:
 * title (or `<slug>-<id8>`), harness, project, date, status, sidechain marker,
 * the best matching snippet with the match highlighted, the score, and **the
 * resume command for that harness**.
 *
 * The resume command is the point of the whole verb. Every other search tool
 * ends at "here is a match"; this one ends at `claude --resume 85ef9531-…`,
 * which is the difference between finding a conversation and re-entering it.
 * Where a session cannot be resumed — archived, ghost, or a harness with no
 * command-line resume — the block says so and offers `potsherd show` instead,
 * because printing a command that would fail is worse than printing none.
 *
 * Ghost blocks carry the honesty line from plans/05: *the assistant side of
 * deleted sessions is not recoverable*. The tool states its limitation on the
 * screen where the limitation bites.
 */
export function renderFind(
  result: RecallResult,
  t: Theme = new Theme(),
  now = new Date(),
): string {
  const lines: string[] = [];
  lines.push(t.dim(headline(result, t)));
  lines.push('');

  if (result.sessions.length === 0) {
    lines.push(INDENT + `nothing in the index matches ${JSON.stringify(result.query)}.`);
    lines.push('');
    if (!result.vectors.available && result.vectors.reason) {
      lines.push(INDENT + t.dim(f.clip(`text search only — ${result.vectors.reason}`, t.width - 2)));
    }
    lines.push(
      INDENT +
        t.dim('run') +
        '  potsherd ls  ' +
        t.dim('to see what is indexed, or  potsherd index  to add more'),
    );
    return lines.join('\n');
  }

  result.sessions.forEach((s, i) => {
    if (i > 0) lines.push('');
    lines.push(...block(s, result, t, now));
  });

  lines.push('');
  lines.push(INDENT + t.dim(footer(result, t)));
  return lines.join('\n');
}

function headline(r: RecallResult, t: Theme): string {
  const parts = [`potsherd find ${JSON.stringify(r.query)}`];
  parts.push(
    r.sessions.length === 0
      ? 'no match'
      : `${f.num(r.sessions.length)} ${f.plural(r.sessions.length, 'session')}`,
  );
  parts.push(r.vectors.used ? 'bm25 + vectors' : 'bm25');
  parts.push(f.duration(r.ms));
  return f.clip(parts.join(` ${t.sep} `), t.width);
}

function block(s: RecallSession, r: RecallResult, t: Theme, now: Date): string[] {
  const lines: string[] = [];
  const width = t.width - INDENT.length;

  // line 1 — the name, and what kind of thing it is.
  const right = [s.harness, statusWord(s)].join(` ${t.sep} `);
  const titleRoom = Math.max(12, width - right.length - 2);
  const title = markerFor(s, t) + f.elide(s.displayTitle, titleRoom - markerLen(s));
  lines.push(
    INDENT +
      title +
      ' '.repeat(Math.max(1, width - Theme.len(title) - right.length)) +
      tone(right, s, t),
  );

  // line 2 — where and when, and the score.
  const meta: string[] = [s.projectName];
  const when = s.startedAt ?? s.endedAt;
  if (when) meta.push(f.shortDate(when, now));
  meta.push(
    s.kind === 'ghost'
      ? `${f.num(s.prompts)} prompts recovered`
      : `${f.num(s.exchanges)} ${f.plural(s.exchanges, 'exchange')}`,
  );
  if (s.gitBranch) meta.push(s.gitBranch);
  if (s.agentName) meta.push(s.agentName);
  const score = s.score.toFixed(4);
  const metaLine = f.clip(meta.join(` ${t.sep} `), Math.max(10, width - score.length - 2));
  lines.push(
    INDENT +
      t.dim(metaLine) +
      ' '.repeat(Math.max(1, width - metaLine.length - score.length)) +
      t.dim(score),
  );

  // line 3+ — the snippets, with the match picked out. A `title` hit has no
  // body behind it and its text is the heading two lines up, so it is evidence
  // for the ranking but never a snippet: printing it would repeat the title
  // back at the reader in the space meant for what the session actually said.
  const quotable = s.hits.filter((h) => h.kind !== 'title');
  for (const hit of quotable.slice(0, 2)) {
    const rendered = snippetLine(hit, t, width - 2);
    if (rendered) lines.push(INDENT + '  ' + rendered);
  }
  if (quotable.length === 0 && s.hits.length > 0) {
    lines.push(INDENT + '  ' + t.dim('the session title matched; the body does not use those words'));
  }

  // last line — the one command that puts them back inside it.
  lines.push(INDENT + '  ' + t.dim(action(s, t, width - 2)));
  void r;
  return lines;
}

/**
 * The snippet, one line, with the matched span in the accent colour.
 *
 * The window is cut in `search/snippet.ts` (200 characters centred on the
 * match); this only has to fit it to the terminal without cutting the match
 * back out again — so it shifts the window rather than clipping it away.
 */
export function snippetLine(hit: RecallHit, t: Theme, width: number): string {
  const text = hit.snippet.text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const m = hit.snippet.match;
  if (!m || m.end > text.length) return t.dim(f.clip(text, width));

  let start = 0;
  let end = text.length;
  let lead = '';
  let trail = '';
  if (text.length > width) {
    // Keep the match visible: centre the visible window on it, and say with an
    // ellipsis that the sentence continues — a snippet that begins mid-word
    // with no mark reads as corrupted text rather than as an excerpt.
    const room = width - 2;
    const half = Math.max(0, Math.floor((room - (m.end - m.start)) / 2));
    start = Math.max(0, Math.min(m.start - half, text.length - room));
    end = Math.min(text.length, start + room);
    lead = start > 0 && !text.startsWith(t.ellip) ? t.ellip : '';
    trail = end < text.length && !text.endsWith(t.ellip) ? t.ellip : '';
  }
  const head = text.slice(start, Math.max(m.start, start));
  const hit_ = text.slice(Math.max(m.start, start), Math.max(Math.min(m.end, end), start));
  const tail = text.slice(Math.max(Math.min(m.end, end), start), end);
  return t.dim(lead + head) + t.accent(hit_) + t.dim(tail + trail);
}

function action(s: RecallSession, t: Theme, width: number): string {
  if (s.resume) return f.clip(`run  ${s.resume}`, width);
  const show = `potsherd show ${idTag(s.id)}`;
  if (s.status === 'ghost') {
    // plans/05, the honesty contract: say the limitation before anyone finds it.
    const long = `assistant side not recoverable ${t.sep} ${show}`;
    return long.length <= width ? long : show;
  }
  if (s.status === 'archived') {
    const long = `only potsherd has this transcript ${t.sep} ${show}`;
    return long.length <= width ? long : show;
  }
  return `run  ${show}`;
}

function statusWord(s: RecallSession): string {
  if (s.status === 'ghost') return 'ghost';
  if (s.isSidechain) return 'sidechain';
  return s.status;
}

function tone(right: string, s: RecallSession, t: Theme): string {
  return s.status === 'ghost' ? t.accent(right) : t.dim(right);
}

function markerFor(s: RecallSession, t: Theme): string {
  if (s.pinned) return `${t.star} `;
  if (s.isSidechain) return `${t.g('↳', '>')} `;
  return '';
}

function markerLen(s: RecallSession): number {
  return s.pinned || s.isSidechain ? 2 : 0;
}

function footer(r: RecallResult, t: Theme): string {
  const parts: string[] = [];
  const ghosts = r.sessions.filter((s) => s.status === 'ghost').length;
  const sidechains = r.sessions.filter((s) => s.isSidechain).length;
  if (ghosts) parts.push(`${f.num(ghosts)} ghost ${f.plural(ghosts, 'hit')}`);
  if (sidechains) parts.push(`${f.num(sidechains)} from subagents`);
  if (!r.vectors.used && r.vectors.reason) parts.push(r.vectors.reason);
  if (r.relaxed) parts.push('relaxed to any-word matching');
  if (parts.length === 0) parts.push(`run  potsherd show <id8>  to read one whole`);
  // joinFit, not clip: a footer that ends "(--v…" has lost a whole clause to
  // save two characters. Drop the last note instead of cutting one in half.
  return f.joinFit(parts, t.width - INDENT.length, ` ${t.sep} `, t.ellip);
}
