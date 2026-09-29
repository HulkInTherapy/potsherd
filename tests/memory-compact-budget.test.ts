import { describe, expect, it } from 'vitest';
import { countTokens, defaultBudget, planResponse, serializeResponse, emittedMcpResult, planWriteReceipt } from '../packages/core/src/memory/budget.js';
import { decodeCompactMemoryPacket } from '../packages/core/src/memory/packet.js';
import { planReadResponse, decodeCursor } from '../packages/core/src/memory/context.js';
import { validateMemoryInput } from '../packages/core/src/memory/input.js';
import { compactFixture } from './memory-compact-fixture.js';
describe('compact chosen-wire accounting',()=>{
  it.each(['json','cli_json','mcp'] as const)('counts actual %s bytes including receipt and wrapper before trimming',transport=>{
    const source=compactFixture(),budget=defaultBudget(8192);
    const full=planResponse(source,budget,{transport});const compact=planResponse(source,budget,{transport,responseFormat:'compact-v1'});
    expect(full.serialized).toBe(serializeResponse(full.response,transport));expect(compact.usedTokens).toBe(countTokens(compact.serialized));expect(compact.usedBytes).toBe(Buffer.byteLength(compact.serialized));
    const body=JSON.parse(transport==='mcp'?emittedMcpResult(compact).content[0]!.text:compact.serialized);const decoded=decodeCompactMemoryPacket(body);
    expect(decoded).toEqual(compact.response);expect(decoded.budget.usedTokens).toBe(compact.usedTokens);expect(decoded.budget.remainingTokens).toBe(8192-compact.usedTokens);expect(compact.usedTokens).toBeLessThan(full.usedTokens);
    expect(compact.response.evidence).toBeDefined();expect(compact.emission.format).toBe('compact-v1');
  });
  it('uses compact fit before removal and keeps the immutable emitted MCP text after semantic mutation',()=>{
    const source=compactFixture(),ample=planResponse(source,defaultBudget(8192),{transport:'mcp',responseFormat:'compact-v1'});
    const compact=planResponse(source,defaultBudget(ample.usedTokens+12),{transport:'mcp',responseFormat:'compact-v1'});
    expect(compact.response.evidence).toHaveLength(2);expect(compact.response.budget.truncated).toBe(false);
    const full=planResponse(source,defaultBudget(ample.usedTokens+12),{transport:'mcp'});expect(full.response.budget.truncated).toBe(true);
    const emitted=emittedMcpResult(compact);const captured=JSON.stringify(emitted);compact.response.evidence[0]!.text='later mutation';compact.response.budget.usedTokens=0;
    expect(JSON.stringify(emittedMcpResult(compact))).toBe(captured);expect(captured).toBe(compact.serialized);expect(Object.isFrozen(emitted.content[0])).toBe(true);
    expect(()=>emittedMcpResult(planResponse(source,defaultBudget(),{transport:'cli_json'}))).toThrow(/not MCP/);
  });
  it.each(['cli_json','mcp'] as const)('reprojects every clipped %s packet, reassesses support, prunes tables and enforces byte caps',transport=>{
    const source=compactFixture();source.evidence[0]!.text='irrelevant '.repeat(200)+'cache.X_9';source.evidence[0]!.startUtf16=0;source.evidence[0]!.endUtf16=source.evidence[0]!.text.length;source.evidence[0]!.provenance!.spanEndUtf16=source.evidence[0]!.endUtf16;source.evidence[1]!.ref.sourceId='other';
    const planned=planResponse(source,{...defaultBudget(1100),maxBytes:4500},{transport,responseFormat:'compact-v1',requirements:[{id:'literal',text:'literal delivered',literal:'cache.X_9'}]});
    expect(planned.usedTokens).toBeLessThanOrEqual(1100);expect(planned.usedBytes).toBeLessThanOrEqual(4500);
    if('evidence' in planned.response){const packet=JSON.parse(transport==='mcp'?emittedMcpResult(planned).content[0]!.text:planned.serialized);expect(decodeCompactMemoryPacket(packet)).toEqual(planned.response);expect(packet.sourceRevisions.length).toBeLessThanOrEqual(planned.response.evidence.length);expect(planned.response.budget.truncated).toBe(true);expect(planned.response.support.state==='sufficient').toBe(planned.response.evidence.some(e=>e.text.includes('cache.X_9')));}
  });
  it('keeps tiny error fallback bounded, refuses human compact and unsupported selectors, rejects packet indices as request refs',()=>{
    const source=compactFixture();const planned=planResponse(source,{...defaultBudget(500),remainingJourneyTokens:20},{responseFormat:'compact-v1'});expect(JSON.parse(planned.serialized)).toEqual({error:'budget_too_small'});expect(planned.usedTokens).toBeLessThanOrEqual(20);
    expect(()=>planResponse(source,defaultBudget(),{transport:'human',responseFormat:'compact-v1'})).toThrow(/requires JSON/);
    expect(()=>validateMemoryInput('recall',{query:'toy',responseFormat:'future'})).toThrow(/unsupported_response_format/);
    expect(()=>validateMemoryInput('write',{responseFormat:'compact-v1'})).toThrow(/unknown_top_level_field/);
    expect(()=>validateMemoryInput('read',{refs:[{sourceRevisionIndex:0,spanId:'x'}]})).toThrow(/unknown_ref_field/);
  });
  it('recounts compact cursor overhead from semantic delivered positions and preserves canonical refs',()=>{
    const source=compactFixture();source.evidence=source.evidence.slice(0,1);const item=source.evidence[0]!;item.text='record 😀 '.repeat(500);item.startUtf16=0;item.endUtf16=item.text.length;item.provenance!.spanStartUtf16=0;item.provenance!.spanEndUtf16=item.endUtf16;
    const planned=planReadResponse(source,defaultBudget(1250),{project:'/toy'},'mcp',true,undefined,undefined,'compact-v1');
    expect(planned.usedTokens).toBeLessThanOrEqual(1250);expect(decodeCompactMemoryPacket(JSON.parse(emittedMcpResult(planned).content[0]!.text))).toEqual(planned.response);
    if('evidence' in planned.response){expect(planned.response.continuation).toBeTruthy();const cursor=decodeCursor(planned.response.continuation!);expect(cursor.positions[0]!.ref).toEqual(item.ref);expect(cursor.positions[0]!.startUtf16).toBe(planned.response.evidence[0]!.endUtf16);}
  });
  it('keeps durable write receipt expanded and uses its counted finalized MCP result',()=>{
    const receipt={contractVersion:2 as const,requestKey:'toy-write',batchId:'batch',noteIds:['n'],epochs:{evidence:1,notes:1,lineage:0,deletion:0,vector:0},redacted:false,authority:'agent_assertion' as const,supportStatus:'unverified' as const,committedAt:'now'};
    const planned=planWriteReceipt(receipt,defaultBudget(),'mcp');expect(JSON.stringify(emittedMcpResult(planned))).toBe(planned.serialized);expect(planned.response.budget.usedTokens).toBe(countTokens(planned.serialized));expect(planned.emission.format).toBe('expanded-v2');
  });
});
