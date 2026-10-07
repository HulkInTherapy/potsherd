import {digest} from './source.js';
import {JEV_MODEL,JevFailure,validateJevResponse,type JevJson,type JevQuestion,type JevResponse} from './jev-contract.js';

export const FREE_JEV_MODEL='jev-1.13-free';
export const FREE_JEV_ENDPOINT='https://opencode.ai/zen/v1/systemone';
export const FREE_JEV_RECIPIENTS='Redacted conversation text goes to OpenCode Zen and TypeSafe/Jev.';
export interface FreeJevRequest {model:typeof FREE_JEV_MODEL;state:JevJson;questions:Record<string,JevQuestion>;}
export interface FreeJevCache {get:(key:string)=>Promise<unknown>|unknown;set:(key:string,value:FreeJevResponse)=>Promise<void>|void;}
export type FreeJevResponse=JevResponse;
export interface FreeJevIdentity {sourceVersion:string;privacyVersion:string;segmentationVersion:string;questionVersion:string;contentHash:string;scopeHash:string;}
/** OpenCode's official provider loader keeps zero-input-price models without
 * auth and uses the literal apiKey "public". That public access marker is not a
 * consumer secret. The Oct7 synthetic smoke verified this exact free endpoint.
 * No environment lookup, configurable service URL, or paid fallback. */
export type FreeJevRoute=
 |{kind:'zen-public'}
 |{kind:'zen';accessVerified:true;apiKey:string;endpoint?:typeof FREE_JEV_ENDPOINT};
export interface FreeJevProviderOptions {beforeDispatch?:(details:{model:typeof FREE_JEV_MODEL;attempt:number;notice:string})=>Promise<void>|void;route:FreeJevRoute;fetch?:typeof globalThis.fetch;cache?:FreeJevCache;timeoutMs?:number;}
export interface FreeJevRunOptions {tokenLimit?:number;maxAttempts?:number;retries?:0|1;signal?:AbortSignal;isCurrent:()=>boolean;estimateTokens?:(serialized:string)=>number;estimateBasis?:string;}
export type FreeJevResult={state:'ok';response:FreeJevResponse;cacheHit:boolean}|{state:'skipped'|'failed';code:string};
export const estimateFreeJevTokens=(serialized:string):number=>Buffer.byteLength(serialized)+128;
export const FREE_JEV_ESTIMATE_BASIS='Conservative UTF-8 byte count plus 128 framing tokens per serialized envelope; not the provider tokenizer.';
const object=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function json(value:unknown,depth=0):boolean{return depth<=32&&(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.every(v=>json(v,depth+1))||object(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.values(value).every(v=>json(v,depth+1)));}
const failure=(error:unknown):string=>error instanceof JevFailure?error.code:'transport_failure';
function estimate(serialized:string,fn:(s:string)=>number):number{const n=fn(serialized);if(!Number.isSafeInteger(n)||n<0)throw new JevFailure('invalid_token_estimate');return n;}
/** Validate without the legacy tiny prompt-only request ceiling. */
export function validateFreeJevRequest(request:FreeJevRequest,tokenizer:(s:string)=>number=estimateFreeJevTokens):number {
 if(!object(request)||Object.keys(request).length!==3||request.model!==FREE_JEV_MODEL||!(typeof request.state==='string'||object(request.state)||Array.isArray(request.state))||!json(request.state)||!object(request.questions))throw new JevFailure('invalid_free_request');
 let serialized:string;try{serialized=JSON.stringify(request);}catch{throw new JevFailure('invalid_free_request');}
 if(Buffer.byteLength(serialized)>256000)throw new JevFailure('request_bytes_limit');
 const ids=Object.keys(request.questions);if(ids.length<1||ids.length>24)throw new JevFailure('invalid_free_request');
 for(const [id,q] of Object.entries(request.questions)){
  if(!id||id.length>128||!q||typeof q.instructions!=='string'||!q.instructions.trim()||q.instructions.length>8192)throw new JevFailure('invalid_free_request');
  if(q.type==='choice'){if(!object(q.criteria)||Object.keys(q.criteria).length<2||Object.keys(q.criteria).length>255||Object.entries(q.criteria).some(([key,value])=>!key||key.length>128||value!==null&&typeof value!=='string'))throw new JevFailure('invalid_free_request');}
  else if(q.type==='score'){if(!Array.isArray(q.criteria)||q.criteria.length<2||q.criteria.length>10||q.criteria.some(c=>typeof c!=='string'||!c.trim()))throw new JevFailure('invalid_free_request');}
  else if(q.type==='noul'){if(q.criteria!==undefined&&(!object(q.criteria)||Object.keys(q.criteria).some(k=>!['true','false'].includes(k))||Object.values(q.criteria).some(v=>typeof v!=='string')))throw new JevFailure('invalid_free_request');}
  else throw new JevFailure('invalid_free_request');
 }
 const state=JSON.stringify(request.state),longest=Math.max(...Object.values(request.questions).map(q=>estimate(JSON.stringify(q),tokenizer))),tokens=estimate(serialized,tokenizer);
 if(tokens>64000||estimate(state,tokenizer)+longest>32000)throw new JevFailure('request_context_limit');
 return tokens;
}
export function validateFreeJevResponse(raw:unknown,request:FreeJevRequest):FreeJevResponse {
 if(!object(raw)||typeof raw.model!=='string'||![FREE_JEV_MODEL,'jev-1.13','jev-1.13.0'].includes(raw.model))throw new JevFailure('model_mismatch');
 // Zen adds a root cost field. Accept only an explicit zero; preserve the
 // strict model/answers/usage validator and reject every other extra field.
 const core={...raw};if(Object.hasOwn(core,'cost')){if(!(core.cost===0||typeof core.cost==='string'&&/^0(?:\.0+)?$/.test(core.cost)))throw new JevFailure('nonzero_or_invalid_free_cost');delete core.cost;}
 const checked=validateJevResponse({...core,model:JEV_MODEL},{...request,model:JEV_MODEL},true);
 return {...checked,model:raw.model};
}

/** One bounded run owns reservations across concurrent calls and retries. */
export class FreeJevProvider {
 readonly notice:string;
 private active=0;private queue:Array<()=>void>=[];
 constructor(readonly options:FreeJevProviderOptions){
  const route=options.route;
  if(!route)throw new JevFailure('free_access_unverified');
  if(route.kind==='zen-public'){if(Object.keys(route).length!==1)throw new JevFailure('invalid_free_route');this.notice=FREE_JEV_RECIPIENTS;}
  else if(route.kind==='zen'){if(route.accessVerified!==true)throw new JevFailure('free_access_unverified');if(!route.apiKey?.trim()||route.endpoint!==undefined&&route.endpoint!==FREE_JEV_ENDPOINT)throw new JevFailure('invalid_free_route');this.notice=FREE_JEV_RECIPIENTS;}
  else throw new JevFailure('invalid_free_route');
  if(!Number.isSafeInteger(options.timeoutMs??10000)||(options.timeoutMs??10000)<1||(options.timeoutMs??10000)>30000)throw new JevFailure('invalid_timeout');
  this.options={...options,route:Object.freeze(structuredClone(route))};
 }
 beginRun(options:FreeJevRunOptions):FreeJevRun{return new FreeJevRun(this,options);}
 execute<T>(fn:()=>Promise<T>,signal:AbortSignal):Promise<T>{
  if(this.queue.length>=128)return Promise.reject(new JevFailure('free_queue_limit'));
  return new Promise((resolve,reject)=>{
   const abort=()=>{const index=this.queue.indexOf(work);if(index>=0){this.queue.splice(index,1);reject(new JevFailure('cancelled'));}};
   const work=()=>{signal.removeEventListener('abort',abort);if(signal.aborted){reject(new JevFailure('cancelled'));return;}this.active++;void fn().then(resolve,reject).finally(()=>{this.active--;this.drain();});};
   if(signal.aborted){reject(new JevFailure('cancelled'));return;}signal.addEventListener('abort',abort,{once:true});this.queue.push(work);this.drain();
  });
 }
 private drain():void{while(this.active<2&&this.queue.length)this.queue.shift()!();}
}
export class FreeJevRun {
 readonly controller=new AbortController();readonly signal:AbortSignal=this.controller.signal;
 private reserved=0;private allocatedAttempts=0;private tokensIn=0;private tokensOut=0;private attemptCount=0;private hits=0;private poisoned=false;
 private readonly abort=()=>this.controller.abort();private readonly tokenizer:(s:string)=>number;
 constructor(private readonly provider:FreeJevProvider,readonly options:FreeJevRunOptions){
  if(!Number.isSafeInteger(options.tokenLimit??100000)||(options.tokenLimit??100000)<0||(options.tokenLimit??100000)>100000||!Number.isSafeInteger(options.maxAttempts??100)||(options.maxAttempts??100)<0||(options.maxAttempts??100)>256||options.retries!==undefined&&![0,1].includes(options.retries))throw new JevFailure('invalid_free_budget');
  this.tokenizer=options.estimateTokens??estimateFreeJevTokens;
  options.signal?.addEventListener('abort',this.abort,{once:true});if(options.signal?.aborted)this.abort();
 }
 assertCurrent():void{if(this.signal.aborted)throw new JevFailure('cancelled');if(!this.options.isCurrent()){this.controller.abort();throw new JevFailure('source_or_privacy_changed');}if(this.poisoned)throw new JevFailure('token_estimate_exceeded');}
 stats():{attempts:number;cacheHits:number;inputTokens:number;outputTokens:number;reservedTokens:number}{return {attempts:this.attemptCount,cacheHits:this.hits,inputTokens:this.tokensIn,outputTokens:this.tokensOut,reservedTokens:this.reserved};}
 cancel():void{this.controller.abort();}
 dispose():void{this.options.signal?.removeEventListener('abort',this.abort);}
 async evaluate(input:FreeJevRequest,identity:FreeJevIdentity):Promise<FreeJevResult>{
  let request:FreeJevRequest,tokens:number;
  try{request=structuredClone(input);tokens=validateFreeJevRequest(request,this.tokenizer);this.assertCurrent();}catch(e){return {state:'skipped',code:failure(e)};}
  const route=this.provider.options.route,key=digest(JSON.stringify({request,identity,route:{kind:route.kind,endpoint:FREE_JEV_ENDPOINT},model:FREE_JEV_MODEL}));
  try{const cached=await abortable(Promise.resolve(this.provider.options.cache?.get(key)),this.signal);this.assertCurrent();if(cached!==undefined&&cached!==null){const response=validateFreeJevResponse(cached,request);this.hits++;return {state:'ok',response,cacheHit:true};}}catch(e){if(this.signal.aborted)return {state:'skipped',code:failure(e)};/* Corrupt cache is a miss. */}
  // Reserve all possible attempts before placing any call in the queue. Failed
  // or unknown-billing attempts retain their reservations for the entire run.
  const attempts=1+(this.options.retries??1),reservation=tokens*attempts;
  if(this.reserved+reservation>(this.options.tokenLimit??100000)||this.allocatedAttempts+attempts>(this.options.maxAttempts??100))return {state:'skipped',code:'free_allowance_exhausted'};
  this.reserved+=reservation;this.allocatedAttempts+=attempts;
  return this.provider.execute(async()=>{
   let result=await this.dispatch(request,tokens,attempts);
    if(result.state==='ok'){try{this.assertCurrent();await abortable(Promise.resolve(this.provider.options.cache?.set(key,structuredClone(result.response))),this.signal);this.assertCurrent();}catch(e){if(this.signal.aborted)result={state:'skipped',code:failure(e)};}}
    return result;
  },this.signal).catch(e=>({state:'failed',code:failure(e)}));
 }
 private async dispatch(request:FreeJevRequest,tokens:number,attempts:number):Promise<FreeJevResult>{
  for(let index=0;index<attempts;index++){
   try{this.assertCurrent();}catch(e){return {state:'skipped',code:failure(e)};}
   if(this.attemptCount>=(this.options.maxAttempts??100))return {state:'skipped',code:'attempt_limit'};this.attemptCount++;
   const controller=new AbortController(),abort=()=>controller.abort();this.signal.addEventListener('abort',abort,{once:true});
   const timer=setTimeout(()=>controller.abort(),this.provider.options.timeoutMs??10000);
   try{
    await abortable(Promise.resolve(this.provider.options.beforeDispatch?.({model:FREE_JEV_MODEL,attempt:this.attemptCount,notice:this.provider.notice})),this.signal);this.assertCurrent();
    const route=this.provider.options.route,endpoint=FREE_JEV_ENDPOINT;
    const auth=route.kind==='zen-public'?'Bearer public':`Bearer ${route.apiKey}`;
    const headers:Record<string,string>={'Content-Type':'application/json',Authorization:auth};
    const fetch=this.provider.options.fetch??globalThis.fetch;
    const response=await abortable(fetch(endpoint,{method:'POST',headers,body:JSON.stringify(request),signal:controller.signal,redirect:'error'}),controller.signal);
    if(!response.ok){void response.body?.cancel().catch(()=>{});if([429,529,503].includes(response.status)&&index+1<attempts){const delay=retryMs(response.headers);await pause(delay,this.signal);continue;}throw new JevFailure(response.status===401?'free_access_denied':response.status===429?'free_quota_unavailable':'free_service_unavailable');}
    const body=await readBounded(response,controller.signal);let raw:unknown;try{raw=JSON.parse(body);}catch{throw new JevFailure('invalid_response');}
    const parsed=validateFreeJevResponse(raw,request);this.tokensIn+=parsed.usage.input_tokens;this.tokensOut+=parsed.usage.output_tokens;
    if(parsed.usage.input_tokens>tokens||this.tokensIn>(this.options.tokenLimit??100000)){this.poisoned=true;this.controller.abort();throw new JevFailure('token_estimate_exceeded');}
    this.assertCurrent();return {state:'ok',response:parsed,cacheHit:false};
   }catch(e){return {state:'failed',code:this.signal.aborted?'cancelled':controller.signal.aborted?'attempt_timeout':failure(e)};}
   finally{clearTimeout(timer);this.signal.removeEventListener('abort',abort);}
  }
  return {state:'failed',code:'retry_limit'};
 }
}
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{if(signal.aborted){reject(new JevFailure('cancelled'));return;}const abort=()=>reject(new JevFailure('cancelled'));signal.addEventListener('abort',abort,{once:true});promise.then(v=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(new JevFailure('cancelled'));else resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);});});}
async function readBounded(response:Response,signal:AbortSignal,maxBytes=128000):Promise<string>{
 const reader=response.body?.getReader();if(!reader)throw new JevFailure('invalid_response');const chunks:Uint8Array[]=[];let bytes=0;
 try{while(true){const item=await abortable(reader.read(),signal);if(item.done)break;bytes+=item.value.byteLength;if(bytes>maxBytes)throw new JevFailure('response_bytes_limit');chunks.push(item.value);}return Buffer.concat(chunks).toString('utf8');}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function retryMs(headers:Headers):number{const value=headers.get('retry-after');if(value===null)return 250;const delay=Number(value)*1000;if(!Number.isFinite(delay)||delay<0||delay>2000)throw new JevFailure('free_retry_delay_exceeded');return delay;}
function pause(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{if(signal.aborted){reject(new JevFailure('cancelled'));return;}const abort=()=>{clearTimeout(timer);reject(new JevFailure('cancelled'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});}
