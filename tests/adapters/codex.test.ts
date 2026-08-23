import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionIndexCache,
  codexDir,
  codexDoctor,
  codexEntrypoint,
  codexPaths,
  codexAdapter,
  discover,
  filesFromCodexToolInput,
  parse,
  readCodexHeader,
  readSessionIndex,
  renderCodexDoctorLine,
  sessionIdFromRolloutPath,
} from '../../packages/core/src/adapters/codex.js';
import type { SessionSource } from '../../packages/core/src/adapters/types.js';
import { rmrf, tempDir } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '..', 'fixtures', 'codex');

const IDS = {
  /** Every record type, two turns, an unknown envelope and a malformed line. */
  full: 'd1d1d1d1-1111-4111-8111-111111111111',
  /** The oversized-line stand-in: base64 images, no text part. */
  binary: 'd2d2d2d2-2222-4222-8222-222222222222',
  /** Under `archived_sessions/`, and absent from `session_index.jsonl`. */
  archived: 'd3d3d3d3-3333-4333-8333-333333333333',
} as const;

const home = { codexHome: FIXTURE };

function sourceFor(id: string): SessionSource {
  const found = discover(home).find((s) => s.sessionId === id);
  if (!found) throw new Error(`fixture ${id} not discovered`);
  return found;
}

afterEach(() => {
  clearSessionIndexCache();
});

// ---------------------------------------------------------------- discovery

describe('codex discover()', () => {
  it('finds live and archived rollouts and nothing else', () => {
    const sources = discover(home);
    expect(sources.map((s) => s.sessionId)).toEqual([IDS.archived, IDS.full, IDS.binary]);
    expect(sources.every((s) => s.harness === 'codex')).toBe(true);
    expect(sources.every((s) => path.basename(s.path).startsWith('rollout-'))).toBe(true);
    expect(sources.every((s) => s.bytes > 0 && s.mtimeMs > 0)).toBe(true);
    expect(sources.every((s) => s.isSidechain === false)).toBe(true);
  });

  it('marks archived_sessions/ archived and sessions/ live', () => {
    const byId = new Map(discover(home).map((s) => [s.sessionId, s]));
    expect(byId.get(IDS.archived)?.status).toBe('archived');
    expect(byId.get(IDS.full)?.status).toBe('live');
  });

  it('ignores the non-transcript jsonl files that share $CODEX_HOME', () => {
    // `transcription-history.jsonl` is voice dictation and `plugins/cache/…`
    // holds vendored fixtures — one of which is even named `rollout-…jsonl`.
    // A `**/*.jsonl` glob would index all three as sessions; only
    // `sessions/` and `archived_sessions/` are walked.
    const paths = discover(home).map((s) => s.path);
    expect(paths.some((p) => p.includes('transcription-history'))).toBe(false);
    expect(paths.some((p) => p.includes('plugins'))).toBe(false);
    expect(paths.some((p) => p.endsWith('notes.txt'))).toBe(false);
  });

  it('returns nothing, and does not throw, when codex is not installed', () => {
    expect(discover({ codexHome: path.join(tempDir(), 'absent') })).toEqual([]);
  });

  it('honours CODEX_HOME', () => {
    const before = process.env['CODEX_HOME'];
    try {
      process.env['CODEX_HOME'] = FIXTURE;
      expect(codexDir()).toBe(FIXTURE);
      expect(codexPaths().sessionIndex).toBe(path.join(FIXTURE, 'session_index.jsonl'));
      expect(discover().length).toBe(3);
    } finally {
      if (before === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = before;
    }
  });

  it('takes the last uuid in the filename as the session id', () => {
    // The leading `2099-01-02T08-30-00` is local wall-clock and contains no
    // uuid; the trailing one is the session id.
    expect(sessionIdFromRolloutPath('/x/rollout-2099-01-02T08-30-00-d1d1d1d1-1111-4111-8111-111111111111.jsonl'))
      .toBe(IDS.full);
  });
});

// ---------------------------------------------------------------- the two streams

describe('codex parse() — one conversation, not two', () => {
  it('counts every turn once, from response_item only', async () => {
    const result = await parse(sourceFor(IDS.full), home);

    // The fixture holds, deliberately:
    //   3 × response_item/message role=user   (1 is injected context)
    //   2 × event_msg/user_message            (the human ones)
    //   2 × response_item/message role=assistant
    //   2 × event_msg/agent_message           (the same two turns)
    // Walking both streams would give 4 prompts and 4 assistant turns.
    expect(result.session.counts.userPrompts).toBe(2);
    expect(result.session.counts.assistantTurns).toBe(2);
    expect(result.exchanges).toHaveLength(2);
    expect(result.exchanges.map((e) => e.seq)).toEqual([1, 2]);
    expect(result.exchanges.map((e) => e.userText)).toEqual([
      'add a changelog entry for the widget pipeline',
      'now list the repo root',
    ]);
    expect(result.exchanges.map((e) => e.assistantText)).toEqual([
      'Added CHANGELOG.md with the widget pipeline entry.',
      'Two files: CHANGELOG.md and README.md.',
    ]);
  });

  it('drops injected user records that no event_msg vouches for', async () => {
    const result = await parse(sourceFor(IDS.full), home);
    const all = result.exchanges.map((e) => e.userText).join('\n');
    expect(all).not.toContain('<environment_context>');
    expect(all).not.toContain('<recommended_plugins>');
    expect(all).not.toContain('<permissions instructions>');
  });

  it('pairs tool calls to their outputs by call_id', async () => {
    const [first, second] = await parse(sourceFor(IDS.full), home).then((r) => r.exchanges);
    expect(first?.toolCalls).toHaveLength(1);
    expect(first?.toolCalls[0]?.name).toBe('exec');
    expect(first?.toolCalls[0]?.result).toContain('Success. Updated the following files');
    // The older `function_call` shape, whose `arguments` really is JSON.
    expect(second?.toolCalls[0]?.name).toBe('shell');
    expect(second?.toolCalls[0]?.result).toBe('CHANGELOG.md\nREADME.md\n');
    expect(await parse(sourceFor(IDS.full), home).then((r) => r.session.counts.toolCalls)).toBe(2);
  });
});

// ---------------------------------------------------------------- session record

describe('codex parse() — the SessionRecord', () => {
  it('fills 03 §2 from the header, the index and turn_context', async () => {
    const result = await parse(sourceFor(IDS.full), home);
    expect(result.session).toMatchObject({
      id: IDS.full,
      harness: 'codex',
      project: '/tmp/potsherd-codex-demo',
      projectSlug: 'potsherd-codex-demo',
      startedAt: '2099-01-02T03:00:00.100Z',
      endedAt: '2099-01-02T03:00:13.500Z',
      title: 'Changelog for the widget pipeline',
      entrypoint: 'desktop',
      model: 'synthetic-model-2',
      isSidechain: false,
      status: 'live',
    });
    expect(result.session.sourcePath).toBe(sourceFor(IDS.full).path);
    expect(result.session.counts.bytes).toBe(sourceFor(IDS.full).bytes);
    // Not in the JSONL at all — codex keeps it in state_5.sqlite.
    expect(result.session.gitBranch).toBeUndefined();
  });

  it('takes the title from session_index.jsonl, matched by id', async () => {
    const index = readSessionIndex(home);
    expect(index.get(IDS.full)?.threadName).toBe('Changelog for the widget pipeline');
    expect(index.get(IDS.binary)?.threadName).toBe('Render the deck pages');
    expect(index.get(IDS.archived)).toBeUndefined();

    const titled = await parse(sourceFor(IDS.binary), home);
    expect(titled.session.title).toBe('Render the deck pages');
    expect(titled.codex.titled).toBe(true);

    const untitled = await parse(sourceFor(IDS.archived), home);
    expect(untitled.session.title).toBeUndefined();
    expect(untitled.codex.titled).toBe(false);
    expect(untitled.session.status).toBe('archived');
  });

  it('skips malformed session_index lines and entries with no id', () => {
    // The fixture index has one unparseable line and one id-less entry.
    const index = readSessionIndex(home);
    expect(index.size).toBe(3);
    expect([...index.keys()]).toContain('d9d9d9d9-9999-4999-8999-999999999999');
  });

  it('normalises entrypoint into 03 §2 vocabulary', async () => {
    expect(codexEntrypoint({ originator: 'Codex Desktop', source: 'vscode' })).toBe('desktop');
    expect(codexEntrypoint({ originator: 'codex_cli', source: 'cli' })).toBe('cli');
    expect(codexEntrypoint({ source: 'vscode' })).toBe('vscode');
    expect(codexEntrypoint({ originator: 'Some New Surface' })).toBe('some-new-surface');
    expect(codexEntrypoint({})).toBeUndefined();
    expect(await parse(sourceFor(IDS.binary), home).then((r) => r.session.entrypoint)).toBe('cli');
  });

  it('reads only line 1 for the header, and reports an unreadable one', async () => {
    const header = await readCodexHeader(sourceFor(IDS.full).path);
    expect(header).toMatchObject({
      sessionId: IDS.full,
      cwd: '/tmp/potsherd-codex-demo',
      originator: 'Codex Desktop',
      source: 'vscode',
      cliVersion: '0.145.0-alpha.27',
    });

    const dir = tempDir();
    const odd = path.join(dir, 'rollout-2099-01-01T00-00-00-eeeeeeee-1111-4111-8111-111111111111.jsonl');
    fs.writeFileSync(odd, '{"timestamp":"2099-01-01T00:00:00.000Z","type":"response_item","payload":{}}\n');
    expect(await readCodexHeader(odd)).toBeUndefined();
    const result = await parse(
      { sessionId: 'eeeeeeee-1111-4111-8111-111111111111', harness: 'codex', path: odd, projectSlug: '', bytes: 1, mtimeMs: 1, isSidechain: false },
      home,
    );
    expect(result.codex.headerUnreadable).toBe(true);
    expect(result.session.id).toBe('eeeeeeee-1111-4111-8111-111111111111');
    rmrf(dir);
  });
});

// ---------------------------------------------------------------- unknown records

describe('codex parse() — unknown records are counted, never fatal', () => {
  it('counts unknown envelope types and malformed lines', async () => {
    const result = await parse(sourceFor(IDS.full), home);
    expect(result.unknownTypes).toEqual({ future_record: 2 });
    expect(result.malformedLines).toBe(1);
    // …and still produced both exchanges either side of the bad line.
    expect(result.exchanges).toHaveLength(2);
  });

  it('flags a cli_version below the supported floor without failing', async () => {
    const old = await parse(sourceFor(IDS.binary), home);
    expect(old.codex.cliVersion).toBe('0.120.0');
    expect(old.codex.versionSupported).toBe(false);
    expect(old.exchanges).toHaveLength(1);

    const current = await parse(sourceFor(IDS.full), home);
    expect(current.codex.versionSupported).toBe(true);
  });
});

// ---------------------------------------------------------------- binary payloads

describe('codex parse() — binary payloads', () => {
  it('elides base64 data URIs wherever they appear', async () => {
    const result = await parse(sourceFor(IDS.binary), home);
    const blob = JSON.stringify(result.exchanges);
    expect(blob).not.toContain('base64,iVBOR');
    expect(blob).toContain('‹elided:image/png:');
    // Two image parts in the text-less output plus one inline in a text part.
    expect(result.codex.elisions.binaryParts).toBe(3);
    expect(result.codex.elisions.charsElided).toBeGreaterThan(14_000);
  });

  it('keeps the exchange far smaller than the line it came from', async () => {
    const source = sourceFor(IDS.binary);
    const result = await parse(source, home);
    const biggest = Math.max(
      ...result.exchanges.flatMap((e) => [
        e.userText.length,
        e.assistantText.length,
        ...e.toolCalls.flatMap((t) => [t.input.length, t.result?.length ?? 0]),
      ]),
    );
    expect(biggest).toBeLessThan(source.bytes / 10);
  });

  it('truncates any value still over the cap and says how much it dropped', async () => {
    const result = await parse(sourceFor(IDS.full), home);
    expect(result.codex.elisions.truncatedValues).toBe(0);

    const tight = await parse(sourceFor(IDS.full), { ...home, maxValueBytes: 40, maxMessageBytes: 20 });
    expect(tight.codex.elisions.truncatedValues).toBeGreaterThan(0);
    const first = tight.exchanges[0];
    expect(first?.userText).toContain('‹elided:oversize:');
    expect(first?.toolCalls[0]?.input.startsWith('const patch = "*** Begin Patch')).toBe(true);
    expect(first?.toolCalls[0]?.input).toContain('‹elided:oversize:');
    expect(tight.codex.elisions.charsElided).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- js tool inputs

describe('codex tool inputs are JavaScript, not JSON', () => {
  it('keeps the source verbatim rather than mangling it', async () => {
    const result = await parse(sourceFor(IDS.full), home);
    const input = result.exchanges[0]?.toolCalls[0]?.input ?? '';
    expect(input).toContain('const patch = "*** Begin Patch');
    expect(input).toContain('await tools.apply_patch({patch})');
    expect(() => JSON.parse(input)).toThrow();
  });

  it('recovers filesTouched from the apply_patch envelope inside that source', async () => {
    const result = await parse(sourceFor(IDS.full), home);
    expect(result.exchanges[0]?.filesTouched).toEqual(['/tmp/potsherd-codex-demo/CHANGELOG.md']);
    // The older `function_call` shape still goes through the generic key walk.
    expect(result.exchanges[1]?.filesTouched).toEqual(['/tmp/potsherd-codex-demo/README.md']);
  });

  it('reads every apply_patch marker, escaped or literal newlines alike', () => {
    expect(filesFromCodexToolInput('const p = "*** Begin Patch\\n*** Add File: /tmp/a.py\\n+x";'))
      .toEqual(['/tmp/a.py']);
    expect(filesFromCodexToolInput('*** Update File: /tmp/b.py\n*** Delete File: /tmp/c.py\n'))
      .toEqual(['/tmp/b.py', '/tmp/c.py']);
    expect(filesFromCodexToolInput('*** Move to: /tmp/d.py\n')).toEqual(['/tmp/d.py']);
    expect(filesFromCodexToolInput('const r = await tools.exec_command({"cmd":"ls"});')).toEqual([]);
  });
});

// ---------------------------------------------------------------- incremental

describe('codex parse() — incremental resume', () => {
  it('resumes from a byte offset and keeps the id, which line 1 alone carries', async () => {
    const source = sourceFor(IDS.full);
    const full = await parse(source, home);
    expect(full.endOffset).toBe(source.bytes);

    const resumed = await parse(source, {
      ...home,
      fromOffset: full.endOffset,
      fromSeq: full.exchanges.length,
    });
    expect(resumed.exchanges).toEqual([]);
    // `session_meta` is out of range at this offset; the header read is what
    // stops the id degrading to a filename guess.
    expect(resumed.session.id).toBe(IDS.full);
    expect(resumed.session.title).toBe('Changelog for the widget pipeline');
  });

  it('never consumes a half-written trailing line', async () => {
    const dir = tempDir();
    const name = path.basename(sourceFor(IDS.full).path);
    const copy = path.join(dir, name);
    const whole = fs.readFileSync(sourceFor(IDS.full).path, 'utf8');
    fs.writeFileSync(copy, whole + '{"timestamp":"2099-01-02T03:00:20.000Z","type":"event_ms');
    const stat = fs.statSync(copy);
    const result = await parse(
      { sessionId: IDS.full, harness: 'codex', path: copy, projectSlug: '', bytes: stat.size, mtimeMs: stat.mtimeMs, isSidechain: false },
      home,
    );
    expect(result.endOffset).toBe(whole.length);
    expect(result.malformedLines).toBe(1); // the deliberate bad line, not the partial one
    rmrf(dir);
  });
});

// ---------------------------------------------------------------- doctor

describe('codex doctor', () => {
  it('reports what it found and the version it could not parse', async () => {
    const report = await codexDoctor(home);
    expect(report).toMatchObject({
      harness: 'codex',
      displayName: 'Codex CLI',
      present: true,
      sessions: 3,
      archived: 1,
      titled: 2,
      unsupportedVersions: ['0.120.0'],
      unreadable: [],
    });
    expect(report.versions).toEqual({ '0.145.0-alpha.27': 2, '0.120.0': 1 });

    const line = renderCodexDoctorLine(report);
    expect(line).toContain('3 sessions');
    expect(line).toContain('2 titled');
    expect(line).toContain('1 archived');
    expect(line).toContain('0.120.0 < 0.130.0, unsupported');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('says so when codex is not installed', async () => {
    const report = await codexDoctor({ codexHome: path.join(tempDir(), 'absent') });
    expect(report.present).toBe(false);
    expect(report.sessions).toBe(0);
    expect(renderCodexDoctorLine(report)).toContain('not installed');
  });
});

// ---------------------------------------------------------------- the adapter object

describe('codexAdapter', () => {
  it('satisfies the L0 contract', async () => {
    expect(codexAdapter.harness).toBe('codex');
    expect(codexAdapter.displayName).toBe('Codex CLI');
    expect(codexAdapter.sourceDir()).toBe(path.join(codexDir(), 'sessions'));
    const result = await codexAdapter.parse(sourceFor(IDS.full), home);
    expect(result.session.harness).toBe('codex');
    expect(result.exchanges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- fixture hygiene

describe('the codex fixtures', () => {
  it('contain no real path, prompt or session id', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(FIXTURE);
    expect(files.length).toBeGreaterThan(4);

    const realHome = os.homedir();
    const realSessionId = '01900000-0000-7000-8000-000000000001'; // the one rollout on this machine
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toContain(realHome);
      expect(text, file).not.toContain(realSessionId);
      expect(text, file).not.toContain('/Users/');
      expect(text, file).not.toContain('sk-');
      expect(text, file).not.toContain('gAAAAAB');
    }
  });
});

// ---------------------------------------------------------------- the real machine

const REAL = codexPaths(codexDir());
const hasReal = fs.existsSync(REAL.sessions) && discover().length > 0;

describe.skipIf(!hasReal)('codex on this machine', () => {
  it('discovers the real rollouts under $CODEX_HOME', () => {
    const sources = discover();
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.harness).toBe('codex');
      expect(source.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(fs.existsSync(source.path)).toBe(true);
    }
  });

  it('parses each one into a SessionRecord + Exchange[] with no double counting', async () => {
    for (const source of discover()) {
      const result = await parse(source);
      expect(result.session.id).toBe(source.sessionId);
      expect(result.session.harness).toBe('codex');
      expect(result.session.startedAt).not.toBe('');
      expect(result.session.counts.bytes).toBe(source.bytes);
      expect(result.endOffset).toBe(source.bytes);

      // Every exchange starts from one `event_msg/user_message`, so the prompt
      // count can never exceed the number of those markers in the file.
      const markers = countUserMessages(source.path);
      expect(result.session.counts.userPrompts).toBe(result.exchanges.length);
      expect(result.session.counts.userPrompts).toBeLessThanOrEqual(markers);

      // Trap 3: whatever the line sizes on disk, nothing huge and nothing
      // binary reaches an Exchange.
      for (const exchange of result.exchanges) {
        for (const value of [
          exchange.userText,
          exchange.assistantText,
          ...exchange.toolCalls.flatMap((t) => [t.input, t.result ?? '']),
        ]) {
          expect(value.length).toBeLessThanOrEqual(256 * 1024 + 64);
          expect(value).not.toContain(';base64,');
        }
      }
    }
  });

  it('renders a doctor line for the real directory', async () => {
    const line = renderCodexDoctorLine(await codexDoctor());
    expect(line.startsWith('codex')).toBe(true);
    expect(line).not.toContain(os.homedir());
  });
});

/** Counts `event_msg/user_message` records without loading the file at once. */
function countUserMessages(file: string): number {
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"user_message"')) continue;
    try {
      const record = JSON.parse(line) as { type?: string; payload?: { type?: string } };
      if (record.type === 'event_msg' && record.payload?.type === 'user_message') n += 1;
    } catch {
      /* malformed lines are counted, not fatal */
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// MEASURED AGAINST A REAL codex-cli 0.149.0 (T10.12, 2026-08-24)
//
// Phases 5–9 said codex "is not installed here and cannot be". That was never
// checked: `@openai/codex@0.149.0` installs from npm in 39s. It was installed,
// pointed at a scratch `CODEX_HOME`, and asked one question. The rollout it
// wrote does not have the shape this adapter's header describes, and the two
// records below are hand-written from scratch to the SHAPE that was observed —
// no real ids, paths or prose (`00-README.md`).
//
// TWO FINDINGS, both reported in `phases/phase-10/T10.12-LABELS.md` and
// DELIBERATELY NOT FIXED HERE (one real session is a sample of one; shaping
// the parser to it could break the documented 2026-07 format, which still
// parses correctly — 1 session, 2 exchanges, 12 tool calls, re-measured).
//
//   F1. `event_msg/user_message` NO LONGER EXISTS. 0.149.0 emits
//       `event_msg/item_completed` carrying `item.type:"UserMessage"` instead.
//       `collectHumanPrompts` therefore returns an empty set, the
//       `humanPrompts.size > 0` guard in `parser/codex.ts` never engages, and
//       EVERY `response_item/message` with `role:"user"` starts an exchange —
//       including the injected `<environment_context>` block, which then
//       becomes the session title and puts the user's cwd in `potsherd ls`.
//       This is the "no event_msg at all" degrade firing on a rollout that has
//       three of them; the guard tests for the wrong thing.
//
//   F2. `session_index.jsonl` is gone — the header calls it "the ONLY title
//       source". 0.149.0 keeps titles in `$CODEX_HOME/state_5.sqlite`,
//       `threads(id, title, first_user_message, preview, rollout_path, cwd,
//       git_branch, model, cli_version, …)`. `first_user_message` alone would
//       resolve F1 exactly.
//
// The assertions below therefore record what the adapter DOES today. When
// either finding is fixed these fail, and that is the point: they are the
// tripwire, not the endorsement.
describe('codex adapter — a real codex-cli 0.149.0 rollout (T10.12)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmrf(d);
  });

  /** Hand-written to the observed shape. Id has 2 distinct hex digits in its first eight. */
  const SESSION = '0a0a0a0a-0a0a-7a0a-8a0a-0a0a0a0a0a0a';
  const TURN = '0a0a0a0a-0a0a-7a0a-8a0a-0a0a0a0a0a0b';

  function writeRollout(): SessionSource {
    const root = tempDir('codex-149');
    dirs.push(root);
    const day = path.join(root, 'sessions', '2026', '08', '24');
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, `rollout-2026-08-24T00-00-00-${SESSION}.jsonl`);
    const at = '2026-08-24T00:00:00.000Z';
    const lines = [
      // ordinal is new at 0.149.0 and sits on the envelope, not the payload.
      { timestamp: at, ordinal: 0, type: 'session_meta', payload: { session_id: SESSION, id: SESSION, timestamp: at, cwd: '/w/scratch', originator: 'codex_exec', cli_version: '0.149.0', source: 'exec' } },
      { timestamp: at, ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: TURN, model_context_window: 258400 } },
      // role:"developer" is new too, and is dropped (correctly) as injection.
      { timestamp: at, ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'msg_a', role: 'developer', content: [{ type: 'input_text', text: 'system preamble' }] } },
      // the injected block. NOT typed by the user.
      { timestamp: at, ordinal: 3, type: 'response_item', payload: { type: 'message', id: 'msg_b', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/w/scratch</cwd>\n  <shell>zsh</shell>\n</environment_context>' }] } },
      { timestamp: at, ordinal: 4, type: 'turn_context', payload: { turn_id: TURN, cwd: '/w/scratch', model: 'a-model' } },
      // the one thing the human typed.
      { timestamp: at, ordinal: 5, type: 'response_item', payload: { type: 'message', id: 'msg_c', role: 'user', content: [{ type: 'input_text', text: 'say hello' }] } },
      // 0.149.0's replacement for event_msg/user_message.
      { timestamp: at, ordinal: 6, type: 'event_msg', payload: { type: 'item_completed', thread_id: SESSION, turn_id: TURN, item: { type: 'UserMessage', id: 'it_a', content: [{ type: 'text', text: 'say hello' }] } } },
      { timestamp: at, ordinal: 7, type: 'event_msg', payload: { type: 'task_complete', turn_id: TURN, last_agent_message: null } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n';
    fs.writeFileSync(file, lines);
    const found = discover({ codexHome: root }).find((s) => s.sessionId === SESSION);
    if (!found) throw new Error('0.149.0 rollout not discovered');
    return found;
  }

  it('is still discovered — the sessions/YYYY/MM/DD/rollout-*.jsonl layout did not change', () => {
    const src = writeRollout();
    expect(src.harness).toBe('codex');
    expect(path.basename(src.path)).toMatch(/^rollout-.*\.jsonl$/);
  });

  it('reads session_meta as before: id, cwd, entrypoint, model', async () => {
    const r = await parse(writeRollout());
    expect(r.session.id).toBe(SESSION);
    expect(r.session.project).toBe('/w/scratch');
    expect(r.session.model).toBe('a-model');
  });

  it('FINDING F1 — counts the injected <environment_context> as a human prompt', async () => {
    const r = await parse(writeRollout());
    // What it SHOULD be is 1. It is 2 because `event_msg/user_message` is gone
    // and the guard that depends on it silently disengages.
    expect(r.session.counts.userPrompts, 'see T10.12-LABELS.md — codex F1').toBe(2);
    expect(r.exchanges[0]?.userText).toContain('<environment_context>');
    expect(r.exchanges[1]?.userText).toBe('say hello');
  });

  it('FINDING F1 — the ground truth IS in the file, under a shape the parser does not read', async () => {
    const src = writeRollout();
    const raw = fs.readFileSync(src.path, 'utf8');
    // The parser looks for payload.type === 'user_message'. There is none.
    expect(raw).not.toContain('"user_message"');
    // What is there instead, and what a fix should read:
    expect(raw).toContain('"item_completed"');
    expect(raw).toContain('"UserMessage"');
  });

  it('FINDING F2 — 0.149.0 writes no session_index.jsonl, so nothing is titled', async () => {
    const src = writeRollout();
    const root = path.resolve(path.dirname(src.path), '..', '..', '..', '..');
    expect(fs.existsSync(path.join(root, 'session_index.jsonl'))).toBe(false);
    const r = await parse(src);
    expect(r.session.title).toBeUndefined();
  });
});
