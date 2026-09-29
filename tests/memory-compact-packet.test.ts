import { describe, expect, it } from 'vitest';
import { encodeCompactMemoryPacket, decodeCompactMemoryPacket, canonicalPacketRef } from '../packages/core/src/memory/packet.js';
import type { EvidenceItem } from '../packages/core/src/memory/contracts.js';

import { compactFixture } from './memory-compact-fixture.js';
describe('standalone lossless compact packet',()=>{
  it('factors exact repeated facts and retains full canonical refs, citation forms and prototype-like locator JSON',()=>{
    const input=compactFixture(),packet=encodeCompactMemoryPacket(input);
    expect(packet.sourceRevisions).toHaveLength(1);expect(packet.units).toHaveLength(1);expect(packet.chunkPolicies).toHaveLength(1);
    expect(decodeCompactMemoryPacket(JSON.parse(JSON.stringify(packet)))).toEqual(input);
    expect(canonicalPacketRef(packet,1)).toEqual(input.evidence[1]!.ref);
    expect(({} as {polluted?:boolean}).polluted).toBeUndefined();
    expect(encodeCompactMemoryPacket(input)).toEqual(packet);expect(input.evidence[0]!.provenance!.locator.extra).toEqual(JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary JSON", "empty":""}'));
  });
  it('preserves absence versus empty provenance and optional null versus absence without inventing facts',()=>{
    const input=compactFixture();delete input.evidence[0]!.provenance;input.evidence[1]!.provenance={} as EvidenceItem['provenance'];delete input.evidence[0]!.toolOutcome;
    const out=decodeCompactMemoryPacket(encodeCompactMemoryPacket(input));expect(out).toEqual(input);
    expect(Object.hasOwn(out.evidence[0]!,'provenance')).toBe(false);expect(Object.hasOwn(out.evidence[1]!,'provenance')).toBe(true);
    expect(Object.hasOwn(out.evidence[0]!,'toolOutcome')).toBe(false);expect(out.evidence[0]!.sourceEventAt).toBeNull();
  });
  it('keeps equal text with different source/revision/time/role/authority/outcome distinct, and literal custom citations unchanged',()=>{
    const input=compactFixture();input.evidence[1]!.ref.sourceId='other';input.evidence[1]!.ref.revisionId='old';input.evidence[1]!.sourceEventAt='2026-08-01';input.evidence[1]!.role='ghost_prompt';input.evidence[1]!.historical=true;input.evidence[1]!.authority='request_only';input.evidence[1]!.toolOutcome='error';input.evidence[1]!.citation='literal citation @ not canonical';
    const packet=encodeCompactMemoryPacket(input);expect(packet.sourceRevisions).toHaveLength(2);expect(packet.units).toHaveLength(2);expect(packet.response.evidence[1]!.citationForm).toBeUndefined();expect(decodeCompactMemoryPacket(packet)).toEqual(input);
  });
  it('does not promote candidates or assertions to evidence or invent support on empty packets',()=>{
    const input=compactFixture();input.evidence=[];input.assertions=[{noteId:'n',batchId:'b',kind:'observation',text:'author claim',project:'/toy',branch:null,eventAt:null,observedAt:'now',validFrom:null,validUntil:null,authority:'agent_assertion',supportStatus:'unverified',supportRefs:[],supersedes:[],current:true,originSourceId:null,lineageAnchorSourceId:null,authorClaim:'agent',origin:'api'}];
    const out=decodeCompactMemoryPacket(encodeCompactMemoryPacket(input));expect(out).toEqual(input);expect(out.evidence).toEqual([]);expect(out.support.state).toBe('unassessed');
  });
  it.each([
    ['version',(p:any)=>{p.packetVersion=2;}],['lifetime',(p:any)=>{p.indexLifetime='session';}],['unknown wrapper',(p:any)=>{p.extra=true;}],
    ['negative index',(p:any)=>{p.response.evidence[0].unitIndex=-1;}],['fractional index',(p:any)=>{p.response.evidence[0].unitIndex=0.5;}],['dangling index',(p:any)=>{p.response.evidence[0].sourceRevisionIndex=99;}],
    ['policy index',(p:any)=>{p.response.evidence[0].chunkPolicyIndex=99;}],['partition collision',(p:any)=>{p.response.evidence[0].facts.role='user';}],['provenance collision',(p:any)=>{p.response.evidence[0].spanProvenance.unitKey='wrong';}],
    ['presence contradiction',(p:any)=>{p.response.evidence[0].provenancePresent=false;}],['citation collision',(p:any)=>{p.response.evidence[0].facts.citation='conflict';}],['citation mode',(p:any)=>{p.response.evidence[0].citationForm='approximate';}],
    ['range mismatch',(p:any)=>{p.response.evidence[0].facts.endUtf16++;}],['immutable bounds',(p:any)=>{p.response.evidence[0].spanProvenance.spanEndUtf16=1;}],['null provenance',(p:any)=>{p.units[0].provenance=null;}],['null outcome',(p:any)=>{p.units[0].facts.toolOutcome=null;}],
    ['surrogate clipping',(p:any)=>{p.response.evidence[0].facts.text='\ud83d';p.response.evidence[0].facts.endUtf16=11;}],['table bound',(p:any)=>{p.units=Array.from({length:257},()=>p.units[0]);}],
  ])('rejects hostile %s instead of silently merging or coercing',(_name,mutate)=>{
    const packet=encodeCompactMemoryPacket(compactFixture());mutate(packet);expect(()=>decodeCompactMemoryPacket(packet)).toThrow(/invalid_memory_packet/);
  });
  it('rejects custom prototypes, getters, cycles, sparse arrays and excessive nested expansion',()=>{
    const valid=encodeCompactMemoryPacket(compactFixture());
    const inherited=Object.create({packetVersion:1});expect(()=>decodeCompactMemoryPacket(inherited)).toThrow(/prototype/);
    Object.defineProperty(valid,'packetVersion',{get(){throw new Error('getter executed');},enumerable:true});expect(()=>decodeCompactMemoryPacket(valid)).toThrow(/property/);
    const cyclic:any=encodeCompactMemoryPacket(compactFixture());cyclic.response.extra=cyclic;expect(()=>decodeCompactMemoryPacket(cyclic)).toThrow(/cycle/);
    const sparse:any=encodeCompactMemoryPacket(compactFixture());sparse.response.warnings=Array(1);expect(()=>decodeCompactMemoryPacket(sparse)).toThrow(/sparse_array/);
    const nested:any=encodeCompactMemoryPacket(compactFixture());let v:any=nested.response;for(let i=0;i<34;i++){v.extra={};v=v.extra;}expect(()=>decodeCompactMemoryPacket(nested)).toThrow(/size/);
    expect(()=>canonicalPacketRef(encodeCompactMemoryPacket(compactFixture()),9)).toThrow(/index/);
  });
});
