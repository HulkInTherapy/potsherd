import { testModelCache } from './model-cache.js';
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {open} from '../packages/core/src/db.js';
import type {ParseResult} from '../packages/core/src/adapters/types.js';
import {hash} from '../packages/core/src/memory/spans.js';
import {publishSource,readEpochs} from '../packages/core/src/memory/source.js';
import {LocalMemoryService} from '../packages/core/src/memory/service.js';
import {defaultBudget} from '../packages/core/src/memory/budget.js';
import {MaintenanceWorker} from '../packages/core/src/memory/maintenance.js';
import {loadSpanTokenizer} from '../packages/core/src/memory/tokenization.js';
import {SpanDenseLane} from '../packages/core/src/memory/dense.js';
import {inspectAssets} from '../packages/core/src/memory/assets.js';
function parsed(text:string,sourcePath='/synthetic/activation',status:'live'|'archived'='live'):ParseResult{return {session:{id:'activation-source',harness:'claude',sourcePath,project:'/activation',projectSlug:'activation',gitBranch:'main',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:1,assistantTurns:0,toolCalls:0,bytes:0},status},records:[{unitKey:'record',role:'user',text,eventAt:'2025-12-01T00:00:00Z',timeBasis:'record',project:'/activation',branch:'main',locator:{recordKey:'record',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'user'}],exchanges:[],unknownTypes:{},endOffset:text.length,malformedLines:0,evidenceVersion:'activation-test'};}
const cache=testModelCache('/nonexistent/potsherd-test-models');
const scope={project:'/activation',branch:'main',asOf:'2026-02-01T00:00:00Z'};
const recall=async(service:LocalMemoryService,query:string,learnedBy:string,includeHistory=false)=> (await service.recall({query,mode:'literal',scope:{...scope,learnedBy,...(includeHistory?{includeHistory:true}:{})},budget:defaultBudget()})).response as any;
describe('historical dense maintenance',()=>{
 it.skipIf(inspectAssets(cache).state!=='ready')('maintains missing historical span vectors and prefilters dense to the actual known snapshot',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'p12-activation-dense-'));fs.symlinkSync(cache,path.join(root,'models'),'dir');const db=open({root}),worker=new MaintenanceWorker(root,{db});const lane=new SpanDenseLane(db,{root,cacheDir:path.join(root,'models')});try{const tokenizer=(await loadSpanTokenizer(path.join(root,'models')))!;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));const a=publishSource(db,{parsed:parsed('HISTORICAL_OLD origin scheduler'),artifactHash:'A',artifactBytes:1,tokenizer});db.prepare("UPDATE maintenance_jobs SET state='done' WHERE target_revision_id=?").run(a.revisionId);vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));const b=publishSource(db,{parsed:parsed('CURRENT_NEW replaced scheduler'),artifactHash:'B',artifactBytes:1,tokenizer});vi.useRealTimers();const query={query:'origin scheduler',scope:{...scope,learnedBy:'2026-01-01T00:00:00Z'},snapshotEpochs:readEpochs(db),limit:64};const missing=await lane.search(query);expect(missing.state).toBe('building');await worker.drainOnce();const historical=await lane.search({...query,snapshotEpochs:readEpochs(db)});expect(historical.state).toBe('ready');expect(historical.candidates.length).toBeGreaterThan(0);expect(historical.candidates.every(c=>c.ref.revisionId===a.revisionId)).toBe(true);const current=await lane.search({...query,scope:{project:'/activation'},snapshotEpochs:readEpochs(db)});expect(current.candidates.every(c=>c.ref.revisionId===b.revisionId)).toBe(true);expect(db.prepare('SELECT observed_at FROM source_revisions WHERE revision_id=?').get(a.revisionId)).toMatchObject({observed_at:'2026-01-01T00:00:00.000Z'});}finally{vi.useRealTimers();await lane.close();await worker.close();db.close();fs.rmSync(root,{recursive:true,force:true});}},30000);
});
