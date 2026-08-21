import process from 'node:process';
import { Command, Option } from 'commander';
import { Theme } from '@potsherd/core';
import { fail, print, type GlobalOptions } from './output.js';
import { runAudit } from './commands/audit.js';
import { runRescue } from './commands/rescue.js';
import { runGuard } from './commands/guard.js';
import { runDoctor } from './commands/doctor.js';
import { runIndex } from './commands/index.js';
import { runFind } from './commands/find.js';
import { runLs } from './commands/ls.js';
import { runShow } from './commands/show.js';
import { runStats } from './commands/stats.js';
import { runCard } from './commands/card.js';

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


/**
 * The filter flags of `03` §7. Registered identically on `find` and `ls` so the
 * two verbs can never drift: whatever `ls --project X --since 30d` lists is
 * exactly what `find q --project X --since 30d` searches.
 */
function addFilters(cmd: Command): Command {
  return cmd
    .option('--project <name>', 'only this project (a directory name is enough)')
    .option('--harness <name>', 'claude, codex, cursor or pi')
    .option('--since <when>', 'on or after this date, or a span like 30d / 6w')
    .option('--until <when>', 'on or before this date')
    .option('--branch <name>', 'only sessions on this git branch')
    .option('--tag <tag>', 'only sessions carrying this tag')
    .addOption(
      new Option('--sidechains <mode>', 'subagent transcripts')
        .choices(['include', 'only', 'exclude'])
        .default('include'),
    )
    .addOption(
      new Option('--ghosts <mode>', 'sessions Claude Code deleted, rebuilt from history')
        .choices(['include', 'only', 'exclude'])
        .default('include'),
    )
    .addOption(new Option('--status <state>', 'index status').choices(['live', 'archived', 'ghost']))
    .option('--pinned', 'only pinned sessions')
    .addOption(new Option('--limit <n>', 'how many to show').argParser(Number));
}

/** Pull the filter flags back off a parsed command, in one shape. */
function filterFlags(opts: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(opts['project'] ? { project: String(opts['project']) } : {}),
    ...(opts['harness'] ? { harness: String(opts['harness']) } : {}),
    ...(opts['since'] ? { since: String(opts['since']) } : {}),
    ...(opts['until'] ? { until: String(opts['until']) } : {}),
    ...(opts['branch'] ? { branch: String(opts['branch']) } : {}),
    ...(opts['tag'] ? { tag: String(opts['tag']) } : {}),
    ...(opts['file'] ? { file: String(opts['file']) } : {}),
    ...(opts['status'] ? { status: String(opts['status']) } : {}),
    ...(opts['sidechains'] ? { sidechains: String(opts['sidechains']) } : {}),
    ...(opts['ghosts'] ? { ghosts: String(opts['ghosts']) } : {}),
    pinned: Boolean(opts['pinned']),
    ...(opts['limit'] !== undefined ? { limit: opts['limit'] } : {}),
  };
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


  const find = addFilters(
    addGlobals(
      program
        .command('find')
        .description('search every prompt, every subagent and every deleted session')
        .argument('<query>', 'the words to look for'),
    )
      .option('--file <path>', 'only sessions that touched a path containing this')
      .addOption(
        new Option('--vectors <mode>', 'the vector half of the hybrid')
          .choices(['auto', 'on', 'off'])
          .default('auto'),
      )
      .option('--no-vec', 'text search only — the same as --vectors off'),
  ).addHelpText('after', `
example:
  potsherd find "pgbouncer"
  potsherd find "vedic astrology" --json | jq -r '.sessions[0].resume'
  potsherd find "instagram" --sidechains only        # what the subagents did
  potsherd find "canon driver" --ghosts only         # only what was deleted
  potsherd find "rls policy" --project Fulcrum --since 30d
  potsherd find "the pooler decision" --vectors on   # force semantic search`);
  find.action(async (query: string, opts: Record<string, unknown>) => {
    const o = globals(program, find, opts);
    await run(
      () =>
        runFind({
          ...o,
          ...filterFlags(opts),
          query,
          vec: opts['vec'] !== false,
          ...(opts['vectors'] ? { vectors: String(opts['vectors']) } : {}),
        }),
      o,
    );
  });

  const ls = addFilters(
    addGlobals(
      program
        .command('ls')
        .description('every session by title, newest first — ghosts and subagents included'),
    ),
  ).addHelpText('after', `
example:
  potsherd ls
  potsherd ls --project Fulcrum --since 30d
  potsherd ls --ghosts only --limit 40               # what the sweep took
  potsherd ls --harness codex --json | jq -r '.sessions[].displayTitle'`);
  ls.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, ls, opts);
    await run(() => runLs({ ...o, ...filterFlags(opts) }), o);
  });

  const show = addGlobals(
    program
      .command('show')
      .description('read one session end to end, by id or by any unambiguous prefix')
      .argument('<session>', 'session id, or the first 8 characters of one')
      .addOption(new Option('--from <n>', 'first exchange to print (1-based)').argParser(Number))
      .addOption(new Option('--to <n>', 'last exchange to print').argParser(Number))
      .option('--md', 'markdown, for pasting into an issue or a note'),
  ).addHelpText('after', `
example:
  potsherd show 85ef9531
  potsherd show 85ef9531 --from 12 --to 18
  potsherd show 85ef9531 --md > session.md
  potsherd show 85ef9531 --json | jq -r '.exchanges[].userText'`);
  show.action(async (session: string, opts: Record<string, unknown>) => {
    const o = globals(program, show, opts);
    await run(
      () =>
        runShow({
          ...o,
          session,
          ...(opts['from'] !== undefined ? { from: opts['from'] } : {}),
          ...(opts['to'] !== undefined ? { to: opts['to'] } : {}),
          md: Boolean(opts['md']),
        }),
      o,
    );
  });

  const stats = addGlobals(
    program
      .command('stats')
      .description('what is in the index: per-harness counts, redaction, freshness')
      .option('--no-fresh', 'skip the per-file staleness check'),
  ).addHelpText('after', `
example:
  potsherd stats
  potsherd stats --json | jq '.harnesses[] | {harness, sessions, ghosts}'`);
  stats.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, stats, opts);
    await run(() => runStats({ ...o, fresh: opts['fresh'] !== false }), o);
  });

  const card = addFilters(
    addGlobals(
      program
        .command('card')
        .description('write a verified card for every session — what it was, decided, left open')
        .argument('[session]', 'one session id, or the first 8 characters of one')
        .option('--all', 'every session and ghost in the index')
        .option('--dry-run', 'print sessions, tokens, cost and minutes; call nothing')
        .option('--force', 're-card even when the card is newer than the transcript')
        .option('--probe', 'make one tiny model call to prove the backend works, then stop')
        .option('--model <name>', 'haiku, sonnet, opus, or an explicit model id')
        .addOption(
          new Option('--backend <name>', 'force a backend instead of detecting one')
            .choices(['agent-sdk', 'codex', 'api']),
        )
        .addOption(
          new Option('--max-usd <n>', 'hard ceiling; the run stops before it crosses this')
            .argParser(Number),
        )
        .addOption(new Option('--max-tokens <n>', 'per-run token ceiling').argParser(Number))
        .addOption(
          new Option('--concurrency <n>', 'how many sessions to card at once').argParser(Number),
        )
        .option('-y, --yes', 'skip the estimate confirmation'),
    ),
  ).addHelpText('after', `
example:
  potsherd card --dry-run --all                      # what it would cost, calls nothing
  potsherd card --dry-run --all --json | jq .estimate
  potsherd card --all --max-usd 2
  potsherd card 4c9339e0 --model sonnet
  potsherd card --probe                              # one tiny call: does the backend work?`);
  card.action(async (session: string | undefined, opts: Record<string, unknown>) => {
    const o = globals(program, card, opts);
    await run(
      () =>
        runCard({
          ...o,
          ...filterFlags(opts),
          ...(session ? { session } : {}),
          all: Boolean(opts['all']),
          dryRun: Boolean(opts['dryRun']),
          force: Boolean(opts['force']),
          probe: Boolean(opts['probe']),
          ...(opts['model'] ? { model: String(opts['model']) } : {}),
          ...(opts['backend'] ? { backend: String(opts['backend']) } : {}),
          ...(opts['maxUsd'] !== undefined ? { maxUsd: Number(opts['maxUsd']) } : {}),
          ...(opts['maxTokens'] !== undefined ? { maxTokens: Number(opts['maxTokens']) } : {}),
          ...(opts['concurrency'] !== undefined
            ? { concurrency: Number(opts['concurrency']) }
            : {}),
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
    ['ls', 'every session by title, newest first — ghosts included'],
    ['find', 'search every prompt, every subagent, every deleted session'],
    ['show', 'read one session end to end'],
    ['card', 'summarise each session into a card you can scan'],
    ['stats', 'what is in the index, per harness'],
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
