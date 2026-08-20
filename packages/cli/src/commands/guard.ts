import { consent, paths } from '@potsherd/core';
import { confirm, print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';

export interface GuardOptions extends GlobalOptions {
  remove?: boolean;
  status?: boolean;
}

/**
 * `potsherd guard` — a SessionStart hook that runs `rescue --quiet` before
 * Claude Code's own sweep can bite. Belt and braces alongside
 * `cleanupPeriodDays`: the setting stops future deletions, the guard makes sure
 * a copy exists even if the setting is ever reset by an update or another tool.
 *
 * Superseded by the Claude Code plugin in phase 5, which ships the same hook
 * without touching the user's settings.json at all.
 */
export async function runGuard(o: GuardOptions): Promise<number> {
  const t = themeFrom(o);
  const installed = consent.guardInstalled(o.claudeDir);

  if (o.status) {
    if (o.json) {
      printJson({ installed, command: consent.GUARD_COMMAND, settings: paths.claudePaths(paths.claudeDir(o.claudeDir)).settings });
      return 0;
    }
    print(
      installed
        ? `  ${t.ok('guard installed')}  SessionStart runs: ${consent.GUARD_COMMAND}`
        : `  guard not installed.  run  potsherd guard  to add the SessionStart hook.`,
    );
    return 0;
  }

  const proposal = consent.proposeGuardHook(o.claudeDir, { remove: o.remove ?? false });

  if (proposal.noop) {
    const msg = o.remove ? 'guard was not installed; nothing to remove.' : 'guard is already installed.';
    if (o.json) { printJson({ changed: false, installed: !o.remove, message: msg }); return 0; }
    print(`  ${msg}`);
    return 0;
  }

  if (!proposal.safe) {
    if (o.json) { printJson({ changed: false, safe: false, reason: proposal.reason }); return 1; }
    for (const line of consent.manualInstructions(proposal, 'guard')) print(line);
    return 1;
  }

  if (!o.json && !o.quiet) {
    print('');
    print(o.remove
      ? `  potsherd will remove its SessionStart hook from ${paths.tildify(proposal.path)}.`
      : `  potsherd will add one SessionStart hook to ${paths.tildify(proposal.path)}.`);
    print(`  It runs  ${consent.GUARD_COMMAND}  and exits in well under a second when nothing changed.`);
    print('');
    for (const line of proposal.diff.split('\n')) {
      const tone = line.startsWith('+') && !line.startsWith('+++') ? t.ok(line)
        : line.startsWith('-') && !line.startsWith('---') ? t.warn(line)
        : t.dim(line);
      print('  ' + tone);
    }
    print('');
  }

  let approved = o.yes ?? false;
  if (!approved) {
    if (!process.stdin.isTTY) {
      throw new UserError(
        'guard needs a terminal to confirm the settings change',
        'potsherd guard --yes',
      );
    }
    approved = await confirm(o.remove ? '  remove the hook?' : '  add the hook?', { default: false });
  }

  if (!approved) {
    if (o.json) { printJson({ changed: false, declined: true }); return 0; }
    print('  no change made.');
    return 0;
  }

  const { backup } = consent.applyProposal(proposal);
  if (o.json) {
    printJson({ changed: true, installed: !o.remove, backup, path: proposal.path });
    return 0;
  }
  print(o.remove
    ? `  ${t.ok('guard removed')}  ${paths.tildify(proposal.path)}`
    : `  ${t.ok('guard installed')}  every Claude Code startup now archives first`);
  if (backup) print(`  ${t.dim('backup:')} ${paths.tildify(backup)}`);
  if (!o.remove) print('\n  run  potsherd audit  to confirm nothing is due for deletion.');
  return 0;
}
