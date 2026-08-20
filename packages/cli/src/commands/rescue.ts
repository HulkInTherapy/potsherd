import {
  consent,
  format as fmt,
  paths,
  readCleanupStatus,
  rescue,
  renderRescueReceipt,
  POTSHERD_CLEANUP_DAYS,
  type ReceiptExtras,
} from '@potsherd/core';
import { confirm, print, printJson, Progress, themeFrom, UserError, type GlobalOptions } from '../output.js';

export interface RescueOptions extends GlobalOptions {
  dryRun?: boolean;
  dest?: string;
  settings?: boolean;
  days?: number;
  ghostsOnly?: boolean;
}

/**
 * `potsherd rescue` — copies, rebuilds, then asks.
 *
 * The order matters: the archive is taken and the ghosts are built before the
 * user is asked anything, so a `n` at the consent prompt still leaves them
 * strictly better off than before they ran the command.
 */
export async function runRescue(o: RescueOptions): Promise<number> {
  const t = themeFrom(o);
  const root = o.dest ? paths.expandTilde(o.dest) : o.potsherdDir;
  const showProgress = !o.json && !o.quiet && Boolean(process.stderr.isTTY);
  const copyBar = new Progress('archiving', showProgress);
  const ghostBar = new Progress('rebuilding ghosts', showProgress);

  const result = await rescue({
    claudeDir: o.claudeDir,
    ...(root ? { root } : {}),
    dryRun: o.dryRun ?? false,
    quiet: o.quiet ?? false,
    ghostsOnly: o.ghostsOnly ?? false,
    onProgress: (p) => {
      if (p.phase === 'copy') copyBar.update(p.done, p.total, p.label ?? '');
      else ghostBar.update(p.done, p.total);
    },
  });
  copyBar.done();
  ghostBar.done();

  // The consent flow. Never runs for --dry-run, --no-settings, or a non-TTY
  // without --yes, which is what makes the SessionStart hook safe.
  const extras: ReceiptExtras = {
    settingsChanged: null,
    guardInstalled: consent.guardInstalled(o.claudeDir),
    settingsEffective: readCleanupStatus(o.claudeDir).effective,
  };
  const wantSettings = o.settings !== false && !o.dryRun;
  if (wantSettings) {
    const status = readCleanupStatus(o.claudeDir);
    const days = o.days ?? POTSHERD_CLEANUP_DAYS;
    const proposal = consent.proposeCleanupPeriod(o.claudeDir, days, status);
    extras.settingsFrom = status.declared;
    extras.settingsTo = days;

    if (proposal.noop) {
      extras.settingsChanged = true;
      extras.settingsFrom = status.declared;
    } else if (!proposal.safe) {
      extras.settingsChanged = null;
      extras.settingsSkippedReason = proposal.reason ?? 'settings.json cannot be edited safely';
      if (!o.json && !o.quiet) {
        print('');
        for (const line of consent.manualInstructions(proposal, 'cleanup', days)) print(line);
      }
    } else {
      const approved = o.yes ? true : await askForSettings(proposal.diff, days, status.effective, o);
      if (approved) {
        const { backup } = consent.applyProposal(proposal);
        extras.settingsChanged = true;
        extras.settingsBackup = backup;
        extras.settingsEffective = days;
      } else {
        extras.settingsChanged = false;
      }
    }
  } else if (o.dryRun) {
    extras.settingsSkippedReason = 'not asked (--dry-run)';
  }

  if (o.json) {
    printJson({ ...result, settings: extras });
    return 0;
  }
  if (o.quiet) return 0;

  print(renderRescueReceipt(result, t, extras));
  if (extras.settingsBackup) {
    const shown = fmt.elideMiddle(paths.tildify(extras.settingsBackup), Math.max(24, t.width - 11), t.ellip);
    print(`  ${t.dim('backup:')} ${shown}`);
  }
  return 0;
}

async function askForSettings(
  diff: string,
  days: number,
  currentEffective: number,
  o: RescueOptions,
): Promise<boolean> {
  if (o.quiet || o.json) return false;
  const t = themeFrom(o);
  print('');
  print(
    `  Claude Code deletes transcripts older than ${currentEffective} days. ` +
      `potsherd can raise that to ${days}.`,
  );
  print(`  This is the only change potsherd ever makes outside ${paths.tildify(paths.potsherdDir())}.`);
  print('');
  for (const line of diff.split('\n')) {
    const tone = line.startsWith('+') && !line.startsWith('+++') ? t.ok(line)
      : line.startsWith('-') && !line.startsWith('---') ? t.warn(line)
      : t.dim(line);
    print('  ' + tone);
  }
  print('');
  if (!process.stdin.isTTY) {
    throw new UserError(
      'settings change needs a terminal to confirm',
      'potsherd rescue --yes    (or --no-settings to skip it)',
    );
  }
  return confirm('  set cleanupPeriodDays in ~/.claude/settings.json?', { default: false });
}
