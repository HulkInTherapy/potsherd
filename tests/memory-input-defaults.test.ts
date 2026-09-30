import {describe,expect,it} from 'vitest';
import {validateMemoryInput,MemoryInputError} from '../packages/core/src/memory/input.js';
import {TOKENIZER_ID} from '../packages/core/src/memory/budget.js';

describe('public memory accounting input defaults',()=>{
 for(const [kind,fields] of Object.entries({recall:{query:'toy'},read:{refs:[]},graft:{query:'toy'},write:{requestKey:'toy',entries:[{kind:'observation',text:'toy'}]}})){
  it(`${kind} uses the pinned accountant when a supplied budget omits tokenizerId`,()=>{
   const value=validateMemoryInput(kind as 'recall'|'read'|'graft'|'write',{...fields,budget:{maxTokens:2048}});
   expect(value.budget).toEqual({maxTokens:2048,tokenizerId:TOKENIZER_ID});
  });
 }
 for(const [budget,code,field] of [
  [{maxTokens:2048,tokenizerId:'private-tokenizer-secret'},'unsupported_budget_tokenizerId','budget.tokenizerId'],
  [{maxTokens:2048,tokenizerId:null},'invalid_budget_tokenizerId','budget.tokenizerId'],
  [{maxTokens:'private-value-secret'},'invalid_budget_maxTokens','budget.maxTokens'],
  [{maxTokens:2048,maxBytes:1},'invalid_budget_maxBytes','budget.maxBytes'],
  [{maxTokens:2048,remainingJourneyTokens:1},'invalid_budget_remainingJourneyTokens','budget.remainingJourneyTokens'],
 ] as const){
  it(`rejects ${code} with a field-specific explanation without echoing values`,()=>{
   try{validateMemoryInput('recall',{query:'toy',budget});throw new Error('unexpected acceptance');}
   catch(error){expect(error).toBeInstanceOf(MemoryInputError);expect((error as MemoryInputError).code).toBe(code);expect((error as Error).message).toContain(field);expect((error as Error).message).not.toContain('private-');}
  });
 }
 it('does not normalize malformed budget objects or unsupported scope boundaries',()=>{
  expect(()=>validateMemoryInput('recall',{query:'toy',budget:[]})).toThrow(/budget must be a JSON object/);
  expect(()=>validateMemoryInput('recall',{query:'toy',scope:{projcet:'/toy'},budget:{maxTokens:2048}})).toThrow(/unknown_scope_field/);
  expect(()=>validateMemoryInput('recall',{query:{secret:'private-query-secret'}})).toThrow(/query must be text/);
 });
});
