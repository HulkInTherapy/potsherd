import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parser } from '@potsherd/core';
import { FIXTURE_CLAUDE, IDS, rmrf, tempDir } from './helpers.js';

const {
  parseClaudeTranscript,
  parseCodexTranscript,
  parseTranscript,
  detectHarness,
  readJsonlLines,
  filesFromToolInput,
  stringifyToolOutput,
  exchangeId,
} = parser;

const P = path.join(FIXTURE_CLAUDE, 'projects');
const ALIVE = path.join(P, '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
const SDK = path.join(P, '-tmp-potsherd-beta', `${IDS.sdk}.jsonl`);
const SIDECHAIN_NESTED = path.join(P, '-tmp-potsherd-alpha', IDS.alive, 'subagents', 'agent-01.jsonl');
const SIDECHAIN_FLAT = path.join(P, '-tmp-potsherd-beta', 'subagents', 'agent-02.jsonl');

describe('jsonl reader', () => {
  it('reports the exact byte range of every line', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"b":"é"}\n');
    const lines = [];
    for await (const l of readJsonlLines(file)) lines.push(l);
    const size = fs.statSync(file).size;
    rmrf(dir);

    expect(lines.map((l) => [l.lineNumber, l.start, l.end, l.terminated])).toEqual([
      [1, 0, 8, true],
      // "é" is two bytes: the offset must be counted in bytes, not characters.
      [2, 8, 19, true],
    ]);
    // The last line's end is the file size — that is what makes it usable as
    // `sessions.source_offset`.
    expect(lines[1]!.end).toBe(size);
  });

  it('marks a half-written trailing line so an index run never consumes it', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'b.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"b":2'); // still being appended to
    const lines = [];
    for await (const l of readJsonlLines(file)) lines.push(l);
    rmrf(dir);

    expect(lines.map((l) => l.terminated)).toEqual([true, false]);
  });

  it('resumes from a byte offset', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'c.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');
    const lines = [];
    for await (const l of readJsonlLines(file, { start: 8, startLine: 1 })) lines.push(l);
    rmrf(dir);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.lineNumber).toBe(2);
    expect(lines[0]!.text).toBe('{"b":2}');
  });
});

describe('claude parser', () => {
  it('produces one exchange per human prompt, not one per user record', async () => {
    const r = await parseClaudeTranscript(ALIVE);
    // The transcript holds three `type:user` records; the middle one carries a
    // tool_result, not a prompt. Upstream would emit three exchanges.
    expect(r.exchanges).toHaveLength(2);
    expect(r.exchanges.map((e) => e.userText)).toEqual([
      'how do we pin the pgbouncer prepared-statement setting?',
      'ship it',
    ]);
    expect(r.exchanges.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('pairs a tool_result back to the tool_use that asked for it', async () => {
    const r = await parseClaudeTranscript(ALIVE);
    const first = r.exchanges[0]!;
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]!.name).toBe('Edit');
    // Upstream leaves a `TODO: Match tool_use_id to previous tool_use` here and
    // drops every result on the floor.
    expect(first.toolCalls[0]!.result).toBe('ok');
    expect(first.filesTouched).toEqual(['/tmp/potsherd-alpha/db/pool.ts']);
  });

  it('takes the last ai-title, not the first', async () => {
    const r = await parseClaudeTranscript(ALIVE);
    expect(r.session.title).toBe('Pin pgbouncer prepared-statement handling');
  });

  it('fills the session record from the transcript itself', async () => {
    const { session } = await parseClaudeTranscript(ALIVE);
    expect(session.id).toBe(IDS.alive);
    expect(session.harness).toBe('claude');
    expect(session.project).toBe('/tmp/potsherd-alpha');
    expect(session.projectSlug).toBe('-tmp-potsherd-alpha');
    expect(session.gitBranch).toBe('main');
    expect(session.entrypoint).toBe('cli');
    expect(session.startedAt).toBe('2026-08-01T09:00:00.000Z');
    expect(session.endedAt).toBe('2026-08-01T09:04:30.000Z');
    expect(session.counts).toEqual({ userPrompts: 2, assistantTurns: 2, toolCalls: 1, bytes: session.counts.bytes });
    expect(session.status).toBe('live');
  });

  it('gives an sdk session no title rather than inventing one', async () => {
    const { session } = await parseClaudeTranscript(SDK);
    expect(session.entrypoint).toBe('sdk-ts');
    expect(session.title).toBeUndefined();
  });

  it.each([
    ['nested under the session dir', SIDECHAIN_NESTED, IDS.alive, 'db-reviewer', '-tmp-potsherd-alpha'],
    ['flat under the project dir', SIDECHAIN_FLAT, IDS.sdk, 'changelog-reader', '-tmp-potsherd-beta'],
  ])('indexes the sidechain %s as its own session', async (_name, file, parent, agent, slug) => {
    const { session, exchanges } = await parseClaudeTranscript(file);
    expect(session.isSidechain).toBe(true);
    // A subagent transcript's `sessionId` field holds the PARENT's id.
    expect(session.parentSessionId).toBe(parent);
    expect(session.id).not.toBe(parent);
    expect(session.id.startsWith(`${parent}:`)).toBe(true);
    expect(session.agentName).toBe(agent);
    expect(session.projectSlug).toBe(slug);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.isSidechain).toBe(true);
  });

  it('counts unknown record types instead of failing on them', async () => {
    const r = await parseClaudeTranscript(ALIVE);
    expect(r.malformedLines).toBe(0);
    // Every type the parser does not read is reported so `doctor` can show it.
    expect(Object.keys(r.unknownTypes).sort()).toEqual([
      'atis-latch',
      'file-history-snapshot',
      'last-prompt',
      'mode',
      'permission-mode',
      'queue-operation',
    ]);
  });

  it('counts a malformed line and keeps going', async () => {
    const dir = tempDir();
    const file = path.join(dir, `${IDS.alive}.jsonl`);
    fs.writeFileSync(
      file,
      [
        'not json at all',
        JSON.stringify({ type: 'user', sessionId: 's1', promptId: 'p1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
      ].join('\n') + '\n',
    );
    const r = await parseClaudeTranscript(file);
    rmrf(dir);

    expect(r.malformedLines).toBe(1);
    expect(r.exchanges).toHaveLength(1);
    expect(r.exchanges[0]!.assistantText).toBe('hello');
  });

  it('resumes from endOffset without re-emitting or renumbering', async () => {
    const dir = tempDir();
    const file = path.join(dir, `${IDS.alive}.jsonl`);
    const head = fs.readFileSync(ALIVE, 'utf8').split('\n').slice(0, 7).join('\n') + '\n';
    fs.writeFileSync(file, head);

    const first = await parseClaudeTranscript(file);
    expect(first.exchanges).toHaveLength(1);

    fs.writeFileSync(file, fs.readFileSync(ALIVE, 'utf8'));
    const second = await parseClaudeTranscript(file, {
      fromOffset: first.endOffset,
      fromSeq: first.exchanges.at(-1)!.seq,
    });
    rmrf(dir);

    expect(second.exchanges.map((e) => e.seq)).toEqual([2]);
    expect(second.exchanges[0]!.userText).toBe('ship it');
    // Ids are a function of (session, seq), so a resumed run agrees with a
    // full one — the store can upsert either way round.
    expect(second.exchanges[0]!.id).toBe(exchangeId(IDS.alive, 2));
  });

  it('leaves redaction to L2', async () => {
    const r = await parseClaudeTranscript(ALIVE);
    expect(r.exchanges.every((e) => e.redacted === false)).toBe(true);
  });
});

/**
 * A minimal codex rollout. Both of the parallel views a real rollout carries
 * are present — `event_msg` and `response_item` — because building exchanges
 * from both is exactly the mistake this parser has to not make.
 */
function writeCodexRollout(dir: string): string {
  const file = path.join(dir, 'rollout-2026-07-21T19-35-33-019f84ff-05f6-7ad0-8ba3-4064f23a1fb5.jsonl');
  const t = (s: number) => `2026-07-21T14:0${s}:00.000Z`;
  const lines = [
    { timestamp: t(0), type: 'session_meta', payload: { session_id: '019f84ff-05f6-7ad0-8ba3-4064f23a1fb5', cwd: '/tmp/potsherd-codex', cli_version: '0.145.0', originator: 'Codex Desktop' } },
    { timestamp: t(1), type: 'turn_context', payload: { cwd: '/tmp/potsherd-codex', model: 'gpt-5-codex' } },
    { timestamp: t(2), type: 'event_msg', payload: { type: 'user_message', message: 'add a retry to the uploader' } },
    { timestamp: t(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp/potsherd-codex</environment_context>' }] } },
    { timestamp: t(3), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a retry to the uploader' }] } },
    { timestamp: t(4), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: { file_path: '/tmp/potsherd-codex/upload.ts' } } },
    { timestamp: t(5), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'patched' }] } },
    { timestamp: t(6), type: 'event_msg', payload: { type: 'agent_message', message: 'Added a three-attempt retry.' } },
    { timestamp: t(7), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added a three-attempt retry.' }] } },
    { timestamp: t(8), type: 'event_msg', payload: { type: 'token_count', info: null } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('codex parser', () => {
  it('builds exchanges from response_item only, so the two views do not double-count', async () => {
    const dir = tempDir();
    const r = await parseCodexTranscript(writeCodexRollout(dir));
    rmrf(dir);

    expect(r.exchanges).toHaveLength(1);
    expect(r.exchanges[0]!.userText).toBe('add a retry to the uploader');
    expect(r.exchanges[0]!.assistantText).toBe('Added a three-attempt retry.');
  });

  it('drops injected environment context that the human never typed', async () => {
    const dir = tempDir();
    const r = await parseCodexTranscript(writeCodexRollout(dir));
    rmrf(dir);
    // event_msg/user_message is the ground truth for "the human typed this".
    expect(r.exchanges.some((e) => e.userText.includes('environment_context'))).toBe(false);
    expect(r.session.counts.userPrompts).toBe(1);
  });

  it('pairs a tool output to its call by call_id', async () => {
    const dir = tempDir();
    const r = await parseCodexTranscript(writeCodexRollout(dir));
    rmrf(dir);

    expect(r.exchanges[0]!.toolCalls).toEqual([
      { name: 'apply_patch', input: '{"file_path":"/tmp/potsherd-codex/upload.ts"}', result: 'patched' },
    ]);
    expect(r.exchanges[0]!.filesTouched).toEqual(['/tmp/potsherd-codex/upload.ts']);
  });

  it('reads session metadata and accepts a title from outside the rollout', async () => {
    const dir = tempDir();
    const { session } = await parseCodexTranscript(writeCodexRollout(dir), {
      title: 'uploader retries',
    });
    rmrf(dir);

    expect(session.id).toBe('019f84ff-05f6-7ad0-8ba3-4064f23a1fb5');
    expect(session.harness).toBe('codex');
    expect(session.project).toBe('/tmp/potsherd-codex');
    expect(session.model).toBe('gpt-5-codex');
    expect(session.entrypoint).toBe('Codex Desktop');
    // A rollout carries no title; it comes from session_index.jsonl.
    expect(session.title).toBe('uploader retries');
    expect(session.isSidechain).toBe(false);
  });
});

describe('harness detection', () => {
  it('recognises claude and codex, and refuses to guess', async () => {
    const dir = tempDir();
    const codex = writeCodexRollout(dir);
    const cursor = path.join(dir, 'cursor.jsonl');
    fs.writeFileSync(cursor, JSON.stringify({ role: 'user', text: 'hi' }) + '\n');
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');

    expect(await detectHarness(ALIVE)).toBe('claude');
    expect(await detectHarness(codex)).toBe('codex');
    // Upstream returns 'claude' for anything unrecognised, which silently feeds
    // a cursor transcript to the claude parser.
    expect(await detectHarness(cursor)).toBe('cursor');
    expect(await detectHarness(empty)).toBeNull();

    expect(await parseTranscript(empty)).toBeNull();
    expect((await parseTranscript(codex))!.session.harness).toBe('codex');
    rmrf(dir);
  });
});

describe('content helpers', () => {
  it('finds files in flat and nested tool inputs', () => {
    expect(filesFromToolInput({ file_path: '/a' })).toEqual(['/a']);
    expect(filesFromToolInput({ notebook_path: '/n.ipynb' })).toEqual(['/n.ipynb']);
    expect(filesFromToolInput({ edits: [{ file_path: '/b' }, { file_path: '/c' }] })).toEqual(['/b', '/c']);
    expect(filesFromToolInput('not an object')).toEqual([]);
  });

  it('stringifies a tool output whatever shape it arrives in', () => {
    expect(stringifyToolOutput('done')).toBe('done');
    expect(stringifyToolOutput([{ type: 'input_text', text: 'done' }])).toBe('done');
    expect(stringifyToolOutput({ exit: 0 })).toBe('{"exit":0}');
    expect(stringifyToolOutput(undefined)).toBeUndefined();
  });
});
