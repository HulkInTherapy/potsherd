import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import process from 'node:process';
import {db as store,paths,lock,prepareMigration,MaintenanceWorker,acquireAssets,inspectAssets,runtimeHealth,enqueueJob,spoolRequest,indexAll,backfillLegacy,backfillLegacyGhosts,backfillLegacyNotes,rebuildEvidenceSpans,readEnrolledSources,loadSpanTokenizer,currentSpanPolicy,SPAN_MANIFEST_VERSION} from '@potsherd/core';
import {MEMORY_SCHEMA_VERSION,assertMemorySchema} from '../../../core/src/memory/readiness.js';
import {print,printJson,type GlobalOptions} from '../output.js';
type MaintainOptions=GlobalOptions&{acquireAssets?:boolean;migrate?:boolean;rebuild?:boolean;enqueueSession?:string;enqueueOnly?:boolean;drain?:boolean};
export async function runMaintain(o:MaintainOptions):Promise<number>{
 const root=paths.potsherdDir(o.potsherdDir);
 if(o.enqueueSession){spoolRequest(root,{kind:'capture',targetId:o.enqueueSession,inputHash:randomUUID()});if(o.enqueueOnly)return 0;}
 const next={...o,enqueueSession:undefined};
 return o.migrate?lock.withLockAsync('maintain',()=>runMaintainUnlocked(next),{root,wait:2000}):runMaintainUnlocked(next);
}
async function runMaintainUnlocked(o:GlobalOptions&{acquireAssets?:boolean;migrate?:boolean;rebuild?:boolean;enqueueSession?:string;enqueueOnly?:boolean;drain?:boolean}):Promise<number> {
 const root=paths.potsherdDir(o.potsherdDir);
 if(o.enqueueSession){
  const request={kind:'capture' as const,targetId:o.enqueueSession,inputHash:randomUUID()};
  // Durable ingress happens before trying SQLite so open/lock failures preserve work.
  spoolRequest(root,request);
  if(o.enqueueOnly)return 0;
 }
 if(!fs.existsSync(paths.dbPath(root))&&!o.migrate){if(o.json)printJson({state:'initialization_required'});else if(!o.quiet)print('Memory initialization required: run potsherd maintain --migrate.');return 1;}
 let db:store.Db;
 if(o.migrate){prepareMigration(root);db=store.open({root});}else{const reader=store.openSqliteReadOnly(paths.dbPath(root));try{assertMemorySchema(reader);}finally{reader.close();}db=store.open({root});}
 const worker=new MaintenanceWorker(root,{db});const stop=()=>{void worker.close();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try {
  if(o.migrate)enqueueJob(db,{kind:'rebuild',targetId:`migration:${MEMORY_SCHEMA_VERSION}`,inputHash:`memory-schema:${MEMORY_SCHEMA_VERSION}`});
  if(o.acquireAssets){await acquireAssets(paths.modelsDir(root));o.rebuild=true;}
  if(o.rebuild){
   const tokenizer=await loadSpanTokenizer(paths.modelsDir(root));
   if(!tokenizer)throw new Error('missing_verified_tokenizer');
   enqueueJob(db,{kind:'rebuild',targetId:'spans:'+currentSpanPolicy(tokenizer),inputHash:SPAN_MANIFEST_VERSION+':'+currentSpanPolicy(tokenizer)});
   await worker.runExplicit(beforeCommit=>{rebuildEvidenceSpans(db,{tokenizer,beforeCommit,limit:Number.MAX_SAFE_INTEGER});db.prepare("UPDATE maintenance_jobs SET state='pending',next_attempt_at=?,error_code=NULL WHERE state='blocked' AND error_code='span_rebuild_required'").run(new Date().toISOString());});
   // Explicit rebuild regenerates spans from enrolled source bytes; never deletes the ledger.
   const enrollment=readEnrolledSources(db);
   if(enrollment){const report=await worker.runExplicit(beforeCommit=>indexAll({beforeCommit,db,root,potsherdDir:root,...enrollment.options,harnesses:enrollment.harnesses,full:true,embed:false}));if(report.totals.failed)throw new Error('rebuild_capture_failed');}
  }
  if(o.migrate){await worker.runExplicit(beforeCommit=>db.transaction(()=>{beforeCommit();backfillLegacy(db,{limit:Number.MAX_SAFE_INTEGER});backfillLegacyGhosts(db,Number.MAX_SAFE_INTEGER);while(backfillLegacyNotes(db,100)>0)beforeCommit();}).immediate());}
  await worker.drainOnce();
  const health=runtimeHealth(db),assets=inspectAssets(paths.modelsDir(root));
  const operationalDebt=(db.prepare("SELECT COUNT(*) n FROM maintenance_jobs WHERE state IN('pending','running','retry','blocked') AND kind<>'embed'").get() as {n:number}).n;
  const captureFailures=(db.prepare('SELECT COUNT(*) n FROM capture_checkpoints WHERE error_code IS NOT NULL').get() as {n:number}).n;
  const initialization={state:operationalDebt||captureFailures?'pending':'ready',schemaVersion:MEMORY_SCHEMA_VERSION};
  if(o.json)printJson({...health,assets,...(o.migrate?{initialization}: {})});else if(!o.quiet)print(`Memory maintenance: assets ${assets.state}; pending ${Object.values(health.debt).reduce((a,b)=>a+b,0)}; captured through ${health.capturedThrough??'unknown'}.`);
  if(o.migrate)return operationalDebt||captureFailures?1:0;
  return (health.debt.retry??0)+(health.debt.blocked??0)>0?1:0;
 }finally{process.off('SIGTERM',stop);process.off('SIGINT',stop);await worker.close();db.close();}
}
