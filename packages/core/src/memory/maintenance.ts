import type {Harness} from '../adapters/types.js';
import {EmbeddingWorkset} from './embedding-workset.js';
import {validatedSpanVectorBlob} from './vector-validation.js';
import {privacyAffectedRange} from './privacy.js';
import fs from 'node:fs';
import path from 'node:path';
import {openDatabase} from '../sqlite-driver.js';
import { open, openSqliteReadOnly, schemaVersion, type Db } from '../db.js';
import {MEMORY_SCHEMA_VERSION,assertMemorySchema} from './readiness.js';
import { indexAll, adapterSpecs, readEnrolledSources, discoverEnrolledSources,discoverEnrolledHistoryInputs } from '../ingest.js';
import {NORMALIZATION_VERSION} from './source.js';
import { modelsDir, dbPath } from '../paths.js';
import { recoverForget } from './delete.js';
import { backfillLegacy, backfillLegacyGhosts, rebuildEvidenceSpans } from './backfill.js';
import {loadSpanTokenizer,inspectSpanTokenizerHash} from './tokenization.js';
import { backfillLegacyNotes } from './notes-store.js';
import { hash, identity, spanEmbeddingText, compatibleSpanPolicies, currentSpanPolicy, SPAN_MANIFEST_VERSION } from './spans.js';
import { claimLease, assertFence, heartbeatLease, releaseLease, type Fence } from './leases.js';
import { enqueueJob, enqueueEmbeddingJob, embeddingJobMatchesSpace, readCapturePayload, recordCaptureResult, recoverJobs, claimJob, finishJob, drainSpool, retryBlocked, type Job } from './jobs.js';
import { DEFAULT_SPACE_ID, MODEL_HASH, TOKENIZER_HASH, inspectAssets, LocalEncoder } from './assets.js';
import { MODEL_ID,RUNTIME_VERSION,BGE_QUERY_PREFIX,embeddingToBlob } from '../embeddings.js';
/** Existing supported stores open without migration or legacy repair before lease ownership. */
function openMaintenanceDb(root:string):Db {
 const file=dbPath(root),reader=openSqliteReadOnly(file);try{assertMemorySchema(reader);}finally{reader.close();}
 const writer=openDatabase(file,{readonly:false,fileMustExist:true});writer.pragma('synchronous = FULL');writer.pragma('foreign_keys = ON');writer.pragma('busy_timeout = 1000');return writer;
}
/** Recovered old revisions remain immutable; their exact supported payloads can be encoded now. */
export function queueHistoricalEmbeddings(db:Db,options:{signal?:AbortSignal}={}):number {
 options.signal?.throwIfAborted();
 // Validate each unique eligible span once, independently of how many retained
 // revisions share it. Only revision/source metadata enters the temporary table;
 // SQLite bounds its page cache, and no full-BLOB cache grows in JavaScript.
 const borrowed=EmbeddingWorkset.forConnection(db),owner=borrowed??new EmbeddingWorkset(db,DEFAULT_SPACE_ID,()=>{});
 try{return owner.validationScan((membership,debt)=>{
  let membershipRevision='',membershipOrdinal=-1;for(;;){options.signal?.throwIfAborted();const page=db.prepare(`SELECT rs.span_id,r.revision_id,r.source_id,rs.ordinal FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN source_revisions r ON r.revision_id=rs.revision_id JOIN memory_sources s ON s.source_id=r.source_id WHERE p.chunk_policy IN (?,?) AND s.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=s.source_id AND t.state<>'reversed') AND (rs.revision_id,rs.ordinal)>(?,?) ORDER BY rs.revision_id,rs.ordinal LIMIT 128`).all(...compatibleSpanPolicies(TOKENIZER_HASH),membershipRevision,membershipOrdinal) as {span_id:string;revision_id:string;source_id:string;ordinal:number}[];if(!page.length)break;for(const row of page){db.prepare(`INSERT INTO ${membership} VALUES(?,?,?)`).run(row.span_id,row.revision_id,row.source_id);membershipRevision=row.revision_id;membershipOrdinal=row.ordinal;}}
  let spanCursor=0;for(;;){options.signal?.throwIfAborted();const spans=db.prepare(`SELECT p.span_id,p.span_rowid,e.vector_blob FROM evidence_spans p LEFT JOIN span_embeddings e ON e.span_id=p.span_id AND e.space_id=? AND e.input_hash=p.embedding_input_hash WHERE p.span_rowid>? AND p.chunk_policy IN (?,?) AND EXISTS(SELECT 1 FROM ${membership} m WHERE m.span_id=p.span_id) ORDER BY p.span_rowid LIMIT 128`).all(DEFAULT_SPACE_ID,spanCursor,...compatibleSpanPolicies(TOKENIZER_HASH)) as {span_id:string;span_rowid:number;vector_blob:Buffer|null}[];if(!spans.length)break;
  for(const span of spans){spanCursor=span.span_rowid;if(validatedSpanVectorBlob(span.vector_blob))continue;
   db.prepare(`INSERT OR IGNORE INTO ${debt} SELECT revision_id,source_id FROM ${membership} WHERE span_id=?`).run(span.span_id);
  }}
  const count=(db.prepare(`SELECT COUNT(*) n FROM ${debt}`).get() as {n:number}).n;
  let revisionCursor='';for(;;){options.signal?.throwIfAborted();const revisions=db.prepare(`SELECT source_id,revision_id FROM ${debt} WHERE revision_id>? ORDER BY revision_id LIMIT 128`).all(revisionCursor) as {source_id:string;revision_id:string}[];if(!revisions.length)break;for(const r of revisions){revisionCursor=r.revision_id;
   const job=enqueueEmbeddingJob(db,r.source_id,r.revision_id,DEFAULT_SPACE_ID);
   // A completed job does not establish health after its stored payload corrupts.
   db.prepare("UPDATE maintenance_jobs SET state='pending',next_attempt_at=?,updated_at=?,error_code='vector_repair_required' WHERE job_id=? AND state='done'").run(new Date().toISOString(),new Date().toISOString(),job);
  }}
  return count;
 });}finally{if(!borrowed){owner.close();if(owner.cleanup?.foreignTempObjectsPresent)console.warn(JSON.stringify({maintenanceCleanup:'temp_settings_not_restored',foreignTempObjectsPresent:true}));}}
}

export function ensureSpanSpace(db:Db):void {
 db.exec('CREATE INDEX IF NOT EXISTS span_embeddings_payload ON span_embeddings(space_id,input_hash)');
 const at=new Date().toISOString();db.transaction(()=>{
  // Explicitly retain mean; CLS is a different build and never a query fallback.
  // chunk_policy='span-v1' is legacy registration provenance. The unchanged
  // verified space supports the explicit compatible v1/v2 window policies.
  db.prepare(`INSERT OR IGNORE INTO embedding_spaces(space_id,model_id,model_revision,model_asset_hash,tokenizer_hash,runtime_version,dtype,pooling,query_prefix,normalization,dimensions,chunk_policy,created_at,state) VALUES(?,?,?,?,?,?,?,'mean',?,'l2',384,'span-v1',?,'building')`).run(DEFAULT_SPACE_ID,MODEL_ID,MODEL_HASH,MODEL_HASH,TOKENIZER_HASH,RUNTIME_VERSION,'q8',BGE_QUERY_PREFIX,at);
  db.prepare("UPDATE embedding_spaces SET state='retired' WHERE state='active' AND space_id<>?").run(DEFAULT_SPACE_ID);
  db.prepare("UPDATE embedding_spaces SET state='active' WHERE space_id=?").run(DEFAULT_SPACE_ID);
 }).immediate();
}
export function commitSpanVector(db:Db,f:Fence,j:Job,spanId:string,inputHash:string,vector:number[]):boolean {
 return db.transaction(()=>{
  assertFence(db,f);
  const eligible=db.prepare(`SELECT 1 FROM evidence_spans p JOIN revision_spans rs ON rs.span_id=p.span_id JOIN source_revisions r ON r.revision_id=rs.revision_id JOIN memory_sources s ON s.source_id=r.source_id JOIN embedding_spaces sp ON sp.space_id=? AND sp.state='active' WHERE p.span_id=? AND p.embedding_input_hash=? AND r.revision_id=? AND s.source_id=? AND s.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=s.source_id AND t.state<>'reversed')`).get(DEFAULT_SPACE_ID,spanId,inputHash,j.target_revision_id,j.target_id);
  if(!eligible)return false;const blob=embeddingToBlob(vector);if(!validatedSpanVectorBlob(blob))throw new Error('embedding_dimensions');
  const running=db.prepare("SELECT 1 FROM maintenance_jobs WHERE job_id=? AND state='running' AND owner_token=? AND lease_generation=?").get(j.job_id,f.ownerToken,f.generation);if(!running)throw new Error('job_superseded');
  db.prepare(`INSERT INTO span_embeddings(span_id,space_id,input_hash,vector_blob,created_at,job_id) VALUES(?,?,?,?,?,?) ON CONFLICT(span_id,space_id) DO UPDATE SET input_hash=excluded.input_hash,vector_blob=excluded.vector_blob,created_at=excluded.created_at,job_id=excluded.job_id`).run(spanId,DEFAULT_SPACE_ID,inputHash,blob,new Date().toISOString(),j.job_id);
  db.prepare('UPDATE memory_epochs SET vector_epoch=vector_epoch+1 WHERE singleton=1').run();return true;
 }).immediate();
}
export class MaintenanceWorker {
 private db:Db|null=null;private fence:Fence|null=null;private timer:ReturnType<typeof setInterval>|null=null;private heart:ReturnType<typeof setInterval>|null=null;private controller=new AbortController();private encoder:LocalEncoder;private pass:Promise<void>|null=null;private stopped=false;private closing:Promise<void>|null=null;readonly cleanupFailures:{stage:string;errorHash:string}[]=[];private discoveryAt=0;private lastCapture=false;private vectorValidationAt:number|null=null;private workset:EmbeddingWorkset|null=null;readonly progressCleanup:{settingsRestored:boolean;foreignTempObjectsPresent:boolean}[]=[];private spaceEnsured=false;private seen=new Map<string,string>();
 constructor(readonly root:string,readonly options:{intervalMs?:number;db?:Db;encoder?:LocalEncoder;vectorValidationIntervalMs?:number}={}){this.encoder=options.encoder??new LocalEncoder(modelsDir(root));}
 start():void {
  if(this.stopped)throw new Error('worker_closed');if(this.timer)return;
  this.db=this.options.db??openMaintenanceDb(this.root);
  this.timer=setInterval(()=>{if(this.pass&&this.db&&this.fence&&!this.stopped){try{assertFence(this.db,this.fence);drainSpool(this.db,this.root);this.discoveryAt=Date.now();this.discover();}catch{}}this.wake();},this.options.intervalMs??2000);this.timer.unref();this.wake();
 }
 private wake():void {if(this.stopped||this.pass)return;this.pass=this.drain().catch(()=>{}).finally(()=>{this.pass=null;});}
 private acquire():boolean {
  if(this.fence)return true;const f=claimLease(this.db!,'maintenance');if(!f)return false;this.fence=f;recoverJobs(this.db!,f);this.heart=setInterval(()=>{try{if(!heartbeatLease(this.db!,f))this.controller.abort(new Error('lease_superseded'));}catch{this.controller.abort(new Error('heartbeat_failed'));}},5000);this.heart.unref();return true;
 }
 private discover():void {
  const db=this.db!,enrollment=readEnrolledSources(db);if(!enrollment)return;
  const tokenizerHash=inspectSpanTokenizerHash(modelsDir(this.root));const pipelinePolicy=currentSpanPolicy(tokenizerHash?{assetHash:tokenizerHash}:undefined)+'\0'+SPAN_MANIFEST_VERSION;
  const versions=new Map(adapterSpecs({...enrollment.options,potsherdDir:this.root}).map(spec=>[spec.harness,spec.evidenceVersion]));
  for(const source of discoverEnrolledSources(db,this.root,()=>assertFence(db,this.fence!))){
   const key=JSON.stringify([source.harness,source.sessionId,source.path]);
   let fingerprint:string;try{const paths=source.harness==='opencode'?[source.path,source.path+'-wal']:[source.path];fingerprint=hash(JSON.stringify(paths.map(p=>{try{const s=fs.statSync(p);return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs];}catch{return null;}})));}catch{continue;}
   if(this.seen.get(key)===fingerprint+'\0'+NORMALIZATION_VERSION+'\0'+(versions.get(source.harness)??'adapter-unknown')+'\0'+pipelinePolicy)continue;
   const pipelineFingerprint=fingerprint+'\0'+NORMALIZATION_VERSION+'\0'+(versions.get(source.harness)??'adapter-unknown')+'\0'+pipelinePolicy;
   this.seen.set(key,pipelineFingerprint);enqueueJob(db,{kind:'capture',targetId:'source:'+JSON.stringify([source.harness,source.sessionId]),inputHash:hash(key+'\0'+pipelineFingerprint)});
  }
  for(const {harness,historyPath} of discoverEnrolledHistoryInputs(db,this.root)){
   let fingerprint:string;try{const stat=fs.statSync(historyPath);fingerprint=hash(JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,NORMALIZATION_VERSION,`${harness}-history-records-v1`,pipelinePolicy]));}catch{continue;}
   const key=`history:${historyPath}`;if(this.seen.get(key)===fingerprint)continue;this.seen.set(key,fingerprint);
   // Discover jobs invoke enrolled indexAll without a transcript session filter.
   enqueueJob(db,{kind:'discover',targetId:'history:'+hash(historyPath),inputHash:fingerprint});
  }
  // A per-index saved enrollment is the only source authority. Capture always hashes bytes.
 }
 private async drain():Promise<void> {
  if(this.stopped||!this.db)return;assertMemorySchema(this.db);if(!this.acquire())return;const db=this.db,f=this.fence!;
  drainSpool(db,this.root);recoverForget(db,{root:this.root});
  if(Date.now()-this.discoveryAt>=(this.options.intervalMs??2000)){this.discoveryAt=Date.now();this.discover();}
  const ready=inspectAssets(modelsDir(this.root)).state==='ready';if(ready){if(!this.workset)this.workset=new EmbeddingWorkset(db,DEFAULT_SPACE_ID,()=>assertFence(db,f));if(!this.spaceEnsured){ensureSpanSpace(db);this.spaceEnsured=true;}retryBlocked(db,'missing_assets');const supported=compatibleSpanPolicies(TOKENIZER_HASH);db.prepare("UPDATE maintenance_jobs SET state='pending',next_attempt_at=?,error_code=NULL WHERE state='blocked' AND error_code='span_rebuild_required' AND EXISTS(SELECT 1 FROM revision_spans WHERE revision_id=target_revision_id) AND NOT EXISTS(SELECT 1 FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id WHERE rs.revision_id=target_revision_id AND p.chunk_policy NOT IN (?,?))").run(new Date().toISOString(),...supported);if(this.vectorValidationAt===null||Date.now()-this.vectorValidationAt>=(this.options.vectorValidationIntervalMs??60000)){db.transaction(()=>{assertFence(db,f);queueHistoricalEmbeddings(db,{signal:this.controller.signal});this.workset?.reset();}).immediate();this.vectorValidationAt=Date.now();}}
  for(;;){this.controller.signal.throwIfAborted();const job=claimJob(db,f,Date.now(),this.lastCapture?'embed':'capture')??claimJob(db,f);if(!job)break;this.lastCapture=job.kind!=='embed';
   try {const complete=await this.handle(job,f);finishJob(db,f,job,complete===false?'pending':'done');}
   catch(error){if(this.controller.signal.aborted){try{finishJob(db,f,job,'retry','worker_cancelled');}catch{}break;}const code=error instanceof Error?error.message:'';finishJob(db,f,job,['missing_assets','span_rebuild_required','source_enrollment_required','privacy_refresh_required','embedding_space_unsupported'].includes(code)?'blocked':'retry',['missing_assets','span_rebuild_required','source_enrollment_required','privacy_refresh_required','embedding_space_unsupported'].includes(code)?code:'maintenance_failed');}
   // Corruption validation/refill also runs during a long active backlog.
   if(ready&&(this.vectorValidationAt===null||Date.now()-this.vectorValidationAt>=(this.options.vectorValidationIntervalMs??60000))){db.transaction(()=>{assertFence(db,f);queueHistoricalEmbeddings(db,{signal:this.controller.signal});this.workset?.reset();}).immediate();this.vectorValidationAt=Date.now();}
   // Requery after every completion: work added during an async pass cannot strand.
  }
 }
 private async handle(j:Job,f:Fence):Promise<void|boolean> {
  const db=this.db!;assertFence(db,f);
  if(j.kind==='embed'){
   if(inspectAssets(modelsDir(this.root)).state!=='ready')throw new Error('missing_assets');if(!this.spaceEnsured){ensureSpanSpace(db);this.spaceEnsured=true;}
   const current=db.prepare("SELECT 1 FROM memory_sources s JOIN source_revisions r ON r.source_id=s.source_id WHERE s.source_id=? AND r.revision_id=? AND s.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=s.source_id AND t.state<>'reversed')").get(j.target_id,j.target_revision_id);if(!current)return;
   type Row={span_id:string;text:string;embedding_context_json:string;embedding_input_hash:string;chunk_policy:string;start_utf16:number;end_utf16:number;unit_text:string;normalization_version:string;ordinal:number;vector_blob:Buffer|null};
   const revision=db.prepare('SELECT manifest_hash FROM source_revisions WHERE revision_id=? AND source_id=?').get(j.target_revision_id,j.target_id) as {manifest_hash:string};
   if(!embeddingJobMatchesSpace(j,DEFAULT_SPACE_ID,revision.manifest_hash))throw new Error('embedding_space_unsupported');
   if(!this.workset)this.workset=new EmbeddingWorkset(db,DEFAULT_SPACE_ID,()=>assertFence(db,f));
   const selected=this.workset.take(j.target_revision_id!,revision.manifest_hash,this.controller.signal);
   const rows=selected.length?db.prepare(`SELECT p.span_id,p.text,p.embedding_context_json,p.embedding_input_hash,p.chunk_policy,p.start_utf16,p.end_utf16,CASE WHEN u.normalization_version<>? THEN u.text ELSE '' END unit_text,u.normalization_version,rs.ordinal FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id WHERE rs.revision_id=? AND p.span_id IN (${selected.map(()=>'?').join(',')}) ORDER BY rs.ordinal`).all(NORMALIZATION_VERSION,j.target_revision_id,...selected.map(p=>p.span_id)) as Row[]:[];
   if(rows.length!==selected.length||rows.some(p=>!selected.some(target=>target.span_id===p.span_id&&target.input_hash===p.embedding_input_hash&&target.ordinal===p.ordinal)))throw new Error('embedding_membership_changed');
   const values=new Map<string,number[]>(),missing=new Map<string,string>();
   for(const p of rows){this.controller.signal.throwIfAborted();if(!compatibleSpanPolicies(TOKENIZER_HASH).includes(p.chunk_policy))throw new Error('span_rebuild_required');if(privacyAffectedRange(p.unit_text,p.start_utf16,p.end_utf16,p.normalization_version))throw new Error('privacy_refresh_required');const text=spanEmbeddingText(p.text,p.embedding_context_json);if(hash(text)!==p.embedding_input_hash)throw new Error('embedding_input_hash_mismatch');
    if(values.has(p.embedding_input_hash)||missing.has(p.embedding_input_hash))continue;
    const reusable=db.prepare(`SELECT e.vector_blob,prior.text,prior.embedding_context_json FROM span_embeddings e JOIN evidence_spans prior ON prior.span_id=e.span_id WHERE e.space_id=? AND e.input_hash=? AND prior.embedding_input_hash=e.input_hash AND prior.chunk_policy IN (?,?) AND length(e.vector_blob)=1536 LIMIT 8`).all(DEFAULT_SPACE_ID,p.embedding_input_hash,...compatibleSpanPolicies(TOKENIZER_HASH)) as {vector_blob:Buffer;text:string;embedding_context_json:string}[];
    const verified=reusable.find(prior=>{const priorInput=spanEmbeddingText(prior.text,prior.embedding_context_json),vector=validatedSpanVectorBlob(prior.vector_blob);return priorInput===text&&hash(priorInput)===p.embedding_input_hash&&vector!==null;});
    if(verified)values.set(p.embedding_input_hash,Array.from(validatedSpanVectorBlob(verified.vector_blob)!));else missing.set(p.embedding_input_hash,text);
   }
   if(missing.size){const keys=[...missing.keys()],vectors=await this.encoder.encodeBatch([...missing.values()],this.controller.signal);keys.forEach((key,i)=>values.set(key,vectors[i]!));}
   // Main-file commit finishes before deleting disposable pending metadata.
   const committed=db.transaction(()=>{assertFence(db,f);this.controller.signal.throwIfAborted();return rows.filter(p=>commitSpanVector(db,f,j,p.span_id,p.embedding_input_hash,values.get(p.embedding_input_hash)!));}).immediate();
   for(const p of committed)this.workset.committed(j.target_revision_id!,p.span_id,p.embedding_input_hash,p.ordinal);
   if(committed.length!==rows.length)throw new Error('embedding_target_changed');
   // Empty selection has undergone full target validation; never infer completion from a frontier alone.
   return rows.length===0;

  }
  if(j.kind==='forget'){recoverForget(db,{root:this.root});return;}
  if(j.kind==='rebuild'&&j.target_id.startsWith('spans:')){const tokenizer=await loadSpanTokenizer(modelsDir(this.root));if(!tokenizer)throw new Error('missing_assets');const result=rebuildEvidenceSpans(db,{tokenizer,beforeCommit:()=>assertFence(db,f),limit:100});if(result.remaining>0&&result.rebuilt===0)throw new Error('rebuild_incomplete');return result.remaining===0;}
  if(j.kind==='rebuild'){const complete=db.transaction(()=>{assertFence(db,f);const sources=backfillLegacy(db);backfillLegacyGhosts(db,Number.MAX_SAFE_INTEGER);while(backfillLegacyNotes(db,100)>0){this.controller.signal.throwIfAborted();assertFence(db,f);}return sources.remaining===0;}).immediate();return complete;}
  const capture=readCapturePayload(db,j.job_id);
  if(!capture&&!readEnrolledSources(db))throw new Error('source_enrollment_required');
  const enrollment=readEnrolledSources(db);
  const logical=!capture&&j.kind==='capture'&&j.target_id.startsWith('source:')?JSON.parse(j.target_id.slice(7)) as [Harness,string]:undefined;
  if(logical&&!enrollment?.harnesses.includes(logical[0]))return; // revoked enrollment cannot be restored by an old discovery job
  const report=await indexAll({db,root:this.root,potsherdDir:this.root,...(enrollment?.options??{}),...(enrollment?{harnesses:enrollment.harnesses}:{}),...(capture??{}),embed:false,...(logical?{harnesses:[logical[0]],sessionId:logical[1]}:!capture&&j.kind==='capture'&&j.target_id!=='*'?{sessionId:j.target_id}:{}),beforeCommit:()=>{this.controller.signal.throwIfAborted();assertFence(db,f);}});
  const requestedSourceMissing=Boolean(capture?.sessionId)&&report.harnesses.every(h=>h.discovered===0);
  if(capture)recordCaptureResult(db,f,j,report,report.totals.failed===0&&!requestedSourceMissing);
  if(requestedSourceMissing)throw new Error('requested_source_unavailable');
  if(report.totals.failed)throw new Error('capture_failed');
 }
 async runExplicit<T>(operation:(beforeCommit:()=>void)=>Promise<T>|T):Promise<T>{if(!this.db)this.db=this.options.db??openMaintenanceDb(this.root);if(!this.acquire())throw new Error('maintenance_busy');return operation(()=>{this.controller.signal.throwIfAborted();assertFence(this.db!,this.fence!);});}
 async drainOnce():Promise<void>{if(!this.db)this.db=this.options.db??openMaintenanceDb(this.root);this.pass=this.drain().finally(()=>{this.pass=null;});await this.pass;}
 close():Promise<void>{
  if(this.closing)return this.closing;
  this.stopped=true;if(this.timer)clearInterval(this.timer);if(this.heart)clearInterval(this.heart);
  const pass=this.pass;this.closing=Promise.resolve().then(()=>this.finishClose(pass));
  this.controller.abort(new Error('worker_closed'));return this.closing;
 }
 private async finishClose(pass:Promise<void>|null):Promise<void>{
  let failure:unknown;const record=(stage:string,error:unknown)=>{failure??=error;this.cleanupFailures.push({stage,errorHash:hash(error instanceof Error?error.message:String(error))});};
  try{try{await this.encoder.close();}catch(error){record('encoder',error);}await pass?.catch(()=>{});}
  finally{
   const db=this.db;
   try{try{this.workset?.close();}catch(error){record('temporary_workset',error);}finally{if(this.workset?.cleanup)this.progressCleanup.push(this.workset.cleanup);this.workset=null;}}
   finally{
    try{if(db&&this.fence){try{db.transaction(()=>{assertFence(db,this.fence!);db.prepare("UPDATE maintenance_jobs SET state='retry',owner_token=NULL,lease_generation=NULL,next_attempt_at=?,error_code='worker_interrupted' WHERE state='running' AND owner_token=? AND lease_generation=?").run(new Date().toISOString(),this.fence!.ownerToken,this.fence!.generation);releaseLease(db,this.fence!);}).immediate();}catch(error){if(!(error instanceof Error&&error.message==='lease_superseded'))record('owned_lease',error);}}}
    finally{try{if(db&&!this.options.db)db.close();}catch(error){record('owned_database',error);}finally{this.db=null;}}
   }
  }
  // Teardown failure is explicit; it never reverses acknowledged durable data.
  if(failure)throw failure;
 }

}

/** Consistent pre-upgrade SQLite snapshot, including committed WAL pages. */
export function prepareMigration(root:string):string|null {
 const file=dbPath(root);if(!fs.existsSync(file))return null;const db=openSqliteReadOnly(file);
 try {if(schemaVersion(db)>=MEMORY_SCHEMA_VERSION)return null;const check=db.prepare('PRAGMA integrity_check').all() as Record<string,unknown>[];if(check.length!==1||Object.values(check[0]!)[0]!=='ok')throw new Error('integrity_check_failed');
  const dir=path.join(root,'backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});const backup=path.join(dir,`pre-memory-${Date.now()}-${process.pid}.db`);db.prepare('VACUUM INTO ?').run(backup);fs.chmodSync(backup,0o600);const fd=fs.openSync(backup,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const parent=fs.openSync(dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}return backup;
 }finally{db.close();}
}
export async function withPublicationLease<T>(root:string,operation:(db:Db,beforeCommit:()=>void)=>Promise<T>):Promise<T>{
 prepareMigration(root);let db:Db;try{db=openMaintenanceDb(root);}catch(error){if(error instanceof Error&&error.message==='unsupported_future_schema')throw error;db=open({root});}const worker=new MaintenanceWorker(root,{db});try{return await worker.runExplicit(beforeCommit=>operation(db,beforeCommit));}finally{await worker.close();db.close();}
}
