import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexAll, paths } from '@potsherd/core';

import { makeContext, resolveGraftCwd } from '../packages/mcp/src/context.js';
import { TOOLS, WRITE_TOOLS } from '../packages/mcp/src/server.js';
import { runRecall } from '../packages/mcp/src/tools/recall.js';
import { AGENT_FLOOR, CONFIDENCE_VALUES } from '../packages/mcp/src/tools/shapes.js';
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

/** A thread the fixture is guaranteed to have. */
async function anySession(client: Client): Promise<string> {
  const r = await call(client, 'potsherd_recall', { query: 'pgbouncer', scope: { limit: 1 } });
  const threads = r['threads'] as { thread: string }[];
  return threads[0]!.thread;
}

describe('the tool list', () => {
  it('is three tools, in the pinned order, and no more', async () => {
    const { client, close } = await connect();
    try {
      const listed = await listTools(client);
      expect(listed.tools.map((t) => t.name)).toEqual([...TOOLS]);
      // Plan §B7: "one skill, three MCP tools". It was six until T10.6, and
      // six was not too many to *hold* — it was too many to *choose between*,
      // which is a different failure and the one the audit measured. A fourth
      // tool fails here before it fails a review.
      expect(listed.tools).toHaveLength(3);
      expect(listed.tools.map((t) => t.name)).toEqual([
        'potsherd_recall',
        'potsherd_read',
        'potsherd_graft',
      ]);
    } finally {
      await close();
    }
  });

  it('the retired tools are gone from the surface, not merely unadvertised', async () => {
    const { client, close } = await connect();
    try {
      for (const name of ['potsherd_find', 'potsherd_ls', 'potsherd_ask', 'potsherd_tag']) {
        const r = await callRaw(client, name, {});
        expect(r.isError, name).toBe(true);
      }
      // ...and the server is still up afterwards.
      expect(Array.isArray((await call(client, 'potsherd_recall', { query: 'pooler' }))['threads'])).toBe(true);
    } finally {
      await close();
    }
  });

  it('annotates readOnlyHint from what the tool does, not from a list', async () => {
    // D5. `potsherd_graft` was annotated `readOnlyHint: true` and creates
    // `./.potsherd/graft-<id8>.md` and a `.gitignore` in the user's project.
    // `readOnlyHint` is the machine-readable field a client reads to decide
    // what may run WITHOUT ASKING, so that annotation let a model put files in
    // somebody's repository with no prompt.
    //
    // The old shape of this test — `readOnlyHint === !WRITE_TOOLS.includes()`
    // plus `expect(WRITE_TOOLS).toEqual(['potsherd_tag'])` — could not catch
    // it: both halves came out of the same wrong constant. So the list is
    // checked against behaviour instead, in `writes exactly the tools it says
    // it writes` below and in `--selftest`.
    const { client, close } = await connect();
    try {
      const listed = await listTools(client);
      for (const t of listed.tools) {
        expect(t.annotations?.readOnlyHint, t.name).toBe(!WRITE_TOOLS.includes(t.name));
      }
      expect(WRITE_TOOLS).toEqual(['potsherd_graft']);
    } finally {
      await close();
    }
  });

  it('says in its instructions which tools write, and does not claim only one does', async () => {
    // The server's `instructions` reach every client verbatim, and they said
    // "potsherd_tag is the only tool here that writes anything" while
    // potsherd_graft was writing files into the user's project.
    const { client, close } = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).not.toMatch(/only tool here that writes/);
      expect(instructions).toMatch(/potsherd_graft creates/);
      // F1 and F3 have to reach the client verbatim, because the instructions
      // are the only prose a model sees before it has called anything.
      expect(instructions).toMatch(/zero rows and that is a real answer/);
      expect(instructions).toMatch(/refused in\s+code/);
    } finally {
      await close();
    }
  });

  it('--selftest keeps to 80 columns and elides with an ellipsis', () => {
    // D11. `--selftest` is a verification command named in the phase file, and
    // `05` governs the screens it prints. It ran to 130 characters, hard-cut
    // mid-word by ad-hoc `.slice(0, 56)` calls with no ellipsis — a reader
    // could not tell a truncated path from a wrong one — and it took no
    // --width.
    const mcpBin = path.join(repo, 'packages', 'mcp', 'dist', 'index.js');
    const at = (width?: number): string[] =>
      execFileSync(
        process.execPath,
        [mcpBin, '--selftest', ...(width === undefined ? [] : ['--width', String(width)])],
        { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
      ).split('\n');

    // The default is 80, with no flag — the form the phase file names.
    for (const line of at()) expect([...line].length, line).toBeLessThanOrEqual(80);

    // Whatever `--width` says, and whatever the paths are.
    for (const width of [60, 100]) {
      const lines = at(width).filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(10);
      for (const line of lines) {
        expect([...line].length, `width ${String(width)}: ${line}`).toBeLessThanOrEqual(width);
      }
    }

    // And nothing is cut without saying so: every line that a narrow run
    // shortened carries an ellipsis. A hard cut mid-word reads as a wrong
    // value, not a clipped one.
    const wide = at(400);
    const narrow = at(60);
    expect(narrow).toHaveLength(wide.length);
    // `wide` and `narrow` are two SEPARATE runs, so anything the run measures
    // about itself differs between them. Comparing raw lengths therefore says
    // "this line got shorter" when all that happened is that the second run was
    // faster: CI caught `  26 checks, all passed  ·  215ms` against a wide run's
    // `649ms` and demanded an ellipsis for a line nothing had clipped.
    //
    // That is this build's most common defect class — a test whose premise is
    // the environment — so the premise is established instead: the volatile
    // spans are replaced by fixed tokens in BOTH runs, and only then is length
    // taken to mean width.
    const stable = (line: string): string =>
      line
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, '<t>')
        .replace(/\b\d[\d,]*\b/g, '<n>')
        .replace(/\/(?:private\/)?(?:var|tmp)\/[^\s]*/g, '<p>');

    let shortened = 0;
    narrow.forEach((line, i) => {
      const full = wide[i]!;
      if ([...stable(line)].length >= [...stable(full)].length) return;
      shortened++;
      expect(line, `cut without an ellipsis: ${line}`).toContain('…');
    });
    expect(shortened, 'nothing was shortened at --width 60').toBeGreaterThan(5);
  });

  it('advertises a json schema for every tool, with the contract fields in it', async () => {
    const { client, close } = await connect();
    try {
      const listed = await listTools(client);
      const props = (name: string): Record<string, unknown> =>
        (listed.tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, unknown> })
          .properties;

      // The pinned shapes from `plans/phases/phase-10-agent-audit.md` §B7,
      // field for field. `budget` on recall is the one addition to the pinned
      // signature and it is reported as such in T10.6-REPORT.md: `want:
      // "context"` is specified as "budgeted" and there was nowhere else to
      // put the ceiling.
      expect(Object.keys(props('potsherd_recall')).sort()).toEqual(
        ['budget', 'query', 'scope', 'want'].sort(),
      );
      expect(Object.keys(props('potsherd_read')).sort()).toEqual(['from', 'thread', 'to']);
      expect(Object.keys(props('potsherd_graft')).sort()).toEqual(['about', 'budget', 'thread']);

      // `scope` is one object rather than nine peers, which is what makes the
      // schema readable as (what to look for, where, how much).
      const scope = (props('potsherd_recall')['scope'] as { properties: Record<string, unknown> })
        .properties;
      expect(Object.keys(scope).sort()).toEqual(
        ['ghosts', 'harness', 'limit', 'pinned', 'project', 'sidechains', 'since', 'tag', 'until'].sort(),
      );
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

  it('potsherd_recall returns the same threads find --json ranks, in the same order', async () => {
    const { client, close } = await connect();
    try {
      const q = 'pgbouncer';
      const tool = await call(client, 'potsherd_recall', { query: q, scope: { limit: 5 } });
      const cli = cliJson(['find', q, '--limit', '5']);

      // Parity is now about the ANSWER, not the envelope: `recall` reshapes
      // sessions into threads and adds the calibration and the citations, so a
      // key-for-key comparison would assert that nothing changed — which is
      // the opposite of what §B7 asked for. What must not change is which
      // threads come back and in what order, because that is the retrieval
      // the CLI and the tool are supposed to share one implementation of.
      const cliIds = (cli['sessions'] as { id: string }[]).map((r) => r.id);
      const toolIds = (tool['threads'] as { links: { sessionId: string }[] }[]).flatMap((t) =>
        t.links.map((l) => l.sessionId),
      );
      expect(toolIds).toEqual(cliIds);

      // The keys the CLI does emit still agree key for key.
      for (const key of ['query', 'vectors', 'ignored', 'relaxed', 'lists']) {
        if (!(key in cli)) continue;
        // `ms` is a duration at every depth: two runs of the same query
        // legitimately differ by a millisecond and that is not a parity
        // failure. `lists[]` carries one per list as well as one at the top.
        expect(stripMs(tool[key]), key).toEqual(stripMs(cli[key]));
      }
      // The fusion's own parameters are the contract's extras — `find` puts
      // them behind `--explain`, this surface puts them on every reply, and a
      // client that can see why a thread ranked where it did can tell a weak
      // match from a strong one without a model.
      for (const key of ['k', 'weights', 'relaxedLists']) {
        expect(tool[key], key).toBeDefined();
      }
    } finally {
      await close();
    }
  });

  it('potsherd_recall reports the project as a short name, never as a path (F9)', async () => {
    const { client, close } = await connect();
    try {
      const tool = await call(client, 'potsherd_recall', { query: 'pgbouncer', scope: { limit: 5 } });
      for (const t of tool['threads'] as { project: string | null; projectPath: string | null }[]) {
        if (t.project === null) continue;
        expect(t.project).not.toContain('/');
        // The path is still there for anyone who needs it — it is just not
        // the field named `project`, which is what the audit caught.
        expect(typeof t.projectPath === 'string' || t.projectPath === null).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it('potsherd_read carries the same exchanges show --json carries for the same window', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const tool = await call(client, 'potsherd_read', { thread: id, from: 1, to: 2 });
      const cli = cliJson(['show', id, '--from', '1', '--to', '2']);
      const cliEx = (cli['exchanges'] as { seq: number; userText: string }[]).map((e) => [
        e.seq,
        e.userText,
      ]);
      const toolEx = (tool['exchanges'] as { seq: number; userText: string }[]).map((e) => [
        e.seq,
        e.userText,
      ]);
      expect(toolEx).toEqual(cliEx);
      expect(tool['total']).toEqual(cli['total']);
    } finally {
      await close();
    }
  });
});

describe('the cliff (F1) — confidence, read and never re-derived', () => {
  it('carries confidence on the envelope and on every row', async () => {
    const { client, close } = await connect();
    try {
      const r = await call(client, 'potsherd_recall', { query: 'pgbouncer', scope: { limit: 3 } });
      expect('confidence' in r).toBe(true);
      expect(typeof r['calibrated']).toBe('boolean');
      expect(typeof r['noMatch']).toBe('boolean');
      for (const t of r['threads'] as { confidence: unknown }[]) {
        expect('confidence' in t).toBe(true);
      }
      for (const h of r['hits'] as { confidence: unknown }[]) {
        expect('confidence' in h).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it('says in words that this build does not calibrate, rather than faking a cliff', async () => {
    // T10.1 has not landed in this tree. `null` is the absence of a
    // measurement and must never be rendered as `none`, which IS one.
    const r = await runRecall(ctx(), { query: 'pgbouncer' });
    if (r['confidence'] === null) {
      expect(r['calibrated']).toBe(false);
      expect(String(r['note'])).toMatch(/does not calibrate its scores yet/);
      expect(r['noMatch']).toBe(false);
    } else {
      expect(['strong', 'weak', 'none']).toContain(r['confidence']);
    }
  });

  it('says what it could not do, on every reply (audit item 9)', async () => {
    const r = await runRecall(ctx(), { query: 'pgbouncer' });
    expect(typeof r['capability']).toBe('string');
    expect(String(r['capability']).length).toBeGreaterThan(0);
  });

  it('want: "context" returns discontiguous windows with seq and ts, under a budget', async () => {
    const r = await runRecall(ctx(), { query: 'pgbouncer', want: 'context', budget: 400 });
    const windows = r['windows'] as { seq: number | null; ts: string | null; text: string; citation: string }[];
    expect(Array.isArray(windows)).toBe(true);
    for (const w of windows) {
      expect(typeof w.text).toBe('string');
      expect('seq' in w && 'ts' in w).toBe(true);
      expect(w.citation).toContain(' · ');
    }
    // The budget is honoured, in the est. tokens the reply itself reports.
    expect(Number(r['windowTokens'])).toBeLessThanOrEqual(Number(r['windowBudget']));
  });

  it('searches at the same floor the human view searches at', async () => {
    // T10.1 landed `minConfidence` and the orchestrator gave `find` the floor
    // at 'weak'. The model-facing door has to search at the SAME floor, or an
    // agent gets rows a human was spared — which is audit F1 with the blame
    // moved rather than the defect fixed.
    expect(AGENT_FLOOR).toBe('weak');
    expect(CONFIDENCE_VALUES).toEqual(['strong', 'weak', 'none']);

    // Asserted on the source as well as on the constant, because the constant
    // being right is worth nothing if the call site stops passing it. This is
    // the one line in the package whose deletion would be silent.
    const src = fs.readFileSync(
      path.join(repo, 'packages', 'mcp', 'src', 'tools', 'recall.ts'),
      'utf8',
    );
    expect(src).toMatch(/\[MIN_CONFIDENCE_FIELD\]:\s*AGENT_FLOOR/);
    expect(src).toMatch(/await recall\(db, query, filters, options\)/);
  });

  it('reports the floor it ran at and how many rows it withheld', async () => {
    const r = await runRecall(ctx(), { query: 'pgbouncer' });
    expect('minConfidence' in r).toBe(true);
    expect('belowFloor' in r).toBe(true);
    const floor = r['minConfidence'];
    expect(floor === null || CONFIDENCE_VALUES.includes(floor as never)).toBe(true);
    const withheld = r['belowFloor'];
    expect(withheld === null || typeof withheld === 'number').toBe(true);
  });

  it('passes T10.1 calibration through untouched rather than re-projecting it', async () => {
    // `{ score, coverage, strength, agreement }` is the arithmetic behind the
    // one-word label. A surface that re-listed its members by hand would drop
    // the fifth one T10.1 adds next, so it is passed through whole.
    const r = await runRecall(ctx(), { query: 'pgbouncer', scope: { limit: 3 } });
    for (const t of r['threads'] as { calibration: unknown }[]) {
      expect('calibration' in t).toBe(true);
    }
    for (const h of r['hits'] as { calibration: unknown }[]) {
      expect('calibration' in h).toBe(true);
    }
  });

  it('an honest empty is zero rows, whatever produced it', async () => {
    // The invariant, asserted unconditionally: whenever the envelope says
    // `none`, there is nothing in the arrays. It holds by construction on the
    // surface as well as in core, so neither side can regress alone.
    for (const query of ['pgbouncer', 'zzzqqq flurblewomp aardvark protocol']) {
      const r = await runRecall(ctx(), { query });
      if (r['confidence'] !== 'none') continue;
      expect(r['noMatch']).toBe(true);
      expect(r['threads']).toEqual([]);
      expect(r['hits']).toEqual([]);
      expect(String(r['note'])).toMatch(/^no match\./);
    }
  });

  it('the nonsense control returns none once the floor is live', async () => {
    // The audit's own control: `find "zzzqqq flurblewomp aardvark protocol"`
    // returned ten rows at 0.0110. Skipped rather than failed while this
    // worktree's core predates T10.1 — the invariant above still binds.
    const r = await runRecall(ctx(), { query: 'zzzqqq flurblewomp aardvark protocol' });
    if (r['confidence'] === null) {
      process.stderr.write(
        '\n  nonsense control: core in this worktree predates T10.1 (confidence null) — invariant asserted, cliff not\n',
      );
      return;
    }
    expect(r['confidence']).toBe('none');
    expect(r['threads']).toEqual([]);
  });

  it('a card hit is labelled as not evidence (F6)', async () => {
    const r = await runRecall(ctx(), { query: 'pgbouncer', scope: { limit: 10 } });
    for (const h of r['hits'] as { kind: string; evidence: string }[]) {
      expect(h.evidence).toBe(h.kind === 'card' || h.kind === 'title' ? 'not-a-transcript' : 'transcript');
    }
  });
});

describe('potsherd_read pagination — the thread is the unit', () => {
  it('pages by exchange, 1-based and inclusive, without overlapping', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const p1 = await call(client, 'potsherd_read', { thread: id, from: 1, to: 1 });
      expect(p1['from']).toBe(1);
      expect(p1['to']).toBe(1);
      expect((p1['exchanges'] as unknown[]).length).toBe(1);

      if (p1['hasMore']) {
        const next = Number(p1['nextFrom']);
        expect(next).toBe(2);
        const p2 = await call(client, 'potsherd_read', { thread: id, from: next });
        const first = (p2['exchanges'] as { seq: number }[])[0];
        const last = (p1['exchanges'] as { seq: number }[])[0];
        expect(first!.seq).toBeGreaterThan(last!.seq);
      }
    } finally {
      await close();
    }
  });

  it('every row carries seq, ts, its own session and a minted citation', async () => {
    // §B7's parenthesis: "paginated, seq+ts — so the windowing subagent never
    // needs filesystem Read". This is that clause, asserted.
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const page = await call(client, 'potsherd_read', { thread: id, from: 1, to: 2 });
      const rows = page['exchanges'] as {
        seq: number;
        ts: string | null;
        sessionId: string;
        id8: string;
        position: number;
        cite: string;
        citation: string;
      }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(typeof r.seq).toBe('number');
        expect('ts' in r).toBe(true);
        expect(r.sessionId.startsWith(r.id8)).toBe(true);
        expect(r.cite).toBe(`${r.id8}@${String(r.seq)}`);
        expect(r.citation).toContain(' · ');
        expect(typeof r.position).toBe('number');
      }
      // The citations block is the only legal source of a source line.
      expect((page['citations'] as unknown[]).length).toBeGreaterThan(0);
      expect(String(page['citationRule'])).toMatch(/refused as a citation/);
    } finally {
      await close();
    }
  });

  it('resolves the thread through core, with no fallback left to take', async () => {
    // D1. This assertion used to accept `session-only` as well, and that is
    // exactly how the defect survived a release: `tools/thread.ts` probed core
    // for `resolveThread`, the name did not exist, and the tool told the model
    // in prose that potsherd "does not model fork/resume chains yet" while
    // `potsherd_graft` reported the whole chain from the same index.
    //
    // The probe is gone and `resolveThread` is a normal import, so `via` has
    // one legal value. Reintroduce a silent fallback and this fails — which is
    // the point: a graceful degradation with no alarm becomes permanent.
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const page = await call(client, 'potsherd_read', { thread: id, from: 1, to: 1 });
      const thread = page['thread'] as { via: string; note: string | null; links: unknown[] };
      expect(thread.via).toBe('core');
      expect(thread.note).toBeNull();
      expect(JSON.stringify(page)).not.toMatch(/does not model fork\/resume chains/);
      expect(thread.links.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('clamps a window wider than the thread, and says when it clamped', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const wide = await call(client, 'potsherd_read', { thread: id, from: 1, to: 10_000 });
      expect(wide['to']).toBe(wide['total']);
      expect(wide['truncated']).toBe(true);
      expect(wide['hasMore']).toBe(false);
    } finally {
      await close();
    }
  });

  it('refuses an end before its start, as a tool error', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const r = await callRaw(client, 'potsherd_read', { thread: id, from: 9, to: 2 });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/is before from/);
    } finally {
      await close();
    }
  });
});

describe('the one tool that writes, and the two that do not', () => {
  it('writes exactly the tools it says it writes', { timeout: 60_000 }, async () => {
    // The structural half of D5: which tools write is decided by watching,
    // not by reading `WRITE_TOOLS`. Annotate a writer read-only, or list a
    // reader as a writer, and this fails whichever way the constant is edited.
    const witness = tempDir('potsherd-mcp-writes-');
    try {
      const observed: string[] = [];
      const listing = (): string => {
        const out: string[] = [];
        const walk = (dir: string, rel = ''): void => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            const key = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(dir, e.name), key);
            else out.push(`${key}:${String(fs.statSync(path.join(dir, e.name)).size)}`);
          }
        };
        walk(witness);
        return out.join('|');
      };

      const { client, close } = await connectInMemory(
        makeContext({ potsherdDir: root, env: { ...OFFLINE }, cwd: witness }),
        'mcp.test.writes',
      );
      try {
        const id = await anySession(client);
        const calls: [string, Record<string, unknown>][] = [
          ['potsherd_recall', { query: 'pooler', scope: { limit: 1 } }],
          ['potsherd_recall', { query: 'pooler', want: 'context' }],
          ['potsherd_read', { thread: id }],
          ['potsherd_graft', { thread: id.slice(0, 8), budget: 300 }],
        ];
        for (const [name, args] of calls) {
          const before = listing();
          await callRaw(client, name, args);
          if (listing() !== before && !observed.includes(name)) observed.push(name);
        }

        expect(observed.sort()).toEqual([...WRITE_TOOLS].sort());

        const listed = await listTools(client);
        for (const t of listed.tools) {
          expect(t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe(
            !observed.includes(t.name),
          );
        }
      } finally {
        await close();
      }
    } finally {
      rmrf(witness);
    }
  });

  it('nothing on the agent surface can change the index any more', async () => {
    // `potsherd_tag` was the only tool that wrote to the index, and it is
    // retired: the audit's §4.5 puts tag, pin, link, card, ls, stats and
    // doctor in the human CLI. The consequence is worth pinning rather than
    // assuming — the agent surface is now read-only except for one file it
    // writes into the user's own project.
    expect(WRITE_TOOLS).toEqual(['potsherd_graft']);
    const { client, close } = await connect();
    try {
      const listed = await listTools(client);
      const writers = listed.tools.filter((t) => t.annotations?.readOnlyHint === false);
      expect(writers.map((t) => t.name)).toEqual(['potsherd_graft']);
    } finally {
      await close();
    }
  });
});

describe('the stdio transport', () => {
  /**
   * D14. A line that is not JSON produced NO reply at all — not even the
   * `-32700` JSON-RPC 2.0 prescribes. The SDK's ReadBuffer throws,
   * StdioServerTransport catches and calls `onerror`, and the default
   * `onerror` does nothing. The server stayed up and perfectly silent, and the
   * client that sent the frame waited for its id forever.
   */
  it('answers an unparseable frame with -32700 and stays up', { timeout: 60_000 }, async () => {
    const mcpBin = path.join(repo, 'packages', 'mcp', 'dist', 'index.js');
    const child = spawn(process.execPath, [mcpBin, '--potsherd-dir', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const send = (s: string): void => { child.stdin.write(s + '\n'); };
    const settle = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 900));
    };

    try {
      send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }));
      await settle();
      const afterInit = out.length;
      expect(afterInit, 'initialize was not answered').toBeGreaterThan(0);

      // Truncated: valid up to the missing closing brace.
      send('{"jsonrpc":"2.0","id":2,"method":"tools/list"');
      await settle();
      const reply = out.slice(afterInit);
      expect(reply, 'the client got nothing back at all').not.toBe('');
      const parsed = JSON.parse(reply.trim().split('\n')[0]!) as {
        error: { code: number; message: string };
        id: null;
      };
      expect(parsed.error.code).toBe(-32700);
      // `id: null`, because the id was inside the bytes that would not parse.
      expect(parsed.id).toBe(null);
      expect(err).toMatch(/unparseable frame/);

      // …and the session survives it, which is the rule the server is under.
      const before = out.length;
      send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }));
      await settle();
      expect(out.slice(before)).toContain('potsherd_recall');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('errors are tool errors, and the server stays up', () => {
  it('survives a malformed argument, a missing thread and an unreadable index', async () => {
    const { client, close } = await connect();
    try {
      const malformed = await callRaw(client, 'potsherd_recall', { query: 42 });
      expect(malformed.isError).toBe(true);
      expect(textOf(malformed)).toMatch(/validation/i);

      const missing = await callRaw(client, 'potsherd_read', { thread: 'ffffffffff' });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toMatch(/no thread in the index starts with/);

      // The database, taken away underneath a live server.
      const db = paths.dbPath(root);
      const saved = fs.readFileSync(db);
      fs.rmSync(db, { force: true });
      const unreadable = await callRaw(client, 'potsherd_recall', { query: 'anything' });
      fs.writeFileSync(db, saved, { mode: 0o600 });
      expect(unreadable.isError).toBe(true);
      expect(textOf(unreadable)).toMatch(/nothing indexed yet/);
      // The fix line survives to the model, exactly as the terminal prints it.
      expect(textOf(unreadable)).toMatch(/try: {2}potsherd index/);

      // ...and it still answers.
      const after = await call(client, 'potsherd_recall', { query: 'pgbouncer', scope: { limit: 1 } });
      expect((after['threads'] as unknown[]).length).toBeGreaterThan(0);

      const unknown = await callRaw(client, 'potsherd_nope', {});
      expect(unknown.isError).toBe(true);
      const stillUp = await call(client, 'potsherd_recall', { query: 'pgbouncer', scope: { limit: 1 } });
      expect((stillUp['threads'] as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

describe('potsherd_graft with no backend', () => {
  it('takes its deadline from the environment', () => {
    expect(makeContext({ env: {}, cwd: project }).askTimeoutMs).toBe(240_000);
    expect(
      makeContext({ env: { POTSHERD_MCP_ASK_TIMEOUT_MS: '1500' }, cwd: project }).askTimeoutMs,
    ).toBe(1_500);
    // Nonsense falls back rather than disabling the ceiling.
    expect(
      makeContext({ env: { POTSHERD_MCP_ASK_TIMEOUT_MS: 'soon' }, cwd: project }).askTimeoutMs,
    ).toBe(240_000);
  });

  it('still produces a cited brief on the card-only path', async () => {
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      // Whether the *checkout* already has a .potsherd/ is not this test's
      // business: a stray one from any earlier run in this directory would
      // otherwise read as "the server wrote here", which is the opposite of
      // what is being asserted. Record the before-state and compare.
      const cwdDotPotsherd = path.join(process.cwd(), '.potsherd');
      const existedBefore = fs.existsSync(cwdDotPotsherd);
      const r = await call(client, 'potsherd_graft', { thread: id, budget: 400 });
      expect(r['via']).toBe('card-only');
      expect(String(r['brief']).length).toBeGreaterThan(0);
      expect(Number(r['tokens'])).toBeLessThanOrEqual(Number(r['budget']));
      expect(r['wrote']).toBe(true);
      expect(fs.existsSync(String(r['path']))).toBe(true);
      // Into the project it was given, never into the process's own cwd.
      expect(String(r['path']).startsWith(project)).toBe(true);
      expect(fs.existsSync(cwdDotPotsherd)).toBe(existedBefore);
    } finally {
      await close();
    }
  });

  it('runs the source check in code on every call, and keeps its own footer', async () => {
    // F3, one level up from `filterAnswer`. `graft`'s brief ends with
    // `source: <harness> <id> · <n> exchanges · <date>` — a true source line,
    // which the check has to KEEP. The refusal only exists to remove lines
    // whose id does not resolve, and a check that ate true lines would be a
    // worse defect than the one it was written for.
    const { client, close } = await connect();
    try {
      const id = await anySession(client);
      const r = await call(client, 'potsherd_graft', { thread: id, budget: 400 });
      expect(r['sourcesChecked']).toBe(true);
      expect(r['refusedSources']).toEqual([]);
      expect(r['refusedNote']).toBeNull();
      expect(String(r['brief'])).toMatch(/^source: /m);
    } finally {
      await close();
    }
  });

  it('takes words as well as an id, and reports the thread it landed on', async () => {
    // §B7 names the parameter `thread_or_query`. The v1.1.0 surface refused
    // the query fallback; with `find` folded into `recall` and this named in
    // the audit's own two-tool list, the words are a legitimate way in.
    const { client, close } = await connect();
    try {
      const r = await call(client, 'potsherd_graft', { thread: 'pgbouncer', budget: 300 });
      expect(String(r['brief']).length).toBeGreaterThan(0);
      const thread = r['thread'] as { id: string; via: string; partial: boolean } | null;
      expect(thread).not.toBeNull();
      expect(thread!.via).toBe('core');
    } finally {
      await close();
    }
  });

  it('says so, rather than guessing, when nothing matches the words', async () => {
    const { client, close } = await connect();
    try {
      const r = await callRaw(client, 'potsherd_graft', {
        thread: 'zzzqqq flurblewomp aardvark protocol',
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/nothing in the index matches/);
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
      const r = await call(client, 'potsherd_graft', { thread: id, budget: 400 });
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
  type Set3 = Record<(typeof TOOLS)[number], string>;

  // A — label. What most MCP servers ship.
  const A: Set3 = {
    potsherd_recall: 'Search indexed coding-agent sessions.',
    potsherd_read: 'Read a session transcript.',
    potsherd_graft: 'Session brief generator.',
  };

  // B — capability. A verb phrase describing behaviour.
  const B: Set3 = {
    potsherd_recall:
      'Searches your past coding sessions by keyword and returns the matching threads with quoted snippets, session ids, dates and a confidence label.',
    potsherd_read:
      'Reads the exchanges of one past thread in order, a page at a time, with the seq number and timestamp of each exchange.',
    potsherd_graft:
      'Compresses one past thread into a short cited brief under a token budget and returns the brief.',
  };

  // C — instruction. What ships.
  const C: Set3 = {
    potsherd_recall: shipped.RECALL_DESCRIPTION,
    potsherd_read: shipped.READ_DESCRIPTION,
    potsherd_graft: shipped.GRAFT_DESCRIPTION,
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
    'that thing we tried',
  ];

  const UTTERANCES: [string, (typeof TOOLS)[number]][] = [
    ['search my past sessions for the retry logic we wrote', 'potsherd_recall'],
    ['we discussed this before, look it up', 'potsherd_recall'],
    ['which session was the one about icons', 'potsherd_recall'],
    ['what was i working on last week', 'potsherd_recall'],
    ['read the exchanges of that thread', 'potsherd_read'],
    ['read the next page of that transcript', 'potsherd_read'],
    ['quote the exact words rather than the snippet', 'potsherd_read'],
    ['pick up where we left off on that project', 'potsherd_graft'],
    ['remind me what state that work was in', 'potsherd_graft'],
    ["i'm restarting that project, carry it forward", 'potsherd_graft'],
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

  function score(set: Set3): { coverage: number; routing: number } {
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
      expect(text.length, name).toBeLessThan(2_400);
    }
  });

  it('names its cost, and the two things a model must be told before it calls', () => {
    // D5: graft writes into the user's project, and the description that a
    // model reads before calling it has to say so in the same register.
    expect(shipped.GRAFT_DESCRIPTION).toMatch(/IT WRITES TO THE USER'S PROJECT/);
    // F1: an empty result is an answer, and the description is where a model
    // learns to believe one.
    expect(shipped.RECALL_DESCRIPTION).toMatch(/TRUST ITS SILENCE/);
    expect(shipped.RECALL_DESCRIPTION).toMatch(/ZERO rows/);
    // The one cost that is not free is still named; recall's is not.
    expect(shipped.RECALL_DESCRIPTION).toMatch(/no model call, no cost/);
  });

  it('keeps the parked candidates in the file, exactly one live per tool', () => {
    // The convention `skills/remembering-sessions/SKILL.md` established and
    // T10.6's acceptance item 7 carries over: the alternatives stay where the
    // next person can try them, and exactly one is uncommented.
    const src = fs.readFileSync(
      path.join(repo, 'packages', 'mcp', 'src', 'descriptions.ts'),
      'utf8',
    );
    for (const name of ['RECALL_DESCRIPTION', 'READ_DESCRIPTION', 'GRAFT_DESCRIPTION']) {
      const live = src.match(new RegExp(`^export const ${name} =`, 'gm')) ?? [];
      const parked = src.match(new RegExp(`^// export const ${name} =`, 'gm')) ?? [];
      expect(live, name).toHaveLength(1);
      expect(parked, name).toHaveLength(2);
    }
  });
});
