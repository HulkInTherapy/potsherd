import path from 'node:path';
import {isRecord,extractTypedText} from '../parser/content.js';
import {hasExclusionMarker} from '../markers.js';
import {boundedBytes,clean,clock,digest,type NativeFacts,type NativeEvent} from './source.js';
import type {NativeSourceFile} from './native-census.js';
export interface LegacyOpenGroup {facts:NativeFacts;records:Record<string,unknown>[];files:readonly {file:string;hash:string}[];root:string;}
/** Native legacy JSON session/message/part stores; files are grouped by explicit IDs. */
export function readLegacyOpenCode(files:readonly NativeSourceFile[],maxBytes=128*1024*1024):{groups:LegacyOpenGroup[];parsed:number;gaps:string[]} {
 const sessions=new Map<string,Record<string,unknown>>(),messages=new Map<string,{value:Record<string,unknown>;file:string}>(),parts=new Map<string,Record<string,unknown>[]>(),captured=new Map<string,{file:string;hash:string;session:string|null;message?:string}>(),gaps=new Set<string>();let bytes=0,parsed=0;
 for(const item of files){if(bytes+item.bytes>maxBytes){gaps.add('opencode_json_total_bytes_limit');break;}try{const buffer=boundedBytes(item.file,8*1024*1024);bytes+=buffer.length;const r=JSON.parse(buffer.toString('utf8'));if(!isRecord(r)){gaps.add('opencode_json_record_invalid');continue;}parsed++;
  if(typeof r.role==='string'){const id=typeof r.id==='string'?r.id:path.basename(item.file,'.json'),session=typeof r.sessionID==='string'?r.sessionID:path.basename(path.dirname(item.file));messages.set(id,{value:{...r,id,sessionID:session},file:item.file});captured.set(item.file,{file:item.file,hash:digest(buffer),session});}
  else if(typeof r.messageID==='string'||/[\\/]part[\\/]/u.test(item.file)){const message=typeof r.messageID==='string'?r.messageID:path.basename(path.dirname(item.file)),rows=parts.get(message)??[];rows.push(r);parts.set(message,rows);captured.set(item.file,{file:item.file,hash:digest(buffer),message,session:typeof r.sessionID==='string'?r.sessionID:null});}
  else if(typeof r.id==='string'){sessions.set(r.id,r);captured.set(item.file,{file:item.file,hash:digest(buffer),session:r.id});}
 }catch{gaps.add('opencode_json_record_unavailable');}}
 const groups:LegacyOpenGroup[]=[];const ids=new Set([...sessions.keys(),...[...messages.values()].map(m=>String(m.value.sessionID))]);
 for(const id of ids){const session=sessions.get(id),project=typeof session?.directory==='string'?session.directory:null,parent=typeof session?.parentID==='string'?session.parentID:null,rows=[...messages.entries()].filter(([,m])=>m.value.sessionID===id).sort((a,b)=>Number((a[1].value.time as {created?:number})?.created??0)-Number((b[1].value.time as {created?:number})?.created??0)||a[0].localeCompare(b[0])),events:NativeEvent[]=[],records:Record<string,unknown>[]=[];let maintenance=false;
  for(const [key,row] of rows){const actualParts=parts.get(key)??[],eligibleParts=actualParts.filter(p=>p.synthetic!==true&&p.ignored!==true),m=row.value,stamp=(m.time as {created?:number})?.created,time=typeof stamp==='number'?new Date(stamp).toISOString():null;records.push({type:'message',id:key,timestamp:time,cwd:project,message:m,content:eligibleParts});if(m.role!=='user')continue;const text=clean(typeof m.content==='string'?m.content:extractTypedText(eligibleParts));if(hasExclusionMarker(text))maintenance=true;const excluded=actualParts.length>0&&eligibleParts.length===0?'declared_meta_or_synthetic_input':parent&&events.length===0?'child_initialization':null;events.push({key,rawStart:events.length+1,rawEnd:events.length+1,role:'user',text,eventAt:time,project,origin:'opencode_user_projection',eligible:false,observed:excluded===null,excluded,identity:`message:${key}`});}
  if(maintenance){gaps.add('maintenance_source_excluded');continue;}const owned=[...captured.values()].filter(f=>f.session===id||f.message!==undefined&&rows.some(([key])=>key===f.message)),hash=digest(JSON.stringify(records)),root=rows[0]?.[1].file??files[0]?.file??'';
  groups.push({facts:{nativeId:id,project,parent,child:parent!==null,title:null,events,gaps:[...gaps],hash,consumed:0,bytes:Buffer.alloc(0)},records,files:owned.map(({file,hash})=>({file,hash})),root});
 }
 return {groups,parsed,gaps:[...gaps]};
}
