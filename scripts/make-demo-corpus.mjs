#!/usr/bin/env node
/**
 * Builds the **demo corpus**: a complete, entirely synthetic `.claude`
 * directory whose `potsherd audit` output reproduces, number for number, what
 * was measured on the reference machine on 21 aug 2026 (phases/phase-0/
 * HANDOFF.md). Everything committed under `docs/screens/` and every code block
 * in the readme is real command output taken against this corpus.
 *
 *   node scripts/make-demo-corpus.mjs [dest]     # default .tmp/demo-home/.claude
 *
 * Why a demo corpus at all. The reference machine's real corpus is a paying
 * developer's client work: project names, prompts and `/Users/<name>` paths.
 * The repository is public. The choice was between publishing weaker numbers
 * from a toy fixture and publishing the real numbers with somebody's client
 * list attached; this is the third option. The shape, the counts and the
 * distributions are the measured ones. Not one byte of content is.
 *
 * Two rules this file will not break:
 *
 *   1. **Nothing here is derived from a real transcript.** Prompts are built
 *      from a template grid, project names are invented, cwds are `/home/dev`.
 *      The real corpus was read for counts and shapes only, never for text.
 *   2. **Determinism.** No `Math.random` (a seeded mulberry32 instead) and no
 *      `Date.now()` in any *content*: every timestamp written into
 *      history.jsonl or a transcript is anchored to a fixed instant, so two
 *      runs a month apart produce byte-identical files.
 *
 * The one thing that is deliberately relative to the wall clock is **file
 * mtimes**. Claude Code's sweep compares mtime against `cleanupPeriodDays`,
 * so "10 sessions die within 7 days, 3 of them within one day" is only true
 * relative to *now*. Baking absolute mtimes in would make those two numbers
 * decay to zero the week after they were generated. So mtimes are set as
 * `now - <fixed age in days>`, with every age deliberately off an integer
 * boundary by ~0.3 of a day so that the few seconds between generating the
 * corpus and auditing it can never tip a `floor()`.
 *
 * The corpus is a few MB, not the reference machine's 329 MB — the numbers
 * that describe *counts* are reproduced exactly, the one that describes
 * *size* is not, and the readme says so.
 *
 * The script self-verifies: it runs the built binary's `audit --json` against
 * what it just wrote and exits non-zero on the first number that disagrees.
 *
 * ## what phase 1 added
 *
 * `audit` and `rescue` only need counts. `find`, `ls` and `show` need
 * *content*: a corpus of independently generated prompts makes every search
 * result a coincidence, and a screenshot of coincidences teaches nobody what
 * the tool is for. So three things were added, all by **overwriting** existing
 * prompt text so that not one headline count can move:
 *
 *   1. **one thread that runs through the corpus** — a connection-pooling
 *      decision taken in a project the sweep has since wiped, reused twice,
 *      and needed again today in a project that still exists. It gives `find`
 *      a query whose answer is a live session, three ghosts and a subagent,
 *      and `show` a session that reads like a session ({@link HERO}).
 *   2. **titles where a screen can see them** — the measured 21 titled
 *      sessions are spent on the ten the sweep takes next (`audit --sweep`)
 *      and the newest eleven (`ls`), leaving two sdk sessions and two ordinary
 *      ones untitled in the default `ls` view, which is the honest picture.
 *   3. **five generated credentials**, in the two places credentials actually
 *      reach a transcript: a `cat .env` and a CI log, plus one dsn pasted into
 *      a prompt. Without them `index` prints "secrets masked 0", which
 *      demonstrates nothing about the redactor.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

// ---------------------------------------------------------------- the targets
// Measured on the reference machine, 21 aug 2026. `potsherd audit --json` over
// the generated corpus must reproduce every one of these.
const TARGET = {
  sessionsEver: 330,
  onDisk: 31,
  deleted: 299,
  promptsLost: 2971,
  projectsWiped: 33,
  historyRange: 'nov 2025 -> aug 2026',
  sidechainFiles: 197,
  titledSessions: 21,
  sdkSessions: 3,
  sessionsIndexFiles: 4,
  memoryFiles: 45,
  nextSweepWithin7Days: 10,
  nextSweepWithinOneDay: 3,
  cleanupPeriodDays: null, // unset
};

/**
 * The instant every *content* timestamp is measured back from. Fixed, not
 * `Date.now()`: it is what keeps "nov 2025 -> aug 2026" true forever and the
 * output byte-identical between runs.
 */
const ANCHOR = Date.parse('2026-08-21T14:00:00.000Z');
/** The first prompt ever typed on this notional machine. */
const FIRST_PROMPT_TS = Date.parse('2025-11-04T10:12:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

/** Claude Code's default. The corpus leaves the key unset, so this applies. */
const CLEANUP_DAYS = 30;

/**
 * `sessions-index.json` records an absolute path. The corpus is generated into
 * a throwaway directory whose name differs per run and per machine, so a
 * notional home keeps the file stable — nothing reads the field.
 */
const NOTIONAL_HOME = '/home/dev/.claude';
const DEV = '/home/dev';

const CLAUDE_VERSIONS = ['2.1.217', '2.1.223', '2.1.229', '2.1.231', '2.1.237'];
const MODELS = [
  'claude-opus-4-6-20260214',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
];
const BRANCHES = ['main', 'develop', 'feat/retry-budget', 'fix/flaky-e2e', 'chore/deps'];

// ------------------------------------------------------------------- projects
//
// Ten projects with at least one surviving transcript, and thirty-three whose
// every session the sweep already took. Flat under /home/dev: no project is a
// subdirectory of another, so `audit`'s wiped-project roll-up has nothing to
// merge and the count is exactly the list length.

const ALIVE_PROJECTS = [
  ['notes-api', 6],
  ['billing-web', 5],
  ['search-index', 4],
  ['mobile-shell', 3],
  ['infra-terraform', 3],
  ['event-bus', 3],
  ['docs-site', 2],
  ['report-builder', 2],
  ['auth-gateway', 2],
  ['data-pipeline', 1],
];

/**
 * The wiped projects, session counts first. The head of this list is what the
 * audit card prints, so it has to read like a working developer's machine and
 * not like a fixture: one project that ate a year, a few real efforts, then a
 * long tail of one-afternoon directories.
 */
const WIPED_PROJECTS = [
  ['payments-api', 44],
  ['crm-ingest', 28],
  ['agent-runner', 22],
  ['portfolio-site', 22],
  ['shelf-cli', 21],
  ['infant-vision', 16],
  ['hive-scheduler', 11],
  ['lesson-graph', 9],
  ['canon-driver', 7],
  ['webhook-relay', 7],
  ['tile-server', 7],
  ['resume-parser', 7],
  ['quiz-engine', 7],
  ['plugin-host', 7],
  ['ocr-bench', 7],
  ['note-sync', 6],
  ['mesh-router', 6],
  ['log-distiller', 6],
  ['kanban-board', 6],
  ['image-lab', 5],
  ['glyph-editor', 5],
  ['form-builder', 5],
  ['feed-reader', 5],
  ['edge-cache', 5],
  ['dotfiles', 4],
  ['cron-board', 4],
  ['chat-widget', 4],
  ['blog-engine', 3],
  ['bench-suite', 3],
  ['audio-tagger', 3],
  ['asset-cdn', 4],
  ['api-docs', 2],
  ['alert-router', 1],
];

/**
 * Days of age for each of the 31 surviving transcripts, oldest first. Against
 * a 30-day sweep this is exactly ten transcripts with <= 7 days left and three
 * with <= 1. Every value sits about a third of a day away from an integer so
 * the seconds between generating and auditing cannot move a `floor()`.
 */
const SESSION_AGES_DAYS = [
  29.8, 29.5, 29.2,                          // 3 x daysLeft 1
  28.6, 27.5, 26.5, 25.5, 24.5, 23.8, 23.3,  // 7 x daysLeft 2..7
  22.5, 21.4, 20.3, 19.6, 18.5, 17.4, 16.3, 15.5, 14.4, 13.3,
  12.5, 11.4, 10.3, 9.5, 8.4, 7.3, 6.5, 5.4, 4.3, 2.5, 0.4,
];

/** Indices into the age list that are SDK-driven: no title, never in history. */
const SDK_INDICES = new Set([12, 19, 26]);
/**
 * Which surviving sessions carry an `ai-title`. The measured count is 21 and
 * that is what the self-check enforces; *which* 21 is free, and two screens
 * need it spent in different places:
 *
 *   - `audit --sweep` names the ten sessions the sweep takes next, so indices
 *     0..9 (the oldest, and therefore the doomed) are all titled;
 *   - `ls` is "the archive, finally legible" and shows the fifteen *newest*
 *     first, so the remaining eleven go to the top of the list rather than
 *     being scattered through the middle where no screen ever sees them.
 *
 * What is deliberately left untitled in that top fifteen: the two sdk-driven
 * sessions (19, 26 — an sdk run never gets an `ai-title`) and two ordinary
 * ones. `ls` falls back to `project-<id8>` for those, which is the honest
 * thing for it to do and is worth having on the screen.
 */
const TITLED_INDICES = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  18, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30,
]);

/** How many subagent transcripts hang off each surviving session (sums to 197). */
const SIDECHAIN_COUNTS = [
  16, 13, 9, 3, 8, 2, 7, 14, 5, 4,
  6, 9, 0, 7, 3, 11, 2, 8, 4, 0,
  6, 5, 11, 3, 7, 2, 9, 0, 8, 6, 9,
];

/** `memory/*.md` counts, by project-directory index (sums to 45). */
const MEMORY_COUNTS = [7, 6, 5, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 0, 0, 0];

/** How many ghosts get a title back out of a surviving sessions-index.json. */
const GHOSTS_WITH_TITLES = 19;

// ------------------------------------------------------------------ text pool
//
// Prompts are assembled from a grid, never copied. Nothing in these lists came
// out of anybody's transcript; they are the kinds of sentence a backend/tooling
// developer types, written for this file.

const PROMPT_SHAPES = [
  (s) => `why is ${s} slower than it was last week?`,
  (s) => `add a test that covers ${s}`,
  (s) => `${s} is failing in CI but passes locally — ideas?`,
  (s) => `refactor ${s} so the retry logic lives in one place`,
  (s) => `write the migration for ${s}`,
  (s) => `explain what ${s} is doing on line 140`,
  (s) => `can we cache ${s} without breaking invalidation?`,
  (s) => `what breaks if I delete ${s}?`,
  (s) => `document ${s} in the readme`,
  (s) => `${s} throws on empty input — fix it and add the case`,
  (s) => `split ${s} into a pure function and an io wrapper`,
  (s) => `benchmark ${s} before and after the change`,
  (s) => `is ${s} safe to run twice?`,
  (s) => `add structured logging around ${s}`,
  (s) => `rename ${s} everywhere, including the tests`,
  (s) => `${s} needs a timeout. what is a sane default?`,
  (s) => `review ${s} for race conditions`,
  (s) => `port ${s} to the new config loader`,
  (s) => `why does ${s} allocate so much?`,
  (s) => `make ${s} idempotent`,
  (s) => `write a smoke test for ${s}`,
  (s) => `${s} regressed after the upgrade — bisect it`,
  (s) => `add a feature flag around ${s}`,
  (s) => `trace one request through ${s} and show me the hops`,
  (s) => `what is the blast radius of changing ${s}?`,
  (s) => `simplify ${s}; it has four levels of nesting`,
  (s) => `add metrics to ${s} so we can alert on it`,
  (s) => `${s} returns 500 on the retry path. reproduce it`,
  (s) => `move ${s} behind an interface so we can fake it`,
  (s) => `check ${s} for off-by-one in the pagination`,
  (s) => `write the rollback plan for ${s}`,
  (s) => `${s} leaks a file handle somewhere. find it`,
  (s) => `turn ${s} into a background job`,
  (s) => `what does ${s} do when the disk is full?`,
  (s) => `add input validation to ${s}`,
  (s) => `update ${s} for the breaking change in v3`,
  (s) => `why is ${s} not covered by the type checker?`,
  (s) => `batch the writes in ${s}`,
  (s) => `${s} should stream instead of buffering. rewrite it`,
  (s) => `add a dry-run mode to ${s}`,
  () => 'ship it',
  () => 'run the tests',
  () => 'keep going',
  () => 'that broke the build — revert the last change',
  () => 'commit this with a message that explains why',
  () => 'show me the diff before you write anything',
  () => 'what would you do differently here?',
  () => 'no, keep the old behaviour behind the flag',
  () => 'summarise what changed in this session',
  () => 'open a pr against develop',
];

const PROMPT_SUBJECTS = [
  'the retry budget', 'the connection pool', 'the webhook receiver', 'the cache warmer',
  'the auth middleware', 'the csv importer', 'the rate limiter', 'the job scheduler',
  'the migration runner', 'the health check', 'the config loader', 'the token refresh',
  'the pagination helper', 'the queue consumer', 'the metrics exporter', 'the audit log',
  'the search indexer', 'the thumbnail worker', 'the session store', 'the feature flag client',
  'the checkout flow', 'the invoice renderer', 'the email templater', 'the sms fallback',
  'the file uploader', 'the schema validator', 'the changelog generator', 'the release script',
  'the docker entrypoint', 'the terraform module', 'the deploy hook', 'the backup job',
  'the seed script', 'the fixture loader', 'the test harness', 'the mock server',
  'the graphql resolver', 'the websocket bridge', 'the event replayer', 'the dead-letter queue',
  'the ocr pipeline', 'the pdf splitter', 'the image resizer', 'the audio transcoder',
  'the crawler', 'the sitemap builder', 'the rss parser', 'the markdown renderer',
  'the cli argument parser', 'the progress bar', 'the log formatter', 'the error reporter',
];

/**
 * `ai-title` is a sentence Claude Code writes about the session, so the pool
 * has to be wide enough that `audit --sweep` lists twenty of them without
 * reading like a mail merge.
 */
const TITLE_SHAPES = [
  (s) => `Fix ${s} timeout handling`,
  (s) => `Add tests for ${s}`,
  (s) => `Refactor ${s} into two passes`,
  (s) => `Investigate ${s} regression`,
  (s) => `Document ${s}`,
  (s) => `Make ${s} idempotent`,
  (s) => `Speed up ${s}`,
  (s) => `Harden ${s} against bad input`,
  (s) => `Migrate ${s} to the new loader`,
  (s) => `Instrument ${s} with metrics`,
  (s) => `Batch writes in ${s}`,
  (s) => `Add a dry-run mode to ${s}`,
  (s) => `Trace a request through ${s}`,
  (s) => `Untangle ${s} error handling`,
  (s) => `Cache ${s} results safely`,
  (s) => `Rewrite ${s} to stream`,
  (s) => `Bisect the ${s} regression`,
  (s) => `Give ${s} a rollback path`,
  (s) => `Pin ${s} behind a feature flag`,
  (s) => `Find the leak in ${s}`,
  (s) => `Validate input to ${s}`,
  (s) => `Split ${s} into io and logic`,
  (s) => `Fix pagination in ${s}`,
  (s) => `Move ${s} to a background job`,
  (s) => `Stop ${s} double-writing`,
  (s) => `Add a timeout to ${s}`,
  (s) => `Reduce allocations in ${s}`,
  (s) => `Cover ${s} with a smoke test`,
];

const AGENT_NAMES = [
  'code-reviewer', 'test-writer', 'schema-checker', 'perf-profiler', 'doc-writer',
  'dependency-auditor', 'log-reader', 'migration-planner', 'flake-hunter', 'api-differ',
];

const ASSISTANT_LINES = [
  'Reading the file first so the edit lands in the right place.',
  'Two things are going on here; the second one is the actual bug.',
  'Done. The test fails before the change and passes after it.',
  'That path is only reachable when the cache is cold.',
  'I moved the retry into the caller so the timeout is not doubled.',
  'The allocation is in the loop, not the parser.',
  'Added the guard and a regression test for the empty case.',
  'This is safe to run twice: the write is keyed on the source path.',
  'Reverted. The build is green again.',
  'The type error was real — the field is optional upstream.',
];

const TOOL_NAMES = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Glob'];

const MEMORY_TOPICS = [
  'decisions', 'conventions', 'gotchas', 'deploy', 'testing', 'schema',
  'perf-notes', 'open-questions', 'runbook', 'glossary',
];

// ------------------------------------------------------------- the planted thread
//
// A grid of independent prompts is enough to make `audit` and `rescue` true,
// but not enough to make `find`, `show` and `ls` mean anything: search is only
// legible when several sessions are about the *same* thing and one of them has
// been deleted. So one story runs through the corpus — a connection-pooling
// decision taken in a project the sweep has since wiped, then re-applied twice,
// and finally needed again today in a project that still exists.
//
// It is planted by *overwriting* prompt text, never by adding prompts: every
// headline count (2,971 lost, 299 ghosts, 330 ever) is a target the self-check
// enforces, and content must not be able to move one.
//
// Every line below was written for this file. None of it is from a transcript.

/**
 * The live session `show` and `find` land on. Its id is fixed rather than
 * drawn from the PRNG so the readme can name it and stay right.
 */
const HERO = {
  id: '9c4d2f18-7a3b-4e05-b6d1-0f2a58e17c43',
  /** Index into SESSION_AGES_DAYS: the newest surviving session (data-pipeline). */
  index: 30,
  title: 'Pool the ingest workers through pgbouncer',
  exchanges: [
    {
      text: 'the ingest workers open one postgres connection per task and we are hitting max_connections again',
      assistant: 'Confirmed from the pool metrics: 412 slots requested against a 400 limit at peak, so the workers queue and then time out.',
      tool: 'Bash',
      file: 'workers/ingest.ts',
    },
    {
      text: 'put pgbouncer in front of it in transaction pooling mode',
      assistant: 'That will hold, but transaction pooling drops session state: SET, LISTEN/NOTIFY and server-side prepared statements stop surviving a transaction boundary.',
      tool: 'Read',
      file: 'db/pool.ts',
    },
    {
      text: 'we hit the prepared statement problem before, in payments-api. what did we land on?',
      assistant: 'Nothing about it is in this repository. The change here is one line either way: the client has to stop preparing, which is statement_cache_size=0.',
      tool: 'Grep',
      file: 'db/pool.ts',
    },
    {
      text: 'set statement_cache_size to 0 and add a test that runs two transactions over one server connection',
      assistant: 'Done. The test fails against the old client config with "prepared statement already exists" and passes with the cache disabled.',
      tool: 'Edit',
      file: 'db/pool.ts',
    },
    {
      text: 'what happens to an in-flight batch when pgbouncer restarts?',
      assistant: 'The client sees a closed connection rather than a rollback, so a retry replays a partially applied batch unless the writer is idempotent.',
      tool: 'Read',
      file: 'workers/ingest.ts',
    },
    {
      text: 'make the batch writer idempotent then — key it on the source digest',
      assistant: 'Keyed on the sha256 of the source file plus the row offset, so a replay is a no-op instead of a double insert.',
      tool: 'Edit',
      file: 'workers/ingest.ts',
    },
    {
      text: 'write the pooling decision down in the readme so nobody relearns it a third time',
      assistant: 'Added a "connection pooling" section: transaction mode, pool_size 24, and statement_cache_size=0 called out as a requirement rather than a tuning knob.',
      tool: 'Write',
      file: 'docs/pooling.md',
    },
    {
      text: 'run the suite and commit',
      assistant: 'All green: 214 passed. Committed as "ingest: pool through pgbouncer in transaction mode".',
      tool: 'Bash',
      file: 'workers/ingest.ts',
    },
  ],
};

/** The subagent the hero session sent off to check the claim. */
const HERO_SIDECHAIN = 'check whether any driver in the repo still prepares statements server-side under pgbouncer';

/**
 * ## what phase 4 added: the other side of the thread
 *
 * `ask`'s open-thread pass (T4.2) answers *"decided in A, never seen in B"*,
 * and it can only ever answer it when the corpus actually holds such a pair:
 * a project that made a decision, and **a sibling project the same decision
 * applies to that never made it.** Everything the corpus had before this was
 * one thread and its own history — `data-pipeline` decides, and the three
 * projects the sweep wiped had already decided the same thing. That is a
 * *closed* thread, and the rule pass is right to raise nothing from it.
 *
 * So: `event-bus` also runs postgres workers behind the same pooler, in the
 * same transaction pooling mode, and reached it from the other end — it ran
 * out of connections, moved its consumers behind the pooler, sized the pool
 * and put a timeout on acquiring one. It never asked what transaction pooling
 * *breaks*, so nothing in it says anything about prepared statements or
 * `statement_cache_size`. That is the open thread, and it is the shape
 * `plans/05` §4 names: *"decided in one project, never applied to the next"*.
 *
 * Two deliberate constraints on the text below, both of which the screens
 * depend on:
 *
 *   1. **The word `pgbouncer` never appears in it.** `find pgbouncer` is a
 *      committed screen (`docs/screens/09-find.txt`) whose whole point is one
 *      live session, three the sweep deleted and one subagent; a fourth live
 *      hit would rewrite it. It is also the more honest test: these two
 *      projects share no *search* vocabulary at all, so nothing a text query
 *      returns would ever have connected them, and the connection has to come
 *      from the cards. Which is what the open-thread pass is for.
 *   2. **Nothing here mentions prepared statements, session state or
 *      statement caching** — not even as a question. `open-threads.ts` counts
 *      an open thread in B as B *knowing about* the question and withdraws the
 *      candidate, correctly. A corpus that hinted at it would be a corpus
 *      whose catch was staged.
 *
 * Planted by overwrite, like the hero and the leaks: {@link SIBLING.index}'s
 * drawn length is exactly {@link SIBLING.exchanges}'s, so not one count moves.
 *
 * Every line below was written for this file. None of it is from a transcript.
 */
const SIBLING = {
  /**
   * Index into SESSION_AGES_DAYS: the middle of `event-bus`'s three surviving
   * sessions, 10.3 days old and titled. Titled matters — it is inside `ls`'s
   * newest fifteen, so the session the open thread points at is one a reader
   * of these screens has already seen by name.
   */
  index: 22,
  title: 'Move the event-bus consumers behind the pooler',
  exchanges: [
    {
      text: 'the delivery consumers open a postgres connection each and the box is out of them at sixty in flight',
      assistant: 'Each consumer holds its own connection for the whole delivery, so sixty in flight wants sixty slots and the database is configured for forty.',
      tool: 'Bash',
      file: 'consumers/deliver.ts',
    },
    {
      text: 'point the consumers at the pooler instead of straight at postgres',
      assistant: 'Done: the consumers dial the pooler on 6432 rather than postgres on 5432. It is running in transaction pooling mode, so a connection goes back to the pool at the end of every transaction.',
      tool: 'Edit',
      file: 'db/pool.ts',
    },
    {
      text: 'what pool_size does the pooler need to carry sixty consumers?',
      assistant: 'Twenty-four server connections carried all sixty at peak with no queue wait, so pool_size 24 with a reserve pool of 4.',
      tool: 'Read',
      file: 'db/pool.ts',
    },
    {
      text: 'a consumer that cannot get a connection should fail rather than hang',
      assistant: 'Five-second acquire timeout on the client. A consumer that misses it nacks the delivery and the broker redelivers it.',
      tool: 'Edit',
      file: 'consumers/deliver.ts',
    },
    {
      text: 'run the load test and write the numbers into the runbook',
      assistant: 'Sixty consumers over 4,000 deliveries: p99 acquire 41ms, no timeouts, database connections flat at 24. Written up under "connections".',
      tool: 'Bash',
      file: 'docs/runbook.md',
    },
  ],
};

/**
 * The same thread as the sweep left it: prompts only, in three projects whose
 * every transcript is gone. `title` is written into the surviving
 * `sessions-index.json`, which is the only way a ghost gets a name back.
 */
const GHOST_THREADS = [
  {
    project: 'payments-api',
    title: 'Move payments-api onto pgbouncer',
    prompts: [
      'postgres is refusing connections under load. is a pooler the answer or do we fix the app first?',
      'compare pgbouncer session pooling against transaction pooling for a worker pool this shape',
      'if we go with transaction pooling, list everything that stops working',
      'server-side prepared statements are failing behind pgbouncer — what are the options?',
      'set statement_cache_size=0 in the client and prove it clears the prepared statement error',
      'write the pooling decision up so the next project does not redo this from scratch',
    ],
  },
  {
    project: 'crm-ingest',
    title: 'Put the importer behind the pooler',
    prompts: [
      'copy the pgbouncer setup from payments-api onto the importer',
      'the importer still opens a connection per row — move it behind the pooler',
      // `{DSN}` is substituted with a generated connection string. Pasting a
      // live dsn into a prompt is the commonest way a transcript ends up
      // holding a credential, and it is what the redactor exists for.
      'the importer cannot reach the pooler — {DSN} times out but the direct port is fine',
      'what is a sane pgbouncer pool_size for twelve importer workers?',
    ],
  },
  {
    project: 'agent-runner',
    title: 'Keep LISTEN/NOTIFY off the pooler',
    prompts: [
      'pgbouncer transaction pooling broke LISTEN/NOTIFY in the runner',
      'move the notify path onto its own direct connection, outside the pooler',
    ],
  },
];

// ------------------------------------------------------------ planted secrets
//
// A corpus with no credentials in it makes `index` print "secrets masked 0",
// which proves nothing. Real transcripts are full of them — phase 1 found five
// live api keys in the reference machine's own history — so the demo corpus
// carries a few too, and the screens show redaction actually firing.
//
// They are generated from the seeded PRNG rather than written out as literals:
// the shapes are what the rule pack matches, and no string that looks like a
// key is committed to this repository. Each one is planted where a real one
// leaks from — a `cat .env`, a CI log, a pasted curl — not in prose.

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// ------------------------------------------------------------------- plumbing

/** mulberry32 — 32 bits of state, no dependencies, identical on every runtime. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(0x50_74_53_64); // "PtSd"
const pick = (xs) => xs[Math.floor(rnd() * xs.length) % xs.length];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/** A v4-shaped uuid drawn from the seeded PRNG, so ids are stable per run. */
function uuid() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) {
    if (i === 12) s += '4';
    else if (i === 16) s += hex[8 + Math.floor(rnd() * 4)];
    else s += hex[Math.floor(rnd() * 16)];
  }
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** `n` characters from an alphabet, drawn from the seeded PRNG. */
function token(n, alphabet = ALNUM) {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
}

/**
 * The credentials the corpus leaks. Generated, not written down: each has the
 * shape its rule matches (`packages/core/src/redact-rules.ts`, ported from
 * gitleaks and secretlint), and none of them is a string this repository
 * stores. They authorise nothing anywhere.
 */
const SECRETS = {
  aws: `AKIA${token(16, UPPER_ALNUM)}`,
  stripe: `sk_live_${token(24)}`,
  gcp: `AIza${token(35)}`,
  github: `ghp_${token(36)}`,
  pgPassword: token(24),
};

/**
 * Where they leak from. Each entry rewrites one exchange of one surviving
 * session — a `cat .env` and a CI log, which is how a key reaches a transcript
 * in practice. Nothing is appended, so no count moves.
 */
const PLANTED_LEAKS = [
  {
    // Fixed, like the hero's, so `make-screens.sh` and the readme can name the
    // session whose transcript holds a credential and show it masked.
    id: 'd3e6b7a1-5c04-4f92-9a83-27b6e0d418ca',
    index: 27,
    exchange: 0,
    text: 'the nightly deploy job is 403ing against the bucket. what does it actually load?',
    assistant: 'The job reads .env at startup and the aws key in it is not the one the bucket policy names.',
    tool: 'Bash',
    file: '.env',
    result: [
      'AWS_ACCESS_KEY_ID=' + SECRETS.aws,
      'AWS_DEFAULT_REGION=eu-west-1',
      'STRIPE_SECRET_KEY=' + SECRETS.stripe,
      'GOOGLE_API_KEY=' + SECRETS.gcp,
      'REPORT_BUCKET=reports-nightly',
    ].join('\n'),
  },
  {
    index: 21,
    exchange: 0,
    text: 'the release workflow fails at the publish step. paste me what it printed',
    assistant: 'The workflow echoes its environment before publishing, so the token is in the log; that is a second bug.',
    tool: 'Bash',
    file: '.github/workflows/release.yml',
    result: [
      'Run npm publish --access public',
      '  env:',
      '    GITHUB_TOKEN=' + SECRETS.github,
      'npm error code E401',
    ].join('\n'),
  },
];

/**
 * Session ids that are pinned rather than drawn: the two sessions the readme
 * and `make-screens.sh` name by id. Everything else gets a PRNG id.
 */
const FIXED_IDS = new Map([
  [HERO.index, HERO.id],
  ...PLANTED_LEAKS.filter((l) => l.id).map((l) => [l.index, l.id]),
]);

const slugify = (cwd) => cwd.replace(/\//g, '-');
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

function promptText() {
  const shape = pick(PROMPT_SHAPES);
  return shape(pick(PROMPT_SUBJECTS));
}

function titleText() {
  return pick(TITLE_SHAPES)(pick(PROMPT_SUBJECTS).replace(/^the /, ''));
}

/**
 * A long-tailed count of prompts per session: most sessions are a handful of
 * exchanges, a few run for days. `total` is hit exactly by walking the list
 * afterwards, because the headline number must be the measured one and not
 * whatever a distribution happened to produce.
 */
function promptCounts(n, total, forced = []) {
  const counts = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i < forced.length) { counts[i] = forced[i]; continue; }
    const u = rnd();
    counts[i] = Math.min(64, 1 + Math.floor(-Math.log(1 - u) * 8.5));
  }
  const fixedFrom = forced.length;
  let sum = counts.reduce((a, b) => a + b, 0);
  let cursor = fixedFrom;
  while (sum !== total) {
    const step = sum < total ? 1 : -1;
    if (step === -1 && counts[cursor] <= 1) {
      cursor = fixedFrom + ((cursor - fixedFrom + 1) % (n - fixedFrom));
      continue;
    }
    counts[cursor] += step;
    sum += step;
    cursor = fixedFrom + ((cursor - fixedFrom + 1) % (n - fixedFrom));
  }
  return counts;
}

// -------------------------------------------------------------------- writing

const dest = path.resolve(process.argv[2] ?? path.join(repo, '.tmp', 'demo-home', '.claude'));
const NOW = Date.now(); // mtimes only — never written into any file's content
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.join(dest, 'projects'), { recursive: true });

const projectsDir = path.join(dest, 'projects');
const projDir = (cwd) => path.join(projectsDir, slugify(cwd));

/** Every file we must stamp an mtime onto, once the whole tree exists. */
const mtimes = [];
const touch = (file, ms) => mtimes.push([file, ms]);

// ---------------------------------------------------------- surviving sessions

const aliveSessions = [];
{
  let idx = 0;
  for (const [name, count] of ALIVE_PROJECTS) {
    const cwd = `${DEV}/${name}`;
    for (let k = 0; k < count; k++) {
      const ageDays = SESSION_AGES_DAYS[idx];
      // uuid() is called for every session, fixed or not, so that pinning an
      // id cannot shift the PRNG stream every other id is drawn from.
      const drawn = uuid();
      aliveSessions.push({
        idx,
        id: FIXED_IDS.get(idx) ?? drawn,
        cwd,
        slug: slugify(cwd),
        ageDays,
        // Content timestamps hang off the fixed anchor; only the mtime hangs
        // off the wall clock. On the day this was written the two coincide.
        startedAt: ANCHOR - ageDays * DAY - 40 * MIN,
        mtimeAt: NOW - ageDays * DAY,
        sdk: SDK_INDICES.has(idx),
        titled: TITLED_INDICES.has(idx),
        sidechains: SIDECHAIN_COUNTS[idx],
        version: CLAUDE_VERSIONS[idx % CLAUDE_VERSIONS.length],
        branch: BRANCHES[idx % BRANCHES.length],
        prompts: [],
        title: null,
      });
      idx++;
    }
  }
  if (idx !== SESSION_AGES_DAYS.length) {
    throw new Error(`alive project counts sum to ${idx}, expected ${SESSION_AGES_DAYS.length}`);
  }
}

// Prompts for the sessions that survived. Their count is not one of the
// headline targets (only `prompts lost` is), so it is free to be plausible.
for (const s of aliveSessions) {
  // between() is called unconditionally: the hero's fixed length must not move
  // the PRNG stream the other thirty sessions draw from.
  const drawn = between(3, 12);
  const n = s.idx === HERO.index ? HERO.exchanges.length : drawn;
  // Cumulative, not `i * gap`: a fresh jitter multiplied by the index runs
  // backwards as often as forwards, and `show` prints the clock on every
  // exchange, so a non-monotonic session is visible on the screen.
  let t = s.startedAt;
  for (let i = 0; i < n; i++) {
    const gap = 7 * MIN + between(0, 400) * 1000;
    s.prompts.push({ ts: t, text: promptText() });
    t += gap;
  }
  if (s.titled) s.title = titleText();
}

// The planted thread and the planted leaks, both by overwrite.
{
  const hero = aliveSessions[HERO.index];
  hero.title = HERO.title;
  for (const [i, ex] of HERO.exchanges.entries()) Object.assign(hero.prompts[i], ex);

  // The other side of the thread. Unlike the hero, this one does *not* pin its
  // session's length: it overwrites in place, so the drawn count has to be at
  // least as long as the thread or a headline count would move underneath it.
  const sibling = aliveSessions[SIBLING.index];
  if (sibling.prompts.length < SIBLING.exchanges.length) {
    throw new Error(
      `sibling thread: session ${SIBLING.index} drew ${sibling.prompts.length} exchanges, ` +
        `the thread needs ${SIBLING.exchanges.length}`,
    );
  }
  sibling.title = SIBLING.title;
  for (const [i, ex] of SIBLING.exchanges.entries()) Object.assign(sibling.prompts[i], ex);

  let leaked = 0;
  for (const leak of PLANTED_LEAKS) {
    const s = aliveSessions[leak.index];
    const p = s.prompts[leak.exchange];
    if (!p) throw new Error(`leak target ${leak.index}/${leak.exchange} has no exchange`);
    const { id, index, exchange, ...rest } = leak;
    Object.assign(p, rest);
    leaked++;
  }
  if (leaked !== PLANTED_LEAKS.length) throw new Error('a planted leak found no home');
}

// ------------------------------------------------------------ deleted sessions

const deletedSessions = [];
{
  // 44 prompts in one project, 241 in one session: the reference machine's
  // shape. The big session goes first so `promptCounts` can pin it.
  const total = TARGET.deleted;
  const counts = promptCounts(total, TARGET.promptsLost, [241]);

  // Spread the 299 starts evenly across the deleted window: the first prompt
  // ever (nov 2025) up to a month before the anchor, because anything newer
  // than `cleanupPeriodDays` would still be on disk.
  const lastDeleted = ANCHOR - 31.5 * DAY;
  const span = lastDeleted - FIRST_PROMPT_TS;

  const order = [];
  for (const [name, n] of WIPED_PROJECTS) for (let i = 0; i < n; i++) order.push(name);
  if (order.length !== total) {
    throw new Error(`wiped project counts sum to ${order.length}, expected ${total}`);
  }
  // Interleave, so no project owns one contiguous block of history.
  const shuffled = order.map((name, i) => ({ name, key: (i * 137 + 61) % order.length }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.name);

  // The 241-prompt session is the one everybody notices, and on the reference
  // machine it belonged to the project that also owned the most sessions.
  // `promptCounts` pins the big count at index 0, so move it onto the first
  // payments-api session rather than moving that session between projects —
  // reassigning a cwd here would quietly make one project's tally wrong.
  const bigIdx = shuffled.indexOf('payments-api');
  [counts[0], counts[bigIdx]] = [counts[bigIdx], counts[0]];

  for (let i = 0; i < total; i++) {
    const cwd = `${DEV}/${shuffled[i]}`;
    deletedSessions.push({
      id: uuid(),
      cwd,
      slug: slugify(cwd),
      // i === 0 lands exactly on the first prompt ever typed, which is what
      // makes the card's history range read `nov 2025 -> aug 2026`.
      startedAt: FIRST_PROMPT_TS + Math.round((i / (total - 1)) * span),
      promptCount: counts[i],
      prompts: [],
      title: null,
    });
  }
  for (const g of deletedSessions) {
    let t = g.startedAt;
    for (let i = 0; i < g.promptCount; i++) {
      const gap = 9 * MIN + between(0, 600) * 1000;
      g.prompts.push({ ts: t, text: promptText() });
      t += gap;
    }
  }

  // The deleted half of the planted thread. The first ghost in each project is
  // taken because it is also the one the surviving `sessions-index.json` still
  // names, which is the only route by which a deleted session gets its title
  // back — exactly the path `find` shows off.
  const dsn = `postgres://ingest:${SECRETS.pgPassword}@db.internal:6432/crm`;
  // Ascending, because deletedSessions is in start order and the thread has to
  // read forwards: the decision is taken, then reused, then it bites.
  let after = -1;
  for (const thread of GHOST_THREADS) {
    const at = deletedSessions.findIndex(
      (x, i) => i > after && x.cwd === `${DEV}/${thread.project}`,
    );
    const g = deletedSessions[at];
    if (!g) throw new Error(`planted thread: no ghost in ${thread.project} after ${after}`);
    after = at;
    if (g.promptCount < thread.prompts.length) {
      throw new Error(`planted thread: ${thread.project} ghost has only ${g.promptCount} prompts`);
    }
    thread.sessionId = g.id;
    g.title = thread.title;
    for (const [i, text] of thread.prompts.entries()) {
      g.prompts[i].text = text.replace('{DSN}', dsn);
    }
  }
}

// ------------------------------------------------------------- project dirs
//
// Sixteen directories under projects/, matching the reference machine: the ten
// with a surviving transcript, plus six left behind by the sweep. A wiped
// project's directory can outlive its transcripts — memory/ notes and
// sessions-index.json are not swept — and that is exactly where a ghost's
// title comes from.

const RESIDUE_DIRS = ['payments-api', 'crm-ingest', 'agent-runner', 'portfolio-site', 'shelf-cli', 'infant-vision'];
const projectDirNames = [...ALIVE_PROJECTS.map(([n]) => n), ...RESIDUE_DIRS];
for (const name of projectDirNames) fs.mkdirSync(projDir(`${DEV}/${name}`), { recursive: true });

// memory/*.md — auto-memory notes, which the sweep never touches.
{
  let written = 0;
  for (const [i, name] of projectDirNames.entries()) {
    const n = MEMORY_COUNTS[i];
    if (!n) continue;
    const dir = path.join(projDir(`${DEV}/${name}`), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < n; k++) {
      const topic = MEMORY_TOPICS[(i + k) % MEMORY_TOPICS.length];
      const file = path.join(dir, `${topic}${k ? `-${k + 1}` : ''}.md`);
      fs.writeFileSync(
        file,
        `# ${topic}\n\n- ${promptText()}\n- ${pick(ASSISTANT_LINES)}\n`,
      );
      touch(file, NOW - between(2, 300) * DAY);
      written++;
    }
  }
  if (written !== TARGET.memoryFiles) {
    throw new Error(`memory notes: wrote ${written}, expected ${TARGET.memoryFiles}`);
  }
}

// ------------------------------------------------------------- the transcripts

/**
 * One session transcript. It carries the full record-type vocabulary from
 * plans/research/formats.md §claude, including the three types that arrive
 * with no `timestamp` at all (`last-prompt`, `mode`, `permission-mode`,
 * `file-history-snapshot`), because a parser that assumes otherwise mis-orders
 * a session and this corpus has to be able to catch that.
 */
function sessionRecords(s) {
  const base = {
    sessionId: s.id,
    cwd: s.cwd,
    version: s.version,
    gitBranch: s.branch,
    userType: 'external',
    entrypoint: s.sdk ? 'sdk-ts' : 'cli',
    isSidechain: false,
  };
  const out = [];
  let uid = 0;
  const next = () => `u${uid++}`;

  out.push({ type: 'last-prompt', leafUuid: next(), sessionId: s.id });
  out.push({ type: 'mode', mode: 'normal', sessionId: s.id });
  out.push({ type: 'permission-mode', permissionMode: 'default', sessionId: s.id });
  out.push({
    ...base,
    type: 'attachment',
    uuid: next(),
    parentUuid: null,
    timestamp: iso(s.startedAt),
    attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: 'OK' },
  });

  let parent = null;
  for (const [i, p] of s.prompts.entries()) {
    const u = next();
    out.push({
      ...base,
      type: 'user',
      uuid: u,
      parentUuid: parent,
      promptId: `p${i}`,
      timestamp: iso(p.ts),
      message: { role: 'user', content: p.text },
    });
    const a = next();
    // pick() is called either way so that a planted override cannot shift the
    // PRNG stream for the sessions around it.
    const drawnTool = pick(TOOL_NAMES);
    const drawnLine = pick(ASSISTANT_LINES);
    const tool = p.tool ?? drawnTool;
    const file = `${s.cwd}/${p.file ?? 'src/index.ts'}`;
    out.push({
      ...base,
      type: 'assistant',
      uuid: a,
      parentUuid: u,
      requestId: `req_${i}_${s.id.slice(0, 8)}`,
      timestamp: iso(p.ts + 9 * 1000),
      message: {
        role: 'assistant',
        model: MODELS[i % MODELS.length],
        content: [
          { type: 'text', text: p.assistant ?? drawnLine },
          { type: 'tool_use', id: `t${i}`, name: tool, input: { file_path: file } },
        ],
      },
    });
    // A tool result is also `type:"user"` and carries no promptId. Counting it
    // as a prompt is the mistake that made an early draft's numbers 3x too big.
    const r = next();
    out.push({
      ...base,
      type: 'user',
      uuid: r,
      parentUuid: a,
      timestamp: iso(p.ts + 11 * 1000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: p.result ?? 'ok' }] },
      toolUseResult: { filePath: file },
    });
    if (i % 3 === 0) out.push({ type: 'file-history-snapshot', messageId: a, snapshot: { trackedFileBackups: {} } });
    if (i % 4 === 1) out.push({ type: 'queue-operation', operation: 'drain', sessionId: s.id });
    if (i % 5 === 2) out.push({ type: 'atis-latch', sessionId: s.id });
    if (i % 6 === 3) out.push({ type: 'system', subtype: 'compact_boundary', sessionId: s.id });
    if (i % 7 === 4) out.push({ type: 'frame-link', sessionId: s.id, frameId: `f${i}`, leafUuid: a });
    if (i % 9 === 5) out.push({ type: 'file-history-delta', messageId: a, delta: { edits: 1 } });
    parent = r;
  }

  out.push({ type: 'summary', summary: s.title ?? 'session summary', leafUuid: parent ?? 'u0' });
  // `ai-title` is rewritten as the session runs (avg 45x on the reference
  // machine); only the last record counts, and sdk sessions never get one.
  if (s.title) {
    const drafts = [s.title.split(' ').slice(0, 2).join(' '), s.title.split(' ').slice(0, 4).join(' '), s.title];
    for (const [i, t] of drafts.entries()) {
      out.push({ type: 'ai-title', sessionId: s.id, aiTitle: t, timestamp: iso(s.startedAt + (i + 1) * 90 * 1000) });
    }
  }
  return out;
}

/** A subagent transcript: same vocabulary, `isSidechain`, plus `agent-name`. */
function sidechainRecords(s, n) {
  const base = {
    sessionId: s.id,
    cwd: s.cwd,
    version: s.version,
    gitBranch: s.branch,
    entrypoint: s.sdk ? 'sdk-ts' : 'cli',
    isSidechain: true,
  };
  const at = s.startedAt + (n + 1) * 3 * MIN;
  const drawnAgent = pick(AGENT_NAMES);
  const drawnPrompt = promptText();
  const drawnLine = pick(ASSISTANT_LINES);
  // The hero session's first subagent is on the same thread as its parent, so
  // `find` has a sidechain hit to return alongside the live and ghost ones.
  const hero = s.idx === HERO.index && n === 0;
  return [
    {
      type: 'agent-name',
      sessionId: s.id,
      agentName: hero ? 'schema-checker' : drawnAgent,
      isSidechain: true,
    },
    {
      ...base,
      type: 'user',
      uuid: `s${n}a`,
      promptId: `sp${n}`,
      timestamp: iso(at),
      message: { role: 'user', content: hero ? HERO_SIDECHAIN : drawnPrompt },
    },
    {
      ...base,
      type: 'assistant',
      uuid: `s${n}b`,
      parentUuid: `s${n}a`,
      timestamp: iso(at + 21 * 1000),
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: hero
            ? 'Two call sites still prepare: db/pool.ts and the reporting reader. Both take statement_cache_size=0.'
            : drawnLine,
        }],
      },
    },
  ];
}

let sidechainsWritten = 0;
for (const s of aliveSessions) {
  const file = path.join(projDir(s.cwd), `${s.id}.jsonl`);
  fs.writeFileSync(file, jsonl(sessionRecords(s)));
  touch(file, s.mtimeAt);

  if (s.sidechains > 0) {
    const dir = path.join(projDir(s.cwd), s.id, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 0; n < s.sidechains; n++) {
      const f = path.join(dir, `agent-${String(n + 1).padStart(2, '0')}.jsonl`);
      fs.writeFileSync(f, jsonl(sidechainRecords(s, n)));
      // A subagent transcript is swept with its parent, so it shares its mtime.
      touch(f, s.mtimeAt);
      sidechainsWritten++;
    }
  }
}
if (sidechainsWritten !== TARGET.sidechainFiles) {
  throw new Error(`sidechains: wrote ${sidechainsWritten}, expected ${TARGET.sidechainFiles}`);
}

// ---------------------------------------------------------- sessions-index.json
//
// Four of the sixteen project directories have one, matching the reference
// machine. This is the only place a deleted session's title survives, so the
// nineteen ghosts that come back with a name come from here.

{
  const indexDirs = ['payments-api', 'crm-ingest', 'agent-runner', 'notes-api'];
  const titledGhosts = deletedSessions
    .filter((g) => indexDirs.some((d) => g.cwd === `${DEV}/${d}`))
    .slice(0, GHOSTS_WITH_TITLES);
  // `??=`: the three ghosts on the planted thread already carry the title the
  // story gives them, and a generated one would overwrite it.
  for (const g of titledGhosts) g.title ??= titleText();
  for (const thread of GHOST_THREADS) {
    if (!titledGhosts.some((g) => g.id === thread.sessionId)) {
      throw new Error(`planted thread in ${thread.project} is outside the titled ${GHOSTS_WITH_TITLES}`);
    }
  }

  for (const name of indexDirs) {
    const cwd = `${DEV}/${name}`;
    const slug = slugify(cwd);
    const entries = [];
    for (const s of aliveSessions.filter((x) => x.cwd === cwd)) {
      entries.push({
        sessionId: s.id,
        fullPath: `${NOTIONAL_HOME}/projects/${slug}/${s.id}.jsonl`,
        fileMtime: s.startedAt + 45 * MIN,
        firstPrompt: s.prompts[0].text,
        summary: s.title ?? 'Working session',
        messageCount: s.prompts.length * 2,
        created: iso(s.startedAt),
        modified: iso(s.startedAt + 45 * MIN),
        gitBranch: s.branch,
        projectPath: cwd,
        isSidechain: false,
      });
    }
    for (const g of titledGhosts.filter((x) => x.cwd === cwd)) {
      entries.push({
        sessionId: g.id,
        fullPath: `${NOTIONAL_HOME}/projects/${slug}/${g.id}.jsonl`,
        fileMtime: g.startedAt + 2 * HOUR,
        firstPrompt: g.prompts[0].text,
        summary: g.title,
        messageCount: g.promptCount * 2,
        created: iso(g.startedAt),
        modified: iso(g.startedAt + 2 * HOUR),
        gitBranch: pick(BRANCHES),
        projectPath: cwd,
        isSidechain: false,
      });
    }
    const file = path.join(projDir(cwd), 'sessions-index.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
    touch(file, NOW - 3 * DAY);
  }
}

// ------------------------------------------------------------------- history
//
// One line per prompt ever typed, in chronological order — the only artefact
// that outlives the sweep, and the source every ghost is rebuilt from. SDK
// sessions never appear here, which is why "sessions ever started" has to be a
// union and not a history count.

{
  const lines = [];
  for (const g of deletedSessions) {
    for (const p of g.prompts) {
      lines.push({ display: p.text, pastedContents: {}, timestamp: p.ts, project: g.cwd, sessionId: g.id });
    }
  }
  for (const s of aliveSessions) {
    if (s.sdk) continue;
    for (const p of s.prompts) {
      lines.push({ display: p.text, pastedContents: {}, timestamp: p.ts, project: s.cwd, sessionId: s.id });
    }
  }
  lines.sort((a, b) => a.timestamp - b.timestamp);
  const file = path.join(dest, 'history.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  touch(file, NOW - 2 * HOUR);
}

// ------------------------------------------------------------------ settings
//
// There is deliberately no settings.json at all. `cleanupPeriodDays` unset is
// the headline, and the commonest way for it to be unset is for the file never
// to have been created — which is also what makes the sweep invisible: there
// is nothing to read to find out it is on.
//
// It keeps the screens reproducible too. `rescue` backs a settings.json up
// before it edits one, and the backup's name carries the wall-clock second it
// was taken, so a corpus with a settings.json would print a different receipt
// on every capture. With no file there is nothing to back up: rescue creates
// it, and `doctor --privacy` afterwards lists it exactly as it would on a
// machine that had one all along.

// mtimes last: writing a file after stamping it would undo the stamp, and the
// sweep countdown on the audit card is entirely a function of these.
for (const [file, ms] of mtimes) {
  const d = new Date(ms);
  fs.utimesSync(file, d, d);
}

// ------------------------------------------------------------------- verify
//
// Self-check: run the real binary over what we just wrote and compare every
// headline number. A generator that silently drifts from its targets is worse
// than no generator, because the readme would keep quoting it.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthYear = (isoStr) => {
  const d = new Date(isoStr);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

function verify() {
  // The checkout's binary first, then the plugin's vendored bundle. The second
  // is committed, so a plain `git clone` with no `pnpm install` and no build
  // has one — which is the machine this generator is most likely to be run on
  // now that a clone is a complete install. Without it, a clone got "potsherd
  // is not built" and exit 1 **after the corpus had already been written**,
  // which is a true sentence that describes the wrong half of what happened.
  const candidates = [
    path.join(repo, 'packages', 'cli', 'dist', 'potsherd.js'),
    path.join(repo, 'plugins', 'claude-code', 'dist', 'potsherd.js'),
  ];
  const bin = candidates.find((f) => fs.existsSync(f));
  if (!bin) {
    console.error('the corpus is written, but nothing here can verify it.');
    console.error('run:  pnpm build   (or use a clone, which carries plugins/claude-code/dist)');
    return 1;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-verify-'));
  let json;
  try {
    const out = execFileSync(
      process.execPath,
      [bin, 'audit', '--json', '--claude-dir', dest, '--potsherd-dir', path.join(scratch, 'none')],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    json = JSON.parse(out);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const range = json.history.firstTs && json.history.lastTs
    ? `${monthYear(json.history.firstTs)} -> ${monthYear(json.history.lastTs)}`
    : '(none)';

  const checks = [
    ['sessions ever started', json.sessionsEver, TARGET.sessionsEver],
    ['still on disk', json.onDisk, TARGET.onDisk],
    ['deleted', json.deleted, TARGET.deleted],
    ['prompts lost', json.promptsLost, TARGET.promptsLost],
    ['projects wiped', json.projectsWiped.length, TARGET.projectsWiped],
    ['history range', range, TARGET.historyRange],
    ['sidechain files', json.sidechainFiles, TARGET.sidechainFiles],
    ['sessions with a title', json.titledSessions, TARGET.titledSessions],
    ['sdk sessions', json.sdkSessions, TARGET.sdkSessions],
    ['sessions-index files', json.sessionsIndexFiles, TARGET.sessionsIndexFiles],
    ['memory notes', json.memoryFiles, TARGET.memoryFiles],
    ['next sweep <= 7 days', json.nextSweepWithin7Days, TARGET.nextSweepWithin7Days],
    ['next sweep <= 1 day', json.nextSweepWithinOneDay, TARGET.nextSweepWithinOneDay],
    ['cleanupPeriodDays', json.cleanupPeriodDays, TARGET.cleanupPeriodDays],
    ['effective sweep', json.cleanupPeriodEffective, CLEANUP_DAYS],
    ['warnings', json.warnings.length, 0],
  ];

  let bad = 0;
  console.log(`demo corpus written to ${dest}`);
  console.log('');
  for (const [label, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    const shown = got === null ? 'unset' : String(got);
    const wanted = want === null ? 'unset' : String(want);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(24)}${shown.padStart(20)}${ok ? '' : `   expected ${wanted}`}`);
  }
  console.log('');
  console.log(`  top wiped projects        ${json.projectsWiped.slice(0, 4).map((p) => p.name).join(' · ')}`);
  console.log(`  corpus size               ${(json.bytes / 1024 / 1024).toFixed(1)} MB` +
    '   (the reference machine had 329 MB; only counts are reproduced)');
  console.log('');
  console.log(`  planted thread            live ${HERO.id.slice(0, 8)} · ghosts ` +
    GHOST_THREADS.map((t) => `${t.sessionId.slice(0, 8)} (${t.project})`).join(' · '));
  console.log(`  the open thread           live ${aliveSessions[SIBLING.index].id.slice(0, 8)}` +
    ` (event-bus) — same pooler, never asked what transaction pooling breaks`);
  console.log(`  planted credentials       ${Object.keys(SECRETS).length}` +
    `   generated, in ${PLANTED_LEAKS.length} tool results and 1 pasted dsn`);
  console.log(`  the leaked .env is in     ${PLANTED_LEAKS[0].id.slice(0, 8)}  exchange 1`);
  console.log('');
  if (bad) console.error(`${bad} target${bad === 1 ? '' : 's'} missed.`);
  return bad ? 1 : 0;
}

process.exit(verify());
