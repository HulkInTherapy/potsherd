import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJsonlLines,parseJsonLine} from '../parser/jsonl.js';
import {isRecord,extractTypedText,extractTextFromContent} from '../parser/content.js';
import {redact} from '../redact.js';
import {elideBinary} from '../redact-elide.js';
import {hasExclusionMarker} from '../markers.js';
import type {AuditHarness} from './contracts.js';

export const digest=(value:string|Buffer):string=>createHash('sha256').update(value).digest('hex');
export const clean=(text:string):string=>redact(elideBinary(text)).text;
export const clock=(value:unknown):string|null=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export interface NativeEvent {key:string;rawStart:number;rawEnd:number;role:'user';text:string;eventAt:string|null;project:string|null;origin:'claude_prompt_id'|'codex_human_marker'|'pi_user_projection'|'unknown';eligible:boolean;excluded:string|null;identity:string;evidenceStart?:number;nativeRecordId?:string;recordCommitment?:string;declaredOrigin?:string;}
export interface NativeFacts {nativeId:string;project:string|null;parent:string|null;child:boolean;title:string|null;events:NativeEvent[];gaps:string[];hash:string;consumed:number;bytes:Buffer;}

/** A size check and a bounded fd read, with identity rechecked after reading. */
export function boundedBytes(file:string,max:number):Buffer {
 const fd=fs.openSync(file,'r');
 try{const before=fs.fstatSync(fd);if(!before.isFile()||before.size>max)throw new Error('source_bytes_limit');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new Error('source_changed');offset+=n;}
  const after=fs.fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw new Error('source_changed');
  return bytes;
 }finally{fs.closeSync(fd);}
}

/** Bounded entry iteration: no adapter discover() array or symlink traversal. */
export async function* walk(root:string,maxEntries:number,signal:AbortSignal,maxDepth=8):AsyncGenerator<string> {
 let visited=0;
 async function* visit(dir:string,depth:number):AsyncGenerator<string>{
  if(signal.aborted)return;if(depth>maxDepth)throw new Error('discovery_depth_limit');
  let handle:fs.Dir;try{handle=await fs.promises.opendir(dir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('source_root_unreadable');}
  try{for await(const item of handle){if(signal.aborted)return;if(++visited>maxEntries)throw new Error('discovery_entries_limit');
    const file=path.join(dir,item.name);if(item.isDirectory())yield* visit(file,depth+1);else if(item.isFile())yield file;
  }}finally{try{await handle.close();}catch{/* async iteration already closes it */}}
 }
 yield* visit(root,0);
}

/** Shares the established JSONL reader and exact content extractors; no exchange folding. */
export async function nativeFacts(file:string,harness:Exclude<AuditHarness,'opencode'>,bytes:Buffer,maxRecords:number):Promise<NativeFacts>{
 const events:NativeEvent[]=[];const gaps=new Set<string>();let project:string|null=null,parent:string|null=null,title:string|null=null;
 let nativeId=path.basename(file,'.jsonl'),consumed=0,records=0,turn:string|null=null,programmatic=false;
 const identity=new Map<string,string>();
 const responses:{text:string;cleanText:string;turn:string|null;start:number;end:number;key:string;time:string|null;project:string|null}[]=[];
 const markers:{event:NativeEvent;turn:string|null}[]=[];
 const put=(event:NativeEvent)=>{const previous=identity.get(event.identity);if(previous!==undefined){if(previous!==event.text)gaps.add('native_event_identity_conflict');return;}identity.set(event.identity,event.text);events.push(event);};
 for await(const line of readJsonlLines(file,{snapshot:bytes})){
  if(!line.terminated){gaps.add('unfinished_tail');break;}if(++records>maxRecords){gaps.add('source_records_limit');break;}consumed=line.end;
  const r=parseJsonLine(line.text);if(!isRecord(r)){if(line.text.trim())gaps.add('malformed_record');continue;}
  const p=isRecord(r.payload)?r.payload:r,m=isRecord(r.message)?r.message:{};
  if(typeof r.cwd==='string')project=r.cwd;if(typeof p.cwd==='string')project=p.cwd;
  const key=typeof r.uuid==='string'?r.uuid:typeof p.id==='string'?p.id:`record:${line.lineNumber}`;
  const at=clock(r.timestamp);const base={key,rawStart:line.start,rawEnd:line.end,role:'user' as const,eventAt:at,project};
  const maintenance=(text:string)=>hasExclusionMarker(text);
  if(harness==='claude'){
   if(typeof r.sessionId==='string'&&!file.includes(`${path.sep}subagents${path.sep}`))nativeId=r.sessionId;
   if(typeof r.entrypoint==='string'){if(r.entrypoint==='sdk-ts')programmatic=true;else if(['cli','desktop','vscode'].includes(r.entrypoint))programmatic=false;}
   if(file.includes(`${path.sep}subagents${path.sep}`)||r.isSidechain===true){parent=typeof r.sessionId==='string'?r.sessionId:parent;}
   if(r.type==='ai-title'&&typeof r.aiTitle==='string')title=clean(r.aiTitle);
   if(r.type!=='user'||m.role!=='user'){
    if(m.role==='user'){const text=extractTypedText(m.content);if(text.trim()){gaps.add('unsupported_user_container');put({...base,text:clean(text),origin:'unknown',eligible:false,excluded:'unsupported_user_container',identity:`record:${key}`});}}
    continue;
   }
   const text=extractTypedText(m.content);if(!text.trim())continue;
   const results=Array.isArray(m.content)&&m.content.some(b=>isRecord(b)&&b.type==='tool_result');
   const native=typeof r.promptId==='string'&&r.promptId.length>0&&!results;
   const declared=typeof r.session_id==='string'&&r.session_id!==nativeId?r.session_id:undefined;
   const recordCopy={...r};delete recordCopy.sessionId;delete recordCopy.session_id;delete recordCopy.promptId;
   const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):isRecord(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
   const excluded=parent?'child_initialization':maintenance(text)?'maintenance_exclusion_marker':results?'tool_result':declared?'inherited_identity_unverified':programmatic?'programmatic_origin_unattested':native?null:'injected_or_origin_unknown';
   if(programmatic&&!parent&&excluded!=='maintenance_exclusion_marker')gaps.add('human_attestation_unavailable');
   put({...base,text:clean(text),origin:native&&!declared&&!programmatic?'claude_prompt_id':'unknown',eligible:native&&excluded===null,excluded,identity:native?`prompt:${r.promptId}`:`record:${key}`,...(typeof r.uuid==='string'&&r.uuid.length>0?{nativeRecordId:r.uuid,recordCommitment:digest(JSON.stringify(stable(recordCopy)))}:{}),...(declared?{declaredOrigin:declared}:{})});
  }else if(harness==='codex'){
   if(r.type==='session_meta'){
    nativeId=typeof p.session_id==='string'?p.session_id:typeof p.id==='string'?p.id:nativeId;
    if(p.originator==='codex_exec'||p.source==='exec')programmatic=true;
    const source=isRecord(p.source)?p.source:{},sub=isRecord(source.subagent)?source.subagent:{},spawn=isRecord(sub.thread_spawn)?sub.thread_spawn:{};
    if(typeof spawn.parent_thread_id==='string')parent=spawn.parent_thread_id;
   }
   if(typeof p.turn_id==='string')turn=p.turn_id;
   if(r.type==='response_item'&&p.type==='message'&&p.role==='user'){
    const text=extractTextFromContent(p.content);if(text.trim())responses.push({text,cleanText:clean(text),turn,start:line.start,end:line.end,key,time:at,project});
   }
   if(r.type!=='response_item'&&r.type!=='event_msg'&&p.role==='user'){
    const text=extractTextFromContent(p.content);if(text.trim()){gaps.add('unsupported_user_container');put({...base,text:clean(text),origin:'unknown',eligible:false,excluded:'unsupported_user_container',identity:`record:${key}`});}
   }
   if(r.type!=='event_msg')continue;
   const item=isRecord(p.item)?p.item:{};
   const text=p.type==='user_message'&&typeof p.message==='string'?p.message:p.type==='item_completed'&&item.type==='UserMessage'?extractTextFromContent(item.content):'';
   if(!text.trim())continue;
   const id=typeof item.id==='string'?`item:${item.id}`:`marker:${line.start}`;
   const excluded=parent?'child_initialization':maintenance(text)?'maintenance_exclusion_marker':programmatic?'programmatic_origin_unattested':null;
   if(programmatic&&!parent&&excluded!=='maintenance_exclusion_marker')gaps.add('human_attestation_unavailable');
   const event:NativeEvent={...base,text:clean(text),origin:programmatic?'unknown':'codex_human_marker',eligible:excluded===null,excluded,identity:id};
   const before=events.length;put(event);if(events.length>before)markers.push({event,turn});
  }else{
   if(r.type==='session'){if(typeof r.id==='string')nativeId=r.id;if(typeof r.cwd==='string')project=r.cwd;if(typeof r.parentSessionId==='string')parent=r.parentSessionId;continue;}
   if(r.type!=='message'||m.role!=='user')continue;const text=extractTypedText(m.content);if(!text.trim())continue;
   put({...base,text:clean(text),origin:'pi_user_projection',eligible:false,excluded:'projection_origin_unverified',identity:`node:${typeof r.id==='string'?r.id:key}`});gaps.add('pi_exchange_projection_fidelity');
  }
 }
 if(harness==='codex'){
  // Markers are the count authority. Pair only unique text candidates inside the
  // explicit turn or nearest marker window; a same-text injection remains ambiguous.
  const used=new Set<number>();
  for(let i=0;i<markers.length;i++){const marker=markers[i]!,prev=markers[i-1]?.event.rawStart??0,next=markers[i+1]?.event.rawStart??consumed;
   const matches=responses.filter(r=>!used.has(r.start)&&r.cleanText.trim()===marker.event.text.trim()&&(marker.turn!==null?r.turn===marker.turn:r.start>=prev&&r.start<=next));
   if(matches.length===1){const response=matches[0]!;used.add(response.start);marker.event.evidenceStart=response.start;}else if(matches.length>1)gaps.add('codex_response_pair_ambiguous');
  }
  for(const response of responses){if(used.has(response.start))continue;const matches=markers.some(m=>m.event.text.trim()===response.cleanText.trim());
   events.push({key:response.key,rawStart:response.start,rawEnd:response.end,role:'user',text:response.cleanText,eventAt:response.time,project:response.project,origin:'unknown',eligible:false,excluded:matches?'unpaired_user_response':'human_marker_missing',identity:`response:${response.start}`});
   if(!markers.length)gaps.add('codex_human_marker_missing');
  }
 }
 if(parent&&harness==='claude')nativeId=`${parent}:${path.basename(file,'.jsonl')}`;
 if(parent){for(const event of events){event.eligible=false;event.excluded='child_initialization';}}
 if(harness==='pi')gaps.add('pi_exchange_projection_fidelity');
 const complete=bytes.subarray(0,consumed);return {nativeId,project,parent,child:parent!==null,title,events,gaps:[...gaps],hash:digest(complete),consumed,bytes:complete};
}
