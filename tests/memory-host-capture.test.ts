import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import Database from 'better-sqlite3';
import {open} from '../packages/core/src/db.js';
import {indexAll,readEnrolledSources} from '../packages/core/src/ingest.js';
import {MaintenanceWorker} from '../packages/core/src/memory/maintenance.js';
import {validateCapturePayload} from '../packages/core/src/memory/jobs.js';
import {clientSpec,planClient,applySetupPlan} from '../packages/core/src/setup.js';
// @ts-expect-error synthetic fixture builder
import {buildOpencodeReal} from './fixtures/opencode/make-opencode-db.mjs';

describe('native host capture regressions',()=>{
 it('captures separate sessions in one store and a committed WAL-only changed tool outcome',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-capture-'));const native=path.join(root,'native');fs.mkdirSync(native);
  const file=path.join(native,'opencode.db');buildOpencodeReal(file);const writer=new Database(file);writer.pragma('journal_mode=WAL');writer.pragma('wal_autocheckpoint=0');
  writer.exec("INSERT INTO session SELECT 'second',project_id,workspace_id,parent_id,'second','/other/project',path,title,version,agent,model,time_created,time_updated FROM session LIMIT 1");
  writer.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('second-user','second',1780000000000,1780000000000,JSON.stringify({role:'user'}));
  writer.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('second-part','second-user','second',1780000000000,1780000000000,JSON.stringify({type:'text',text:'other project decision'}));
  const db=open({root:path.join(root,'memory')});const worker=new MaintenanceWorker(path.join(root,'memory'),{db});
  try{
   const report=await indexAll({db,root:path.join(root,'memory'),opencodeDir:native,harnesses:['opencode'],embed:false});expect(report.totals.failed).toBe(0);
   expect(db.prepare("SELECT count(*) n FROM memory_sources WHERE harness='opencode' AND active_revision_id IS NOT NULL").get()).toMatchObject({n:2});
   await worker.drainOnce();
   const before=fs.readFileSync(file);const row=writer.prepare("SELECT id,session_id FROM message WHERE json_extract(data,'$.role')='assistant'").get() as {id:string;session_id:string};
   writer.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('tool-part',row.id,row.session_id,1780000006000,1780000006000,JSON.stringify({type:'tool',callID:'call-1',tool:'bash',state:{status:'error',input:{command:'test'},error:'test failed',output:'changed outcome'}}));
   expect(fs.readFileSync(file).equals(before)).toBe(true);
   await new Promise(r=>setTimeout(r,5));(worker as unknown as {discoveryAt:number}).discoveryAt=0;await worker.drainOnce();
   expect(db.prepare("SELECT result,is_error FROM tool_calls WHERE result='changed outcome'").get()).toMatchObject({result:'changed outcome',is_error:1});
   expect(db.prepare("SELECT project FROM sessions WHERE id='second'").get()).toMatchObject({project:'/other/project'});
  }finally{await worker.close();db.close();writer.close();fs.rmSync(root,{recursive:true,force:true});}
 });
 it('persists deliberate additions/removals without a scan filter removing other roots',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'enroll-host-'));const db=open({root});try{
   await indexAll({db,root,claudeDir:path.join(root,'claude'),harnesses:['claude'],embed:false});
   await indexAll({db,root,piDir:path.join(root,'pi'),harnesses:['pi'],enrollHarnesses:['pi'],embed:false});
   expect(readEnrolledSources(db)?.harnesses).toEqual(['claude','pi']);
   await indexAll({db,root,harnesses:['claude'],embed:false});expect(readEnrolledSources(db)?.harnesses).toEqual(['claude','pi']);
   await indexAll({db,root,removeHarnesses:['pi'],embed:false});expect(readEnrolledSources(db)?.harnesses).toEqual(['claude']);
   expect(validateCapturePayload({piDir:'/owned/pi',opencodeDir:'/owned/oc',enrollHarnesses:['pi']})).toMatchObject({enrollHarnesses:['pi']});
   expect(()=>validateCapturePayload({piDir:'relative'})).toThrow('invalid_capture_request');
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
});
