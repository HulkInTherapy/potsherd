import { describe, expect, it } from 'vitest';
import { compactFixture } from './memory-compact-fixture.js';
import type { Candidate, EvidenceItem, MemoryResponse } from '../packages/core/src/memory/contracts.js';
import { hash } from '../packages/core/src/memory/spans.js';
import { countTokens, defaultBudget, emittedMcpResult, inspectPreview, planResponse, type PreviewWork } from '../packages/core/src/memory/budget.js';
import { encodeCompactMemoryPacket, decodeCompactMemoryPacket } from '../packages/core/src/memory/packet.js';
import { validateMemoryInput } from '../packages/core/src/memory/input.js';

function item(n:number,text='Exact independent route '+n+' archive qualifier 日本語 😀'):EvidenceItem {
 const e=structuredClone(compactFixture().evidence[0]!);e.ref={sourceId:hash('nav-source'),revisionId:hash('nav-revision'),spanId:hash('nav-span-'+n)};e.text=text;e.startUtf16=100;e.endUtf16=100+text.length;e.citation=`span:${e.ref.sourceId}:${e.ref.revisionId}:${e.ref.spanId}@${e.startUtf16}-${e.endUtf16}`;e.provenance!.spanStartUtf16=100;e.provenance!.spanEndUtf16=e.endUtf16;e.provenance!.unitRevisionId=hash('nav-unit-'+n);e.provenance!.unitTextHash=hash(text);e.provenance!.spanTextHash=hash(text);e.provenance!.unitKey='nav-record-'+n;e.sourceEventAt=n%2?'2026-08-01T00:00:00Z':null;return e;
}
function fixture(count=10){
 const response=compactFixture();response.requestId='nav-inert-fixture';response.evidence=[item(0,'Selected quote '+('large source material '.repeat(200)))];response.assertions=[];response.candidates=[];response.support={state:'unassessed',method:'none',requirements:[],unresolved:[]};
 const pool:Candidate[]=[{ref:response.evidence[0]!.ref,score:1,lanes:['lexical'],evidence:response.evidence[0]}];
 for(let i=1;i<=count;i++){const evidence=item(i);pool.push({ref:evidence.ref,score:1/(i+1),lanes:['lexical','dense'],evidence});}
 response.candidates=pool.slice(1,9).map(({ref,score,lanes})=>({ref,score,lanes}));return {response,pool};
}
const nav=(pool:Candidate[],seeds=3,previewTokens=32)=>({pool,query:'archive qualifier',terms:['archive','qualifier'],profile:{seeds,previewTokens}});
describe('inspect navigation inert source/wire controls',()=>{
 it.each(['json','mcp'] as const)('restores affordable omitted selected routes after large evidence removal on %s',transport=>{
  const response=compactFixture();response.assertions=[];response.candidates=[];response.support={state:'unassessed',method:'none',requirements:[],unresolved:[]};
  response.evidence=[0,1,2].map(n=>{const e=structuredClone(response.evidence[0]!);e.ref={sourceId:hash('source'+n),revisionId:hash('revision'+n),spanId:hash('span'+n)};e.text='Independent selected source '+n+'.';e.startUtf16=0;e.endUtf16=e.text.length;e.citation=`span:${e.ref.sourceId}:${e.ref.revisionId}:${e.ref.spanId}@0-${e.text.length}`;e.provenance!.spanStartUtf16=0;e.provenance!.spanEndUtf16=e.text.length;return e;});
  const pool:Candidate[]=response.evidence.map((e,i)=>({ref:e.ref,score:1-i/10,lanes:['lexical'],evidence:e}));
  const limit=transport==='mcp'?1200:1100;const planned=planResponse(response,defaultBudget(limit),{transport,responseFormat:'compact-v1',navigation:{pool,query:'selected source',terms:['source'],profile:{seeds:3,previewTokens:32}}});
  expect(planned.response.evidence.length).toBeLessThan(3);expect(planned.response.candidates.length).toBeGreaterThan(0);
  const visible=[...planned.response.evidence,...planned.response.candidates].map(e=>e.ref.spanId);
  expect(new Set(visible)).toEqual(new Set(response.evidence.map(e=>e.ref.spanId)));
  expect(planned.response.candidates.every(c=>!c.evidence)).toBe(true);expect(planned.usedTokens).toBeLessThanOrEqual(limit);
  const wire=transport==='mcp'?JSON.parse(emittedMcpResult(planned).content[0]!.text):JSON.parse(planned.serialized);
  expect(decodeCompactMemoryPacket(wire)).toEqual(planned.response);
 });

 it('adds an explicit preview extension sharing metadata, leaves ordinary compact shape unchanged and never promotes candidate proof',()=>{
  const {response,pool}=fixture();const plain=planResponse(response,defaultBudget(8192),{responseFormat:'compact-v1'});const ordinary=JSON.parse(plain.serialized);expect(ordinary.navigation).toBeUndefined();expect(plain.response.navigation).toBeUndefined();expect(plain.response.candidates.every(c=>!c.evidence)).toBe(true);
  const planned=planResponse(response,defaultBudget(8192),{responseFormat:'compact-v1',navigation:nav(pool)});const wire=JSON.parse(planned.serialized);expect(wire.navigation.version).toBe(1);expect(wire.navigation.previews).toHaveLength(3);expect(wire.response.candidates).toHaveLength(8);expect(wire.response.candidates[0].evidence).toBeUndefined();expect(wire.response.candidates[0].previewIndex).toBe(0);
  expect(decodeCompactMemoryPacket(wire)).toEqual(planned.response);expect(wire.sourceRevisions.length).toBeLessThan(wire.response.evidence.length+wire.navigation.previews.length);expect(planned.response.support.state).toBe('unassessed');expect(planned.response.evidence.map(e=>e.ref)).toEqual(response.evidence.map(e=>e.ref));
 });
 it('preserves valid shared semantic evidence objects without alias-mutation loss',()=>{
  const {response}=fixture();response.navigation='inspect-v1';const same=response.evidence[0]!;response.candidates=[{ref:same.ref,score:1,lanes:['lexical'],evidence:same}];expect(decodeCompactMemoryPacket(encodeCompactMemoryPacket(response))).toEqual(response);
 });
 it('keeps stable seed routes before optional recovery refs and survives actual compact budget clipping',()=>{
  const {response,pool}=fixture();const planned=planResponse(response,defaultBudget(2048),{transport:'mcp',responseFormat:'compact-v1',navigation:nav(pool)});expect(planned.usedTokens).toBeLessThanOrEqual(2048);expect(planned.usedBytes).toBeLessThanOrEqual(65536);
  if(!('evidence' in planned.response))throw new Error('navigation control must carry one useful route');expect(planned.response.candidates.length).toBeGreaterThan(0);expect(planned.response.candidates[0]!.ref).toEqual(pool[1]!.ref);expect(planned.response.evidence.some(e=>e.text.length>0)).toBe(true);expect(planned.response.budget.truncated).toBe(true);
  expect(JSON.stringify(emittedMcpResult(planned))).toBe(planned.serialized);expect(decodeCompactMemoryPacket(JSON.parse(emittedMcpResult(planned).content[0]!.text))).toEqual(planned.response);
 });
 it('drops preview facts and reduces seed count before evicting useful selected text at a constrained cap',()=>{
  const {response,pool}=fixture();const zero=planResponse(response,defaultBudget(2048),{responseFormat:'compact-v1',navigation:nav(pool,3,0)});const clipped=planResponse(response,defaultBudget(2048),{responseFormat:'compact-v1',navigation:nav(pool)});
  for(const planned of [zero,clipped]){expect(planned.response.evidence.some(e=>e.text.length>0)).toBe(true);expect(planned.response.candidates.length).toBeGreaterThanOrEqual(1);expect(planned.response.candidates.every(c=>!c.evidence)).toBe(true);const packet=JSON.parse(planned.serialized);expect(packet.navigation.previews).toEqual([]);expect(packet.units.length).toBe(planned.response.evidence.length);expect(packet.response.candidates.every((c:any)=>c.previewIndex===undefined)).toBe(true);expect(decodeCompactMemoryPacket(packet)).toEqual(planned.response);expect(planned.usedTokens).toBeLessThanOrEqual(2048);}
 });
 it('keeps two complementary selected sources before optional navigation seeds',()=>{
  const {response,pool}=fixture();response.evidence=[item(100,'Independent first measurement: 11 absent assets.'),item(101,'Independent second measurement: 0 absent assets.')];
  const bare={ref:pool[1]!.ref,score:pool[1]!.score,lanes:pool[1]!.lanes};
  const exact=planResponse({...response,candidates:[bare]},defaultBudget(8192),{responseFormat:'compact-v1'});
  const planned=planResponse(response,defaultBudget(exact.usedTokens+48),{responseFormat:'compact-v1',navigation:nav(pool)});
  expect(planned.response.evidence.map(e=>e.text)).toEqual(response.evidence.map(e=>e.text));
  expect(planned.response.candidates).toHaveLength(1);expect(planned.usedTokens).toBeLessThanOrEqual(exact.usedTokens+48);
  expect(decodeCompactMemoryPacket(JSON.parse(planned.serialized))).toEqual(planned.response);
 });
 it('offers budget-omitted selected evidence before an unrelated exploration seed',()=>{
  const {response,pool}=fixture();response.evidence=[item(100,'Primary measurement retained.'),item(101,'Complementary independent measurement retained.'),item(102,'Third event comparison retained.')];
  const planned=planResponse(response,defaultBudget(1600),{responseFormat:'compact-v1',navigation:nav(pool)});
  const visible=new Set(planned.response.evidence.map(e=>e.ref.spanId));
  const omitted=response.evidence.filter(e=>!visible.has(e.ref.spanId));expect(omitted.length).toBeGreaterThan(0);
  expect(planned.response.candidates[0]!.ref).toEqual(omitted[0]!.ref);expect(planned.usedTokens).toBeLessThanOrEqual(1600);
 });
 it('returns bounded operational failure when truthful state plus one readable source route cannot fit',()=>{
  const {response,pool}=fixture();const planned=planResponse(response,{...defaultBudget(64),maxBytes:256},{transport:'mcp',responseFormat:'compact-v1',navigation:nav(pool)});expect(planned.response).toEqual({error:'budget_too_small'});expect(planned.usedTokens).toBeLessThanOrEqual(64);expect(planned.usedBytes).toBeLessThanOrEqual(256);
 });
 it('does not force extra seeds on satisfied exact requirements and ignores preview literals as final support',()=>{
  const {response,pool}=fixture();response.evidence=[item(0,'needle exact')];pool[0]!.evidence=response.evidence[0];const requirements=[{id:'exact',text:'source literal',literal:'needle exact'}];
  const satisfied=planResponse(response,defaultBudget(8192),{responseFormat:'compact-v1',navigation:nav(pool),requirements});expect(satisfied.response.support.state).toBe('sufficient');expect(satisfied.response.candidates.every(c=>!c.evidence)).toBe(true);
  response.evidence=[];response.candidates=[];const previewOnly=planResponse(response,defaultBudget(8192),{responseFormat:'compact-v1',navigation:{pool:pool.slice(1),query:'archive',terms:['archive']},requirements:[{id:'route',text:'source archive',literal:'archive'}]});expect(previewOnly.response.evidence).toEqual([]);expect(previewOnly.response.support.state).toBe('insufficient');expect(previewOnly.response.candidates.some(c=>c.evidence?.text.includes('archive'))).toBe(true);
 });
 it('deduplicates only canonical refs, not identical text under different provenance, and avoids redundant partial-ref candidates',()=>{
  const {response,pool}=fixture(3);pool[2]!.evidence=item(2,pool[1]!.evidence!.text);pool[2]!.ref=pool[2]!.evidence!.ref;pool.push({...pool[1]!});
  const planned=planResponse(response,defaultBudget(8192),{responseFormat:'compact-v1',navigation:nav(pool)});expect(new Set(planned.response.candidates.map(c=>JSON.stringify(c.ref))).size).toBe(planned.response.candidates.length);expect(planned.response.candidates.some(c=>c.ref.spanId===pool[1]!.ref.spanId)).toBe(true);expect(planned.response.candidates.some(c=>c.ref.spanId===pool[2]!.ref.spanId)).toBe(true);expect(planned.response.candidates.some(c=>c.ref.spanId===response.evidence[0]!.ref.spanId)).toBe(false);
 });
 it('preserves one recovery route if the only selected item is removed entirely',()=>{
  const {response,pool}=fixture(0);const planned=planResponse(response,defaultBudget(1200),{responseFormat:'compact-v1',navigation:nav(pool)});
  if('evidence' in planned.response){expect(planned.response.evidence.length+planned.response.candidates.length).toBeGreaterThan(0);if(!planned.response.evidence.length)expect(planned.response.candidates[0]!.ref).toEqual(pool[0]!.ref);}
  else expect(planned.response).toEqual({error:'budget_too_small'});
 });
 it('rejects more than eight inspect candidates on both semantic encode and wire decode',()=>{
  const {response,pool}=fixture();response.navigation='inspect-v1';response.candidates=pool.slice(1);expect(()=>encodeCompactMemoryPacket(response)).toThrow(/invalid_memory_packet/);
  const planned=planResponse(fixture().response,defaultBudget(8192),{responseFormat:'compact-v1',navigation:nav(pool)});const packet=JSON.parse(planned.serialized);packet.response.candidates.push({...packet.response.candidates[0],previewIndex:undefined});expect(()=>decodeCompactMemoryPacket(packet)).toThrow(/invalid_memory_packet/);
 });
 it('quotes one bounded original Unicode late-hit window and limits scanning/anchor/tokenization work',()=>{
  const text='noise '.repeat(100)+'archive qualifier 日本語 😀 '+('suffix '.repeat(4000));const original=item(20,text);const work:PreviewWork={scanCharacters:0,anchors:0,windows:0};const preview=inspectPreview(original,'archive qualifier',['archive','qualifier'],32,work);
  expect(preview.text).toContain('archive qualifier');expect(preview.startUtf16).toBeGreaterThan(original.startUtf16);expect(preview.text).toBe(text.slice(preview.startUtf16-original.startUtf16,preview.endUtf16-original.startUtf16));expect(preview.endUtf16-preview.startUtf16).toBe(preview.text.length);expect(countTokens(preview.text)).toBeLessThanOrEqual(32);expect(work.scanCharacters).toBeLessThanOrEqual(16384);expect(work.anchors).toBeLessThanOrEqual(8);expect(work.windows).toBeLessThanOrEqual(16);expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(preview.text)).toBe(false);expect(preview.role).toBe(original.role);expect(preview.sourceEventAt).toBe(original.sourceEventAt);expect(preview.authority).toBe(original.authority);expect(preview.provenance).toEqual(original.provenance);
 });
 it('preserves complete qualified metadata when preview text is removed, without claiming the source span is empty',()=>{
  const source=item(10);source.role='ghost_prompt';source.toolOutcome='unknown';source.provenance!.transcriptAvailability='unavailable';const preview=inspectPreview(source,'none',[],0);expect(preview.text).toBe('');expect(preview.endUtf16).toBe(preview.startUtf16);expect(preview.provenance!.spanEndUtf16).toBeGreaterThan(preview.endUtf16);expect(preview.role).toBe('ghost_prompt');expect(preview.provenance).toEqual(source.provenance);expect(preview.toolOutcome).toBe('unknown');
 });
 it.each([
  ['wrong preview ref',(p:any)=>{p.response.candidates[0].ref.spanId='wrong';}],['dangling index',(p:any)=>{p.response.candidates[0].previewIndex=99;}],['negative index',(p:any)=>{p.response.candidates[0].previewIndex=-1;}],['fractional index',(p:any)=>{p.response.candidates[0].previewIndex=0.5;}],['reused index',(p:any)=>{p.response.candidates[1].previewIndex=0;}],['inline preview collision',(p:any)=>{p.response.candidates[0].evidence={};}],['extension missing',(p:any)=>{delete p.navigation;}],['extension version',(p:any)=>{p.navigation.version=2;}],['orphan preview',(p:any)=>{delete p.response.candidates[0].previewIndex;}]
 ])('rejects %s without promotion or hidden alias',(_name,change)=>{
  const {response,pool}=fixture();const planned=planResponse(response,defaultBudget(8192),{responseFormat:'compact-v1',navigation:nav(pool)});const packet=JSON.parse(planned.serialized);change(packet);expect(()=>decodeCompactMemoryPacket(packet)).toThrow(/invalid_memory_packet/);
 });
 it('negotiates the scalar only on compact recall; ordinary requests are unchanged and all read refs stay canonical',()=>{
  const ordinary={query:'all qualifiers',budget:defaultBudget(),scope:{}};expect(validateMemoryInput('recall',ordinary)).toEqual(ordinary);
  expect(()=>validateMemoryInput('recall',{...ordinary,navigation:'inspect-v1'})).toThrow(/navigation_requires_compact/);expect(()=>validateMemoryInput('recall',{...ordinary,responseFormat:'compact-v1',navigation:'future'})).toThrow(/unsupported_navigation/);
  expect(validateMemoryInput('recall',{...ordinary,responseFormat:'compact-v1',navigation:'inspect-v1'}).navigation).toBe('inspect-v1');
  for(const kind of ['read','graft','write'] as const)expect(()=>validateMemoryInput(kind,{navigation:'inspect-v1'})).toThrow(/unknown_top_level_field/);
  expect(()=>validateMemoryInput('read',{refs:[{previewIndex:0}]})).toThrow(/unknown_ref_field/);
 });
});
