import {openAuditSqliteSnapshot} from '../audit-sqlite.js';
import {describeStore,parseContent,type StoreSchema} from '../adapters/opencode.js';
import {clock,clean,digest} from './source.js';

const quote=(s:string)=>`"${s.replaceAll('"','""')}"`;
const col=(s:string|undefined,alias:string)=>s?`${quote(s)} AS ${quote(alias)}`:`NULL AS ${quote(alias)}`;
export interface OpenSession {id:string;project:string|null;parent:string|null;title:string|null;}
export interface OpenPrompt {key:string;text:string;time:string|null;seq:number;}
/** Bounded projections use the adapter's recognized schema and content parser. */
export function openSessions(file:string,max:number,maxStoreBytes:number):{sessions:OpenSession[];more:boolean;schema:StoreSchema;assertCurrent:()=>void;assertIdentityCurrent:()=>void}|{gap:string}{
 const snapshot=openAuditSqliteSnapshot(file,maxStoreBytes),db=snapshot.db;
 try{const description=describeStore(file,db);if(!description.ok)return {gap:'opencode_store_unsupported'};const schema=description.schema,c=schema.sessions.columns;const rows=db.prepare(`SELECT ${quote(c.id!)} AS id,${col(c.directory,'project')},${col(c.parent,'parent')},${col(c.title,'title')} FROM ${quote(schema.sessions.table)} ORDER BY ${quote(c.id!)} LIMIT ?`).all(max+1) as Record<string,unknown>[];
  snapshot.assertCurrent();return {schema,assertCurrent:snapshot.assertCurrent,assertIdentityCurrent:snapshot.assertIdentityCurrent,more:rows.length>max,sessions:rows.slice(0,max).map(r=>({id:String(r.id),project:typeof r.project==='string'?r.project:null,parent:typeof r.parent==='string'?r.parent:null,title:typeof r.title==='string'?clean(r.title):null}))};
 }finally{db.close();}
}
export function openPrompts(schema:StoreSchema,id:string,maxRecords:number,maxBytes:number,maxStoreBytes:number):{prompts:OpenPrompt[];hash:string;gaps:string[];bytes:number;nativeRecords:Record<string,unknown>[]}{
 const snapshot=openAuditSqliteSnapshot(schema.dbPath,maxStoreBytes),db=snapshot.db,c=schema.messages.columns;const gaps=new Set<string>(['opencode_exchange_projection_fidelity']);
 try{const result=db.transaction(()=>{
  const content=quote(c.content!),rows=db.prepare(`SELECT ${col(c.id,'id')},${col(c.role,'role')},${col(c.created,'created')},CASE WHEN length(CAST(${content} AS BLOB))<=? THEN ${content} ELSE NULL END AS content FROM ${quote(schema.messages.table)} WHERE ${quote(c.session!)}=? ORDER BY ${c.created?quote(c.created)+',':''}${c.id?quote(c.id):'rowid'} LIMIT ?`).iterate(maxBytes,id,maxRecords+1) as IterableIterator<Record<string,unknown>>;
  const prompts:OpenPrompt[]=[];let bytes=0,seq=0,records=0;
  const commitments:unknown[]=[];const nativeRecords:Record<string,unknown>[]=[];
  for(const row of rows){if(++records>maxRecords){gaps.add('source_records_limit');break;}if(row.content===null){gaps.add('source_bytes_limit');continue;}let raw=String(row.content),role=typeof row.role==='string'?row.role:'';let time=clock(row.created);let nativeMessage:Record<string,unknown>|null=null,nativeParts:unknown[]=[];
   const messageBytes=Buffer.byteLength(raw);if(bytes+messageBytes>maxBytes){gaps.add('source_bytes_limit');break;}bytes+=messageBytes;
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
 })();snapshot.assertCurrent();return result;}finally{db.close();}
}
