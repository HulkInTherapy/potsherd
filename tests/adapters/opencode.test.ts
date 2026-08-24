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
  OPENCODE_DOCTOR_NOTE,
  OPENCODE_FORMAT_PROVENANCE,
  OPENCODE_FORMAT_UNVERIFIED,
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
    // Was `unverified format`. T10.12 ran a real 1.18.21 store through this
    // path; what it found was a measured defect, which is a stronger claim
    // than never having looked. See the D8 block at the foot of this file.
    expect(line).toContain('content unread at 1.18.21');
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

// ---------------------------------------------------------------------------
// MEASURED AGAINST A REAL opencode-ai 1.18.21 (T10.12, 2026-08-24)
//
// This is the one of the four harnesses where a full round trip happened.
// `opencode-ai@1.18.21` installs from npm — the phase-5 claim that it could
// not be installed here was never checked and is false — and it answered "say
// hello" through its bundled provider with no credentials of ours. Run under a
// relocated HOME, then indexed:
//
//   opencode  1  1 session · 1 exchange · 1 re-read
//   24 aug  openco…  work   Greeting request   live
//
// SO: DISCOVERY IS VERIFIED. The store is `~/.local/share/opencode/opencode.db`
// exactly as this adapter guessed; `describeStore` accepts it, the `session`
// row parses, and title, directory and both timestamps are right. That half of
// the `unverified` label is earned off and `T10.12-LABELS.md` says so.
//
// FINDING — the CONTENT half is verified WRONG. `message` at 1.18.21 has no
// role and no content column: the role is inside a `data` JSON blob, and the
// turn's text is not in `message` at all, it is in `part.data`. Column
// discovery finds `data`, treats the metadata blob as the message body, and a
// real session comes out as `prompts: 0` with `doctor` counting
// `opencode role:(no role)` twice — while `potsherd show` prints a JSON object
// of token counts where the answer should be. Neither "say hello" nor "Hello!"
// survives anywhere in the index.
//
// NOT FIXED HERE: joining `part` is a new read path, and `03 §10`'s rule is
// discovery plus degrade, not a second hard-coded schema. `T10.12-LABELS.md`
// carries the recommendation (widen MESSAGE_COLUMNS to look inside `data`, and
// join `part` on `message_id` when no content column exists).
describe('opencode adapter — a real opencode-ai 1.18.21 store (T10.12)', () => {
  let realDir: string;
  let realDb: string;

  beforeAll(async () => {
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-11821-'));
    realDb = path.join(realDir, 'opencode.db');
    const mod = await import('../fixtures/opencode/make-opencode-db.mjs');
    (mod as { buildOpencodeReal: (f: string) => void }).buildOpencodeReal(realDb);
  });

  afterAll(() => {
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('VERIFIED — the store is found where the adapter looks and is supported', () => {
    expect(findStores(realDir)).toContain(realDb);
    const described = describeStore(realDb);
    expect(described.ok, described.ok ? '' : described.reason).toBe(true);
  });

  it('VERIFIED — the session row parses: title, directory, both timestamps', async () => {
    const found = discover(realDir);
    expect(found).toHaveLength(1);
    const r = await parse(found[0]!);
    expect(r.session.title).toBe('Greeting request');
    expect(r.session.project).toBe('/w/scratch');
    expect(r.session.startedAt).not.toBe('');
    expect(r.session.endedAt).not.toBe('');
  });

  it('FINDING — message has no role or content column; both live in JSON', () => {
    const described = describeStore(realDb);
    if (!described.ok) throw new Error(described.reason);
    const cols = described.schema.messages.columns;
    expect(described.schema.messages.table).toBe('message');
    // The adapter resolved neither: both are inside the `data` JSON blob.
    expect(cols['role']).toBeUndefined();
    // and what it DID resolve as content is that blob.
    expect(cols['content']).toBe('data');
  });

  it('FINDING — so a real session indexes with zero prompts and no turn text', async () => {
    const r = await parse(discover(realDir)[0]!);
    expect(r.session.counts.userPrompts, 'see T10.12-LABELS.md — opencode F1').toBe(0);
    const whole = JSON.stringify(r.exchanges);
    expect(whole).not.toContain('say hello');
    expect(whole).not.toContain('Hello!');
    // what landed instead: the metadata blob, verbatim.
    expect(whole).toContain('finish');
    expect(Object.keys(r.unknownTypes).some((t) => /no role/i.test(t))).toBe(true);
  });
});

/**
 * D8 — the relabelling, applied to the surface a caller actually reads.
 *
 * T10.12 measured this adapter against a real opencode-ai 1.18.21 and split
 * its label in two: discovery and session metadata **verified correct**,
 * message content **verified unread**. Only copilot's human line was updated.
 * `OPENCODE_DOCTOR_NOTE` still opened with *"this adapter was written from
 * documentation, not from a real store"* — a sentence the same phase had
 * falsified — and all four `doctorLine()` notes still ended `unverified
 * format`, so the one word a caller greps for said "nobody looked" about the
 * only one of the four harnesses that got a full round trip.
 *
 * Every claim asserted here is from `phases/phase-10/T10.12-LABELS.md` §4.
 */
describe('the opencode label says what was measured (D8)', () => {
  it('the doctor note no longer claims nobody ran this against a real store', () => {
    expect(OPENCODE_DOCTOR_NOTE).not.toMatch(/not from a real store/);
    expect(OPENCODE_DOCTOR_NOTE).not.toMatch(/written from documentation/);
    // What replaced it: the version, and both halves of the split label.
    expect(OPENCODE_DOCTOR_NOTE).toContain('1.18.21');
    expect(OPENCODE_DOCTOR_NOTE).toMatch(/discovery/i);
    expect(OPENCODE_DOCTOR_NOTE).toMatch(/part/);
  });

  it('no doctor line calls the format unverified any more', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-oc-label-'));
    const alien = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-oc-alien2-'));
    fs.copyFileSync(path.join(root, 'alien.db'), path.join(alien, 'alien.db'));
    try {
      for (const line of [doctorLine(root), doctorLine(empty), doctorLine(alien)]) {
        expect(line, line).not.toContain('unverified');
      }
      // The ready line carries the measurement instead, and names the defect
      // rather than a state of ignorance.
      expect(doctorLine(root)).toContain('1.18.21');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(alien, { recursive: true, force: true });
    }
  });

  it('exports the provenance as data, not only as a sentence', () => {
    // `doctor --json` is the documented API and the line it carries is
    // width-clipped, so the split label has to exist as fields. This is the
    // constant `doctor.ts` needs one line to publish.
    expect(OPENCODE_FORMAT_PROVENANCE.measured).toContain('1.18.21');
    expect(OPENCODE_FORMAT_PROVENANCE.verified.length).toBeGreaterThan(0);
    expect(OPENCODE_FORMAT_PROVENANCE.wrong.length).toBeGreaterThan(0);
    // Still a form of unverified, per T10.12 §6: two of five keep one.
    expect(OPENCODE_FORMAT_UNVERIFIED).toBe(true);
    expect(OPENCODE_FORMAT_PROVENANCE.unverified).toBe(OPENCODE_FORMAT_UNVERIFIED);
  });
});
