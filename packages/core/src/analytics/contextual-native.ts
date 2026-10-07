import {isRecord} from '../parser/content.js';
import {hasExclusionMarker} from '../markers.js';
import {clean,clock,digest} from './source.js';
import type {AuditHarness,AuditEvidenceRoute} from './contracts.js';
import type {ContextRecord,ContextSegment} from './launch-contracts.js';

export const CONTEXT_SEGMENTATION_VERSION='launch-context-v2-stable-state';
export interface EligibleContextPrompt {id:string;route:AuditEvidenceRoute;}
export interface ContextualNativeOptions {
 bytes:Buffer;harness:AuditHarness;conversationId:string;parentId?:string|null;project?:string|null;
 /** Canonical policy must decide EVERY record, including records after a cwd change. */
 allowRecord:(project:string|null,record:Readonly<Record<string,unknown>>)=>boolean;
 eligiblePrompts:ReadonlyMap<string,EligibleContextPrompt>;maxBytes?:number;maxRecords?:number;
}
/** Frozen bytes only. This parser never discovers, opens, or mutates source files. */
export function parseContextualNative(options:ContextualNativeOptions):{records:ContextRecord[];gaps:string[]} {
 const {bytes,harness}=options,records:ContextRecord[]=[],gaps=new Set<string>();
 const maxBytes=options.maxBytes??8*1024*1024,maxRecords=options.maxRecords??50000;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxRecords)||maxRecords<1)throw new Error('invalid_context_bounds');
 if(bytes.length>maxBytes)return {records,gaps:['context_source_bytes_limit']};
 const decoded=bytes.toString('utf8');if(!Buffer.from(decoded).equals(bytes))return {records,gaps:['context_invalid_utf8']};
 let project=options.project??null,parent=options.parentId??null,model:string|null=null,provider:string|null=null,offset=0,lineNumber=0,count=0;
 const seen=new Map<string,string>();
 for(const line of decoded.split('\n')){
  lineNumber++;const start=offset;offset+=Buffer.byteLength(line)+1;if(!line.trim())continue;
  if(offset>bytes.length){gaps.add('context_unfinished_tail');break;}if(++count>maxRecords){gaps.add('context_source_records_limit');break;}
  let raw:unknown;try{raw=JSON.parse(line);}catch{gaps.add('context_malformed_record');continue;}if(!isRecord(raw)){gaps.add('context_malformed_record');continue;}
  const p=isRecord(raw.payload)?raw.payload:raw, m=isRecord(raw.message)?raw.message:isRecord(raw.info)?raw.info:raw;
  if(raw.isSynthetic===true||m.model==='<synthetic>'){gaps.add('context_synthetic_excluded');continue;}
  const nextProject=string(raw.cwd)??string(p.cwd)??string(raw.project)??string(raw.directory)??string(m.directory);
  if(nextProject!==null)project=nextProject;
  const source=isRecord(p.source)?p.source:{},sub=isRecord(source.subagent)?source.subagent:{},spawn=isRecord(sub.thread_spawn)?sub.thread_spawn:{};
  parent=string(spawn.parent_thread_id)??string(raw.parentSessionId)??string(raw.parentSession)??string(raw.parentID)??parent;
  if(raw.isSidechain===true)parent=string(raw.sessionId)??parent;
  // An ignored record is a boundary, never available as preceding context or title.
  if(!options.allowRecord(project,raw)){gaps.add('context_record_excluded');continue;}
  if(raw.type==='turn_context'||raw.type==='model_change'){
   model=string(p.model)??string(p.modelId)??model;provider=string(p.model_provider)??string(p.provider)??provider;continue;
  }
  if(['session_meta','session','ai-title'].includes(String(raw.type)))continue;
  const nativeKey=string(raw.uuid)??string(raw.id)??string(p.id)??string(m.id)??`record:${lineNumber}`;
  const eligible=options.eligiblePrompts.get(nativeKey)??options.eligiblePrompts.get(`record:${lineNumber}`)??options.eligiblePrompts.get(String(start))??options.eligiblePrompts.get(`marker:${start}`)??(string(raw.promptId)?options.eligiblePrompts.get(`prompt:${raw.promptId}`):undefined);
  const stamp=clock(raw.timestamp)??clock(m.timestamp)??clock(raw.eventAt)??clock(raw.created)??numericTime(raw.created)??numericTime(isRecord(m.time)?m.time.created:null);
  const put=(role:ContextRecord['role'],text:string,suffix='',direct=false)=>{
   if(!text.trim())return;if(hasExclusionMarker(text)){gaps.add('context_maintenance_excluded');return;}
   const id=direct&&eligible?eligible.id:`${options.conversationId}:${nativeKey}${suffix}`;
   const cleaned=clean(text),old=seen.get(id);if(old!==undefined){if(old!==cleaned)gaps.add('context_identity_conflict');return;}seen.set(id,cleaned);
   records.push({id,conversationId:options.conversationId,parentId:parent,harness,eventAt:stamp,project:project===null?null:clean(project),role,text:cleaned,
    model:role==='user'?null:string(m.model)??string(m.modelID)??string(isRecord(m.model)?m.model.id:null)??string(p.model)??model,provider:role==='user'?null:string(m.provider)??string(m.providerID)??string(p.model_provider)??provider,
    directUser:direct&&eligible!==undefined,route:direct&&eligible?eligible.route:null});
  };
  if(harness==='codex'){
   if(raw.type==='event_msg'&&p.type==='user_message'){put('user',string(p.message)??'', '',Boolean(eligible));continue;}
   if(raw.type==='event_msg'&&p.type==='item_completed'&&isRecord(p.item)&&p.item.type==='UserMessage'){put('user',content(p.item.content),'',Boolean(eligible));continue;}
   if(raw.type!=='response_item')continue;
   if(p.type==='message'&&['user','assistant'].includes(String(p.role))){
    // A paired response may share the marker's identity; the supplied native mapping is authoritative.
    put(p.role as 'user'|'assistant',content(p.content),'',p.role==='user'&&Boolean(eligible));
   }else if(['function_call','custom_tool_call'].includes(String(p.type)))put('tool',toolText(p));
   else if(['function_call_output','custom_tool_call_output'].includes(String(p.type)))put('tool',string(p.output)??content(p.output));
   else if(p.type!==undefined)gaps.add('context_unsupported_codex_record');
   continue;
  }
  const role=string(m.role)??string(raw.role);
  if(role==='assistant'){
   put('assistant',content(m.content??raw.content??raw.parts));
   for(const [i,block] of blocks(m.content??raw.parts).entries())if(['tool_use','tool','toolCall'].includes(String(block.type)))put('tool',toolText(block),`:tool:${i}`);
  }else if(['tool','toolResult','tool_result'].includes(role??''))put('tool',content(m.content??raw.content??raw.parts));
  else if(role==='user'){
   const body=m.content??m.text??raw.content??raw.parts,results=blocks(body).filter(b=>b.type==='tool_result');
   if(results.length){for(const [i,result] of results.entries())put('tool',content(result.content),`:result:${i}`);}
   else put('user',content(body),'',Boolean(eligible)&&raw.isMeta!==true&&raw.isSynthetic!==true);
  }else if(role!==null)gaps.add('context_unknown_role');
 }
 return {records,gaps:[...gaps]};
}
const string=(value:unknown):string|null=>typeof value==='string'&&value.length>0?value:null;
const numericTime=(value:unknown):string|null=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=8.64e15?new Date(value).toISOString():null;
const blocks=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.filter(isRecord):[];
function content(value:unknown):string{
 if(typeof value==='string')return value;
 if(Array.isArray(value))return value.map(content).filter(Boolean).join('\n');
 if(!isRecord(value))return '';
 if(['text','input_text','output_text'].includes(String(value.type)))return string(value.text)??'';
 if(value.type==='tool_result')return content(value.content);
 if(value.type==='tool')return toolText(value);
 return string(value.text)??'';
}
function toolText(value:Record<string,unknown>):string{
 const state=isRecord(value.state)?value.state:{};
 return JSON.stringify({tool:string(value.name)??string(value.tool),callId:string(value.call_id)??string(value.id),input:value.input??value.arguments??state.input??null,output:value.output??state.output??state.content??null,status:state.status??null});
}

/** Fit entire conversations once. Large conversations use complete target turns
 * and the immediately preceding whole turn, with explicit earlier-context gaps. */
export function segmentContext(records:readonly ContextRecord[],options:{maxSegmentBytes?:number;gaps?:readonly string[]}={}):{segments:ContextSegment[];gaps:string[]} {
 const max=options.maxSegmentBytes??24*1024;if(!Number.isSafeInteger(max)||max<1)throw new Error('invalid_segment_bounds');
 const segments:ContextSegment[]=[],gaps=new Set(options.gaps??[]),groups=new Map<string,ContextRecord[]>();
 for(const record of records){const key=JSON.stringify([record.conversationId,record.project]);const group=groups.get(key)??[];group.push(record);groups.set(key,group);}
 for(const group of groups.values()){
  const starts=group.flatMap((r,i)=>r.role==='user'?[i]:[]);
  if(starts.length===0)continue;
  const emit=(context:ContextRecord[],targetRecords:ContextRecord[],promptIds:string[],localGaps:string[])=>{
   const target=targetRecords[0]!;
   const text=JSON.stringify(context);if(Buffer.byteLength(text)>max){gaps.add('context_turn_oversize');return;}
   const unknown=targetRecords.some(r=>r.role==='user'&&!r.directUser);
   const segmentGaps=[...new Set([...options.gaps??[],...localGaps,...unknown?['context_user_origin_unverified']:[]])];
   segments.push({id:`${target.conversationId}:turn:${target.id}`,conversationId:target.conversationId,parentId:target.parentId,project:target.project,
    eventFrom:target.eventAt,eventTo:targetRecords.at(-1)?.eventAt??target.eventAt,records:context,promptIds,coverage:segmentGaps.length?'partial':'complete',gaps:segmentGaps,contentHash:digest(JSON.stringify({records:context.map(({route:_,...record})=>record),promptIds}))});
  };
  if(Buffer.byteLength(JSON.stringify(group))<=max){emit(group,group.slice(starts[0]!),starts.map(i=>group[i]!.id),[]);continue;}
  for(const [index,start] of starts.entries()){
   const end=starts[index+1]??group.length,previous=starts[index-1]??0;
   emit(group.slice(previous,end),group.slice(start,end),[group[start]!.id],previous>0?['earlier_context_not_in_segment']:[]);
  }
 }
 return {segments,gaps:[...gaps]};
}
