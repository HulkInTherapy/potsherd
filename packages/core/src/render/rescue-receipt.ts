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
 *
 * Every row here is a delta *and* a total, because the second run of rescue is
 * the one people screenshot ("did it work?") and a bare `0` in a column of
 * totals reads as "the archive is empty". The value is what this run did; the
 * note carries what is in the archive now. Nothing in the card depends on a
 * caption to be read correctly.
 */
export interface ReceiptExtras {
  /** null when the user was never asked, false when they declined. */
  settingsChanged: boolean | null;
  settingsFrom?: number | null;
  settingsTo?: number;
  /**
   * The cleanupPeriodDays actually in force right now. The receipt reports
   * this rather than assuming the sweep is on whenever it did not ask: a user
   * who set the key last week must not be told their sessions are at risk.
   */
  settingsEffective?: number;
  settingsBackup?: string | null;
  settingsSkippedReason?: string;
  /**
   * True when potsherd refused to rewrite settings.json (JSONC, invalid JSON,
   * or managed policy). The reason is a sentence containing an absolute path,
   * already printed in full above the card — it must never be squeezed into
   * the note column, and the closing line must not suggest re-running a
   * command that has just been refused.
   */
  settingsRefused?: boolean;
  /** Whether the SessionStart guard hook is already in place. */
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

  const ghostsTouched = r.ghostsBuilt + r.ghostsUpdated;

  card.rows([
    {
      label: r.dryRun ? 'files to copy' : 'files copied',
      value: f.num(r.filesCopied),
      note: r.filesCopied ? f.bytes(r.bytesCopied) : 'nothing new since last rescue',
      tone: r.filesCopied ? 'ok' : 'none',
    },
    {
      label: 'already archived',
      value: f.num(r.filesSkipped),
      note: f.bytes(r.bytesArchived) + ' total on disk',
    },
    {
      // "sessions 0" on a second run reads as "the archive holds no sessions".
      // Both halves are spelled out instead: newly archived, then the total.
      label: 'sessions archived',
      value: f.num(r.sessionsArchived),
      note: sessionNote(r),
    },
    {
      label: 'ghosts rebuilt',
      value: f.num(r.ghostsBuilt),
      note: ghostNote(r),
    },
    {
      label: 'prompts recovered',
      value: f.num(r.promptsRecovered),
      note: promptNote(r, ghostsTouched, t),
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
    card.fit(
      'nothing was written. run  potsherd rescue  to do it for real.',
      'nothing was written. run  potsherd rescue  for real.',
    );
    return card.toString();
  }

  card.text(`archive: ${f.elideMiddle(tildify(r.archiveDir), Math.max(24, t.width - 11), t.ellip)}`);
  closing(card, extras);
  return card.toString();
}

/**
 * The last line is always the fix — and the fix has to be one that can work.
 * After potsherd has refused to rewrite settings.json, `potsherd rescue --yes`
 * would be refused again for the same reason, so the line points at the edit
 * the user has to make themselves (spelled out in full just above the card).
 */
function closing(card: Card, e: ReceiptExtras): void {
  if (e.settingsRefused) {
    const days = e.settingsTo ?? 3650;
    card.fit(
      `potsherd cannot edit settings.json. add  "cleanupPeriodDays": ${days}  by hand.`,
      `add  "cleanupPeriodDays": ${days}  to settings.json by hand.`,
      `add  "cleanupPeriodDays": ${days}  by hand.`,
    );
    return;
  }
  // The next verb is whichever one this machine still needs. Pointing at a verb
  // that would be a no-op here is how a tour turns into noise.
  const sweepOff = e.settingsChanged === true || (e.settingsEffective ?? 30) >= 365;
  if (!sweepOff) {
    card.fix(
      'potsherd rescue --yes',
      'to stop the sweep deleting any more.',
      'to stop the sweep.',
    );
  } else if (!e.guardInstalled) {
    card.fix(
      'potsherd guard',
      'to take a copy at every startup, automatically.',
      'to copy at every startup.',
    );
  } else {
    card.fix(
      'potsherd audit',
      'to confirm nothing is due for deletion.',
      'to check nothing is due.',
    );
  }
}

function n(count: number, one: string, many = one + 's'): string {
  return `${f.num(count)} ${f.plural(count, one, many)}`;
}

/**
 * What this run added, then what the archive holds. The total comes first
 * whenever the run added nothing, so the row never reads as an empty archive.
 */
function sessionNote(r: RescueResult): string {
  const bits: string[] = [];
  if (r.sessionsInArchive) bits.push(`${f.num(r.sessionsInArchive)} in the archive`);
  if (r.sidechainsArchived) bits.push(n(r.sidechainsArchived, 'sidechain'));
  if (r.memoryFilesArchived) bits.push(n(r.memoryFilesArchived, 'memory note'));
  if (r.sessionIndexesArchived) bits.push(n(r.sessionIndexesArchived, 'index', 'indexes'));
  if (r.historyArchived) bits.push('history.jsonl');
  return bits.join(' · ');
}

function ghostNote(r: RescueResult): string {
  if (!r.ghostsBuilt && !r.ghostsUpdated) return '';
  // A `0` with nothing beside it reads as "there are no ghosts". Say the total.
  if (!r.ghostsBuilt) return `${f.num(r.ghostsUpdated)} in the archive, none new`;
  return r.ghostsUpdated ? `${f.num(r.ghostsUpdated)} refreshed` : '';
}

/** `prompts recovered` is a total, not a delta. The note says whose. */
function promptNote(r: RescueResult, ghostsTouched: number, t: Theme): string {
  const bits: string[] = [];
  if (ghostsTouched) bits.push(`from ${n(ghostsTouched, 'ghost')}`);
  if (r.ghostsWithTitles) {
    bits.push(r.ghostsWithTitles === 1 ? '1 with a title' : `${f.num(r.ghostsWithTitles)} with titles`);
  }
  return bits.join(` ${t.sep} `);
}

function sweepRow(t: Theme, e: ReceiptExtras): {
  label: string;
  value: string;
  note: string;
  tone: 'ok' | 'warn' | 'none';
} {
  if (e.settingsChanged === true) {
    return {
      label: 'the sweep',
      value: 'off',
      note: `cleanupPeriodDays ${e.settingsFrom ?? 'unset'} ${t.arrow} ${e.settingsTo}`,
      tone: 'ok',
    };
  }
  const days = e.settingsEffective ?? e.settingsFrom ?? 30;
  // A year or more is not a sweep anyone needs warning about.
  const off = days >= 365;

  if (e.settingsChanged === false) {
    return {
      label: 'the sweep',
      value: off ? 'off' : 'on',
      note: off
        ? `cleanupPeriodDays ${days}`
        : `still ${days} days — rescue again before it runs`,
      tone: off ? 'ok' : 'warn',
    };
  }
  return {
    label: 'the sweep',
    value: off ? 'off' : 'on',
    note: off
      ? `cleanupPeriodDays ${days}`
      // Never the refusal reason: it opens with an absolute path, and the note
      // column truncates it into gibberish. The full sentence is above.
      : e.settingsRefused
        ? 'settings.json left untouched'
        : (e.settingsSkippedReason ?? 'not asked (--no-settings)'),
    tone: off ? 'ok' : 'warn',
  };
}
