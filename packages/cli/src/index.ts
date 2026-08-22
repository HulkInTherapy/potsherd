import process from 'node:process';
import { Command, Option } from 'commander';
import { ASK_K, ASK_MAX_USD, ASK_CONCURRENCY } from '@potsherd/core';
import { closeAgentMemoryClients } from '@potsherd/bridges';
import { fail, print, printJson, themeFrom, type GlobalOptions } from './output.js';
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
import { runIgnore } from './commands/ignore.js';
import { runLink } from './commands/link.js';
import { runAsk } from './commands/ask.js';
import { runGraft } from './commands/graft.js';
import { runSetup, SETUP_CLIENTS } from './commands/setup.js';
import { runExport, EXPORT_TARGETS } from './commands/export.js';
import { runStack } from './commands/stack.js';

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

/**
 * The global flags, as they look in argv. Used to decide whether an invocation
 * carries a verb at all: `potsherd --ascii` should print the tour in ASCII, not
 * an empty screen.
 */
const GLOBAL_ONLY =
  /^(--json|--no-color|--ascii|--width|--claude-dir|--potsherd-dir|--debug|\d+|\/.*|~.*)$/;

/** Registered on the program *and* on every verb, so position never matters. */
function addGlobals(cmd: Command): Command {
  // An error inside a verb should point at that verb's help, not at the list
  // of twenty verbs: `potsherd setup --nosuch` used to answer "run potsherd
  // --help for the list of verbs", which is the one page that cannot say what
  // `--nosuch` should have been. `05` asks every error for the one command
  // that fixes it, and for a mistyped flag that command names the verb.
  const name = cmd.name();
  if (name && name !== 'potsherd') {
    // Short enough that the longest verb name still fits 60 columns: `(run
    // potsherd export --help  for its flags and an example)` is 59.
    cmd.showHelpAfterError(`(run  potsherd ${name} --help  for its flags and an example)`);
  }
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
      .option('--embed', 'add semantic search: fetch the 32 MB model once, then embed (~6 min)')
      .option('--no-embed', 'text only, and stop offering --embed (text only is the default)')
      .option('--session <id>', 'index one session id and nothing else')
      .option('-q, --quiet', 'print nothing on success (for hooks)'),
  ).addHelpText('after', `
example:
  potsherd index                                    # text only: no model, no network
  potsherd index --embed                            # ...and semantic search, once
  potsherd index --full
  potsherd index --json | jq .totals`);
  index.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, index, opts);
    await run(
      () =>
        runIndex({
          ...o,
          full: Boolean(opts['full']),
          incremental: Boolean(opts['incremental']),
          // Tri-state, and commander gives all three because both spellings
          // are declared (T8.E): absent = no flag = text only and offer the
          // upgrade, true = --embed, false = --no-embed = text only and stop
          // offering. `!== false` collapsed the first two and made the 32 MB
          // download the default.
          ...(opts['embed'] === undefined ? {} : { embed: Boolean(opts['embed']) }),
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
      .option('--explain', 'show the per-list ranks and scores behind the order')
      .option('--with <tools>', 'also search other memory tools: claude-mem, agentmemory, notes')
      .option('--all', 'include the projects  potsherd ignore  hides'),
  ).addHelpText('after', `
example:
  potsherd find "pgbouncer"
  potsherd find "rate limiter" --json | jq -r '.sessions[0].resume'
  potsherd find "the pooler decision" --vectors on   # force semantic search
  potsherd find "pgbouncer" --explain                # why this order

filters, one example each — they compose, and all of them are AND:
  --project event-bus          only that project (a directory name is enough)
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
          all: Boolean(opts['all']),
          ...(opts['vectors'] ? { vectors: String(opts['vectors']) } : {}),
          ...(opts['with'] ? { with: String(opts['with']) } : {}),
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
      .option('--no-vec', 'text search only — the same as --vectors off')
      // The pair that lets a caller run the reader fan-out itself — Claude
      // Code's native Agent tool, say — and hand the outputs back, so the
      // synthesizer, the citation filter and --strict all run unchanged.
      .option('--readers-out <path>', 'write what the readers would be given to this file; makes no model call')
      .option('--readers-in <path>', 'answer from reader outputs recorded in this file, filter and all'),
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
          ...(opts['readersOut'] ? { readersOut: String(opts['readersOut']) } : {}),
          ...(opts['readersIn'] ? { readersIn: String(opts['readersIn']) } : {}),
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
        )
      .option('--all', 'include the projects  potsherd ignore  hides'),
    ),
  ).addHelpText('after', `
example:
  potsherd ls
  potsherd ls --project event-bus --since 30d
  potsherd ls --ghosts only --limit 40               # what the sweep took
  potsherd ls --tag postgres --pinned --since 30d    # filters compose
  potsherd ls --linked-to 4c9339e0                   # both ends of a link
  potsherd ls --untitled                             # what to card next
  potsherd ls --resume-menu                          # pick a session by title
  potsherd ls --harness codex --json | jq -r '.sessions[].displayTitle'

--resume-menu: potsherd does not write into another tool's directory.`);
  ls.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, ls, opts);
    await run(
      () => runLs({ ...o, ...filterFlags(opts), resumeMenu: Boolean(opts['resumeMenu']), all: Boolean(opts['all']) }),
      o,
    );
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

  const ignore = addGlobals(
    program
      .command('ignore')
      .description('keep a project out of ls, find, ask and stats — never out of the index')
      .argument('[project]', 'a directory name, or a path; none at all prints the list'),
  ).addHelpText('after', `
example:
  potsherd ignore potsherd                           # a directory name
  potsherd ignore ~/work/scratch                     # or a path
  potsherd ignore                                    # what is ignored now
  potsherd unignore potsherd
  potsherd ls --all                                  # everything, this once

a bare name matches that path segment anywhere:  ignore potsherd  hides
/you/code/potsherd and every worktree under it. a name with a slash in it
matches that path and its children, and nothing else.

honoured by  ls, find, ask, stats.  --all overrides it on ls, find and stats;
ask has no --all, so reach an ignored project with  ask --project <name>  or
unignore it. --project always wins: naming a project is asking for it.

nothing is ignored by default, and nothing is ever hidden silently — ls, find
and stats each print how many rows the list cost them, and  potsherd doctor
prints the list itself. index and rescue are not affected: ignoring is a view,
not a deletion, and  potsherd show <id>  still shows an ignored session.

stored in  ~/.potsherd/config.json`);
  ignore.action(async (project: string | undefined, opts: Record<string, unknown>) => {
    const o = globals(program, ignore, opts);
    await run(() => runIgnore({ ...o, ...(project ? { project } : {}) }), o);
  });

  const unignore = addGlobals(
    program
      .command('unignore')
      .description('take a project off the ignore list')
      .argument('<project>', 'the entry as  potsherd ignore  stored it'),
  ).addHelpText('after', `
example:
  potsherd unignore potsherd
  potsherd ignore                                    # what is left`);
  unignore.action(async (project: string, opts: Record<string, unknown>) => {
    const o = globals(program, unignore, opts);
    await run(() => runIgnore({ ...o, project, remove: true }), o);
  });

  const link = addGlobals(
    program
      .command('link')
      .description('record that two sessions are the same thread of work')
      .argument('[a]', 'session id, or the first 8 characters of one')
      .argument('[b]', 'the other one')
      .option('--note <text>', 'why they belong together')
      .option('--remove', 'delete the link again')
      .option('--suggest', 'propose cross-project links to accept by hand; writes nothing'),
  ).addHelpText('after', `
example:
  potsherd link 4c9339e0 f1665f76 --note "same pgbouncer fix"
  potsherd ls --linked-to 4c9339e0                   # finds it from either end
  potsherd ls --linked-to f1665f76
  potsherd link 4c9339e0 f1665f76 --remove
  potsherd link --suggest                            # proposals, nothing written`);
  link.action(async (a: string | undefined, b: string | undefined, opts: Record<string, unknown>) => {
    const o = globals(program, link, opts);
    await run(
      () =>
        runLink({
          ...o,
          ...(a ? { a } : {}),
          ...(b ? { b } : {}),
          remove: Boolean(opts['remove']),
          suggest: Boolean(opts['suggest']),
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
      .option('--md', 'markdown, for pasting into an issue or a note')
      .option('--html', 'one self-contained page: no script, no network, no tracking'),
  ).addHelpText('after', `
example:
  potsherd show 9c4d2f18
  potsherd show 9c4d2f18 --from 12 --to 18
  potsherd show 9c4d2f18 --md > session.md
  potsherd show 9c4d2f18 --html > session.html   # open it in a browser
  potsherd show 9c4d2f18 --json | jq -r '.exchanges[].userText'`);
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
          html: Boolean(opts['html']),
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
      .option('--no-fresh', 'skip the per-file staleness check')
      .option('--all', 'include the projects  potsherd ignore  hides'),
  ).addHelpText('after', `
example:
  potsherd stats
  potsherd stats --json | jq '.harnesses[] | {harness, sessions, ghosts}'`);
  stats.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, stats, opts);
    await run(() => runStats({ ...o, fresh: opts['fresh'] !== false, all: Boolean(opts['all']) }), o);
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

  const setupCmd = addGlobals(
    program
      .command('setup')
      .description("register potsherd's MCP server with the agent you name")
      .option('--claude', 'Claude Code         ~/.claude.json')
      .option('--codex', 'Codex CLI           ~/.codex/config.toml')
      .option('--cursor', 'Cursor              ~/.cursor/mcp.json')
      .option('--gemini', 'Gemini CLI          ~/.gemini/settings.json')
      .option('--opencode', 'opencode            ~/.config/opencode/opencode.json')
      .option('--copilot', 'GitHub Copilot CLI  ~/.copilot/mcp-config.json')
      .option('--pi', 'pi                  ~/.pi/agent/settings.json')
      .option('--all', 'every client above, skipping the ones not installed here')
      .option('--dry-run', 'show the diff and write nothing')
      .option('--status', 'report what is registered where; change nothing')
      .option('--remove', 'remove potsherd again, leaving every other server alone')
      .option('-y, --yes', 'accept the change without asking')
      .option('-q, --quiet', 'drop the closing hint'),
  ).addHelpText('after', `
example:
  potsherd setup --cursor --dry-run                 # the diff, and nothing written
  potsherd setup --cursor
  potsherd setup --all --status
  potsherd setup --claude --remove`);
  setupCmd.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, setupCmd, opts);
    await run(
      () =>
        runSetup({
          ...o,
          clients: SETUP_CLIENTS.filter((id) => Boolean(opts[id])),
          all: Boolean(opts['all']),
          dryRun: Boolean(opts['dryRun']),
          status: Boolean(opts['status']),
          remove: Boolean(opts['remove']),
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
  const exportCmd = addGlobals(
    program
      .command('export')
      .description('write your cards out — to markdown, or into another memory tool')
      .requiredOption('--to <target>', `where to write: ${EXPORT_TARGETS.join(', ')}`)
      .argument('[dir]', 'the directory to write into (markdown)')
      .option('--transcripts', 'also write the full conversations, one file each')
      .addOption(new Option('--limit <n>', 'cap on transcripts written').argParser(Number))
      .option('--yes', 'required to write into another tool’s store'),
  ).addHelpText('after', `
example:
  potsherd export --to markdown ./vault
  potsherd export --to markdown ./vault --transcripts   # cards + full conversations
  potsherd export --to markdown ./vault --json | jq .cards.files
  potsherd export --to agentmemory                      # dry run: says what it would push
  potsherd export --to agentmemory --yes                # actually writes into their store`);
  exportCmd.action(async (dir: string | undefined, opts: Record<string, unknown>) => {
    const o = globals(program, exportCmd, opts);
    await run(
      () =>
        runExport({
          ...o,
          to: String(opts['to']),
          ...(dir ? { dir } : {}),
          transcripts: Boolean(opts['transcripts']),
          ...(opts['limit'] ? { limit: Number(opts['limit']) } : {}),
        }),
      o,
    );
  });

  const stackCmd = addGlobals(
    program
      .command('stack')
      .description('which memory tool covers which failure, and what potsherd does not do')
      .option('--paths', 'print every path detection looked at, including the misses')
      .option('--sources', 'print the url and fetch date behind every row'),
  ).addHelpText('after', `
example:
  potsherd stack                    # the table, against what you have installed
  potsherd stack --sources          # every claim, with the url it was read from
  potsherd stack --paths            # why a tool you have installed reads as absent
  potsherd stack --json | jq '.tools[] | select(.present)'

every row says how far its claim was checked: read off this machine, read out
of a real config file, or from that project's own docs on a printed date.`);
  stackCmd.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, stackCmd, opts);
    await run(
      () =>
        runStack({
          ...o,
          paths: Boolean(opts['paths']),
          sources: Boolean(opts['sources']),
        }),
      o,
    );
  });


  // `potsherd` alone is the tour -- and so is `potsherd --ascii`, `potsherd
  // --width 60` and `potsherd --json`, which are the three spellings anyone
  // taking a screenshot or piping the output actually types. Before this, a
  // global flag with no verb parsed to nothing and printed nothing at all: the
  // program exited 0 having produced an empty screen.
  const globalsOnly = argv.slice(2).every((a) => GLOBAL_ONLY.test(a));
  if (argv.length <= 2 || globalsOnly) {
    const i = argv.indexOf('--width');
    tour({
      ...(i >= 0 && argv[i + 1] ? { width: Number(argv[i + 1]) } : {}),
      ascii: argv.includes('--ascii'),
      color: !argv.includes('--no-color'),
      json: argv.includes('--json'),
    });
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
  } finally {
    // The warm agentmemory server is cached per process and keeps the event
    // loop alive; without this, `export --to agentmemory` and `find --with
    // agentmemory` print their receipt and then never exit.
    closeAgentMemoryClients();
  }
}

/**
 * `potsherd` with no arguments.
 *
 * It used to print all thirteen verbs it had at the time, one per line, in
 * registration order -- which by phase 6 was twenty verbs and no longer a tour
 * but a second `--help`. `plans/05` is specific about the shape this should
 * have instead: *"every verb ends with the next verb. audit -> rescue -> ls ->
 * find -> ask -> graft. the tool teaches itself in the last line of each
 * output."* The no-args screen is the first of those last lines, so it is the
 * path, numbered, and nothing else in the same visual weight.
 *
 * The other fourteen verbs are named -- leaving them out would make the screen
 * a lie about what the product does -- but as one dim wrapped run with the one
 * command that opens any of them. Twenty rows of equal weight teaches nothing
 * about which to type first; six numbered ones and a footnote does.
 *
 * Fits 80x24 with room to spare and re-wraps at 60 (`tests/terminal.test.ts`
 * checks every verb at both widths, and this screen with them).
 */
/**
 * The six, in the order a user meets them. `05`'s path, unchanged.
 *
 * Each carries two glosses. `05` asks for a screen designed at 80 columns that
 * *degrades* to 60, and the long gloss does not fit 60 -- so rather than wrap a
 * table or truncate a sentence mid-word, the narrow rendering drops the
 * repeated `potsherd ` prefix and uses the short gloss. Both say the same
 * thing; the second says it in half the room.
 */
const PATH6: [string, string, string][] = [
  ['audit', 'how many sessions Claude Code has already deleted', 'what Claude Code deleted'],
  ['rescue', 'archive what is left; rebuild the deleted ones as ghosts', 'archive what is left'],
  ['ls', 'every session by title, newest first — ghosts included', 'every session by title'],
  ['find', 'search every prompt, every subagent, every ghost', 'search every prompt'],
  ['ask', 'one answer over the whole archive, with citations', 'one cited answer'],
  ['graft', 'carry a past session into the agent you are in', 'carry one into your agent'],
];

/**
 * The other thirteen, grouped by what they are for rather than by registration
 * order. A flat list of thirteen names teaches nothing; three groups of four or
 * five, each with one gloss, is still one glance.
 */
const REST: [string[], string][] = [
  [['index', 'show', 'stats', 'doctor'], 'the archive, and what is in it'],
  [['card', 'tag', 'pin', 'unpin', 'link', 'guard'], 'what you add to it'],
  [['ignore', 'unignore'], 'projects you would rather not see'],
  [['setup', 'export', 'stack'], 'reaching your other tools'],
];

function tour(o: { width?: number; ascii?: boolean; color?: boolean; json?: boolean } = {}): void {
  const t = themeFrom(o);
  const w = t.width;

  // `--json` on everything, carrying the same data as the human view: the tour
  // is a list of verbs, so that is what it carries.
  if (o.json) {
    printJson({
      version: VERSION,
      path: PATH6.map(([verb, what]) => ({ verb, what })),
      also: REST.flatMap(([verbs, group]) => verbs.map((verb) => ({ verb, group }))),
      start: 'potsherd audit',
    });
    return;
  }

  const wide = w >= 80;
  print('');
  print(
    `  ${t.bold('potsherd')} ${t.dim(VERSION)}  ${t.dim(
      wide
        ? `${t.g('—', '-')} your coding-agent sessions, rescued and searchable`
        : `${t.g('—', '-')} your sessions, rescued and searchable`,
    )}`,
  );
  print('');
  print(`  ${t.dim('the six, in the order you meet them:')}`);
  print('');
  for (const [i, [verb, long, short]] of PATH6.entries()) {
    print(
      wide
        ? `    ${t.dim(String(i + 1))}  potsherd ${verb.padEnd(7)} ${t.dim(long)}`
        : `    ${t.dim(String(i + 1))}  ${verb.padEnd(7)} ${t.dim(short)}`,
    );
  }
  print('');

  const names = REST.map(([verbs]) => verbs.join('  '));
  const col = Math.max(...names.map((n) => n.length));
  // At 80 the gloss sits in its own column; below ~76 there is no room for it
  // and the names wrap on their own, because a wrapped table is worse than a
  // missing gloss (plans/05: "never wraps a table").
  const roomy = w >= 9 + col + 2 + Math.max(...REST.map(([, g]) => g.length));
  REST.forEach(([, gloss], i) => {
    const label = i === 0 ? '  also:  ' : '         ';
    const line = roomy
      ? `${label}${names[i]?.padEnd(col)}  ${gloss}`
      : `${label}${names[i]}`;
    print(t.dim(line));
  });
  print(t.dim(`         potsherd help <verb> for any of them`));
  print('');
  print(`  start here:  ${t.accent('potsherd audit')}`);
  print('');
}

main(process.argv);
