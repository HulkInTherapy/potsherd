import {describe,it,expect} from 'vitest';
import fixture from './fixtures/memory/receipt-cycle.json';
import {countTokens,defaultBudget,planResponse,finalizeEmission,emittedMcpResult,planWriteReceipt,type Transport} from '../packages/core/src/memory/budget.js';
import {decodeCompactMemoryPacket} from '../packages/core/src/memory/packet.js';
import type {MemoryResponse,MemoryResponseFormat} from '../packages/core/src/memory/contracts.js';
const original=()=>structuredClone(fixture.response) as MemoryResponse;
const renderedBody=(p:ReturnType<typeof planResponse>)=>JSON.parse(p.emission.kind==='mcp'?emittedMcpResult(p).content[0]!.text:p.serialized);
function receipt(p:ReturnType<typeof planResponse>,limit:number,bytes=65536){expect(p.serialized).toBe(p.emission.serialized);expect(p.usedTokens).toBe(countTokens(p.emission.serialized));expect(p.usedBytes).toBe(Buffer.byteLength(p.emission.serialized));expect(p.usedTokens).toBeLessThanOrEqual(limit);expect(p.usedBytes).toBeLessThanOrEqual(bytes);if('budget' in p.response){expect(p.response.budget.usedTokens).toBe(p.usedTokens);expect(p.response.budget.remainingTokens).toBe(Math.max(0,limit-p.usedTokens));}expect(Object.isFrozen(p.emission)).toBe(true);}
describe('immutable exact token receipt cycle settlement',()=>{
 it('preserves the public proven1048/1049 cycle input and resolves it at the original2048 budget',()=>{
  const input=original();input.budget.usedTokens=1048;input.budget.remainingTokens=1000;expect(countTokens(finalizeEmission(input,'cli_json').serialized)).toBe(1049);input.budget.usedTokens=1049;input.budget.remainingTokens=999;expect(countTokens(finalizeEmission(input,'cli_json').serialized)).toBe(1048);
  const p=planResponse(original(),defaultBudget(fixture.maxTokens),{transport:'cli_json'});receipt(p,2048);const actual=renderedBody(p) as MemoryResponse;expect(actual.requestId).toBe(fixture.response.requestId);expect(actual.evidence).toEqual(fixture.response.evidence);expect(actual.coverage).toEqual(fixture.response.coverage);expect(actual.budget.truncated).toBe(false);expect(p.serialized.startsWith('\n')).toBe(true);expect(p.serialized.endsWith('\n')).toBe(true);expect(actual.budget.usedTokens).toBe(1049);expect(actual.budget.remainingTokens).toBe(999);expect(planResponse(original(),defaultBudget(2048),{transport:'cli_json'}).serialized).toBe(p.serialized);
 });
 it.each(['json','cli_json','mcp'] as const)('preserves every semantic field and measures the complete %s emission',transport=>{
  const p=planResponse(original(),defaultBudget(2048),{transport});receipt(p,2048);const actual=renderedBody(p) as MemoryResponse;expect(actual.evidence).toEqual(fixture.response.evidence);expect(actual.requestId).toBe(fixture.response.requestId);expect(actual.budget.truncated).toBe(false);if(p.emission.kind==='mcp'){expect(JSON.stringify(emittedMcpResult(p))).toBe(p.serialized);expect(Object.isFrozen(emittedMcpResult(p).content[0])).toBe(true);}const captured=p.serialized;(p.response as MemoryResponse).evidence[0]!.text='later public mutation';expect(p.emission.serialized).toBe(captured);
 });
 it.each(['json','cli_json','mcp'] as const)('keeps compact-v1 shape/round-trip and exact complete %s accounting',transport=>{
  const p=planResponse(original(),defaultBudget(2048),{transport,responseFormat:'compact-v1'});receipt(p,2048);const encoded=renderedBody(p);expect(encoded.packetFormat).toBe('compact-v1');expect(decodeCompactMemoryPacket(encoded)).toEqual(p.response);expect((p.response as MemoryResponse).evidence).toEqual(fixture.response.evidence);
 });
 it.each(['human',{kind:'human',width:40,ascii:true}] as const)('measures actual human bytes, receipt digits and source text',transport=>{
  const p=planResponse(original(),defaultBudget(2048),{transport});receipt(p,2048);expect(p.serialized).toContain('Exact cache.X_9 recovered');expect(p.serialized).toContain(`Tokens: ${p.usedTokens};`);expect(p.serialized).toContain(`remaining: ${2048-p.usedTokens}`);expect((p.response as MemoryResponse).evidence).toEqual(fixture.response.evidence);
 });
 it('keeps normally stable serialization byte-for-byte unchanged',()=>{
  const p=planResponse(original(),defaultBudget(2049),{transport:'cli_json'});receipt(p,2049);expect(p.serialized).toBe(finalizeEmission(p.response,'cli_json').serialized);expect(p.serialized.startsWith('{')).toBe(true);
 });
 it('enforces byte/token caps on actual chosen whitespace and never counts padding outside MCP text',()=>{
  const ample=planResponse(original(),defaultBudget(2048),{transport:'cli_json'});const exact=planResponse(original(),{...defaultBudget(2048),maxBytes:ample.usedBytes},{transport:'cli_json'});receipt(exact,2048,ample.usedBytes);expect((exact.response as MemoryResponse).evidence).toEqual(fixture.response.evidence);
  for(const transport of ['json','cli_json','mcp','human'] as const){const p=planResponse(original(),{...defaultBudget(2048),maxBytes:300},{transport});receipt(p,2048,300);const tiny=planResponse(original(),{...defaultBudget(2048),remainingJourneyTokens:20,maxBytes:300},{transport});receipt(tiny,20,300);}
  const m=finalizeEmission(original(),'mcp','expanded-v2','\n');expect(m.kind).toBe('mcp');if(m.kind==='mcp'){expect(m.result.content[0]!.text.startsWith('\n{')).toBe(true);expect(JSON.stringify(m.result)).toBe(m.serialized);expect(JSON.parse(m.result.content[0]!.text)).toEqual(original());}
 });
 it('settles deterministic decimal boundary matrices for all supported expanded/compact transports',()=>{
  const transports:Transport[]=['json','cli_json','mcp','human'];for(const transport of transports){const formats:MemoryResponseFormat[]=transport==='human'?['expanded-v2']:['expanded-v2','compact-v1'];for(const format of formats){const baseline=planResponse(original(),defaultBudget(8192),{transport,responseFormat:format});for(const delta of [98,99,100,998,999,1000]){const limit=baseline.usedTokens+delta,p=planResponse(original(),defaultBudget(limit),{transport,responseFormat:format});receipt(p,limit);expect((p.response as MemoryResponse).evidence).toEqual(fixture.response.evidence);}}}
 });
 it('uses the same exact emitted receipt mechanism for durable acknowledgements without losing commit identity',()=>{
  const value={contractVersion:2 as const,requestKey:'public-receipt-cycle',batchId:'public-batch',noteIds:['public-note'],epochs:{evidence:1,notes:1,lineage:0,deletion:0,vector:0},redacted:false,authority:'agent_assertion' as const,supportStatus:'unverified' as const,committedAt:'2026-10-07T00:00:00Z'};
  for(const transport of ['json','cli_json','mcp','human'] as const)for(const limit of [999,1000,2048]){const p=planWriteReceipt(value,defaultBudget(limit),transport);expect(p.response.requestKey).toBe(value.requestKey);expect(p.response.noteIds).toEqual(value.noteIds);expect(p.usedTokens).toBe(countTokens(p.emission.serialized));expect(p.response.budget.usedTokens).toBe(p.usedTokens);expect(p.response.budget.remainingTokens).toBe(limit-p.usedTokens);expect(p.usedTokens).toBeLessThanOrEqual(limit);if(p.emission.kind==='mcp')expect(JSON.stringify(emittedMcpResult(p))).toBe(p.serialized);}
 });
});
