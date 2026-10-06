import {randomUUID} from 'node:crypto';
import {digest} from './source.js';
import {JEV_MODEL,JEV_ATTEMPT_RESERVATION_USD,JEV_PRICE_PER_MILLION_INPUT,JevFailure,validateJevRequest,validateJevResponse,type JevRequest,type JevResponse} from './jev-contract.js';

export interface JevCacheIdentity {contentHash:string;scopeHash:string;privacyVersion:string;normalizationVersion:string;questionVersion:string;sourceVersion:string;segmentationVersion:string;}
export interface JevAttempt {id:string;requestHash:string;scopeHash:string;model:string;dispatchedAt:string;completedAt:string|null;status:number|null;outcome:'running'|'success'|'failed';billing:'reserved'|'reported'|'unknown';reservedUsd:number;reportedUsd:number|null;inputTokens:number|null;outputTokens:number|null;requestId:string|null;errorCode:string|null;}
export type JevResult={state:'ok';response:JevResponse;cacheHit:boolean;requestId:string|null}|{state:'failed'|'skipped';code:string};
export interface JevJobOptions {consent:true;maxRequests:number;budgetUsd:number;signal?:AbortSignal;isCurrent:()=>boolean;deadlineMs?:number;}
export interface JevProviderOptions {apiKey:string;fetch?:typeof globalThis.fetch;attemptTimeoutMs?:number;cacheEntries?:number;ledgerEntries?:number;}
interface Queued {job:JevJob;request:JevRequest;identity:JevCacheIdentity;key:string;resolve:(result:JevResult)=>void;cleanup:()=>void;}
interface Cached {response:JevResponse;requestId:string|null;}
function signalled<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{if(signal.aborted){reject(new JevFailure('cancelled'));return;}const aborted=()=>reject(new JevFailure('cancelled'));signal.addEventListener('abort',aborted,{once:true});promise.then(value=>{signal.removeEventListener('abort',aborted);if(signal.aborted)reject(new JevFailure('cancelled'));else resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});});}
const coded=(value:unknown)=>value instanceof JevFailure?value.code:'connection';
export function jevKeyFromEnvironment():string|null{return process.env['POTSHERD_TYPESAFE_API_KEY']?.trim()||process.env['TYPESAFE_API_KEY']?.trim()||null;}
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new JevFailure('cancelled'));return;}const aborted=()=>{clearTimeout(timer);reject(new JevFailure('cancelled'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},ms);signal.addEventListener('abort',aborted,{once:true});});

/** In-memory transport only. No implicit retries, store writes, logs, or credential-file reads. */
export class JevProvider {
 private active=0;private concurrency=2;private queue:Queued[]=[];private cache=new Map<string,Cached>();private attempts:JevAttempt[]=[];private readonly transport:typeof globalThis.fetch;
 constructor(private readonly options:JevProviderOptions){if(!options.apiKey.trim())throw new JevFailure('no_key');for(const [value,max] of [[options.attemptTimeoutMs??10000,10000],[options.cacheEntries??128,512],[options.ledgerEntries??256,512]])if(!Number.isSafeInteger(value)||value!<1||value!>max!)throw new JevFailure('invalid_provider_options');this.transport=options.fetch??((input,init)=>globalThis.fetch(input,init));}
 beginJob(options:JevJobOptions):JevJob{return new JevJob(this,options);}
 clearCache():void{this.cache.clear();}
 ledger():readonly JevAttempt[]{return structuredClone(this.attempts);}
 private key(request:JevRequest,identity:JevCacheIdentity):string{return digest(JSON.stringify({request,identity}));}
 evaluate(job:JevJob,request:JevRequest,identity:JevCacheIdentity):Promise<JevResult>{
  try{request=structuredClone(request);identity=structuredClone(identity);validateJevRequest(request);job.assertCurrent();}catch(error){return Promise.resolve({state:'failed',code:coded(error)});}
  const key=this.key(request,identity),cached=this.cache.get(key);if(cached){this.cache.delete(key);this.cache.set(key,cached);job.cacheHits++;return Promise.resolve({state:'ok',response:structuredClone(cached.response),cacheHit:true,requestId:cached.requestId});}
  if(this.queue.length>=128)return Promise.resolve({state:'skipped',code:'queue_limit'});
  return new Promise(resolve=>{const queued:Queued={job,request,identity,key,resolve,cleanup:()=>{}};this.queue.push(queued);const cancelled=()=>{const index=this.queue.indexOf(queued);if(index>=0){this.queue.splice(index,1);resolve({state:'skipped',code:'cancelled_before_dispatch'});}job.signal.removeEventListener('abort',cancelled);};queued.cleanup=()=>job.signal.removeEventListener('abort',cancelled);job.signal.addEventListener('abort',cancelled,{once:true});this.drain();});
 }
 private drain():void{
  while(this.active<this.concurrency&&this.queue.length){const item=this.queue.shift()!;item.cleanup();this.active++;void this.dispatch(item).then(result=>{this.active--;this.drain();item.resolve(result);},error=>{this.active--;this.drain();item.resolve({state:'failed',code:coded(error)});});}
 }
 private async dispatch(item:Queued):Promise<JevResult>{
  const {job,request,key,identity}=item;const requestHash=digest(JSON.stringify(request));
  for(let attempt=0;attempt<2;attempt++){
   try{job.assertCurrent();}catch(error){return {state:'skipped',code:coded(error)};}
   if(this.attempts.length>=(this.options.ledgerEntries??256))return {state:'skipped',code:'ledger_limit'};
   if(!job.reserve())return {state:'skipped',code:'budget_or_request_limit'};
   const row:JevAttempt={id:randomUUID(),requestHash,scopeHash:identity.scopeHash,model:JEV_MODEL,dispatchedAt:new Date().toISOString(),completedAt:null,status:null,outcome:'running',billing:'reserved',reservedUsd:JEV_ATTEMPT_RESERVATION_USD,reportedUsd:null,inputTokens:null,outputTokens:null,requestId:null,errorCode:null};this.attempts.push(row);job.attempts.push(row);
   const controller=new AbortController(),abort=()=>controller.abort();job.signal.addEventListener('abort',abort,{once:true});let timedOut=false;const timeout=Math.min(this.options.attemptTimeoutMs??10_000,job.remainingMs());const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
   let retryDelay:number|null=null;
   try{
    const response=await signalled(this.transport('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{Authorization:`Bearer ${this.options.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:controller.signal}),controller.signal);row.status=response.status;row.requestId=response.headers.get('x-typesafe-request-id')?.slice(0,256)??null;
    if(!response.ok){
     const code=response.status===401?'auth':response.status===422?'invalid_request':response.status===429?'rate_limited':response.status===529?'overloaded':'http_error';row.errorCode=code;void response.body?.cancel().catch(()=>{});
     if(response.status===429||response.status===529){this.concurrency=1;retryDelay=this.retryAfter(response.headers);}throw new JevFailure(code);
    }
    const text=await this.readBody(response,controller.signal);let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw new JevFailure('invalid_response');}const result=validateJevResponse(parsed,request);
    row.billing='reported';row.inputTokens=result.usage.input_tokens;row.outputTokens=result.usage.output_tokens;row.reportedUsd=result.usage.input_tokens/1_000_000*JEV_PRICE_PER_MILLION_INPUT;row.outcome='success';job.assertCurrent();
    this.cache.set(key,{response:structuredClone(result),requestId:row.requestId});while(this.cache.size>(this.options.cacheEntries??128))this.cache.delete(this.cache.keys().next().value!);
    return {state:'ok',response:result,cacheHit:false,requestId:row.requestId};
   }catch(error){
    row.outcome='failed';if(row.billing!=='reported')row.billing='unknown';row.errorCode=coded(error)==='privacy_changed'?'privacy_changed':timedOut?'timeout':job.signal.aborted?job.remainingMs()<=0?'job_deadline':'cancelled':coded(error);
    if(retryDelay!==null&&attempt===0&&!job.signal.aborted&&job.canReserve()&&job.remainingMs()>retryDelay+(this.options.attemptTimeoutMs??10_000)){
     clearTimeout(timer);job.signal.removeEventListener('abort',abort);try{await wait(retryDelay,job.signal);}catch{return {state:'failed',code:'cancelled'};}continue;
    }
    return {state:'failed',code:row.errorCode};
   }finally{clearTimeout(timer);job.signal.removeEventListener('abort',abort);row.completedAt=new Date().toISOString();}
  }
  return {state:'failed',code:'retry_limit'};
 }
 private retryAfter(headers:Headers):number{
  const milliseconds=Number(headers.get('retry-after-ms'));if(headers.has('retry-after-ms')&&Number.isFinite(milliseconds)&&milliseconds>=0)return milliseconds;
  const value=headers.get('retry-after');if(value){const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const date=Date.parse(value);if(Number.isFinite(date))return Math.max(0,date-Date.now());}return 500;
 }
 private async readBody(response:Response,signal:AbortSignal):Promise<string>{
  const reader=response.body?.getReader();if(!reader)return '';const chunks:Uint8Array[]=[];let bytes=0;const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{while(true){if(signal.aborted)throw new JevFailure('cancelled');const result=await signalled(reader.read(),signal);if(result.done)break;bytes+=result.value.byteLength;if(bytes>65536)throw new JevFailure('response_bytes_limit');chunks.push(result.value);}if(signal.aborted)throw new JevFailure('cancelled');return Buffer.concat(chunks).toString('utf8');}
  finally{signal.removeEventListener('abort',abort);if(signal.aborted||bytes>65536)void reader.cancel().catch(()=>{});reader.releaseLock();}
 }
}

export class JevJob {
 readonly controller:AbortController=new AbortController();readonly signal:AbortSignal=this.controller.signal;readonly attempts:JevAttempt[]=[];cacheHits=0;private dispatches=0;private readonly deadline:number;private readonly timer:ReturnType<typeof setTimeout>;private readonly aborted=()=>this.controller.abort();
 constructor(private readonly provider:JevProvider,private readonly options:JevJobOptions){
  if(options.consent!==true)throw new JevFailure('consent_required');if(!Number.isSafeInteger(options.maxRequests)||options.maxRequests<0||options.maxRequests>50||!Number.isFinite(options.budgetUsd)||options.budgetUsd<0||options.budgetUsd>10)throw new JevFailure('invalid_budget');
  const duration=options.deadlineMs??20_000;if(!Number.isFinite(duration)||duration<=0||duration>20_000)throw new JevFailure('invalid_deadline');this.deadline=Date.now()+duration;this.timer=setTimeout(this.aborted,duration);options.signal?.addEventListener('abort',this.aborted,{once:true});if(options.signal?.aborted)this.aborted();
 }
 assertCurrent():void{if(this.signal.aborted||this.remainingMs()<=0)throw new JevFailure('cancelled');if(!this.options.isCurrent()){this.provider.clearCache();this.controller.abort();throw new JevFailure('privacy_changed');}}
 remainingMs():number{return Math.max(0,this.deadline-Date.now());}
 canReserve():boolean{return this.dispatches<this.options.maxRequests&&this.stats().reportedCostUsd+this.stats().unresolvedCostUsd+JEV_ATTEMPT_RESERVATION_USD<=this.options.budgetUsd+Number.EPSILON;}
 reserve():boolean{if(!this.canReserve())return false;this.dispatches++;return true;}
 evaluate(request:JevRequest,identity:JevCacheIdentity):Promise<JevResult>{return this.provider.evaluate(this,request,identity);}
 stats():{requestCount:number;cacheHits:number;reportedCostUsd:number;unresolvedCostUsd:number;estimatedCostUsd:number}{return {requestCount:this.dispatches,cacheHits:this.cacheHits,reportedCostUsd:this.attempts.reduce((n,a)=>n+(a.reportedUsd??0),0),unresolvedCostUsd:this.attempts.filter(a=>a.billing!=='reported').reduce((n,a)=>n+a.reservedUsd,0),estimatedCostUsd:this.dispatches*JEV_ATTEMPT_RESERVATION_USD};}
 cancel():void{this.controller.abort();}
 dispose():void{clearTimeout(this.timer);this.options.signal?.removeEventListener('abort',this.aborted);}
}
