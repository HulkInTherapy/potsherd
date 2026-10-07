import {describe,it,expect} from 'vitest';
import {extractNativeUsage} from '../../packages/core/src/analytics/native-usage.js';
const bytes=(rows:unknown[])=>Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
const t='2026-10-07T08:00:00Z';
describe('native per-response inference facts',()=>{
 it('keeps Codex model switches and deduplicates replayed cumulative reports; cache and reasoning stay included',()=>{
  const total=(input:number,output:number,cache:number,reasoning:number)=>({input_tokens:input,output_tokens:output,cached_input_tokens:cache,reasoning_output_tokens:reasoning});
  const count=(tot:unknown,last:unknown)=>({timestamp:t,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:tot,last_token_usage:last}}});
  const first=count(total(100,30,40,10),{input_tokens:100,output_tokens:30});
  const out=extractNativeUsage(bytes([{type:'session_meta',payload:{id:'s',model_provider:'openai'}},{type:'turn_context',payload:{model:'gpt-5.4'}},first,first,{type:'turn_context',payload:{model:'gpt-5-mini'}},count(total(200,60,60,15),total(100,30,20,5))]),'codex','c');
  expect(out).toHaveLength(2);expect(out.map(r=>r.model)).toEqual(['gpt-5.4','gpt-5-mini']);expect(out[0]).toMatchObject({inputTokens:100,outputTokens:30,cacheReadTokens:40,reasoningTokens:10,inputIncludesCache:true,outputIncludesReasoning:true,provider:'openai'});expect(out[1]!.cacheReadTokens).toBe(20);
 });
 it('advances excluded cumulative baselines and preserves unknown initial cumulative usage',()=>{
  const out=extractNativeUsage(bytes([100,160,190].map((input,i)=>({timestamp:t,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:input/10,cached_input_tokens:0,reasoning_output_tokens:0}}},allowed:i!==1}))),'codex','c',{acceptRecord:r=>r.allowed!==false});
  expect(out).toHaveLength(2);expect(out[0]!.inputTokens).toBeNull();expect(out[0]!.gaps).toContain('cumulative_baseline_unknown');expect(out[1]!.inputTokens).toBe(30);expect(out[1]!.model).toBeNull();
 });
 it('merges Claude streamed blocks by native response ID without counting tokens twice, keeps different model responses',()=>{
  const row=(uuid:string,id:string,model:string,output:number)=>({type:'assistant',uuid,timestamp:t,cwd:'/p',provider:'anthropic',message:{id,role:'assistant',model,usage:{input_tokens:10,output_tokens:output,cache_read_input_tokens:100,cache_creation_input_tokens:20}}});
  const out=extractNativeUsage(bytes([row('b1','msg1','claude-sonnet-4-6',2),row('b2','msg1','claude-sonnet-4-6',8),row('b3','msg2','claude-opus-4-5',4)]),'claude','c');
  expect(out).toHaveLength(2);expect(out[0]).toMatchObject({inputTokens:10,outputTokens:8,cacheReadTokens:100,cacheWriteTokens:20,inputIncludesCache:false});expect(out[1]!.model).toBe('claude-opus-4-5');
 });
 it('does not invent Claude endpoints and rejects conflicting streamed model attribution',()=>{
  const out=extractNativeUsage(bytes(['a','b'].map(model=>({type:'assistant',message:{role:'assistant',id:'same',model,usage:{input_tokens:1,output_tokens:2}}}))),'claude','c');expect(out).toHaveLength(1);expect(out[0]!.provider).toBeNull();expect(out[0]!.model).toBeNull();expect(out[0]!.gaps).toContain('response_identity_model_conflict');
 });
 it('uses pi assistant usage per node, ignores tool/user records and scope-excluded inference',()=>{
  const row=(id:string,model:string,role='assistant')=>({id,type:'message',timestamp:t,message:{role,provider:'anthropic-vertex',model,usage:{input:5,output:10,cacheRead:40,cacheWrite:20,cost:{total:0.1}}}});
  const out=extractNativeUsage(bytes([row('1','a'),row('1','a'),row('2','b'),row('3','b','toolResult'),row('4','b')]),'pi','c',{acceptRecord:r=>r.id!=='4'});expect(out).toHaveLength(2);expect(out[0]).toMatchObject({inputTokens:5,cacheReadTokens:40,reportedCostUsd:0.1,provider:'anthropic-vertex'});expect(out[1]!.model).toBe('b');
 });
 it('recognizes bounded OpenCode metadata exports with separate reasoning and cache',()=>{
  const row=(id:string,modelID:string)=>({type:'message',id,timestamp:t,message:{id,role:'assistant',providerID:'opencode',modelID,tokens:{input:3,output:10,reasoning:5,cache:{read:20,write:2}},cost:0},content:[{type:'text',text:'fixture'}]});
  const out=extractNativeUsage(bytes([row('one','gpt-5.4'),row('one','gpt-5.4'),row('two','jev-1.13-free')]),'opencode','c');expect(out).toHaveLength(2);expect(out[0]).toMatchObject({inputTokens:3,outputTokens:10,reasoningTokens:5,inputIncludesCache:false,outputIncludesReasoning:false});expect(out[1]!.model).toBe('jev-1.13-free');
 });
 it('does not use unsafe or negative token counts as recorded numbers',()=>{
  const out=extractNativeUsage(bytes([{type:'message',id:'bad',message:{role:'assistant',model:'x',usage:{input:-1,output:Number.MAX_SAFE_INTEGER+1}}}]),'pi','c');expect(out[0]!.inputTokens).toBeNull();expect(out[0]!.outputTokens).toBeNull();expect(out[0]!.gaps).toContain('usage_partial');
 });
});
