import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  copilotAdapter,
  discover,
  doctorLine,
  isoOf,
  parse,
  scan,
  sessionIdFromPath,
  sourceDir,
  stateFileIn,
} from '../../packages/core/src/adapters/copilot.js';
import { isAdapter } from '@potsherd/core';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Synthetic and committed (`plans/00-README.md`). There were no real Copilot
 * CLI sessions on the reference machine to derive these from — `~/.copilot`
 * exists and the CLI has run, but it wrote no `session-state/` at all.
 */
const FIXTURE_COPILOT = path.join(here, '..', 'fixtures', 'copilot');

function source(id: string) {
  const found = discover(FIXTURE_COPILOT).find((s) => s.sessionId === id);
  if (!found) throw new Error(`fixture session ${id} not discovered`);
  return found;
}

describe('copilot adapter — discovery', () => {
  it('finds all three layouts: a session directory, a flat json, a flat jsonl', () => {
    const found = discover(FIXTURE_COPILOT);
    expect(found.map((s) => s.sessionId).sort()).toEqual([
      'fixture-cp-dir-0001',
      'fixture-cp-flat-0002',
      'fixture-cp-jsonl-0003',
    ]);
    for (const s of found) {
      expect(s.harness).toBe('copilot');
      expect(s.isSidechain).toBe(false);
      expect(s.status).toBe('live');
      expect(path.isAbsolute(s.path)).toBe(true);
      expect(s.bytes).toBeGreaterThan(0);
    }
  });

  it('reports a session directory it cannot open rather than skipping it silently', () => {
    const { unreadable } = scan(FIXTURE_COPILOT);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain('fixture-cp-empty-0004');
  });

  it('finds the state file inside a session directory', () => {
    const dir = path.join(FIXTURE_COPILOT, 'session-state', 'fixture-cp-dir-0001');
    expect(stateFileIn(dir)).toBe(path.join(dir, 'state.json'));
    expect(stateFileIn(path.join(FIXTURE_COPILOT, 'session-state', 'fixture-cp-empty-0004'))).toBeUndefined();
  });

  it('derives the session id from the directory or the filename', () => {
    expect(sessionIdFromPath('/x/fixture-cp-dir-0001/state.json')).toBe('fixture-cp-dir-0001');
    expect(sessionIdFromPath('/x/fixture-cp-flat-0002.json')).toBe('fixture-cp-flat-0002');
    expect(sessionIdFromPath('/x/fixture-cp-jsonl-0003.jsonl')).toBe('fixture-cp-jsonl-0003');
  });

  it('returns nothing rather than throwing when copilot is not installed', () => {
    const missing = path.join(os.tmpdir(), 'potsherd-copilot-does-not-exist');
    expect(fs.existsSync(missing)).toBe(false);
    expect(discover(missing)).toEqual([]);
  });

  it('names session-state/ as its source directory', () => {
    expect(sourceDir(FIXTURE_COPILOT)).toBe(path.join(FIXTURE_COPILOT, 'session-state'));
  });
});

describe('copilot adapter — the directory layout', () => {
  it('reads metadata off the wrapper and never invents it', async () => {
    const { session } = await parse(source('fixture-cp-dir-0001'));
    expect(session.id).toBe('fixture-cp-dir-0001');
    expect(session.project).toBe('/tmp/potsherd-fx/epsilon');
    expect(session.projectSlug).toBe('epsilon');
    expect(session.model).toBe('fixture-model-c');
    expect(session.gitBranch).toBe('fixture-branch');
    expect(session.title).toBe('fixture directory-layout session');
    expect(session.startedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(session.endedAt).toBe('2026-01-02T03:34:05.000Z');
  });

  it('does not count a tool-result user turn as a human prompt', async () => {
    const { session, exchanges } = await parse(source('fixture-cp-dir-0001'));
    // Two real prompts. The `user` turn carrying only a tool_result is the
    // harness feeding output back, not a human.
    expect(session.counts.userPrompts).toBe(2);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.userText).toBe('fixture prompt one');
    expect(exchanges[1]!.userText).toBe('fixture prompt two');
  });

  it('pairs tool calls with their results by id, including the OpenAI-style shape', async () => {
    const { exchanges } = await parse(source('fixture-cp-dir-0001'));
    const editor = exchanges[0]!.toolCalls.find((c) => c.name === 'str_replace_editor')!;
    expect(editor.result).toContain('fixture tool output');
    expect(editor.isError).toBeUndefined();
    // `tool_calls` beside the content, with arguments as a JSON *string*.
    const bash = exchanges[1]!.toolCalls.find((c) => c.name === 'bash')!;
    expect(bash.isError).toBe(true);
    expect(bash.input).toContain('fixture-command');
  });

  it('parses a JSON-string arguments blob so filesTouched still works', async () => {
    const { exchanges } = await parse(source('fixture-cp-dir-0001'));
    expect(exchanges[0]!.filesTouched).toContain('/tmp/potsherd-fx/epsilon/src/mod.ts');
  });

  it('counts unknown block types and unknown roles, and is not fatal', async () => {
    const { unknownTypes, exchanges } = await parse(source('fixture-cp-dir-0001'));
    expect(unknownTypes['block:fixture_unknown_block']).toBe(1);
    expect(unknownTypes['role:fixture-unknown-role']).toBe(1);
    expect(exchanges.length).toBeGreaterThan(0);
  });
});

describe('copilot adapter — the flat layouts', () => {
  it('reads a bare array of turns with no wrapper at all', async () => {
    const { session, exchanges } = await parse(source('fixture-cp-flat-0002'));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.userText).toBe('fixture flat prompt');
    expect(exchanges[0]!.assistantText).toBe('fixture flat reply.');
    // No metadata in the document: nothing is invented.
    expect(session.title).toBeUndefined();
    expect(session.model).toBeUndefined();
    expect(session.project).toBe('');
  });

  it('reads jsonl, taking a role-less header record as metadata', async () => {
    const { session, exchanges } = await parse(source('fixture-cp-jsonl-0003'));
    expect(session.id).toBe('fixture-cp-jsonl-0003');
    expect(session.project).toBe('/tmp/potsherd-fx/zeta');
    expect(session.model).toBe('fixture-model-d');
    expect(session.startedAt).toBe('2026-01-03T01:00:00.000Z');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.assistantText).toContain('fixture jsonl reply.');
  });

  it('counts a malformed jsonl line without losing the lines around it', async () => {
    const { malformedLines, exchanges } = await parse(source('fixture-cp-jsonl-0003'));
    expect(malformedLines).toBe(1);
    // The orphan tool_result after the bad line still landed.
    const orphan = exchanges[0]!.toolCalls.find((c) => c.name === 'orphan_tool')!;
    expect(orphan.result).toContain('fixture orphan output');
    expect(orphan.input).toBe('');
  });
});

describe('copilot adapter — time helper', () => {
  it('accepts iso, epoch-ms and epoch-second values and rejects nonsense', () => {
    expect(isoOf('2026-01-02T03:04:05.000Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(isoOf(1767322445000)).toBe(new Date(1767322445000).toISOString());
    expect(isoOf(1767322445)).toBe(new Date(1767322445000).toISOString());
    expect(isoOf('not a date')).toBeUndefined();
    expect(isoOf(undefined)).toBeUndefined();
  });
});

describe('copilot adapter — doctor', () => {
  it('says "absent" when the harness is not installed at all', () => {
    const missing = path.join(os.tmpdir(), 'potsherd-copilot-does-not-exist');
    const line = doctorLine(missing);
    expect(line).toContain('absent');
    expect(line).toContain('Copilot CLI not installed');
  });

  it('distinguishes installed-with-no-session-state from not installed', () => {
    // This is the reference machine's actual state, and the reason the
    // distinction is worth a branch: the CLI is there and has run, and it has
    // written no session-state/ whatever.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-cp-empty-'));
    const line = doctorLine(dir);
    expect(line).toContain('empty');
    expect(line).toContain('written no session-state/');
    expect(line).not.toContain('not installed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says session-state/ is present but holds nothing, when that is the case', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-cp-empty2-'));
    fs.mkdirSync(path.join(dir, 'session-state'), { recursive: true });
    const line = doctorLine(dir);
    expect(line).toContain('empty');
    expect(line).toContain('holds no sessions');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says "ready" with a count, and names sessions it could not open', () => {
    const line = doctorLine(FIXTURE_COPILOT);
    expect(line).toContain('ready');
    expect(line).toContain('3 sessions');
    expect(line).toContain('1 unreadable');
    expect(line).toContain('unverified format');
  });
});

describe('copilot adapter — the contract', () => {
  it('satisfies the Adapter interface', () => {
    expect(isAdapter(copilotAdapter)).toBe(true);
    expect(copilotAdapter.harness).toBe('copilot');
  });

  it('keeps exchange ids stable across re-parses', async () => {
    const a = await parse(source('fixture-cp-dir-0001'));
    const b = await parse(source('fixture-cp-dir-0001'));
    expect(a.exchanges.map((x) => x.id)).toEqual(b.exchanges.map((x) => x.id));
    expect(a.exchanges.map((x) => x.seq)).toEqual([1, 2]);
  });

  it('writes nothing under the fixture directory', () => {
    const state = path.join(FIXTURE_COPILOT, 'session-state');
    const before = fs.readdirSync(state).sort();
    discover(FIXTURE_COPILOT);
    doctorLine(FIXTURE_COPILOT);
    expect(fs.readdirSync(state).sort()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// MEASURED AGAINST A REAL GitHub Copilot CLI 1.0.80 (T10.12, 2026-08-24)
//
// `08 §3` item 7 recorded an anomaly: the Copilot CLI had run on the reference
// machine and had still written no `session-state/`. Both halves are now
// explained, by installing `@github/copilot@1.0.80` from npm (33s, alongside
// gemini and opencode) and running it under a relocated HOME.
//
//   WHY THE REFERENCE MACHINE HAS NONE. `~/.copilot/logs/process-*.log` shows
//   every run there was `Starting CLI in server mode (stdio)` … `Destroying 0
//   active sessions` — the IDE's JSON-RPC engine, never an interactive or
//   `-p` CLI session. Copilot writes `session-state/` per *CLI session*, and
//   there had never been one. The adapter's PATH IS RIGHT; the machine had no
//   sessions to put in it. One `copilot -p …` created the directory on the
//   first try.
//
//   WHAT IS ACTUALLY IN IT — and this is the finding. `session-state/<uuid>/`
//   at 1.0.80 holds `workspace.yaml`, `checkpoints/index.md`,
//   `rewind-file-snapshots/tracking.json`, and empty `files/` and `research/`.
//   It holds NONE of the six names {@link STATE_FILES} looks for, and no JSON
//   document of turns at all. The transcript lives one level up, in
//   `~/.copilot/session-store.db` — a sqlite database with
//   `sessions(id, cwd, repository, host_type, branch, summary, created_at,
//   updated_at)` and `turns(session_id, turn_index, user_message,
//   assistant_response, timestamp)`, plus `checkpoints`, `session_files` and
//   an FTS `search_index`. The adapter never opens it.
//
// So `potsherd index` over a real, non-empty Copilot install reports
// `copilot 0 · no transcripts in ~/.copilot/session-state`. NOT FIXED HERE:
// reading it means a second sqlite adapter, which is a feature, not a
// correction (`T10.12-LABELS.md` carries the recommendation). These assertions
// pin the measured layout so the next person starts from a fact.
describe('copilot adapter — a real Copilot CLI 1.0.80 session directory (T10.12)', () => {
  function realShape(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-1080-'));
    // 2 distinct hex digits in the first eight — the guard's entropy test.
    const id = 'bbbbbbbb-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
    const dir = path.join(root, 'session-state', id);
    fs.mkdirSync(path.join(dir, 'checkpoints'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'rewind-file-snapshots'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'research'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'workspace.yaml'),
      [
        `id: ${id}`,
        'cwd: /w/scratch',
        'client_name: github/cli',
        'user_named: false',
        'summary_count: 0',
        'created_at: 2026-08-24T00:00:00.000Z',
        'updated_at: 2026-08-24T00:00:00.000Z',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'checkpoints', 'index.md'),
      '# Checkpoint History\n\n| # | Title | File |\n|---|-------|------|\n',
    );
    fs.writeFileSync(path.join(dir, 'rewind-file-snapshots', 'tracking.json'), '{}\n');
    return root;
  }

  it('FINDING — the session directory exists and holds none of the names STATE_FILES looks for', () => {
    const root = realShape();
    const dir = fs.readdirSync(path.join(root, 'session-state'))[0]!;
    const inside = fs.readdirSync(path.join(root, 'session-state', dir)).sort();
    expect(inside).toEqual([
      'checkpoints',
      'files',
      'research',
      'rewind-file-snapshots',
      'workspace.yaml',
    ]);
    expect(stateFileIn(path.join(root, 'session-state', dir))).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('FINDING — so discover() returns nothing for a real, non-empty install', () => {
    const root = realShape();
    expect(discover(root)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the metadata IS there, in YAML the adapter does not read', () => {
    const root = realShape();
    const dir = fs.readdirSync(path.join(root, 'session-state'))[0]!;
    const yaml = fs.readFileSync(path.join(root, 'session-state', dir, 'workspace.yaml'), 'utf8');
    // Everything SessionRecord wants except the turns themselves.
    expect(yaml).toMatch(/^id: /m);
    expect(yaml).toMatch(/^cwd: /m);
    expect(yaml).toMatch(/^created_at: /m);
    expect(yaml).toMatch(/^updated_at: /m);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
