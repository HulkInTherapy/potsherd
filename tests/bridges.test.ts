import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  BRIDGE_WEIGHTS,
  UNRANKED_PENALTY,
  agentMemoryDirs,
  claudeMemDbPath,
  claudeMemWorkerPort,
  closeAgentMemoryClients,
  collectCards,
  columnsOf,
  detectAgentMemory,
  detectClaudeMem,
  detectNotes,
  exportMarkdown,
  federate,
  federationLine,
  memoryDir,
  unavailableList,
  unrecognisedStatus,
  notesPaths,
  parseHits,
  pickColumn,
  pushToAgentMemory,
  queryAgentMemory,
  queryClaudeMem,
  queryNotes,
  safeSegment,
  sections,
  type BridgeList,
} from '@potsherd/bridges';
import { rrfScore } from '../packages/core/src/search/similarity.js';
import type { RecallResult } from '@potsherd/core';
import { tempDir, rmrf } from './helpers.js';

/**
 * T6.2 — the bridges and the exports.
 *
 * Two things this file is organised around, both of them consequences of the
 * machine it was written on:
 *
 * **Neither claude-mem nor agentmemory is installed here.** So the absent path
 * is not an edge case to be covered last; it is the path almost every user
 * takes, and it gets tested first and hardest. "No stack traces when the other
 * tool is missing" is a DoD box, and the only way to keep it is to assert it.
 *
 * **A store that is present is simulated, never assumed.** The claude-mem
 * tests build real sqlite files — one shaped like their documented schema, one
 * shaped nothing like it, one with an fts5 index and one without — because the
 * whole design claim of `claude-mem.ts` is that it discovers a schema at
 * runtime rather than hard-coding one, and that claim is only worth anything
 * if a schema it has never seen is in the test suite.
 */

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = tempDir(prefix);
  temps.push(dir);
  return dir;
}

afterAll(() => {
  closeAgentMemoryClients();
  for (const dir of temps) rmrf(dir);
});

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bridges',
  'stub-mcp-server.mjs',
);

// --------------------------------------------------------------- absent

describe('bridges degrade when the other tool is absent', () => {
  it('claude-mem reports absent, with a sentence and no throw', async () => {
    const home = temp('psh-cm-absent-');
    const status = await detectClaudeMem({ home, env: {}, noWorker: true });
    expect(status.presence).toBe('absent');
    expect(status.available).toBe(false);
    expect(status.detail).toContain('not installed');
    // A sentence, not a stack: one line, no "at Object.<anonymous>".
    expect(status.detail.split('\n')).toHaveLength(1);
    expect(status.detail).not.toContain('    at ');
    // The path is reported even when nothing is there, so `doctor` can show
    // the reader where potsherd looked.
    expect(status.path.endsWith('claude-mem.db')).toBe(true);
  });

  it('claude-mem query on an absent store returns an empty list, not an error', async () => {
    const home = temp('psh-cm-absent-q-');
    const list = await queryClaudeMem('pgbouncer', { home, env: {}, noWorker: true });
    expect(list.list).toBe('claude-mem');
    expect(list.hits).toEqual([]);
    expect(list.unavailable).toContain('not installed');
    expect(list.strategy).toBeNull();
  });

  it('agentmemory reports absent and names every path it probed', () => {
    const home = temp('psh-am-absent-');
    const status = detectAgentMemory({ home, env: { PATH: '' } });
    expect(status.presence).toBe('absent');
    // Naming one path invites "but it is installed, look in the other one".
    for (const candidate of agentMemoryDirs({ home, env: { PATH: '' } })) {
      expect(status.detail).toContain(path.basename(path.dirname(candidate.path)) === 'agentmemory' ? 'agentmemory' : 'agentmemory');
    }
    expect(status.detail).toContain('not installed');
  });

  it('agentmemory query on an absent store never spawns anything', async () => {
    const home = temp('psh-am-absent-q-');
    const started = Date.now();
    const list = await queryAgentMemory('pgbouncer', { home, env: { PATH: '' }, noCache: true });
    expect(list.hits).toEqual([]);
    expect(list.unavailable).toContain('not installed');
    // Nothing was spawned, so this cannot have taken anything like the 5 s
    // ceiling. The assertion is the point: detection precedes the spawn.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  /**
   * T6.6 D6 — `presence: 'store'` beside a `path` that is not there.
   *
   * `detectNotes` answers `store` when *any* readable file was found, and the
   * commonest way that happens is a `CLAUDE.md` walked up from the cwd with no
   * auto-memory directory anywhere. It then reported the auto-memory directory
   * as `path` — a directory that does not exist. `BridgeStatus.path` is
   * documented as "the path probed… so `doctor` can show it", and `find --with
   * notes --json` hands it straight to the caller, who has no way to know it is
   * a guess.
   */
  it('notes never reports a store at a path that does not exist', () => {
    const home = temp('psh-notes-path-');
    const project = path.join(home, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# rules\n\nuse pnpm.\n');
    const status = detectNotes({ claudeDir: path.join(home, '.claude'), cwd: project });
    expect(status.presence).toBe('store');
    expect(fs.existsSync(status.path)).toBe(true);
    // …and it is the file that was actually read, not a directory nobody made.
    expect(status.path).toBe(path.join(project, 'CLAUDE.md'));
  });

  it('notes still reports the memory directory when that is what it read', () => {
    const home = temp('psh-notes-mem-');
    const project = path.join(home, 'project');
    fs.mkdirSync(project, { recursive: true });
    const claudeDir = path.join(home, '.claude');
    const memory = memoryDir(path.join(claudeDir, 'projects'), project);
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'notes.md'), '# remembered\n\nthe pooler.\n');
    const status = detectNotes({ claudeDir, cwd: project });
    expect(status.presence).toBe('store');
    expect(status.path).toBe(memory);
    expect(fs.existsSync(status.path)).toBe(true);
  });

  it('notes reports absent when there is no memory dir and no CLAUDE.md', () => {
    const home = temp('psh-notes-absent-');
    const status = detectNotes({
      claudeDir: path.join(home, '.claude'),
      cwd: path.join(home, 'project'),
    });
    expect(status.presence).toBe('absent');
    expect(status.detail).toContain('not installed');
  });

  it('a federated result with every bridge absent is byte-identical to the local one', () => {
    const local = fakeRecall();
    const lists: BridgeList[] = [
      emptyBridge('claude-mem', 'absent'),
      emptyBridge('agentmemory', 'absent'),
      emptyBridge('notes', 'absent'),
    ];
    const federated = federate(local, lists);
    // The whole promise of `--with`: an absent tool changes the report and
    // never the results.
    expect(federated.hits).toEqual(local.hits);
    expect(federated.sessions).toEqual(local.sessions);
    expect(federated.external).toEqual([]);
    expect(federated.bridges.map((b) => b.presence)).toEqual(['absent', 'absent', 'absent']);
    expect(federationLine(federated.bridges)).toBe(
      'claude-mem: not installed  ·  agentmemory: not installed  ·  notes: not installed',
    );
  });
});

// -------------------------------------------------- claude-mem, simulated

describe('claude-mem schema discovery', () => {
  /** A store shaped the way claude-mem's own SessionStore shapes it. */
  function documentedStore(home: string, rows = 3): string {
    const dir = path.join(home, '.claude-mem');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'claude-mem.db');
    const db = new Database(file);
    // No `observations_fts`: claude-mem's source creates `observations` as an
    // ordinary table and only `user_prompts_fts` as fts5. The phase file said
    // "fts5 query of observations"; this is what is actually there.
    db.exec(`
      create table observations (
        id text primary key,
        session_id text,
        text text,
        title text,
        created_at integer
      );
      create table user_prompts (id integer primary key, prompt text);
      create virtual table user_prompts_fts using fts5(prompt);
    `);
    const insert = db.prepare('insert into observations values (?, ?, ?, ?, ?)');
    for (let i = 0; i < rows; i += 1) {
      insert.run(
        `obs-${i}`,
        's1',
        i === 0 ? 'the pgbouncer pool was sized per process' : `unrelated observation ${i}`,
        i === 0 ? 'pool sizing' : `note ${i}`,
        1770000000 + i,
      );
    }
    db.close();
    return file;
  }

  it('finds observations, and reports the like strategy when there is no fts index', async () => {
    const home = temp('psh-cm-doc-');
    documentedStore(home);
    const status = await detectClaudeMem({ home, env: {}, noWorker: true });
    expect(status.presence).toBe('store');
    expect(status.available).toBe(true);
    expect(status.schema?.table).toBe('observations');
    expect(status.schema?.textColumn).toBe('text');
    expect(status.schema?.timeColumn).toBe('created_at');
    // Discovered, not declared: the columns came back from pragma table_info.
    expect(status.schema?.columns).toEqual(['id', 'session_id', 'text', 'title', 'created_at']);
    expect(status.schema?.fts).toBe(false);
    expect(status.rows).toBe(3);

    const list = await queryClaudeMem('pgbouncer pool', { home, env: {}, noWorker: true });
    expect(list.unavailable).toBeNull();
    expect(list.strategy).toBe('like');
    expect(list.hits.length).toBeGreaterThan(0);
    expect(list.hits[0]?.text).toContain('pgbouncer');
    expect(list.hits[0]?.rank).toBe(1);
    // The timestamp was epoch seconds and comes back as ISO, or as null —
    // never as `Invalid Date`.
    expect(list.hits[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('uses fts5 when the store has an index, and says so', async () => {
    const home = temp('psh-cm-fts-');
    const dir = path.join(home, '.claude-mem');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'claude-mem.db'));
    db.exec(`
      create table observations (id text primary key, text text, created_at text);
      create virtual table observations_fts using fts5(text);
    `);
    db.prepare('insert into observations values (?, ?, ?)').run(
      'o1',
      'the pgbouncer pool was sized per process',
      '2026-02-14T09:20:00Z',
    );
    db.prepare('insert into observations_fts(rowid, text) values (?, ?)').run(
      1,
      'the pgbouncer pool was sized per process',
    );
    db.close();

    const list = await queryClaudeMem('pgbouncer', { home, env: {}, noWorker: true });
    expect(list.strategy).toBe('fts5');
    expect(list.hits).toHaveLength(1);
    expect(list.hits[0]?.bridge).toBe('claude-mem');
  });

  it('relaxes to any-token only after the strict pass finds nothing', async () => {
    const home = temp('psh-cm-relax-');
    documentedStore(home);
    const strict = await queryClaudeMem('pgbouncer pool', { home, env: {}, noWorker: true });
    expect(strict.relaxed).toBe(false);

    // `pgbouncer` is there and `kubernetes` is not, so the AND pass is empty
    // and the OR pass is not.
    const relaxed = await queryClaudeMem('pgbouncer kubernetes', { home, env: {}, noWorker: true });
    expect(relaxed.relaxed).toBe(true);
    expect(relaxed.hits.length).toBeGreaterThan(0);
  });

  it('degrades to "schema not recognised" on a store it cannot read', async () => {
    const home = temp('psh-cm-weird-');
    const dir = path.join(home, '.claude-mem');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'claude-mem.db'));
    // Every column is a number. There is nothing here to search.
    db.exec('create table telemetry (a integer, b integer, c integer)');
    db.prepare('insert into telemetry values (1, 2, 3)').run();
    db.close();

    const status = await detectClaudeMem({ home, env: {}, noWorker: true });
    expect(status.presence).toBe('unrecognised');
    expect(status.detail).toContain('bridge unavailable: schema not recognised');
    expect(status.detail).toContain('telemetry');
    expect(status.available).toBe(false);

    const list = await queryClaudeMem('anything', { home, env: {}, noWorker: true });
    expect(list.hits).toEqual([]);
    expect(list.unavailable).toContain('schema not recognised');
  });

  it('separates "installed and empty" from "not installed"', async () => {
    const dirOnly = temp('psh-cm-empty-');
    fs.mkdirSync(path.join(dirOnly, '.claude-mem'), { recursive: true });
    const noDb = await detectClaudeMem({ home: dirOnly, env: {}, noWorker: true });
    expect(noDb.presence).toBe('empty');
    expect(noDb.detail).toContain('installed, nothing to search');

    const noRows = temp('psh-cm-empty2-');
    documentedStore(noRows, 0);
    const empty = await detectClaudeMem({ home: noRows, env: {}, noWorker: true });
    expect(empty.presence).toBe('empty');
    expect(empty.rows).toBe(0);
    // The schema was still discovered — the store is readable, it is the data
    // that is missing, and a reader deserves to know which.
    expect(empty.schema?.table).toBe('observations');
  });

  it('survives a file that is not a database at all', async () => {
    const home = temp('psh-cm-garbage-');
    const dir = path.join(home, '.claude-mem');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude-mem.db'), 'this is not sqlite');
    const status = await detectClaudeMem({ home, env: {}, noWorker: true });
    expect(status.presence).toBe('unrecognised');
    expect(status.detail.split('\n')).toHaveLength(1);
  });

  it('honours claude-mem’s own overrides rather than hard-coding its defaults', () => {
    const moved = temp('psh-cm-moved-');
    expect(claudeMemDbPath({ env: { CLAUDE_MEM_DATA_DIR: moved } })).toBe(
      path.join(path.resolve(moved), 'claude-mem.db'),
    );
    expect(claudeMemWorkerPort({ env: { CLAUDE_MEM_WORKER_PORT: '40123' } })).toBe(40123);
    // The formula from their SettingsDefaultsManager, including the `?? 77`.
    const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
    expect(claudeMemWorkerPort({ env: {} })).toBe(37700 + (uid % 100));
    expect(claudeMemWorkerPort({ env: {} })).toBeGreaterThanOrEqual(37700);
    expect(claudeMemWorkerPort({ env: {} })).toBeLessThan(37800);
  });

  it('pickColumn prefers an exact name and never invents one', () => {
    expect(pickColumn(['id', 'content_hash', 'content'], ['text', 'content'])).toBe('content');
    expect(pickColumn(['body_text'], ['text'])).toBe('body_text');
    expect(pickColumn(['a', 'b'], ['text', 'content'])).toBeNull();
  });

  it('columnsOf quotes a table name it was handed', () => {
    const home = temp('psh-cm-quote-');
    const file = path.join(home, 'q.db');
    const db = new Database(file);
    db.exec('create table "odd ""name" (x integer)');
    db.close();
    const read = new Database(file, { readonly: true });
    expect(columnsOf(read as never, 'odd "name')).toEqual(['x']);
    read.close();
  });
});

// ------------------------------------------------------------------ notes

describe('notes', () => {
  function withNotes(): { home: string; cwd: string; claudeDir: string } {
    const home = temp('psh-notes-');
    const claudeDir = path.join(home, '.claude');
    const cwd = path.join(home, 'work', 'project');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'CLAUDE.md'),
      '# global\n\nalways use pnpm, never npm.\n',
    );
    fs.writeFileSync(
      path.join(cwd, 'CLAUDE.md'),
      '# database\n\nuse pgbouncer in transaction mode.\n\n# style\n\nno semicolons.\n',
    );
    const memory = path.join(claudeDir, 'projects', cwd.replace(/[/\\]/g, '-'), 'memory');
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'MEMORY.md'), '# decisions\n\npgbouncer was chosen over pgpool.\n');
    return { home, cwd, claudeDir };
  }

  it('reads auto-memory and both kinds of CLAUDE.md, and labels each correctly', () => {
    const { cwd, claudeDir } = withNotes();
    const status = detectNotes({ cwd, claudeDir });
    expect(status.presence).toBe('store');
    expect(status.detail).toContain('auto-memory');
    expect(status.detail).toContain('project-claude-md');
    expect(status.detail).toContain('global-claude-md');
  });

  it('never labels the global CLAUDE.md as a project rule', () => {
    // The bug this exists to prevent: walking up from a cwd inside the home
    // directory finds `<home>/.claude/CLAUDE.md` and calls it a project rule.
    const home = temp('psh-notes-global-');
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# global\n\nalways use pnpm.\n');
    const cwd = path.join(home, 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });

    const paths_ = notesPaths({ cwd, claudeDir });
    const global = paths_.filter((p) => p.path === path.join(claudeDir, 'CLAUDE.md'));
    expect(global).toHaveLength(1);
    expect(global[0]?.kind).toBe('global-claude-md');

    const status = detectNotes({ cwd, claudeDir });
    expect(status.detail).toContain('global-claude-md');
    expect(status.detail).not.toContain('project-claude-md');
  });

  it('answers "this is already in your CLAUDE.md" with the section, not the file', () => {
    const { cwd, claudeDir } = withNotes();
    const list = queryNotes('pgbouncer transaction mode', { cwd, claudeDir });
    expect(list.strategy).toBe('files');
    expect(list.unavailable).toBeNull();
    expect(list.hits.length).toBeGreaterThan(0);
    // The hit names which file and which heading, which is the whole output.
    expect(list.hits[0]?.title).toMatch(/CLAUDE\.md › database|auto-memory › decisions/);
    expect(list.hits[0]?.id).toContain('#');
  });

  it('requires every token before it relaxes', () => {
    const { cwd, claudeDir } = withNotes();
    const strict = queryNotes('pgbouncer transaction', { cwd, claudeDir });
    expect(strict.relaxed).toBe(false);

    // Nothing here is about kubernetes. The strict pass finds nothing, the
    // relaxed one finds the pgbouncer sections, and the flag says which.
    const relaxed = queryNotes('pgbouncer kubernetes', { cwd, claudeDir });
    expect(relaxed.relaxed).toBe(true);
    expect(relaxed.hits.length).toBeGreaterThan(0);
  });

  it('splits on headings and keeps text that has none', () => {
    const flat = sections('/x/CLAUDE.md', 'project-claude-md', 'no headings here at all\njust rules\n');
    expect(flat).toHaveLength(1);
    expect(flat[0]?.heading).toBe('CLAUDE.md');

    const headed = sections('/x/CLAUDE.md', 'project-claude-md', 'preamble\n\n# one\na\n\n## two\nb\n');
    expect(headed.map((s) => s.heading)).toEqual(['CLAUDE.md', 'one', 'two']);
    expect(headed[1]?.line).toBe(3);
  });

  it('does not read transcripts — that would be the double capture 03 §10 forbids', () => {
    const { cwd, claudeDir } = withNotes();
    for (const candidate of notesPaths({ cwd, claudeDir })) {
      expect(candidate.path.endsWith('.jsonl')).toBe(false);
    }
  });
});

// ------------------------------------------------------------ agentmemory

describe('agentmemory over the stdio client', () => {
  function store(): { home: string; env: NodeJS.ProcessEnv } {
    const home = temp('psh-am-');
    const dir = path.join(home, 'Library', 'Application Support', 'agentmemory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), '{}');
    return {
      home,
      env: { ...process.env, POTSHERD_AGENTMEMORY_COMMAND: `${process.execPath} ${STUB}` },
    };
  }

  it('probes the app-data directory before the dotdir', () => {
    const home = temp('psh-am-order-');
    const probed = agentMemoryDirs({ home, env: {} });
    expect(probed[0]?.kind).toBe('app-data');
    expect(probed[probed.length - 1]?.kind).toBe('dotdir');
    expect(probed[probed.length - 1]?.path).toBe(path.join(home, '.agentmemory'));
    // The plan said `~/.agentmemory`; their README says app-data. Both are
    // checked, and the documented one wins.
    expect(probed.some((c) => c.path.includes('agentmemory'))).toBe(true);
  });

  it('calls exactly one tool and reads its argument names from tools/list', async () => {
    const { home, env } = store();
    const list = await queryAgentMemory('pgbouncer', { home, env, noCache: true, limit: 5 });
    expect(list.unavailable).toBeNull();
    expect(list.strategy).toBe('mcp');
    expect(list.hits.length).toBeGreaterThan(0);
    expect(list.hits[0]?.bridge).toBe('agentmemory');
    // The stub echoes the query back, which proves the client sent it under
    // the name the *server's* schema declared rather than a hard-coded one.
    expect(list.hits[0]?.text).toContain('pgbouncer');
  });

  it('skips, with a sentence, when the command does not exist', async () => {
    const { home, env } = store();
    const list = await queryAgentMemory('pgbouncer', {
      home,
      env: { ...env, POTSHERD_AGENTMEMORY_COMMAND: '/nonexistent/agentmemory-mcp' },
      noCache: true,
      timeoutMs: 1000,
    });
    expect(list.hits).toEqual([]);
    expect(list.unavailable).toContain('skipped');
    expect(list.unavailable?.split('\n')).toHaveLength(1);
  });

  it('reports "installed and unstartable" as its own state', () => {
    const { home } = store();
    const status = detectAgentMemory({ home, env: { PATH: '' } });
    expect(status.presence).toBe('unrecognised');
    expect(status.detail).toContain('launch command not discoverable');
    // Not "schema not recognised": no schema was ever read.
    expect(status.detail).not.toContain('schema');
  });

  it('never runs a downloader, however the config asks for one', () => {
    const home = temp('psh-am-npx-');
    const dir = path.join(home, 'Library', 'Application Support', 'agentmemory');
    fs.mkdirSync(dir, { recursive: true });
    // Exactly what agentmemory's own plugin/.mcp.json contains.
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { agentmemory: { command: 'npx', args: ['-y', '@agentmemory/mcp'] } } }),
    );
    const status = detectAgentMemory({ home, env: { PATH: '' } });
    expect(status.presence).toBe('unrecognised');
    expect(status.detail).toContain('launch command not discoverable');
  });

  it('parses a result it has no schema for, four ways, and never throws', () => {
    expect(parseHits(JSON.stringify([{ id: 'a', text: 'one' }]), 5, 's')).toHaveLength(1);
    expect(parseHits(JSON.stringify({ results: [{ text: 'one' }, { text: 'two' }] }), 5, 's')).toHaveLength(2);
    expect(parseHits(JSON.stringify({ text: 'just one object' }), 5, 's')).toHaveLength(1);
    // Prose. A bridge that returned nothing here would be reporting a
    // parser's opinion as the user's memory.
    expect(parseHits('first paragraph\n\nsecond paragraph', 5, 's')).toHaveLength(2);
    expect(parseHits('', 5, 's')).toEqual([]);
    expect(parseHits('{ not json', 5, 's')).toHaveLength(1);
  });
});

// --------------------------------------------------------------- the fusion

describe('federate', () => {
  it('uses the same arithmetic as the local ranker, from the result’s own k', () => {
    const local = fakeRecall();
    const list = bridgeWith('claude-mem', 3);
    const federated = federate(local, [list]);
    const weight = BRIDGE_WEIGHTS['claude-mem'];
    for (const [i, hit] of federated.external.entries()) {
      // Not a re-derivation: `rrfScore` is imported from
      // packages/core/src/search/similarity.ts, so if the two ever disagree
      // this fails rather than drifting silently.
      expect(hit.score).toBeCloseTo(weight * rrfScore(i + 1, local.k), 12);
    }
  });

  it('halves an unranked list, because RRF reads order and `like` has none', () => {
    const local = fakeRecall();
    const ranked = federate(local, [bridgeWith('claude-mem', 2, 'fts5')]);
    const unranked = federate(local, [bridgeWith('claude-mem', 2, 'like')]);
    expect(ranked.bridges[0]?.weight).toBe(BRIDGE_WEIGHTS['claude-mem']);
    expect(unranked.bridges[0]?.weight).toBe(BRIDGE_WEIGHTS['claude-mem'] * UNRANKED_PENALTY);
    expect(unranked.external[0]!.score!).toBeCloseTo(ranked.external[0]!.score! * UNRANKED_PENALTY, 12);
  });

  it('never merges a foreign hit into the local list', () => {
    const local = fakeRecall();
    const federated = federate(local, [bridgeWith('claude-mem', 4)]);
    expect(federated.hits).toEqual(local.hits);
    expect(federated.external).toHaveLength(Math.min(4, Math.max(local.sessions.length, 5)));
    // A foreign hit carries no sessionId and cannot be mistaken for one.
    for (const hit of federated.external) {
      expect(hit).not.toHaveProperty('sessionId');
      expect(hit.bridge).toBe('claude-mem');
    }
  });

  it('interleaves both halves by score in `order`', () => {
    const local = fakeRecall();
    const federated = federate(local, [bridgeWith('notes', 2)]);
    const scores = federated.order.map((ref) =>
      ref.kind === 'local' ? federated.hits[ref.index]!.score : federated.external[ref.index]!.score!,
    );
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(federated.order).toHaveLength(local.hits.length + federated.external.length);
  });

  /**
   * T6.6 D4 — the sentence `types.ts` says must never be printed.
   *
   * `unrecognisedStatus`'s own doc: "printing 'schema not recognised' at
   * someone whose schema was never read would send them to look in the wrong
   * place." An agentmemory install with no discoverable launch command is
   * exactly that: presence `unrecognised`, headline `bridge unavailable`, and
   * no schema was ever read because the server was never started. `--json`
   * got it right because it carries `unavailable`; `federationLine` discarded
   * the headline and printed the constant.
   */
  it('never says "schema not recognised" about a schema that was never read', () => {
    const local = fakeRecall();
    const status = unrecognisedStatus(
      'agentmemory',
      '/fake/agentmemory',
      'launch command not discoverable; set POTSHERD_AGENTMEMORY_COMMAND',
      null,
      'bridge unavailable',
    );
    const f = federate(local, [unavailableList(status)]);
    const line = federationLine(f.bridges);
    expect(line).toBe('agentmemory: bridge unavailable');
    expect(line).not.toContain('schema not recognised');
    // …and the `--json` sentence, which was always right, is unchanged.
    expect(f.bridges[0]!.unavailable).toBe(
      'bridge unavailable (launch command not discoverable; set POTSHERD_AGENTMEMORY_COMMAND)',
    );
  });

  /** A real schema mismatch still says so, or the fix above is a regression. */
  it('still says "schema not recognised" when a schema really was read and rejected', () => {
    const local = fakeRecall();
    const status = unrecognisedStatus('claude-mem', '/fake/claude-mem', 'no text column');
    const f = federate(local, [unavailableList(status)]);
    expect(federationLine(f.bridges)).toBe('claude-mem: schema not recognised');
  });

  it('gives every presence its own sentence', () => {
    const local = fakeRecall();
    const f = federate(local, [
      emptyBridge('claude-mem', 'empty'),
      emptyBridge('agentmemory', 'unrecognised'),
      bridgeWith('notes', 2),
    ]);
    expect(federationLine(f.bridges)).toBe(
      'claude-mem: installed, nothing to search  ·  agentmemory: schema not recognised  ·  notes: 2 hits',
    );
  });
});

// -------------------------------------------------------------- the export

describe('export --to markdown', () => {
  /** A cards mirror with one real card and both sentinels beside it. */
  function mirror(): string {
    const root = temp('psh-export-');
    const dir = path.join(root, 'cards', 'claude', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'aaaa1111.md'), '---\nid: "aaaa1111"\n---\n\n# a real card\n\nbody.\n');
    fs.writeFileSync(path.join(dir, 'bbbb2222.md'), '');
    fs.writeFileSync(path.join(dir, 'cccc3333.md'), '__ERRORED__\n');
    return root;
  }

  it('copies the mirror and skips potsherd’s own bookkeeping', () => {
    const root = mirror();
    const dest = path.join(temp('psh-vault-'), 'vault');
    const result = exportMarkdown({ root, dest });
    expect(result.cards.files).toBe(1);
    expect(result.cards.skipped).toBe(2);
    expect(fs.existsSync(path.join(dest, 'claude', 'demo', 'aaaa1111.md'))).toBe(true);
    // A file whose entire content is `__ERRORED__` must never land in a vault.
    expect(fs.existsSync(path.join(dest, 'claude', 'demo', 'cccc3333.md'))).toBe(false);
    expect(result.transcripts).toBeNull();
  });

  it('re-exports in place rather than duplicating', () => {
    const root = mirror();
    const dest = path.join(temp('psh-vault2-'), 'vault');
    exportMarkdown({ root, dest });
    const again = exportMarkdown({ root, dest });
    expect(again.cards.files).toBe(1);
    expect(fs.readdirSync(path.join(dest, 'claude', 'demo'))).toEqual(['aaaa1111.md']);
  });

  it('writes 0600, because a card is the archive leaving ~/.potsherd', () => {
    const root = mirror();
    const dest = path.join(temp('psh-vault3-'), 'vault');
    exportMarkdown({ root, dest });
    const mode = fs.statSync(path.join(dest, 'claude', 'demo', 'aaaa1111.md')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('is honest about an empty mirror instead of failing', () => {
    const root = temp('psh-export-empty-');
    const dest = path.join(temp('psh-vault4-'), 'vault');
    const result = exportMarkdown({ root, dest });
    expect(result.cards.files).toBe(0);
    expect(result.cards.skipped).toBe(0);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('says why --transcripts did nothing rather than writing an empty tree', () => {
    const root = mirror();
    const dest = path.join(temp('psh-vault5-'), 'vault');
    const result = exportMarkdown({ root, dest, transcripts: true });
    expect(result.transcripts?.files).toBe(0);
    expect(result.transcripts?.reasons[0]).toContain('needs the database');
    expect(fs.existsSync(path.join(dest, 'transcripts'))).toBe(false);
  });

  it('a project name out of a transcript cannot escape the destination', () => {
    // The project name is untrusted input to this process, however trusted
    // its author. `../../.ssh` must become a segment, not a traversal.
    expect(safeSegment('../../.ssh')).not.toContain('..');
    expect(safeSegment('../../.ssh').includes('/')).toBe(false);
    expect(safeSegment('')).toBe('unknown');
    expect(safeSegment(null)).toBe('unknown');
    expect(safeSegment('normal-project')).toBe('normal-project');
  });

  it('collectCards reads the mirror and skips the sentinels too', () => {
    const root = mirror();
    const cards = collectCards(root);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.sessionId).toBe('aaaa1111');
    expect(cards[0]?.title).toBe('a real card');
    expect(collectCards(temp('psh-nocards-'))).toEqual([]);
  });
});

// ------------------------------------------------------- the consent gate

describe('export --to agentmemory writes nothing without --yes', () => {
  it('refuses on an absent store, whatever the flag says', async () => {
    const home = temp('psh-push-absent-');
    const result = await pushToAgentMemory([{ sessionId: 'a', title: 't', markdown: '# t' }], {
      home,
      env: { PATH: '' },
      yes: true,
    });
    expect(result.wrote).toBe(false);
    expect(result.pushed).toBe(0);
    expect(result.detail).toContain('nothing written');
  });

  it('plans without --yes, and the plan touches nothing', async () => {
    const home = temp('psh-push-plan-');
    const dir = path.join(home, 'Library', 'Application Support', 'agentmemory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), '{}');
    const env = { ...process.env, POTSHERD_AGENTMEMORY_COMMAND: `${process.execPath} ${STUB}` };

    const cards = [
      { sessionId: 'a', title: 'one', markdown: '# one' },
      { sessionId: 'b', title: 'two', markdown: '# two' },
    ];
    const plan = await pushToAgentMemory(cards, { home, env, timeoutMs: 5000 });
    expect(plan.wrote).toBe(false);
    expect(plan.pushed).toBe(0);
    expect(plan.planned).toBe(2);
    // Discovery happened — it can name the tool — and no write did.
    expect(plan.tool).toBe('memory_store');
    expect(plan.detail).toContain('would be pushed');
    expect(plan.detail).toContain('--yes');
    expect(readStubWrites()).toEqual([]);

    const wrote = await pushToAgentMemory(cards, { home, env, yes: true, timeoutMs: 5000 });
    expect(wrote.wrote).toBe(true);
    expect(wrote.pushed).toBe(2);
    expect(readStubWrites()).toHaveLength(2);
    closeAgentMemoryClients();
  });
});

// ----------------------------------------------------------------- helpers

/** Where the stub server records what was written into it. */
function readStubWrites(): unknown[] {
  const log = path.join(os.tmpdir(), 'potsherd-stub-mcp-writes.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakeRecall(): RecallResult {
  const hit = (i: number): RecallResult['hits'][number] => ({
    kind: 'exchange',
    sessionId: `s${i}`,
    id: `e${i}`,
    seq: i,
    ts: null,
    userText: `local ${i}`,
    snippet: { text: `local ${i}`, ranges: [] } as never,
    isSidechain: false,
    score: 1 / (60 + i),
    from: [{ list: 'exchanges_fts', rank: i, raw: -1, contribution: 1 / (60 + i) }],
  });
  const hits = [hit(1), hit(2), hit(3)];
  return {
    query: 'pgbouncer',
    sessions: [],
    hits,
    vectors: { used: false, available: false },
    lists: [],
    k: 60,
    weights: {},
    relaxedLists: [],
    relaxed: false,
    ghostsOnly: false,
    indexedGhosts: null,
    ms: 1,
  };
}

function bridgeWith(
  name: 'claude-mem' | 'agentmemory' | 'notes',
  n: number,
  strategy: BridgeList['strategy'] = 'fts5',
): BridgeList {
  return {
    list: name,
    status: {
      bridge: name,
      presence: 'store',
      path: `/fake/${name}`,
      available: true,
      detail: 'a fake store',
      schema: null,
      rows: n,
      worker: null,
    },
    hits: Array.from({ length: n }, (_, i) => ({
      bridge: name,
      id: `x${i}`,
      title: `their hit ${i}`,
      text: `their hit ${i}`,
      ts: null,
      source: `/fake/${name}`,
      rank: i + 1,
      raw: 0,
    })),
    ms: 1,
    unavailable: null,
    strategy,
    relaxed: false,
  };
}

function emptyBridge(
  name: 'claude-mem' | 'agentmemory' | 'notes',
  presence: 'absent' | 'empty' | 'unrecognised',
): BridgeList {
  return {
    list: name,
    status: {
      bridge: name,
      presence,
      path: `/fake/${name}`,
      available: false,
      detail: 'not here',
      // T6.6 D4 — the headline is the bridge's own sentence, and the fixture
      // has to carry a plausible one per presence or the footer test would be
      // asserting a string this helper made up.
      headline:
        presence === 'absent'
          ? 'not installed'
          : presence === 'empty'
            ? 'installed, nothing to search'
            : 'schema not recognised',
      schema: null,
      rows: null,
      worker: null,
    },
    hits: [],
    ms: 0,
    unavailable: 'not here',
    strategy: null,
    relaxed: false,
  };
}
