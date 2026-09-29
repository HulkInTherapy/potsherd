import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexAll, rescue, stripAnsi, defaultBudget, type MemoryResponse } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * `find`, `ls`, `show` and `stats` through the shipped binary.
 *
 * Two things only the binary can be held to, and both are acceptance criteria
 * rather than niceties:
 *
 *   **width.** Every line of every verb must fit 80 columns and stay legible at
 *   60. The design system uses multi-byte glyphs (`·` `→` `…` `★`), so this is
 *   counted in *characters* — a byte count would pass a line that wraps.
 *
 *   **`--json` carries the same data as the human view.** Not similar data: the
 *   same. A plugin, the MCP server and a shell pipeline all read the JSON, and
 *   a field that only exists in the rendering is a field they cannot have.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');
const FIXTURE = path.join(repo, 'evals', 'fixture', 'claude');

let root: string;
const dirs: string[] = [];

interface RunResult { code: number; stdout: string; stderr: string }

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [bin, ...args, '--potsherd-dir', root], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** The widest line, counted in characters after ANSI is stripped. */
function widest(text: string): { width: number; line: string } {
  let width = 0;
  let line = '';
  for (const raw of text.split('\n')) {
    const n = [...stripAnsi(raw)].length;
    if (n > width) {
      width = n;
      line = raw;
    }
  }
  return { width, line };
}

beforeAll(async () => {
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
  root = tempDir('potsherd-query-cli-');
  dirs.push(root);
  await rescue({ claudeDir: FIXTURE, root, ghostsOnly: true, quiet: true });
  await indexAll({ root, claudeDir: FIXTURE, harnesses: ['claude'], embed: false, full: true });
}, 120_000);

afterAll(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

const VERBS: [string, string[]][] = [
  ['ls', ['ls']],
  ['ls --ghosts only', ['ls', '--ghosts', 'only']],
  ['ls --sidechains only', ['ls', '--sidechains', 'only']],
  ['find', ['find', 'pgbouncer transaction pooling']],
  // A query whose best evidence is on the assistant side of a session whose
  // prompts are pasted-screenshot placeholders.
  ['find over boilerplate', ['find', 'pay button spinner']],
  ['find --ghosts only', ['find', 'brother laser printer', '--ghosts', 'only']],
  ['stats', ['stats']],
  ['show', ['show', '0a2fbf9b']],
  ['show a ghost', ['show', 'e6aa5ba7']],
];

describe('width: every verb fits the terminal it was designed for', () => {
  for (const [name, args] of VERBS) {
    it(`${name} fits 80 columns`, () => {
      const r = run([...args, '--width', '80']);
      expect(r.code === 0 || r.code === 1).toBe(true);
      const { width, line } = widest(r.stdout);
      expect(width, `widest line (${width}): ${line}`).toBeLessThanOrEqual(80);
    });

    it(`${name} fits 60 columns`, () => {
      const r = run([...args, '--width', '60']);
      const { width, line } = widest(r.stdout);
      expect(width, `widest line (${width}): ${line}`).toBeLessThanOrEqual(60);
    });
  }
});

describe('ls', () => {
  it('shows titles rather than uuids', () => {
    const r = run(['ls', '--width', '80', '--project', '/tmp/potsherd-eval-api']);
    expect(r.stdout).toContain('Pin the pgbouncer');
    expect(r.stdout).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  it('fits an 80x24 screenshot by default', () => {
    const r = run(['ls', '--width', '80']);
    expect(r.stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(24);
  });

  it('marks the deleted sessions and says what is left of them', () => {
    const r = run(['ls', '--ghosts', 'only', '--width', '80']);
    expect(r.stdout).toContain('ghost');
    expect(r.stdout).toContain('prompts only');
  });

  it('--json carries every column the table shows, and the id it does not', () => {
    const j = JSON.parse(run(['ls', '--json']).stdout) as {
      total: number;
      ghosts: number;
      rolledUp: number;
      sessions: Record<string, unknown>[];
    };
    expect(j.ghosts).toBe(12);
    expect(j.rolledUp).toBe(6);
    const first = j.sessions[0]!;
    for (const key of ['id', 'harness', 'project', 'displayTitle', 'status', 'isSidechain', 'resume']) {
      expect(Object.keys(first)).toContain(key);
    }
  });

  it('rejects a filter value it does not have, and names the ones it does', () => {
    const r = run(['ls', '--ghosts', 'maybe']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/include|only|exclude/);
  });
});

const memory = (args: string[]): MemoryResponse => JSON.parse(run([...args, '--json']).stdout) as MemoryResponse;
const projectScope = { project: '/tmp/potsherd-eval-api' };

describe('find: bounded source evidence', () => {
  it('preserves native source identity, exact matching text, roles and citations', () => {
    const j = memory(['find', 'pgbouncer', '--exact']);
    expect(j.contractVersion).toBe(2);
    expect(j.evidence.length, JSON.stringify(j)).toBeGreaterThan(0);
    for (const e of j.evidence) {
      expect(e.text).toContain('pgbouncer');
      expect(e.provenance!.nativeSessionId).toBeTruthy();
      expect(e.citation).toBeTruthy();
      expect(['user', 'assistant', 'tool_input', 'tool_result', 'ghost_prompt']).toContain(e.role);
      expect(e.quoteBasis).toBe('redacted_unit');
    }
    const human = run(['find', 'pgbouncer', '--exact', '--width', '80']).stdout;
    expect(human).toContain('pgbouncer');
    expect(human).toContain('semantic:');
    expect(human).toContain('support:');
    expect(j.coverage.semantic).toBe('disabled');
  });

  it('reports lexical degradation and honors explicit vector-off flags', () => {
    const hybrid = memory(['find', 'pgbouncer']);
    expect(hybrid.evidence.length).toBeGreaterThan(0);
    expect(hybrid.coverage.semantic).toBe('missing_assets');
    for (const flags of [['--no-vec'], ['--vectors', 'off']]) {
      const lexical = memory(['find', 'pgbouncer', ...flags]);
      expect(lexical.evidence.length).toBeGreaterThan(0);
      expect(lexical.coverage.semantic).toBe('disabled');
    }
  });

  it('honors project, source, branch and event-time boundaries in complete public JSON inputs', () => {
    const input = { query: 'pgbouncer', mode: 'literal', scope: projectScope, budget: defaultBudget() };
    const all = memory(['find', '--input-json', JSON.stringify(input)]);
    expect(all.evidence.length).toBeGreaterThan(0);
    expect(all.evidence.every(e => e.project === projectScope.project)).toBe(true);
    const sourceId = all.evidence[0]!.ref.sourceId;
    const scoped = memory(['find', '--input-json', JSON.stringify({ ...input, scope: { ...projectScope, sourceIds: [sourceId], branch: 'main', asOf: '2026-06-02T10:00:00.000Z' } })]);
    expect(scoped.evidence.length).toBeGreaterThan(0);
    for (const e of scoped.evidence) {
      expect(e.ref.sourceId).toBe(sourceId);
      expect(e.branch).toBe('main');
      expect(Date.parse(e.sourceEventAt!)).toBeLessThanOrEqual(Date.parse('2026-06-02T10:00:00.000Z'));
    }
    const wrong = memory(['find', '--input-json', JSON.stringify({ ...input, scope: { project: '/tmp/not-enrolled' } })]);
    expect(wrong.evidence).toEqual([]);
  });

  it('finds subagent-owned evidence by default and excludes it when explicitly requested', () => {
    const all = memory(['find', 'tree shaking icon set']);
    expect(all.evidence.length).toBeGreaterThan(0);
    expect(all.evidence.some(e => e.provenance!.parentNativeSessionId !== null)).toBe(true);
    const excluded = memory(['find', 'tree shaking icon set', '--sidechains', 'exclude']);
    expect(excluded.evidence.every(e => e.provenance!.parentNativeSessionId === null)).toBe(true);
  });

  it('delivers ghost prompts without certifying assistant answers or tool outcomes', () => {
    const j = memory(['find', 'brother laser printer', '--ghosts', 'only']);
    expect(j.evidence.length, JSON.stringify(j)).toBeGreaterThan(0);
    expect(j.coverage.unavailableKinds).toContain('original_transcript');
    for (const e of j.evidence) {
      expect(e.role).toBe('ghost_prompt');
      expect(e.text).toContain('printer');
      expect(e.toolOutcome).not.toBe('success');
    }
    expect(j.support.state).not.toBe('sufficient');
    const human = run(['find', 'brother laser printer', '--ghosts', 'only']).stdout;
    expect(human).toMatch(/Original transcript unavailable/);
    expect(human).not.toContain('claude --resume');
  });

  it('returns a scoped empty with exit 1 and no fabricated answer', () => {
    const q = 'zzzznothinghere';
    const human = run(['find', q]);
    const json = run(['find', q, '--json']);
    expect(human.code).toBe(1);
    expect(json.code).toBe(1);
    const j = JSON.parse(json.stdout) as MemoryResponse;
    expect(j.evidence).toEqual([]);
    expect(j.assertions).toEqual([]);
    expect(j.support.state).not.toBe('sufficient');
    expect(human.stdout).not.toMatch(/nothing in the index answers|TRUST ITS SILENCE/);
    expect(human.stdout).toContain('Memory:');
  });

  it('rejects obsolete flat inputs and explicitly unsupported default flags', () => {
    for (const flags of [['--no-cards'], ['--min-confidence', 'none'], ['--limit', '20']]) {
      const r = run(['find', 'pgbouncer', ...flags]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/not supported by v2/);
    }
    for (const scope of [{ projcet: projectScope.project }, { project: projectScope.project, repository: '/tmp/other' }]) {
      const r = memory(['find', '--input-json', JSON.stringify({ query: 'pgbouncer', scope, budget: defaultBudget() })]);
      expect(r.warnings).toContain('invalid_memory_input');
      expect(r.evidence).toEqual([]);
    }
    const diagnostic = JSON.parse(run(['find', 'pgbouncer', '--explain', '--no-cards', '--min-confidence', 'none', '--limit', '20', '--json']).stdout);
    expect(diagnostic.cards).toBe(false);
    expect(diagnostic.sessions.length).toBeGreaterThan(0);
    expect(diagnostic.sessions.length).toBeLessThanOrEqual(20);
  });

  it('makes exact source expansion available through immutable refs', () => {
    const j = memory(['find', 'spinner', '--exact']);
    expect(j.evidence.length).toBeGreaterThan(0);
    const hit = j.evidence[0]!;
    const read = memory(['show', '--input-json', JSON.stringify({ refs: [hit.ref], scope: { sourceIds: [hit.ref.sourceId] }, budget: defaultBudget() })]);
    expect(read.evidence[0]!.ref).toEqual(hit.ref);
    expect(read.evidence[0]!.text).toContain(hit.text);
    expect(read.evidence[0]!.role).toBe(hit.role);
    expect(read.evidence[0]!.provenance!.nativeSessionId).toBe(hit.provenance!.nativeSessionId);
  });

  it('keeps default human source text inside width and ASCII limits', () => {
    for (const width of ['80', '60']) {
      const r = run(['find', 'idempotency key on a replayed request', '--width', width, '--ascii']);
      expect(r.code).toBe(0);
      expect(stripAnsi(r.stdout)).toMatch(/^[\x00-\x7f]*$/);
      expect(widest(r.stdout).width).toBeLessThanOrEqual(Number(width));
      expect(r.stdout.toLowerCase()).toContain('idempotency');
    }
  });

  it('does not cite card/title-only routing as transcript evidence', () => {
    const j = memory(['find', 'timezone drift', '--exact']);
    expect(j.evidence.every(e => e.text.includes('timezone drift'))).toBe(true);
    expect(j.evidence.some(e => ['title', 'card'].includes(e.role))).toBe(false);
    expect(j.support.state).not.toBe('sufficient');
    // The retained diagnostic makes the metadata-only route inspectable.
    expect(run(['find', 'timezone drift', '--explain']).stdout).toContain('titles');
  });
});

describe('show', () => {
  it('reads one session by an 8-character prefix', () => {
    const r = run(['show', '0a2fbf9b', '--width', '80']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pgbouncer');
    expect(r.stdout).toContain('span:');
    const j = memory(['show', '0a2fbf9b']);
    expect(j.evidence[0]!.provenance!.nativeSessionId).toMatch(/^0a2fbf9b/);
    expect(r.stdout).toContain('user');
  });

  it('windows with --from and --to', () => {
    const j = memory(['show', '0a2fbf9b', '--from', '2', '--to', '2']);
    expect(j.evidence.length, JSON.stringify(j)).toBeGreaterThan(0);
    expect(j.evidence.every(e => e.provenance!.nativeSessionId.startsWith('0a2fbf9b'))).toBe(true);
    const exact = memory(['show', '--input-json', JSON.stringify({ legacyRef: { sessionId: j.evidence[0]!.provenance!.nativeSessionId, seq: 2 }, scope: {}, budget: defaultBudget() })]);
    expect(exact.evidence.map(e => ({ ref: e.ref, text: e.text, role: e.role }))).toEqual(j.evidence.map(e => ({ ref: e.ref, text: e.text, role: e.role })));
    expect(j.evidence[0]!.text).not.toContain('the connection pool falls over under load');
  });

  it('rejects JSON read inputs combined with silently conflicting legacy range flags', () => {
    const first = memory(['show', '0a2fbf9b']);
    const native = first.evidence[0]!.provenance!.nativeSessionId;
    const scope = { project: first.evidence[0]!.project! };
    for (const [target, flags] of [
      [{ legacyRef: { sessionId: native, seq: 1 } }, ['--from', '2']],
      [{ legacyRef: { sessionId: native, seq: 2 } }, ['--to', '1']],
      [{ refs: [first.evidence[0]!.ref] }, ['--from', '2']],
    ] as const) {
      const result = run(['show', '--input-json', JSON.stringify({ ...target, scope, budget: defaultBudget() }), ...flags]);
      expect(result.code, result.stdout).toBe(1);
      const rejected = JSON.parse(result.stdout) as MemoryResponse;
      expect(rejected.warnings).toContain('invalid_memory_input');
      expect(rejected.evidence).toEqual([]);
      expect(rejected.coverage.state).toBe('unavailable');
    }
    const control = memory(['show', '--input-json', JSON.stringify({ legacyRef: { sessionId: native, fromSeq: 2, toSeq: 2 }, scope, budget: defaultBudget() })]);
    expect(control.evidence.length).toBeGreaterThan(0);
    expect(control.evidence[0]!.provenance!.nativeSessionId).toBe(native);
  });

  it('renders a ghost as prompts, and says the rest is gone', () => {
    const r = run(['show', 'e6aa5ba7', '--width', '80']);
    expect(r.stdout).toMatch(/Original transcript unavailable/);
    expect(r.stdout).toContain('brother laser printer');
    expect(r.stdout).not.toContain('claude --resume');
  });

  it('--md is markdown with the session id in it', () => {
    const r = run(['show', '0a2fbf9b', '--md']);
    expect(r.stdout).toMatch(/^# Pin the pgbouncer/m);
    expect(r.stdout).toMatch(/- session: `[0-9a-f-]{36}`/);
  });

  it('names the candidates rather than guessing on an ambiguous prefix', () => {
    const r = run(['show', 'a', '--width', '80']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('matches');
    // The whole id, because the point is that the prefixes collided.
    expect(r.stderr).toMatch(/complete native session id/);
    expect(r.stderr).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  it('says so plainly when the id is not there', () => {
    const r = run(['show', 'zzzzzzzz']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('potsherd ls');
  });
});

describe('stats', () => {
  it('counts each harness, and the ghosts beside them', () => {
    const r = run(['stats', '--width', '80']);
    expect(r.stdout).toContain('claude');
    expect(r.stdout).toContain('ghosts');
    expect(r.stdout).toContain('prompts recovered');
  });

  it('--json carries the per-harness rows and the freshness check', () => {
    const j = JSON.parse(run(['stats', '--json']).stdout) as {
      harnesses: { harness: string; sessions: number; sidechains: number; ghosts: number }[];
      totals: { exchanges: number };
      freshness: { stale: number; missing: number; vecAvailable: boolean };
      redaction: unknown;
    };
    const claude = j.harnesses.find((h) => h.harness === 'claude')!;
    expect(claude.sessions).toBe(46);
    expect(claude.sidechains).toBe(6);
    expect(claude.ghosts).toBe(12);
    expect(j.freshness.stale).toBe(0);
    expect(j.freshness.missing).toBe(0);
    expect(j.redaction).toBeTruthy();
  });
});

describe('the index has to exist first', () => {
  it('says which command builds it', () => {
    const empty = tempDir('potsherd-query-empty-');
    dirs.push(empty);
    try {
      execFileSync('node', [bin, 'find', 'anything', '--potsherd-dir', empty], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('should have failed');
    } catch (err) {
      const e = err as { stderr?: string };
      expect(e.stderr ?? '').toContain('potsherd index');
    }
  });
});
