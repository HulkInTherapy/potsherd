import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store, indexAll, defaultBudget, LocalMemoryService, publishSource } from '@potsherd/core';
import { parseClaudeTranscript } from '../packages/core/src/parser/claude.js';
import { parseCodexTranscript } from '../packages/core/src/parser/codex.js';
import { tempDir, rmrf } from './helpers.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(rmrf));
const bin = path.resolve('packages/cli/bin/potsherd.js');
function fixture() {
  const root = tempDir('memory-legacy-'); roots.push(root);
  const claudeDir = path.join(root, 'claude');
  const file = path.join(claudeDir, 'projects', '-tmp-compat', 'compat-native.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { sessionId: 'compat-native', cwd: '/tmp/compat', gitBranch: 'main', timestamp: '2026-01-01T00:00:00Z' };
  const rows = [
    { ...base, type: 'assistant', uuid: 'orphan', message: { role: 'assistant', content: 'orphan-before-human' } },
    ...[1, 2, 3].flatMap(n => [
      { ...base, type: 'user', uuid: `u${n}`, promptId: `p${n}`, message: { role: 'user', content: `human-${n}` } },
      { ...base, type: 'assistant', uuid: `a${n}`, message: { role: 'assistant', content: [{ type: 'text', text: `answer-${n}` }, { type: 'tool_use', id: `call-${n}`, name: 'read', input: { path: `/tmp/${n}` } }] } },
      { ...base, type: 'user', uuid: `r${n}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${n}`, content: `result-${n}`, is_error: false }] } },
    ]),
  ];
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { root, claudeDir, file };
}
function cli(root: string, args: string[]) { return JSON.parse(execFileSync(process.execPath, [bin, '--potsherd-dir', root, ...args, '--json'], { encoding: 'utf8', env: process.env })); }
function allPages(service: LocalMemoryService, legacyRef: { sessionId: string; seq?: number; fromSeq?: number; toSeq?: number }) {
  const text: string[] = []; let cursor: string | undefined;
  let pages=0;
  do {
    if(++pages>30)throw new Error(`legacy pagination did not finish: ${JSON.stringify(legacyRef)}`);
    const response = service.read({ ...(cursor ? { cursor } : { legacyRef }), scope: {}, budget: defaultBudget() }).response;
    if (!('evidence' in response)) throw new Error('unexpected budget failure');
    text.push(...response.evidence.map(item => item.text)); cursor = response.continuation ?? undefined;
  } while (cursor);
  return text.join('\n');
}
describe('verified legacy exchange linkage on the v2 service', () => {
  it('links prompt/assistant/tool records from one snapshot and leaves orphan records unlinked', async () => {
    const { file } = fixture(); const parsed = await parseClaudeTranscript(file);
    expect(parsed.records!.find(record => record.unitKey.includes('orphan'))!.seq).toBeUndefined();
    for (const record of parsed.records!.filter(record => !record.unitKey.includes('orphan'))) {
      const exchange = parsed.exchanges.find(exchange => exchange.seq === record.seq)!;
      expect(record.exchangeId).toBe(exchange.id);
      const raw = fs.readFileSync(file).subarray(Number(record.locator.rawStart), Number(record.locator.rawEnd)).toString();
      expect(JSON.parse(raw).uuid).toMatch(new RegExp(`${record.seq}$`));
    }
  });
  it('preserves canonical refs when filling only missing verified projection mappings', async () => {
    const { root, file } = fixture(); const parsed = await parseClaudeTranscript(file); const db = store.open({ root });
    try {
      const original = structuredClone(parsed); original.records!.forEach(record => { delete record.seq; delete record.exchangeId; });
      const first = publishSource(db, { parsed: original, artifactHash: parsed.artifactHash!, artifactBytes: parsed.endOffset });
      const before = db.prepare('SELECT unit_revision_id,text,role,event_at,locator_json FROM evidence_units ORDER BY unit_revision_id').all();
      const epoch = (db.prepare('SELECT evidence_epoch n FROM memory_epochs').get() as { n: number }).n;
      const repaired = publishSource(db, { parsed, artifactHash: parsed.artifactHash!, artifactBytes: parsed.endOffset });
      expect(repaired.revisionId).toBe(first.revisionId);
      expect(db.prepare('SELECT unit_revision_id,text,role,event_at,locator_json FROM evidence_units ORDER BY unit_revision_id').all()).toEqual(before);
      expect((db.prepare('SELECT evidence_epoch n FROM memory_epochs').get() as { n: number }).n).toBeGreaterThan(epoch);
      const service = new LocalMemoryService(db);
      expect(allPages(service, { sessionId: 'compat-native', seq: 2 })).toContain('human-2');
      expect(allPages(service, { sessionId: 'compat-native', seq: 2 })).not.toContain('human-1');
      expect(allPages(service, { sessionId: 'compat-native', fromSeq: 2 })).toContain('human-3');
      expect(allPages(service, { sessionId: 'compat-native', toSeq: 1 })).not.toContain('human-2');
      expect(allPages(service, { sessionId: 'compat-native', fromSeq: 2, toSeq: 2 })).toContain('result-2');
      service.close();
    } finally { db.close(); }
  });
  it('unchanged older checkpoints are reparsed once for a verified missing mapping, then skip normally',async()=>{
    const {root,claudeDir}=fixture();await indexAll({root,claudeDir,harnesses:['claude'],embed:false});const db=store.open({root});
    const before=db.prepare('SELECT unit_revision_id,text,role,event_at,locator_json FROM evidence_units ORDER BY unit_revision_id').all();
    db.exec("UPDATE evidence_units SET legacy_seq=NULL,legacy_exchange_id=NULL; UPDATE capture_checkpoints SET continuation_json=json_remove(continuation_json,'$.legacyMappingVersion')");db.close();
    expect((await indexAll({root,claudeDir,harnesses:['claude'],embed:false})).totals.parsed).toBe(1);
    const after=store.open({root});try{expect(after.prepare('SELECT unit_revision_id,text,role,event_at,locator_json FROM evidence_units ORDER BY unit_revision_id').all()).toEqual(before);expect((after.prepare('SELECT COUNT(*) n FROM evidence_units WHERE legacy_seq=2').get() as {n:number}).n).toBe(4);}finally{after.close();}
    expect((await indexAll({root,claudeDir,harnesses:['claude'],embed:false})).totals.parsed).toBe(0);
  });
  it('the built CLI respects --from/--to and rejects reversed windows', async () => {
    const { root, claudeDir } = fixture(); await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false });
    expect(cli(root, ['show', 'compat-native', '--from', '1', '--to', '1']).evidence[0].text).toBe('human-1');
    expect(cli(root, ['show', 'compat-native', '--from', '2']).evidence[0].text).toBe('human-2');
    expect(cli(root, ['show', 'compat-native', '--to', '1']).evidence[0].text).toBe('human-1');
    const bad = spawnSync(process.execPath, [bin, '--potsherd-dir', root, 'show', 'compat-native', '--from', '3', '--to', '2'], { encoding: 'utf8', env: process.env });
    expect(bad.status).not.toBe(0); expect(bad.stderr).toContain('increasing exchange range');
  });
  it('find delivers retained prompt bytes and composes ghost/status/sidechain filters without outcome support',async()=>{
    const {root,claudeDir}=fixture();fs.writeFileSync(path.join(claudeDir,'history.jsonl'),JSON.stringify({sessionId:'ghost-native',project:'/tmp/compat',timestamp:1767225600000,display:'retained_ghost_marker requested retry'})+'\n');
    await indexAll({root,claudeDir,harnesses:['claude'],embed:false});
    for(const flags of [['--ghosts','only'],['--status','ghost']]){
      const response=cli(root,['find','retained_ghost_marker','--exact',...flags]);
      expect(response.evidence).toHaveLength(1);expect(response.evidence[0]).toMatchObject({role:'ghost_prompt',text:'retained_ghost_marker requested retry',provenance:{nativeSessionId:'ghost-native',artifactBasis:'history_records',transcriptAvailability:'unavailable'}});
      expect(response.coverage.unavailableKinds).toContain('original_transcript');expect(response.support.state).toBe('insufficient');
      expect(response.warnings).not.toContain('No matching evidence in this captured snapshot.');
    }
    for(const flags of [['--ghosts','exclude'],['--ghosts','only','--sidechains','only']]){
      const response=spawnSync(process.execPath,[bin,'--potsherd-dir',root,'find','retained_ghost_marker','--exact','--json',...flags],{encoding:'utf8',env:process.env});
      expect(response.status).toBe(1);expect(JSON.parse(response.stdout).evidence).toEqual([]);
    }
  });
  it('Codex injected context is not a guessed human ordinal', async () => {
    const { root } = fixture(); const file = path.join(root, 'codex.jsonl');
    const rows = [
      { type: 'session_meta', payload: { id: 'codex-native', cwd: '/tmp/compat' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'actual human' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected context' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'actual human' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recorded answer' }] } },
    ]; fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const parsed = await parseCodexTranscript(file);
    expect(parsed.exchanges).toHaveLength(1);
    expect(parsed.records!.find(record => record.text === 'injected context')!.seq).toBeUndefined();
    expect(parsed.records!.filter(record => record.seq === 1).map(record => record.text)).toEqual(['actual human', 'recorded answer']);
  });
});
