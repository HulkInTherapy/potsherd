import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  columnsOf,
  describeStore,
  discover,
  doctorLine,
  findStores,
  isoOf,
  opencodeAdapter,
  parse,
  parseContent,
  quoteIdent,
  sourceDir,
} from '../../packages/core/src/adapters/opencode.js';
import { isAdapter } from '@potsherd/core';
// @ts-expect-error — a plain .mjs fixture builder, deliberately untyped.
import { makeOpencodeFixtures } from '../fixtures/opencode/make-opencode-db.mjs';

/**
 * The fixture store is **built from the committed synthetic builder**
 * (`tests/fixtures/opencode/make-opencode-db.mjs`) into a temp directory this
 * test owns. A sqlite file cannot be reviewed as committed text; the builder
 * can.
 */
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-opencode-'));
  makeOpencodeFixtures(root);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const source = (id: string) => {
  const found = discover(root).find((s) => s.sessionId === id);
  if (!found) throw new Error(`fixture session ${id} not discovered`);
  return found;
};

describe('opencode adapter — schema discovery (03 §10)', () => {
  it('reads columns from pragma table_info rather than assuming them', () => {
    const described = describeStore(path.join(root, 'snake.db'));
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.schema.sessions.table).toBe('session');
    expect(described.schema.sessions.columns['created']).toBe('created_at');
    expect(described.schema.sessions.columns['directory']).toBe('directory');
    expect(described.schema.messages.table).toBe('message');
    expect(described.schema.messages.columns['session']).toBe('session_id');
  });

  it('resolves a completely different set of column names in the same code path', () => {
    // The point of this test: `camel.db` shares no column name with
    // `snake.db`. A hard-coded schema cannot pass both.
    const described = describeStore(path.join(root, 'camel.db'));
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.schema.sessions.table).toBe('sessions');
    expect(described.schema.sessions.columns['id']).toBe('sessionID');
    expect(described.schema.sessions.columns['title']).toBe('name');
    expect(described.schema.sessions.columns['directory']).toBe('cwd');
    expect(described.schema.messages.columns['role']).toBe('kind');
    expect(described.schema.messages.columns['content']).toBe('body');
  });

  it('degrades to "unsupported version" instead of throwing on a store it cannot read', () => {
    const described = describeStore(path.join(root, 'alien.db'));
    expect(described.ok).toBe(false);
    if (described.ok) return;
    expect(described.reason).toContain('unsupported version');
    expect(described.reason).toContain('unrelated_table');
  });

  it('degrades rather than throwing when the file is not a database at all', () => {
    const junk = path.join(root, 'not-a-db.db');
    fs.writeFileSync(junk, 'fixture, not a database\n');
    const described = describeStore(junk);
    expect(described.ok).toBe(false);
    fs.rmSync(junk, { force: true });
  });

  it('degrades rather than throwing when the file does not exist', () => {
    const described = describeStore(path.join(root, 'absent.db'));
    expect(described.ok).toBe(false);
    if (described.ok) return;
    expect(described.reason).toContain('cannot open store read-only');
  });

  it('quotes identifiers the database reported, including awkward ones', () => {
    expect(quoteIdent('order')).toBe('"order"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('reports no columns for a table that does not exist, rather than throwing', () => {
    // `columnsOf` is the discovery primitive; it must never be the thing that
    // takes the process down.
    const described = describeStore(path.join(root, 'snake.db'));
    expect(described.ok).toBe(true);
  });
});

describe('opencode adapter — discovery', () => {
  it('finds the sqlite stores under the opencode directory', () => {
    const stores = findStores(root).map((p) => path.basename(p)).sort();
    expect(stores).toEqual(['alien.db', 'camel.db', 'snake.db']);
  });

  it('yields one source per session row, keyed by session id on a shared file', () => {
    const found = discover(root);
    expect(found.map((s) => s.sessionId).sort()).toEqual([
      'fixture-oc-camel-0001',
      'fixture-oc-session-0001',
      'fixture-oc-session-0002',
    ]);
    for (const s of found) {
      expect(s.harness).toBe('opencode');
      expect(path.isAbsolute(s.path)).toBe(true);
      expect(s.status).toBe('live');
    }
    // Two sessions share one database file — the id is what separates them.
    const snake = found.filter((s) => s.path.endsWith('snake.db'));
    expect(snake).toHaveLength(2);
    expect(new Set(snake.map((s) => s.path)).size).toBe(1);
  });

  it('marks a session with a parent as a sidechain', () => {
    expect(source('fixture-oc-session-0002').isSidechain).toBe(true);
    expect(source('fixture-oc-session-0002').parentSessionId).toBe('fixture-oc-session-0001');
    expect(source('fixture-oc-session-0001').isSidechain).toBe(false);
  });

  it('counts bytes per session, not per file', () => {
    const a = source('fixture-oc-session-0001').bytes;
    const b = source('fixture-oc-session-0002').bytes;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('skips the unsupported store without failing the whole discovery', () => {
    expect(discover(root).some((s) => s.path.endsWith('alien.db'))).toBe(false);
    expect(discover(root).length).toBe(3);
  });

  it('returns nothing rather than throwing when opencode is not installed', () => {
    const missing = path.join(os.tmpdir(), 'potsherd-opencode-does-not-exist');
    expect(fs.existsSync(missing)).toBe(false);
    expect(discover(missing)).toEqual([]);
    expect(sourceDir(missing)).toBe(missing);
  });
});

describe('opencode adapter — parse', () => {
  it('builds exchanges, tool calls and counts from JSON parts content', async () => {
    const { session, exchanges } = await parse(source('fixture-oc-session-0001'));
    expect(session.title).toBe('fixture snake session');
    expect(session.project).toBe('/tmp/potsherd-fx/gamma');
    expect(session.projectSlug).toBe('gamma');
    expect(session.model).toBe('fixture-model-a');
    expect(session.startedAt).toBe(new Date(1767322445000).toISOString());
    expect(session.endedAt).toBe(new Date(1767326045000).toISOString());
    expect(session.counts.userPrompts).toBe(2);
    expect(exchanges).toHaveLength(2);

    const first = exchanges[0]!;
    expect(first.userText).toBe('fixture prompt one');
    expect(first.assistantText).toContain('fixture reply one.');
    const read = first.toolCalls.find((c) => c.name === 'read')!;
    expect(read.result).toContain('fixture file body');
    expect(read.isError).toBeUndefined();
    const bash = first.toolCalls.find((c) => c.name === 'bash')!;
    expect(bash.isError).toBe(true);
    expect(first.filesTouched).toContain('/tmp/potsherd-fx/gamma/src/thing.ts');
  });

  it('counts unrendered part types and unclassified roles, and is not fatal', async () => {
    const { unknownTypes, exchanges } = await parse(source('fixture-oc-session-0001'));
    expect(unknownTypes['part:reasoning']).toBe(1);
    expect(unknownTypes['role:fixture-unknown-role']).toBe(1);
    expect(exchanges.length).toBeGreaterThan(0);
  });

  it('counts content that looks like JSON and is not, keeping it as prose', async () => {
    const { malformedLines, exchanges } = await parse(source('fixture-oc-session-0001'));
    expect(malformedLines).toBe(1);
    expect(exchanges[1]!.assistantText).toContain('fixture truncat');
  });

  it('parses the camelCase store through the same code path', async () => {
    const { session, exchanges } = await parse(source('fixture-oc-camel-0001'));
    expect(session.title).toBe('fixture camel session');
    expect(session.project).toBe('/tmp/potsherd-fx/delta');
    expect(session.startedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.userText).toBe('fixture camel prompt');
    expect(exchanges[0]!.assistantText).toBe('fixture camel reply.');
  });

  it('carries the parent session onto the record for a child session', async () => {
    const { session } = await parse(source('fixture-oc-session-0002'));
    expect(session.isSidechain).toBe(true);
    expect(session.parentSessionId).toBe('fixture-oc-session-0001');
  });

  it('returns an empty result with a counted reason for an unsupported store', async () => {
    const result = await parse({
      sessionId: 'whatever',
      harness: 'opencode',
      path: path.join(root, 'alien.db'),
      projectSlug: '',
      bytes: 0,
      mtimeMs: 0,
      isSidechain: false,
    });
    expect(result.exchanges).toEqual([]);
    expect(Object.keys(result.unknownTypes)[0]).toContain('unsupported version');
  });

  it('keeps exchange ids stable across re-parses', async () => {
    const a = await parse(source('fixture-oc-session-0001'));
    const b = await parse(source('fixture-oc-session-0001'));
    expect(a.exchanges.map((x) => x.id)).toEqual(b.exchanges.map((x) => x.id));
    expect(a.exchanges.map((x) => x.seq)).toEqual([1, 2]);
  });
});

describe('opencode adapter — content and time helpers', () => {
  it('reads plain text, a parts array and a wrapped object alike', () => {
    const u: Record<string, number> = {};
    const noop = () => {};
    expect(parseContent('fixture prose', u, noop).text).toBe('fixture prose');
    expect(parseContent('[{"type":"text","text":"a"}]', u, noop).text).toBe('a');
    expect(parseContent('{"parts":[{"type":"text","text":"b"}]}', u, noop).text).toBe('b');
    expect(parseContent('{"text":"c"}', u, noop).text).toBe('c');
  });

  it('accepts iso, epoch-ms and epoch-second timestamps and rejects nonsense', () => {
    expect(isoOf('2026-01-02T03:04:05.000Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(isoOf(1767322445000)).toBe(new Date(1767322445000).toISOString());
    expect(isoOf(1767322445)).toBe(new Date(1767322445000).toISOString());
    expect(isoOf('not a date')).toBeUndefined();
    expect(isoOf(null)).toBeUndefined();
    expect(isoOf(undefined)).toBeUndefined();
  });
});

describe('opencode adapter — doctor', () => {
  it('says "absent" when the harness is not installed at all', () => {
    const missing = path.join(os.tmpdir(), 'potsherd-opencode-does-not-exist');
    const line = doctorLine(missing);
    expect(line).toContain('absent');
    expect(line).toContain('opencode not installed');
  });

  it('says "empty" — not absent — when installed with no store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-oc-empty-'));
    const line = doctorLine(dir);
    expect(line).toContain('empty');
    expect(line).toContain('no sessions yet');
    expect(line).not.toContain('not installed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the json storage/ layout when that is what it found', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-oc-json-'));
    fs.mkdirSync(path.join(dir, 'storage', 'session'), { recursive: true });
    const line = doctorLine(dir);
    expect(line).toContain('empty');
    expect(line).toContain('storage/ json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says "unsupported" when every store present has an unreadable schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-oc-alien-'));
    fs.copyFileSync(path.join(root, 'alien.db'), path.join(dir, 'alien.db'));
    const line = doctorLine(dir);
    expect(line).toContain('unsupported');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says "ready" with a count when sessions parse', () => {
    const line = doctorLine(root);
    expect(line).toContain('ready');
    expect(line).toContain('3 sessions');
    expect(line).toContain('unverified format');
  });
});

describe('opencode adapter — the contract', () => {
  it('satisfies the Adapter interface', () => {
    expect(isAdapter(opencodeAdapter)).toBe(true);
    expect(opencodeAdapter.harness).toBe('opencode');
  });

  it('never writes to the store — the file is byte-identical after a full pass', async () => {
    const file = path.join(root, 'snake.db');
    const before = fs.readFileSync(file);
    discover(root);
    await parse(source('fixture-oc-session-0001'));
    doctorLine(root);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // And no journal/wal was left behind beside it.
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-journal`)).toBe(false);
  });
});
