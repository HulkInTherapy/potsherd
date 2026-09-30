import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store, indexAll, writeMemoryNotes, LocalMemoryService, readEpochs, listSourceSpans, sourceId, defaultBudget, countTransportTokens, applyForget } from '@potsherd/core';
import {captureHistoryEvidence} from '../packages/core/src/memory/history.js';
import { tempDir, rmrf } from './helpers.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(rmrf));
const bin=path.resolve('packages/cli/bin/potsherd.js');
function fixture(){
 const root=tempDir('v2-cli-compat-');roots.push(root);const claude=path.join(root,'claude');const project=path.join(claude,'projects','synthetic');fs.mkdirSync(project,{recursive:true});
 const id='native-controls';const rows=[
  {type:'user',sessionId:id,uuid:'early-u',promptId:'early',cwd:'/tmp/control-project',gitBranch:'main',timestamp:'2026-01-01T00:00:00Z',message:{role:'user',content:'EARLY_REQUEST requested review'}},
  {type:'assistant',sessionId:id,uuid:'early-a',cwd:'/tmp/control-project',gitBranch:'main',timestamp:'2026-01-01T00:00:01Z',message:{role:'assistant',content:'EARLY_RESULT completed a review'}},
  {type:'user',sessionId:id,uuid:'late-u',promptId:'late',cwd:'/tmp/control-project',gitBranch:'main',timestamp:'2026-06-30T00:00:00Z',message:{role:'user',content:'LATE_REQUEST requested retry'}},
  {type:'assistant',sessionId:id,uuid:'late-a',cwd:'/tmp/control-project',gitBranch:'main',timestamp:'2026-06-30T00:00:01Z',message:{role:'assistant',content:'LATE_RESULT retry returned successful'}},
  {type:'user',sessionId:id,uuid:'unknown-u',promptId:'unknown',cwd:'/tmp/control-project',gitBranch:'main',message:{role:'user',content:'UNKNOWN_REQUEST clock was not recorded'}},
 ];fs.writeFileSync(path.join(project,id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 fs.writeFileSync(path.join(claude,'history.jsonl'),JSON.stringify({sessionId:'history-controls',timestamp:1767225600000,project:'/tmp/control-project',display:'HISTORY_REQUEST requested retry'})+'\n');
 return {root,claude,id};
}
function run(root:string,args:string[]){return spawnSync(process.execPath,[bin,'--potsherd-dir',root,...args],{encoding:'utf8',env:process.env});}
function json(root:string,args:string[]){const result=run(root,[...args,'--json']);if(result.status!==0)throw new Error(result.stderr+'\n'+result.stdout);return JSON.parse(result.stdout);}
describe('v2 CLI event and organization compatibility',()=>{
 it('selects evidence by event time without a session-start/end predicate and keeps unknown dates partial',async()=>{
  const f=fixture();await indexAll({root:f.root,claudeDir:f.claude,harnesses:['claude'],embed:false});
  const late=json(f.root,['find','LATE_RESULT','--exact','--since','2026-06-01']);expect(late.evidence[0].text).toContain('LATE_RESULT');expect(Date.parse(late.coverage.scope.eventFrom)).toBe(Date.parse('2026-06-01'));expect(late.coverage.omittedKinds).toContain('event_time_unknown');
  const before=run(f.root,['find','LATE_RESULT','--exact','--until','2026-06-01','--json']);expect(before.status).toBe(1);expect(JSON.parse(before.stdout).evidence).toEqual([]);expect(JSON.parse(before.stdout).coverage.state).toBe('partial');
  const unknown=run(f.root,['find','UNKNOWN_REQUEST','--exact','--since','2026-06-01','--json']);expect(unknown.status).toBe(1);expect(JSON.parse(unknown.stdout).coverage.omittedKinds).toContain('event_time_unknown');expect(JSON.parse(unknown.stdout).warnings).not.toContain('No matching evidence in this captured snapshot.');
 });
 it('unknown author-event dates remain visible as uncertainty rather than temporal absence',async()=>{
  const f=fixture();await indexAll({root:f.root,claudeDir:f.claude,harnesses:['claude'],embed:false});const db=store.open({root:f.root});try{writeMemoryNotes(db,{requestKey:'unknown-note',scope:{project:'/tmp/control-project'},entries:[{kind:'observation',text:'NOTE_TIME_UNKNOWN recorded assertion'}],origin:'api'});}finally{db.close();}
  const output=json(f.root,['find','--input-json',JSON.stringify({query:'NOTE_TIME_UNKNOWN',scope:{project:'/tmp/control-project',eventFrom:'2026-06-01'}})]);expect(output.assertions).toEqual([]);expect(output.coverage.state).toBe('partial');expect(output.coverage.omittedKinds).toContain('event_time_unknown');
 });
 it('organizes source-only retained history and composes tag/pin/link/project filters without manufacturing a transcript',async()=>{
  const f=fixture();await indexAll({root:f.root,claudeDir:f.claude,harnesses:['claude'],embed:false});
  expect(json(f.root,['tag','history-controls','+review']).tags).toContain('review');expect(json(f.root,['pin','history-controls']).pinned).toBe(true);expect(run(f.root,['link','history-controls',f.id]).status).toBe(0);
  const found=json(f.root,['find','HISTORY_REQUEST','--exact','--ghosts','only','--tag','review','--pinned','--linked-to',f.id,'--project','control-project']);expect(found.evidence).toHaveLength(1);expect(found.evidence[0].role).toBe('ghost_prompt');
  const db=store.open({root:f.root});try{expect(db.prepare("SELECT 1 FROM ghosts WHERE session_id='history-controls'").get()).toBeUndefined();expect(db.prepare("SELECT 1 FROM sessions WHERE id='history-controls'").get()).toBeUndefined();}finally{db.close();}
  json(f.root,['unpin','history-controls']);const unpinned=run(f.root,['find','HISTORY_REQUEST','--exact','--pinned','--ghosts','only','--json']);expect(unpinned.status).toBe(1);expect(JSON.parse(unpinned.stdout).evidence).toEqual([]);
 });
 it('rejects native/harness ambiguity before organization writes',async()=>{
  const f=fixture();await indexAll({root:f.root,claudeDir:f.claude,harnesses:['claude'],embed:false});const codex=path.join(f.root,'codex-history.jsonl');fs.writeFileSync(codex,JSON.stringify({session_id:'history-controls',ts:1767225600,text:'other harness retained prompt'})+'\n');const db=store.open({root:f.root});try{captureHistoryEvidence(db,{root:f.root,harness:'codex',historyPath:codex});}finally{db.close();}
  const pinned=run(f.root,['pin','history-controls']);expect(pinned.status).toBe(1);expect(pinned.stderr).toContain('multiple harnesses');const check=store.open({root:f.root});try{expect(check.prepare("SELECT 1 FROM pins WHERE session_id='history-controls'").get()).toBeUndefined();}finally{check.close();}
 });
 it('binds internal annotation selection across asynchronous work and cursor replay without echoing implementation IDs',async()=>{
  const f=fixture();await indexAll({root:f.root,claudeDir:f.claude,harnesses:['claude'],embed:false});const db=store.open({root:f.root});try{
   const a=sourceId('claude',f.id),b=sourceId('claude','history-controls');db.prepare('INSERT INTO tags VALUES(?,?)').run(f.id,'selected');
   const selected=()=>{const sourceIds=(db.prepare('SELECT m.source_id id FROM tags t JOIN memory_sources m ON m.native_session_id=t.session_id WHERE t.tag=? ORDER BY m.source_id').all('selected') as {id:string}[]).map(row=>row.id);return {sourceIds,selectionId:createHash('sha256').update(JSON.stringify({tag:'selected',sourceIds})).digest('hex'),warning:'Source filter applied: tag=selected'};};
   const service=new LocalMemoryService(db,{sourceSelection:selected});const first=service.read({legacyRef:{sessionId:f.id},scope:{project:'/tmp/control-project'},budget:defaultBudget()}).response;if(!('continuation' in first))throw new Error('missing cursor');expect(first.continuation).toBeTruthy();expect(first.coverage.scope.sourceIds).toBeUndefined();const epochs=readEpochs(db);
   db.prepare('DELETE FROM tags WHERE tag=?').run('selected');db.prepare('INSERT INTO tags VALUES(?,?)').run('history-controls','selected');expect(readEpochs(db)).toEqual(epochs);
   const stale=service.read({cursor:first.continuation,scope:{project:'/tmp/control-project'},budget:defaultBudget()}).response;if(!('warnings' in stale))throw new Error('budget failed');expect(stale.warnings).toContain('snapshot_changed');expect(stale.evidence).toEqual([]);service.close();
   db.prepare('DELETE FROM tags WHERE tag=?').run('selected');db.prepare('INSERT INTO tags VALUES(?,?)').run(f.id,'selected');let calls=0;
   const dense={async search(){calls++;if(calls===1){db.prepare('DELETE FROM tags WHERE tag=?').run('selected');db.prepare('INSERT INTO tags VALUES(?,?)').run('history-controls','selected');}const ref=listSourceSpans(db,calls===1?a:b).evidence[0]!.ref;return {state:'ready' as const,candidates:[{ref,score:1,lanes:['dense' as const]}]};}};
   const queried=new LocalMemoryService(db,{sourceSelection:selected,dense});const response=(await queried.recall({query:'synthetic_semantic_probe',scope:{project:'/tmp/control-project'},budget:defaultBudget()})).response;if(!('evidence' in response))throw new Error('budget failed');expect(calls).toBe(2);expect(response.evidence[0]?.ref.sourceId).toBe(b);expect(response.coverage.scope.sourceIds).toBeUndefined();queried.close();
  }finally{db.close();}
 });
 it('reports explicitly disabled semantic search and refuses mixed full-input/CLI boundaries',async()=>{
  const f=fixture();await indexAll({root:f.root,claudeDir:f.claude,harnesses:['claude'],embed:false});expect(json(f.root,['find','LATE_RESULT','--no-vec']).coverage.semantic).toBe('disabled');
  const mixed=run(f.root,['find','--input-json',JSON.stringify({query:'LATE_RESULT',scope:{project:'/tmp/control-project'}}),'--project','other','--json']);expect(mixed.status).toBe(1);const response=JSON.parse(mixed.stdout);expect(response.warnings).toContain('conflicting_cli_scope');expect(response.evidence).toEqual([]);expect(response.budget.usedTokens).toBe(countTransportTokens(mixed.stdout));
 });
 it('uses canonical harness identity and labels combined-filter collision gaps without borrowing annotations',async()=>{
  const root=tempDir('v2-cross-harness-');roots.push(root);const claude=path.join(root,'claude'),codex=path.join(root,'codex'),id='11111111-1111-4111-8111-111111111111';const a=path.join(claude,'projects','synthetic',id+'.jsonl'),b=path.join(codex,'sessions','2026','01','01',`rollout-2026-01-01T00-00-00-${id}.jsonl`);fs.mkdirSync(path.dirname(a),{recursive:true});fs.mkdirSync(path.dirname(b),{recursive:true});
  fs.writeFileSync(a,JSON.stringify({type:'user',sessionId:id,uuid:'a',promptId:'p',cwd:'/synthetic',timestamp:'2026-01-01T00:00:00Z',message:{role:'user',content:'CLAUDE_COLLISION_ONLY'}})+'\n');fs.writeFileSync(b,[{type:'session_meta',payload:{id,cwd:'/synthetic'}},{type:'response_item',timestamp:'2026-01-01T00:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:'CODEX_COLLISION_ONLY'}]}}].map(row=>JSON.stringify(row)).join('\n')+'\n');
  await indexAll({root,claudeDir:claude,codexHome:codex,harnesses:['claude','codex'],embed:false});
  const db=store.open({root});try{expect(db.prepare('SELECT COUNT(*) n FROM memory_sources').get()).toEqual({n:2});expect(db.prepare('SELECT COUNT(*) n FROM sessions').get()).toEqual({n:1});db.prepare('INSERT INTO tags VALUES(?,?)').run(id,'ambiguous');db.prepare('INSERT INTO pins VALUES(?,?)').run(id,new Date().toISOString());}finally{db.close();}
  for(const harness of ['claude','codex']){const found=json(root,['find',harness==='claude'?'CLAUDE_COLLISION_ONLY':'CODEX_COLLISION_ONLY','--exact','--harness',harness]);expect(found.evidence).toHaveLength(1);expect(found.evidence[0].provenance.harness).toBe(harness);const combined=run(root,['find',harness==='claude'?'CLAUDE_COLLISION_ONLY':'CODEX_COLLISION_ONLY','--exact','--harness',harness,'--tag','ambiguous','--pinned','--json']);const packet=JSON.parse(combined.stdout);expect(packet.evidence).toEqual([]);expect(packet.coverage.state).toBe('partial');expect(packet.coverage.omittedKinds).toContain('source_filter_projection_gap');expect(packet.warnings).not.toContain('No matching evidence in this captured snapshot.');}
  expect(run(root,['pin',sourceId('claude',id)]).status).toBe(1);
  const forgotten=store.open({root});try{applyForget(forgotten,{requestKey:'forget-collision-A',target:{sourceId:sourceId('claude',id)}},{root});}finally{forgotten.close();}
  const surviving=json(root,['find','CODEX_COLLISION_ONLY','--exact','--harness','codex']);expect(surviving.evidence).toHaveLength(1);
  const retained=JSON.parse(run(root,['find','CODEX_COLLISION_ONLY','--exact','--harness','codex','--tag','ambiguous','--pinned','--json']).stdout);expect(retained.evidence).toEqual([]);expect(retained.coverage.state).toBe('partial');expect(retained.coverage.omittedKinds).toContain('source_filter_projection_gap');expect(retained.warnings).not.toContain('No matching evidence in this captured snapshot.');
  const organization=run(root,['pin',sourceId('codex',id)]);expect(organization.status).toBe(1);expect(organization.stderr).toContain('multiple harnesses');

 });
 it('refuses canonical organization writes when the sole legacy row belongs to another harness',async()=>{
  const f=fixture();await indexAll({root:f.root,claudeDir:f.claude,harnesses:['claude'],embed:false});const db=store.open({root:f.root});try{db.prepare("UPDATE sessions SET harness='codex',project='/foreign' WHERE id=?").run(f.id);}finally{db.close();}
  for(const args of [['pin',sourceId('claude',f.id)],['tag',sourceId('claude',f.id),'+unsafe']]){const attempt=run(f.root,args);expect(attempt.status).toBe(1);expect(attempt.stderr).toContain('organization is ambiguous');}
  const check=store.open({root:f.root});try{expect(check.prepare('SELECT COUNT(*) n FROM pins WHERE session_id=?').get(f.id)).toEqual({n:0});expect(check.prepare('SELECT COUNT(*) n FROM tags WHERE session_id=?').get(f.id)).toEqual({n:0});expect(check.prepare('SELECT harness,project FROM sessions WHERE id=?').get(f.id)).toEqual({harness:'codex',project:'/foreign'});}finally{check.close();}
 });

});
it('retained readers and current cursors see material enrollment change before a failed scan',async()=>{const f=fixture();await indexAll({root:f.root,claudeDir:f.claude,harnesses:['claude'],embed:false});const db=store.open({root:f.root});try{const service=new LocalMemoryService(db,{root:f.root});const first=service.read({legacyRef:{sessionId:f.id},scope:{},budget:defaultBudget()}).response;if(!('coverage' in first)||!first.continuation)throw new Error('fixture needs current cursor');const epoch=readEpochs(db);const changedRoot=path.join(f.root,'new-present-claude');fs.mkdirSync(changedRoot);await expect(indexAll({db,root:f.root,claudeDir:changedRoot,harnesses:['claude'],embed:false,onProgress(progress){if(progress.phase==='discover')throw new Error('fail_after_enrollment');}})).rejects.toThrow('fail_after_enrollment');expect(readEpochs(db).evidence).toBeGreaterThan(epoch.evidence);expect(service.inspect({}).state).toBe('partial');expect(service.inspect({}).omittedKinds).toContain('claude:capture_capability_unverified');const replay=service.read({cursor:first.continuation,scope:{},budget:defaultBudget()}).response;if(!('warnings' in replay))throw new Error('fixture budget');expect(replay.warnings).toContain('snapshot_changed');const historical=service.read({refs:[first.evidence[0]!.ref],scope:{},budget:defaultBudget()}).response;if(!('coverage' in historical))throw new Error('fixture budget');expect(historical.coverage.state).toBe('partial');expect(historical.evidence[0]!.text).toBe(first.evidence[0]!.text);await indexAll({db,root:f.root,claudeDir:changedRoot,harnesses:['claude'],embed:false});expect(service.inspect({}).omittedKinds).not.toContain('claude:capture_capability_unverified');const after=readEpochs(db);await indexAll({db,root:f.root,claudeDir:changedRoot,harnesses:['claude'],embed:false});expect(readEpochs(db)).toEqual(after);}finally{db.close();}});
