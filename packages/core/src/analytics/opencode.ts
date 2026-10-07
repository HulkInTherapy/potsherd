import {openAuditSqliteSnapshot,type AuditSqliteSnapshot} from '../audit-sqlite.js';
import {describeStore,parseContent,type StoreSchema} from '../adapters/opencode.js';
import {clock,clean,digest} from './source.js';

const quote=(s:string)=>`"${s.replaceAll('"','""')}"`;
const col=(s:string|undefined,alias:string)=>s?`${quote(s)} AS ${quote(alias)}`:`NULL AS ${quote(alias)}`;
export interface AuditOpenSchema extends StoreSchema {v2?:boolean;forkCutoffs?:ReadonlyMap<string,number>;}
export interface OpenSession {initialization?:boolean;id:string;project:string|null;parent:string|null;title:string|null;}
export interface OpenPrompt {key:string;text:string;time:string|null;seq:number;}
/** Bounded projections use the adapter's recognized schema and content parser. */
export function openSessions(file:string,max:number,maxStoreBytes:number,reader?:AuditSqliteSnapshot):{sessions:OpenSession[];more:boolean;schema:AuditOpenSchema;assertCurrent:()=>void;assertIdentityCurrent:()=>void}|{gap:string}{
 const snapshot=reader??openAuditSqliteSnapshot(file,maxStoreBytes),db=snapshot.db;
 try{const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name);let schema:AuditOpenSchema;
  if(tables.includes('session_message')&&(tables.includes('session')||tables.includes('session_v2'))){const table=tables.includes('session')?'session':'session_v2',cols=(db.pragma(`table_info(${quote(table)})`) as {name:string}[]).map(c=>c.name),mc=(db.pragma('table_info(session_message)') as {name:string}[]).map(c=>c.name);if(!['id','session_id','type','data'].every(k=>mc.includes(k)))return {gap:'opencode_v2_schema_unsupported'};const parent=cols.includes('parent_id')?'parent_id':cols.includes('fork_session_id')?'fork_session_id':undefined;const forkCutoffs=new Map<string,number>();if(cols.includes('fork_session_id')&&cols.includes('fork_boundary')&&mc.includes('seq')){for(const f of db.prepare(`SELECT id,fork_session_id parent,fork_boundary boundary FROM ${quote(table)} WHERE fork_session_id IS NOT NULL`).all() as {id:string;parent:string;boundary:string}[]){try{const b=JSON.parse(f.boundary) as {type:string;messageID:string},r=db.prepare('SELECT seq FROM session_message WHERE session_id=? AND id=?').get(f.parent,b.messageID) as {seq:number}|undefined;if(r){if(b.type==='through')forkCutoffs.set(f.id,r.seq);else if(b.type==='before'){const n=db.prepare('SELECT max(seq) n FROM session_message WHERE session_id=? AND seq<?').get(f.parent,r.seq) as {n:number|null};if(n.n!==null)forkCutoffs.set(f.id,n.n);}}}catch{}}}
   schema={dbPath:file,v2:true,forkCutoffs,sessions:{table,columns:{id:'id',directory:cols.includes('directory')?'directory':undefined,parent,title:cols.includes('title')?'title':undefined}},messages:{table:'session_message',columns:{id:'id',session:'session_id',role:'type',content:'data',created:mc.includes('time_created')?'time_created':undefined}}};
  }else{const description=describeStore(file,db);if(!description.ok)return {gap:'opencode_store_unsupported'};schema=description.schema;}const c=schema.sessions.columns;const rows=db.prepare(`SELECT ${quote(c.id!)} AS id,${col(c.directory,'project')},${col(c.parent,'parent')},${col(c.title,'title')} FROM ${quote(schema.sessions.table)} ORDER BY ${quote(c.id!)} LIMIT ?`).all(max+1) as Record<string,unknown>[];
  if(!reader)snapshot.assertCurrent();return {schema,assertCurrent:snapshot.assertCurrent,assertIdentityCurrent:snapshot.assertIdentityCurrent,more:rows.length>max,sessions:rows.slice(0,max).map(r=>({id:String(r.id),project:typeof r.project==='string'?r.project:null,parent:typeof r.parent==='string'?r.parent:null,initialization:c.parent!=='fork_session_id',title:typeof r.title==='string'?clean(r.title):null}))};
 }finally{if(!reader)db.close();}
}
export function openPrompts(schema:AuditOpenSchema,id:string,maxRecords:number,maxBytes:number,maxStoreBytes:number,reader?:AuditSqliteSnapshot):{prompts:OpenPrompt[];hash:string;gaps:string[];bytes:number;nativeRecords:Record<string,unknown>[]}{
 const snapshot=reader??openAuditSqliteSnapshot(schema.dbPath,maxStoreBytes),db=snapshot.db,c=schema.messages.columns;const gaps=new Set<string>(schema.v2?[]:['opencode_exchange_projection_fidelity']);
 try{const result=db.transaction(()=>{
  const content=quote(c.content!),rows=db.prepare(`SELECT ${col(c.id,'id')},${col(c.role,'role')},${col(c.created,'created')},CASE WHEN length(CAST(${content} AS BLOB))<=? THEN ${content} ELSE NULL END AS content FROM ${quote(schema.messages.table)} WHERE ${quote(c.session!)}=? ${schema.v2&&schema.forkCutoffs?.has(id)?`AND seq>${schema.forkCutoffs.get(id)}`:''} ORDER BY ${c.created?quote(c.created)+',':''}${c.id?quote(c.id):'rowid'} LIMIT ?`).iterate(maxBytes,id,maxRecords+1) as IterableIterator<Record<string,unknown>>;
  const prompts:OpenPrompt[]=[];let bytes=0,seq=0,records=0;
  const commitments:unknown[]=[];const nativeRecords:Record<string,unknown>[]=[];
  for(const row of rows){if(++records>maxRecords){gaps.add('source_records_limit');break;}if(row.content===null){gaps.add('source_bytes_limit');continue;}let raw=String(row.content),role=typeof row.role==='string'?row.role:'';let time=clock(row.created);let nativeMessage:Record<string,unknown>|null=null,nativeParts:unknown[]=[];
   const messageBytes=Buffer.byteLength(raw);if(bytes+messageBytes>maxBytes){gaps.add('source_bytes_limit');break;}bytes+=messageBytes;
   if(schema.v2){try{const message=JSON.parse(raw) as Record<string,unknown>;nativeMessage={...message,role};time=typeof (message.time as Record<string,unknown>|undefined)?.created==='number'?new Date((message.time as {created:number}).created).toISOString():typeof row.created==='number'?new Date(row.created).toISOString():time;nativeParts=Array.isArray(message.content)?message.content:typeof message.text==='string'?[{type:'text',text:message.text}]:[];raw=JSON.stringify(nativeParts);}catch{gaps.add('opencode_native_message_invalid');continue;}}
   if(schema.parts){let doc:unknown;try{doc=JSON.parse(raw);}catch{gaps.add('opencode_native_message_invalid');continue;}if(!doc||typeof doc!=='object'){gaps.add('opencode_native_message_invalid');continue;}
    const message=doc as Record<string,unknown>;nativeMessage=message;role=typeof message.role==='string'?message.role:'';const t=message.time as Record<string,unknown>|undefined;
    const created=t?.created;if(typeof created==='number'&&Number.isFinite(created))time=new Date(created).toISOString();
    const pc=schema.parts.columns,data=quote(pc.content!);
    const parts=db.prepare(`SELECT CASE WHEN length(CAST(${data} AS BLOB))<=? THEN ${data} ELSE NULL END AS data FROM ${quote(schema.parts.table)} WHERE ${quote(pc.message!)}=? ORDER BY ${quote(pc.id!)} LIMIT ?`).iterate(maxBytes,String(row.id),maxRecords+1) as IterableIterator<{data:unknown}>;
    const payloads:unknown[]=[];
    for(const part of parts){if(++records>maxRecords){gaps.add('source_records_limit');break;}if(part.data===null){gaps.add('source_bytes_limit');continue;}const text=String(part.data),partBytes=Buffer.byteLength(text);if(bytes+partBytes>maxBytes){gaps.add('source_bytes_limit');break;}bytes+=partBytes;try{payloads.push(JSON.parse(text));}catch{gaps.add('opencode_native_part_invalid');}}
    nativeParts=payloads;raw=JSON.stringify(payloads);
   }
   commitments.push([row.id,role,row.created,raw,nativeMessage]);
   nativeRecords.push({type:'message',id:String(row.id??records),timestamp:time,message:nativeMessage??{role},content:nativeMessage?nativeParts:raw});
   if(!['user','human','prompt'].includes(role))continue;
   const unknown:Record<string,number>={};const parsed=parseContent(raw,unknown,()=>gaps.add('malformed_record'));if(Object.keys(unknown).length)gaps.add('content_coverage_partial');
   if(parsed.text.trim())prompts.push({key:String(row.id??seq),text:clean(parsed.text),time,seq:++seq});
  }
  return {prompts,hash:digest(JSON.stringify(commitments)),gaps:[...gaps],bytes,nativeRecords};
 })();if(!reader)snapshot.assertCurrent();return result;}finally{if(!reader)db.close();}
}

/** Native message.data contains usage metadata independently of large text/tool parts. */
export function openUsageMetadata(schema:AuditOpenSchema,id:string,reader:AuditSqliteSnapshot,maxRecords=1000000,maxBytes=64*1024*1024):{records:Record<string,unknown>[];gaps:string[]}{
 if(!schema.parts&&!schema.v2)return {records:[],gaps:['opencode_native_usage_unavailable']};const c=schema.messages.columns,data=quote(c.content!),projection=schema.v2?`CASE WHEN json_valid(${data}) THEN json_object('role',${quote(c.role!)},'model',json_extract(${data},'$.model'),'modelID',json_extract(${data},'$.modelID'),'providerID',json_extract(${data},'$.providerID'),'tokens',json_extract(${data},'$.tokens'),'time',json_extract(${data},'$.time'),'cost',json_extract(${data},'$.cost')) ELSE NULL END`:`CASE WHEN length(CAST(${data} AS BLOB))<=1048576 THEN ${data} ELSE NULL END`,rows=reader.db.prepare(`SELECT ${col(c.id,'id')},${col(c.created,'created')},${projection} data FROM ${quote(schema.messages.table)} WHERE ${quote(c.session!)}=? ${schema.v2&&schema.forkCutoffs?.has(id)?`AND seq>${schema.forkCutoffs.get(id)}`:''} ORDER BY ${c.created?quote(c.created)+',':''}${c.id?quote(c.id):'rowid'} LIMIT ?`).iterate(id,maxRecords+1) as IterableIterator<{id:unknown;data:unknown;created:unknown}>;
 const records:Record<string,unknown>[]=[],gaps:string[]=[];let bytes=0;for(const row of rows){if(records.length>=maxRecords){gaps.push('opencode_usage_records_limit');break;}if(typeof row.data!=='string'){gaps.push('opencode_usage_record_bytes_limit');continue;}bytes+=Buffer.byteLength(row.data);if(bytes>maxBytes){gaps.push('opencode_usage_bytes_limit');break;}try{const message=JSON.parse(row.data) as Record<string,unknown>;records.push({type:'message',id:String(row.id),timestamp:typeof (message.time as Record<string,unknown>|undefined)?.created==='number'?new Date((message.time as {created:number}).created).toISOString():typeof row.created==='number'?new Date(row.created).toISOString():null,message,content:[]});}catch{gaps.push('opencode_usage_record_invalid');}}
 return {records,gaps:[...new Set(gaps)]};
}
/** Observed user role inputs are independent of assistant/tool body capture limits. */
export function openNativeInputs(schema:AuditOpenSchema,metadata:readonly Record<string,unknown>[],reader:AuditSqliteSnapshot,maxBytes=64*1024*1024):{prompts:OpenPrompt[];excluded:Set<string>;gaps:string[]}{
 const prompts:OpenPrompt[]=[],excluded=new Set<string>(),gaps:string[]=[];let bytes=0;
 const pc=schema.parts?.columns;const query=pc?reader.db.prepare(`SELECT ${quote(pc.content!)} data FROM ${quote(schema.parts!.table)} WHERE ${quote(pc.message!)}=? ORDER BY ${quote(pc.id!)}`):null;
 for(const record of metadata){const message=record.message as Record<string,unknown>|undefined;if(message?.role!=='user')continue;const key=String(record.id);let parts:Record<string,unknown>[]=[];
  if(schema.v2){const row=reader.db.prepare(`SELECT CASE WHEN length(CAST(${quote(schema.messages.columns.content!)} AS BLOB))<=8388608 THEN json_extract(${quote(schema.messages.columns.content!)},'$.text') ELSE NULL END text FROM session_message WHERE id=?`).get(key) as {text:string|null};if(row?.text!==null&&row?.text!==undefined){bytes+=Buffer.byteLength(row.text);if(bytes<=maxBytes)parts=[{type:'text',text:row.text}];else gaps.push('native_input_text_limit');}else gaps.push('native_input_text_unavailable');}
  if(query){for(const row of query.iterate(key) as IterableIterator<{data:unknown}>){if(typeof row.data!=='string')continue;bytes+=Buffer.byteLength(row.data);if(bytes>maxBytes){gaps.push('native_input_text_limit');break;}try{const p=JSON.parse(row.data);if(p&&typeof p==='object')parts.push(p);}catch{gaps.push('opencode_native_part_invalid');}}}
  if(parts.length&&parts.every(p=>p.synthetic===true||p.ignored===true)){excluded.add(key);continue;}parts=parts.filter(p=>p.synthetic!==true&&p.ignored!==true);const unknown:Record<string,number>={};const parsed=parseContent(JSON.stringify(parts),unknown,()=>gaps.push('opencode_native_part_invalid'));
  prompts.push({key,text:clean(parsed.text),time:clock(record.timestamp),seq:prompts.length+1});
 }
 return {prompts,excluded,gaps:[...new Set(gaps)]};
}
