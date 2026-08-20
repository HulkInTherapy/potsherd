import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HARNESSES, isAdapter, type Exchange, type SessionRecord, type SessionSource } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = path.join(repo, 'packages', 'core', 'src', 'adapters', 'types.ts');

/**
 * `adapters/types.ts` is the interface the four adapter authors (T1.2, T1.3)
 * code against. These tests are less about behaviour than about pinning the
 * contract: a field silently renamed here breaks four workers at once, so the
 * field list is asserted literally against `plans/03-ARCHITECTURE.md` §2.
 */
describe('adapter contract', () => {
  it('compiles standalone, under the strictest settings, importing nothing', () => {
    // It must be liftable into any other project (and into a worker's editor)
    // without dragging the rest of core behind it.
    expect(fs.readFileSync(TYPES, 'utf8')).not.toMatch(/^\s*import\s/m);

    const dir = tempDir();
    const copy = path.join(dir, 'types.ts');
    fs.copyFileSync(TYPES, copy);
    const tsc = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
    expect(() =>
      execFileSync(process.execPath, [
        tsc,
        '--noEmit',
        '--strict',
        '--noUncheckedIndexedAccess',
        '--target', 'ES2023',
        '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext',
        copy,
      ], { stdio: 'pipe' }),
    ).not.toThrow();
    rmrf(dir);
  });

  it('has exactly the SessionRecord fields of 03 §2', () => {
    const session: SessionRecord = {
      id: 's', harness: 'claude', sourcePath: '/t.jsonl', project: '/p', projectSlug: '-p',
      startedAt: '', endedAt: '', title: 't', gitBranch: 'main', entrypoint: 'cli', model: 'm',
      isSidechain: false, parentSessionId: 'p', agentName: 'a',
      counts: { userPrompts: 0, assistantTurns: 0, toolCalls: 0, bytes: 0 },
      status: 'live',
    };
    expect(Object.keys(session)).toEqual([
      'id', 'harness', 'sourcePath', 'project', 'projectSlug', 'startedAt', 'endedAt',
      'title', 'gitBranch', 'entrypoint', 'model', 'isSidechain', 'parentSessionId',
      'agentName', 'counts', 'status',
    ]);
    expect(Object.keys(session.counts)).toEqual(['userPrompts', 'assistantTurns', 'toolCalls', 'bytes']);
  });

  it('has exactly the Exchange fields of 03 §2', () => {
    const exchange: Exchange = {
      id: 'e', sessionId: 's', seq: 1, ts: '', userText: '', assistantText: '',
      toolCalls: [{ name: 'Edit', input: '{}', result: 'ok', isError: false }],
      filesTouched: [], isSidechain: false, parentUuid: 'u', redacted: false,
    };
    expect(Object.keys(exchange)).toEqual([
      'id', 'sessionId', 'seq', 'ts', 'userText', 'assistantText', 'toolCalls',
      'filesTouched', 'isSidechain', 'parentUuid', 'redacted',
    ]);
    expect(Object.keys(exchange.toolCalls[0]!)).toEqual(['name', 'input', 'result', 'isError']);
  });

  it('names every harness 03 §2 lists, in doctor order', () => {
    expect(HARNESSES).toEqual(['claude', 'codex', 'cursor', 'pi', 'gemini', 'opencode', 'copilot']);
  });

  it('lets doctor tell a real adapter from a not-yet-supported stub', () => {
    const stub = {
      harness: 'gemini' as const,
      displayName: 'Gemini CLI',
      sourceDir: () => '/home/dev/.gemini',
      supported: false as const,
      reason: 'transcript format not characterised yet',
    };
    expect(isAdapter(stub)).toBe(false);
  });

  it('carries everything an incremental index needs on SessionSource', () => {
    const source: SessionSource = {
      sessionId: 's', harness: 'claude', path: '/t.jsonl', projectSlug: '-p',
      bytes: 10, mtimeMs: 1, isSidechain: true, parentSessionId: 'p', status: 'live',
    };
    // `03` §3 indexes by (source_mtime, source_offset); both halves of the
    // change test have to survive discovery without a parse.
    expect(source.bytes).toBe(10);
    expect(source.mtimeMs).toBe(1);
  });
});
