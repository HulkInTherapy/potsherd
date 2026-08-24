import { INDENT, fitLine } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { idTag } from '../recall.js';
import type { ShowResult, ShownExchange } from '../browse.js';
import type { StoredCard } from '../cards/write.js';
import type { CardClaim } from '../cards/schema.js';

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

  // Audit F4, the half `show` still owed.
  //
  // `claude --resume` writes a NEW transcript whose head is a copy of the old
  // one, and potsherd's dedup correctly attributes the shared records to the
  // session that had them first. So the count above is honest about THIS FILE
  // and silent about the work: the audit's own fixture reads `4 exchanges`
  // here while its thread holds 123 one hop away, which is precisely the
  // complaint — *"no hint that 1,660 records of context live one hop away"*.
  //
  // The count is not changed, because `show` prints this file's transcript and
  // a number that disagreed with what follows it would be worse. The thread is
  // named instead, with the verb that opens it.
  if (s.thread && s.thread.sessions.length > 1 && s.thread.exchanges > r.total) {
    // `plans/05`: a line that reports a gap names the verb that closes it.
    // Saying "one of two" would describe the problem; naming `graft` hands the
    // reader the whole chain.
    lines.push(
      fitLine(
        t,
        t.dim('thread') +
          `  ${f.num(s.thread.exchanges)} exchanges across ${f.num(s.thread.sessions.length)} sessions` +
          t.dim(`  ${t.sep} potsherd graft ${s.id.slice(0, 8)}`),
        t.dim('thread') +
          `  ${f.num(s.thread.exchanges)} exchanges` +
          t.dim(`  ${t.sep} potsherd graft ${s.id.slice(0, 8)}`),
        t.dim('thread') + `  ${f.num(s.thread.exchanges)} exchanges in the chain`,
      ),
    );
  }

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
    // Wrapped, not clipped: this sentence is the honesty contract of `plans/05`
    // in one line, and a narrow terminal used to cut it off mid-word.
    for (const l of f.wrap('the assistant side of this session is not recoverable.', width - 2)) {
      lines.push(INDENT + t.dim(l));
    }
  }

  // The card comes first, and everything below it is the evidence for it.
  //
  // That order is the whole point of `03` §6: a card is what a returning
  // reader wants — what this was, what was decided, what was left open — and
  // the transcript is what they read when the card does not answer them.
  // Until T2.7 `show` printed the card's *title* and then went straight to raw
  // prompts, so the phase's central artifact was legible only through the
  // markdown mirror or a SQL client (verification D3).
  if (r.card) lines.push(...cardBlock(r.card, t, width));

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

/**
 * The card, as something a stranger can read with no caption (`plans/05`
 * moment 3).
 *
 * Six sections, in the order a reader asks for them: what this was (summary),
 * what was settled (decisions), what was not (open threads), what it touched
 * (files), how to find it again (tags), and how much of it survived checking
 * (verified). Empty sections are omitted rather than printed empty — a heading
 * over nothing reads as a bug, and `decisions: none` is already said by the
 * `kept` count.
 *
 * Every claim carries the `seq` numbers it was verified against, because a
 * claim you cannot check is exactly what `verify.ts` exists to prevent and
 * printing it without its citations throws that away at the last step.
 */
function cardBlock(stored: StoredCard, t: Theme, width: number): string[] {
  const c = stored.card;
  const out: string[] = [];
  const body = Math.max(24, width - 8);

  const section = (name: string): void => {
    out.push('');
    out.push(INDENT + t.dim(name));
  };

  if (c.summary.trim()) {
    section('summary');
    for (const l of f.wrap(c.summary.trim(), body)) out.push(INDENT + '  ' + l);
  }

  // `INDENT` + two spaces + a two-character bullet: what is left is what a
  // claim may occupy. Computed rather than guessed, because the citation is
  // appended to the *last* line and a guess there is an over-width line on
  // exactly the claims that cite the most exchanges.
  const claimIndent = INDENT + '    ';
  const avail = Math.max(16, width - claimIndent.length);

  const claims = (name: string, list: readonly CardClaim[]): void => {
    if (list.length === 0) return;
    section(name);
    for (const claim of list) {
      const cite = claim.evidence_seq.length ? `[${claim.evidence_seq.map(String).join(', ')}]` : '';
      const wrapped = f.wrap(claim.what.trim(), avail);
      const last = wrapped[wrapped.length - 1] ?? '';
      // The citation rides on the last line when it fits and takes its own
      // line when it does not. It is never dropped and never truncated: a
      // claim whose seq numbers have been elided is a claim you cannot check.
      const inline = cite !== '' && last.length + 1 + cite.length <= avail;
      wrapped.forEach((l, i) => {
        const bullet = i === 0 ? `${t.bullet} ` : '  ';
        const tail = inline && i === wrapped.length - 1 ? ` ${t.dim(cite)}` : '';
        out.push(INDENT + '  ' + bullet + l + tail);
      });
      if (cite !== '' && !inline) out.push(claimIndent + t.dim(cite));
      const why = (claim.why ?? '').trim();
      if (why) {
        for (const l of f.wrap(why, Math.max(16, avail - 2))) {
          out.push(claimIndent + '  ' + t.dim(l));
        }
      }
    }
  };
  claims('decisions', c.decisions);
  claims('open threads', c.open_threads);

  /**
   * A `·`-separated run of short strings, filled greedily by item.
   *
   * Not `f.wrap` over a joined string: `wrap` breaks on spaces and does not
   * know a `·` is a separator, so it will happily start a line with a lone
   * one. Breaking by *item* keeps the separator with the item it follows and
   * never opens a line with punctuation nobody can attach to anything.
   */
  const list = (name: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    section(name);
    const sep = ` ${t.mid} `;
    let line = '';
    // A single path can be longer than the whole line. Elided in the middle,
    // like every other path potsherd prints: the last segment is what names a
    // file, and a hard-wrapped path is a path you cannot copy.
    for (const raw of items) {
      const item = raw.length > body ? f.elideMiddle(raw, body, t) : raw;
      if (line === '') {
        line = item;
      } else if (line.length + sep.length + item.length <= body) {
        line += sep + item;
      } else {
        out.push(INDENT + '  ' + line + ` ${t.mid}`);
        line = item;
      }
    }
    if (line !== '') out.push(INDENT + '  ' + line);
  };
  list('files', c.files);
  list('tags', [...new Set([...c.topics, ...c.tags])]);

  // The receipt line. `kept` is what the card holds and `dropped` is what the
  // transcript refused to support — the second number is the one that makes
  // the first believable, so they are never printed apart.
  const v = stored.verified;
  const bits: string[] = [];
  if (v) bits.push(`verified  ${f.num(v.kept)} kept ${t.sep} ${f.num(v.dropped)} dropped`);
  bits.push(`outcome ${c.outcome}`);
  if (stored.source) bits.push(stored.source);
  if (stored.model) bits.push(stored.model);
  out.push('');
  for (const l of f.wrap(bits.join(`  ${t.sep}  `), width - 4)) out.push(INDENT + t.dim(l));

  // One rule under the card: everything after this line is the transcript the
  // card was written from, and the reader should be able to see the seam.
  out.push('');
  out.push(INDENT + t.dim('-'.repeat(Math.max(8, Math.min(width - 4, 40)))));
  return out;
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

  // `--md` is for pasting into an issue, and the card is the half worth
  // pasting. It leads, exactly as it does on screen.
  if (r.card) {
    const c = r.card.card;
    out.push('## card');
    out.push('');
    if (c.summary.trim()) {
      out.push(c.summary.trim());
      out.push('');
    }
    const claims = (name: string, list: readonly { what: string; why?: string | null; evidence_seq: number[] }[]): void => {
      if (list.length === 0) return;
      out.push(`**${name}**`);
      out.push('');
      for (const claim of list) {
        const cite = claim.evidence_seq.length ? ` [${claim.evidence_seq.join(', ')}]` : '';
        const why = (claim.why ?? '').trim();
        out.push(`- ${claim.what.trim()}${cite}${why ? ` — _${why}_` : ''}`);
      }
      out.push('');
    };
    claims('decisions', c.decisions);
    claims('open threads', c.open_threads);
    if (c.files.length) {
      out.push(`_files: ${c.files.join(', ')}_`);
      out.push('');
    }
    const tags = [...new Set([...c.topics, ...c.tags])];
    if (tags.length) {
      out.push(`_tags: ${tags.join(', ')}_`);
      out.push('');
    }
    const v = r.card.verified;
    out.push(
      `_verified: ${v ? `${v.kept} kept, ${v.dropped} dropped` : 'not recorded'}` +
        ` · outcome ${c.outcome} · from ${r.card.source}${r.card.model ? ` · ${r.card.model}` : ''}_`,
    );
    out.push('');
  }

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
