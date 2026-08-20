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
 * Which surviving sessions carry an `ai-title`. The ten the sweep is about to
 * take are all titled, because `audit --sweep` naming them is the whole point
 * of that screen; eleven more make up the measured 21.
 */
const TITLED_INDICES = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  10, 11, 13, 14, 16, 17, 20, 22, 24, 27, 29,
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
      aliveSessions.push({
        idx,
        id: uuid(),
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
  const n = between(3, 12);
  for (let i = 0; i < n; i++) {
    s.prompts.push({ ts: s.startedAt + i * (7 * MIN + between(0, 400) * 1000), text: promptText() });
  }
  if (s.titled) s.title = titleText();
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
    for (let i = 0; i < g.promptCount; i++) {
      g.prompts.push({ ts: g.startedAt + i * (9 * MIN + between(0, 600) * 1000), text: promptText() });
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
    const tool = pick(TOOL_NAMES);
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
          { type: 'text', text: pick(ASSISTANT_LINES) },
          { type: 'tool_use', id: `t${i}`, name: tool, input: { file_path: `${s.cwd}/src/index.ts` } },
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
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] },
      toolUseResult: { filePath: `${s.cwd}/src/index.ts` },
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
  return [
    { type: 'agent-name', sessionId: s.id, agentName: pick(AGENT_NAMES), isSidechain: true },
    {
      ...base,
      type: 'user',
      uuid: `s${n}a`,
      promptId: `sp${n}`,
      timestamp: iso(at),
      message: { role: 'user', content: promptText() },
    },
    {
      ...base,
      type: 'assistant',
      uuid: `s${n}b`,
      parentUuid: `s${n}a`,
      timestamp: iso(at + 21 * 1000),
      message: { role: 'assistant', content: [{ type: 'text', text: pick(ASSISTANT_LINES) }] },
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
  for (const g of titledGhosts) g.title = titleText();

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
  const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');
  if (!fs.existsSync(path.join(repo, 'packages', 'cli', 'dist', 'potsherd.js'))) {
    console.error('potsherd is not built. run:  pnpm build');
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
  if (bad) console.error(`${bad} target${bad === 1 ? '' : 's'} missed.`);
  return bad ? 1 : 0;
}

process.exit(verify());
