import type { RescueResult } from '../rescue.js';
import { Card } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';
import { tildify } from '../paths.js';

/**
 * The rescue receipt — the relief screenshot, and the answer to "what did it
 * actually do to my machine". Same grid as the audit card; the accent colour
 * moves from the loss line to the recovery line, because that is now the
 * number that matters.
 */
export interface ReceiptExtras {
  /** null when the user was never asked, false when they declined. */
  settingsChanged: boolean | null;
  settingsFrom?: number | null;
  settingsTo?: number;
  settingsBackup?: string | null;
  settingsSkippedReason?: string;
  guardInstalled?: boolean;
}

export function renderRescueReceipt(
  r: RescueResult,
  t: Theme = new Theme(),
  extras: ReceiptExtras = { settingsChanged: null },
): string {
  const card = new Card(t);
  const verb = r.dryRun ? 'rescue --dry-run' : 'rescue';
  card.heading(verb, tildify(r.archiveDir), f.date(r.ranAt)).blank();

  card.rows([
    {
      label: r.dryRun ? 'files that would be copied' : 'files copied',
      value: f.num(r.filesCopied),
      note: r.filesCopied ? f.bytes(r.bytesCopied) : 'nothing new since last rescue',
      tone: r.filesCopied ? 'ok' : 'none',
    },
    {
      label: 'already archived',
      value: f.num(r.filesSkipped),
      note: f.bytes(r.bytesArchived) + ' total on disk',
    },
    { label: 'sessions', value: f.num(r.sessionsArchived), note: sessionNote(r) },
    {
      label: 'ghosts rebuilt',
      value: f.num(r.ghostsBuilt),
      note: r.ghostsUpdated ? `${f.num(r.ghostsUpdated)} refreshed` : '',
    },
    {
      label: 'prompts recovered',
      value: f.num(r.promptsRecovered),
      note: r.ghostsWithTitles ? `${f.num(r.ghostsWithTitles)} with titles` : '',
      tone: r.promptsRecovered ? 'accent' : 'none',
    },
  ]);

  card.blank();
  card.rows([sweepRow(t, extras)]);

  if (r.filesFailed.length) {
    card.blank();
    card.text(t.warn(`${f.num(r.filesFailed.length)} files could not be read:`));
    for (const fail of r.filesFailed.slice(0, 3)) {
      card.text(t.dim(`  ${f.elideMiddle(fail.path, t.width - 8, t.ellip)} — ${fail.error}`));
    }
  }
  for (const w of r.warnings.slice(0, 2)) card.text(t.dim(`note: ${w}`));

  card.blank();
  if (r.dryRun) {
    card.text('nothing was written. run  potsherd rescue  to do it for real.');
  } else {
    card.text(`archive: ${tildify(r.archiveDir)}`);
    card.text('run  potsherd ls  to see the archive with titles instead of uuids.');
  }
  return card.toString();
}

function sessionNote(r: RescueResult): string {
  const bits: string[] = [];
  if (r.sidechainsArchived) bits.push(`${f.num(r.sidechainsArchived)} sidechains`);
  if (r.memoryFilesArchived) bits.push(`${f.num(r.memoryFilesArchived)} memory notes`);
  if (r.sessionIndexesArchived) bits.push(`${f.num(r.sessionIndexesArchived)} indexes`);
  return bits.join(' · ');
}

function sweepRow(t: Theme, e: ReceiptExtras): {
  label: string;
  value: string;
  note: string;
  tone: 'ok' | 'warn' | 'none';
} {
  if (e.settingsChanged === true) {
    return {
      label: '30-day sweep',
      value: 'off',
      note: `cleanupPeriodDays ${e.settingsFrom ?? 'unset'} ${t.arrow} ${e.settingsTo}`,
      tone: 'ok',
    };
  }
  if (e.settingsChanged === false) {
    return {
      label: '30-day sweep',
      value: 'on',
      note: `still ${e.settingsFrom ?? 30} days — rescue again before it runs`,
      tone: 'warn',
    };
  }
  return {
    label: '30-day sweep',
    value: 'on',
    note: e.settingsSkippedReason ?? 'not asked (--no-settings)',
    tone: 'warn',
  };
}
