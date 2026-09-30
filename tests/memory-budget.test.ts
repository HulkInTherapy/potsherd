import { describe, expect, it } from 'vitest';
import { countTokens, defaultBudget, planResponse, serializeResponse, TOKENIZER_ID, clipText } from '../packages/core/src/memory/budget.js';
import type { MemoryResponse } from '../packages/core/src/memory/contracts.js';
function response(): MemoryResponse {
 const text = ('A code block \\ "quotation" 日本語 😀\n').repeat(300);
 return {contractVersion:2,requestId:'test',coverage:{state:'complete_snapshot',snapshotEpochs:{evidence:1,notes:0,lineage:0,deletion:0,vector:0},scope:{},capturedThrough:null,pendingSources:0,failedSources:0,omittedKinds:[],semantic:'disabled'},support:{state:'unassessed',method:'none',requirements:[],unresolved:[]},evidence:[{ref:{sourceId:'s',revisionId:'r',spanId:'i'},text,role:'assistant',startUtf16:0,endUtf16:text.length,sourceEventAt:null,observedAt:'now',project:null,branch:null,authority:'source',citation:'i',historical:false,quoteBasis:'redacted_unit'}],assertions:[],candidates:[],budget:{tokenizerId:TOKENIZER_ID,usedTokens:0,remainingTokens:0,truncated:false,omittedItems:0},warnings:[]};
}
describe('whole-response transport accounting', () => {
 it('counts escaped MCP wrapper including self receipt and independent byte cap', () => {
  const planned = planResponse(response(), {...defaultBudget(1000),maxBytes:2500}, {transport:'mcp'});
  expect(countTokens(planned.serialized)).toBe(planned.usedTokens);
  expect(Buffer.byteLength(planned.serialized)).toBeLessThanOrEqual(2500);
  expect(planned.usedTokens).toBeLessThanOrEqual(1000);
  const actual = planned.response as MemoryResponse;
  expect(actual.budget.usedTokens).toBe(countTokens(serializeResponse(actual,'mcp')));
  expect(actual.evidence[0]!.endUtf16).toBe(actual.evidence[0]!.text.length);
 });
 it('preserves a caller literal in a tight rendered subrange and rechecks support',()=>{
  const source=response();source.evidence[0]!.text='irrelevant '.repeat(250)+'cache.X_9';source.evidence[0]!.endUtf16=source.evidence[0]!.text.length;
  const planned=planResponse(source,defaultBudget(400),{requirements:[{id:'literal',text:'literal exists',literal:'cache.X_9'}]});
  const actual=planned.response as MemoryResponse;expect(actual.evidence[0]!.text).toContain('cache.X_9');expect(actual.support.state).toBe('sufficient');expect(actual.budget.truncated).toBe(true);
 });
 it('reserves journey remaining tokens and returns valid bounded errors for tiny budgets', () => {
  const planned = planResponse(response(), {...defaultBudget(500),remainingJourneyTokens:20});
  expect(planned.usedTokens).toBeLessThanOrEqual(20);
  expect(JSON.parse(planned.serialized)).toEqual({error:'budget_too_small'});
 });
 it('treats literal special-token-looking archive text as ordinary text', () => {
  expect(countTokens('<|endoftext|>')).toBeGreaterThan(1);
 });
 it('never splits surrogate pairs when clipping', () => {
  const clipped = clipText('😀'.repeat(200),17);
  expect(clipped.endsWith('\ud83d')).toBe(false);
  expect(countTokens(clipped)).toBeLessThanOrEqual(17);
 });
});
