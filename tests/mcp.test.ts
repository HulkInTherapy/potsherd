import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexAll, paths } from '@potsherd/core';

import { makeContext, resolveGraftCwd } from '../packages/mcp/src/context.js';
import { TOOLS, WRITE_TOOLS } from '../packages/mcp/src/server.js';
import { runAsk } from '../packages/mcp/src/tools/ask.js';
import * as shipped from '../packages/mcp/src/descriptions.js';
import {
  call,
  callRaw,
  connectInMemory,
  listTools,
  textOf,
  type CallToolResult,
  type Client,
} from '../packages/mcp/src/testing.js';
import { FIXTURE_CLAUDE, rmrf, tempDir } from './helpers.js';

/**
 * T5.1 — the MCP stdio server.
 *
 * These tests live in `tests/` rather than `packages/mcp/test/` for one
 * mechanical reason: `vitest.config.ts` includes `tests/**` and
 * `packages/*​/src/**`, so a `packages/mcp/test/` directory would never be
 * collected and the suite would silently be zero tests. The config is shared
 * with four other live workers and is not worth editing for a directory name.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');

let root = '';
let project = '';
let scratch = '';
/** An environment with no model backend in it. See `--selftest`'s header. */
const OFFLINE: NodeJS.ProcessEnv = {};

beforeAll(async () => {
  scratch = tempDir('potsherd-mcp-');
  root = path.join(scratch, 'potsherd');
  project = path.join(scratch, 'project');
  fs.mkdirSync(project, { recursive: true });
  await indexAll({
    root,
    potsherdDir: root,
    claudeDir: FIXTURE_CLAUDE,
    harnesses: ['claude'],
    full: true,
    embed: false,
  });
  execFileSync('node', ['build.mjs'], {
    cwd: path.join(repo, 'packages', 'cli'),
    stdio: 'pipe',
  });
});

afterAll(() => {
  if (scratch) rmrf(scratch);
});

function ctx() {
  return makeContext({ potsherdDir: root, env: { ...OFFLINE }, cwd: project });
}

const connect = () => connectInMemory(ctx(), 'mcp.test');

/** The CLI's `--json` for the same request, parsed. */
function cliJson(args: string[]): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [bin, ...args, '--json', '--potsherd-dir', root], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** A session id the fixture is guaranteed to have. */
async function anySession(client: Client): Promise<string> {
  const ls = await call(client, 'potsherd_ls', { limit: 1 });
  return ((ls['sessions'] as { id: string }[])[0] as { id: string }).id;
}

describe('the tool list', () => {
  it('is six tools, in the pinned order, and no more', async () => {
    const { client, close } = await connect();
    try {
      const listed = await listTools(client);
      expect(listed.tools.map((t) => t.name)).toEqual([...TOOLS]);
      // `03` §9: ≤ 6 tools, agentmemory's 54 is the named anti-pattern. A
      // seventh tool fails here before it fails a review.
      expect(listed.tools).toHaveLength(6);
    } finally {
      await close();
    }
  });

  it('is read-only everywhere except potsherd_tag', async () => {
    const { client, close } = await connect();
    try {
      const listed = await listTools(client);
      for (const t of listed.tools) {
        expect(t.annotations?.readOnlyHint, t.name).toBe(!WRITE_TOOLS.includes(t.name));
      }
      expect(WRITE_TOOLS).toEqual(['potsherd_tag']);
    } finally {
      await close();
    }
  });

  it('advertises a json schema for every tool, with the contract fields in it', async () => {
    const { client, close } = await connect();
    try {
      const listed = await listTools(client);
      const props = (name: string): Record<string, unknown> =>
        (listed.tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, unknown> })
          .properties;

      // The pinned shapes from `phases/phase-5/WAVE.md`, field for field.
      expect(Object.keys(props('potsherd_find')).sort()).toEqual(
        ['ghosts', 'harness', 'limit', 'pinned', 'project', 'query', 'sidechains', 'since', 'tag', 'until'].sort(),
      );
      expect(Object.keys(props('potsherd_read')).sort()).toEqual(['end_line', 'session', 'start_line']);
      expect(Object.keys(props('potsherd_ask')).sort()).toEqual(['filters', 'k', 'question', 'strict']);
      expect(Object.keys(props('potsherd_graft')).sort()).toEqual(['about', 'budget', 'session']);
      expect(Object.keys(props('potsherd_ls')).sort()).toEqual(
        ['ghosts', 'limit', 'pinned', 'project', 'since', 'tag'].sort(),
      );
      expect(Object.keys(props('potsherd_tag')).sort()).toEqual(['add', 'remove', 'session']);
    } finally {
      await close();
    }
  });
});

describe('--json parity with the cli', () => {
  /**
   * The claim `03` §9 makes is that a client and a terminal never disagree.
   * The test of it is not "both return sessions" — it is that **every key the
   * CLI emits, the tool emits, with an equal value**. The tools add fields the
   * contract asks for on top; they may never change or drop one.
   *
   * `ms` is excluded everywhere and only `ms` — at every depth, because
   * `find --json` carries a per-list duration inside `lists[]` as well as one
   * at the top. It is a duration: two runs of the same query legitimately
   * differ by a millisecond and that is not a parity failure.
   */
  function stripMs<T>(value: T): T {
    if (Array.isArray(value)) return value.map(stripMs) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k !== 'ms') out[k] = stripMs(v);
      }
      return out as unknown as T;
    }
    return value;
  }

  function sameAs(cli: Record<string, unknown>, tool: Record<string, unknown>, skip: string[] = []) {
    for (const key of Object.keys(cli)) {
      if (key === 'ms' || skip.includes(key)) continue;
      expect(stripMs(tool[key]), `key "${key}"`).toEqual(stripMs(cli[key]));
    }
  }

  it('potsherd_find carries everything find --json carries', async () => {
    const { client, close } = await connect();
    try {
      const q = 'pgbouncer';
      const tool = await call(client, 'potsherd_find', { query: q, limit: 5 });
      sameAs(cliJson(['find', q, '--limit', '5']), tool);
      // ...and the four the contract names on top of it.
      for (const key of ['hits', 'k', 'weights', 'relaxedLists']) {
        expect(tool[key], key).toBeDefined();
      }
      expect(Array.isArray(tool['hits'])).toBe(true);
    } finally {
      await close();
    }
  });

  it('potsherd_ls carries everything ls --json carries', async () => {
    const { client, close } = await connect();
    try {
      sameAs(cliJson(['ls', '--limit', '5']), await call(client, 'potsherd_ls', { limit: 5 }));
    } finally {
      await close();
    }
  });

  it('potsherd_read carries everything show --json carries for the same window', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const tool = await call(client, 'potsherd_read', {
        session: id,
        start_line: 1,
        end_line: 2,
      });
      sameAs(cliJson(['show', id, '--from', '1', '--to', '2']), tool);
    } finally {
      await close();
    }
  });

  it('potsherd_tag carries everything tag --json carries', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const tool = await call(client, 'potsherd_tag', { session: id, add: ['parity'] });
      // The CLI reads the same session back with no operands, which is the
      // read path of the same verb and prints the same object.
      const cli = cliJson(['tag', id]);
      expect(tool['tags']).toEqual(cli['tags']);
      expect(tool['session']).toEqual(cli['session']);
      await call(client, 'potsherd_tag', { session: id, remove: ['parity'] });
    } finally {
      await close();
    }
  });
});

describe('potsherd_read pagination', () => {
  it('pages by exchange, 1-based and inclusive, without overlapping', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const p1 = await call(client, 'potsherd_read', { session: id, start_line: 1, end_line: 1 });
      expect(p1['from']).toBe(1);
      expect(p1['to']).toBe(1);
      expect((p1['exchanges'] as unknown[]).length).toBe(1);

      if (p1['hasMore']) {
        const next = Number(p1['nextStartLine']);
        expect(next).toBe(2);
        const p2 = await call(client, 'potsherd_read', { session: id, start_line: next });
        const first = (p2['exchanges'] as { seq: number }[])[0];
        const last = (p1['exchanges'] as { seq: number }[])[0];
        expect(first!.seq).toBeGreaterThan(last!.seq);
      }
    } finally {
      await close();
    }
  });

  it('echoes start_line and end_line, and says when it clamped them', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const wide = await call(client, 'potsherd_read', {
        session: id,
        start_line: 1,
        end_line: 10_000,
      });
      expect(wide['start_line']).toBe(wide['from']);
      expect(wide['end_line']).toBe(wide['to']);
      expect(wide['truncated']).toBe(true);
    } finally {
      await close();
    }
  });

  it('refuses an end before its start, as a tool error', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const r = await callRaw(client, 'potsherd_read', {
        session: id,
        start_line: 9,
        end_line: 2,
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/before start_line/);
    } finally {
      await close();
    }
  });
});

describe('potsherd_tag is the only tool that writes', () => {
  it('adds, normalises, reads back and removes', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const added = await call(client, 'potsherd_tag', { session: id, add: ['Postgres', 'infra'] });
      expect(added['tags']).toEqual(['infra', 'postgres']);
      expect(added['wrote']).toBe(true);

      const found = await call(client, 'potsherd_ls', { tag: 'postgres' });
      expect(Number(found['total'])).toBe(1);

      const read = await call(client, 'potsherd_tag', { session: id });
      expect(read['wrote']).toBe(false);
      expect(read['tags']).toEqual(['infra', 'postgres']);

      const removed = await call(client, 'potsherd_tag', {
        session: id,
        remove: ['postgres', 'infra'],
      });
      expect(removed['tags']).toEqual([]);
    } finally {
      await close();
    }
  });

  it('rejects a string that no tag can be made of', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const r = await callRaw(client, 'potsherd_tag', { session: id, add: ['!!!'] });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/letters, digits/);
    } finally {
      await close();
    }
  });
});

describe('errors are tool errors, and the server stays up', () => {
  it('survives a malformed argument, a missing session and an unreadable index', async () => {
    const { client, close } = await connect();
    try {
      const malformed = await callRaw(client, 'potsherd_find', { query: 42 });
      expect(malformed.isError).toBe(true);
      expect(textOf(malformed)).toMatch(/validation/i);

      const missing = await callRaw(client, 'potsherd_read', { session: 'ffffffffff' });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toMatch(/no session in the index starts with/);

      // The database, taken away underneath a live server.
      const db = paths.dbPath(root);
      const saved = fs.readFileSync(db);
      fs.rmSync(db, { force: true });
      const unreadable = await callRaw(client, 'potsherd_ls', {});
      fs.writeFileSync(db, saved, { mode: 0o600 });
      expect(unreadable.isError).toBe(true);
      expect(textOf(unreadable)).toMatch(/nothing indexed yet/);
      // The fix line survives to the model, exactly as the terminal prints it.
      expect(textOf(unreadable)).toMatch(/try: {2}potsherd index/);

      // ...and it still answers.
      const after = await call(client, 'potsherd_ls', { limit: 1 });
      expect(Number(after['total'])).toBeGreaterThan(0);

      const unknown = await callRaw(client, 'potsherd_nope', {});
      expect(unknown.isError).toBe(true);
      const stillUp = await call(client, 'potsherd_ls', { limit: 1 });
      expect(Number(stillUp['total'])).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

describe('the two model tools with no backend', () => {
  it('potsherd_ask fails cleanly and immediately, naming what to install', async () => {
    const { client, close } = await connect();
    try {
      const started = Date.now();
      const r = await callRaw(client, 'potsherd_ask', { question: 'why did we do that?' });
      const took = Date.now() - started;
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/claude|codex|ANTHROPIC_API_KEY/i);
      // The whole point: not 100 seconds. A hundred milliseconds is already
      // three orders of magnitude of headroom on the measured p50.
      expect(took).toBeLessThan(2_000);
    } finally {
      await close();
    }
  });

  it('potsherd_ask refuses an empty question before it looks for a backend', async () => {
    await expect(runAsk(ctx(), { question: '   ' })).rejects.toThrow(/needs a question/);
  });

  it('potsherd_graft still produces a cited brief on the card-only path', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const r = await call(client, 'potsherd_graft', { session: id, budget: 400 });
      expect(r['via']).toBe('card-only');
      expect(String(r['brief']).length).toBeGreaterThan(0);
      expect(Number(r['tokens'])).toBeLessThanOrEqual(Number(r['budget']));
      expect(r['wrote']).toBe(true);
      expect(fs.existsSync(String(r['path']))).toBe(true);
      // Into the project it was given, never into the process's own cwd.
      expect(String(r['path']).startsWith(project)).toBe(true);
      expect(fs.existsSync(path.join(process.cwd(), '.potsherd'))).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("where potsherd_graft's brief lands", () => {
  const env: NodeJS.ProcessEnv = {};

  it('uses the working directory when it is a plausible project', () => {
    // `path.resolve`, not `realpath`: the check resolves symlinks (macOS's
    // /tmp is one) to decide whether the directory is forbidden, but what it
    // hands back is the path the caller gave, because rewriting somebody's
    // working directory into its physical form is not this function's job.
    expect(resolveGraftCwd(project, env)).toBe(path.resolve(project));
  });

  it('refuses the filesystem root, the home directory and the temp root', () => {
    const os = require('node:os') as typeof import('node:os');
    expect(resolveGraftCwd('/', env)).toBeNull();
    expect(resolveGraftCwd(os.homedir(), env)).toBeNull();
    expect(resolveGraftCwd(os.tmpdir(), env)).toBeNull();
  });

  it('refuses a directory that is not there', () => {
    expect(resolveGraftCwd(path.join(scratch, 'no-such-dir'), env)).toBeNull();
  });

  it('honours POTSHERD_GRAFT_CWD over everything', () => {
    expect(resolveGraftCwd('/', { POTSHERD_GRAFT_CWD: project })).toBe(project);
  });

  it('returns the brief inline, and writes nothing, when there is nowhere to write', async () => {
    const homeless = makeContext({ potsherdDir: root, env: {}, cwd: '/' });
    expect(homeless.graftCwd).toBeNull();
    const { client, close } = await connectInMemory(homeless, 'mcp.test');
    try {
      const id = await anySession(client);
      const r = await call(client, 'potsherd_graft', { session: id, budget: 400 });
      expect(r['path']).toBeNull();
      expect(r['wrote']).toBe(false);
      expect(String(r['brief']).length).toBeGreaterThan(0);
      expect(String(r['writeNote'])).toMatch(/POTSHERD_GRAFT_CWD/);
      expect(fs.existsSync('/.potsherd')).toBe(false);
    } finally {
      await close();
    }
  });
});

/**
 * `03` §9: *mcp tool descriptions decide whether the model uses them*, and the
 * phase file requires three phrasings to be tried.
 *
 * **This is a lexical proxy, not a model trial**, and the numbers below are
 * labelled `est.` wherever they are quoted. The reference machine cannot make a
 * model-path measurement (`phases/phase-5/WAVE.md` item 6: `claude -p` reports
 * `Not logged in` under a relocated HOME), and a trial that called a real model
 * from a unit test would be neither reproducible nor free. What is measured
 * here is the property a description needs in order to be *retrievable*: does
 * the text contain the words a user actually says at the moment the tool is the
 * right move.
 *
 * Two metrics, because one of them is confounded and the other controls for it:
 *
 *   **trigger coverage** — of the phrasings `plans/phases/phase-5` names as the
 *   moments recall should fire ("last time", "we discussed", "why did we"…),
 *   how many appear verbatim in the tool set. Longer text scores higher, which
 *   is exactly the confound.
 *
 *   **routing accuracy under Jaccard** — for each of 16 utterances, the tool
 *   whose description has the highest Jaccard similarity to it. Jaccard divides
 *   by the union, so a long description is *penalised*: this is the metric
 *   verbosity cannot win by itself.
 */
describe('the three phrasings', () => {
  type Set6 = Record<(typeof TOOLS)[number], string>;

  // A — label. What most MCP servers ship.
  const A: Set6 = {
    potsherd_find: 'Search indexed coding-agent sessions.',
    potsherd_read: 'Read a session transcript.',
    potsherd_ask: 'Question answering over session history.',
    potsherd_graft: 'Session brief generator.',
    potsherd_ls: 'List sessions.',
    potsherd_tag: 'Session tag management.',
  };

  // B — capability. A verb phrase describing behaviour.
  const B: Set6 = {
    potsherd_find:
      'Searches your past coding sessions by keyword and returns the matching sessions with quoted snippets, session ids and dates.',
    potsherd_read:
      'Reads the exchanges of one past session in order, a page at a time, with the seq number of each exchange.',
    potsherd_ask:
      'Answers a question from your past sessions by reading the best-matching ones and returning an answer whose every sentence carries a checked citation.',
    potsherd_graft:
      'Compresses one past session into a short cited brief under a token budget and returns the brief.',
    potsherd_ls:
      'Lists your past sessions newest first with titles, projects, dates, tags and the command that resumes each one.',
    potsherd_tag: 'Adds and removes tags on a session and returns the tags it carries afterwards.',
  };

  // C — instruction. What ships.
  const C: Set6 = {
    potsherd_find: shipped.FIND_DESCRIPTION,
    potsherd_read: shipped.READ_DESCRIPTION,
    potsherd_ask: shipped.ASK_DESCRIPTION,
    potsherd_graft: shipped.GRAFT_DESCRIPTION,
    potsherd_ls: shipped.LS_DESCRIPTION,
    potsherd_tag: shipped.TAG_DESCRIPTION,
  };

  /** The moments `plans/phases/phase-5` says recall has to fire on. */
  const TRIGGERS = [
    'last time',
    'we discussed',
    'why did we',
    'what did we decide',
    'do not remember',
    'no access to earlier sessions',
    'never discussed',
    'pick up where we left off',
    'what was i working on',
    'find the session about',
  ];

  const UTTERANCES: [string, (typeof TOOLS)[number]][] = [
    ['find the session about the connection pooler', 'potsherd_find'],
    ['search my past sessions for the retry logic we wrote', 'potsherd_find'],
    ['we discussed this before, look it up', 'potsherd_find'],
    ['which session was the one about icons', 'potsherd_find'],
    ['read the exchanges of that session', 'potsherd_read'],
    ['show me the exact words in session cbcfda7e', 'potsherd_read'],
    ['read the next page of that transcript', 'potsherd_read'],
    ['why did we decide to drop the queue', 'potsherd_ask'],
    ['what was the reasoning behind that choice', 'potsherd_ask'],
    ['pick up where we left off on that project', 'potsherd_graft'],
    ['remind me what state that work was in', 'potsherd_graft'],
    ['what was i working on last week', 'potsherd_ls'],
    ['list my pinned sessions', 'potsherd_ls'],
    ['show everything tagged postgres', 'potsherd_ls'],
    ['tag that one postgres', 'potsherd_tag'],
    ['drop the infra label off that session', 'potsherd_tag'],
  ];

  const words = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

  function jaccard(a: Set<string>, b: Set<string>): number {
    let hit = 0;
    for (const w of a) if (b.has(w)) hit++;
    return hit / (a.size + b.size - hit);
  }

  function score(set: Set6): { coverage: number; routing: number } {
    const all = Object.values(set).join(' ').toLowerCase();
    const coverage = TRIGGERS.filter((t) => all.includes(t)).length;

    const bags = Object.fromEntries(
      Object.entries(set).map(([k, v]) => [k, words(v)]),
    ) as Record<string, Set<string>>;

    let right = 0;
    for (const [utterance, want] of UTTERANCES) {
      const u = words(utterance);
      let best = '';
      let bestScore = -1;
      for (const tool of TOOLS) {
        const s = jaccard(u, bags[tool]!);
        if (s > bestScore) {
          bestScore = s;
          best = tool;
        }
      }
      if (best === want) right++;
    }
    return { coverage, routing: right };
  }

  it('the instruction phrasing wins on both metrics, and the numbers are printed', () => {
    const results = { A: score(A), B: score(B), C: score(C) };

    // Printed rather than only asserted: the phase file asks for the trial, and
    // a trial whose numbers nobody can read is a box ticked, not a measurement.
    const rows = (Object.entries(results) as [string, { coverage: number; routing: number }][])
      .map(
        ([name, r]) =>
          `    ${name}  triggers ${r.coverage}/${TRIGGERS.length}` +
          `   routing ${r.routing}/${UTTERANCES.length} (est., lexical proxy)`,
      )
      .join('\n');
    process.stderr.write(`\n  three phrasings — A label · B capability · C instruction\n${rows}\n`);

    // Coverage: only the instruction phrasing quotes the user back at itself.
    expect(results.C.coverage).toBeGreaterThan(results.A.coverage);
    expect(results.C.coverage).toBeGreaterThan(results.B.coverage);

    // Routing, under a metric that penalises length: the instruction phrasing
    // must not be *worse* than the others, or its extra words are noise.
    expect(results.C.routing).toBeGreaterThanOrEqual(results.A.routing);
    expect(results.C.routing).toBeGreaterThanOrEqual(results.B.routing);
  });

  it('every shipped description is an instruction with a stated boundary', () => {
    for (const [name, text] of Object.entries(C)) {
      // Opens with a directive, not a noun phrase.
      expect(text.startsWith('USE THIS'), name).toBe(true);
      // Names something it is NOT for, or the tool to use instead. A tool with
      // no boundary is reached for at random.
      expect(/Do NOT|instead|rather than/i.test(text), name).toBe(true);
      // Long enough to be an instruction and short enough to be read.
      expect(text.length, name).toBeGreaterThan(200);
      expect(text.length, name).toBeLessThan(1_600);
    }
  });

  it('names its cost where the cost is not free', () => {
    expect(shipped.ASK_DESCRIPTION).toMatch(/40 to 180 seconds/);
    expect(shipped.ASK_DESCRIPTION).toMatch(/costs money/);
    expect(shipped.TAG_DESCRIPTION).toMatch(/ONLY POTSHERD TOOL THAT WRITES/);
  });
});
