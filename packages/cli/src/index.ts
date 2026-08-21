import process from 'node:process';
import { Command, Option } from 'commander';
import { Theme, ASK_K, ASK_MAX_USD, ASK_CONCURRENCY } from '@potsherd/core';
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
import { runTag, splitTagOperands } from './commands/tag.js';
import { runPin } from './commands/pin.js';
import { runLink } from './commands/link.js';
import { runAsk } from './commands/ask.js';
import { runGraft } from './commands/graft.js';

import { VERSION } from '@potsherd/core';
export { VERSION };

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
    .option('--linked-to <id>', 'only sessions linked to this one, from either side of the link')
    .option('--untitled', 'only sessions with no card and no title from the harness')
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
    untitled: Boolean(opts['untitled']),
    ...(opts['linkedTo'] ? { linkedTo: String(opts['linkedTo']) } : {}),
    ...(opts['limit'] !== undefined ? { limit: opts['limit'] } : {}),
  };
}

function main(rawArgv: string[]): void {
  // `potsherd tag <id> +postgres -infra` — `-infra` is the five short flags
  // `-i -n -f -r -a` to any getopt-shaped parser, and `-v2` would match the
  // program's own `-v/--version` and exit zero having printed a version
  // number. So the tag operands are lifted out of argv before commander is
  // constructed; see `splitTagOperands` for the rule, which is one sentence.
  const { argv, ops: tagOperands } = splitTagOperands(rawArgv);
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
      .option('--no-vec', 'text search only — the same as --vectors off')
      .option('--explain', 'show the per-list ranks and scores behind the order'),
  ).addHelpText('after', `
example:
  potsherd find "pgbouncer"
  potsherd find "vedic astrology" --json | jq -r '.sessions[0].resume'
  potsherd find "the pooler decision" --vectors on   # force semantic search
  potsherd find "pgbouncer" --explain                # why this order

filters, one example each — they compose, and all of them are AND:
  --project Fulcrum          only that project (a directory name is enough)
  --harness claude           claude, codex, cursor, pi, gemini, opencode
  --since "last week"        2026-08-01 / 2026-08 / 30d / today / in july
  --until 2026-08-15         the same forms; the day itself is included
  --tag postgres             sessions you tagged
  --branch feat/pooler       the git branch the session ran on ("feat/*" ok)
  --file "%/db/%"            sessions that touched a matching path
  --sidechains only          what the subagents did (default: include)
  --ghosts only              only what Claude Code deleted (default: include)
  --pinned                   only the ones you starred
  --status archived          live, archived or ghost

  potsherd find "supabase" --file "%/db/%" --harness claude --since 30d`);
  find.action(async (query: string, opts: Record<string, unknown>) => {
    const o = globals(program, find, opts);
    await run(
      () =>
        runFind({
          ...o,
          ...filterFlags(opts),
          query,
          vec: opts['vec'] !== false,
          explain: Boolean(opts['explain']),
          ...(opts['vectors'] ? { vectors: String(opts['vectors']) } : {}),
        }),
      o,
    );
  });

  const ask = addFilters(
    addGlobals(
      program
        .command('ask')
        .description('answer a question from your own history, with citations that resolve')
        .argument('<question>', 'what you want to know'),
    )
      .option('--file <path>', 'only sessions that touched a path containing this')
      .addOption(new Option('--k <n>', 'sessions to read').argParser(Number).default(ASK_K))
      .option('--strict', 'refuse rather than answer when fewer than 2 quotes survive')
      .addOption(
        new Option('--max-usd <n>', 'stop before crossing this')
          .argParser(Number)
          .default(ASK_MAX_USD),
      )
      .option('--model <name>', 'synthesizer model (default sonnet-class)')
      .option('--reader-model <name>', 'reader model (default haiku-class)')
      .addOption(
        new Option('--concurrency <n>', 'model calls in flight at once')
          .argParser(Number)
          .default(ASK_CONCURRENCY),
      )
      .addOption(
        new Option('--vectors <mode>', 'the vector half of the shortlist (default on)')
          .choices(['auto', 'on', 'off']),
      )
      // NO `.default('auto')` here, unlike `find`. `ask` defaults to
      // vectors-ON in the library and a commander default would silently
      // override it — which it did, for four real runs that all came back
      // "0 answered" on a bm25-only shortlist. See `vectorMode()` in
      // packages/cli/src/commands/ask.ts.
      .option('--no-vec', 'text search only — the same as --vectors off'),
  ).addHelpText('after', `
example:
  potsherd ask "how did we handle pgbouncer with prepared statements?"
  potsherd ask "what did we decide about the pooler?" --project api --since 30d
  potsherd ask "what is the capital of france" --strict     # refuses, exit 2
  potsherd ask "the pooler decision" --json | jq '.evidence | length'
  potsherd ask "why did we drop the queue?" --k 10 --max-usd 0.25

every sentence in ANSWER carries an evidence number. a sentence whose citation
does not resolve to a real quote in a real exchange is dropped by code before
the answer is printed — see  potsherd ask "…" --debug  for what was dropped.

exit codes:  0 answered  ·  1 nothing matched  ·  2 --strict refused`);
  ask.action(async (question: string, opts: Record<string, unknown>) => {
    const o = globals(program, ask, opts);
    await run(
      () =>
        runAsk({
          ...o,
          ...filterFlags(opts),
          question,
          strict: Boolean(opts['strict']),
          vec: opts['vec'] !== false,
          ...(opts['k'] !== undefined ? { k: opts['k'] } : {}),
          ...(opts['maxUsd'] !== undefined ? { maxUsd: opts['maxUsd'] } : {}),
          ...(opts['concurrency'] !== undefined ? { concurrency: opts['concurrency'] } : {}),
          ...(opts['model'] ? { model: String(opts['model']) } : {}),
          ...(opts['readerModel'] ? { readerModel: String(opts['readerModel']) } : {}),
          ...(opts['vectors'] ? { vectors: String(opts['vectors']) } : {}),
        }),
      o,
    );
  });

  const ls = addFilters(
    addGlobals(
      program
        .command('ls')
        .description('every session by title, newest first — ghosts and subagents included')
        .option(
          '--resume-menu',
          'print  claude --resume <id>  # <title>  lines to paste into your shell',
        ),
    ),
  ).addHelpText('after', `
example:
  potsherd ls
  potsherd ls --project Fulcrum --since 30d
  potsherd ls --ghosts only --limit 40               # what the sweep took
  potsherd ls --tag postgres --pinned --since 30d    # filters compose
  potsherd ls --linked-to 4c9339e0                   # both ends of a link
  potsherd ls --untitled                             # what to card next
  potsherd ls --resume-menu                          # pick a session by title
  potsherd ls --harness codex --json | jq -r '.sessions[].displayTitle'

--resume-menu: potsherd does not write into another tool's directory.`);
  ls.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, ls, opts);
    await run(() => runLs({ ...o, ...filterFlags(opts), resumeMenu: Boolean(opts['resumeMenu']) }), o);
  });

  const tag = addGlobals(
    program
      .command('tag')
      .description('add and remove your own tags on a session, in one go')
      .argument('<session>', 'session id, or the first 8 characters of one')
      .argument('[tags...]', '+tag to add, -tag to remove; none at all lists them'),
  ).addHelpText('after', `
example:
  potsherd tag 4c9339e0                              # what it carries now
  potsherd tag 4c9339e0 +postgres +infra
  potsherd tag 4c9339e0 +postgres -mysql             # add and remove at once
  potsherd ls --tag postgres
  potsherd tag 4c9339e0 --json | jq -r '.tags[]'`);
  tag.action(async (session: string, tags: string[], opts: Record<string, unknown>) => {
    const o = globals(program, tag, opts);
    // `-infra` never reaches commander (see splitTagOperands); what does reach
    // the variadic argument is whatever the rewrite left behind, which for a
    // well-formed invocation is nothing.
    await run(() => runTag({ ...o, session, ops: [...tagOperands, ...tags] }), o);
  });

  const pin = addGlobals(
    program
      .command('pin')
      .description('keep a session where you can find it; a ★ marks it in ls')
      .argument('<session>', 'session id, or the first 8 characters of one'),
  ).addHelpText('after', `
example:
  potsherd pin 4c9339e0
  potsherd ls --pinned
  potsherd pin 4c9339e0 --json | jq .pinnedAt`);
  pin.action(async (session: string, opts: Record<string, unknown>) => {
    const o = globals(program, pin, opts);
    await run(() => runPin({ ...o, session }), o);
  });

  const unpin = addGlobals(
    program
      .command('unpin')
      .description('remove a pin')
      .argument('<session>', 'session id, or the first 8 characters of one'),
  ).addHelpText('after', `
example:
  potsherd unpin 4c9339e0`);
  unpin.action(async (session: string, opts: Record<string, unknown>) => {
    const o = globals(program, unpin, opts);
    await run(() => runPin({ ...o, session, remove: true }), o);
  });

  const link = addGlobals(
    program
      .command('link')
      .description('record that two sessions are the same thread of work')
      .argument('<a>', 'session id, or the first 8 characters of one')
      .argument('<b>', 'the other one')
      .option('--note <text>', 'why they belong together')
      .option('--remove', 'delete the link again'),
  ).addHelpText('after', `
example:
  potsherd link 4c9339e0 f1665f76 --note "same pgbouncer fix"
  potsherd ls --linked-to 4c9339e0                   # finds it from either end
  potsherd ls --linked-to f1665f76
  potsherd link 4c9339e0 f1665f76 --remove`);
  link.action(async (a: string, b: string, opts: Record<string, unknown>) => {
    const o = globals(program, link, opts);
    await run(
      () =>
        runLink({
          ...o,
          a,
          b,
          remove: Boolean(opts['remove']),
          ...(opts['note'] ? { note: String(opts['note']) } : {}),
        }),
      o,
    );
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


  const graftCmd = addGlobals(
    program
      .command('graft')
      .description('a token-budgeted brief from one past session, ready to paste into an agent')
      .argument('<session>', 'a session id, the first 8 characters of one, or a query')
      .option('--about <topic>', 'only the exchanges about this topic')
      .addOption(
        new Option('--budget <n>', 'hard ceiling on the brief, in tokens')
          .argParser(Number)
          .default(1200),
      )
      .option('--clip', 'copy the brief to the system clipboard')
      .option('--no-model', 'no model call — the card verbatim, labelled unsummarised')
      .option('--model <name>', 'haiku, sonnet, opus, or an explicit model id')
      .addOption(
        new Option('--backend <name>', 'force a backend instead of detecting one')
          .choices(['agent-sdk', 'codex', 'api']),
      ),
  ).addHelpText('after', `
example:
  potsherd graft 4c9339e0 --about pgbouncer --budget 800
  potsherd graft "instagram client" --clip
  potsherd graft 4c9339e0 --json | jq -r .brief

the brief is written to ./.potsherd/graft-<id8>.md in the current directory —
the one place potsherd writes outside ~/.potsherd — and that directory gets a
generated .gitignore. an existing .gitignore is never overwritten.

with no claude, no codex and no ANTHROPIC_API_KEY, graft still writes a brief:
the stored card verbatim, labelled unsummarised. --no-model asks for that path.`);
  graftCmd.action(async (session: string, opts: Record<string, unknown>) => {
    const o = globals(program, graftCmd, opts);
    await run(
      () =>
        runGraft({
          ...o,
          target: session,
          ...(opts['about'] !== undefined ? { about: String(opts['about']) } : {}),
          ...(opts['budget'] !== undefined ? { budget: Number(opts['budget']) } : {}),
          clip: Boolean(opts['clip']),
          // commander turns `--no-model` into `model: false`, and
          // `--model haiku` into `model: 'haiku'`. Both are wanted.
          ...(opts['model'] !== undefined ? { model: opts['model'] as boolean | string } : {}),
          ...(opts['backend'] !== undefined ? { backend: String(opts['backend']) } : {}),
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
        .option('--ghosts-only', 'only the sessions Claude Code deleted, carded from their prompts')
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
        .option('--export <dir>', 'copy the markdown mirror into this directory and stop')
        .option('-q, --quiet', 'print nothing on success')
        .option('-y, --yes', 'skip the estimate confirmation'),
    ),
  ).addHelpText('after', `
example:
  potsherd card --dry-run --all                      # what it would cost, calls nothing
  potsherd card --dry-run --all --json | jq .estimate
  potsherd card --all --max-usd 2
  potsherd card 4c9339e0 --model sonnet
  potsherd card --ghosts-only --max-usd 2                # only what the sweep deleted
  potsherd card --ghosts-only --limit 10             # a small run first
  potsherd card --export ~/vault/sessions            # copy the markdown mirror out
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
          ghostsOnly: Boolean(opts['ghostsOnly']),
          dryRun: Boolean(opts['dryRun']),
          force: Boolean(opts['force']),
          probe: Boolean(opts['probe']),
          ...(opts['model'] ? { model: String(opts['model']) } : {}),
          ...(opts['backend'] ? { backend: String(opts['backend']) } : {}),
          ...(opts['maxUsd'] !== undefined ? { maxUsd: Number(opts['maxUsd']) } : {}),
          ...(opts['maxTokens'] !== undefined ? { maxTokens: Number(opts['maxTokens']) } : {}),
          ...(opts['export'] ? { export: String(opts['export']) } : {}),
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
    ['tag', 'your own tags on a session: +postgres -mysql'],
    ['pin', 'keep one where you can find it; ★ marks it in ls'],
    ['link', 'record that two sessions are the same thread'],
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
