import {afterEach,describe,it,expect,vi} from 'vitest';
import {AUDIT_INTENTS} from '../../packages/core/src/analytics/contracts.js';
import {JEV_MODEL,JEV_ATTEMPT_RESERVATION_USD,validateJevResponse,type JevRequest} from '../../packages/core/src/analytics/jev-contract.js';
import {JevProvider,jevKeyFromEnvironment,type JevCacheIdentity,type JevJob} from '../../packages/core/src/analytics/jev-provider.js';
import {promptQuestionRequest,suppliedTopicRequest,paraphrasePairRequest,adjacentTransitionRequest,primaryIntent} from '../../packages/core/src/analytics/jev-questions.js';

const jobs:JevJob[]=[];afterEach(()=>{jobs.splice(0).forEach(job=>{job.cancel();job.dispose();});vi.restoreAllMocks();vi.unstubAllEnvs();});
const request=():JevRequest=>({model:JEV_MODEL,state:'Synthetic public input only',questions:{requested:{type:'noul',instructions:'Does this request a code change?'}}});
const identity: JevCacheIdentity={contentHash:'content',scopeHash:'scope',privacyVersion:'privacy-v1',normalizationVersion:'normalization-v1',questionVersion:'questions-v1',sourceVersion:'source-v1',segmentationVersion:'window-v1'};
function raw(req:JevRequest){return {model:JEV_MODEL,answers:Object.fromEntries(Object.entries(req.questions).map(([id,q])=>[id,q.type==='noul'?{type:'noul',noul:0.8}:q.type==='choice'?{type:'choice',choice:Object.keys(q.criteria)[0],probabilities:Object.fromEntries(Object.keys(q.criteria).map((key,i)=>[key,i===0?1:0])),confidence:1}:{type:'score',score:1,legend:Object.fromEntries(q.criteria.map((level,i)=>[String(i),level])),probabilities:Object.fromEntries(q.criteria.map((_,i)=>[String(i),i===1?1:0])),confidence:1}])),usage:{input_tokens:1000,output_tokens:50}};}
const response=(req:JevRequest)=>new Response(JSON.stringify(raw(req)),{status:200,headers:{'Content-Type':'application/json','x-typesafe-request-id':'synthetic-request'}});
function job(provider:JevProvider,options:Partial<Parameters<JevProvider['beginJob']>[0]>={}){const result=provider.beginJob({consent:true,maxRequests:20,budgetUsd:0.2,isCurrent:()=>true,...options});jobs.push(result);return result;}

describe('Jev v1 strict validation and bounded builders',()=>{
 it('retains all16 primary options and independent activity/steering questions with complete meanings',()=>{
  const req=promptQuestionRequest({target:{role:'user',text:'Build the export and preserve existing command names.'},precedingUser:[],assistantContext:'unavailable'});expect(req.questions.primary_intent!.type).toBe('choice');expect(Object.keys((req.questions.primary_intent as {criteria:object}).criteria)).toEqual([...AUDIT_INTENTS]);expect(req.questions.preservation_constraint!.instructions).toContain('target.text');expect(req.questions.explicit_correction!.type).toBe('noul');expect(Object.keys(req.questions)).toHaveLength(18);expect(validateJevResponse(raw(req),req).answers.activity_tests!.type).toBe('noul');
 });
 it('checks Choice option coverage and Score legend, expected mean, bounds, IDs, model and usage',()=>{
  const req=suppliedTopicRequest('A public test excerpt',[{id:'A',text:'Testing'},{id:'B',text:'Deployment'}]);expect(validateJevResponse(raw(req),req).answers.topic_relevance_0!.type).toBe('score');
  const cases=[(v:any)=>delete v.answers.topic_selection,(v:any)=>v.answers.extra={type:'noul',noul:1},(v:any)=>v.model='jev-latest',(v:any)=>v.answers.topic_selection.choice='omitted',(v:any)=>v.answers.topic_selection.probabilities.A=0.5,(v:any)=>v.answers.topic_selection.confidence=NaN,(v:any)=>v.answers.topic_relevance_0.legend['1']='wrong',(v:any)=>v.answers.topic_relevance_0.score=0.2,(v:any)=>v.usage.input_tokens=-1,(v:any)=>v.usage.output_tokens=1.5,(v:any)=>v.answers.topic_relevance_0.probabilities['2']=Infinity];
  for(const mutate of cases){const value=raw(req);mutate(value);expect(()=>validateJevResponse(value,req)).toThrow();}
 });
 it('builds bounded supplied pairs and actual adjacent-transition questions without generated candidate text',()=>{
  const pairs=[{id:'pair',left:'Preserve the public command names.',right:'Keep existing command names.'}];expect(paraphrasePairRequest(pairs).questions.pair_0!.instructions).toContain('material constraints');expect(adjacentTransitionRequest(pairs).questions.transition_0!.instructions).toContain('chronological adjacent');expect(()=>paraphrasePairRequest(Array.from({length:17},(_,i)=>({...pairs[0]!,id:String(i)})))).toThrow();expect(()=>suppliedTopicRequest('x',[{id:'no_match',text:'x'}])).toThrow();
 });
});

describe('Jev transport mock-only qualification',()=>{
 it('dispatches current v1 JSON with bounded reservation and keeps cached data isolated from callers',async()=>{
  const fetch=vi.fn(async()=>response(request())),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch}),j=job(provider);const result=await j.evaluate(request(),identity);expect(result.state).toBe('ok');expect(fetch).toHaveBeenCalledTimes(1);const init=fetch.mock.calls[0]![1] as RequestInit;expect(JSON.parse(String(init.body)).model).toBe(JEV_MODEL);expect(provider.ledger()[0]!.requestId).toBe('synthetic-request');expect(j.stats().reportedCostUsd).toBeCloseTo(0.000042);expect(j.stats().unresolvedCostUsd).toBe(0);
  const warm=job(provider,{maxRequests:0,budgetUsd:0});expect((await warm.evaluate(request(),identity)).state).toBe('ok');expect(warm.stats().requestCount).toBe(0);expect(warm.stats().cacheHits).toBe(1);expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('binds cache to content, scope, privacy, normalization, source, question and actual Choice order',async()=>{
  const req=suppliedTopicRequest('Public excerpt',[{id:'A',text:'Testing'},{id:'B',text:'Deployment'}]);const fetch=vi.fn(async(_url:unknown,init:RequestInit)=>response(JSON.parse(String(init.body)) as JevRequest)),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch}),j=job(provider);
  await j.evaluate(req,identity);for(const key of ['contentHash','scopeHash','privacyVersion','normalizationVersion','sourceVersion','questionVersion','segmentationVersion'] as const)await j.evaluate(req,{...identity,[key]:'changed'});
  const reordered={...req,questions:{...req.questions,topic_selection:{...req.questions.topic_selection!,type:'choice' as const,criteria:{B:'Deployment',A:'Testing',no_match:'None of the supplied topics matches the excerpt.',insufficient_context:'The excerpt does not establish which supplied topic applies.'}}}};await j.evaluate(reordered,identity);expect(fetch).toHaveBeenCalledTimes(9);
 });
 it('reuses raw distributions for local threshold changes without a new request',async()=>{
  const req=promptQuestionRequest({target:{role:'user',text:'Build a test widget.'},precedingUser:[],assistantContext:'unavailable'}),value=raw(req);value.answers.primary_intent={type:'choice',choice:'feature_build',probabilities:Object.fromEntries(AUDIT_INTENTS.map((id,i)=>[id,i===0?0.7:0.02])),confidence:0.68};const fetch=vi.fn(async()=>new Response(JSON.stringify(value))),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch}),j=job(provider);const first=await j.evaluate(req,identity);if(first.state!=='ok')throw new Error('fixture failed');expect(primaryIntent(first.response.answers.primary_intent,0.6).intent).toBe('feature_build');expect(primaryIntent(first.response.answers.primary_intent,0.9).abstained).toBe(true);expect((await j.evaluate(req,identity)).state).toBe('ok');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it.each([401,422])('does not retry rejected HTTP%s and does not claim unknown billing is free',async(status)=>{
  const fetch=vi.fn(async()=>new Response('{}',{status})),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch}),j=job(provider);expect((await j.evaluate(request(),identity)).state).toBe('failed');expect(fetch).toHaveBeenCalledTimes(1);expect(j.stats().unresolvedCostUsd).toBe(JEV_ATTEMPT_RESERVATION_USD);
 });
 it.each([429,529])('retries HTTP%s once only when delay/deadline/reservation fit',async(status)=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response('{}',{status,headers:{'retry-after-ms':'0'}})).mockImplementation(async()=>response(request())),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch,attemptTimeoutMs:100}),j=job(provider,{deadlineMs:1000,maxRequests:2});expect((await j.evaluate(request(),identity)).state).toBe('ok');expect(fetch).toHaveBeenCalledTimes(2);expect(j.stats().requestCount).toBe(2);expect(j.stats().unresolvedCostUsd).toBe(JEV_ATTEMPT_RESERVATION_USD);
 });
 it('refuses an oversized server retry delay and a second reservation beyond the remaining budget',async()=>{
  const delayed=vi.fn(async()=>new Response('{}',{status:429,headers:{'retry-after':'60'}})),provider=new JevProvider({apiKey:'synthetic-key',fetch:delayed as typeof globalThis.fetch,attemptTimeoutMs:100}),j=job(provider,{deadlineMs:1000});await j.evaluate(request(),identity);expect(delayed).toHaveBeenCalledTimes(1);
  const noBudget=vi.fn(async()=>new Response('{}',{status:529,headers:{'retry-after-ms':'0'}})),other=new JevProvider({apiKey:'synthetic-key',fetch:noBudget as typeof globalThis.fetch,attemptTimeoutMs:100}),one=job(other,{budgetUsd:JEV_ATTEMPT_RESERVATION_USD,deadlineMs:1000});await one.evaluate(request(),identity);expect(noBudget).toHaveBeenCalledTimes(1);
 });
 it('times out an abort-ignoring transport and retains its potentially billed reservation',async()=>{
  const fetch=vi.fn(()=>new Promise<Response>(()=>{})),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch,attemptTimeoutMs:10}),j=job(provider,{deadlineMs:100});const result=await j.evaluate(request(),identity);expect(result).toEqual({state:'failed',code:'timeout'});expect(fetch).toHaveBeenCalledTimes(1);expect(j.stats().unresolvedCostUsd).toBe(JEV_ATTEMPT_RESERVATION_USD);
 });
 it('cancels queued and active work without dispatching the queued request',async()=>{
  const fetch=vi.fn(()=>new Promise<Response>(()=>{})),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch}),j=job(provider);const results=[j.evaluate(request(),identity),j.evaluate(request(),{...identity,contentHash:'two'}),j.evaluate(request(),{...identity,contentHash:'three'})];expect(fetch).toHaveBeenCalledTimes(2);j.cancel();const outcomes=await Promise.all(results);expect(outcomes[2]).toEqual({state:'skipped',code:'cancelled_before_dispatch'});expect(fetch).toHaveBeenCalledTimes(2);expect(j.stats().unresolvedCostUsd).toBe(2*JEV_ATTEMPT_RESERVATION_USD);
 });
 it('cancels backoff, validates malformed bodies/model output, and clears cache on privacy change',async()=>{
  const fetch=vi.fn(async()=>new Response('{}',{status:429,headers:{'retry-after-ms':'100'}})),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch,attemptTimeoutMs:10}),j=job(provider,{deadlineMs:1000});const pending=j.evaluate(request(),identity);await new Promise(resolve=>setTimeout(resolve,5));j.cancel();expect((await pending).state).toBe('failed');expect(fetch).toHaveBeenCalledTimes(1);
  for(const value of ['not JSON',JSON.stringify({...raw(request()),model:'jev-preview'}),JSON.stringify({model:JEV_MODEL,answers:{},usage:{input_tokens:1,output_tokens:0}})]){const p=new JevProvider({apiKey:'synthetic-key',fetch:(async()=>new Response(value)) as typeof globalThis.fetch});expect((await job(p).evaluate(request(),identity)).state).toBe('failed');expect(p.ledger()[0]!.billing).toBe('unknown');}
  let current=true;const safeFetch=vi.fn(async()=>{current=false;return response(request());}),p=new JevProvider({apiKey:'synthetic-key',fetch:safeFetch as typeof globalThis.fetch}),priv=job(p,{isCurrent:()=>current});expect(await priv.evaluate(request(),identity)).toEqual({state:'failed',code:'privacy_changed'});expect(priv.stats().reportedCostUsd).toBeCloseTo(0.000042);current=true;await job(p).evaluate(request(),identity);expect(safeFetch).toHaveBeenCalledTimes(2);
 });
 it('requires consent and reads only named environment variables without any request',()=>{
  const fetch=vi.fn(),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch});expect(()=>provider.beginJob({consent:false,maxRequests:1,budgetUsd:1,isCurrent:()=>true} as any)).toThrow('consent_required');vi.stubEnv('POTSHERD_TYPESAFE_API_KEY','synthetic-priority-key');vi.stubEnv('TYPESAFE_API_KEY','synthetic-other-key');expect(jevKeyFromEnvironment()).toBe('synthetic-priority-key');expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects invalid job deadlines before creating timers or dispatching',()=>{
  const fetch=vi.fn(),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch});for(const deadlineMs of [NaN,Infinity,0,-1,20001])expect(()=>provider.beginJob({consent:true,maxRequests:1,budgetUsd:1,isCurrent:()=>true,deadlineMs})).toThrow('invalid_deadline');expect(fetch).not.toHaveBeenCalled();
 });
 it('removes completed queue abort listeners and snapshots caller-owned request data before enqueue',async()=>{
  const fetch=vi.fn(async(_url:unknown,init:RequestInit)=>response(JSON.parse(String(init.body)))),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch}),j=job(provider),add=vi.spyOn(j.signal,'addEventListener'),remove=vi.spyOn(j.signal,'removeEventListener');
  for(let i=0;i<14;i++)await j.evaluate(request(),{...identity,contentHash:String(i)});expect(fetch).toHaveBeenCalledTimes(14);expect(add.mock.calls.filter(c=>c[0]==='abort')).toHaveLength(remove.mock.calls.filter(c=>c[0]==='abort').length);
  const complete:((response:Response)=>void)[]=[],pendingFetch=vi.fn((_url:unknown,_init:RequestInit)=>new Promise<Response>(resolve=>complete.push(resolve))),queuedProvider=new JevProvider({apiKey:'synthetic-key',fetch:pendingFetch as typeof globalThis.fetch}),other=job(queuedProvider);const first=other.evaluate(request(),identity),second=other.evaluate(request(),{...identity,contentHash:'second'}),thirdRequest=request(),third=other.evaluate(thirdRequest,{...identity,contentHash:'third'});thirdRequest.state='Changed caller data after enqueue';complete[0]!(response(request()));await first;expect(JSON.parse(String(pendingFetch.mock.calls[2]![1].body)).state).toBe('Synthetic public input only');complete[1]!(response(request()));complete[2]!(response(request()));await Promise.all([second,third]);expect(pendingFetch).toHaveBeenCalledTimes(3);
 });
 it('reduces subsequent dispatch concurrency after overload instead of immediately reopening two slots',async()=>{
  let call=0;const complete:((response:Response)=>void)[]=[];const fetch=vi.fn(()=>{if(++call===1)return Promise.resolve(new Response('{}',{status:429,headers:{'retry-after':'60'}}));return new Promise<Response>(resolve=>complete.push(resolve));}),provider=new JevProvider({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch,attemptTimeoutMs:1000}),j=job(provider,{deadlineMs:2000});
  await j.evaluate(request(),identity);const a=j.evaluate(request(),{...identity,contentHash:'A'}),b=j.evaluate(request(),{...identity,contentHash:'B'});expect(fetch).toHaveBeenCalledTimes(2);complete[0]!(response(request()));await a;await new Promise(resolve=>setTimeout(resolve,0));expect(fetch).toHaveBeenCalledTimes(3);complete[1]!(response(request()));await b;
 });
});
