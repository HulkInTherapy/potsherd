import type {AuditHarness} from './contracts.js';
import {derivedDigest,validDerivedBinding,type DerivedCacheBinding} from './derived-cache.js';
export interface HistoryDateIndex {schema:'history-date-v1';sourceBinding:string;bytesHash:string;records:number;datedRecords:number;unknownDates:number;eventFrom:string|null;eventTo:string|null;complete:boolean;gaps:readonly string[];}
export interface HistoryIndexOptions {maxRecords?:number;completeBytes?:boolean;}
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const time=(v:unknown):string|null=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<8.64e15?new Date(v).toISOString():null;
function bind(b:DerivedCacheBinding):string{return derivedDigest([b.sourceId,b.sourceIdentity,b.contentHash,b.currentness,b.privacyPolicy,b.forgetEpoch,b.normalizationVersion]);}
/** Inventories actual native event timestamps; filesystem mtime never supplies a date. */
export function indexHistoryBytes(bytes:Buffer|string,harness:AuditHarness,binding:DerivedCacheBinding,options:HistoryIndexOptions={}):HistoryDateIndex {
 if(!validDerivedBinding(binding))throw new Error('history_index_binding_invalid');const text=Buffer.isBuffer(bytes)?bytes.toString('utf8'):bytes;let records=0,datedRecords=0,unknownDates=0,eventFrom:string|null=null,eventTo:string|null=null;const gaps=new Set<string>();let complete=options.completeBytes!==false;
 const jsonArray=text.trimStart().startsWith('[');let lines:string[];try{lines=jsonArray?(JSON.parse(text) as unknown[]).map(x=>JSON.stringify(x)):text.split('\n');}catch{lines=[];complete=false;gaps.add('malformed_record');}
 if(!jsonArray&&text.length&&!text.endsWith('\n')){complete=false;gaps.add('unfinished_tail');}
 for(const line of lines){if(!line.trim())continue;if(records>=(options.maxRecords??100_000)){complete=false;gaps.add('source_records_limit');break;}records++;
  let r:Record<string,unknown>;try{r=record(JSON.parse(line));}catch{complete=false;unknownDates++;gaps.add('malformed_record');continue;}
  const m=record(r.message),p=record(r.payload),nativeTime=record(r.time);const date=time(r.timestamp)??time(m.timestamp)??time(nativeTime.created)??time(record(m.time).created)??time(p.timestamp);
  if(date){datedRecords++;if(eventFrom===null||date<eventFrom)eventFrom=date;if(eventTo===null||date>eventTo)eventTo=date;}
  else{unknownDates++;gaps.add('event_date_unrecorded');}
 }
 if(unknownDates)complete=false;if(!records)gaps.add('no_date_inventory');return {schema:'history-date-v1',sourceBinding:bind(binding),bytesHash:derivedDigest(text),records,datedRecords,unknownDates,eventFrom,eventTo,complete,gaps:[...gaps]};
}
export function validateHistoryDateIndex(v:unknown):v is HistoryDateIndex {
 const r=record(v);if(r.schema!=='history-date-v1'||typeof r.sourceBinding!=='string'||typeof r.bytesHash!=='string'||typeof r.complete!=='boolean'||!Array.isArray(r.gaps)||!r.gaps.every(g=>typeof g==='string'))return false;
 if(!['records','datedRecords','unknownDates'].every(k=>typeof r[k]==='number'&&Number.isSafeInteger(r[k])&&(r[k] as number)>=0))return false;
 if((r.datedRecords as number)+(r.unknownDates as number)!==r.records)return false;
 if(r.eventFrom!==null&&(typeof r.eventFrom!=='string'||time(r.eventFrom)!==r.eventFrom))return false;if(r.eventTo!==null&&(typeof r.eventTo!=='string'||time(r.eventTo)!==r.eventTo))return false;
 return !(r.complete&&(r.unknownDates!==0||(r.records as number)>0&&(r.eventFrom===null||r.eventTo===null)))&&!(typeof r.eventFrom==='string'&&typeof r.eventTo==='string'&&r.eventFrom>r.eventTo);
}
/** false is proof of exclusion only under an unchanged verified source binding. */
export function historyMayOverlap(index:HistoryDateIndex|null,binding:DerivedCacheBinding,from:string|null,until:string|null):boolean {
 if(!index||!validDerivedBinding(binding)||!validateHistoryDateIndex(index)||!index.complete||index.sourceBinding!==bind(binding))return true;
 if((from!==null&&!Number.isFinite(Date.parse(from)))||(until!==null&&!Number.isFinite(Date.parse(until))))return true;
 if(!index.records)return false;if(index.eventFrom===null||index.eventTo===null)return true;
 return !(from!==null&&Date.parse(index.eventTo)<Date.parse(from)||until!==null&&Date.parse(index.eventFrom)>Date.parse(until));
}
