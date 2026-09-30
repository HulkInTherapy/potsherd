import {validSpanVector,validatedSpanVectorBlob} from './vector-validation.js';
import {compatibleSpanPolicies} from './spans.js';
import type { Db } from '../db.js';
import type { DenseLane } from './service.js';
import type { Candidate, Scope } from './contracts.js';
import { readIgnoreList, isIgnoredProject } from '../ignore.js';
import { scopeSql } from './scope.js';
import { inspectCoverage,readSpan } from './source.js';
import { DEFAULT_SPACE_ID, TOKENIZER_HASH, inspectAssets, LocalEncoder } from './assets.js';
import { BGE_QUERY_PREFIX } from '../embeddings.js';
/** Every eligibility predicate is applied before scoring/top-k. */
export function denseEligibility(db:Db,scope:Scope,root:string,includeIgnored=false):{sql:string;params:unknown[]} {
 const f=scopeSql(scope);if(scope.project!==undefined||includeIgnored)return f;
 const entries=readIgnoreList(root);if(!entries.length)return f;
 const projects=(db.prepare('SELECT DISTINCT project FROM evidence_units UNION SELECT DISTINCT project FROM memory_sources').all() as {project:string|null}[]).filter(r=>r.project!==null&&isIgnoredProject(r.project,entries)).map(r=>r.project!);
 if(!projects.length)return f;const p=projects.map(()=>'?').join(',');return {sql:f.sql+` AND (u.project IS NULL OR u.project NOT IN (${p})) AND (s.project IS NULL OR s.project NOT IN (${p}))`,params:[...f.params,...projects,...projects]};
}
export class SpanDenseLane implements DenseLane {
 constructor(private db:Db,private options:{root:string;cacheDir:string;encoder?:LocalEncoder;includeIgnored?:boolean}){}
 private ownEncoder:LocalEncoder|undefined;
 async search(input:Parameters<DenseLane['search']>[0],signal?:AbortSignal):ReturnType<DenseLane['search']> {
  signal?.throwIfAborted();
  const space=this.db.prepare(`SELECT space_id FROM embedding_spaces WHERE space_id=? AND state='active'`).get(DEFAULT_SPACE_ID);
  if(inspectAssets(this.options.cacheDir).state!=='ready')return {candidates:[],state:'missing_assets',spaceId:DEFAULT_SPACE_ID};
  if(input.scope.learnedBy&&!input.scope.includeHistory&&inspectCoverage(this.db,input.scope).omittedKinds.includes('activation_history_unknown'))return {candidates:[],state:'failed',spaceId:DEFAULT_SPACE_ID};
  if(!space)return {candidates:[],state:'building',spaceId:DEFAULT_SPACE_ID};
  const f=denseEligibility(this.db,input.scope,this.options.root,this.options.includeIgnored);
  const base=`FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id JOIN source_revisions r ON r.revision_id=rs.revision_id JOIN memory_sources s ON s.source_id=r.source_id`;
  const count=(this.db.prepare(`SELECT COUNT(*) n ${base} WHERE ${f.sql}`).get(...f.params) as {n:number}).n;
  try {
   const encoder=this.options.encoder??(this.ownEncoder??=new LocalEncoder(this.options.cacheDir));
   const q=await encoder.encode(BGE_QUERY_PREFIX+input.query,signal,true);
   if(!validSpanVector(q))return {candidates:[],state:'failed',spaceId:DEFAULT_SPACE_ID};
   const best:{ref:Candidate['ref'];score:number}[]=[];
   let valid=0,corrupt=false,ordinal=-1,revision='';
   // Keyset pages bound BLOB retention; every requested membership remains in
   // the denominator, including missing/unsupported historical representations.
   for(;;){
    signal?.throwIfAborted();
    const rows=this.db.prepare(`SELECT s.source_id,r.revision_id,p.span_id,rs.ordinal,e.vector_blob ${base} JOIN span_embeddings e ON e.span_id=p.span_id AND e.space_id=? AND e.input_hash=p.embedding_input_hash WHERE ${f.sql} AND p.chunk_policy IN (?,?) AND (rs.revision_id,rs.ordinal)>(?,?) ORDER BY rs.revision_id,rs.ordinal LIMIT 128`).all(DEFAULT_SPACE_ID,...f.params,...compatibleSpanPolicies(TOKENIZER_HASH),revision,ordinal) as {source_id:string;revision_id:string;span_id:string;ordinal:number;vector_blob:Buffer}[];
    if(!rows.length)break;
    for(const row of rows){
     ordinal=row.ordinal;revision=row.revision_id;
     const v=validatedSpanVectorBlob(row.vector_blob);if(!v){corrupt=true;continue;}valid++;
     let score=0;for(let j=0;j<q.length;j++)score+=q[j]!*v[j]!;
     if(!Number.isFinite(score)){corrupt=true;continue;}
     const entry={ref:{sourceId:row.source_id,revisionId:row.revision_id,spanId:row.span_id},score};
     best.push(entry);best.sort((a,b)=>b.score-a.score||a.ref.spanId.localeCompare(b.ref.spanId));if(best.length>Math.min(64,input.limit))best.pop();
    }
    await new Promise<void>(resolve=>setImmediate(resolve));
   }
   return {candidates:best.map(x=>({...x,lanes:['dense'] as Candidate['lanes']})),state:corrupt?'failed':valid===count?'ready':'building',spaceId:DEFAULT_SPACE_ID};
  }catch(error){if(signal?.aborted)throw error;return {candidates:[],state:'failed',spaceId:DEFAULT_SPACE_ID};}
 }
 async close():Promise<void>{await this.ownEncoder?.close();}
}
