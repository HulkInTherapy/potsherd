import { INDENT, fitLine } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { idTag } from '../recall.js';
import type { ShowResult, ShownExchange } from '../browse.js';

/**
 * `potsherd show` — one session, read end to end.
 *
 * This is the only verb whose body **wraps** rather than clips. Everywhere else
 * a truncated line loses a detail; here it would lose the sentence the user
 * came back for, so prose reflows to the terminal width with a hanging indent
 * and the columns stay out of its way.
 *
 * A ghost shows what a ghost is: the prompts, in order, with the assistant side
 * missing and named as missing. That is the honest rendering of a session
 * Claude Code deleted — and seeing eleven of your own prompts from a session
 * you thought was gone is, in practice, most of the value.
 */
export function renderShow(r: ShowResult, t: Theme = new Theme(), now = new Date()): string {
  const lines: string[] = [];
  const s = r.session;
  const width = Math.max(40, t.width);
  const body = width - 5;

  lines.push(t.dim(f.clip(`potsherd show ${t.sep} ${s.displayTitle}`, width)));
  lines.push('');

  const meta = [s.harness, s.status === 'ghost' ? t.accent('ghost') : s.status, s.projectName];
  const when = s.startedAt ?? s.endedAt;
  if (when) meta.push(f.shortDateTime(when, now));
  if (s.gitBranch) meta.push(s.gitBranch);
  if (s.isSidechain) meta.push(`sidechain${s.agentName ? ` ${t.sep} ${s.agentName}` : ''}`);
  lines.push(INDENT + meta.join(` ${t.sep} `));
  lines.push(INDENT + t.dim(f.clip(s.id, width - 2)));

  const total = r.total;
  const range =
    r.from === 1 && r.to >= total
      ? `${f.num(total)} ${f.plural(total, r.ghostPrompts ? 'prompt' : 'exchange')}`
      : `${f.num(r.from)}–${f.num(r.to)} of ${f.num(total)}`;
  lines.push(INDENT + t.dim(range + (s.pinned ? `  ${t.star} pinned` : '')));

  // The caveat on the title, in the one place the title is largest. A carded
  // ghost's heading is a card title — written by a model from the prompts
  // below and nothing else — and `show` is where a reader decides how much to
  // believe it (`phase-2` T2.3).
  if (s.cardSource === 'prompts-only') {
    const note = f.clip('— written from these prompts; the assistant side is gone', width - 22);
    lines.push(
      INDENT + t.dim('card') + `  ${t.accent('prompts-only')}` + t.dim(`  ${note}`),
    );
  }

  if (s.resume) {
    lines.push(INDENT + t.dim('run') + `  ${s.resume}`);
  } else if (s.status === 'ghost') {
    lines.push(INDENT + t.dim('the assistant side of this session is not recoverable.'));
  }

  if (r.ghostPrompts) {
    // The number is the position `--from` / `--to` address, not the harness's
    // own sequence number: the two differ (ghost prompts count from 0,
    // exchanges from 1) and only one of them is a thing the user can type.
    r.ghostPrompts.forEach((p, i) => {
      lines.push('');
      lines.push(INDENT + label(t, r.from + i, p.ts, 'you', now));
      lines.push(...prose(p.text, body, t, false));
    });
    lines.push('');
    lines.push(
      fitLine(
        t,
        `${t.dim('run')}  potsherd find <words>  ${t.dim('to search every prompt, deleted or not')}`,
        `${t.dim('run')}  potsherd find <words>  ${t.dim('deleted prompts included')}`,
        `${t.dim('run')}  potsherd find <words>`,
      ),
    );
    return lines.join('\n');
  }

  r.exchanges.forEach((e, i) => {
    lines.push('');
    lines.push(INDENT + label(t, r.from + i, e.ts, 'you', now, e));
    lines.push(...prose(e.userText, body, t, false));
    if (e.assistantText.trim()) {
      lines.push(INDENT + '  ' + t.dim(s.harness));
      lines.push(...prose(e.assistantText, body, t, true));
    }
    const notes: string[] = [];
    if (e.toolCalls.length) notes.push(toolNote(e, t));
    if (e.filesTouched.length) {
      notes.push(`files  ${f.joinFit(e.filesTouched.map(base), body - 8, ` ${t.mid} `, t.ellip)}`);
    }
    for (const n of notes) lines.push(INDENT + '  ' + t.dim(f.clip(n, body)));
  });

  if (r.children.length) {
    lines.push('');
    lines.push(
      INDENT +
        t.dim(
          `${f.num(r.children.length)} subagent ${f.plural(r.children.length, 'transcript')}:  ` +
            f.joinFit(
              r.children.map((c) => `${c.agentName ?? 'agent'} ${idTag(c.id)}`),
              width - 30,
              ` ${t.mid} `,
              t.ellip,
            ),
        ),
    );
  }

  lines.push('');
  lines.push(
    fitLine(
      t,
      `${t.dim('run')}  potsherd show ${idTag(s.id)} --md  ${t.dim('for markdown')}`,
      `${t.dim('run')}  potsherd show ${idTag(s.id)} --md`,
    ),
  );
  return lines.join('\n');
}

function label(
  t: Theme,
  n: number,
  ts: string | null,
  who: string,
  now: Date,
  e?: ShownExchange,
): string {
  const parts = [String(n).padStart(3), ts ? f.shortDateTime(ts, now) : '', who];
  if (e?.isSidechain) parts.push('sidechain');
  if (e?.redacted) parts.push('redacted');
  return t.dim(parts.filter(Boolean).join('  '));
}

function prose(text: string, width: number, t: Theme, dim: boolean): string[] {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [INDENT + '  ' + t.dim('(empty)')];
  const out = f.wrap(clean, width).map((l) => INDENT + '  ' + (dim ? t.dim(l) : l));
  return out.length ? out : [INDENT + '  ' + t.dim('(empty)')];
}

function toolNote(e: ShownExchange, t: Theme): string {
  const byName = new Map<string, { n: number; errors: number }>();
  for (const c of e.toolCalls) {
    const seen = byName.get(c.name) ?? { n: 0, errors: 0 };
    seen.n++;
    if (c.isError) seen.errors++;
    byName.set(c.name, seen);
  }
  const parts = [...byName.entries()].map(
    ([name, v]) => `${name}${v.n > 1 ? `(${v.n})` : ''}${v.errors ? '!' : ''}`,
  );
  return `tools  ${parts.join(` ${t.mid} `)}`;
}

function base(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** `--md`: the same session as markdown, for pasting into an issue or a note. */
export function renderShowMarkdown(r: ShowResult): string {
  const s = r.session;
  const out: string[] = [];
  out.push(`# ${s.displayTitle}`);
  out.push('');
  out.push(`- session: \`${s.id}\``);
  out.push(`- harness: ${s.harness}`);
  out.push(`- project: ${s.project ?? '—'}`);
  out.push(`- status: ${s.status}${s.isSidechain ? ' (sidechain)' : ''}`);
  if (s.cardSource) out.push(`- card source: ${s.cardSource}`);
  if (s.startedAt) out.push(`- started: ${s.startedAt}`);
  if (s.gitBranch) out.push(`- branch: ${s.gitBranch}`);
  if (s.resume) out.push(`- resume: \`${s.resume}\``);
  out.push('');

  if (r.ghostPrompts) {
    out.push('> Rebuilt from `history.jsonl`. The assistant side is not recoverable.');
    out.push('');
    r.ghostPrompts.forEach((p, i) => {
      out.push(`## ${r.from + i}${p.ts ? ` — ${p.ts}` : ''}`);
      out.push('');
      out.push(p.text);
      out.push('');
    });
    return out.join('\n');
  }

  r.exchanges.forEach((e, i) => {
    out.push(`## ${r.from + i}${e.ts ? ` — ${e.ts}` : ''}`);
    out.push('');
    out.push('**you**');
    out.push('');
    out.push(e.userText);
    out.push('');
    if (e.assistantText.trim()) {
      out.push(`**${s.harness}**`);
      out.push('');
      out.push(e.assistantText);
      out.push('');
    }
    if (e.toolCalls.length) {
      out.push(`_tools: ${e.toolCalls.map((c) => c.name).join(', ')}_`);
      out.push('');
    }
    if (e.filesTouched.length) {
      out.push(`_files: ${e.filesTouched.join(', ')}_`);
      out.push('');
    }
  });
  return out.join('\n');
}
