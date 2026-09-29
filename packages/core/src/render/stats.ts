import { Card, INDENT, table } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { redactionRow } from '../redact.js';
import { tildify } from '../paths.js';
import type { FreshnessStats, HarnessStats, StatsReport } from '../stats.js';
import { fitNote, vectorNote } from '../doctor-line.js';
import type { Row } from '../render.js';

/**
 * `potsherd stats` — the index, counted.
 *
 * Two grids, both from `render.ts`: a `table` for the per-harness block, where
 * six numbers per row have to line up as columns, and the `Card` label/value
 * rows for the totals, where each line is one statement. Every number is a
 * `COUNT` or a `SUM` the user could recompute by hand — that is what makes
 * this the verb you run to check that `index` did what it said.
 *
 * The accent goes on the one line that is a claim rather than a tally: the
 * prompts recovered from sessions that no longer exist.
 */
export function renderStats(r: StatsReport, t: Theme = new Theme()): string {
  const card = new Card(t);
  card.heading('stats', tildify(r.root), f.date(r.ranAt)).blank();

  if (r.harnesses.length === 0) {
    card
      .text('nothing indexed yet.')
      .blank()
      .fix('potsherd index', 'to read every transcript on this machine.');
    return card.toString();
  }

  const header = ['harness', 'sessions', 'subagents', 'ghosts', 'exchanges', 'bytes', 'span'];
  const rows = [
    header.map((h) => t.dim(h)),
    ...r.harnesses.map((h) => harnessRow(h, t)),
  ];
  for (const line of table(t, rows, {
    gap: 2,
    grow: 6,
    align: ['left', 'right', 'right', 'right', 'right', 'right', 'left'],
  })) {
    card.raw(line);
  }

  card.blank();
  const tot = r.totals;
  card.rows([
    {
      label: 'sessions',
      value: f.num(tot.sessions),
      note: `${f.num(tot.sidechains)} subagents ${t.sep} ${f.num(tot.titled)} titled ${t.sep} ${f.num(tot.archived)} archived`,
    },
    {
      label: 'exchanges',
      value: f.num(tot.exchanges),
      note: `${f.num(tot.toolCalls)} tool ${f.plural(tot.toolCalls, 'call')} ${t.sep} ${f.num(r.redactedExchanges)} redacted`,
    },
    {
      label: 'ghosts',
      value: f.num(tot.ghosts),
      note:
        tot.ghosts > 0
          ? `${f.num(tot.ghostPrompts)} prompts recovered ${t.sep} no assistant side`
          : 'none — run  potsherd rescue',
      tone: tot.ghosts > 0 ? 'accent' : 'dim',
    },
    redactionRow(r.redaction, t, card.noteWidth()),
  ]);

  card.blank();
  const fr = r.freshness;
  card.rows([
    {
      label: 'indexed',
      value: fr.lastIndexedAt ? f.shortDate(fr.lastIndexedAt, new Date(r.ranAt)) : '—',
      note: freshnessNote(r, t),
      tone: fr.stale > 0 || fr.missing > 0 ? 'warn' : 'ok',
    },
    vectorsRow(fr, t, card.noteWidth()),
    {
      label: 'database',
      value: f.bytes(fr.dbBytes),
      // Elide in the middle: the file name is what identifies a path, and the
      // middle of `/private/tmp/…/potsherd.db` never does.
      note: f.elideMiddle(tildify(fr.dbPath), card.noteWidth(), t.ellip),
      tone: 'dim',
    },
  ]);

  // The one line that stops the totals above from being a claim about the
  // whole archive when they are a claim about part of it. `stats` is the verb
  // people run to check that `index` did what it said; a count that silently
  // left a project out would break exactly that.
  if (r.ignored.hidden > 0) {
    const n = r.ignored.hidden;
    const p = r.ignored.projects.length;
    const what = `not counting ${f.num(n)} ${f.plural(n, 'session')} in ${f.num(p)} ignored ${f.plural(p, 'project')}`;
    // Two variants rather than one that elides. `05` gives every line the
    // command that acts on it, and at 60 columns the long form loses exactly
    // that half — a caveat whose remedy has been cut off is a caveat.
    const wide = `${what}  ${t.sep}  potsherd stats --all`;
    card.blank();
    card.text(t.dim(Theme.len(INDENT + wide) <= t.width ? wide : `${what}  ${t.sep} --all`));
  }

  card.blank();
  card.fix(
    'potsherd ls',
    'to read the archive by title, newest first.',
    'to read it by title.',
  );
  return card.toString();
}

function harnessRow(h: HarnessStats, t: Theme): string[] {
  return [
    h.harness,
    f.num(h.sessions),
    h.sidechains ? f.num(h.sidechains) : t.dim('—'),
    h.ghosts ? f.num(h.ghosts) : t.dim('—'),
    f.num(h.exchanges),
    f.bytes(h.bytes),
    span(h, t),
  ];
}

function span(h: HarnessStats, t: Theme): string {
  if (!h.firstTs || !h.lastTs) return t.dim('—');
  const from = f.monthYear(h.firstTs);
  const to = f.monthYear(h.lastTs);
  return t.dim(from === to ? from : `${from} ${t.arrow} ${to}`);
}

function freshnessNote(r: StatsReport, t: Theme): string {
  const fr = r.freshness;
  const parts: string[] = [];
  parts.push(`${f.num(fr.indexed)} ${f.plural(fr.indexed, 'transcript')}`);
  if (fr.stale > 0) parts.push(`${f.num(fr.stale)} changed since — run potsherd index`);
  if (fr.missing > 0) parts.push(`${f.num(fr.missing)} source ${f.plural(fr.missing, 'file')} gone`);
  if (fr.stale === 0 && fr.missing === 0) parts.push('up to date');
  return parts.join(` ${t.sep} `);
}

/** Kept for callers that want the block without the card around it. */
export { INDENT };

/**
 * The `vectors` row — the same report, the same wording, as `doctor`, `index`
 * and `find`.
 *
 * FIX-B D2. This row used to compose its own sentence out of its own two
 * numbers: `bge-small · 1,586 pending · hybrid search on`, beside a `doctor`
 * saying `warming 142 of 4,699`. Two of the differences were arithmetic and
 * `stats.ts` owns those now; the third was the sentence itself — `hybrid
 * search on` is a claim about a search that was in fact still warming, and
 * `index --embed to build them` is an instruction from the release where
 * vectors were opt-in.
 *
 * So there is no wording here. {@link vectorNote} composes the value and the
 * parts, {@link fitNote} drops whole clauses to the terminal's width, and the
 * only thing this function decides is that the row is called `vectors`.
 */
function vectorsRow(fr: FreshnessStats, t: Theme, noteWidth: number): Row {
  const report = fr.vectorReport;
  if (!report) {
    return {
      label: 'vectors',
      value: '—',
      note: f.clip(`${fr.vecReason ?? 'unavailable'} ${t.sep} text search only`, noteWidth),
      tone: 'dim',
    };
  }
  const worded = vectorNote(report, { num: f.num, bytes: f.bytes });
  return {
    label: 'vectors',
    value: worded.value,
    note: fitNote(worded.parts, noteWidth, ` ${t.sep} `),
    tone: worded.tone,
  };
}
