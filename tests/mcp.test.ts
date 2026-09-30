import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db as store, indexAll, paths, writeCard, defaultBudget, countTransportTokens, type MemoryResponse, type EvidenceItem } from '@potsherd/core';

import { makeContext, resolveGraftCwd } from '../packages/mcp/src/context.js';
import { TOOLS, WRITE_TOOLS } from '../packages/mcp/src/server.js';
import { NEAREST_THREADS, capabilityLine, runRecall } from '../packages/mcp/src/tools/recall.js';
// FIX-I C-1. `orderByLabel` was this door's own copy of FIX-D's rule and is
// gone: the comparator lives in core, `recall()` applies it, and this door
// takes the order it is given. `packages/core/src/index.ts` is another
// worker's file this phase, so it is imported from the module that owns it.
import { byLabel, summaryRank } from '../packages/core/src/recall.js';
import { describeError } from '../packages/mcp/src/errors.js';
import { AGENT_FLOOR, CONFIDENCE_VALUES } from '../packages/mcp/src/tools/shapes.js';
import {
  call,
  callRaw,
  connectInMemory,
  listTools,
  textOf,
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

describe('legacy recall diagnostic calibration (F1)', () => {
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
    // C-1 step 3 — the call site now passes the *requested* floor, which is
    // `AGENT_FLOOR` when the caller named none. Both halves are asserted,
    // because the constant being right is worth nothing if the resolution
    // stops defaulting to it, and the default being right is worth nothing if
    // the call site stops passing what it resolved.
    expect(src).toMatch(/\[MIN_CONFIDENCE_FIELD\]:\s*requestedFloor/);
    expect(src).toMatch(/const requestedFloor: Confidence = args\.minConfidence \?\? AGENT_FLOOR;/);
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
      // C-1 step 3. Still `no match`, and now it says WHICH empty: nothing
      // matched at all, or something matched and none of it cleared the floor.
      // The old text asserted here — "no match. The archive does not contain
      // this" — was a claim about the archive's contents that the floor is not
      // able to make; C-1 §1 measures it false on 50 of 60 benchmark queries.
      expect(String(r['note'])).toMatch(/^no match: /);
      expect(String(r['note'])).not.toMatch(/The archive does not contain this/);
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
    const settle = async (predicate: () => boolean): Promise<void> => {
      const until = Date.now() + 10_000;
      while (!predicate() && Date.now() < until) {
        if (child.exitCode !== null) throw new Error(`MCP child exited: ${err}`);
        await new Promise(r => setTimeout(r, 20));
      }
      expect(predicate(), `MCP reply deadline: ${err}`).toBe(true);
    };

    try {
      send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }));
      await settle(() => out.includes('\n'));
      const afterInit = out.length;
      expect(afterInit, 'initialize was not answered').toBeGreaterThan(0);

      // Truncated: valid up to the missing closing brace.
      send('{"jsonrpc":"2.0","id":2,"method":"tools/list"');
      await settle(() => out.slice(afterInit).includes('\n'));
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
      await settle(() => out.slice(before).includes('\n'));
      expect(out.slice(before)).toContain('potsherd_recall');
    } finally {
      child.kill('SIGKILL');
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
});

describe('FIX-C — no instruction an agent cannot follow', () => {
  /**
   * A shell verb, in the forms this repo has actually shipped one: a bare
   * `run …`, a pipeline, `jq`, or a `potsherd <verb>` invocation. The three MCP
   * tools are the only things the caller can reach.
   */
  const SHELL = /\brun\s|\bjq\b|\|\s|potsherd\s+(index|ls|find|audit|stats|doctor)\b|--embed\b/;

  it('C1 — the capability line at 0 vectors offers no shell command', async () => {
    // Both branches an empty index reaches: a query that hits, and one that
    // does not. Before FIX-C the second read
    //   `SEMANTIC SEARCH UNAVAILABLE — … (no embeddings in the index — run  potsherd index --embed)`
    for (const query of ['pgbouncer', 'zzzqqq flurblewomp aardvark protocol']) {
      const r = await runRecall(ctx(), { query });
      expect(String(r['capability']), query).not.toMatch(SHELL);
    }
  });

  it('C1 — a warming index is called warming, not UNAVAILABLE', async () => {
    // "UNAVAILABLE" is a claim about a permanent state. An index that is 0%
    // embedded and climbing is transient, and the repo's own word for it —
    // `warmingLine` in `doctor-line.ts` — is `warming`.
    //
    // **FIX-F C2 amended the fixture, not the rule.** This root is 0-embedded
    // and nothing is embedding it — no `.lock.embed`, no worker, no runtime —
    // so `warming` was never true here, which is the whole of C2. The claim
    // this test exists to pin is that a *transient* state is not shouted at as
    // a permanent one, and it is pinned in both directions now: with a worker
    // holding the lane the word is `warming`, and without one it is neither
    // `warming` nor `UNAVAILABLE`.
    const dir = path.join(root, '.lock.embed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        op: 'embed',
        at: new Date().toISOString(),
        host: process.env.HOSTNAME ?? '',
      }),
    );
    try {
      const r = await runRecall(ctx(), { query: 'pgbouncer' });
      expect(String(r['capability'])).toMatch(/warming/);
      expect(String(r['capability'])).not.toMatch(/UNAVAILABLE/);
    } finally {
      rmrf(dir);
    }
    const stopped = await runRecall(ctx(), { query: 'pgbouncer' });
    expect(String(stopped['capability'])).not.toMatch(/UNAVAILABLE/);
    expect(String(stopped['capability'])).not.toMatch(/warming/);
  });

  it('C1 — a count is always `N of M`, never a bare numerator', async () => {
    // `928 vectors` cannot be told apart from a finished index. Every human
    // verb prints `of 4,725`; this door now reads the same `vecStatus` report.
    const r = await runRecall(ctx(), { query: 'pgbouncer' });
    expect(String(r['capability'])).toMatch(/\d[\d,]* of \d[\d,]* embedded/);
  });

  it('C1 — the `used` branch carries the denominator too', () => {
    const line = capabilityLine(
      { used: true, available: true, vectors: 928 },
      { phase: 'warming', embedded: 928, pending: 3797, total: 4725, runtimeReady: true, acquireBytes: 0 },
    );
    expect(line).toMatch(/928 of 4,725 embedded/);
    // The bare numerator is gone, not merely joined by a denominator.
    expect(line).not.toMatch(/928 vectors/);
  });

  it('C1 — a genuinely unavailable runtime still says unavailable', () => {
    // The warming wording must not swallow a real failure. `phase: empty` with
    // `available: false` is an index that has no vectors and no pending work.
    const line = capabilityLine(
      { used: false, available: false, reason: 'no vector index — never built' },
      { phase: 'empty', embedded: 0, pending: 0, total: 0, runtimeReady: false, acquireBytes: 0 },
    );
    expect(line).toMatch(/unavailable/i);
    expect(line).toMatch(/never built/);
  });

  it('C1 — with no report at hand it says less rather than guessing', () => {
    // No denominator is available at this call site, so no numerator is
    // printed either. Silence beats a number that cannot be interpreted.
    const line = capabilityLine({ used: true, available: true, vectors: 928 });
    expect(line).not.toMatch(/928/);
  });

  it('C2 — `noMatch` discloses that only the keyword half ran', async () => {
    // An agent told "the archive does not contain this" deserves to know the
    // semantic half was never consulted. The verifier sized the gap: the same
    // query answers 1 session with vectors on and 0 with them off.
    const r = await runRecall(ctx(), { query: 'zzzqqq flurblewomp aardvark protocol' });
    expect(r['noMatch']).toBe(true);
    expect(String(r['note'])).toMatch(/keyword/i);
  });

  it('C3 — an unmatched project names the projects instead of a pipeline', async () => {
    // Was: `try:  potsherd ls --json | jq -r ".sessions[].project" | sort -u`.
    let text = '';
    try {
      await runRecall(ctx(), { query: 'pgbouncer', scope: { project: 'no-such-project-4b1' } });
    } catch (err) {
      text = describeError(err);
    }
    expect(text).toMatch(/no indexed project matches/);
    expect(text).not.toMatch(SHELL);
    // It states how many the index holds, so a truncated list is visibly
    // truncated rather than silently five-of-eighteen.
    expect(text).toMatch(/index holds \d+/);
  });
});

/**
 * FIX-D C5a — the first row is the best row.
 *
 * The third verifier caught `hit0 score 0.016393 conf weak` above
 * `hit1 score 0.016393 conf strong` at this door. `hits[]` came back in the
 * order core merged them — reciprocal rank fusion, a function of rank alone —
 * and every row was labelled from `calibration`, which is computed from the
 * evidence RRF throws away. Two right numbers, one wrong impression: the reader
 * here is a model, and every consumer of a ranked list assumes the top row is
 * the best one before it reads a single field.
 *
 * The order is now the label's. These are the fence, and they fail if the two
 * ever drift apart again — which is the property the item asked for, not the
 * one-off reshuffle.
 */
describe('FIX-D — the order agrees with the label', () => {
  const RANK: Record<string, number> = { strong: 0, weak: 1, none: 2 };
  const row = (confidence: string, cal: number, score: number, tag: string) => ({
    confidence: confidence as 'strong' | 'weak' | 'none',
    calibration: { score: cal, confidence, coverage: 0, strength: 0, agreement: 0 },
    score,
    tag,
  });

  /**
   * FIX-I C-1 — these three cases are FIX-D's, run against the comparator in
   * its new home.
   *
   * They used to call `orderByLabel`, which lived in
   * `packages/mcp/src/tools/recall.ts` and which `packages/cli` never
   * imported: the rule was right and only one of the two doors had it. It is
   * `byLabel` in `packages/core/src/recall.ts` now, `recall()` applies it to
   * `sessions` and to `hits`, and both doors read the result — so a fence on
   * the comparator is a fence on both doors at once, which is what it was
   * always supposed to be.
   */
  it('C5a — the verifier\'s two rows come back the other way round', () => {
    // Verbatim from VERIFICATION-3 §C5: same fused score, opposite labels,
    // the weak one first because RRF put it there.
    const merged = [row('weak', 0.5667, 0.016393, 'hit0'), row('strong', 0.85, 0.016393, 'hit1')];
    expect(merged.map((r) => r.tag)).toEqual(['hit0', 'hit1']);
    expect([...merged].sort(byLabel).map((r) => r.tag)).toEqual(['hit1', 'hit0']);
  });

  it('C5a — the word wins over the number, because the number can be capped', () => {
    // A routing row is capped at ROUTING_CEILING (`weak`) however well it
    // scores, so a sort on `calibration.score` alone would put a card back on
    // top of a transcript. This is why the first key is the label.
    const card = row('weak', 0.92, 0.016393, 'card');
    const transcript = row('strong', 0.61, 0.008197, 'transcript');
    expect([card, transcript].sort(byLabel).map((r) => r.tag)).toEqual(['transcript', 'card']);
  });

  it('C5a — inside one band it is calibration first, then the fused score', () => {
    const rows = [
      row('weak', 0.40, 0.016393, 'low-cal-high-rrf'),
      row('weak', 0.55, 0.008197, 'high-cal-low-rrf'),
      row('weak', 0.55, 0.009524, 'high-cal-higher-rrf'),
    ];
    expect([...rows].sort(byLabel).map((r) => r.tag)).toEqual([
      'high-cal-higher-rrf',
      'high-cal-low-rrf',
      'low-cal-high-rrf',
    ]);
  });

  it('C5a — it moves rows and never adds, drops or edits one', () => {
    const rows = [row('none', 0.2, 0.01, 'a'), row('strong', 0.9, 0.002, 'b'), row('weak', 0.5, 0.03, 'c')];
    const out = [...rows].sort(byLabel);
    expect(out).toHaveLength(rows.length);
    expect([...out].sort((x, y) => x.tag.localeCompare(y.tag))).toEqual(
      [...rows].sort((x, y) => x.tag.localeCompare(y.tag)),
    );
    // The same objects, not copies: nothing here rewrites a row.
    for (const r of rows) expect(out).toContain(r);
  });

  it('C5a — a build whose core carries no label leaves the merge order alone', () => {
    // `null` is not `none`. With no label there is nothing for the order to
    // contradict, so the fused order — which is a real ordering — stands.
    const rows = [
      { calibration: null, score: 0.008, tag: 'a' },
      { calibration: null, score: 0.016, tag: 'b' },
    ];
    expect([...rows].sort(byLabel).map((r) => r.tag)).toEqual(['b', 'a']);
  });

  it('C5a — the real envelope: hits[] never labels the top row weaker than one below it', async () => {
    // `statement` is the query that makes this falsifiable rather than
    // decorative: on the committed fixture it returned `none, strong` — the
    // verifier's shape exactly — before the ordering landed. Unwire
    // core's comparator and this case goes red, which is the whole point of it.
    let sawTwoLabels = false;
    for (const query of ['statement', 'pgbouncer', 'transaction pooling', 'the', 'and the']) {
      const r = await runRecall(ctx(), { query });
      const hits = (r['hits'] ?? []) as { confidence: string; calibration: { score: number } }[];
      if (new Set(hits.map((h) => h.confidence)).size > 1) sawTwoLabels = true;
      for (let i = 1; i < hits.length; i++) {
        expect(
          RANK[hits[i - 1]!.confidence]!,
          `${query}: hit${String(i - 1)} is ${hits[i - 1]!.confidence} above hit${String(i)} ${hits[i]!.confidence}`,
        ).toBeLessThanOrEqual(RANK[hits[i]!.confidence]!);
      }
    }
    // ...and the fence is not vacuous: at least one of those queries really
    // does return rows carrying two different labels.
    expect(sawTwoLabels).toBe(true);
  });

  it('C5a — and threads[], which is the list an agent picks a thread from', async () => {
    for (const query of ['statement', 'pgbouncer', 'transaction pooling', 'the', 'and the']) {
      const r = await runRecall(ctx(), { query });
      const threads = (r['threads'] ?? []) as { confidence: string }[];
      for (let i = 1; i < threads.length; i++) {
        expect(
          RANK[threads[i - 1]!.confidence]!,
          `${query}: thread${String(i - 1)} is ${threads[i - 1]!.confidence} above thread${String(i)} ${threads[i]!.confidence}`,
        ).toBeLessThanOrEqual(RANK[threads[i]!.confidence]!);
      }
    }
  });
});

// --------------------------------------------------------------------- FIX-F

/**
 * FIX-F — the door stops claiming work that will never run, and stops handing
 * out a citation for a session whose transcript it has never seen.
 *
 * Three findings, one shape: **a field that was true of one state was printed
 * in every state.** `warming` was true of an index somebody is embedding and
 * printed on one nobody is; `citable` was true of a thread with transcript
 * evidence and printed on a thread that matched six model-written words of
 * title; `readMore` was suppressed on an empty page, which is the one page it
 * is the whole answer to.
 *
 * Everything here drives `runRecall` — the function the real server calls —
 * against purpose-built roots, because the fixture corpus has neither a
 * title-only match nor an exchange longer than the context budget.
 */
describe('FIX-F — the door stops claiming what it cannot know', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots.splice(0)) rmrf(r);
  });

  function open(name: string): { root: string; db: ReturnType<typeof store.open> } {
    const root = tempDir(name);
    roots.push(root);
    return { root, db: store.open({ root }) };
  }

  function session(
    db: ReturnType<typeof store.open>,
    id: string,
    title: string,
    body: string,
  ): void {
    db.prepare(
      `INSERT INTO sessions (id, harness, project, source_path, indexed_at, started_at, ended_at, title)
       VALUES (?, 'claude', '/tmp/fixf', ?, '2026-08-23T00:00:00Z', '2026-08-20T00:00:00Z', '2026-08-20T01:00:00Z', ?)`,
    ).run(id, `/tmp/fixf/${id}.jsonl`, title);
    db.prepare(
      `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
       VALUES (?, ?, 0, '2026-08-20T00:10:00Z', ?, 'noted.')`,
    ).run(`${id}-e0`, id, body);
  }

  /**
   * One thread whose **title** matches the query and whose body does not, and
   * one whose body does. The reference-archive shape, in eight rows.
   */
  function summaryRoot(): string {
    const { root, db } = open('potsherd-fixf-summary-');
    try {
      // Matches on `titles` only: the body says none of the query's words.
      session(db, 'ttt11111-1111-4111-8111-111111111111', 'kestrel migration notes',
        'we spent the whole session on unrelated packaging questions');
      // Matches on `exchanges_fts`: the body says both, the title says neither.
      session(db, 'eee22222-2222-4222-8222-222222222222', 'packaging questions',
        'the kestrel migration was postponed until the quarter after next');
      // fts5 with `content='exchanges'` is an external-content index: rows put
      // into `exchanges` by hand are invisible to `MATCH` until it is rebuilt.
      // `ingest.ts` writes both sides; these fixtures write one, so they say so.
      db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
    } finally {
      db.close();
    }
    return root;
  }

  /** One thread whose only matching exchange is longer than the whole budget. */
  function oversizedRoot(): string {
    const { root, db } = open('potsherd-fixf-oversized-');
    try {
      // 60,000 chars against a 6,000-token (24,000-char) default ceiling.
      session(db, 'ooo33333-3333-4333-8333-333333333333', 'packaging questions',
        `kestrel ${'the same sentence again and again. '.repeat(1700)}`);
      db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
    } finally {
      db.close();
    }
    return root;
  }

  /**
   * Hold the embed lane the way the background worker holds it: a `.lock.embed`
   * directory with an `owner.json` naming a live pid. `lock.holder()` reads
   * exactly this, and `lock.isStale` reads exactly this pid.
   */
  function holdEmbedLane(root: string): () => void {
    const dir = path.join(root, '.lock.embed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        op: 'embed',
        at: new Date().toISOString(),
        host: process.env.HOSTNAME ?? '',
      }),
    );
    return () => rmrf(dir);
  }

  const at = (r: string) => makeContext({ potsherdDir: r, env: { ...OFFLINE }, cwd: project });

  // ------------------------------------------------------------------- C2

  it('C2 — an index nobody is embedding is not called warming', async () => {
    // The state of every `index --no-embed`, every offline first run, and every
    // index whose embedder was killed: rows pending, `phase: "pending"`, and
    // no holder of `<root>/.lock.embed` anywhere.
    const r = await runRecall(at(summaryRoot()), { query: 'kestrel migration' });
    expect(String(r['capability'])).toMatch(/not running/);
    expect(String(r['capability'])).not.toMatch(/warming/);
    // ...and it still carries the denominator FIX-C put there.
    expect(String(r['capability'])).toMatch(/\d[\d,]* of \d[\d,]* embedded/);
    // No command: the caller has three tools and no shell.
    expect(String(r['capability'])).not.toMatch(/\brun\s|potsherd\s+index/);
  });

  it('C2 — and the same index IS called warming while a worker holds the lane', async () => {
    // The distinction is the whole finding: one word for work in flight, a
    // different one for work that has stopped, never one word widened over
    // both. Same root, same query, same rows — only the lock changes.
    const root = summaryRoot();
    const release = holdEmbedLane(root);
    try {
      const r = await runRecall(at(root), { query: 'kestrel migration' });
      expect(String(r['capability'])).toMatch(/warming/);
      expect(String(r['capability'])).not.toMatch(/not running/);
    } finally {
      release();
    }
  });

  it('C2 — a stale lock whose holder is dead reads as stopped, not as warming', async () => {
    // `lock.isStale` decides a lock with a readable owner by whether that pid
    // is alive. A crashed embedder leaves the directory behind; the evidence
    // that matters is the pid, not the file.
    const root = summaryRoot();
    const dir = path.join(root, '.lock.embed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: 0x7ffffffe, op: 'embed', at: new Date().toISOString(), host: process.env.HOSTNAME ?? '' }),
    );
    const r = await runRecall(at(root), { query: 'kestrel migration' });
    expect(String(r['capability'])).toMatch(/not running/);
  });

  it('C2 — the no-match note stops implying that a retry will do better', async () => {
    // The compound failure the verifier named: the same reply said "The
    // archive does not contain this — do not widen into a guess" and "semantic
    // search is warming", i.e. *retry later and the other half will have run*.
    const r = await runRecall(at(summaryRoot()), { query: 'zzzqqq flurblewomp aardvark' });
    expect(r['noMatch']).toBe(true);
    expect(String(r['note'])).toMatch(/nothing is embedding this index/);
    expect(String(r['note'])).toMatch(/will not change/);
  });

  it('C2 — `vectors.reason` says never rather than yet, and carries the fact', async () => {
    // The envelope's `vectors` object is what an agent parses when it wants
    // more than the sentence, and `no embeddings in the index yet` is a
    // promise: `yet` is true while somebody is embedding and false on all
    // three indexes where nobody is.
    const root = summaryRoot();
    const stopped = (await runRecall(at(root), { query: 'kestrel migration' }))['vectors'] as {
      reason?: string;
      working?: boolean;
    };
    expect(stopped.working).toBe(false);
    expect(String(stopped.reason)).toMatch(/is not running|nothing is embedding/);
    expect(String(stopped.reason)).not.toMatch(/\byet\b|as vectors land/);

    const release = holdEmbedLane(root);
    try {
      const warming = (await runRecall(at(root), { query: 'kestrel migration' }))['vectors'] as {
        reason?: string;
        working?: boolean;
      };
      expect(warming.working).toBe(true);
      expect(String(warming.reason)).toMatch(/yet|as vectors land/);
    } finally {
      release();
    }
  });

  it('C2 — capabilityLine: three states, three sentences, one count', () => {
    const base = { phase: 'pending' as const, embedded: 0, pending: 4725, total: 4725, runtimeReady: false, acquireBytes: 46_100_000 };
    const v = { used: false, available: false, vectors: 0 };
    expect(capabilityLine(v, { ...base, working: false })).toBe(
      'keyword search only — semantic search is not running (0 of 4,725 embedded)',
    );
    expect(capabilityLine(v, { ...base, working: true })).toBe(
      'keyword search only — semantic search is warming (0 of 4,725 embedded)',
    );
    // A caller with no root cannot know, and must not guess: the old sentence
    // stands rather than a claim in either direction.
    expect(capabilityLine(v, base)).toBe(
      'keyword search only — semantic search is warming (0 of 4,725 embedded)',
    );
  });

  // ------------------------------------------------------------------- C3

  it('C3 — a title-only thread is not citable and carries no citation', async () => {
    const r = await runRecall(at(summaryRoot()), { query: 'kestrel migration' });
    const threads = r['threads'] as Record<string, unknown>[];
    const summary = threads.filter((t) => t['evidence'] === 'not-a-transcript');
    expect(summary).toHaveLength(1);
    expect(summary[0]!['citable']).toBe(false);
    expect(summary[0]!['citation']).toBeNull();
    // And it says why, in a sentence naming a tool the caller actually has.
    expect(String(summary[0]!['citableNote'])).toMatch(/potsherd_read/);
    // The thread with transcript evidence keeps everything it had.
    const evidence = threads.filter((t) => t['evidence'] === 'transcript');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!['citable']).toBe(true);
    expect(typeof evidence[0]!['citation']).toBe('string');
  });

  it('C3 — a summary never outranks a transcript, in threads[] and in hits[]', async () => {
    const r = await runRecall(at(summaryRoot()), { query: 'kestrel migration' });
    const threads = r['threads'] as { evidence: string }[];
    const hits = r['hits'] as { evidence: string }[];
    expect(threads.map((t) => t.evidence)).toEqual(['transcript', 'not-a-transcript']);
    // Every transcript hit comes before every summary hit — the verifier
    // measured `first transcript hit at index 18 of 28` on the real archive.
    const first = hits.findIndex((h) => h.evidence === 'not-a-transcript');
    expect(first).toBeGreaterThan(-1);
    expect(hits.slice(0, first).every((h) => h.evidence === 'transcript')).toBe(true);
    expect(hits.slice(first).every((h) => h.evidence === 'not-a-transcript')).toBe(true);
  });

  it('C3 — a summary-only thread is never labelled strong', async () => {
    // `strong` is a licence to stop reading, and there is nothing here to
    // read. Core caps it at ROUTING_CEILING, which is also what keeps the
    // order above monotone in the confidence word (FIX-D's fence).
    const r = await runRecall(at(summaryRoot()), { query: 'kestrel migration' });
    for (const t of r['threads'] as { evidence: string; confidence: string }[]) {
      if (t.evidence === 'not-a-transcript') expect(t.confidence).not.toBe('strong');
    }
  });

  /**
   * The corpus with a card in it — FIX-F round 2, closing round 1's §4.6.3.
   *
   * Round 1 proved `scope.cards` was accepted, forwarded to
   * `RecallOptions.cards` and reported back on the envelope, and could not
   * prove it changed a result set: the real archive has never had
   * `potsherd card` run on it, so `routing` was 0 with the flag and 0 without
   * it. A flag proved only to be *plumbed* is the audit's own "documented and
   * does nothing" shape, one round later.
   *
   * So: the audit's F6 fixture, in three rows. One session whose transcript
   * says none of the query's words and whose **card** says all of them.
   */
  function cardedRoot(): { root: string; query: string } {
    const { root, db } = open('potsherd-fixf-carded-');
    try {
      session(db, 'ccc55555-5555-4555-8555-555555555555', 'csv import notes',
        'we spent this session on the csv importer and nothing else whatsoever');
      db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
      writeCard(db, root, {
        sessionId: 'ccc55555-5555-4555-8555-555555555555',
        harness: 'claude',
        project: '/tmp/fixf',
        projectSlug: 'fixf',
        card: {
          title: 'zonal drain cutover review',
          summary: 'the session covered the zonal drain cutover in detail.',
          topics: ['zonal drain cutover'],
          decisions: [],
          files: [],
          outcome: 'unknown',
          open_threads: [],
          tags: [],
        },
        verified: { kept: 0, dropped: 0 },
        model: 'seeded-by-hand',
        costUsd: 0,
        createdAt: '2026-08-24T00:00:00.000Z',
        source: 'transcript',
      });
    } finally {
      db.close();
    }
    // Words no transcript in this root contains. Only the card says them.
    return { root, query: 'zonal drain cutover' };
  }

  it('C3 — the cards control changes the result set, not just the envelope', async () => {
    const { root, query } = cardedRoot();

    // Cards on, which is the default: the card finds a conversation whose
    // transcript never uses these words. That is routing working, and it is
    // why cards are demoted rather than switched off.
    const on = await runRecall(at(root), { query });
    expect(on['cards']).toBe(true);
    expect(on['noMatch']).toBe(false);
    expect(on['routing']).toBe(1);
    const onThreads = on['threads'] as Record<string, unknown>[];
    expect(onThreads).toHaveLength(1);
    expect(onThreads[0]!['lane']).toBe('routing');
    // ...and it testifies to nothing: F6 in one field.
    expect(onThreads[0]!['evidence']).toBe('not-a-transcript');
    expect(onThreads[0]!['citable']).toBe(false);
    expect(onThreads[0]!['citation']).toBeNull();
    expect((on['lists'] as { list: string }[]).some((l) => l.list === 'cards_fts')).toBe(true);

    // Cards off: the same query over the same index returns the honest empty.
    // The rows are not filtered out downstream — the two card lists never run.
    const off = await runRecall(at(root), { query, scope: { cards: false } });
    expect(off['cards']).toBe(false);
    expect(off['routing']).toBe(0);
    expect(off['threads']).toHaveLength(0);
    expect(off['noMatch']).toBe(true);
    expect((off['lists'] as { list: string }[]).some((l) => l.list === 'cards_fts')).toBe(false);
  });

  it('C3 — the agent gets the cards control the human has had', async () => {
    const root = summaryRoot();
    const on = await runRecall(at(root), { query: 'kestrel migration' });
    expect(on['cards']).toBe(true);
    const off = await runRecall(at(root), { query: 'kestrel migration', scope: { cards: false } });
    expect(off['cards']).toBe(false);
    // It is on the envelope so a caller can confirm the flag took, exactly as
    // `find --json` reports it.
    expect(off['routing']).toBe(0);
  });

  it('C3 — a summary row ranks last without contradicting the label', () => {
    // FIX-I C-1: the partition and the comparator, spelled the way `recall()`
    // spells them — `summaryRank` first, `byLabel` under it. It used to be
    // `orderByLabel`'s first key at this door only, which is why `find --json`
    // never had it.
    const row = (kind: string, confidence: string, cal: number, tag: string) => ({
      hits: [{ kind: kind as 'exchange' | 'title' }],
      confidence: confidence as 'strong' | 'weak' | 'none',
      calibration: { score: cal, confidence, coverage: 0, strength: 0, agreement: 0 },
      score: 0.0164,
      tag,
    });
    const order = (a: ReturnType<typeof row>, b: ReturnType<typeof row>): number =>
      summaryRank(a.hits) - summaryRank(b.hits) || byLabel(a, b);
    // A summary row with a better calibration than a weak transcript row: the
    // cap stops it being `strong`, and the partition stops it being first.
    const out = [row('title', 'weak', 0.92, 'summary'), row('exchange', 'weak', 0.41, 'transcript')].sort(
      order,
    );
    expect(out.map((r) => r.tag)).toEqual(['transcript', 'summary']);
  });

  it('C3 — and the published threads[] put the summary-only thread last', async () => {
    // The same property, asserted on the reply rather than on a comparator:
    // this is the one that goes red if this door ever stops taking core's
    // order. The `summaryRoot` corpus holds one title-only thread and one
    // transcript thread for the same words.
    const r = await runRecall(at(summaryRoot()), { query: 'kestrel migration', minConfidence: 'none' });
    const threads = (r['threads'] ?? []) as { evidence: string; confidence: string }[];
    expect(threads.length).toBeGreaterThan(1);
    const rank = (t: { evidence: string }) => (t.evidence === 'not-a-transcript' ? 1 : 0);
    for (let i = 1; i < threads.length; i++) {
      expect(rank(threads[i - 1]!)).toBeLessThanOrEqual(rank(threads[i]!));
    }
    expect(rank(threads[threads.length - 1]!)).toBe(1);
  });

  // ------------------------------------------------------------------- C6

  it('C6 — an exchange longer than the budget comes back clipped, not missing', async () => {
    const r = await runRecall(at(oversizedRoot()), { query: 'kestrel', want: 'context' });
    expect(r['noMatch']).toBe(false);
    expect((r['threads'] as unknown[]).length).toBe(1);
    const windows = r['windows'] as { text: string; clipped?: boolean }[];
    expect(windows).toHaveLength(1);
    expect(windows[0]!.clipped).toBe(true);
    expect(windows[0]!.text.length).toBeGreaterThan(0);
    expect(r['windowsClipped']).toBe(1);
    // The clip respects the ceiling it was clipped to fit.
    expect(Number(r['windowTokens'])).toBeLessThanOrEqual(Number(r['windowBudget']));
  });

  it('C6 — readMore survives the empty page, and stays silent on a real no-match', async () => {
    const root = oversizedRoot();
    // Matched, and (before the clip) no text: the one case where "read the
    // thread" is the whole answer, and the one case it used to be withheld in.
    const hit = await runRecall(at(root), { query: 'kestrel', want: 'context' });
    expect(hit['readMore']).not.toBeNull();
    expect(String(hit['readMore'])).toMatch(/potsherd_read/);
    // Nothing matched: there is no thread to read, and naming one would be an
    // instruction the caller cannot carry out.
    const miss = await runRecall(at(root), {
      query: 'zzzqqq flurblewomp aardvark',
      want: 'context',
    });
    expect(miss['noMatch']).toBe(true);
    expect(miss['readMore']).toBeNull();
  });

  // ------------------------------------------------------------------- C7

  it('C7 — one withheld row is one row, and it was withheld', async () => {
    // `though 1 rows were withheld below the weak floor`, live at the model
    // door. The project singularises through `f.plural` everywhere else.
    const { root, db } = open('potsherd-fixf-plural-');
    try {
      session(db, 'ppp44444-4444-4444-8444-444444444444', 'packaging questions',
        'kestrel appears here once and the rest of this line is about nothing else at all');
      db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
    } finally {
      db.close();
    }
    const r = await runRecall(at(root), { query: 'kestrel wombat parasol' });
    if (r['noMatch'] === true && Number(r['belowFloor']) === 1) {
      expect(String(r['note'])).toContain('1 row was withheld');
      expect(String(r['note'])).not.toContain('1 rows were withheld');
    } else {
      // The fixture must produce the case the assertion is about.
      expect({ noMatch: r['noMatch'], belowFloor: r['belowFloor'] }).toEqual({
        noMatch: true,
        belowFloor: 1,
      });
    }
  });
});

/**
 * C-1 step 3 — the model door gets the control the CLI has had since T10.1.
 *
 * ## What was wrong
 *
 * `potsherd_recall`'s description says, in capitals, `TRUST ITS SILENCE`, and
 * its reply reports `belowFloor: 30`. Its input schema was
 * `query, scope, want, budget`. **The agent being instructed to trust the
 * silence could neither check it nor override it**, while the human at the CLI
 * was shown `--min-confidence none` on the same empty screen. That asymmetry is
 * only survivable if the silence is trustworthy, and C-1 measured that it is
 * not: on the product's own 60-query benchmark the floor withholds the correct
 * answer on 50 of them, structurally, because `calibrate()`'s score can never
 * exceed the fraction of the query's literal terms a thread repeats.
 *
 * ## What must not move, and is asserted here in both directions
 *
 * **F1 stays.** The default is `AGENT_FLOOR` and the default reply for an
 * absent topic and for nonsense is still zero rows and `noMatch: true`. The
 * override is opt-in, it comes back labelled `none`, and the note says in words
 * that it is not an answer.
 */
describe('C-1 step 3 — the floor is visible, and it is overridable', () => {
  it('F1 — the default is unchanged: an absent topic is still zero rows', async () => {
    const r = await runRecall(ctx(), { query: 'kubernetes ingress payment service' });
    expect(r['minConfidence']).toBe(AGENT_FLOOR);
    if (r['confidence'] === 'none') {
      expect(r['noMatch']).toBe(true);
      expect(r['threads']).toEqual([]);
      expect(r['hits']).toEqual([]);
    }
    const nonsense = await runRecall(ctx(), { query: 'zzzqqq flurblewomp aardvark protocol' });
    expect(nonsense['threads']).toEqual([]);
    expect(nonsense['hits']).toEqual([]);
  });

  it('minConfidence: "none" hands back the rows the floor withheld, labelled none', async () => {
    // A sentence about a conversation in words it does not use — the shape the
    // floor deletes, and the reason a caller needs to be able to look.
    const q = 'the pooling decision we wrote down in the readme afterwards';
    const floored = await runRecall(ctx(), { query: q });
    const opened = await runRecall(ctx(), { query: q, minConfidence: 'none' });

    expect(floored['noMatch']).toBe(true);
    expect(floored['threads']).toEqual([]);
    expect(Number(floored['belowFloor'])).toBeGreaterThan(0);

    expect(opened['minConfidence']).toBe('none');
    expect((opened['threads'] as unknown[]).length).toBeGreaterThan(0);
    for (const t of opened['threads'] as { confidence: string }[]) {
      expect(t.confidence).toBe('none');
    }
    // And it says what they are, so an agent cannot read them as the answer
    // the same envelope has just said it does not have.
    expect(opened['noMatch']).toBe(true);
    expect(String(opened['note'])).toMatch(/below the confidence floor/);
    expect(String(opened['note'])).toMatch(/not an answer/);
    expect(String(opened['note'])).toMatch(/do not cite them/);
  });

  it('the empty note tells the truth about what silence means, and names the way out', async () => {
    const r = await runRecall(ctx(), {
      query: 'the pooling decision we wrote down in the readme afterwards',
    });
    const note = String(r['note']);
    // The sentence this replaced was "no match. The archive does not contain
    // this" — false on 50 of the 60 queries the floor empties. It must not
    // come back.
    expect(note).not.toMatch(/The archive does not contain this/);
    expect(note).toMatch(/how many of your literal words/);
    expect(note).toMatch(/minConfidence: "none"/);
    expect(note).toMatch(/two to four distinctive nouns/);
    // The half that was always right, kept.
    expect(note).toMatch(/do not answer from the repository in front of you/);
  });

  it('distinguishes the two empties that used to read the same', async () => {
    // Nothing matched at all, versus something matched and none of it well
    // enough. An agent that cannot tell those apart cannot decide whether to
    // ask again, which is the whole of why `belowFloor` was added and then
    // left unusable.
    const nothing = String((await runRecall(ctx(), { query: 'zzzqqq flurblewomp aardvark protocol' }))['note']);
    expect(nothing).toMatch(/nothing in the index matched these words at all/);
    expect(nothing).toMatch(/a real answer/);
    const withheld = String(
      (await runRecall(ctx(), { query: 'the pooling decision we wrote down in the readme afterwards' }))['note'],
    );
    expect(withheld).toMatch(/nothing cleared the confidence floor/);
  });

  it('raising the floor is possible too, and is not a second way of lowering it', async () => {
    const strong = await runRecall(ctx(), { query: 'pgbouncer', minConfidence: 'strong' });
    expect(strong['minConfidence']).toBe('strong');
    for (const t of strong['threads'] as { confidence: string }[]) {
      expect(t.confidence).toBe('strong');
    }
  });
});

/**
 * ROUND 3 — the divider at the model door, on a key of its own.
 *
 * `TRUST ITS SILENCE` survives this change and is the reason for its shape.
 * The silence is the verdict: `noMatch` stays `true`, `confidence` stays
 * `none`, `threads` and `hits` stay empty, and `citations` stays empty so a
 * source line for one of these cannot be minted even by accident. What is
 * added is the evidence that the silence was not laziness — the archive's
 * nearest text, on a key an agent cannot reach by iterating the two arrays it
 * already knows.
 */
describe('ROUND 3 — nearest is not a result', () => {
  const PARAPHRASE = 'the pooling decision we wrote down in the readme afterwards';

  it('keeps the verdict, and puts the rows somewhere they cannot be mistaken for it', async () => {
    const r = await runRecall(ctx(), { query: PARAPHRASE });
    expect(r['noMatch']).toBe(true);
    expect(r['confidence']).toBe('none');
    expect(r['threads']).toEqual([]);
    expect(r['hits']).toEqual([]);
    expect(r['citations'] ?? []).toEqual([]);
    expect(Number(r['belowFloor'])).toBeGreaterThan(0);

    const nearest = r['nearest'] as { thread: string; title: string; confidence: string }[];
    expect(Array.isArray(nearest)).toBe(true);
    expect(nearest.length).toBeGreaterThan(0);
    expect(nearest.length).toBeLessThanOrEqual(NEAREST_THREADS);
    for (const n of nearest) {
      expect(n.confidence).toBe('none');
      expect(typeof n.thread).toBe('string');
      // Nothing quotable. These are the fields an agent quotes FROM, and their
      // absence is what makes the key safe to hand over.
      expect('citation' in n).toBe(false);
      expect('snippet' in n).toBe(false);
      expect('text' in n).toBe(false);
    }
    expect(String(r['nearestNote'])).toMatch(/NOT an answer/);
    expect(String(r['nearestNote'])).toMatch(/must not be quoted/);
  });

  it('dates a nearest row at the same end every other surface does', async () => {
    // **VERIFICATION-7 C7-5 at the model door.** The rows carried `startedAt`
    // and nothing else, so an agent dated a session at the head of its interval
    // while `ls`, `find` and this server's own thread rows date it at the tail.
    // The key is named for the column it has to agree with.
    const r = await runRecall(ctx(), { query: PARAPHRASE });
    const nearest = r['nearest'] as { lastActive?: string | null; startedAt?: string | null }[];
    expect(nearest.length).toBeGreaterThan(0);
    for (const n of nearest) expect('lastActive' in n).toBe(true);
    // And it is the end of the interval, not the head, wherever the two differ.
    const withBoth = nearest.filter((n) => n.startedAt && n.lastActive);
    expect(withBoth.length).toBeGreaterThan(0);
    for (const n of withBoth) {
      expect(String(n.lastActive) >= String(n.startedAt)).toBe(true);
    }
  });

  it('is absent, not empty, when nothing was withheld', async () => {
    // So its absence is never a fact a caller has to interpret. On a text-only
    // index nonsense matches no term at all and there is nothing to be near.
    const r = await runRecall(ctx(), { query: 'zzzqqq flurblewomp aardvark protocol' });
    expect(r['threads']).toEqual([]);
    expect('nearest' in r).toBe(false);
    expect('nearestNote' in r).toBe(false);
  });

  it('does not appear when the caller already asked to see below the floor', async () => {
    // `minConfidence: "none"` returns the rows AS rows; a second copy of them
    // under a "not an answer" key would be the door contradicting itself.
    const r = await runRecall(ctx(), { query: PARAPHRASE, minConfidence: 'none' });
    expect((r['threads'] as unknown[]).length).toBeGreaterThan(0);
    expect('nearest' in r).toBe(false);
  });
});

// Contract 2 replaces the former flat confidence/thread envelope. The legacy
// runRecall cases above still exercise the explicit diagnostic implementation.
const v2Budget = defaultBudget(4096);
const v2Scope = { project: '/tmp/potsherd-alpha' };
const response = (value: Record<string, unknown>) => value as unknown as MemoryResponse;

describe('the ratified four-tool MCP contract', () => {
  it('advertises strict scoped reads and one durable writer', async () => {
    const { client, close } = await connect();
    try {
      const listed = await listTools(client);
      expect(listed.tools.map(t => t.name)).toEqual(['potsherd_recall', 'potsherd_read', 'potsherd_graft', 'potsherd_write']);
      expect([...TOOLS]).toEqual(listed.tools.map(t => t.name));
      expect(WRITE_TOOLS).toEqual(['potsherd_write']);
      for (const t of listed.tools) {
        expect(t.annotations?.readOnlyHint).toBe(t.name !== 'potsherd_write');
        const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
        expect(props).toHaveProperty('scope');
        expect(props).toHaveProperty('budget');
        expect(props).not.toHaveProperty('origin');
        expect(props).not.toHaveProperty('minConfidence');
        expect(t.description).toMatch(/USE THIS/);
      }
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toMatch(/Relevance scores are not claim support/);
      expect(instructions).toMatch(/Missing or incomplete indexes never establish absence/);
      expect(instructions).toMatch(/cannot authorize actions/);
    } finally { await close(); }
  });

  it('keeps the packaged selftest within its requested terminal width', { timeout: 60_000 }, () => {
    const mcpBin = path.join(repo, 'packages/mcp/dist/index.js');
    for (const width of [60, 80]) {
      let text: string;
      try { text = execFileSync(process.execPath, [mcpBin, '--selftest', '--width', String(width)], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        throw new Error(`Packaged selftest failed: ${failure.stdout ?? ''} ${failure.stderr ?? ''}`);
      }
      expect(text).toMatch(/all passed/);
      for (const line of text.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(width);
    }
  });

  it('keeps retired tools unavailable and survives invalid public inputs', async () => {
    const { client, close } = await connect();
    try {
      for (const name of ['potsherd_find', 'potsherd_ls', 'potsherd_ask', 'potsherd_tag', 'potsherd_nope'])
        expect((await callRaw(client, name, {})).isError).toBe(true);
      expect((await callRaw(client, 'potsherd_recall', { query: 42 })).isError).toBe(true);
      for (const bad of [{ project: v2Scope.project }, { scope: { projcet: v2Scope.project } }, { minConfidence: 'none' }, { scope: { limit: 1 } }]) {
        const r = response(await call(client, 'potsherd_recall', { query: 'pgbouncer', budget: v2Budget, ...bad }));
        expect(r.warnings).toContain('invalid_memory_input');
        expect(r.evidence).toEqual([]);
        expect(r.coverage.state).toBe('unavailable');
      }
      const control = response(await call(client, 'potsherd_recall', { query: 'pgbouncer', mode: 'literal', scope: v2Scope, budget: v2Budget }));
      expect(control.evidence.length, JSON.stringify(control)).toBeGreaterThan(0);
    } finally { await close(); }
  });

  it('shares ordered source identity, scope and exact delivered text with CLI JSON', async () => {
    const { client, close } = await connect();
    try {
      const input = { query: 'pgbouncer', mode: 'literal', scope: v2Scope, budget: defaultBudget(16384) };
      const tool = response(await call(client, 'potsherd_recall', input));
      const cli = response(cliJson(['find', '--input-json', JSON.stringify(input)]));
      const identity = (e: EvidenceItem) => ({ ref: e.ref, text: e.text, role: e.role, project: e.project, native: e.provenance!.nativeSessionId });
      expect(tool.evidence.map(identity)).toEqual(cli.evidence.map(identity));
      expect(tool.evidence.length, JSON.stringify(tool)).toBeGreaterThan(0);
      for (const e of tool.evidence) {
        expect(e.project).toBe(v2Scope.project);
        expect(e.text).toContain('pgbouncer');
        expect(e.citation).toBeTruthy();
        expect(e.provenance!.nativeSessionId).toBeTruthy();
      }
      const hit = tool.evidence[0]!;
      const readInput = { refs: [hit.ref], scope: v2Scope, budget: input.budget };
      const read = response(await call(client, 'potsherd_read', readInput));
      const cliRead = response(cliJson(['show', '--input-json', JSON.stringify(readInput)]));
      expect(read.evidence.map(identity)).toEqual(cliRead.evidence.map(identity));
      expect(read.evidence[0]!.text).toContain(hit.text);
      const wrongScope = response(await call(client, 'potsherd_read', { ...readInput, scope: { project: '/tmp/unrelated' } }));
      expect(wrongScope.evidence).toEqual([]);
    } finally { await close(); }
  });

  it('enforces source, branch and event/observation cutoffs without widening scope', async () => {
    const { client, close } = await connect();
    try {
      const input = { query: 'pgbouncer', mode: 'literal', scope: v2Scope, budget: v2Budget };
      const all = response(await call(client, 'potsherd_recall', input));
      expect(all.evidence.length).toBeGreaterThan(0);
      const sourceId = all.evidence[0]!.ref.sourceId;
      const event = '2026-08-01T09:00:05.000Z';
      const bounded = response(await call(client, 'potsherd_recall', { ...input, scope: { ...v2Scope, sourceIds: [sourceId], branch: 'main', asOf: event } }));
      expect(bounded.evidence.length).toBeGreaterThan(0);
      for (const e of bounded.evidence) {
        expect(e.ref.sourceId).toBe(sourceId);
        expect(e.branch).toBe('main');
        expect(Date.parse(e.sourceEventAt!)).toBeLessThanOrEqual(Date.parse(event));
      }
      const beforeObservation = response(await call(client, 'potsherd_recall', { ...input, scope: { ...v2Scope, learnedBy: '2000-01-01T00:00:00.000Z' } }));
      expect(beforeObservation.evidence).toEqual([]);
      const wrongBranch = response(await call(client, 'potsherd_recall', { ...input, scope: { ...v2Scope, branch: 'other-branch' } }));
      expect(wrongBranch.evidence).toEqual([]);
    } finally { await close(); }
  });

  it('delivers retained ghost requests without inventing an observed outcome', async () => {
    const { client, close } = await connect();
    try {
      const input = { query: 'gamma deploy', mode: 'literal', scope: { project: '/tmp/potsherd-gamma' }, budget: v2Budget };
      const ghost = response(await call(client, 'potsherd_recall', input));
      expect(ghost.evidence.length, JSON.stringify(ghost)).toBeGreaterThan(0);
      expect(ghost.support.state).not.toBe('sufficient');
      expect(ghost.coverage.unavailableKinds).toContain('original_transcript');
      for (const e of ghost.evidence) {
        expect(e.role).toBe('ghost_prompt');
        expect(e.text).toBe('gamma deploy is failing on the health check');
        expect(e.toolOutcome).not.toBe('success');
        const read = response(await call(client, 'potsherd_read', { refs: [e.ref], scope: input.scope, budget: v2Budget }));
        expect(read.evidence[0]!.text).toBe(e.text);
        expect(read.evidence[0]!.role).toBe('ghost_prompt');
      }
    } finally { await close(); }
  });

  it('pages an inclusive legacy range without overlap and preserves exact role-separated quotations', async () => {
    const { client, close } = await connect();
    try {
      const input = { legacyRef: { sessionId: '11111111-1111-4111-8111-111111111111', fromSeq: 1, toSeq: 2 }, scope: v2Scope, budget: v2Budget };
      let page = response(await call(client, 'potsherd_read', input));
      const all: EvidenceItem[] = [];
      const cursors = new Set<string>();
      for (let n = 0; n < 30; n++) {
        all.push(...page.evidence);
        if (!page.continuation) break;
        expect(cursors.has(page.continuation)).toBe(false);
        cursors.add(page.continuation);
        page = response(await call(client, 'potsherd_read', { ...input, cursor: page.continuation }));
      }
      expect(page.continuation).toBeUndefined();
      expect(all.length, JSON.stringify(page)).toBeGreaterThan(1);
      expect(new Set(all.map(e => e.ref.spanId)).size).toBe(all.length);
      for (const e of all) {
        expect(e.provenance!.locator).toBeTruthy();
        expect(e.project).toBe(v2Scope.project);
        expect(e.provenance!.nativeSessionId).toMatch(/^11111111/);
        expect(e.sourceEventAt).toBeTruthy();
        const expanded = response(await call(client, 'potsherd_read', { refs: [e.ref], scope: v2Scope, budget: v2Budget }));
        expect(expanded.evidence[0]!.text).toBe(e.text);
        expect(expanded.evidence[0]!.role).toBe(e.role);
      }
      const invalid = response(await call(client, 'potsherd_read', { ...input, legacyRef: { sessionId: '11111111-1111-4111-8111-111111111111', fromSeq: 9, toSeq: 2 } }));
      expect(invalid.warnings).toContain('invalid_memory_input');
      const missing = response(await call(client, 'potsherd_read', { ...input, legacyRef: { sessionId: 'ffffffff' } }));
      expect(missing.evidence).toEqual([]);
      expect(missing.coverage.state).not.toBe('complete_snapshot');
    } finally { await close(); }
  });

  it('measures the complete actual transport payload and labels an empty conservatively', async () => {
    const { client, close } = await connect();
    try {
      for (const query of ['pgbouncer', 'quuxzzzz-no-record']) {
        const raw = await callRaw(client, 'potsherd_recall', { query, mode: 'literal', scope: v2Scope, budget: v2Budget });
        expect(raw.content).toHaveLength(1);
        expect(raw.structuredContent).toBeUndefined();
        const r = response(JSON.parse(textOf(raw)) as Record<string, unknown>);
        expect(r.budget.usedTokens).toBe(countTransportTokens(JSON.stringify({ content: raw.content })));
        expect(r.budget.usedTokens).toBeLessThanOrEqual(v2Budget.maxTokens);
        expect(Buffer.byteLength(JSON.stringify({ content: raw.content }))).toBeLessThanOrEqual(v2Budget.maxBytes!);
        if (query.startsWith('quux')) {
          expect(r.evidence).toEqual([]);
          expect(r.support.state).not.toBe('sufficient');
          expect(JSON.stringify(r)).not.toMatch(/nothing in the index answers|TRUST ITS SILENCE/);
        }
      }
    } finally { await close(); }
  });

  it('grafts source evidence without project writes and exposes explicit durable assertion writes', async () => {
    const { client, close } = await connect();
    try {
      const before = fs.readdirSync(project);
      const graft = response(await call(client, 'potsherd_graft', { query: 'pgbouncer', scope: v2Scope, budget: v2Budget }));
      expect(graft.evidence.length, JSON.stringify(graft)).toBeGreaterThan(0);
      expect(fs.readdirSync(project)).toEqual(before);
      expect(graft).not.toHaveProperty('brief');
      const input = { requestKey: 'mcp-contract-retry', scope: v2Scope, authorClaim: 'user', entries: [{ kind: 'decision', text: 'Synthetic contractmarker decision pending review' }] };
      const forged = response(await call(client, 'potsherd_write', { ...input, origin: 'api' }));
      expect(forged.warnings).toContain('invalid_memory_input');
      const first = await call(client, 'potsherd_write', input);
      const retry = await call(client, 'potsherd_write', input);
      expect(retry['noteIds']).toEqual(first['noteIds']);
      expect(first['authority']).toBe('agent_assertion');
      const note = response(await call(client, 'potsherd_read', { noteIds: first['noteIds'], scope: v2Scope, budget: v2Budget }));
      expect(note.evidence).toEqual([]);
      expect(note.assertions).toHaveLength(1);
      expect(note.assertions[0]).toMatchObject({ text: input.entries[0]!.text, current: true, origin: 'mcp', authority: 'agent_assertion' });
      const emptyRoot = path.join(scratch, 'unavailable-v2');
      const isolated = await connectInMemory(makeContext({ potsherdDir: emptyRoot, env: {}, cwd: project }), 'unavailable');
      try {
        const unavailable = response(await call(isolated.client, 'potsherd_recall', { query: 'anything', scope: {}, budget: v2Budget }));
        expect(unavailable.coverage.state).toBe('unavailable');
        expect(unavailable.support.state).toBe('insufficient');
        expect(fs.existsSync(path.join(emptyRoot, 'potsherd.db'))).toBe(false);
      } finally { await isolated.close(); }
    } finally { await close(); }
  });
});
