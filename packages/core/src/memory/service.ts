import {adjacentDialogueContext,flattenDialogueGroups} from './dialogue-context.js';
import { inspectNotes } from './notes-store.js';
import { readIgnoreList, isIgnoredProject, rootForDb } from '../ignore.js';
import { potsherdDir } from '../paths.js';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { readSpan, readEpochs, inspectCoverage,spanPrivacyRefreshRequired,privacySafeReplacement,outcomeSafeReplacement,spanOutcomeRefreshRequired } from './source.js';
import { scopeSql, validateScope, lineageFamilySql } from './scope.js';
import type { Candidate, Coverage, Epochs, EvidenceItem, GraftInput, MemoryResponse, MemoryResponseFormat, NoteView, RecallInput, ReadInput, Requirement, Scope, WriteInput, WriteReceipt } from './contracts.js';
import { assertResponseFormat, defaultBudget, planResponse, safeBoundary, type InspectNavigationPlan, type PlannedResponse, type Transport } from './budget.js';
import { validateMemoryResponseFormat, validateRecallNavigation } from './input.js';
import { centerEvidence, decodeCursor, planReadResponse, sameEvidenceEpochs, type ReadCursor } from './context.js';
import { CANDIDATES_PER_LANE, retrievalIntent, ftsQuery, fuseCandidates, selectEvidence, queryTerms, fullUnitLiteralCandidates, knownLiteralMatches, literalSearchLimited } from './retrieval.js';
import { assessSupport, refKey } from './support.js';

export interface DenseLane {
 search(input: {query:string;scope:Scope;snapshotEpochs:Epochs;limit:number}, signal?:AbortSignal): Promise<{candidates:Candidate[];state:Coverage['semantic'];spaceId?:string}>;
}
export type MemorySourceSelection={sourceIds:string[];selectionId:string;warning?:string;harnesses?:string[];coverageGaps?:string[]};
export type MemoryServiceOptions = { transport?:Transport; dense?:DenseLane; notes?:(scope:Scope,query?:string)=>NoteView[]; write?:(input:WriteInput)=>WriteReceipt; ownsConnection?:boolean; root?:string; includeIgnored?:boolean;semanticDisabled?:boolean;sourceSelection?:()=>MemorySourceSelection|undefined };
/** Transport service returns planned emissions, unlike the semantic MemoryStore interface. */
export interface PlannedMemoryService {
 recall(input:RecallInput,signal?:AbortSignal):Promise<PlannedResponse>;
 read(input:ReadInput,signal?:AbortSignal):PlannedResponse;
 graft(input:GraftInput,signal?:AbortSignal):Promise<PlannedResponse>;
}
const JOIN = `FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id JOIN source_revisions r ON r.revision_id=rs.revision_id JOIN memory_sources s ON s.source_id=r.source_id`;
const EMPTY_EPOCHS: Epochs={evidence:0,notes:0,lineage:0,deletion:0,vector:0};

/** Service owns read lifetimes; no migration, acquisition or paid model calls. */
export class LocalMemoryService implements PlannedMemoryService {
 private closed = false;
 constructor(private readonly db:Db, private readonly options:MemoryServiceOptions = {}) {}
 inspect(scope:Scope={}):Coverage {
  this.assertOpen(); validateScope(scope);
  try { return this.db.transaction(()=>this.scopedCoverage(scope,this.options.semanticDisabled?'disabled':this.options.dense?'building':'missing_assets',this.currentSelection()))(); }
  catch { return {state:'upgrade_required',snapshotEpochs:EMPTY_EPOCHS,scope,capturedThrough:null,pendingSources:0,failedSources:0,omittedKinds:['evidence_index'],semantic:'failed'}; }
 }
 private currentSelection():MemorySourceSelection|undefined{const selection=this.options.sourceSelection?.();return selection?{...selection,sourceIds:[...new Set(selection.sourceIds)].sort()}:undefined;}
 private assertOpen():void { if(this.closed)throw new Error('memory_service_closed'); }
 private base(scope:Scope,coverage=this.inspect(scope)):MemoryResponse {
  return {contractVersion:2,requestId:randomUUID(),coverage,support:{state:'unassessed',method:'none',requirements:[],unresolved:[]},evidence:[],assertions:[],candidates:[],budget:{tokenizerId:defaultBudget().tokenizerId,usedTokens:0,remainingTokens:0,truncated:false,omittedItems:0},warnings:coverage.omittedKinds.includes('activation_history_unknown')?['Source activation history before the recorded upgrade baseline is unknown; this does not establish historical absence.']:[]};
 }
 private format(value?:MemoryResponseFormat):MemoryResponseFormat {const format=validateMemoryResponseFormat(value);assertResponseFormat(this.options.transport??'json',format);return format;}
 private plan(response:MemoryResponse,budget=defaultBudget(),requirements?:readonly Requirement[],literalMatches?:ReturnType<typeof knownLiteralMatches>,responseFormat:MemoryResponseFormat='expanded-v2',navigation?:InspectNavigationPlan,evidenceFirst=false):PlannedResponse {
  return planResponse(response,budget,{transport:this.options.transport??'json',responseFormat,navigation,evidenceFirst,requirements,knownLiteralMatches:literalMatches,noteScopeEligible:(note,scope)=>this.noteScopeEligible(note,scope)});
 }
 private fail(scope:Scope,budget:RecallInput['budget'],code:string,state:Coverage['state']='unavailable',responseFormat:MemoryResponseFormat='expanded-v2'):PlannedResponse {
  const result=this.base(scope); result.coverage.state=state;result.warnings=[code];result.support={state:'insufficient',method:'none',requirements:[],unresolved:['The requested memory operation did not complete; this is not evidence of absence.']};
  return this.plan(result,budget,undefined,undefined,responseFormat);
 }
 private ignoredProjects(scope:Scope):string[] {
  if(scope.project!==undefined||this.options.includeIgnored)return [];
  const entries=readIgnoreList(this.options.root??rootForDb(this.db)??potsherdDir());
  if(!entries.length)return [];
  const projects=(this.db.prepare('SELECT DISTINCT project FROM evidence_units UNION SELECT DISTINCT project FROM memory_note_events').all() as {project:string|null}[]).map((r)=>r.project).filter((p):p is string=>p!==null);
  return projects.filter((project)=>isIgnoredProject(project,entries));
 }
 private effectiveScope(scope:Scope,selection?:MemorySourceSelection):Scope {
  // Public lineage expansion establishes scope; internal boundaries constrain final membership.
  if(scope.sourceIds&&scope.lineage&&scope.lineage!=='self'){
   const family=lineageFamilySql(scope);
   scope={...scope,sourceIds:(this.db.prepare(family.sql).all(...family.params) as {id:string}[]).map(row=>row.id),lineage:'self'};
  }
  if(selection)scope={...scope,sourceIds:scope.sourceIds?scope.sourceIds.filter(id=>selection.sourceIds.includes(id)):selection.sourceIds};
  const ignored=this.ignoredProjects(scope);
  if(!ignored.length)return scope;
  const allowed=(this.db.prepare(`SELECT source_id FROM memory_sources WHERE project IS NULL OR project NOT IN (${ignored.map(()=>'?').join(',')})`).all(...ignored) as {source_id:string}[]).map((row)=>row.source_id);
  return {...scope,sourceIds:scope.sourceIds?scope.sourceIds.filter((id)=>allowed.includes(id)):allowed};
 }
 private eligibleSql(scope:Scope,selection?:MemorySourceSelection):ReturnType<typeof scopeSql> {
  const filter=scopeSql(this.effectiveScope(scope,selection));
  const ignored=this.ignoredProjects(scope);
  return ignored.length?{sql:filter.sql+` AND (u.project IS NULL OR u.project NOT IN (${ignored.map(()=>'?').join(',')}))`,params:[...filter.params,...ignored]}:filter;
 }
 private scopedCoverage(scope:Scope,semantic:Coverage['semantic'],selection?:MemorySourceSelection):Coverage{const effective=this.effectiveScope(scope,selection);const coverage=inspectCoverage(this.db,effective,semantic,{sourceIds:scope.sourceIds?effective.sourceIds:undefined,harnesses:scope.sourceIds?undefined:selection?.harnesses});const gaps=selection?.coverageGaps?.slice(0,8).map(code=>code.slice(0,64))??[];return {...coverage,...(gaps.length?{state:'partial' as const,omittedKinds:[...new Set([...coverage.omittedKinds,...gaps])]}:{}),scope};}
 private addSelectionWarning(response:MemoryResponse,selection?:MemorySourceSelection):void{if(response.coverage.omittedKinds.includes('producer_refresh_required'))response.warnings.push('producer_refresh_required');if(response.coverage.omittedKinds.includes('outcome_refresh_required'))response.warnings.push('outcome_refresh_required');if(response.coverage.omittedKinds.includes('privacy_refresh_required'))response.warnings.push('privacy_refresh_required');if(selection?.coverageGaps?.length)response.warnings.push(...selection.coverageGaps.slice(0,8).map(code=>code.slice(0,64)));if(selection?.warning)response.warnings.push(selection.warning.slice(0,400));}
 private noteScopeEligible(note:NoteView,scope:Scope):boolean{return inspectNotes(this.db,scope,{includeHistory:scope.includeHistory}).some(item=>item.noteId===note.noteId);}
 private assessSupport(requirements:readonly Requirement[],evidence:readonly EvidenceItem[],notes:readonly NoteView[],complete:boolean){
  return assessSupport(requirements,evidence,notes,complete,(note,scope)=>this.noteScopeEligible(note,scope));
 }
 private producerWarnings(response:MemoryResponse):void{if(response.evidence.some(item=>item.provenance?.producerNameBasis==='unverified')){response.coverage.state='partial';response.coverage.omittedKinds=[...new Set([...response.coverage.omittedKinds,'producer_refresh_required'])];if(!response.warnings.includes('producer_refresh_required'))response.warnings.push('producer_refresh_required');}}
 private readNotes(scope:Scope,query?:string,requirements:readonly Requirement[]=[],selection?:MemorySourceSelection):NoteView[] {
  scope=this.effectiveScope(scope,selection);
  const ignored=this.ignoredProjects(scope);
  const rows=this.options.notes?.(scope,query)??inspectNotes(this.db,scope,{includeHistory:scope.includeHistory});
  const terms=queryTerms(query??'');
  return rows.filter((note)=>!ignored.includes(note.project)).map((note)=>{
   const text=`${note.kind} ${note.text}`.toLowerCase();
   const score=terms.filter((term)=>text.includes(term)||term.endsWith('s')&&text.includes(term.slice(0,-1))).length;
   const selector=requirements.some((r)=>r.note&&(!r.note.kind||r.note.kind===note.kind));
   return {note,score,selector};
  }).filter((item)=>!query||!terms.length||item.score>0||item.selector).sort((a,b)=>Number(b.selector)-Number(a.selector)||b.score-a.score||a.note.noteId.localeCompare(b.note.noteId)).slice(0,16).map((item)=>item.note);
 }
 private lane(query:string,scope:Scope,literal:boolean,selection?:MemorySourceSelection):Candidate[] {
  const filter=this.eligibleSql(scope,selection);
  if(literal)return fullUnitLiteralCandidates(this.db,query,filter);
  const phrase=ftsQuery(query);
  const rows=(phrase ? this.db.prepare(`SELECT s.source_id,r.revision_id,p.span_id ${JOIN} JOIN spans_fts ON spans_fts.rowid=p.span_rowid WHERE ${filter.sql} AND spans_fts MATCH ? ORDER BY bm25(spans_fts),p.span_id LIMIT ?`).all(...filter.params,phrase,CANDIDATES_PER_LANE) : []) as {source_id:string;revision_id:string;span_id:string}[];
  return rows.map((row)=>{const ref={sourceId:row.source_id,revisionId:row.revision_id,spanId:row.span_id};return {ref,score:0,lanes:[literal?'literal':'lexical'],evidence:readSpan(this.db,ref)??undefined};});
 }
 async recall(input:RecallInput,signal?:AbortSignal):Promise<PlannedResponse> {
  this.assertOpen(); validateScope(input.scope);const responseFormat=this.format(input.responseFormat);
  const navigation=validateRecallNavigation(input.navigation,responseFormat);
  if(!input.query || input.query.length>8000)throw new Error('query must contain 1–8000 characters');
  if((input.requirements?.length??0)>16)throw new Error('too many requirements');
  signal?.throwIfAborted();
  const literal=input.mode==='literal';
  try {
   for(let attempt=0;attempt<2;attempt++) {
    const snapshot=this.db.transaction(()=>{const selection=this.currentSelection();signal?.throwIfAborted();return {selection,effectiveScope:this.effectiveScope(input.scope,selection),coverage:this.scopedCoverage(input.scope,literal?'disabled':this.options.semanticDisabled?'disabled':this.options.dense?'building':'missing_assets',selection),lexical:this.lane(input.query,input.scope,literal,selection),probes:(input.requirements??[]).filter(r=>r.literal!==undefined).flatMap(r=>this.lane(r.literal!,input.scope,true,selection)),notes:literal?[]:this.readNotes(input.scope,input.query,input.requirements,selection)};})();
    signal?.throwIfAborted();
    const dense=literal?{candidates:[],state:'disabled' as const}:this.options.dense?await this.options.dense.search({query:input.query,scope:this.effectiveScope(input.scope,snapshot.selection),snapshotEpochs:snapshot.coverage.snapshotEpochs,limit:CANDIDATES_PER_LANE},signal):{candidates:[],state:this.options.semanticDisabled?'disabled' as const:'missing_assets' as const};
    signal?.throwIfAborted();
    const finished=this.db.transaction(()=>{
     const selection=this.currentSelection();signal?.throwIfAborted();
     const currentEpochs=readEpochs(this.db);
     if(!sameEvidenceEpochs(snapshot.coverage.snapshotEpochs,currentEpochs)||(selection?.selectionId??null)!==(snapshot.selection?.selectionId??null)||JSON.stringify(this.effectiveScope(input.scope,selection))!==JSON.stringify(snapshot.effectiveScope))return null;
     // A vector-only commit cannot invalidate immutable lexical evidence. Discard the
     // asynchronous dense lane rather than combine it with an unpinned vector view.
     const vectorChanged=currentEpochs.vector!==snapshot.coverage.snapshotEpochs.vector;
     // Re-read every dense ref and revalidate eligibility. Runtime must also prefilter before top-k.
     const filter=this.eligibleSql(input.scope,selection);
     const verified=(vectorChanged?[]:dense.candidates).filter((candidate)=>Boolean(this.db.prepare(`SELECT 1 ${JOIN} WHERE ${filter.sql} AND s.source_id=? AND r.revision_id=? AND p.span_id=?`).get(...filter.params,candidate.ref.sourceId,candidate.ref.revisionId,candidate.ref.spanId)))
      .map((candidate)=>({...candidate,evidence:readSpan(this.db,candidate.ref)??undefined}));
     const pool=fuseCandidates([{lane:literal?'literal':'lexical',candidates:snapshot.lexical},{lane:'dense',candidates:verified},{lane:'literal',candidates:snapshot.probes}]);
     const response=this.base(input.scope,{...snapshot.coverage,semantic:vectorChanged?'building':dense.state});if(vectorChanged)response.warnings.push('vector_progress_lexical_fallback');this.addSelectionWarning(response,selection);
     const literalMatches=knownLiteralMatches(pool);
     if(literalSearchLimited(pool)){response.coverage.state='partial';response.coverage.omittedKinds.push('literal_search_limited');response.warnings.push('literal_search_limited');}
     const requirements=literal&&!(input.requirements?.length)?[{id:'literal',text:'The exact requested literal occurs in delivered source evidence.',literal:input.query}]:input.requirements??[];
     response.assertions=snapshot.notes.slice(0,16);
     const selected=selectEvidence(pool,input.query,requirements);
     // Short human choices often lack the entity words in their explanatory
     // assistant record. Retrieve bounded same-revision dialogue context without
     // turning chronology or adjacency into an adopted-decision assertion.
     const intent=retrievalIntent(input.query);
     const historicalContext=/\b(historical|original|prior|earlier)\b/iu.test(input.query)&&!intent.requestForDecisionContext&&!intent.requestForObservedOutcome;
     const groups=literal||requirements.some(r=>r.literal!==undefined)||(!intent.requestForDecisionContext&&!historicalContext)?[]:adjacentDialogueContext(this.db,pool.slice(0,16).flatMap(c=>c.evidence?[c.evidence]:[]),input.query,filter,historicalContext?{maxAnchors:16,precedingUnits:8,roles:['assistant','tool_result'],allowComparison:false}:{maxAnchors:16}).filter(group=>group.context.length);
     const contextual=flattenDialogueGroups(groups);
     for(const item of contextual)if(!pool.some(candidate=>refKey(candidate.ref)===refKey(item.ref)))pool.push({ref:item.ref,score:0,lanes:[],evidence:item});
     const grouped=[...contextual,...selected.filter(item=>!contextual.some(other=>refKey(other.ref)===refKey(item.ref)&&other.startUtf16===item.startUtf16&&other.endUtf16===item.endUtf16))];
     response.evidence=grouped.map((item)=>centerEvidence(item,input.query,requirements.flatMap((r)=>r.literal!==undefined?[r.literal]:[])));
     response.candidates=pool.filter((candidate)=>!response.evidence.some((e)=>refKey(e.ref)===refKey(candidate.ref))).slice(0,8).map(({ref,score,lanes})=>({ref,score,lanes}));
     this.producerWarnings(response);response.support=this.assessSupport(requirements,response.evidence,response.assertions,response.coverage.state==='complete_snapshot');
     if(!response.evidence.length&&!response.assertions.length)response.warnings.push(literalMatches.length?'Matching canonical source text was not delivered; inspect the candidate spans.':response.coverage.state==='complete_snapshot'?'No matching evidence in this captured snapshot.':'No delivered evidence; captured coverage is incomplete.');
     if(!literal&&dense.state!=='ready')response.warnings.push(`Semantic retrieval capability: ${dense.state}.`);
     signal?.throwIfAborted();const planned=this.plan(response,input.budget,requirements,literalMatches,responseFormat,navigation?{pool,query:input.query,terms:queryTerms(input.query)}:undefined,!requirements.some(r=>r.note)&&! /\b(notes?|handoffs?|constraints?)\b/iu.test(input.query));signal?.throwIfAborted();return planned;
    })();
    if(finished)return finished;
   }
   return this.fail(input.scope,input.budget,'snapshot_changed','partial',responseFormat);
  } catch(error) {
   if(signal?.aborted)throw error;
   return this.fail(input.scope,input.budget,'retrieval_failed','unavailable',responseFormat);
  }
 }
 read(input:ReadInput,signal?:AbortSignal):PlannedResponse {
  this.assertOpen();validateScope(input.scope);const responseFormat=this.format(input.responseFormat);signal?.throwIfAborted();
  try { return this.db.transaction(()=>{
   const selection=this.currentSelection();signal?.throwIfAborted();
   const coverage=this.scopedCoverage(input.scope,'disabled',selection);
   const cursor=input.cursor?decodeCursor(input.cursor):null;
   if(cursor&&(cursor.selectionId??null)!==(selection?.selectionId??null))return this.fail(input.scope,input.budget,'snapshot_changed','partial',responseFormat);
   if(cursor&&!cursor.historical&&!sameEvidenceEpochs(cursor.epochs,coverage.snapshotEpochs))return this.fail(input.scope,input.budget,'snapshot_changed','partial',responseFormat);
   if(cursor&&JSON.stringify(cursor.scope)!==JSON.stringify(input.scope))throw new Error('cursor_scope_mismatch');
   let refs=input.refs??cursor?.positions.map((p)=>p.ref)??[];
   if(refs.length>16)throw new Error('Read accepts at most16refs');
   let scan:ReadCursor['scan'];
   const legacyRef=input.legacyRef??cursor?.scan?.legacyRef;
   if(!refs.length&&legacyRef) {
    const filter=this.eligibleSql(input.scope,selection);
    const sources=this.db.prepare(`SELECT DISTINCT s.source_id ${JOIN} WHERE ${filter.sql} AND s.native_session_id=?`).all(...filter.params,legacyRef.sessionId) as {source_id:string}[];
    if(sources.length!==1)return this.fail(input.scope,input.budget,sources.length?'ambiguous_legacy_ref':'legacy_ref_unavailable','unavailable',responseFormat);
    const rows=(this.db.prepare(`SELECT s.source_id,r.revision_id,p.span_id ${JOIN} WHERE ${filter.sql} AND s.native_session_id=? ${legacyRef.seq!==undefined?'AND u.legacy_seq=?':`${legacyRef.fromSeq!==undefined?'AND u.legacy_seq>=?':''} ${legacyRef.toSeq!==undefined?'AND u.legacy_seq<=?':''}`} ORDER BY s.source_id,r.revision_id,rs.ordinal LIMIT 2 OFFSET ?`).all(...filter.params,legacyRef.sessionId,...(legacyRef.seq!==undefined?[legacyRef.seq]:[...(legacyRef.fromSeq!==undefined?[legacyRef.fromSeq]:[]),...(legacyRef.toSeq!==undefined?[legacyRef.toSeq]:[])]),cursor?.scan?.offset??0) as {source_id:string;revision_id:string;span_id:string}[]);
    if(!rows.length)return this.fail(input.scope,input.budget,'legacy_exchange_unavailable','partial',responseFormat);
    refs=rows.slice(0,1).map((r)=>({sourceId:r.source_id,revisionId:r.revision_id,spanId:r.span_id}));
    if(rows.length>1)scan={legacyRef,offset:(cursor?.scan?.offset??0)+1};
   }
   if(refs.length&&cursor?.positions.length&&cursor.scan)scan=cursor.scan;
   const response=this.base(input.scope,coverage);this.addSelectionWarning(response,selection);
   for(const ref of refs) {
    signal?.throwIfAborted();
    const filter=this.eligibleSql({...input.scope,includeHistory:true},selection);
    const eligible=this.db.prepare(`SELECT 1 ${JOIN} WHERE ${filter.sql} AND s.source_id=? AND r.revision_id=? AND p.span_id=?`).get(...filter.params,ref.sourceId,ref.revisionId,ref.spanId);
    const item=eligible?readSpan(this.db,ref):null;
    if(!item){response.coverage.state='partial';const privacy=Boolean(eligible)&&spanPrivacyRefreshRequired(this.db,ref);response.warnings.push(privacy?'privacy_refresh_required':'source_span_unavailable');if(privacy){const newer=privacySafeReplacement(this.db,ref);if(newer&&this.db.prepare(`SELECT 1 ${JOIN} WHERE ${filter.sql} AND s.source_id=? AND r.revision_id=? AND p.span_id=?`).get(...filter.params,newer.sourceId,newer.revisionId,newer.spanId))response.candidates.push({ref:newer,score:0,lanes:[]});}continue;}
    if(spanOutcomeRefreshRequired(this.db,item.ref)){
     const newer=outcomeSafeReplacement(this.db,ref);if(newer&&readSpan(this.db,newer)&&this.db.prepare(`SELECT 1 ${JOIN} WHERE ${filter.sql} AND s.source_id=? AND r.revision_id=? AND p.span_id=?`).get(...filter.params,newer.sourceId,newer.revisionId,newer.spanId))response.candidates.push({ref:newer,score:0,lanes:[]});
    }
    const start=cursor?.positions.find((p)=>refKey(p.ref)===refKey(ref))?.startUtf16??item.startUtf16;
    if(start<item.startUtf16||start>=item.endUtf16||safeBoundary(item.text,start-item.startUtf16)!==start-item.startUtf16)throw new Error('cursor_range_mismatch');
    const text=item.text.slice(start-item.startUtf16);
    response.evidence.push({...item,text,startUtf16:start,citation:`span:${ref.sourceId}:${ref.revisionId}:${ref.spanId}@${start}-${item.endUtf16}`});
   }
   signal?.throwIfAborted();
   if(input.noteIds){
    if(input.noteIds.length>16)throw new Error('Read accepts at most16note IDs');
    const ignored=this.ignoredProjects(input.scope);
    response.assertions=inspectNotes(this.db,{...this.effectiveScope(input.scope,selection),includeHistory:true},{includeHistory:true}).filter((note)=>input.noteIds!.includes(note.noteId)&&!ignored.includes(note.project));
    if(response.assertions.length!==new Set(input.noteIds).size){response.coverage.state='partial';response.warnings.push('note_unavailable');}
   }else if(!refs.length&&(input.scope.project||input.scope.sourceIds?.length))response.assertions=this.readNotes(input.scope,undefined,[],selection);
   if(response.evidence.some(item=>item.provenance?.producerNameBasis==='unverified'&&item.role==='tool_result')){response.coverage.state='partial';response.coverage.omittedKinds.push('producer_refresh_required');response.warnings.push('producer_refresh_required');}
   if(response.evidence.some(item=>spanOutcomeRefreshRequired(this.db,item.ref))){response.coverage.state='partial';response.coverage.omittedKinds.push('outcome_refresh_required');response.warnings.push('outcome_refresh_required');}
   this.producerWarnings(response);response.support=this.assessSupport([],response.evidence,response.assertions,response.coverage.state==='complete_snapshot');
   signal?.throwIfAborted();
   const planned=planReadResponse(response,input.budget,input.scope,this.options.transport??'json',cursor?.historical??Boolean(input.refs?.length),scan,selection?.selectionId,responseFormat);signal?.throwIfAborted();return planned;
  })(); } catch(error) {if(signal?.aborted)throw error;return this.fail(input.scope,input.budget,'read_failed','unavailable',responseFormat);}
 }
 async graft(input:GraftInput,signal?:AbortSignal):Promise<PlannedResponse> {
  this.assertOpen();validateScope(input.scope);const responseFormat=this.format(input.responseFormat);signal?.throwIfAborted();
  if(input.mode==='assisted')return this.fail(input.scope,input.budget,'assisted_graft_requires_explicit_backend','unavailable',responseFormat);
  if(input.refs?.length)return this.read({refs:input.refs,scope:input.scope,budget:input.budget,responseFormat},signal);
  if(input.query)return this.recall({query:input.query,scope:input.scope,budget:input.budget,requirements:input.requirements,responseFormat},signal);
  return this.db.transaction(()=>{
   const selection=this.currentSelection();signal?.throwIfAborted();const response=this.base(input.scope,this.scopedCoverage(input.scope,this.options.semanticDisabled?'disabled':this.options.dense?'building':'missing_assets',selection));this.addSelectionWarning(response,selection);response.assertions=this.readNotes(input.scope,undefined,input.requirements,selection);
   const filter=this.eligibleSql(input.scope,selection);
   const rows=this.db.prepare(`SELECT s.source_id,r.revision_id,p.span_id ${JOIN} WHERE ${filter.sql} AND u.role<>'ghost_prompt' ORDER BY CASE WHEN u.role='tool_result' THEN 0 ELSE 1 END,u.event_at DESC,r.observed_at DESC,rs.ordinal DESC LIMIT 32`).all(...filter.params) as {source_id:string;revision_id:string;span_id:string}[];
   const candidates=rows.map((row,index)=>{const ref={sourceId:row.source_id,revisionId:row.revision_id,spanId:row.span_id};return {ref,score:1/(60+index+1),lanes:[] as Candidate['lanes'],evidence:readSpan(this.db,ref)??undefined};});
   response.evidence=selectEvidence(candidates,'current status decisions open next',input.requirements);
   this.producerWarnings(response);response.support=this.assessSupport(input.requirements??[],response.evidence,response.assertions,response.coverage.state==='complete_snapshot');signal?.throwIfAborted();const planned=this.plan(response,input.budget,input.requirements,undefined,responseFormat);signal?.throwIfAborted();return planned;
  })();
 }
 write(input:WriteInput,signal?:AbortSignal):WriteReceipt {this.assertOpen();signal?.throwIfAborted();if(!this.options.write)throw new Error('durable_writer_unavailable');return this.options.write(input);}
 close():void {if(this.closed)return;this.closed=true;if(this.options.ownsConnection)this.db.close();}
}
