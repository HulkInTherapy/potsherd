import { Card, INDENT, table } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { redactionRow } from '../redact.js';
import { tildify } from '../paths.js';
import type { HarnessStats, StatsReport } from '../stats.js';

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
    {
      label: 'vectors',
      value: fr.vecAvailable ? f.num(fr.vectors) : '—',
      note: fr.vecAvailable
        ? `bge-small ${t.sep} ${f.num(fr.vectorsPending)} pending ${t.sep} hybrid search on`
        : f.clip(`${fr.vecReason ?? 'unavailable'} ${t.sep} text search only`, card.noteWidth()),
      tone: fr.vecAvailable ? 'ok' : 'dim',
    },
    {
      label: 'database',
      value: f.bytes(fr.dbBytes),
      // Elide in the middle: the file name is what identifies a path, and the
      // middle of `/private/tmp/…/potsherd.db` never does.
      note: f.elideMiddle(tildify(fr.dbPath), card.noteWidth(), t.ellip),
      tone: 'dim',
    },
  ]);

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
