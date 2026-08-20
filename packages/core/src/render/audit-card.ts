import type { AuditReport } from '../audit.js';
import { Card, noteWidth, type Row } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { tildify } from '../paths.js';

/**
 * The audit card. This is the product's face: the one screenshot a stranger
 * sees before they have installed anything.
 *
 * Design constraints it must never break (plans/05):
 *   - fits 80x20, still legible at 60 columns
 *   - numbers right-aligned in one column, thousands separators
 *   - exactly one accent colour, on the loss line; one warning colour, on the
 *     next-sweep line; everything else neutral or dim
 *   - the last two lines are always the fix
 */
export function renderAuditCard(r: AuditReport, t: Theme = new Theme()): string {
  const card = new Card(t);

  card.heading('audit', tildify(r.claudeDir), f.date(r.measuredAt)).blank();

  if (!r.claudeDirExists) {
    card
      .text(`no Claude Code data at ${tildify(r.claudeDir)}.`)
      .blank()
      .text('if Claude Code stores its data elsewhere, point potsherd at it:')
      .raw(`  potsherd audit --claude-dir <path>`)
      .blank();
    return card.toString();
  }

  const rows: Row[] = [];

  rows.push({
    label: 'sessions ever started',
    value: f.num(r.sessionsEver),
    note: historyRange(r, t),
  });
  rows.push({ label: 'still on disk', value: f.num(r.onDisk) });
  rows.push({
    label: `deleted by ${r.cleanupPeriodEffective}-day sweep`,
    value: f.num(r.deleted),
    note: r.deleted > 0 ? f.pct(r.deleted, r.sessionsEver) : '',
    tone: r.deleted > 0 ? 'accent' : 'none',
  });
  rows.push({ label: 'prompts lost', value: f.num(r.promptsLost) });

  if (r.projectsWiped.length > 0) {
    const width = Math.max(12, noteWidth(t));
    rows.push({
      label: 'projects wiped entirely',
      value: f.num(r.projectsWiped.length),
      note: f.joinFit(r.projectsWiped.map((p) => p.name), width, ` ${t.sep} `, t.ellip),
    });
  }

  card.rows(rows).blank();

  const sweepRows: Row[] = [];
  const doomed = r.nextSweepWithin7Days;
  const soon = r.nextSweepWithinOneDay;
  sweepRows.push({
    label: 'next sweep will delete',
    value: f.num(doomed),
    note: doomed
      ? `sessions in ${t.le} 7 days` + (soon ? `   (${f.num(soon)} within one day)` : '')
      : 'nothing in the next 7 days',
    tone: doomed > 0 ? 'warn' : 'ok',
  });
  sweepRows.push({
    label: 'cleanupPeriodDays',
    value: r.cleanupPeriodDays === null ? 'unset' : f.num(r.cleanupPeriodDays),
    note:
      r.cleanupPeriodDays === null
        ? `${t.arrow} ${r.cleanupPeriodEffective} (default)`
        : r.cleanupPeriodSource !== 'user'
          ? `${t.arrow} ${r.cleanupPeriodEffective} (${r.cleanupPeriodSource})`
          : '',
  });
  card.rows(sweepRows).blank();

  if (r.warnings.length) {
    for (const w of r.warnings.slice(0, 3)) card.text(t.dim(`note: ${w}`));
    if (r.warnings.length > 3) card.text(t.dim(`note: ${r.warnings.length - 3} more (see --json)`));
    card.blank();
  }

  if (r.deleted > 0) {
    card.text(`the prompts from all ${f.num(r.deleted)} are recoverable from history.jsonl.`);
    card.text('run  potsherd rescue  to archive what is left and rebuild the ghosts.');
  } else if (r.onDisk > 0) {
    card.text('nothing has been deleted yet.');
    card.text('run  potsherd rescue  to archive what you have before the sweep runs.');
  } else {
    card.text('no sessions found yet. run Claude Code once, then audit again.');
  }

  return card.toString();
}

/** `nov 2025 -> aug 2026`, or a single month when the range is short. */
function historyRange(r: AuditReport, t: Theme): string {
  if (!r.historyFirstTs || !r.historyLastTs) return '';
  const a = f.monthYear(r.historyFirstTs);
  const b = f.monthYear(r.historyLastTs);
  return a === b ? a : `${a} ${t.arrow} ${b}`;
}

/**
 * `potsherd audit --sweep` and the tail of `rescue`: the named sessions that
 * the next sweep is about to take. A count is abstract; a title is not.
 */
export function renderSweepList(r: AuditReport, t: Theme = new Theme(), limit = 10): string {
  if (r.nextSweep.length === 0) return '';
  const card = new Card(t);
  card.blank().text('sessions the sweep takes next:');
  for (const s of r.nextSweep.slice(0, limit)) {
    const when = s.daysLeft <= 0 ? 'at next startup' : s.daysLeft === 1 ? 'in 1 day' : `in ${s.daysLeft} days`;
    const label = s.title ?? `${basename(s.project)}-${s.id.slice(0, 8)}`;
    card.raw(`    ${t.warn(pad(when, 16))}${f.elide(label, Math.max(20, t.width - 24))}`);
  }
  if (r.nextSweep.length > limit) {
    card.raw(`    ${t.dim(`${r.nextSweep.length - limit} more`)}`);
  }
  return card.toString();
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
