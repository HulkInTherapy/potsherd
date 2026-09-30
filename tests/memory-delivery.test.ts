import {describe,it,expect} from 'vitest';
import {compactFixture} from './memory-compact-fixture.js';
import {completeDeliveredSpan,complementaryReadRefs,planComplementaryRead} from '../packages/core/src/memory/delivery.js';
import {planReadResponse} from '../packages/core/src/memory/context.js';
import {countTokens,defaultBudget} from '../packages/core/src/memory/budget.js';

describe('complementary batch admission',()=>{
 it('orders support, clipped completion, then bare routes and deduplicates',()=>{
  const p=compactFixture();const support=p.candidates[0]!.ref;
  p.assertions=[{supportRefs:[support,support]} as never];
  expect(complementaryReadRefs(p)).toEqual([support,p.evidence[0]!.ref]);
 });
 it('bounds a known completion and first offered route even when later scores are higher',()=>{
  const p=compactFixture();p.evidence=p.evidence.slice(0,1);p.assertions=[];const first=p.candidates[0]!;p.candidates=[{...first,score:0.01},{...first,ref:{...first.ref,spanId:'other'},score:0.99}];
  expect(complementaryReadRefs(p)).toEqual([p.evidence[0]!.ref,first.ref]);
 });
 it('keeps third and later routes reachable after a bounded tuple is explicitly attempted',()=>{
  const p=compactFixture();p.evidence=[];p.assertions=[];const first=p.candidates[0]!;p.candidates=[0,1,2,3].map(i=>({...first,ref:{...first.ref,spanId:`route${i}`}}));
  const tuple=complementaryReadRefs(p);expect(tuple).toHaveLength(2);
  const attempted=new Set(tuple.map(ref=>JSON.stringify([ref.sourceId,ref.revisionId,ref.spanId])));
  expect(complementaryReadRefs(p,[],attempted)).toEqual(p.candidates.slice(2).map(c=>c.ref));
 });
 it('requires contiguous coverage with matching immutable bounds',()=>{
  const p=compactFixture(),item=p.evidence[0]!;item.provenance!.spanStartUtf16=0;item.provenance!.spanEndUtf16=10;
  const a={...item,startUtf16:0,endUtf16:6},b={...item,startUtf16:5,endUtf16:10};
  expect(completeDeliveredSpan([a,b],item.ref)).toBe(true);
  expect(completeDeliveredSpan([a,{...b,startUtf16:7}],item.ref)).toBe(false);
  expect(completeDeliveredSpan([a,{...b,provenance:{...b.provenance!,spanEndUtf16:11}}],item.ref)).toBe(false);
 });
 it('skips full delivered spans without treating a bare route as evidence',()=>{
  const p=compactFixture();for(const item of p.evidence){item.provenance!.spanStartUtf16=item.startUtf16;item.provenance!.spanEndUtf16=item.endUtf16;}
  expect(complementaryReadRefs(p)).toEqual([p.candidates[0]!.ref]);
 });

 it('prices an advancing cursor with its useful quote and never calls planner twice',()=>{
  const p=compactFixture();p.candidates=[];p.evidence=p.evidence.slice(0,1);const item=p.evidence[0]!;item.text='independent recorded outcome '.repeat(3000);item.endUtf16=item.startUtf16+item.text.length;item.provenance!.spanEndUtf16=item.endUtf16;
  let calls=0;const plan=planComplementaryRead(p,defaultBudget(2048),input=>{calls++;return planReadResponse(p,input.budget,input.scope,'mcp',true,undefined,undefined,'compact-v1');},[]);
  expect(calls).toBe(1);expect(plan.state).toBe('ready');expect(plan.planned!.response.continuation).toBeTruthy();expect(plan.planned!.response.evidence[0]!.text.length).toBeGreaterThan(0);expect(countTokens(plan.planned!.emission.serialized)).toBe(plan.usedTokens);expect(plan.usedTokens).toBeLessThanOrEqual(2048);
 });
 for(const transport of ['cli_json','mcp'] as const)it(`admits useful exact wire below 2048 and visibly stops infeasible ${transport}`,()=>{
  const p=compactFixture();p.candidates=[];p.evidence=p.evidence.slice(0,1);
  const read=(input:any)=>planReadResponse(p,input.budget,input.scope,transport,true,undefined,undefined,'compact-v1');
  const full=planComplementaryRead(p,defaultBudget(2048),read,[]);expect(full.state).toBe('ready');
  const cost=full.usedTokens;expect(cost).toBeLessThan(2048);
  const exact=planComplementaryRead(p,defaultBudget(cost),read,[]);expect(exact.state).toBe('ready');expect(exact.usedTokens).toBeLessThanOrEqual(cost);
  expect(countTokens(exact.planned!.emission.serialized)).toBe(exact.usedTokens);
  expect(exact.request!.scope).toEqual(p.coverage.scope);
  const impossible=planComplementaryRead(p,defaultBudget(64),read,[]);expect(impossible.state).toBe('budget_incomplete');
  expect(impossible.usedTokens).toBeLessThanOrEqual(64);
 });
});
