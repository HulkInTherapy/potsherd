import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.js';
import { assertFence, type Fence } from './leases.js';
import type { Harness } from '../adapters/types.js';
import type { IndexReport } from '../ingest.js';
import { identity } from './spans.js';
import { DEFAULT_SPACE_ID } from './assets.js';
export type JobKind='discover'|'capture'|'parse'|'lineage'|'embed'|'rebuild'|'forget';
export type Job={job_id:string;kind:JobKind;target_id:string;target_revision_id:string|null;input_hash:string;attempts:number};
export type CapturePayload={claudeDir?:string;codexHome?:string;piDir?:string;opencodeDir?:string;enrollHarnesses?:Harness[];removeHarnesses?:Harness[];harnesses?:Harness[];full?:boolean;sessionId?:string};
export type CaptureStatus={jobId:string;state:string;durable:true;captured:boolean;report?:IndexReport};
export type Request={kind:JobKind;targetId:string;inputHash:string;targetRevisionId?:string;requestId?:string;capture?:CapturePayload};
export function enqueueJob(db:Db,r:Request,now=Date.now()):string {
 const id=identity('job/v1',r.kind,r.targetId,r.inputHash),at=new Date(now).toISOString();
 db.prepare(`INSERT INTO maintenance_jobs(job_id,kind,target_id,target_revision_id,input_hash,state,attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'pending',0,?,?,?) ON CONFLICT(kind,target_id,input_hash) DO NOTHING`).run(id,r.kind,r.targetId,r.targetRevisionId??null,r.inputHash,at,at,at);return id;
}
/** Exact work identity, shared by publication and retained-history repair. */
export function enqueueEmbeddingJob(db:Db,sourceId:string,revisionId:string,spaceId:string,now=Date.now()):string {
 return enqueueJob(db,{kind:'embed',targetId:sourceId,targetRevisionId:revisionId,inputHash:identity('embedding-target/v1',spaceId,revisionId)},now);
}
/** Only explicitly supported old default-space aliases may use canonical work. */
export function embeddingJobMatchesSpace(job:Job,spaceId:string,manifestHash:string):boolean {
 const revision=job.target_revision_id;if(!revision)return false;
 if(job.input_hash===identity('embedding-target/v1',spaceId,revision))return true;
 if(spaceId!==DEFAULT_SPACE_ID)return false;
 return job.input_hash===manifestHash||
  job.input_hash===identity('historical-space-backfill/v1',spaceId,revision)||
  job.input_hash===identity('historical-space-backfill/v2-vector-validation',spaceId,revision);
}
/** Whitelist metadata only; transcript bodies and arbitrary IndexOptions never enter requests. */
export function validateCapturePayload(value:unknown):CapturePayload {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_capture_request');
 const allowed=new Set(['claudeDir','codexHome','piDir','opencodeDir','enrollHarnesses','removeHarnesses','harnesses','full','sessionId']);for(const key of Object.keys(value))if(!allowed.has(key))throw new Error('invalid_capture_request');
 const r=value as CapturePayload;for(const key of ['claudeDir','codexHome','piDir','opencodeDir','sessionId'] as const)if(r[key]!==undefined&&(typeof r[key]!=='string'||!r[key]||r[key]!.length>8192))throw new Error('invalid_capture_request');
 for(const key of ['claudeDir','codexHome','piDir','opencodeDir'] as const)if(r[key]!==undefined&&!path.isAbsolute(r[key]!))throw new Error('invalid_capture_request');
 if(r.full!==undefined&&typeof r.full!=='boolean')throw new Error('invalid_capture_request');
 for(const key of ['harnesses','enrollHarnesses','removeHarnesses'] as const)if(r[key]!==undefined&&(!Array.isArray(r[key])||r[key]!.some(h=>!['claude','codex','cursor','pi','gemini','opencode','copilot'].includes(h))))throw new Error('invalid_capture_request');
 return {...r,...(r.harnesses?{harnesses:[...r.harnesses]}:{})};
}
export function enqueueRequest(db:Db,r:Request):string {
 return db.transaction(()=>{const capture=r.capture===undefined?undefined:validateCapturePayload(r.capture);const id=enqueueJob(db,r);
  if(capture){if(r.kind!=='capture')throw new Error('invalid_capture_request');const detail=JSON.stringify({capture});const previous=db.prepare("SELECT detail_json FROM maintenance_events WHERE job_id=? AND kind='capture_request' LIMIT 1").get(id) as {detail_json:string}|undefined;
   if(previous&&previous.detail_json!==detail)throw new Error('capture_request_conflict');
   if(!previous)db.prepare("INSERT INTO maintenance_events(job_id,kind,at,detail_json) VALUES(?,'capture_request',?,?)").run(id,new Date().toISOString(),detail);
  }return id;}).immediate();
}
export function readCapturePayload(db:Db,id:string):CapturePayload|undefined {const r=db.prepare("SELECT detail_json FROM maintenance_events WHERE job_id=? AND kind='capture_request' ORDER BY event_id DESC LIMIT 1").get(id) as {detail_json:string}|undefined;return r?validateCapturePayload(JSON.parse(r.detail_json).capture):undefined;}
export function recordCaptureResult(db:Db,f:Fence,j:Job,report:IndexReport,captured=report.totals.failed===0):void {
 db.transaction(()=>{assertFence(db,f);if(!db.prepare("SELECT 1 FROM maintenance_jobs WHERE job_id=? AND state='running' AND owner_token=? AND lease_generation=?").get(j.job_id,f.ownerToken,f.generation))throw new Error('job_superseded');
  const safe={...report,harnesses:report.harnesses.map(h=>({...h,errors:h.errors.map(()=> 'capture_failed')}))};
  db.prepare("INSERT INTO maintenance_events(job_id,kind,at,detail_json) VALUES(?,'capture_result',?,?)").run(j.job_id,new Date().toISOString(),JSON.stringify({captured,report:safe}));
 }).immediate();
}
export function captureStatus(db:Db,jobId:string):CaptureStatus|null {
 const job=db.prepare('SELECT state FROM maintenance_jobs WHERE job_id=?').get(jobId) as {state:string}|undefined;if(!job)return null;
 const event=db.prepare("SELECT detail_json FROM maintenance_events WHERE job_id=? AND kind='capture_result' ORDER BY event_id DESC LIMIT 1").get(jobId) as {detail_json:string}|undefined;
 const result=event?JSON.parse(event.detail_json) as {captured:boolean;report:IndexReport}:undefined;
 return {jobId,state:job.state,durable:true,captured:job.state==='done'&&result?.captured===true,...(result?{report:result.report}:{})};
}
export function recoverJobs(db:Db,f:Fence,now=Date.now()):void {db.transaction(()=>{assertFence(db,f);db.prepare(`UPDATE maintenance_jobs SET state='retry',owner_token=NULL,lease_generation=NULL,next_attempt_at=?,updated_at=?,error_code='owner_interrupted',error_detail_redacted=NULL WHERE state='running' AND (owner_token<>? OR lease_generation<>? OR owner_token IS NULL)`).run(new Date(now).toISOString(),new Date(now).toISOString(),f.ownerToken,f.generation);}).immediate();}
export function claimJob(db:Db,f:Fence,now=Date.now(),lane?:'embed'|'capture'):Job|null {
 return db.transaction(()=>{assertFence(db,f);const j=db.prepare(`SELECT * FROM maintenance_jobs WHERE state IN('pending','retry') AND next_attempt_at<=? ${lane==='embed'?"AND kind='embed'":lane==='capture'?"AND kind<>'embed'":''} ORDER BY next_attempt_at,created_at,job_id LIMIT 1`).get(new Date(now).toISOString()) as Job|undefined;if(!j)return null;
 db.prepare(`UPDATE maintenance_jobs SET state='running',attempts=attempts+1,owner_token=?,lease_generation=?,updated_at=? WHERE job_id=?`).run(f.ownerToken,f.generation,new Date(now).toISOString(),j.job_id);return {...j,attempts:j.attempts+1};}).immediate();
}
export function finishJob(db:Db,f:Fence,j:Job,state:'done'|'pending'|'retry'|'blocked'|'cancelled',code?:string,now=Date.now()):void {
 db.transaction(()=>{assertFence(db,f);const delay=state==='retry'?Math.min(60000,1000*2**Math.min(6,Math.max(0,j.attempts-1))):0;
 db.prepare(`UPDATE maintenance_jobs SET state=?,owner_token=NULL,lease_generation=NULL,next_attempt_at=?,updated_at=?,error_code=?,error_detail_redacted=NULL WHERE job_id=? AND state='running' AND owner_token=? AND lease_generation=?`).run(state,new Date(now+delay).toISOString(),new Date(now).toISOString(),code??null,j.job_id,f.ownerToken,f.generation);}).immediate();
}
export function retryBlocked(db:Db,code:string):void {const at=new Date().toISOString();db.prepare("UPDATE maintenance_jobs SET state='pending',next_attempt_at=?,updated_at=?,error_code=NULL WHERE state='blocked' AND error_code=?").run(at,at,code);}
export function spoolRequest(root:string,r:Request):string {
 const dir=path.join(root,'maintenance-spool');fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,identity('spool/v1',r.kind,r.targetId,r.inputHash)+'.json'),temp=file+'.'+randomUUID()+'.tmp';
 const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({...r,requestId:r.requestId??randomUUID()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}return file;
}
export function drainSpool(db:Db,root:string):number {
 const dir=path.join(root,'maintenance-spool');if(!fs.existsSync(dir))return 0;let n=0;
 for(const name of fs.readdirSync(dir).filter(x=>/^[a-f0-9]{64}\.json$/u.test(x)).sort()){
  const file=path.join(dir,name);try{const r=JSON.parse(fs.readFileSync(file,'utf8')) as Request;if(!['discover','capture','parse','lineage','embed','rebuild','forget'].includes(r.kind)||typeof r.targetId!=='string'||typeof r.inputHash!=='string')continue;enqueueRequest(db,r);fs.unlinkSync(file);n++;}catch{/* Keep malformed/uncommitted requests for diagnosis and recovery. */}
 }return n;
}
export function runtimeHealth(db:Db):{debt:Record<string,number>;owners:unknown[];capturedThrough:string|null} {
 const debt:Record<string,number>={};for(const r of db.prepare("SELECT state,count(*) n FROM maintenance_jobs WHERE state NOT IN('done','cancelled') GROUP BY state").all() as {state:string;n:number}[])debt[r.state]=r.n;
 const row=db.prepare('SELECT MIN(last_success_at) at FROM capture_checkpoints').get() as {at:string|null};return {debt,owners:db.prepare('SELECT lane,owner_token,generation,pid,heartbeat_at,expires_at FROM maintenance_leases WHERE process_started_at<>\'released\'').all(),capturedThrough:row.at};
}
