import { afterEach, describe, expect, it } from 'vitest';
import { open } from '../packages/core/src/db.js';
import { hash } from '../packages/core/src/memory/spans.js';
import { publishSource, readSpan } from '../packages/core/src/memory/source.js';
import { LocalMemoryService } from '../packages/core/src/memory/service.js';
import { defaultBudget, countTokens } from '../packages/core/src/memory/budget.js';
import type { MemoryResponse, EvidenceRecord } from '../packages/core/src/memory/contracts.js';
import type { ParseResult } from '../packages/core/src/adapters/types.js';
import type { Db } from '../packages/core/src/db.js';
const dbs:Db[]=[];afterEach(()=>dbs.splice(0).forEach((db)=>db.close()));
function store(){const db=open({file:':memory:'});dbs.push(db);return db;}
function publish(db:Db,id:string,text:string,branch='main',project='/p',role:EvidenceRecord['role']='assistant') {
 const parsed:ParseResult={session:{id,harness:'claude',sourcePath:'/synthetic/'+id,project,projectSlug:'p',gitBranch:branch,startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:0,assistantTurns:1,toolCalls:0,bytes:text.length},status:'live'},exchanges:[],unknownTypes:{},endOffset:text.length,malformedLines:0,evidenceVersion:'test-v1',records:[{unitKey:'record',role,text,eventAt:'2026-01-01T00:00:00Z',timeBasis:'record',branch,project,seq:1,locator:{recordKey:'record',mapping:'unavailable'},locatorFidelity:'record_id',recordType:role}]};
 return publishSource(db,{parsed,artifactHash:hash(text),artifactBytes:text.length,tokenizer:{id:'test-scalar-fixture',assetHash:'test-only',count:(text)=>Array.from(text).length,sourceBoundaries(text){return [0,...Array.from(text).reduce<number[]>((ends,c)=>{ends.push((ends.at(-1)??0)+c.length);return ends;},[])].map((offsetUtf16,tokenEndOrdinal)=>({offsetUtf16,tokenEndOrdinal}));},boundaries(text){return [0,...Array.from(text).reduce<number[]>((ends,c)=>{ends.push((ends.at(-1)??0)+c.length);return ends;},[])];}}});
}
function asResponse(value:unknown){return value as MemoryResponse;}
describe('public immutable memory service',()=>{
 it('protects punctuation/case/scope in literal mode and proves only literal existence',async()=>{
  const db=store();publish(db,'other','cache.X_9','other');publish(db,'right','cache.X_9');publish(db,'near','cache.x_9');
  const service=new LocalMemoryService(db,{transport:'mcp'});
  const planned=await service.recall({query:'cache.X_9',mode:'literal',scope:{branch:'main'},budget:defaultBudget()});
  const result=asResponse(planned.response);
  expect(result.evidence).toHaveLength(1);expect(result.evidence[0]!.text).toBe('cache.X_9');expect(result.support.state).toBe('sufficient');
  expect(result.budget.usedTokens).toBe(countTokens(planned.serialized));
 });
 it('keeps independent scoped lexical and dense candidates with unassessed semantics',async()=>{
  const db=store();const a=publish(db,'one','airflow job scheduler');const b=publish(db,'two','recurring wakeups recovered');
  const ids=db.prepare('SELECT span_id FROM revision_spans WHERE revision_id=?').all(b.revisionId) as {span_id:string}[];
  const service=new LocalMemoryService(db,{dense:{async search(){return {state:'ready',candidates:[{ref:{...b,spanId:ids[0]!.span_id},score:1,lanes:['dense']}]};}}});
  const result=asResponse((await service.recall({query:'airflow recurring recovery',scope:{project:'/p'},budget:defaultBudget()})).response);
  expect(new Set(result.evidence.map((e)=>e.ref.sourceId))).toEqual(new Set([a.sourceId,b.sourceId]));expect(result.support.state).toBe('unassessed');
 });
 it('does not equate index failure with absence',async()=>{
  const db=store();db.exec('DROP TABLE spans_fts');const service=new LocalMemoryService(db);
  const result=asResponse((await service.recall({query:'cache',scope:{},budget:defaultBudget()})).response);
  expect(result.coverage.state).toBe('unavailable');expect(result.warnings).toContain('retrieval_failed');expect(result.support.state).toBe('insufficient');
 });
 it('retains exact historical reads and reports a changed current cursor',()=>{
  const db=store();const first=publish(db,'one','cache '.repeat(4000));const service=new LocalMemoryService(db);
  const initial=asResponse(service.read({legacyRef:{sessionId:'one'},scope:{},budget:defaultBudget(1600)}).response);
  expect(initial.continuation).toBeTruthy();
  publish(db,'one','new current value');
  const changed=asResponse(service.read({cursor:initial.continuation,scope:{},budget:defaultBudget(1600)}).response);
  expect(changed.coverage.state).toBe('partial');expect(changed.warnings).toContain('snapshot_changed');
  const historical=asResponse(service.read({refs:[initial.evidence[0]!.ref],scope:{},budget:defaultBudget()}).response);
  expect(historical.evidence[0]!.historical).toBe(true);
  expect(historical.evidence[0]!.text).toBe(readSpan(db,initial.evidence[0]!.ref)!.text);
 });
 it('grafts evidence deterministically without a backend or external write',async()=>{
  const db=store();publish(db,'one','The cache invalidation recovered.');const service=new LocalMemoryService(db);
  const result=asResponse((await service.graft({query:'cache invalidation',scope:{},budget:defaultBudget()})).response);
  expect(result.evidence[0]!.text).toContain('recovered');expect(result.support.state).toBe('unassessed');
 });
});
