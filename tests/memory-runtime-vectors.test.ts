import { testModelCache } from './model-cache.js';
import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {open} from '../packages/core/src/db.js';import type {ParseResult} from '../packages/core/src/adapters/types.js';
import {publishSource} from '../packages/core/src/memory/source.js';
import {hash,spanEmbeddingText} from '../packages/core/src/memory/spans.js';
import {claimLease,releaseLease} from '../packages/core/src/memory/leases.js';
import {claimJob} from '../packages/core/src/memory/jobs.js';
import {ensureSpanSpace,commitSpanVector,MaintenanceWorker} from '../packages/core/src/memory/maintenance.js';
import {DEFAULT_SPACE_ID,LocalEncoder,inspectAssets} from '../packages/core/src/memory/assets.js';
import {loadSpanTokenizer} from '../packages/core/src/memory/tokenization.js';
import {SpanDenseLane} from '../packages/core/src/memory/dense.js';
import {readEpochs} from '../packages/core/src/memory/source.js';
const cache=testModelCache('/nonexistent/potsherd-test-models');
function parsed(id:string,text:string,project='/p'):ParseResult {return {session:{id,harness:'claude',sourcePath:'/synthetic/'+id,project,projectSlug:'p',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:0,assistantTurns:1,toolCalls:0,bytes:text.length},status:'live'},records:[{unitKey:'a',role:'assistant',text,eventAt:null,timeBasis:'unknown',project,locator:{recordKey:'a',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'assistant'}],exchanges:[],unknownTypes:{},endOffset:text.length,malformedLines:0,evidenceVersion:'runtime-test'};}
describe('revision fenced span vectors',()=>{
 it('retains old revision vectors without stamping new content and rejects wrong hashes and replacement owners',()=>{const db=open({file:':memory:'});try{ensureSpanSpace(db);const a=publishSource(db,{parsed:parsed('one','old text'),artifactHash:hash('old'),artifactBytes:3});const f=claimLease(db,'maintenance')!,j=claimJob(db,f)!;const p=db.prepare('SELECT span_id,embedding_input_hash FROM evidence_spans').get() as {span_id:string;embedding_input_hash:string};const v=Array(384).fill(0);v[0]=1;expect(commitSpanVector(db,f,j,p.span_id,'wrong',v)).toBe(false);publishSource(db,{parsed:parsed('one','new text'),artifactHash:hash('new'),artifactBytes:3});expect(commitSpanVector(db,f,j,p.span_id,p.embedding_input_hash,v)).toBe(true);expect(db.prepare('SELECT COUNT(*) n FROM span_embeddings e JOIN revision_spans rs ON rs.span_id=e.span_id JOIN memory_sources s ON s.active_revision_id=rs.revision_id').get()).toMatchObject({n:0});releaseLease(db,f);const replacement=claimLease(db,'maintenance')!;expect(()=>commitSpanVector(db,f,j,p.span_id,p.embedding_input_hash,v)).toThrow('lease_superseded');expect(replacement.generation).toBe(f.generation+1);expect(db.prepare('SELECT COUNT(*) n FROM span_embeddings').get()).toMatchObject({n:1});}finally{db.close();}});
 it.skipIf(inspectAssets(cache).state!=='ready')('runs real cached offline WASM span encoding, pooling separation and bounded cancellation',async()=>{const encoder=new LocalEncoder(cache);try{
  const tokenizer=await loadSpanTokenizer(cache);expect(tokenizer).toBeTruthy();
  const input='The recurring scheduler recovers interrupted durable jobs.';
  const mean=await encoder.encode(input);expect(mean.length).toBe(384);expect(Math.sqrt(mean.reduce((s,v)=>s+v*v,0))).toBeCloseTo(1,4);
  const cls=await encoder.encode(input,undefined,false,'cls');expect(cls.length).toBe(384);expect(mean.some((v,i)=>Math.abs(v-cls[i]!)>1e-4)).toBe(true);
  const controller=new AbortController(),start=Date.now();const pending=encoder.encode('interrupted work '.repeat(100),controller.signal);setTimeout(()=>controller.abort(new Error('test_cancel')),1);await expect(pending).rejects.toThrow('test_cancel');await encoder.close();expect(Date.now()-start).toBeLessThan(5000);
 }finally{await encoder.close();}},45000);
 it.skipIf(inspectAssets(cache).state!=='ready')('prefilters project/history/input-hash/ignore eligibility before dense top-k',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p12-dense-')),db=open({root});const encoder=new LocalEncoder(cache);
  try{const tokenizer=(await loadSpanTokenizer(cache))!;ensureSpanSpace(db);
   const sources=[];for(const [id,project] of [['good','/p'],['ignored','/ignored'],['other','/other']] as const)sources.push(publishSource(db,{parsed:parsed(id,'scheduler crash recovery',project),artifactHash:hash(id),artifactBytes:id.length,tokenizer}));
   const fence=claimLease(db,'maintenance')!;const vector=await encoder.encode('scheduler crash recovery');let job;while(job=claimJob(db,fence)){for(const p of db.prepare('SELECT p.* FROM evidence_spans p JOIN revision_spans rs ON rs.span_id=p.span_id WHERE rs.revision_id=?').all(job.target_revision_id) as {span_id:string;embedding_input_hash:string}[])commitSpanVector(db,fence,job,p.span_id,p.embedding_input_hash,vector);db.prepare("UPDATE maintenance_jobs SET state='done' WHERE job_id=?").run(job.job_id);}
   fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({ignore:['/ignored']}));
   const lane=new SpanDenseLane(db,{root,cacheDir:cache,encoder});const result=await lane.search({query:'scheduler',scope:{project:'/p'},snapshotEpochs:readEpochs(db),limit:1});expect(result.state).toBe('ready');expect(result.candidates[0]!.ref.sourceId).toBe(sources[0]!.sourceId);
   db.prepare('UPDATE span_embeddings SET input_hash=? WHERE span_id IN (SELECT span_id FROM revision_spans WHERE revision_id=?)').run('stale',sources[0]!.revisionId);
   const stale=await lane.search({query:'scheduler',scope:{project:'/p'},snapshotEpochs:readEpochs(db),limit:1});expect(stale.candidates).toHaveLength(0);expect(stale.state).toBe('building');
  }finally{await encoder.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
 },45000);
});
