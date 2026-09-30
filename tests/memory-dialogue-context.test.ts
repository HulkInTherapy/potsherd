import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {open} from '../packages/core/src/db.js';
import {publishSource,listSourceSpans,readSpan} from '../packages/core/src/memory/source.js';
import {adjacentDialogueContext,flattenDialogueGroups} from '../packages/core/src/memory/dialogue-context.js';
import {LocalMemoryService} from '../packages/core/src/memory/service.js';
import {defaultBudget} from '../packages/core/src/memory/budget.js';
import {scopeSql} from '../packages/core/src/memory/scope.js';
import {retrievalIntent} from '../packages/core/src/memory/retrieval.js';
import {hash} from '../packages/core/src/memory/spans.js';
import type {ParseResult} from '../packages/core/src/adapters/types.js';
import type {EvidenceRecord} from '../packages/core/src/memory/contracts.js';
function fixture(records:Partial<EvidenceRecord>[]){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dialogue-context-')),db=open({root});
 const parsed:ParseResult={session:{id:'synthetic-dialogue',harness:'claude',sourcePath:'/owned/synthetic',project:'/context',projectSlug:'context',gitBranch:'main',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:0,assistantTurns:0,toolCalls:0,bytes:0},status:'live'},exchanges:[],unknownTypes:{},endOffset:0,malformedLines:0,evidenceVersion:'synthetic-context-v1',records:records.map((record,i)=>({unitKey:'record-'+i,role:'assistant',text:'',eventAt:`2026-01-01T00:00:0${i}.000Z`,timeBasis:'record',project:'/context',branch:'main',locator:{recordKey:'record-'+i,mapping:'unavailable'},locatorFidelity:'record_id',recordType:'synthetic',...record}))};
 const pub=publishSource(db,{parsed,artifactHash:hash(JSON.stringify(records)),artifactBytes:0});
 const all=listSourceSpans(db,pub.sourceId,undefined,0,100).evidence;
 return {root,db,all,close(){db.close();fs.rmSync(root,{recursive:true,force:true});}};
}
const filter=()=>scopeSql({project:'/context',branch:'main'});
const query='What recovery policy governs the application?';
describe('bounded scoped dialogue context',()=>{
 it('retains neighboring paraphrased human choices for explicit backward comparison',()=>{
  const f=fixture([{role:'user',text:'Use replay offset as the cursor.'},{text:'The previous choice is recorded for comparison.'},{role:'user',text:'Use committed batch UUID as the cursor.'},{text:'This replaces the earlier choice because checkpoints advanced after socket close.'}]);
  try{expect(adjacentDialogueContext(f.db,[f.all.at(-1)!],query,filter())[0]!.context.map(x=>x.text)).toEqual(['Use replay offset as the cursor.','Use committed batch UUID as the cursor.']);}finally{f.close();}
 });
 it('recovers both short human choices while keeping attribution and chronology explicit',()=>{
  const f=fixture([{role:'user',text:'Clear the global cookie jar first.'},{text:'The global cookie jar is the original plan.'},{role:'user',text:'Instead clear the matching partitioned cookie jar.'},{text:'The partitioned cookie jar replaces clearing the global cookie jar because the embedded browser has a separate partition.'}]);
  try{const anchor=f.all.at(-1)!;const groups=adjacentDialogueContext(f.db,[anchor],query,filter());expect(groups[0]!.context.map(x=>x.text)).toEqual(['Clear the global cookie jar first.','Instead clear the matching partitioned cookie jar.']);
   const delivered=flattenDialogueGroups(groups);expect(delivered.map(x=>x.role)).toEqual(['user','user','assistant']);expect(delivered.at(-1)).toEqual(anchor);
   for(const item of delivered){const source=readSpan(f.db,item.ref)!;expect(item.text).toBe(source.text.slice(item.startUtf16-source.startUtf16,item.endUtf16-source.startUtf16));expect(item.authority).toBe('source_evidence');}
  }finally{f.close();}
 });
 it('does not link unrelated adjacent chatter merely because it repeats the queried entity',()=>{
  const f=fixture([{role:'user',text:'For application recovery policy, order lunch and replace the menu.'},{text:'For application recovery policy, clear the matching partitioned cookie jar.'}]);
  try{expect(adjacentDialogueContext(f.db,[f.all.at(-1)!],query,filter())[0]!.context).toEqual([]);}finally{f.close();}
 });
 it('applies branch, event and deletion eligibility before expanding context',()=>{
  const f=fixture([{role:'user',text:'Clear the global cookie jar.',branch:'private-branch'},{text:'Use the partitioned cookie jar, not the global cookie jar.'}]);
  try{const anchor=f.all.at(-1)!;expect(adjacentDialogueContext(f.db,[anchor],query,filter())[0]!.context).toEqual([]);
   expect(adjacentDialogueContext(f.db,[anchor],query,scopeSql({project:'/other'}))[0]!.context).toEqual([]);
   const eventFilter=scopeSql({project:'/context',eventFrom:'2026-01-01T00:00:01Z'});expect(adjacentDialogueContext(f.db,[anchor],query,eventFilter)[0]!.context).toEqual([]);
   f.db.prepare("UPDATE memory_sources SET availability='forgotten'").run();expect(adjacentDialogueContext(f.db,[anchor],query,scopeSql({project:'/context'}))[0]!.context).toEqual([]);
  }finally{f.close();}
 });
 it('keeps every long-source anchor range and completes multi-span context without a one-span cap',()=>{
  const previous='Clear matching cookie partitions. '.repeat(19),reply='Matching cookie partitions need explicit clearing. '.repeat(45);
  const f=fixture([{role:'user',text:previous},{text:reply}]);
  try{const anchors=f.all.filter(x=>x.role==='assistant');expect(anchors.length).toBeGreaterThan(1);
   const groups=adjacentDialogueContext(f.db,anchors,'cookie policy',filter(),{maxUnitUtf16:1024,maxTotalUtf16:2048});const context=groups.flatMap(x=>x.context);
   expect(context.length).toBeGreaterThan(1);expect(context.map(x=>x.text).join('')).toBe(previous);
   const delivered=flattenDialogueGroups(groups);for(const anchor of anchors)expect(delivered).toContainEqual(anchor);
   for(const item of context){const original=readSpan(f.db,item.ref)!;expect(item.text).toBe(original.text.slice(item.startUtf16-original.startUtf16,item.endUtf16-original.startUtf16));}
  }finally{f.close();}
 });
 it('declines incomplete context when the text allowance cannot fit a whole short unit',()=>{
  const f=fixture([{role:'user',text:'Clear the global cookie jar.'},{text:'The partitioned cookie jar replaces the global cookie jar.'}]);
  try{const anchor=f.all.at(-1)!;const groups=adjacentDialogueContext(f.db,[anchor],query,filter(),{maxTotalUtf16:8});expect(groups[0]!.context).toEqual([]);expect(flattenDialogueGroups(groups)).toEqual([anchor]);}finally{f.close();}
 });
});


describe('public dialogue navigation intent',()=>{
 const records=[{role:'user' as const,text:'Clear the global cookie jar first.'},{text:'The global cookie jar is the original plan.'},{role:'user' as const,text:'Instead clear the matching partitioned cookie jar.'},{text:'The recovery choice currently governing is to clear the matching partitioned cookie jar rather than the global cookie jar. The diagnosis is that the embedded browser stores cookies in a separate partition.'}];
 it('delivers both human records for a governing-choice question through public recall',async()=>{
  const f=fixture(records);try{const service=new LocalMemoryService(f.db);const result=await service.recall({query:'What recovery choice currently governs?',scope:{project:'/context',branch:'main'},budget:defaultBudget(4096)});
   expect(result.response.evidence.filter(x=>x.role==='user').map(x=>x.text)).toEqual([records[0]!.text,records[2]!.text]);
   expect(result.response.support.state).toBe('unassessed');
  }finally{f.close();}
 });
 it('retains the diagnosis anchor without prioritizing decision context for a diagnosis question',async()=>{
  const f=fixture(records);try{const service=new LocalMemoryService(f.db);const result=await service.recall({query:'Explain the historical diagnosis of the embedded browser',scope:{project:'/context',branch:'main'},budget:defaultBudget(2048)});
   expect(result.response.evidence.some(x=>x.text.includes('embedded browser'))).toBe(true);expect(result.response.evidence.some(x=>x.role==='user')).toBe(false);
  }finally{f.close();}
 });
 it('does not expand the literal path with nonmatching human dialogue',async()=>{
  const f=fixture(records);try{const service=new LocalMemoryService(f.db);const result=await service.recall({query:'embedded browser',mode:'literal',scope:{project:'/context',branch:'main'},budget:defaultBudget(2048)});
   expect(result.response.evidence.length).toBeGreaterThan(0);expect(result.response.evidence.every(x=>x.role==='assistant')).toBe(true);expect(result.response.support.state).toBe('sufficient');
  }finally{f.close();}
 });
});

it('does not confuse parent/child authority with historical decision comparison',()=>{expect(retrievalIntent('What did the verifier child actually report, and is it an adopted parent decision?').requestForDecisionContext).toBe(false);expect(retrievalIntent('What previous parent decision did the child replace?').requestForDecisionContext).toBe(true);});

it('retrieves earlier diagnostic source identity rather than only a later recap',async()=>{
 const f=fixture([{text:'Lease renewal used wall time across a clock transition.'},{role:'tool_result',text:'Observed lease renewal used wall time across a clock transition.'},{text:'The deployment schedule is unrelated.'},{text:'This replaces the earlier choice: lease renewal used wall time across a clock transition.'}]);
 try{const service=new LocalMemoryService(f.db);const result=await service.recall({query:'Use the historical diagnosis of clock transition',scope:{project:'/context',branch:'main'},budget:defaultBudget(4096)});expect(result.response.evidence.some(x=>x.ref.spanId===f.all[0]!.ref.spanId)).toBe(true);expect(result.response.evidence.some(x=>x.text==='The deployment schedule is unrelated.')).toBe(false);expect(result.response.support.state).toBe('unassessed');}finally{f.close();}
});
