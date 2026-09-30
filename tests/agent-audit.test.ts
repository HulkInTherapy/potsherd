import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db as store, recall, backfillLegacy, backfillLegacyGhosts, defaultBudget, countTransportTokens, type Db } from '@potsherd/core';
import { coveredTerms } from '../packages/core/src/calibration.js';
import { cardMarkdown, cardPath } from '../packages/core/src/cards/write.js';
import { findMcpEntry } from '../packages/core/src/setup.js';
import { makeContext } from '../packages/mcp/src/context.js';
import { connectInMemory, call } from '../packages/mcp/src/testing.js';
import { tempDir, rmrf } from './helpers.js';

let root: string;
let db: Db;
const id = 'abababab-1111-4111-8111-111111111111';
const ghost = 'cdcdcdcd-2222-4222-8222-222222222222';
const child = `${id}:agent-efefefef12345678`;

beforeAll(() => {
  root = tempDir('potsherd-agent-audit-');
  db = store.open({ root });
  db.prepare('INSERT INTO sessions (id, harness, project, title) VALUES (?, ?, ?, ?)')
    .run(id, 'claude', '/tmp/audit-project', 'release_stamp');
  db.prepare('INSERT INTO exchanges (id, session_id, seq, user_text, assistant_text) VALUES (?, ?, ?, ?, ?)')
    .run('literal-e1', id, 1, 'Compare v1.2.1 with v1 2 1.', 'The C7-2 issue contains the exact phrase: no such module: vec0.');
  db.prepare('INSERT INTO ghosts (session_id, project, first_prompt) VALUES (?, ?, ?)')
    .run(ghost, '/tmp/audit-ghost', 'Why did C7-2 happen?');
  db.prepare('INSERT INTO ghost_prompts (id, session_id, seq, text) VALUES (?, ?, ?, ?)')
    .run('literal-g1', ghost, 1, 'Why did C7-2 happen?');
  db.prepare('INSERT INTO sessions (id, harness, project, parent_session_id, is_sidechain) VALUES (?, ?, ?, ?, 1)')
    .run(child, 'claude', '/tmp/audit-project', id);
  db.prepare('INSERT INTO exchanges (id, session_id, seq, user_text, assistant_text, is_sidechain) VALUES (?, ?, 1, ?, ?, 1)')
    .run('literal-child', child, 'A long investigation.', 'ordinary filler '.repeat(3000) + 'The resolution was cobalt-needle.');
  db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild'); INSERT INTO ghost_prompts_fts(ghost_prompts_fts) VALUES('rebuild'); INSERT INTO ghosts_fts(ghosts_fts) VALUES('rebuild');");
  backfillLegacy(db,{limit:Number.MAX_SAFE_INTEGER});backfillLegacyGhosts(db,Number.MAX_SAFE_INTEGER);
});
afterAll(() => { db.close(); rmrf(root); });

describe('literal retrieval through the agent and CLI doors', () => {
  it('preserves punctuation and refuses scattered token matches', async () => {
    const yes = await recall(db, 'v1.2.1', {}, { exact: true, minConfidence: 'weak' });
    expect(yes.sessions.map((s) => s.id)).toEqual([id]);
    expect(yes.confidence).toBe('strong');
    expect(yes.vectors.used).toBe(false);
    const no = await recall(db, 'v1/2/1', {}, { exact: true, minConfidence: 'weak' });
    expect(no.sessions).toEqual([]);
    expect(no.relaxed).toBe(false);
  });

  it('returns ghost prompts with their original provenance and applies filters', async () => {
    const r = await recall(db, 'C7-2', { ghosts: 'only' }, { exact: true });
    expect(r.sessions.map((s) => s.id)).toEqual([ghost]);
    expect(r.sessions[0]?.kind).toBe('ghost');
    expect(r.hits[0]?.userText).toBe('Why did C7-2 happen?');
    const other = await recall(db, 'C7-2', { project: '/tmp/missing' }, { exact: true });
    expect(other.sessions).toEqual([]);
  });

  it('does not turn a title or card into literal transcript evidence', async () => {
    const r = await recall(db, 'release_stamp', {}, { exact: true });
    expect(r.sessions).toEqual([]);
    const ranked = await recall(db, 'release_stamp', {}, { vectors: false });
    expect(ranked.lists.find((l) => l.list === 'titles')?.candidates).toBe(1);
  });

  it('forwards exact from a real MCP client to the search engine', async () => {
    const h = await connectInMemory(makeContext({ potsherdDir: root, cwd: root }));
    try {
      const r = await call(h.client, 'potsherd_recall', { query: 'no such module: vec0', mode:'literal', want: 'context' });
      expect(r.contractVersion).toBe(2);
      expect((r.evidence as {text:string;role:string;provenance:{nativeSessionId:string}}[]).map(item=>item.provenance.nativeSessionId)).toEqual([id]);
      expect((r.evidence as {text:string}[])[0]!.text).toContain('no such module: vec0');
      expect((r.coverage as {semantic:string}).semantic).toBe('disabled');
      const none = await call(h.client, 'potsherd_recall', { query: 'v1/2/1', mode:'literal' });
      expect(none.evidence).toEqual([]);
      expect((none.support as {state:string}).state).toBe('insufficient');
    } finally { await h.close(); }
  });

  it('forwards --exact from the built CLI', () => {
    const result = JSON.parse(execFileSync(process.execPath, [path.resolve('packages/cli/bin/potsherd.js'), '--potsherd-dir', root, 'find', 'C7-2', '--exact', '--json'], { encoding: 'utf8' }));
    expect(result.contractVersion).toBe(2);
    expect(new Set(result.evidence.map((item:{provenance:{nativeSessionId:string}})=>item.provenance.nativeSessionId))).toEqual(new Set([id,ghost]));
    expect(result.evidence.some((item:{role:string})=>item.role==='ghost_prompt')).toBe(true);
    expect(result.coverage.semantic).toBe('disabled');
  });

  it('returns the matching part of a long exchange and a resolvable subagent id', async () => {
    const h = await connectInMemory(makeContext({ potsherdDir: root, cwd: root }));
    try {
      const r = await call(h.client, 'potsherd_recall', { query:'cobalt-needle',mode:'literal',budget:defaultBudget(2000) });
      const evidence = r.evidence as {ref:unknown;text:string;startUtf16:number;provenance:{nativeSessionId:string}}[];
      expect(evidence[0]?.provenance.nativeSessionId).toBe(child);
      expect(evidence[0]?.text).toContain('cobalt-needle');
      expect(evidence[0]?.startUtf16).toBeGreaterThan(0);
      expect((r.budget as {usedTokens:number}).usedTokens).toBeLessThanOrEqual(2000);
      const read=await call(h.client,'potsherd_read',{refs:[evidence[0]!.ref],budget:defaultBudget(2000)});
      expect((read.evidence as {provenance:{nativeSessionId:string}}[])[0]?.provenance.nativeSessionId).toBe(child);
      const tiny=await call(h.client,'potsherd_recall',{query:'cobalt-needle',mode:'literal',budget:defaultBudget(200)});
      expect(countTransportTokens(JSON.stringify({content:[{type:'text',text:JSON.stringify(tiny)}]}))).toBeLessThanOrEqual(200);
      expect((tiny.evidence as unknown[]|undefined)??[]).toEqual([]);
    } finally { await h.close(); }
  });
});

describe('long evidence and plugin setup', () => {
  it('confines card filenames from untrusted session ids to the card directory', () => {
    const folder = path.join(root, 'cards', 'claude', 'fixture');
    const escaped = cardPath(root, 'claude', 'fixture', '../../outside');
    expect(path.dirname(escaped)).toBe(folder);
    expect(escaped).not.toBe(cardPath(root, 'claude', 'fixture', '..%2F..%2Foutside'));
    expect(path.dirname(cardPath(root, 'claude', 'fixture', '..\\outside'))).toBe(folder);
  });
  it('points a subagent card back at the subagent transcript', () => {
    const markdown = cardMarkdown({ sessionId: child, harness: 'claude', projectSlug: 'audit-project',
      project: '/tmp/audit-project', card: { title: 'Fixture', summary: '', topics: [],
        decisions: [], files: [], outcome: 'unknown', open_threads: [], tags: [] },
      verified: { kept: 0, dropped: 0 }, model: 'fixture', costUsd: 0,
      createdAt: '2026-01-01', source: 'transcript' });
    expect(markdown).toContain('potsherd show efefefef');
    expect(markdown).not.toContain('potsherd show abababab');
  });
  it('does not discard a matching term after the old 20,000-word ceiling', () => {
    expect(coveredTerms(['needle'], 'filler '.repeat(20_100) + 'needle')).toBe(1);
  });

  it('keeps prefix, duplicate-term and Unicode coverage semantics', () => {
    expect(coveredTerms(['pool', 'pool', 'indexes', 'café'], 'pooling index café')).toBe(4);
    expect(coveredTerms(['cat'], 'catastrophe')).toBe(0);
  });

  it('locates the MCP server bundled beside a marketplace CLI', () => {
    const dir = path.join(root, 'plugin', 'dist');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'potsherd.js'), '// cli');
    fs.writeFileSync(path.join(dir, 'mcp.js'), '// server');
    expect(findMcpEntry(path.join(dir, 'potsherd.js'))).toEqual({ file: path.join(dir, 'mcp.js'), exists: true });
  });
});
