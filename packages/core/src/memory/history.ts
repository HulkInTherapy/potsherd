import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {Db} from '../db.js';
import type {ParseResult} from '../adapters/types.js';
import type {EvidenceRecord} from './contracts.js';
import {publishSource,sourceId,NORMALIZATION_VERSION} from './source.js';
import {hash,hasCurrentSpanManifest,type SpanTokenizer} from './spans.js';
export const isHistoryVersion=(version:string):boolean=>/^(claude|codex)-history-records-v1$/.test(version);
/** Each source owns an artifact of exact original record bytes, never a reconstructed projection. */
export function captureHistoryEvidence(db:Db,options:{root:string;harness:'claude'|'codex';historyPath:string;sessionId?:string;tokenizer?:SpanTokenizer;beforeCommit?:()=>void}):{captured:number;malformed:number;pendingBytes:number}{
 if(!fs.existsSync(options.historyPath))return{captured:0,malformed:0,pendingBytes:0};
 const snapshot=fs.readFileSync(options.historyPath),groups=new Map<string,{raw:Buffer[];records:EvidenceRecord[];bytes:number;project:string}>();let start=0,malformed=0;
 for(let end=0;end<snapshot.length;end++){
  if(snapshot[end]!==10)continue;const raw=snapshot.subarray(start,end+1),originalStart=start;start=end+1;if(!raw.toString('utf8').trim())continue;
  let r:Record<string,unknown>;try{const value:unknown=JSON.parse(raw.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('shape');r=value as Record<string,unknown>;}catch{malformed++;continue;}
  const id=options.harness==='claude'?r.sessionId:r.session_id,text=options.harness==='claude'?r.display:r.text;
  if(typeof id!=='string'||!id||typeof text!=='string'){malformed++;continue;}if(options.sessionId&&id!==options.sessionId)continue;
  const g=groups.get(id)??{raw:[],records:[],bytes:0,project:''};const project=typeof r.project==='string'?r.project:'';if(!g.project)g.project=project;
  const clock=options.harness==='claude'?r.timestamp:typeof r.ts==='number'?r.ts*1000:undefined;const eventAt=typeof clock==='number'&&Number.isFinite(clock)&&Number.isFinite(new Date(clock).valueOf())?new Date(clock).toISOString():null;
  // Offset within this retained raw artifact is exact; original file offsets are separately named.
  const key=hash(raw);g.records.push({unitKey:`ghost_prompt:${key}:${g.records.filter(x=>x.locator.rawRecordHash===key).length}`,role:'ghost_prompt',text,eventAt,timeBasis:eventAt?'record':'unknown',project,recordType:'history_prompt',locatorFidelity:'record_ordinal',locator:{recordKey:key,rawRecordHash:key,rawStart:g.bytes,rawEnd:g.bytes+raw.length,originalHistoryStart:originalStart,originalHistoryEnd:end+1,historyFormat:options.harness,mapping:'record_container'}});g.raw.push(raw);g.bytes+=raw.length;groups.set(id,g);
 }
 let captured=0;
 for(const [native,g] of groups){
  const sid=sourceId(options.harness,native);if(db.prepare("SELECT 1 FROM forget_tombstones WHERE source_id=? AND state<>'reversed'").get(sid))continue;
  const current=db.prepare('SELECT s.active_revision_id,r.adapter_version FROM memory_sources s LEFT JOIN source_revisions r ON r.revision_id=s.active_revision_id WHERE s.source_id=?').get(sid) as {active_revision_id:string|null;adapter_version:string|null}|undefined;
  // A known transcript remains richer; history is never allowed to downgrade it.
  if(current?.active_revision_id&&!isHistoryVersion(current.adapter_version??'')&&current.adapter_version!=='ghost-retained-prompts-v1')continue;
  const bytes=Buffer.concat(g.raw),digest=hash(bytes),relative=path.join('archive','evidence',`${digest}.jsonl`),file=path.join(options.root,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if(fs.existsSync(file)){if(hash(fs.readFileSync(file))!==digest)throw new Error('history artifact corruption');}
  else{const tmp=`${file}.${crypto.randomUUID()}.tmp`;try{const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{try{fs.unlinkSync(tmp);}catch{}}}
  const dates=g.records.map(r=>r.eventAt).filter((s):s is string=>!!s).sort();
  const parsed:ParseResult={session:{id:native,harness:options.harness,sourcePath:options.historyPath,project:g.project,projectSlug:'',startedAt:dates[0]??'',endedAt:dates.at(-1)??'',isSidechain:false,status:'ghost',counts:{userPrompts:g.records.length,assistantTurns:0,toolCalls:0,bytes:g.bytes}},records:g.records,exchanges:[],evidenceVersion:`${options.harness}-history-records-v1`,unknownTypes:{},malformedLines:0,endOffset:g.bytes};
  const prior=db.prepare('SELECT artifact_hash,adapter_version,normalization_version,coverage_gaps_json FROM source_revisions WHERE revision_id=?').get(current?.active_revision_id??'') as {artifact_hash:string;adapter_version:string;normalization_version:string;coverage_gaps_json:string}|undefined;
  // Missing/different pipeline policy refreshes unchanged history exactly once.
  if(prior?.artifact_hash===digest&&prior.adapter_version===parsed.evidenceVersion&&prior.normalization_version===NORMALIZATION_VERSION&&hasCurrentSpanManifest(prior.coverage_gaps_json,options.tokenizer))continue;
  const compatible:string[]=[];let older=false;for(const row of db.prepare("SELECT revision_id,artifact_hash,archive_relative_path FROM source_revisions WHERE source_id=? AND adapter_version LIKE '%-history-records-v1' AND archive_relative_path IS NOT NULL").all(sid) as {revision_id:string;artifact_hash:string;archive_relative_path:string}[]){const original=path.resolve(options.root,row.archive_relative_path);if(!original.startsWith(path.resolve(options.root)+path.sep))continue;try{const priorBytes=fs.readFileSync(original);if(hash(priorBytes)!==row.artifact_hash)continue;const n=Math.min(bytes.length,priorBytes.length);if(bytes.subarray(0,n).equals(priorBytes.subarray(0,n))){compatible.push(row.artifact_hash);if(row.revision_id===current?.active_revision_id&&priorBytes.length>bytes.length)older=true;}}catch{}}
  publishSource(db,{parsed,prefixCompatibleArtifactHashes:compatible,olderArchivedPrefix:older,artifactHash:digest,artifactBytes:g.bytes,archiveRelativePath:relative,expectedActiveRevisionId:current?.active_revision_id??null,beforeCommit:options.beforeCommit,tokenizer:options.tokenizer,sourceCompleteness:'complete'});captured++;
 }
 db.transaction(()=>{options.beforeCommit?.();db.prepare('INSERT INTO sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`memory:history-input:${options.harness}`,JSON.stringify({malformed,pendingBytes:snapshot.length-start,artifactHash:hash(snapshot),capturedAt:new Date().toISOString()}),new Date().toISOString());}).immediate();
 return{captured,malformed,pendingBytes:snapshot.length-start};
}
