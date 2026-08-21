import process from 'node:process';
import { Command, Option } from 'commander';
import { Theme } from '@potsherd/core';
import { fail, print, type GlobalOptions } from './output.js';
import { runAudit } from './commands/audit.js';
import { runRescue } from './commands/rescue.js';
import { runGuard } from './commands/guard.js';
import { runDoctor } from './commands/doctor.js';
import { runIndex } from './commands/index.js';

export const VERSION = '0.1.0';

/**
 * The `potsherd` binary.
 *
 * Three rules hold for every verb, now and in every later phase:
 *   1. `--json` exists and carries the same data as the human view.
 *   2. `--help` shows at least one real example.
 *   3. the global flags work in either position, because `potsherd audit --json`
 *      is what people actually type.
 */

/** Registered on the program *and* on every verb, so position never matters. */
function addGlobals(cmd: Command): Command {
  return cmd
    .option('--json', 'machine-readable output, same data as the human view')
    .option('--no-color', 'disable colour (NO_COLOR is honoured too)')
    .option('--ascii', 'ASCII-only glyphs, for terminals without a unicode font')
    .addOption(new Option('--width <n>', 'render for this terminal width').argParser(Number))
    .option('--claude-dir <path>', 'read Claude Code data from here (CLAUDE_CONFIG_DIR is honoured)')
    .option('--potsherd-dir <path>', "potsherd's own directory (default ~/.potsherd)")
    .option('--debug', 'print full errors');
}

function main(argv: string[]): void {
  const program = new Command();

  addGlobals(
    program
      .name('potsherd')
      .description('rescue, index, search and re-enter every coding-agent session on your machine')
      .version(VERSION, '-v, --version')
      .showHelpAfterError('(run  potsherd --help  for the list of verbs)'),
  );

  const audit = addGlobals(
    program
      .command('audit')
      .description('count what Claude Code has already deleted, and what it deletes next')
      .option('--sweep', 'also list the sessions the next sweep will take, by title')
      .option('--verify', 'print standalone python that recomputes the four numbers, then exit'),
  ).addHelpText('after', `
example:
  potsherd audit
  potsherd audit --json | jq .deleted
  potsherd audit --claude-dir ~/backup/.claude
  potsherd audit --verify                            # check potsherd without potsherd
  potsherd audit --verify --json | jq -r .snippet | sh   # ...and run it now`);
  audit.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, audit, opts);
    await run(
      () => runAudit({ ...o, sweep: Boolean(opts['sweep']), verify: Boolean(opts['verify']) }),
      o,
    );
  });

  const rescue = addGlobals(
    program
      .command('rescue')
      .description('archive every surviving transcript and rebuild the deleted ones as ghosts')
      .option('--dry-run', 'report what would be copied; write nothing anywhere')
      .option('-y, --yes', 'accept the cleanupPeriodDays change without asking')
      .option('--no-settings', 'never touch ~/.claude/settings.json')
      .option('--dest <path>', 'archive into this directory instead of ~/.potsherd')
      .addOption(new Option('--days <n>', 'value to propose for cleanupPeriodDays').argParser(Number))
      .option('--ghosts-only', 'skip the archive copy; only rebuild ghosts from history.jsonl')
      .option('-q, --quiet', 'print nothing on success (for hooks)'),
  ).addHelpText('after', `
example:
  potsherd rescue
  potsherd rescue --dry-run
  potsherd rescue --yes --no-settings --quiet    # what the SessionStart hook runs`);
  rescue.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, rescue, opts);
    await run(
      () =>
        runRescue({
          ...o,
          dryRun: Boolean(opts['dryRun']),
          settings: opts['settings'] !== false,
          ghostsOnly: Boolean(opts['ghostsOnly']),
          ...(opts['dest'] ? { dest: String(opts['dest']) } : {}),
          ...(opts['days'] ? { days: Number(opts['days']) } : {}),
        }),
      o,
    );
  });

  const guard = addGlobals(
    program
      .command('guard')
      .description('install a SessionStart hook so a copy is taken before any future sweep')
      .option('--remove', 'remove the hook again')
      .option('--status', 'report whether the hook is installed; change nothing')
      .option('-y, --yes', 'accept the settings change without asking')
      .option('-q, --quiet', 'print nothing on success'),
  ).addHelpText('after', `
example:
  potsherd guard
  potsherd guard --status
  potsherd guard --remove`);
  guard.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, guard, opts);
    await run(
      () => runGuard({ ...o, remove: Boolean(opts['remove']), status: Boolean(opts['status']) }),
      o,
    );
  });

  const index = addGlobals(
    program
      .command('index')
      .description('parse, redact and index every transcript on this machine')
      .option('--full', 're-read every transcript, ignoring what has not changed')
      .option('--incremental', 'only what changed since the last run (the default)')
      .option('--harness <list>', 'only these harnesses: claude,codex,cursor,pi')
      .option('--no-embed', 'skip embeddings entirely — text search only, no model, no network')
      .option('--session <id>', 'index one session id and nothing else')
      .option('-q, --quiet', 'print nothing on success (for hooks)'),
  ).addHelpText('after', `
example:
  potsherd index
  potsherd index --full
  potsherd index --harness claude --no-embed        # offline, fts only
  potsherd index --json | jq .totals`);
  index.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, index, opts);
    await run(
      () =>
        runIndex({
          ...o,
          full: Boolean(opts['full']),
          incremental: Boolean(opts['incremental']),
          embed: opts['embed'] !== false,
          ...(opts['harness'] ? { harness: String(opts['harness']) } : {}),
          ...(opts['session'] ? { session: String(opts['session']) } : {}),
        }),
      o,
    );
  });

  const doctor = addGlobals(
    program
      .command('doctor')
      .description('what potsherd can see, what it stored, and what it could not parse')
      .option('--privacy', 'list every path potsherd reads and every path it writes'),
  ).addHelpText('after', `
example:
  potsherd doctor
  potsherd doctor --privacy
  potsherd doctor --json | jq .recordTypes`);
  doctor.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, doctor, opts);
    await run(() => runDoctor({ ...o, privacy: Boolean(opts['privacy']) }), o);
  });

  // `potsherd` with no arguments is a tour, not a usage dump. It is often the
  // second thing a user runs, so it teaches the next verb rather than listing
  // flags.
  if (argv.length <= 2) {
    tour();
    return;
  }

  program.parseAsync(argv).catch((err) => fail(err, { debug: argv.includes('--debug') }));
}

/** Verb-level flags win over program-level ones; both spellings are accepted. */
function globals(program: Command, cmd: Command, local: Record<string, unknown>): GlobalOptions {
  const g = program.opts();
  const pick = <T>(key: string): T | undefined =>
    (local[key] !== undefined ? local[key] : g[key]) as T | undefined;

  const width = pick<number>('width');
  const claudeDir = pick<string>('claudeDir');
  const potsherdDir = pick<string>('potsherdDir');
  void cmd;
  return {
    json: Boolean(pick<boolean>('json')),
    color: local['color'] === false || g['color'] === false ? false : true,
    ascii: Boolean(pick<boolean>('ascii')),
    ...(width ? { width: Number(width) } : {}),
    debug: Boolean(pick<boolean>('debug')),
    ...(claudeDir ? { claudeDir: String(claudeDir) } : {}),
    ...(potsherdDir ? { potsherdDir: String(potsherdDir) } : {}),
    quiet: Boolean(local['quiet']),
    yes: Boolean(local['yes']),
  };
}

async function run(fn: () => Promise<number>, o: GlobalOptions): Promise<void> {
  try {
    const code = await fn();
    if (code) process.exitCode = code;
  } catch (err) {
    fail(err, o);
  }
}

function tour(): void {
  const t = new Theme();
  const rows: [string, string][] = [
    ['audit', 'how many sessions Claude Code has already deleted'],
    ['rescue', 'archive what is left; rebuild the deleted ones as ghosts'],
    ['guard', 'take a copy at every startup, before the sweep can run'],
    ['index', 'parse, redact and index every transcript, ready to search'],
    ['doctor', 'what potsherd can see, and every path it reads or writes'],
  ];
  print('');
  print(`  ${t.bold('potsherd')} ${t.dim(VERSION)}  ${t.dim('— your coding-agent sessions, rescued and searchable')}`);
  print('');
  for (const [verb, what] of rows) {
    print(`  potsherd ${verb.padEnd(9)}${t.dim(what)}`);
  }
  print('');
  print(`  start here:  ${t.accent('potsherd audit')}`);
  print('');
}

main(process.argv);
