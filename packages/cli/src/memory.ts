import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { AMBIGUOUS_LEGACY_NATIVE_IDS_SQL,LocalMemoryService,MemoryPrivacyError,MemoryInputError,validateMemoryInput,validateMemoryResponseFormat,type PublicMemoryKind,MemorySchemaError,assertMemorySchema,schemaResponse,planResponse,SpanDenseLane, db as dbNs, paths, defaultBudget, search, resolveSession, copyToClipboard, writeMemoryNotes, planWriteReceipt, type WriteInput, type RecallInput, type ReadInput, type GraftInput, type Scope, type PlannedResponse, type MemoryTransport, type ResponseBudget, type MemoryResponseFormat } from '@potsherd/core';
import { parseFilters, type FilterFlags } from './filters.js';
import { UserError, themeFrom, type GlobalOptions } from './output.js';

/** New evidence defaults open a read-only connection, never run a migration. */
export function openMemory(o:GlobalOptions&FilterFlags&{all?:boolean;vec?:boolean;vectors?:string}):{service:LocalMemoryService;db:dbNs.Db;close:()=>void}|null {
 const root=paths.potsherdDir(o.potsherdDir),file=paths.dbPath(root);
 if(!fs.existsSync(file))return null;
 const db=dbNs.openSqliteReadOnly(file);
 try {
  assertMemorySchema(db);
 } catch(error) {db.close();throw error;}
 const transport:MemoryTransport=o.json?'cli_json':{kind:'human' as const,width:themeFrom(o).width,ascii:o.ascii};
 const dense=new SpanDenseLane(db,{root,cacheDir:paths.modelsDir(root),includeIgnored:o.all});
 const service=new LocalMemoryService(db,{transport,root,...(o.vec===false||o.vectors==='off'?{semanticDisabled:true}:{dense}),includeIgnored:o.all,sourceSelection:()=>legacySourceSelection(db,o)});
 return {service,db,close(){service.close();void dense.close();db.close();}};
}
function operationalMemory(o:GlobalOptions&{inputJson?:string}):{opened:ReturnType<typeof openMemory>;state:number|null}{
 try{return {opened:openMemory({...o,...(o.inputJson?{json:true}: {})}),state:null};}
 catch(error){if(!(error instanceof MemorySchemaError))throw error;const input=o.inputJson?parseMemoryInput<{scope?:Scope;budget?:ReturnType<typeof defaultBudget>;responseFormat?:MemoryResponseFormat}>(o.inputJson):{};const planned=planResponse(schemaResponse(error,input.scope??{}),input.budget??defaultBudget(),{transport:o.inputJson||o.json?'cli_json':'human',responseFormat:input.responseFormat});return {opened:null,state:emitMemory(planned)};}
}
export function emitMemory(planned:PlannedResponse):number {
 process.stdout.write(planned.emission.serialized);
 const response=planned.response;
 return 'coverage' in response && response.coverage.state!=='unavailable'&&response.coverage.state!=='upgrade_required'?0:1;
}
/** New negotiated format also bounds the missing-store failure; legacy handling stays intact. */
function compactUnavailable(input:Pick<RecallInput,'scope'|'budget'|'responseFormat'>):number {
 const response=schemaResponse(new MemorySchemaError(0),input.scope);response.requestId='unavailable';response.coverage.state='unavailable';response.coverage.omittedKinds=['evidence_index'];response.coverage.semantic='failed';response.warnings=['memory_operation_failed'];response.support.unresolved=['The requested memory operation did not complete; this is not evidence of absence.'];
 return emitMemory(planResponse(response,input.budget,{transport:'cli_json',responseFormat:input.responseFormat}));
}
export function parseMemoryInput<T>(text:string,kind?:PublicMemoryKind):T {
 if(text.length>65536)throw new UserError('--input-json is too large','Keep public memory inputs under64KiB');
 try {const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return (kind?validateMemoryInput(kind,value):value) as T;}
 catch(error) {if(error instanceof MemoryInputError)throw error;throw new UserError('--input-json needs a JSON object','Pass a RecallInput, ReadInput or GraftInput JSON object');}
}
export function legacyMemoryScope(db:dbNs.Db,o:FilterFlags&{all?:boolean;potsherdDir?:string}):Scope {
 const {project,branch,since,until}=parseFilters(db,o);
 if(branch&&/[?*%]/u.test(branch))throw new UserError('Wildcard branches are available only on legacy diagnostics; v2 evidence needs an exact branch','Use an exact --branch or explicit --with/--explain diagnostic');
 return {...(project?{project}:{}),...(branch?{branch}:{}),...(since?{eventFrom:since}:{}),...(until?{asOf:until}:{})};
}
function legacySourceSelection(db:dbNs.Db,o:FilterFlags):{sourceIds:string[];selectionId:string;warning:string;harnesses?:string[];coverageGaps?:string[]}|undefined{
 const {project:_project,branch:_branch,since:_since,until:_until,...filters}=parseFilters(db,o);
 const active=Object.entries(filters).some(([key,value])=>Boolean(value)&&(!['sidechains','ghosts'].includes(key)||value!=='include'));
 if(!active)return undefined;
 const rows:{source_id:string}[]=[];
 const activeFields=Object.entries(filters).filter(([key,value])=>Boolean(value)&&(!['sidechains','ghosts'].includes(key)||value!=='include'));
 const canonical=db.prepare(`SELECT m.source_id,m.native_session_id,m.harness,
 EXISTS(SELECT 1 FROM sessions catalog WHERE catalog.id=m.native_session_id AND catalog.harness=m.harness) session_projection,
 EXISTS(SELECT 1 FROM ghosts catalog WHERE catalog.session_id=m.native_session_id AND catalog.harness=m.harness) ghost_projection,
 EXISTS(SELECT 1 FROM revision_units ru JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ru.revision_id=m.active_revision_id AND u.role='ghost_prompt') ghost_evidence
 FROM memory_sources m WHERE m.active_revision_id IS NOT NULL AND m.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=m.source_id AND t.state<>'reversed') ${filters.harness?'AND m.harness=?':''}`).all(...(filters.harness?[filters.harness]:[])) as {source_id:string;native_session_id:string;harness:string;session_projection:number;ghost_projection:number;ghost_evidence:number}[];
 const harnessOnly=activeFields.length===1&&activeFields[0]![0]==='harness';
 if(harnessOnly)rows.push(...canonical.map(row=>({source_id:row.source_id})));
 if(!harnessOnly&&filters.ghosts!=='only'&&filters.status!=='ghost'){
  const filter=search.buildSessionFilters(filters);
  rows.push(...db.prepare(`SELECT m.source_id FROM sessions s JOIN memory_sources m ON m.harness=s.harness AND m.native_session_id=s.id WHERE 1=1 ${filter.sql}`).all(...filter.params) as {source_id:string}[]);
 }
 if(!harnessOnly&&filters.ghosts!=='exclude'&&filters.sidechains!=='only'&&!filters.file&&(!filters.status||filters.status==='ghost')){
  const filter=search.buildGhostFilters(filters);
  rows.push(...db.prepare(`SELECT m.source_id FROM (
   SELECT session_id,harness,project,first_ts,last_ts,git_branch,title FROM ghosts
   UNION ALL
   SELECT s.native_session_id,s.harness,s.project,r.event_min,r.event_max,r.branch,NULL FROM memory_sources s JOIN source_revisions r ON r.revision_id=s.active_revision_id
   WHERE NOT EXISTS(SELECT 1 FROM ghosts old WHERE old.session_id=s.native_session_id AND old.harness=s.harness)
   AND EXISTS(SELECT 1 FROM revision_units ru JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ru.revision_id=r.revision_id AND u.role='ghost_prompt')
  ) g JOIN memory_sources m ON m.harness=g.harness AND m.native_session_id=g.session_id WHERE 1=1 ${filter.sql}
  ${filters.untitled?"AND NOT EXISTS(SELECT 1 FROM revision_units ru JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ru.revision_id=m.active_revision_id AND u.role='ghost_prompt' AND u.text NOT LIKE '/%' AND length(trim(u.text))>3)":''}`).all(...filter.params) as {source_id:string}[]);
 }
 const ambiguous=!harnessOnly?(db.prepare(`SELECT native_id native_session_id FROM (${AMBIGUOUS_LEGACY_NATIVE_IDS_SQL})`).all() as {native_session_id:string}[]).map(row=>row.native_session_id):[];
 const blocked=new Set(canonical.filter(row=>ambiguous.includes(row.native_session_id)).map(row=>row.source_id));
 const projectionGap=!harnessOnly&&canonical.some(row=>blocked.has(row.source_id)||(!row.session_projection&&!row.ghost_projection&&!row.ghost_evidence));
 const coverageGaps=projectionGap?['source_filter_projection_gap']:[];
 const sourceIds=[...new Set(rows.filter(row=>!blocked.has(row.source_id)).map((r)=>r.source_id))];
 sourceIds.sort();const identity=JSON.stringify({filters,sourceIds,coverageGaps});return {sourceIds,...(coverageGaps.length?{coverageGaps}:{}),...(filters.harness?{harnesses:[filters.harness]}:{}),selectionId:createHash('sha256').update(identity).digest('hex'),warning:'Source filters applied: '+Object.entries(filters).filter(([key,value])=>Boolean(value)&&(!['sidechains','ghosts'].includes(key)||value!=='include')).map(([key,value])=>`${key}=${String(value)}`).join('; ').slice(0,350)};
}
export function legacyMemoryRef(db:dbNs.Db,ref:string):string {
 const exact=db.prepare("SELECT native_session_id FROM memory_sources WHERE native_session_id=? AND availability<>'forgotten'").get(ref) as {native_session_id:string}|undefined;if(exact)return exact.native_session_id;
 const escaped=ref.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_');
 const rows=db.prepare("SELECT native_session_id FROM memory_sources WHERE native_session_id LIKE ? ESCAPE '\\' AND availability<>'forgotten'").all(escaped+'%') as {native_session_id:string}[];
 if(rows.length===1)return rows[0]!.native_session_id;
 if(rows.length>1){const found=resolveSession(db,ref);if(found&&!found.ambiguous)return found.id;throw new UserError(`source ref ${ref} matches ${rows.length} sessions:\n        ${rows.map(row=>row.native_session_id).join('\n        ')}`,'Use a complete native session id');}
 const found=resolveSession(db,ref);if(!found||found.ambiguous)throw new UserError(`source ref unavailable: ${ref}`,'Run potsherd ls and use a complete native session id');return found.id;
}
function checkedPublicInput<T>(o:GlobalOptions&{inputJson?:string},kind:PublicMemoryKind):{input?:T;failure?:number}{
 if(!o.inputJson)return {};
 try{if(kind==='read'&&Object.entries(o).some(([key,value])=>['from','to'].includes(key)&&value!==undefined))throw new MemoryInputError('conflicting_cli_range');if(Object.entries(o).some(([key,value])=>['project','harness','since','until','branch','file','tag','pinned','linkedTo','untitled','status','sidechains','ghosts'].includes(key)&&Boolean(value)&&(!['sidechains','ghosts'].includes(key)||value!=='include')))throw new MemoryInputError('conflicting_cli_scope');return {input:parseMemoryInput<T>(o.inputJson,kind)};}
 catch(error){let requested=defaultBudget();let responseFormat:MemoryResponseFormat='expanded-v2';try{const raw=JSON.parse(o.inputJson);if(raw.budget&&Number.isInteger(raw.budget.maxTokens)&&raw.budget.maxTokens>=64&&raw.budget.tokenizerId===requested.tokenizerId)requested={...requested,...raw.budget};if(kind!=='write')responseFormat=validateMemoryResponseFormat(raw.responseFormat);}catch{}
 const response=schemaResponse(new MemorySchemaError(0),{});response.coverage.state='unavailable';response.support.unresolved=['The request boundary is invalid; no memory operation ran.'];response.warnings=['invalid_memory_input',error instanceof MemoryInputError?error.code:'invalid_input_json'];return {failure:emitMemory(planResponse(response,requested,{transport:'cli_json',responseFormat}))};}
}
export async function memoryFind(o:GlobalOptions&FilterFlags&{query:string;inputJson?:string;exact?:boolean;vec?:boolean;vectors?:string;cards?:boolean;minConfidence?:string;limit?:unknown}):Promise<number|null> {
 if(o.cards===false||o.minConfidence!==undefined||o.limit!==undefined)throw new UserError('Legacy card/confidence/limit controls are not supported by v2 evidence output','Use --input-json with mode, explicit scope and response budget; --explain uses the legacy diagnostic surface');
 const checked=checkedPublicInput<RecallInput>(o,'recall');if(checked.failure!==undefined)return checked.failure;
 const {opened,state}=operationalMemory(o);if(state!==null)return state;
 if(!opened){if(checked.input?.responseFormat==='compact-v1')return compactUnavailable(checked.input);if(o.inputJson)throw new UserError('memory evidence index unavailable or upgrade required','Run explicit potsherd index/maintain migration first');return null;}
 try {const input=o.inputJson?checked.input!:{query:o.query,mode:o.exact?'literal' as const:'hybrid' as const,scope:legacyMemoryScope(opened.db,o),budget:defaultBudget()};const planned=await opened.service.recall(input);const code=emitMemory(planned);return !o.inputJson&&'evidence' in planned.response&&!planned.response.evidence.length&&!planned.response.assertions.some(note=>note.availability!=='privacy_refresh_required')?1:code;}finally{opened.close();}
}
export function memoryShow(o:GlobalOptions&{session:string;inputJson?:string;from?:unknown;to?:unknown}):number|null {
 const checked=checkedPublicInput<ReadInput>(o,'read');if(checked.failure!==undefined)return checked.failure;
 const {opened,state}=operationalMemory(o);if(state!==null)return state;
 if(!opened){if(checked.input?.responseFormat==='compact-v1')return compactUnavailable(checked.input);if(o.inputJson)throw new UserError('memory evidence index unavailable or upgrade required','Run explicit migration first');return null;}
 try {if(!o.inputJson&&([o.from,o.to].some(value=>value!==undefined&&(!Number.isSafeInteger(Number(value))||Number(value)<1))||(o.from!==undefined&&o.to!==undefined&&Number(o.to)<Number(o.from))))throw new UserError('show needs a positive, increasing exchange range','Use --from 1 --to 2');const input=o.inputJson?checked.input!:{legacyRef:{sessionId:legacyMemoryRef(opened.db,o.session),...(o.from!==undefined?{fromSeq:Number(o.from)}: {}),...(o.to!==undefined?{toSeq:Number(o.to)}: {})},scope:{},budget:defaultBudget()};return emitMemory(opened.service.read(input));}finally{opened.close();}
}
export async function memoryGraft(o:GlobalOptions&FilterFlags&{target:string;inputJson?:string;about?:string;budget?:number;clip?:boolean}):Promise<number|null> {
 const checked=checkedPublicInput<GraftInput>(o,'graft');if(checked.failure!==undefined)return checked.failure;
 const {opened,state}=operationalMemory(o);if(state!==null)return state;
 if(!opened){if(checked.input?.responseFormat==='compact-v1')return compactUnavailable(checked.input);if(o.inputJson)throw new UserError('memory evidence index unavailable or upgrade required','Run explicit migration first');return null;}
 try {
  if(o.inputJson){const planned=await opened.service.graft(checked.input!);if(o.clip)copyToClipboard(planned.serialized);return emitMemory(planned);}
  const budget=defaultBudget(o.budget??4096);const scope=legacyMemoryScope(opened.db,o);
  let id:string|null=null;try{id=legacyMemoryRef(opened.db,o.target);}catch(error){if(error instanceof Error&&error.message.includes('ambiguous source ref'))throw error;}
  const planned=id&&!o.about?opened.service.read({legacyRef:{sessionId:id},scope,budget}):await opened.service.graft({query:o.about??o.target,scope:id?{...scope,sourceIds:(opened.db.prepare('SELECT source_id FROM memory_sources WHERE native_session_id=?').all(id) as {source_id:string}[]).map((r)=>r.source_id).filter(source=>!scope.sourceIds||scope.sourceIds.includes(source))}:scope,budget});
  if(o.clip){const result=copyToClipboard(planned.serialized);if(!result.ok)process.stderr.write(`${result.note}\n`);}
  return emitMemory(planned);
 }finally{opened.close();}
}

export function memoryNote(o:GlobalOptions&{session:string;inputJson?:string;requestKey?:string;decided?:string[];open?:string[];next?:string[];by?:string}):number|null {
 const checked=checkedPublicInput<WriteInput>(o,'write');if(checked.failure!==undefined)return checked.failure;
 const {opened,state}=operationalMemory(o);if(state!==null)return state;
 if(!opened){if(o.inputJson)throw new UserError('durable memory writer unavailable or upgrade required','Run explicit index migration first');return null;}
 try {
  let input:WriteInput;
  if(o.inputJson)input=checked.input!;
  else {
   const native=legacyMemoryRef(opened.db,o.session);
   const rows=opened.db.prepare('SELECT s.source_id,s.project,r.branch FROM memory_sources s JOIN source_revisions r ON r.revision_id=s.active_revision_id WHERE s.native_session_id=?').all(native) as {source_id:string;project:string|null;branch:string|null}[];
   if(rows.length!==1||!rows[0]!.project)throw new UserError('notes need one source with explicit project scope','Use --input-json with explicit project and originSourceId');
   const source=rows[0]!;
   const entries:WriteInput['entries']=[...(o.decided??[]).map((text)=>({kind:'decision' as const,text})),...(o.open??[]).map((text)=>({kind:'open' as const,text})),...(o.next??[]).map((text)=>({kind:'next' as const,text}))];
   if(!entries.length)return emitMemory(opened.service.read({scope:{project:source.project!,sourceIds:[source.source_id],...(source.branch?{branch:source.branch}: {})},budget:defaultBudget()}));
   input={requestKey:o.requestKey??randomUUID(),scope:{project:source.project!,...(source.branch?{branch:source.branch}: {})},originSourceId:source.source_id,entries,authorClaim:o.by??'unknown',origin:'cli',authority:'agent_assertion'};
  }
  const {budget:requestedBudget=defaultBudget(),...semanticInput}=input as WriteInput&{budget?:ResponseBudget};
  const transport:MemoryTransport=o.json||o.inputJson?'cli_json':{kind:'human',width:themeFrom(o).width,ascii:o.ascii};
  const writer=dbNs.open({root:paths.potsherdDir(o.potsherdDir)});
  try {const planned=writer.transaction(()=>{const receipt=writeMemoryNotes(writer,{...semanticInput,origin:'cli',authority:input.authority??'agent_assertion'},'cli');const packet=planWriteReceipt(receipt,requestedBudget,transport);if(packet.response.error)throw new RangeError('write_receipt_over_budget');return packet;}).immediate();process.stdout.write(planned.emission.serialized);return 0;}catch(error){if(!(error instanceof MemoryPrivacyError)&&!(error instanceof RangeError&&error.message.includes('Budget')||error instanceof RangeError&&error.message==='write_receipt_over_budget'))throw error;const response=schemaResponse(new MemorySchemaError(0),input.scope);response.coverage.state='unavailable';response.warnings=[error instanceof MemoryPrivacyError?'privacy_refresh_required':'write_receipt_over_budget'];response.support.unresolved=[error instanceof MemoryPrivacyError?'The retained support quote is unavailable under the current privacy policy; obtain a safe refreshed ref before writing.':'The requested budget cannot carry a durable receipt; no new write committed. Retry with a larger budget.'];return emitMemory(planResponse(response,requestedBudget,{transport}));}finally{writer.close();}
 }finally{opened.close();}
}
