import fs from 'node:fs';
import process from 'node:process';
import { consent, onPath, paths } from '@potsherd/core';
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
  const resolution = consent.guardCommandFor(process.argv[1]);
  const installed = consent.installedGuardCommand(o.claudeDir);

  if (o.status) return status(o, t, installed, resolution);

  const proposal = consent.proposeGuardHook(o.claudeDir, {
    remove: o.remove ?? false,
    command: resolution.command,
  });

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
    if (!o.remove) {
      print(`  It runs  ${resolution.command}`);
      print('  and exits in well under a second when nothing has changed.');
      if (resolution.via === 'absolute') {
        print('');
        print(t.dim('  potsherd is not on your PATH, so the hook pins this install by path.'));
        print(t.dim('  after  npm i -g potsherd,  re-run  potsherd guard  for the portable form.'));
      }
    }
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
    printJson({
      changed: true,
      installed: !o.remove,
      command: o.remove ? null : resolution.command,
      via: o.remove ? null : resolution.via,
      backup,
      path: proposal.path,
    });
    return 0;
  }
  print(o.remove
    ? `  ${t.ok('guard removed')}  ${paths.tildify(proposal.path)}`
    : `  ${t.ok('guard installed')}  every Claude Code startup now archives first`);
  if (backup) print(`  ${t.dim('backup:')} ${paths.tildify(backup)}`);
  if (!o.remove) print('\n  run  potsherd audit  to confirm nothing is due for deletion.');
  return 0;
}

/**
 * `--status` re-resolves the binary as well as reading the hook, because the
 * failure that matters is an installed hook whose command no longer runs — a
 * global uninstall, or a moved checkout.
 */
function status(
  o: GuardOptions,
  t: ReturnType<typeof themeFrom>,
  installed: string | null,
  resolution: ReturnType<typeof consent.guardCommandFor>,
): number {
  const runnable = installed === null ? null : commandLooksRunnable(installed);

  if (o.json) {
    printJson({
      installed: installed !== null,
      command: installed,
      runnable,
      wouldInstall: resolution.command,
      via: resolution.via,
      settings: paths.claudePaths(paths.claudeDir(o.claudeDir)).settings,
    });
    return runnable === false ? 1 : 0;
  }

  if (installed === null) {
    print('  guard not installed.');
    print(`  run  potsherd guard  to add a SessionStart hook that runs  ${resolution.command}`);
    return 0;
  }
  if (runnable) {
    print(`  ${t.ok('guard installed')}  SessionStart runs: ${installed}`);
    return 0;
  }
  print(`  ${t.warn('guard installed but broken')}  SessionStart runs: ${installed}`);
  print('  that command is not runnable from here, so no copy is being taken.');
  print('  run  potsherd guard --remove  then  potsherd guard  to repair it.');
  return 1;
}

/**
 * Can this hook command actually be executed from here?
 *
 * Two shapes to check: `potsherd rescue ...`, which needs potsherd on PATH, and
 * `node "/abs/path/potsherd.js" rescue ...`, which needs that file to exist.
 */
function commandLooksRunnable(command: string): boolean {
  const quoted = command.match(/"([^"]+)"/);
  if (quoted?.[1]) return fs.existsSync(quoted[1]);

  const bin = command.trim().split(/\s+/)[0] ?? '';
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\')) return fs.existsSync(bin);
  return onPath(bin) !== null;
}
