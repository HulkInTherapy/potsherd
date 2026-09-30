import { describe, expect, it } from 'vitest';
import { hash } from '../packages/core/src/memory/spans.js';
import { planReadResponse, decodeCursor } from '../packages/core/src/memory/context.js';
import { countTokens, defaultBudget, emittedMcpResult, planBudgetFailure, type Transport } from '../packages/core/src/memory/budget.js';
import { decodeCompactMemoryPacket } from '../packages/core/src/memory/packet.js';
import { compactFixture } from './memory-compact-fixture.js';
import type { EvidenceItem, MemoryResponse, MemoryResponseFormat, NoteView } from '../packages/core/src/memory/contracts.js';

function fixture():MemoryResponse {
 const response=compactFixture();response.evidence=response.evidence.slice(0,1);response.candidates=[];
 const item=response.evidence[0]!;item.ref={sourceId:hash('progress-source'),revisionId:hash('progress-revision'),spanId:hash('progress-span')};
 item.text='progress 日本語 😀 '+('xYz_9日本語😀 '.repeat(200));item.startUtf16=20;item.endUtf16=20+item.text.length;item.citation=`span:${item.ref.sourceId}:${item.ref.revisionId}:${item.ref.spanId}@${item.startUtf16}-${item.endUtf16}`;
 const p=item.provenance!;p.artifactHash=hash('artifact');p.manifestHash=hash('manifest');p.unitRevisionId=hash('unit');p.unitTextHash=hash(item.text);p.spanTextHash=p.unitTextHash;p.spanStartUtf16=item.startUtf16;p.spanEndUtf16=item.endUtf16;
 return response;
}
function emptyItem(original:EvidenceItem):EvidenceItem {
 const item=structuredClone(original);item.ref.spanId=hash('empty-metadata');item.text='';item.endUtf16=item.startUtf16;delete item.provenance;item.citation=`span:${item.ref.sourceId}:${item.ref.revisionId}:${item.ref.spanId}@${item.startUtf16}-${item.endUtf16}`;return item;
}
function assertion():NoteView {return {noteId:'metadata-note',batchId:'batch',kind:'observation',text:'',project:'/toy',branch:null,eventAt:null,observedAt:'2026-09-01',validFrom:null,validUntil:null,authority:'unknown',supportStatus:'unverified',supportRefs:[],supersedes:[],current:true,originSourceId:null,lineageAnchorSourceId:null,authorClaim:'unknown',origin:'api'};}
function wire(planned:ReturnType<typeof planReadResponse>,transport:Transport):unknown {
 const parsed=JSON.parse(transport==='mcp'?emittedMcpResult(planned).content[0]!.text:planned.serialized);return parsed.packetFormat==='compact-v1'?decodeCompactMemoryPacket(parsed):parsed;
}
const cases=(['expanded-v2','compact-v1'] as const).flatMap(format=>(['json','cli_json','mcp'] as const).map(transport=>({format,transport})));
describe('semantic forward progress for bounded reads',()=>{
 it.each(['json','cli_json','mcp'] as const)('terminates when continuation metadata displaces all positive ranges (%s)',transport=>{
  const source=fixture();source.assertions=[];
  source.evidence=Array.from({length:3},(_,index)=>{
   const item=structuredClone(source.evidence[0]!);item.ref.spanId=hash(`regression-${index}`);
   item.citation=`span:${item.ref.sourceId}:${item.ref.revisionId}:${item.ref.spanId}@${item.startUtf16}-${item.endUtf16}`;return item;
  });
  for(const maxTokens of [282,423,640,766]){
   const result=planReadResponse(source,defaultBudget(maxTokens),{},transport,true,undefined,undefined,'compact-v1');
   expect(result.response).toEqual({error:'budget_too_small'});
   expect(result.usedTokens).toBe(countTokens(result.serialized));expect(result.usedTokens).toBeLessThanOrEqual(maxTokens);
  }
 });
 it.each(cases)('returns counted failure without cursor for unchanged positive ranges ($format/$transport)',({format,transport})=>{
  const source=fixture(),planned=planReadResponse(source,defaultBudget(640),{},transport,true,undefined,undefined,format);
  expect(planned.response).toEqual({error:'budget_too_small'});expect(wire(planned,transport)).toEqual({error:'budget_too_small'});
  expect(planned.usedTokens).toBe(countTokens(planned.serialized));expect(planned.usedBytes).toBe(Buffer.byteLength(planned.serialized));expect(planned.usedTokens).toBeLessThanOrEqual(640);
 });
 it.each(['expanded-v2','compact-v1'] as const)('preserves advancing exact Unicode partial reads and larger-budget recovery (%s)',format=>{
  const source=fixture();const partial=planReadResponse(source,defaultBudget(1600),{},'mcp',true,undefined,undefined,format);
  if(!('evidence' in partial.response))throw new Error('partial control needs viable envelope');
  expect(partial.response.evidence.length).toBeGreaterThan(0);const delivered=partial.response.evidence[0]!;expect(delivered.text.length).toBeGreaterThan(0);expect(delivered.text).toBe(source.evidence[0]!.text.slice(0,delivered.text.length));
  expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(delivered.text)).toBe(false);expect(decodeCursor(partial.response.continuation!).positions[0]!.startUtf16).toBe(delivered.endUtf16);
  const complete=planReadResponse(source,defaultBudget(8192),{},'mcp',true,undefined,undefined,format);expect(complete.response.evidence).toEqual(source.evidence);expect(complete.response.continuation).toBeUndefined();
 });
 it.each(['expanded-v2','compact-v1'] as const)('counts returned empty metadata, not merely an unreturned empty original (%s)',format=>{
  const source=fixture();const empty=emptyItem(source.evidence[0]!);source.evidence.unshift(empty);
  const useful=planReadResponse(source,defaultBudget(1024),{},'json',true,undefined,undefined,format);
  if(!('evidence' in useful.response))throw new Error('metadata control needs viable envelope');expect(useful.response.evidence.some(item=>item.ref.spanId===empty.ref.spanId&&item.text==='')).toBe(true);
  source.evidence.reverse();const missing=planReadResponse(source,defaultBudget(640),{},'json',true,undefined,undefined,format);expect(missing.response).toEqual({error:'budget_too_small'});
 });
 it.each(['expanded-v2','compact-v1'] as const)('preserves actually returned assertions, advancing other refs, genuine EOF and scanner-only metadata (%s)',format=>{
  const source=fixture();source.assertions=[assertion()];const noted=planReadResponse(source,defaultBudget(1024),{},'json',true,undefined,undefined,format);
  expect(noted.response.assertions).toHaveLength(1);expect(noted.response.evidence).toHaveLength(0);expect(noted.response.continuation).toBeTruthy();
  source.assertions=[];const short=emptyItem(source.evidence[0]!);short.text='another exact range';short.endUtf16=short.startUtf16+short.text.length;source.evidence.unshift(short);
  const other=planReadResponse(source,defaultBudget(1100),{},'json',true,undefined,undefined,format);expect(other.response.evidence.some(item=>item.ref.spanId===short.ref.spanId&&item.text===short.text)).toBe(true);
  const eof=fixture();eof.evidence=[];const empty=planReadResponse(eof,defaultBudget(),{},'mcp',true,undefined,undefined,format);expect(empty.response.evidence).toEqual([]);expect(empty.response.continuation).toBeUndefined();
  const scan=planReadResponse(eof,defaultBudget(),{},'mcp',false,{legacyRef:{sessionId:'toy'},offset:3},undefined,format);expect(decodeCursor(scan.response.continuation!).scan!.offset).toBe(3);
 });
 it.each(['privacy_refresh_required','source_span_unavailable','note_unavailable'])('does not replace existing explicit %s source outcome',code=>{
  const source=fixture();source.coverage.state='partial';source.warnings=[code];const planned=planReadResponse(source,defaultBudget(640),{},'json',true);
  expect(planned.response.coverage.state).toBe('partial');expect(planned.response.continuation).toBeTruthy();
 });
 it('reuses the exact existing tiny-envelope fallback and exception semantics',()=>{
  expect(planBudgetFailure({...defaultBudget(640),remainingJourneyTokens:20},'mcp','compact-v1').response).toEqual({error:'budget_too_small'});
  expect(planBudgetFailure({...defaultBudget(1),maxBytes:2}).response).toEqual({});
  expect(()=>planBudgetFailure({...defaultBudget(1),maxBytes:2},'mcp')).toThrow(/transport envelope/);
  expect(()=>planBudgetFailure({...defaultBudget(),tokenizerId:'unknown'})).toThrow(/Unsupported transport tokenizer/);
 });
});
