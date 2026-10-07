import type {AuditRawAnswer} from './contracts.js';

export const JEV_MODEL='jev-1.13.0';
export const JEV_PRICE_PER_MILLION_INPUT=0.042;
/** Pessimistic context reservation, not a documented invoice guarantee. */
export const JEV_ATTEMPT_RESERVATION_USD=64_000/1_000_000*JEV_PRICE_PER_MILLION_INPUT;
export const JEV_QUESTION_VERSION='audit-questions-v1';
export type JevJson=null|boolean|number|string|JevJson[]|{[key:string]:JevJson};
export type JevQuestion=
 | {type:'choice';instructions:string;criteria:Record<string,string|null>}
 | {type:'noul';instructions:string;criteria?:{true?:string;false?:string}}
 | {type:'score';instructions:string;criteria:readonly string[]};
export interface JevRequest {model:typeof JEV_MODEL;state:JevJson;questions:Record<string,JevQuestion>;}
export interface JevResponse {model:string;answers:Record<string,AuditRawAnswer>;usage:{input_tokens:number;output_tokens:number};}
export class JevFailure extends Error {constructor(readonly code:string){super(code);}}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,expected:readonly string[])=>Object.keys(value).length===expected.length&&expected.every(k=>Object.hasOwn(value,k));
const number=(value:unknown,min=0,max=1):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
function fail(code:string):never{throw new JevFailure(code);}
function json(value:unknown,depth=0):boolean{return depth<=16&&(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.every(v=>json(v,depth+1))||record(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.values(value).every(v=>json(v,depth+1)));}
export function validateJevRequest(request:JevRequest):void{
 if(request.model!==JEV_MODEL||!(typeof request.state==='string'||Array.isArray(request.state)||record(request.state))||!json(request.state))fail('invalid_request');
 const ids=Object.keys(request.questions);if(!ids.length||ids.length>24||ids.some(id=>!id||id.length>128))fail('invalid_request');
 for(const q of Object.values(request.questions)){
  if(!record(q)||typeof q.instructions!=='string'||!q.instructions.trim()||q.instructions.length>8192)fail('invalid_request');
  if(q.type==='choice'){if(!record(q.criteria))fail('invalid_request');const options=Object.keys(q.criteria);if(options.length<2||options.length>255||options.some(k=>!k||k.length>128)||Object.values(q.criteria).some(v=>v!==null&&typeof v!=='string'))fail('invalid_request');}
  else if(q.type==='score'){if(!Array.isArray(q.criteria)||q.criteria.length<2||q.criteria.length>10||q.criteria.some(level=>typeof level!=='string'||!level.trim()))fail('invalid_request');}
  else if(q.type!=='noul')fail('invalid_request');else if(q.criteria!==undefined&&(!record(q.criteria)||Object.keys(q.criteria).some(key=>!['true','false'].includes(key))||Object.values(q.criteria).some(value=>typeof value!=='string')))fail('invalid_request');
 }
 if(Buffer.byteLength(JSON.stringify(request.state))>8192||Buffer.byteLength(JSON.stringify(request))>32768)fail('request_bytes_limit');
}
function distribution(raw:unknown,expected:readonly string[],allowRounded=false):Record<string,number>{
 if(!record(raw)||!keys(raw,expected)||Object.values(raw).some(v=>!number(v)))fail('invalid_response');
 const result=raw as Record<string,number>;const values=Object.values(result),rounded=allowRounded&&values.every(v=>Math.abs(v*100-Math.round(v*100))<1e-8);const tolerance=rounded?Math.min(0.02,Math.max(0.001,expected.length*0.005)):0.001;if(Math.abs(values.reduce((a,b)=>a+b,0)-1)>tolerance+1e-9)fail('invalid_response');return result;
}
/** SDK typing is not runtime validation; every answer and bound is checked here. */
export function validateJevResponse(raw:unknown,request:JevRequest,allowRounded=false):JevResponse{
 if(!record(raw)||!keys(raw,['model','answers','usage']))fail('invalid_response');if(raw.model!==request.model)fail('model_mismatch');
 if(!record(raw.answers)||!keys(raw.answers,Object.keys(request.questions))||!record(raw.usage)||!keys(raw.usage,['input_tokens','output_tokens']))fail('invalid_response');
 for(const count of Object.values(raw.usage))if(!number(count,0,Number.MAX_SAFE_INTEGER)||!Number.isSafeInteger(count))fail('invalid_response');
 const answers:Record<string,AuditRawAnswer>=Object.create(null);
 for(const [id,q] of Object.entries(request.questions)){
  const a=raw.answers[id];if(!record(a)||a.type!==q.type)fail('invalid_response');
  if(q.type==='noul'){if(!keys(a,['type','noul'])||!number(a.noul))fail('invalid_response');answers[id]={type:'noul',noul:a.noul};}
  else if(q.type==='choice'){
   if(!keys(a,['type','choice','probabilities','confidence'])||typeof a.choice!=='string'||!Object.hasOwn(q.criteria,a.choice)||!number(a.confidence))fail('invalid_response');
   const probabilities=distribution(a.probabilities,Object.keys(q.criteria),allowRounded);if(probabilities[a.choice]!+0.001<Math.max(...Object.values(probabilities)))fail('invalid_response');answers[id]={type:'choice',choice:a.choice,probabilities,confidence:a.confidence};
  }else{
   const levels=q.criteria.map((_,i)=>String(i));if(!keys(a,['type','score','legend','probabilities','confidence'])||!number(a.score,0,levels.length-1)||!number(a.confidence)||!record(a.legend)||!keys(a.legend,levels)||levels.some((level,i)=>(a.legend as Record<string,unknown>)[level]!==q.criteria[i]))fail('invalid_response');
   const probabilities=distribution(a.probabilities,levels,allowRounded),mean=levels.reduce((n,level)=>n+Number(level)*probabilities[level]!,0);if(Math.abs(a.score-mean)>0.02)fail('invalid_response');answers[id]={type:'score',score:a.score,confidence:a.confidence,probabilities,legend:a.legend as Record<string,string>};
  }
 }
 return {model:request.model,answers,usage:raw.usage as JevResponse['usage']};
}
