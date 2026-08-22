/**
 * T6.5 — `potsherd stack`: the verb that says out loud what potsherd does
 * **not** do, and which tool does it instead.
 *
 * `plans/phases/phase-6-ecosystem.md` deliverable 3, read literally: *detects
 * installed memory tools, prints a table mapping each to the four failures
 * (`01 §1`), flags overlaps/double-capture, and prints a recommended config.*
 *
 * ## The design constraint that shapes every line below
 *
 * This is the only surface in the product that prints **claims about other
 * people's software**. Two facts about this build make that dangerous rather
 * than merely delicate:
 *
 *   1. Four phantom flags have already been found in this repo — features
 *      documented and registered that do nothing. A table asserting what seven
 *      other tools do is the same failure with a wider blast radius, because
 *      nobody reading it can check it against a binary they have installed.
 *   2. A tool that prints a table of competitors and wins every row has
 *      written marketing. `01 §1` scopes potsherd to failures **3 and 4**. Its
 *      own row therefore reads `no` twice, and {@link POTSHERD} is the first
 *      row in {@link TOOLS} so the losses are the first thing on screen.
 *
 * So every claim here carries {@link ToolSpec.verified}, exactly as
 * `setup.ts` does for its seven MCP clients — and the label reaches the user's
 * terminal, not only the docs page. The three values mean:
 *
 *   `tool`   — read off the tool's own state on this machine.
 *   `config` — read out of a real config/db file that tool had written.
 *   `docs`   — from the project's current documentation, fetched on the date
 *              in {@link VERIFIED_ON}. Correct as documented; **not**
 *              exercised here.
 *
 * Nothing in this module is `assumed`. Where a fact could not be established
 * it is absent, or {@link ToolSpec.licence} is `'unknown'`, and the coverage
 * cell says `?` rather than guessing.
 *
 * ## Detection reads and never writes
 *
 * `00-README.md` makes `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi` and
 * `~/.gemini` read-only, and the same rule is applied to every third-party
 * directory named here. {@link detectTools} calls `existsSync` and nothing
 * else — no spawn, no probe, no HTTP, and in particular no read of the
 * *contents* of another tool's database. Presence is the whole signal.
 *
 * @see docs/memory-stack.md for the sources, with fetch dates.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as paths from './paths.js';

// ------------------------------------------------------------ the four failures

/**
 * `01-PROBLEM-AND-EVIDENCE.md` §1. The four things people mean by "losing
 * context", which is the axis the whole table is laid out on.
 *
 * They are numbered, not named, in the output's column heads, because four
 * three-word labels do not fit beside seven tool names at 60 columns. The
 * legend is printed above the table every single time — a table whose column
 * heads are bare digits and whose legend is behind a flag is a table nobody
 * reads correctly.
 */
export interface Failure {
  n: 1 | 2 | 3 | 4;
  /** One or two words, for the legend. */
  label: string;
  /** When it bites, in the user's terms. */
  when: string;
  /** `01 §1`'s own verdict on the state of the art. */
  solved: boolean;
}

export const FAILURES: readonly Failure[] = [
  { n: 1, label: 'context rot', when: 'during a session', solved: true },
  { n: 2, label: 'cold start', when: 'next day, same repo', solved: true },
  { n: 3, label: 'archive amnesia', when: 'weeks later, any project', solved: false },
  { n: 4, label: 're-entry', when: 'after you found it', solved: false },
];

/**
 * What a tool does about one failure.
 *
 * `partial` is doing real work in this table and is not a hedge: it is the
 * cell for a tool that addresses the failure under a condition its own docs
 * state — agentmemory backfills the archive *if you imported before the sweep
 * ran*, episodic-memory searches the archive *except the 87% of files that are
 * sidechains*. Collapsing those to `yes` would be the marketing version;
 * collapsing them to `no` would be unfair to the tool.
 *
 * `unknown` prints `?`. It is used where a tool's current documentation does
 * not answer the question, and the alternative would be to guess.
 */
export type Coverage = 'yes' | 'partial' | 'no' | 'unknown';

/** How far a claim in this file was actually checked. Mirrors `setup.ts`. */
export type Verification = 'tool' | 'config' | 'docs';

export type ToolId =
  | 'potsherd'
  | 'claude-mem'
  | 'agentmemory'
  | 'superbrain'
  | 'episodic-memory'
  | 'hindsight'
  | 'greplica'
  | 'auto-memory';

export interface ToolSpec {
  id: ToolId;
  /** How the table names it. Kept to 15 chars so the table fits at 60 cols. */
  label: string;
  /** `owner/repo`, or null for something that is not a repo. */
  repo: string | null;
  /**
   * SPDX id as reported by `api.github.com/repos/<repo>` on
   * {@link VERIFIED_ON}, or `built-in` for what ships inside the harness and
   * has no separate licence of its own.
   *
   * `04-DECISIONS.md` Q1 binds this project on attribution, so a licence that
   * is not permissive has to be visible **before** a later phase reuses a line
   * of anything. Two of these were wrong in `research/competitors.md` and are
   * corrected here; see {@link ToolSpec.licenceNote}.
   */
  licence: string;
  /** Anything surprising about the licence, printed under `--licences`. */
  licenceNote?: string;
  verified: Verification;
  /** One line saying what was checked. Printed by `--sources` and in the docs. */
  evidenceNote: string;
  /** The URL the claims were read from. Cited in `docs/memory-stack.md`. */
  source: string;
  /** Files or directories whose existence means it is installed here. */
  markers: (env?: NodeJS.ProcessEnv) => string[];
  /** Coverage of failures 1..4, in order. */
  coverage: readonly [Coverage, Coverage, Coverage, Coverage];
  /** The one sentence that explains the row. */
  note: string;
  /**
   * True when the tool captures **new** sessions as they happen, via hooks.
   * Two of these installed at once is double-capture; see {@link overlaps}.
   */
  capturesLive: boolean;
  /** True when the tool pushes text into the model's context at session start. */
  injectsAtStart: boolean;
}

/**
 * The date every `docs`-verified claim below was read from the project's own
 * current documentation.
 *
 * Printed in the output. A claim about someone else's tool is perishable and a
 * table with no date on it is a table that quietly becomes false.
 */
export const VERIFIED_ON = '22 aug 2026';

// ---------------------------------------------------------------- the tools

/**
 * potsherd's own row, and it goes first.
 *
 * Two `no`s at the top of the table, before any other tool is named. `01 §1`
 * scopes this product to failures 3 and 4; `02`'s *what we refuse to build*
 * makes failure 2 a **deliberate** loss rather than an unfinished one — "no
 * auto-injection at SessionStart by default … that is claude-mem's lane".
 * Failure 1 is not a loss at all, it is simply not this tool's problem:
 * compaction, subagents and a 1M window happen inside a session potsherd is
 * not in.
 */
export const POTSHERD: ToolSpec = {
  id: 'potsherd',
  label: 'potsherd',
  repo: null,
  licence: 'MIT',
  verified: 'tool',
  evidenceNote: 'this program',
  source: 'plans/01-PROBLEM-AND-EVIDENCE.md §1, plans/02-STRATEGY-AND-VIRALITY.md',
  markers: () => [paths.potsherdDir()],
  coverage: ['no', 'no', 'yes', 'yes'],
  note: 'scoped to 3 and 4. 1 is not in its reach; 2 it refuses on purpose.',
  capturesLive: false,
  injectsAtStart: false,
};

/**
 * Everything else, in descending order of how many people run it.
 *
 * The order is stars, not merit, and it is deliberate: the reader is being
 * told which of these they should keep, and the ones they are most likely to
 * already have installed should be the ones they meet first.
 */
export const TOOLS: readonly ToolSpec[] = [
  POTSHERD,
  {
    id: 'claude-mem',
    label: 'claude-mem',
    repo: 'thedotmack/claude-mem',
    licence: 'Apache-2.0',
    licenceNote:
      'permissive. `research/competitors.md` guessed "AGPL-ish? check before linking" — the ' +
      'GitHub licence API says Apache-2.0, so reuse with attribution is allowed after all.',
    verified: 'docs',
    evidenceNote:
      'README and the GitHub licence API, read ' +
      VERIFIED_ON +
      '; not installed here, so nothing was exercised',
    source: 'https://github.com/thedotmack/claude-mem (README + api.github.com/repos)',
    markers: () => [path.join(paths.home(), '.claude-mem')],
    coverage: ['no', 'yes', 'no', 'no'],
    note: 'five hooks, injects at SessionStart. its README documents no import of transcripts from before install.',
    capturesLive: true,
    injectsAtStart: true,
  },
  {
    id: 'agentmemory',
    label: 'agentmemory',
    repo: 'rohitg00/agentmemory',
    licence: 'Apache-2.0',
    verified: 'docs',
    evidenceNote:
      'README and the GitHub licence API, read ' +
      VERIFIED_ON +
      '; not installed here. its data dir is the OS app-data path, not ~/.agentmemory',
    source: 'https://github.com/rohitg00/agentmemory (README + api.github.com/repos)',
    // Its README is explicit that state lives outside the repo, in the
    // platform's app-data directory — *not* `~/.agentmemory`, which is what
    // the phase brief and `03 §10` both assumed. Both are checked, because a
    // detector that only knows the wrong path reports "absent" on a machine
    // where the tool is running.
    markers: (env = process.env) => [
      path.join(paths.home(), '.agentmemory'),
      process.platform === 'darwin'
        ? path.join(paths.home(), 'Library', 'Application Support', 'agentmemory')
        : path.join(
            env['XDG_DATA_HOME']?.trim()
              ? paths.expandTilde(env['XDG_DATA_HOME'].trim())
              : path.join(paths.home(), '.local', 'share'),
            'agentmemory',
          ),
    ],
    coverage: ['no', 'yes', 'partial', 'partial'],
    note: 'the only one here that backfills: `import-jsonl` reads ~/.claude/projects. only what the sweep left.',
    capturesLive: true,
    injectsAtStart: true,
  },
  {
    id: 'hindsight',
    label: 'hindsight',
    repo: 'vectorize-io/hindsight',
    licence: 'MIT',
    verified: 'docs',
    evidenceNote:
      'README and the GitHub licence API, read ' +
      VERIFIED_ON +
      '; not installed here. needs postgres or its embedded pg0, so detection is weak',
    source: 'https://github.com/vectorize-io/hindsight (README + api.github.com/repos)',
    markers: () => [
      path.join(paths.home(), '.hindsight'),
      path.join(paths.home(), '.pg0'),
    ],
    coverage: ['no', 'yes', 'no', 'partial'],
    note: 'retain/recall per bank, one bank per project. no documented import of old transcripts.',
    capturesLive: true,
    injectsAtStart: false,
  },
  {
    id: 'episodic-memory',
    label: 'episodic-mem',
    repo: 'obra/episodic-memory',
    licence: 'MIT',
    verified: 'tool',
    evidenceNote:
      'installed on this machine: its sqlite index was opened read-only and its table list read',
    source:
      'https://github.com/obra/episodic-memory + the local index at ' +
      '~/.config/superpowers/conversation-index/db.sqlite',
    markers: () => [episodicIndexPath()],
    // The closest thing on this list to failure 3, and still `partial`: its
    // search hard-codes `AND e.is_sidechain = 0`, which excludes 197 of the
    // 227 transcript files on the reference machine (`01 §2`), and it can only
    // index what the 30-day sweep has not already taken.
    coverage: ['no', 'partial', 'partial', 'no'],
    note: 'potsherd is forked from it. cross-project search, but sidechains excluded and read-only.',
    capturesLive: false,
    injectsAtStart: false,
  },
  {
    id: 'greplica',
    label: 'greplica',
    repo: 'Autoloops/greplica',
    licence: 'MIT',
    verified: 'docs',
    evidenceNote:
      'README and the GitHub licence API, read ' +
      VERIFIED_ON +
      '; not installed here. it is per-repo, so a home-directory marker is the weakest signal on this list',
    source: 'https://github.com/Autoloops/greplica (README + api.github.com/repos)',
    markers: () => [path.join(paths.home(), '.greplica')],
    coverage: ['no', 'partial', 'no', 'partial'],
    note: 'one knowledge graph per repo. cannot answer "which project was that in".',
    capturesLive: true,
    injectsAtStart: false,
  },
  {
    id: 'superbrain',
    label: 'superbrain',
    repo: 'm3talux/superbrain',
    licence: 'MIT',
    verified: 'docs',
    evidenceNote:
      'README and the GitHub licence API, read ' +
      VERIFIED_ON +
      '; not installed here. its vault path is fixed, which makes the marker a strong one',
    source: 'https://github.com/m3talux/superbrain (README + api.github.com/repos)',
    markers: () => [path.join(paths.home(), '.superbrain')],
    coverage: ['no', 'yes', 'no', 'no'],
    note: 'obsidian vault at ~/.superbrain/vault, injects a brief at start. capture-only from install.',
    capturesLive: true,
    injectsAtStart: true,
  },
  {
    id: 'auto-memory',
    label: 'CLAUDE.md',
    repo: null,
    licence: 'built-in',
    verified: 'config',
    evidenceNote:
      'the files themselves were found on this machine, and the behaviour read from code.claude.com/docs/en/memory on ' +
      VERIFIED_ON,
    source: 'https://code.claude.com/docs/en/memory',
    markers: () => [
      path.join(paths.claudeDir(), 'CLAUDE.md'),
      path.join(paths.claudeDir(), 'projects'),
    ],
    // The one row on this table with a documented immunity to the 30-day
    // sweep: *"Claude Code deletes old session transcripts after the
    // cleanupPeriodDays retention period, but excludes the files in the memory
    // directory from that retention sweep."* That is why it is the thing
    // potsherd bridges to rather than replaces.
    coverage: ['no', 'yes', 'no', 'no'],
    note: 'loaded into every session, and the memory dir survives the 30-day sweep. per-repo, 200 lines.',
    capturesLive: true,
    injectsAtStart: true,
  },
];

/**
 * episodic-memory's index, which is not under a directory named after it.
 *
 * It ships inside the `superpowers` marketplace, so its state lands in
 * `~/.config/superpowers/conversation-index/db.sqlite`. Hard-coding
 * `~/.episodic-memory` — the name a detector would reach for — finds nothing
 * on a machine where it is installed and working, which is exactly the
 * false-negative this whole module has to avoid.
 */
export function episodicIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.trim()
    ? path.resolve(paths.expandTilde(xdg.trim()))
    : path.join(paths.home(), '.config');
  return path.join(base, 'superpowers', 'conversation-index', 'db.sqlite');
}

export function toolSpec(id: ToolId): ToolSpec {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) throw new Error(`unknown tool: ${id}`);
  return spec;
}

// ------------------------------------------------------------------ detection

export interface Detection {
  spec: ToolSpec;
  present: boolean;
  /** Every marker that exists, tildified. Empty when absent. */
  found: string[];
  /** Every marker that was looked for, tildified. */
  looked: string[];
}

/**
 * Which of these are on this machine.
 *
 * `existsSync` on each marker and nothing more. No spawn, no `--version`, no
 * read of another tool's database: `stack` is a read-only observer of other
 * people's directories, and the difference between "this path exists" and
 * "this program works" is stated in the output rather than papered over by
 * probing harder.
 *
 * The failure mode this accepts on purpose is the **false negative** — a tool
 * installed somewhere non-default reads as absent. That is why
 * {@link Detection.looked} carries every path that was tried, and why the
 * renderer offers to print them: a user who knows the tool is installed can
 * see in one line what potsherd looked at and why it missed.
 */
export function detectTools(env: NodeJS.ProcessEnv = process.env): Detection[] {
  return TOOLS.map((spec) => {
    const markers = spec.markers(env);
    const found = markers.filter((m) => safeExists(m));
    return {
      spec,
      present: found.length > 0,
      found: found.map((m) => paths.tildify(m)),
      looked: markers.map((m) => paths.tildify(m)),
    };
  });
}

/** `existsSync` that cannot throw, because a permission error is not "installed". */
function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- overlaps

export type OverlapKind = 'double-capture' | 'double-inject' | 'none';

export interface Overlap {
  kind: OverlapKind;
  /** The tools involved, by label. */
  tools: string[];
  /** What it costs the user, in one line. */
  cost: string;
  /** The one thing to do about it. */
  fix: string;
}

/**
 * What is stepping on what.
 *
 * Two kinds, and they are different problems:
 *
 *   - **double-capture**: two tools with hooks writing a record of the same
 *     session into two stores. It costs disk and it costs hook latency on
 *     every tool call, and neither store is authoritative afterwards.
 *   - **double-inject**: two tools pushing text into the context window at
 *     session start. This is the expensive one — it is spent from the same
 *     budget as the user's actual work, every session, whether or not it is
 *     used, and `02` cites claude-mem's own power user on the result: *"never
 *     saw them surface unless i asked"*.
 *
 * Only detected tools count. A warning about two tools the user does not have
 * is noise, and this verb's whole claim on the reader's attention is that it
 * does not flatter itself or pad.
 */
export function overlaps(detections: readonly Detection[]): Overlap[] {
  const present = detections.filter((d) => d.present).map((d) => d.spec);
  const out: Overlap[] = [];

  const capturing = present.filter((s) => s.capturesLive);
  if (capturing.length > 1) {
    out.push({
      kind: 'double-capture',
      tools: capturing.map((s) => s.label),
      cost: `${capturing.length} tools write a record of the same session, in ${capturing.length} stores.`,
      fix: 'keep one. the rest add hook latency to every tool call and no new recall.',
    });
  }

  const injecting = present.filter((s) => s.injectsAtStart);
  if (injecting.length > 1) {
    out.push({
      kind: 'double-inject',
      tools: injecting.map((s) => s.label),
      cost: 'each one spends context at session start, from the same budget as your work.',
      fix: 'keep one injector. pull beats push: the others can stay as on-demand search.',
    });
  }

  return out;
}

// -------------------------------------------------------------- the recommendation

export interface Recommendation {
  /** One line per failure, in order. */
  rows: { failure: Failure; use: string; why: string }[];
  /** Concrete next steps, at most three. Empty when the stack is already right. */
  actions: string[];
}

/**
 * What to run, given what is here.
 *
 * The rule is one owner per failure, and potsherd only ever nominates itself
 * for 3 and 4. For 1 it nominates nothing it can install — compaction and
 * subagents are already in the harness — and for 2 it nominates whichever
 * detected tool covers it, falling back to Claude Code's own auto memory,
 * which is free, on by default and documented to survive the 30-day sweep.
 */
export function recommend(detections: readonly Detection[]): Recommendation {
  const present = new Map(detections.filter((d) => d.present).map((d) => [d.spec.id, d.spec]));
  const best = (ids: ToolId[]): ToolSpec | null => {
    for (const id of ids) {
      const s = present.get(id);
      if (s) return s;
    }
    return null;
  };

  // Failure 2's owner: whatever the user already runs, preferred in the order
  // they cover it. Nothing is recommended for *installation* here — this verb
  // does not sell other people's software either.
  const coldStart = best(['claude-mem', 'agentmemory', 'superbrain', 'auto-memory']);

  const rows: Recommendation['rows'] = [
    {
      failure: FAILURES[0]!,
      use: 'your harness',
      why: 'compaction, subagents and a long window. nothing to install; potsherd is not in the session.',
    },
    {
      failure: FAILURES[1]!,
      use: coldStart ? coldStart.label : 'CLAUDE.md',
      why: coldStart
        ? 'already installed here, and it owns this row. potsherd refuses it on purpose.'
        : 'nothing here covers this. Claude Code auto memory is on by default and costs nothing.',
    },
    {
      failure: FAILURES[2]!,
      use: 'potsherd',
      why: 'the archive, the ghosts of what the sweep took, and search across every project.',
    },
    {
      failure: FAILURES[3]!,
      use: 'potsherd',
      why: 'graft: put a session you found into the agent you are talking to now.',
    },
  ];

  const actions: string[] = [];
  const over = overlaps(detections);
  const inject = over.find((o) => o.kind === 'double-inject');
  if (inject) actions.push(`pick one of ${inject.tools.join(', ')} to inject at start; turn the others off.`);
  if (!present.has('potsherd')) actions.push('run potsherd rescue before the next 30-day sweep does.');
  if (present.has('agentmemory')) {
    actions.push('agentmemory import-jsonl only sees what the sweep left. run potsherd audit for the rest.');
  }

  return { rows, actions };
}

// ------------------------------------------------------------------- the report

export interface StackReport {
  verifiedOn: string;
  failures: readonly Failure[];
  detections: Detection[];
  overlaps: Overlap[];
  recommendation: Recommendation;
  /** How many of {@link TOOLS}, potsherd excluded, are installed here. */
  installed: number;
  /** How many rows carry a `docs`-only claim. The honesty headline. */
  unverified: number;
}

/** Everything `potsherd stack` and `--json` both render, computed once. */
export function stackReport(env: NodeJS.ProcessEnv = process.env): StackReport {
  const detections = detectTools(env);
  return {
    verifiedOn: VERIFIED_ON,
    failures: FAILURES,
    detections,
    overlaps: overlaps(detections),
    recommendation: recommend(detections),
    installed: detections.filter((d) => d.present && d.spec.id !== 'potsherd').length,
    unverified: detections.filter((d) => d.spec.verified === 'docs').length,
  };
}

/** The glyph a coverage cell prints. One character, so the table never wraps. */
export function coverageGlyph(c: Coverage, ascii = false): string {
  switch (c) {
    case 'yes':
      return ascii ? 'v' : '✓';
    case 'partial':
      return ascii ? '~' : '~';
    case 'no':
      return ascii ? '.' : '·';
    default:
      return '?';
  }
}
