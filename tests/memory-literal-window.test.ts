import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {open,type Db} from '../packages/core/src/db.js';
import {publishSource,readSpan,sourceId} from '../packages/core/src/memory/source.js';
import {hash,identity,buildSpanManifest,type SpanTokenizer} from '../packages/core/src/memory/spans.js';
import {LocalMemoryService} from '../packages/core/src/memory/service.js';
import {countTokens,defaultBudget,safeBoundary} from '../packages/core/src/memory/budget.js';
import {assessSupport,deliveredLiteralRefs} from '../packages/core/src/memory/support.js';
import {fullUnitLiteralCandidates,knownLiteralMatches,selectEvidence,LITERAL_EXPANSION_LIMIT,literalSearchLimited} from '../packages/core/src/memory/retrieval.js';
import {scopeSql} from '../packages/core/src/memory/scope.js';
import {applyForget} from '../packages/core/src/memory/delete.js';
import {writeIgnoreList} from '../packages/core/src/ignore.js';
import type {EvidenceItem,EvidenceRecord,MemoryResponse,Scope} from '../packages/core/src/memory/contracts.js';
import type {ParseResult} from '../packages/core/src/adapters/types.js';

const ends=(text:string)=>[0,...Array.from(text).reduce<number[]>((result,character)=>{result.push((result.at(-1)??0)+character.length);return result;},[])];
const tokenizer:SpanTokenizer={id:'literal-synthetic-scalar',assetHash:'synthetic-only',count:text=>Array.from(text).length,boundaries:ends,sourceBoundaries:text=>ends(text).map((offsetUtf16,tokenEndOrdinal)=>({offsetUtf16,tokenEndOrdinal}))};
const stores:{db:Db;root:string}[]=[];
afterEach(()=>{for(const {db,root} of stores.splice(0)){db.close();fs.rmSync(root,{recursive:true,force:true});}});
function store(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'potsherd-literal-window-'));const db=open({root});stores.push({db,root});return {db,root};}
function publish(db:Db,id:string,text:string,overrides:Partial<EvidenceRecord>={},observedAt?:string){
 const record:EvidenceRecord={unitKey:'record',role:'assistant',text,eventAt:'2026-01-01T00:00:00Z',timeBasis:'record',project:'/synthetic/literal',branch:'main',locator:{recordKey:'one',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'assistant',...overrides};
 const parsed:ParseResult={session:{id,harness:'claude',sourcePath:'',project:record.project!,projectSlug:'literal',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:0,assistantTurns:1,toolCalls:0,bytes:Buffer.byteLength(text)},status:'archived'},exchanges:[],records:[record],evidenceVersion:'literal-synthetic-v1',unknownTypes:{},endOffset:Buffer.byteLength(text),malformedLines:0};
 return publishSource(db,{parsed,artifactHash:hash(id+text+JSON.stringify(overrides)),artifactBytes:Buffer.byteLength(text),tokenizer,observedAt});
}
function windows(db:Db,rid:string){return db.prepare('SELECT p.span_id,p.start_utf16 start,p.end_utf16 end,p.text FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id WHERE rs.revision_id=? ORDER BY rs.ordinal').all(rid) as {span_id:string;start:number;end:number;text:string}[];}
/** Build genuinely separate historical synthetic rows, never rewrite a publication. */
function historical(db:Db,id:string,text:string){
 const sid=sourceId('claude',id),norm='redacted-evidence-v2',unit=identity('historical-unit',sid,text),manifest=buildSpanManifest(text,tokenizer),rid=identity('historical-revision',sid,text),at='2026-01-01T00:00:00.000Z';
 db.prepare("INSERT INTO memory_sources VALUES(?,?,?,NULL,?,'archived',?)").run(sid,'claude',id,'/synthetic/literal',at);
 db.prepare('INSERT INTO source_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,sid,hash(text),Buffer.byteLength(text),null,'literal-synthetic-v1',norm,hash(JSON.stringify(manifest)),at,at,at,'/synthetic/literal','main','complete',JSON.stringify({chunkPolicy:manifest.policy}));
 db.prepare('INSERT INTO evidence_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(unit,sid,'record','assistant',text,hash(text),norm,null,null,null,at,'record','/synthetic/literal','main','{}','record_id',null,null);db.prepare('INSERT INTO revision_units VALUES(?,?,0)').run(rid,unit);
 for(const [i,w] of manifest.windows.entries()) {const span=identity(unit,String(w.startUtf16),String(w.endUtf16));const inserted=db.prepare('INSERT INTO evidence_spans(span_id,unit_revision_id,start_utf16,end_utf16,text,text_hash,chunk_policy,embedding_input_hash,embedding_context_json) VALUES(?,?,?,?,?,?,?,?,?)').run(span,unit,w.startUtf16,w.endUtf16,w.text,hash(w.text),w.chunkPolicy,w.embeddingInputHash,w.embeddingContextJson);db.prepare('INSERT INTO spans_fts(rowid,text) VALUES(?,?)').run(inserted.lastInsertRowid,w.text);db.prepare('INSERT INTO revision_spans VALUES(?,?,?)').run(rid,span,i);}
 db.prepare('UPDATE memory_sources SET active_revision_id=? WHERE source_id=?').run(rid,sid);db.prepare('INSERT INTO source_activation_baselines VALUES(?,?,1)').run(sid,at);db.prepare("INSERT INTO source_activations(source_id,revision_id,activated_at,evidence_epoch,basis) VALUES(?,?,?,0,'published')").run(sid,rid,at);
 return {sourceId:sid,revisionId:rid};
}
const source=Array.from({length:700},(_,i)=>`word${String(i).padStart(4,'0')}`).join(' ');
function boundary(text:string,ws:ReturnType<typeof windows>){const start=safeBoundary(text,ws[1]!.start-20),end=safeBoundary(text,ws[0]!.end+20);return {start,end,query:text.slice(start,end)};}
async function recall(db:Db,root:string,query:string,scope:Scope={project:'/synthetic/literal'},tokens=4096,options:ConstructorParameters<typeof LocalMemoryService>[1]={}){const planned=await new LocalMemoryService(db,{root,semanticDisabled:true,...options}).recall({query,mode:'literal',scope,budget:defaultBudget(tokens)});return {planned,response:planned.response as MemoryResponse};}
function checkRanges(db:Db,items:EvidenceItem[]){for(const item of items){const original=readSpan(db,item.ref)!;expect(item.text).toBe(original.text.slice(item.startUtf16-original.startUtf16,item.endUtf16-original.startUtf16));expect(item.endUtf16-item.startUtf16).toBe(item.text.length);expect(safeBoundary(original.text,item.startUtf16-original.startUtf16)).toBe(item.startUtf16-original.startUtf16);expect(safeBoundary(original.text,item.endUtf16-original.startUtf16)).toBe(item.endUtf16-original.startUtf16);if(item.startUtf16!==original.startUtf16||item.endUtf16!==original.endUtf16)expect(item.citation).toContain(`@${item.startUtf16}-${item.endUtf16}`);}}

describe('F12 bounded canonical-unit exact literals',()=>{
 it('delivers an exact phrase longer than the overlap that no stored window contains',async()=>{
  const {db,root}=store(),published=publish(db,'boundary',source),ws=windows(db,published.revisionId),hit=boundary(source,ws);
  expect(ws.some(w=>w.text.includes(hit.query))).toBe(false);expect(source.includes(hit.query)).toBe(true);
  const before=db.prepare('SELECT * FROM evidence_spans ORDER BY span_id').all();
  const {planned,response}=await recall(db,root,hit.query);
  expect(response.support.state).toBe('sufficient');expect(response.evidence).toHaveLength(2);expect(response.evidence.map(e=>e.text).join('')).toBe(hit.query);expect(response.support.requirements[0]!.refs).toHaveLength(2);
  expect(response.evidence.map(e=>[e.startUtf16,e.endUtf16])).toEqual([[hit.start,ws[0]!.end],[ws[0]!.end,hit.end]]);checkRanges(db,response.evidence);
  expect(countTokens(planned.serialized)).toBe(response.budget.usedTokens);expect(db.prepare('SELECT * FROM evidence_spans ORDER BY span_id').all()).toEqual(before);expect(planned.serialized).not.toContain('internal literal');
 });
 it('supports literals needing more than the ordinary five evidence selections',async()=>{
  const {db,root}=store();publish(db,'long',source);const query=source.slice(0,2300);const {response}=await recall(db,root,query,undefined,16000);
  expect(response.evidence.length).toBeGreaterThan(5);expect(response.evidence.map(e=>e.text).join('')).toBe(query);expect(response.support.state).toBe('sufficient');checkRanges(db,response.evidence);
 });
 it('merges complementary literal requirements sharing one anchor without duplicate span delivery',async()=>{
  const {db,root}=store(),published=publish(db,'requirements',source),hit=boundary(source,windows(db,published.revisionId));
  const literals=[hit.query,source.slice(hit.start+5,hit.end+15)],requirements=literals.map((literal,i)=>({id:String(i),text:'exact requested literal',literal}));
  const planned=await new LocalMemoryService(db,{root,semanticDisabled:true}).recall({query:'requested numbered words',scope:{project:'/synthetic/literal'},requirements,budget:defaultBudget()});const response=planned.response as MemoryResponse;
  expect(response.support.state).toBe('sufficient');expect(response.support.requirements.map(r=>r.state)).toEqual(['supported','supported']);expect(new Set(response.evidence.map(e=>e.ref.spanId)).size).toBe(response.evidence.length);checkRanges(db,response.evidence);
 });
 it('keeps UTF16 focus after astral text and the first exact repeated occurrence',async()=>{
  const {db,root}=store(),text=Array.from({length:400},(_,i)=>`😀 café é 각${i} `).join(''),published=publish(db,'unicode',text),ws=windows(db,published.revisionId),hit=boundary(text,ws);
  expect(ws.some(w=>w.text.includes(hit.query))).toBe(false);
  const {response}=await recall(db,root,hit.query);expect(response.support.state).toBe('sufficient');checkRanges(db,response.evidence);expect(deliveredLiteralRefs(response.evidence,hit.query).length).toBeGreaterThan(0);
  const first=text.indexOf(hit.query);expect(response.evidence[0]!.startUtf16).toBe(first);expect(response.evidence.map(e=>e.text).join('')).toBe(hit.query);
  const repeated='😀 prefix '+hit.query+' filler '.repeat(100)+hit.query;publish(db,'repeated',repeated,{project:'/repeated'});const actual=(await recall(db,root,hit.query,{project:'/repeated'})).response;expect(actual.evidence[0]!.startUtf16+actual.evidence[0]!.text.indexOf(hit.query)).toBe(repeated.indexOf(hit.query));checkRanges(db,actual.evidence);
 });
 it('applies scope and internal selection before unit hit limits, and keeps exact controls',async()=>{
  const {db,root}=store(),query=boundary(source,windows(db,publish(db,'template',source,{project:'/unselected'}).revisionId)).query;
  for(let i=0;i<70;i++)publish(db,`other-${i}`,source,{project:'/other',branch:'other'});
  const selected=publish(db,'selected',source);publish(db,'near',query.toUpperCase());publish(db,'semantic','The corresponding fourteen words describe the same numbered sequence.');
  const {response}=await recall(db,root,query,{project:'/synthetic/literal',branch:'main',sourceIds:[selected.sourceId]});expect(response.support.state).toBe('sufficient');expect(new Set(response.evidence.map(e=>e.ref.sourceId))).toEqual(new Set([selected.sourceId]));
  expect((await recall(db,root,query,{sourceIds:[]})).response.evidence).toEqual([]);
  expect((await recall(db,root,query,{},4096,{sourceSelection:()=>({sourceIds:[selected.sourceId],selectionId:'a'.repeat(64)})})).response.support.state).toBe('sufficient');
  expect((await recall(db,root,query+' missing',{})).response.support.state).toBe('insufficient');
 });
 it('honors ignored projects, current revisions and event/knowledge boundaries',async()=>{
  const {db,root}=store(),a=publish(db,'ignored',source,{project:'/ignored'}),ws=windows(db,a.revisionId),hit=boundary(source,ws);writeIgnoreList(root,['/ignored']);
  expect((await recall(db,root,hit.query,{})).response.evidence).toEqual([]);expect((await recall(db,root,hit.query,{project:'/ignored'})).response.support.state).toBe('sufficient');
  const old=publish(db,'rewrite',source,{},'2026-01-01T00:00:00Z');publish(db,'rewrite','Current rewritten source has different words.');
  expect((await recall(db,root,hit.query,{sourceIds:[old.sourceId]})).response.evidence).toEqual([]);expect((await recall(db,root,hit.query,{sourceIds:[old.sourceId],includeHistory:true})).response.support.state).toBe('sufficient');
  expect((await recall(db,root,hit.query,{sourceIds:[old.sourceId],includeHistory:true,learnedBy:'2025-01-01'})).response.evidence).toEqual([]);expect((await recall(db,root,hit.query,{project:'/ignored',asOf:'2025-01-01'})).response.evidence).toEqual([]);
 });
 it('keeps lineage and explicit forget fences in canonical-unit search',async()=>{
  const {db,root}=store(),parent=publish(db,'parent','The parent does not contain the requested words.'),child=publish(db,'child',source,{locator:{recordKey:'one',mapping:'unavailable',parentNativeSessionId:'parent'}}),hit=boundary(source,windows(db,child.revisionId));
  expect((await recall(db,root,hit.query,{sourceIds:[parent.sourceId],lineage:'self'})).response.evidence).toEqual([]);const included=(await recall(db,root,hit.query,{sourceIds:[parent.sourceId],lineage:'descendants'})).response;expect(included.support.state).toBe('sufficient');expect(included.evidence[0]!.ref.sourceId).toBe(child.sourceId);
  applyForget(db,{requestKey:'literal-forget',target:{sourceId:child.sourceId}},{root});expect((await recall(db,root,hit.query,{sourceIds:[child.sourceId],includeHistory:true})).response.evidence).toEqual([]);
 });
 it('returns unresolved support and useful handles when a matching cover cannot fit',async()=>{
  const {db,root}=store();publish(db,'budget',source);const query=source.slice(0,2300),{planned,response}=await recall(db,root,query,undefined,950);
  expect(response.support.state).toBe('insufficient');expect(response.support.unresolved.join(' ')).toContain('Matching canonical source text exists');expect(response.candidates.length).toBeGreaterThan(0);expect(response.budget.truncated).toBe(true);expect(response.budget.omittedItems).toBeGreaterThan(0);expect(response.warnings.join(' ')).not.toContain('No matching evidence');expect(deliveredLiteralRefs(response.evidence,query)).toEqual([]);expect(planned.usedTokens).toBeLessThanOrEqual(950);checkRanges(db,response.evidence);
  const tiny=await recall(db,root,query,undefined,20);expect(tiny.planned.usedTokens).toBeLessThanOrEqual(20);expect(tiny.planned.response).toEqual({error:'budget_too_small'});
 });
 it('keeps existing short literal exact punctuation/case behavior',async()=>{
  const {db,root}=store();publish(db,'short','The exact key is cache.X_9.');publish(db,'case','cache.x_9');const {response}=await recall(db,root,'cache.X_9');expect(response.evidence).toHaveLength(1);expect(response.evidence[0]!.text).toBe('The exact key is cache.X_9.');expect(response.support.state).toBe('sufficient');
 });
 it('fences historical privacy before hit limits and finds a later unaffected exact occurrence',async()=>{
  const {db,root}=store(),secret='0a1b2c3d4e5f60718293a4b5c6d7e8f9',query='0a1b';
  for(let i=0;i<70;i++)historical(db,`old-private-${i}`,`--socket-auth ${secret}`);
  const safeText=`--socket-auth ${secret}\n`+'z'.repeat(1000)+` ${query} SAFE`,safe=historical(db,'later-safe',safeText),before=db.prepare('SELECT unit_revision_id,text,text_hash FROM evidence_units ORDER BY unit_revision_id').all();
  const candidates=fullUnitLiteralCandidates(db,query,scopeSql({project:'/synthetic/literal'}));expect(candidates).toHaveLength(1);expect(candidates[0]!.ref.sourceId).toBe(safe.sourceId);
  const {response,planned}=await recall(db,root,query);expect(response.evidence[0]!.text).toContain(query+' SAFE');expect(response.evidence[0]!.startUtf16+response.evidence[0]!.text.indexOf(query)).toBe(safeText.lastIndexOf(query));expect(response.coverage.state).toBe('partial');expect(planned.serialized).not.toContain(secret);expect(db.prepare('SELECT unit_revision_id,text,text_hash FROM evidence_units ORDER BY unit_revision_id').all()).toEqual(before);
 });
 it('prefers a complete eligible cover over an earlier cover with a privacy-blocked segment',()=>{
  const {db}=store(),text='--socket-auth 0a1b2c3d4e5f60718293a4b5c6d7e8f9\n'+source,old=historical(db,'blocked-cover',text),hit=boundary(text,windows(db,old.revisionId)),current=publish(db,'safe-cover',text);
  const blocked=fullUnitLiteralCandidates(db,hit.query,scopeSql({sourceIds:[old.sourceId]})),safe=fullUnitLiteralCandidates(db,hit.query,scopeSql({sourceIds:[current.sourceId]}));const requirement=[{id:'literal',text:'exact',literal:hit.query}];
  expect(assessSupport(requirement,selectEvidence(blocked,hit.query,requirement),[],true).state).toBe('insufficient');const selected=selectEvidence([...blocked,...safe],hit.query,requirement);expect(assessSupport(requirement,selected,[],true).state).toBe('sufficient');expect(selected[0]!.ref.sourceId).toBe(current.sourceId);checkRanges(db,selected);
 });
 it('bounds old-privacy repeated-match scanning and reports unresolved rather than absence',async()=>{
  const {db,root}=store(),secret='0a1b2c3d4e5f60718293a4b5c6d7e8f9';historical(db,'scan-limit',(`--socket-auth ${secret}\n`).repeat(257)+'0a1b safe');
  const {response,planned}=await recall(db,root,'0a1b');expect(response.coverage.state).toBe('partial');expect(response.coverage.omittedKinds).toContain('literal_search_limited');expect(response.evidence).toEqual([]);expect(response.support.unresolved.join(' ')).toContain('Matching canonical source text exists');expect(response.warnings.join(' ')).not.toContain('No matching evidence');expect(planned.serialized).not.toContain(secret);
 });
 it('bounds canonical cover expansion and exposes incomplete delivery rather than false absence',()=>{
  const {db}=store(),text='a'.repeat(24000);publish(db,'huge',text);const candidates=fullUnitLiteralCandidates(db,text,scopeSql({project:'/synthetic/literal'}));const items=selectEvidence(candidates,text,[{id:'literal',text:'exact',literal:text}]);expect(items).toHaveLength(LITERAL_EXPANSION_LIMIT);expect(literalSearchLimited(candidates)).toBe(true);expect(knownLiteralMatches(candidates)).toHaveLength(LITERAL_EXPANSION_LIMIT);expect(assessSupport([{id:'literal',text:'exact',literal:text}],items,[],true).state).toBe('insufficient');
 });
 it('never certifies a phrase made by joining different sources, revisions, units, roles or gaps',()=>{
  const {db}=store(),published=publish(db,'stitch',source),ws=windows(db,published.revisionId),hit=boundary(source,ws),first=readSpan(db,{...published,spanId:ws[0]!.span_id})!,second=readSpan(db,{...published,spanId:ws[1]!.span_id})!;
  const a={...first,text:source.slice(hit.start,first.endUtf16),startUtf16:hit.start},b={...second,text:source.slice(first.endUtf16,hit.end),startUtf16:first.endUtf16,endUtf16:hit.end};
  const requirement=[{id:'literal',text:'exact',literal:hit.query}];expect(assessSupport(requirement,[a,b],[],true).state).toBe('sufficient');
  for(const wrong of [{...b,ref:{...b.ref,sourceId:'foreign'}},{...b,ref:{...b.ref,revisionId:'other'}},{...b,provenance:{...b.provenance!,unitRevisionId:'other'}},{...b,role:'user'},{...b,startUtf16:b.startUtf16+1,endUtf16:b.endUtf16+1},{...b,text:'!'+b.text.slice(1)},{...b,provenance:undefined}])expect(assessSupport(requirement,[a,wrong],[],true).state).toBe('insufficient');
 });
});

it('preserves ordinary literal context from multiple sources and a late within-window match',async()=>{const {db,root}=store();const a=publish(db,'context-a','Before cache.X_9 means the retained retry setting. Afterward inspect the journal.');const b=publish(db,'context-b','A second source explains cache.X_9 belongs to the deploy path.');const full=(await recall(db,root,'cache.X_9')).response;expect(new Set(full.evidence.map(item=>item.ref.sourceId))).toEqual(new Set([a.sourceId,b.sourceId]));expect(full.evidence.some(item=>item.text.includes('retained retry setting'))).toBe(true);expect(full.evidence.some(item=>item.text.includes('deploy path'))).toBe(true);checkRanges(db,full.evidence);const long=publish(db,'late-context',('earlier context '.repeat(24))+'cache.X_9 retained after match');const small=(await recall(db,root,'cache.X_9',{sourceIds:[long.sourceId]},2000)).response;expect(small.evidence[0]!.text).toContain('cache.X_9');expect(small.support.state).toBe('sufficient');checkRanges(db,small.evidence);});
