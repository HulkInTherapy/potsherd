import {createHash} from 'node:crypto';
import type {AuditHarness} from './contracts.js';
import type {RecordedInference} from './launch-contracts.js';

type R=Record<string,unknown>;
const obj=(v:unknown):R=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as R:{};
const str=(...v:unknown[]):string|null=>v.find(x=>typeof x==='string'&&x.length>0) as string|undefined??null;
const num=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const cost=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const at=(v:unknown):string|null=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<8.64e15?new Date(v).toISOString():typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
export interface UsageRecordScope {key:string;rawStart:number;rawEnd:number;eventAt:string|null;project:string|null;}
export interface NativeUsageOptions {project?:string|null;maxRecords?:number;acceptRecord?:(record:R,scope:UsageRecordScope)=>boolean;}
/** Reads only the caller's bounded frozen bytes. Excluded records still advance native counters. */
export function extractNativeUsage(bytes:Buffer|string,harness:AuditHarness,conversationId:string,options:NativeUsageOptions={}):RecordedInference[]{
 const text=Buffer.isBuffer(bytes)?bytes.toString('utf8'):bytes;
 const records=new Map<string,RecordedInference>();let project=options.project??null,model:string|null=null,provider:string|null=null,session=conversationId,offset=0,seq=0;
 let previous:R|null=null;const seenTotals=new Set<string>();
 const put=(r:RecordedInference)=>{const old=records.get(r.id);if(!old){records.set(r.id,r);return;}
  const conflict=old.model!==r.model||old.provider!==r.provider;
  for(const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'] as const){const a=old[k],b=r[k];old[k]=a===null?b:b===null?a:Math.max(a,b);}
  old.reportedCostUsd=old.reportedCostUsd===null?r.reportedCostUsd:r.reportedCostUsd===null?old.reportedCostUsd:Math.max(old.reportedCostUsd,r.reportedCostUsd);
  old.gaps=[...new Set([...old.gaps,...r.gaps,...(conflict?['response_identity_model_conflict']:[])])];if(conflict){old.model=null;old.provider=null;}
 };
 const lines=text.trimStart().startsWith('[')?(()=>{try{return (JSON.parse(text) as unknown[]).map(x=>JSON.stringify(x));}catch{return [];}})():text.split('\n');
 for(const line of lines){const start=offset;offset+=Buffer.byteLength(line)+1;if(!line.trim())continue;if(++seq>(options.maxRecords??100_000))break;
  let r:R;try{r=obj(JSON.parse(line));}catch{continue;}
  if(harness==='opencode'){r={...r,...obj(r.message)};const wrapped=r.data??r.content;if(typeof wrapped==='string'){try{r={...r,...obj(JSON.parse(wrapped))};}catch{/* unsupported projection remains unknown */}}else if(wrapped&&typeof wrapped==='object')r={...r,...obj(wrapped)};}
  const p=obj(r.payload),m=obj(r.message);
  project=str(r.cwd,p.cwd,r.directory)??project;
  if(harness==='codex'&&(r.type==='session_meta'||r.type==='turn_context')){session=str(p.session_id,p.id)??session;model=str(p.model)??model;provider=str(p.model_provider,p.provider)??provider;continue;}
  const eventAt=at(r.timestamp)??at(m.timestamp)??at(obj(r.time).created);const key=str(r.uuid,r.id,p.id,m.id)??`record:${seq}`;
  const accepted=options.acceptRecord?.(r,{key,rawStart:start,rawEnd:offset,eventAt,project})??true;
  let input:number|null=null,output:number|null=null,read:number|null=null,write:number|null=null,reasoning:number|null=null,reported:number|null=null;
  let observedModel:string|null=null,observedProvider:string|null=null,id:string,basis:string,includesCache=false,includesReasoning=true;const gaps:string[]=[];
  if(harness==='codex'){
   if(r.type!=='event_msg'||p.type!=='token_count')continue;const info=obj(p.info),last=obj(info.last_token_usage),total=obj(info.total_token_usage);if(!Object.keys(last).length&&!Object.keys(total).length)continue;
   const previousTotal=previous;previous=Object.keys(total).length?total:previous;
   const signature=Object.keys(total).length?JSON.stringify([session,total.input_tokens,total.output_tokens,total.cached_input_tokens,total.reasoning_output_tokens]):null;
   if(signature&&seenTotals.has(signature))continue;if(signature)seenTotals.add(signature);
   const delta=(field:string):number|null=>{const current=num(total[field]),prev=num(previousTotal?.[field]);return current===null||prev===null||current<prev?null:current-prev;};
   const firstComplete=previousTotal===null&&num(last.input_tokens)!==null&&last.input_tokens===total.input_tokens&&last.output_tokens===total.output_tokens;
   const bucket=(field:string)=>num(last[field])??delta(field)??(firstComplete?num(total[field]):null);
   input=bucket('input_tokens');output=bucket('output_tokens');read=bucket('cached_input_tokens');write=bucket('cache_write_input_tokens');reasoning=bucket('reasoning_output_tokens');
   if(!Object.keys(last).length&&previousTotal===null)gaps.push('cumulative_baseline_unknown');
   if(previousTotal&&Object.keys(total).length&&['input_tokens','output_tokens'].some(k=>num(total[k])!==null&&num(previousTotal[k])!==null&&(num(total[k]) as number)<(num(previousTotal[k]) as number)))gaps.push('cumulative_counter_reset');
   observedModel=str(p.model,info.model)??model;observedProvider=str(p.model_provider,p.provider,info.provider)??provider;
   includesCache=true;basis='codex_last_response_with_cumulative_dedup';id=`codex:${hash(JSON.stringify([session,str(p.response_id,info.response_id)??signature??[eventAt,last]]))}`;
   // Absent optional cache-write means zero in Codex's native usage schema.
   write=write??0;
  }else if(harness==='claude'){
   if(r.type!=='assistant'||m.role!=='assistant')continue;const u=obj(m.usage);input=num(u.input_tokens);output=num(u.output_tokens);read=num(u.cache_read_input_tokens)??(input!==null?0:null);write=num(u.cache_creation_input_tokens)??(input!==null?0:null);reasoning=num(u.reasoning_tokens);
   if(num(obj(u.cache_creation).ephemeral_1h_input_tokens))gaps.push('cache_write_duration_unknown');
   observedModel=str(m.model,r.model);observedProvider=str(m.provider,r.provider,r.modelProvider);reported=cost(r.costUSD)??cost(m.costUSD);basis='claude_response_usage';id=`claude:${str(m.id,r.uuid)??hash(JSON.stringify([conversationId,key,eventAt]))}`;
  }else if(harness==='pi'){
   if(r.type!=='message'||m.role!=='assistant')continue;const u=obj(m.usage);input=num(u.input);output=num(u.output);read=num(u.cacheRead)??(input!==null?0:null);write=num(u.cacheWrite)??(input!==null?0:null);reasoning=num(u.reasoning);reported=cost(obj(u.cost).total);observedModel=str(m.model);observedProvider=str(m.provider);basis='pi_response_usage';id=`pi:${str(r.id)??hash(JSON.stringify([conversationId,key,eventAt]))}`;
  }else{
   if(r.role!=='assistant')continue;const u=obj(r.tokens),cache=obj(u.cache);input=num(u.input);output=num(u.output);read=num(cache.read)??(input!==null?0:null);write=num(cache.write)??(input!==null?0:null);reasoning=num(u.reasoning);reported=cost(r.cost);observedModel=str(r.modelID,obj(r.model).modelID,r.model);observedProvider=str(r.providerID,obj(r.model).providerID,r.provider);basis='opencode_response_tokens';includesReasoning=false;id=`opencode:${str(r.id)??hash(JSON.stringify([conversationId,key,eventAt]))}`;
  }
  if(!accepted)continue;if(!observedModel)gaps.push('model_unrecorded');if(!observedProvider)gaps.push('provider_unrecorded');if(input===null||output===null)gaps.push('usage_partial');
  if(includesCache&&read===null)gaps.push('cache_inclusion_unknown');
  if(includesCache&&input!==null&&read!==null&&write!==null&&read+write>input)gaps.push('cache_exceeds_input');
  if(includesReasoning&&output!==null&&reasoning!==null&&reasoning>output)gaps.push('reasoning_exceeds_output');
  put({id,conversationId,harness,eventAt,project,provider:observedProvider,model:observedModel,canonicalModel:null,inputTokens:input,outputTokens:output,cacheReadTokens:read,cacheWriteTokens:write,reasoningTokens:reasoning,inputIncludesCache:includesCache,outputIncludesReasoning:includesReasoning,reportedCostUsd:reported,basis,gaps});
 }
 return [...records.values()];
}
