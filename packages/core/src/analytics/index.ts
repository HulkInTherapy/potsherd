import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as pause} from 'node:timers/promises';
import type {Db} from '../db.js';
import {openAuditSqliteSnapshot,type AuditSqliteSnapshot} from '../audit-sqlite.js';
import * as paths from '../paths.js';
import {readIgnoreConfig,isIgnoredProject} from '../ignore.js';
import {assertMemorySchema} from '../memory/readiness.js';
import {sourceId,readEpochs,getSourceRevision,inspectCoverage} from '../memory/source.js';
import {scopeSql} from '../memory/scope.js';
import {LocalMemoryService} from '../memory/service.js';
import {defaultBudget} from '../memory/budget.js';
import {collectEvidence} from '../parser/evidence.js';
import {requiresPrivacyRefresh,NORMALIZATION_VERSION} from '../memory/privacy.js';
import {boundedBytes,walk,nativeFacts,digest,clean,clock,type NativeFacts,type NativeEvent} from './source.js';
import type {LaunchAudit,ContextRecord,RecordedInference,SemanticPeriod,ContextSegment} from './launch-contracts.js';
import {extractNativeUsage} from './native-usage.js';
import {aggregateLaunchFacts,type ModelCatalog} from './model-catalog.js';
import {cachedPublicCatalog,refreshPublicCatalog} from './catalog-service.js';
import {attributeDirectLanguage} from './language-models.js';
import {DerivedCache,type DerivedCacheBinding} from './derived-cache.js';
import {indexHistoryBytes,historyMayOverlap,validateHistoryDateIndex} from './history-index.js';
import {parseContextualNative,segmentContext,CONTEXT_SEGMENTATION_VERSION} from './contextual-native.js';
import {FreeJevProvider,FREE_JEV_MODEL,type FreeJevResponse} from './free-jev.js';
import {runLaunchSemantics,LAUNCH_QUESTION_VERSION,selectedSegments,buildLaunchRequest} from './launch-semantics.js';
import {openSessions,openPrompts,type OpenSession,type OpenPrompt} from './opencode.js';
import {deterministicFindings} from './findings.js';
import {JevSessionRunner,type SemanticConversationInput} from './jev-session.js';
import {auditProfanity} from './profanity.js';
import type {Scope,Epochs,MemoryResponse} from '../memory/contracts.js';
import type {AuditOverviewOptions,AuditSession,AuditSnapshot,AuditHarness,AuditCoverage,AuditMetric,AuditEvent,AuditPrompt,AuditConversation,AuditEvidenceRoute,AuditEvidence,AuditProject,AuditSemanticSelection,AuditSemanticPreview,AuditSemantics,AuditPromptJudgment} from './contracts.js';
export * from './contracts.js';
export {composeJevJudgments} from './jev-session.js';

const HARNESSES:AuditHarness[]=['claude','codex','pi','opencode'];
const cap=(value:number|undefined,fallback:number,max:number)=>{const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error('invalid audit limit');return n;};
const metric=(value:number|null,unit:string,basis:string,definition:string,partial=false):AuditMetric=>({value,numerator:value,denominator:null,unit,measurementBasis:basis,state:value===null?'unavailable':partial?'partial':'observed',definition});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const immutable=<T>(value:T):T=>freeze(structuredClone(value));
const emptyCoverage=():AuditCoverage=>({state:'complete_snapshot',knownSources:0,parsedSources:0,unknownOriginEvents:0,excludedEvents:0,omittedSources:0,gapCodes:[]});
const routeKey=(route:AuditEvidenceRoute)=>JSON.stringify(route);
interface OriginProof {recordId:string;commitment:string;declaredOrigin:string|null;}
interface Entry {conversation:AuditConversation;project:string|null;prompts:AuditPrompt[];hash:string;proofs?:Map<string,OriginProof>;committedBytes?:Buffer;file:string|null;fileHash:string|null;fileStat?:{size:number;dev:string;ino:string;mtimeNs:string;ctimeNs:string};nativeRecords?:Record<string,unknown>[];nativeKeys?:Map<string,string>;open?:{schema:Parameters<typeof openPrompts>[0];id:string;maxBytes:number;assertCurrent:()=>void;assertIdentityCurrent:()=>void};}

/** Aggregate-only public representation: titles, identifiers, paths and excerpts are private detail. */
export function publicAuditSnapshot(snapshot:AuditSnapshot):AuditSnapshot {
 return immutable({...snapshot,...(snapshot.launch?{launch:{...snapshot.launch,languageByModel:snapshot.launch.languageByModel?.map(row=>({...row,promptIds:[]})),facts:snapshot.launch.facts?{...snapshot.launch.facts,records:[]}:null,semantics:snapshot.launch.semantics?{...snapshot.launch.semantics,stories:[],hallOfFame:[],judgments:[]}:null}}:{}),...(snapshot.profanity?{profanity:{...snapshot.profanity,matches:[]}}:{}),scope:{...snapshot.scope,project:snapshot.scope.project?'selected_project':null},conversations:snapshot.conversations.map((c,i)=>({...c,nativeSessionId:`Conversation ${i+1}`,title:null})),projects:snapshot.projects.map(p=>({...p,path:null,displayName:p.alias})),phrases:[],judgments:[],insights:snapshot.insights.map(i=>({...i,caption:i.publicCaption})),warnings:snapshot.warnings.map(w=>w.split(':')[0]!.slice(0,96))});
}

export function createAuditSession(options:AuditOverviewOptions={}):AuditSession {return new LocalAuditSession(options);}
class LocalAuditSession implements AuditSession {
 private readonly controller=new AbortController();private readonly id=randomUUID();private disposed=false;private started=false;private stale=false;
 private db:Db|null=null;private storeSnapshot:AuditSqliteSnapshot|null=null;private policyChecked=false;private policyAvailable=true;private ignored:string[]=[];private epochs:Epochs|null=null;private policyCommitment:string|null=null;private hadStore=false;
 private entries=new Map<string,Entry>();private routes=new Map<string,AuditPrompt>();private totalBytes=0;private totalPrompts=0;private sequence=0;
 private gaps=new Set<string>();private lineageGaps=new Set<string>();private omitted=0;private candidates=0;private parsed=0;private callback:((event:AuditEvent)=>void)|undefined;
 private readonly limits:{source:number;candidates:number;total:number;prompts:number;records:number;store:number};private readonly root:string;private derived:DerivedCache|null=null;private semanticReservedTokens=0;private launchRunning=false;private launchSegments:ContextSegment[]=[];private catalog:ModelCatalog|null=null;
 private current:AuditSnapshot;private readonly semanticRunner=new JevSessionRunner();private readonly dayMemo=new Map<string,string>();private readonly dayFormatter:Intl.DateTimeFormat;
 constructor(private readonly options:AuditOverviewOptions){
  const harnesses=options.harnesses?[...new Set(options.harnesses)]:options.launch?(['codex','claude','opencode','pi'] as AuditHarness[]):HARNESSES;if(!harnesses.every(h=>HARNESSES.includes(h)))throw new Error('unsupported audit harness');
  const timezone=options.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone;new Intl.DateTimeFormat('en-US',{timeZone:timezone}).format();this.dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const from=options.since?clock(options.since):null,to=options.until?clock(options.until):null;if((options.since&&!from)||(options.until&&!to)||(from&&to&&from>to))throw new Error('invalid audit event range');
  const store=options.maxStoreBytes??64*1024*1024;if(!Number.isSafeInteger(store)||store<100||store>256*1024*1024)throw new Error('invalid audit SQLite byte limit');
  this.root=paths.potsherdDir(options.potsherdDir);if(options.launch){this.derived=new DerivedCache(options.derivedCacheDir??path.join(this.root,'audit-derived'));this.catalog=cachedPublicCatalog(this.derived);}this.limits={source:cap(options.maxSourceBytes,2*1024*1024,16*1024*1024),candidates:cap(options.maxCandidates,500,5000),total:cap(options.maxTotalBytes,32*1024*1024,128*1024*1024),prompts:cap(options.maxPrompts,10000,50000),records:cap(options.maxRecordsPerSource,10000,50000),store};
  options.signal?.addEventListener('abort',()=>this.cancel(),{once:true});if(options.signal?.aborted)this.cancel();
  this.current=immutable({schemaVersion:'audit-v1',snapshotId:this.id,sequence:0,measuredAt:new Date().toISOString(),scope:{harnesses,project:options.project?path.resolve(options.project):null,eventFrom:from,asOf:to,timezone},status:'discovering',coverage:emptyCoverage(),progress:{stage:'discovering',completed:0,total:null,unit:'candidate_source',provisional:true,cancellable:true},metrics:{conversations:metric(null,'top_level_conversation','native_identity','Distinct selected top-level conversations'),humanPrompts:metric(null,'eligible_human_input_event','native_origin_discriminator_v1','Eligible recorded human input events; child initialization excluded'),projects:metric(null,'known_project','exact_path','Distinct known projects in selected conversations'),linkedChildren:metric(null,'supported_child_source','declared_parent_identity','Selected child conversations with recorded parents')},sources:harnesses.map(h=>({harness:h,state:'absent',candidateFiles:0,conversations:0,humanPrompts:null,humanOrigin:h==='pi'||h==='opencode'?'projection':'native_marker',evidence:'unavailable',usage:'unavailable',firstUnsupportedStep:null,gapCodes:[]})),projects:[],activity:[],conversations:[],insights:[],usage:{state:'unavailable',inputTokens:null,outputTokens:null,cacheTokens:null,reasoningTokens:null,costUsd:null,measurementBasis:null,inclusion:null,priceVersion:null},...(options.launch?{launch:{facts:null,semantics:null,stage:'discovering' as const,notice:'Conversation text is redacted locally. OpenCode Zen and TypeSafe/Jev receive selected conversations for free analysis. Esc cancels.'}}:{}),semantics:{state:'not_run',qualified:false,model:null,classifiedPrompts:0,eligiblePrompts:0,uncertainPrompts:0,work:[],requestCount:0,cacheHits:0,estimatedCostUsd:null,reportedCostUsd:null,unresolvedCostUsd:null,errorCode:null},warnings:[],sourceEpochs:null});
 }
 snapshot():AuditSnapshot{return this.current;}
 cancel():void{this.controller.abort();this.semanticRunner.invalidate();}
 dispose():void{if(this.disposed)return;this.cancel();this.disposed=true;this.db?.close();this.db=null;this.storeSnapshot=null;this.entries.clear();this.routes.clear();this.dayMemo.clear();this.launchSegments=[];this.semanticRunner.dispose();}
 private assertOpen():void{if(this.disposed)throw new Error('audit_session_disposed');}
 /** Changed fields are isolated; untouched, deeply frozen fields can be shared. */
 private update(patch:Partial<AuditSnapshot>):void{this.current=freeze({...this.current,...immutable(patch)});}
 private emit(stage:AuditSnapshot['status']):void{
  if(this.policyChecked&&!this.fresh()){this.invalidate();this.policyAvailable=false;this.gap('audit_snapshot_stale');stage='partial';}
  this.originProofs();if(stage==='cancelled')this.gap('cancelled_scan_scope_unmeasured');
  const entries=[...this.entries.values()],partial=this.gaps.size>0||this.omitted>0;const prompts=entries.flatMap(e=>e.prompts),eligible=prompts.filter(p=>p.eligibleHuman);
  const unknown=prompts.filter(p=>p.originBasis==='unknown'&&!['unpaired_user_response','child_initialization','tool_result','maintenance_exclusion_marker','inherited_native_event'].includes(p.excludedReason??'')).length;
  const excluded=prompts.length-eligible.length-unknown;const projectMap=new Map<string,AuditProject>();
  for(const entry of entries){if(entry.project===null)continue;const id=digest(entry.project).slice(0,20);let project=projectMap.get(id);if(!project){project={id,alias:'',displayName:'',path:entry.project,humanPrompts:0,conversations:0,share:null};projectMap.set(id,project);}project.conversations+=entry.conversation.child?0:1;project.humanPrompts+=entry.prompts.filter(p=>p.eligibleHuman).length;}
  const projects=[...projectMap.values()].sort((a,b)=>a.id.localeCompare(b.id)).map((p,i)=>({...p,alias:`Project ${i<26?String.fromCharCode(65+i):i+1}`,displayName:this.options.launch?clean(path.basename(p.path!)): `Project ${i<26?String.fromCharCode(65+i):i+1}`,share:eligible.length?p.humanPrompts/eligible.length:null}));if(this.options.launch)projects.sort((a,b)=>b.humanPrompts-a.humanPrompts||b.conversations-a.conversations||a.id.localeCompare(b.id));
  const dates=new Map<string,number>();
  for(const prompt of eligible){if(prompt.eventAt){let date=this.dayMemo.get(prompt.eventAt);if(date===undefined){const parts=this.dayFormatter.formatToParts(new Date(prompt.eventAt));const get=(type:string)=>parts.find(p=>p.type===type)!.value;date=`${get('year')}-${get('month')}-${get('day')}`;if(this.dayMemo.size<this.limits.prompts)this.dayMemo.set(prompt.eventAt,date);}dates.set(date,(dates.get(date)??0)+1);}}
  const top=entries.filter(e=>!e.conversation.child).length,children=entries.length-top;
  const coverage:AuditCoverage={state:partial?'partial':'complete_snapshot',knownSources:this.candidates,parsedSources:this.parsed,unknownOriginEvents:unknown,excludedEvents:excluded,omittedSources:this.omitted,gapCodes:[...this.gaps].sort()};
  const sources=this.current.sources.map(source=>{const group=entries.filter(e=>e.conversation.harness===source.harness),n=group.flatMap(e=>e.prompts).filter(p=>p.eligibleHuman).length;const projection=source.harness==='pi'||source.harness==='opencode';const ownGaps=[...new Set([...source.gapCodes,...group.flatMap(e=>e.conversation.coverage.gapCodes)])];return {...source,state:!this.policyAvailable?'unavailable' as const:ownGaps.length?'partial' as const:group.length?'available' as const:source.state,conversations:group.length,humanPrompts:projection||!n&&ownGaps.length?null:n,evidence:group.some(e=>e.prompts.some(p=>p.route.basis==='canonical'))?'canonical' as const:group.length?projection?'projection' as const:'transient' as const:source.evidence,gapCodes:ownGaps};});
  const humanValue=eligible.length?eligible.length:unknown||this.omitted||this.gaps.size||entries.some(e=>e.conversation.harness==='pi'||e.conversation.harness==='opencode')?null:0;
  const progress={stage,completed:this.parsed,total:stage==='ready'||stage==='partial'?this.candidates:null,unit:'candidate_source' as const,provisional:!['ready','partial','cancelled','error'].includes(stage),cancellable:!['ready','partial','cancelled','error'].includes(stage)};
  const final=['ready','partial','cancelled'].includes(stage)&&!this.stale;const profanity=final?auditProfanity(eligible,partial):undefined;
  const findings=final?deterministicFindings(entries.map(e=>e.conversation),eligible,this.current.scope.timezone,partial,digest(JSON.stringify(this.current.scope))):{insights:[],phrases:[]};
  this.update({...findings,profanity,sequence:++this.sequence,measuredAt:new Date().toISOString(),status:stage,sourceEpochs:this.epochs,coverage,progress,sources,projects,conversations:entries.map(e=>e.conversation),activity:[...dates].sort(([a],[b])=>a.localeCompare(b)).map(([date,count])=>({date,count})),metrics:{conversations:metric(!this.policyAvailable&&!entries.length?null:top,'top_level_conversation','harness_native_identity','Distinct selected top-level conversation identities',partial),humanPrompts:metric(!this.policyAvailable&&!entries.length?null:humanValue,'eligible_human_input_event','native_origin_discriminator_v1','Eligible native input markers; known maintenance and programmatic inputs excluded. This is recorded-origin evidence, not universal human attestation.',partial),projects:metric(!this.policyAvailable&&!entries.length?null:projects.length,'known_project','normalized_exact_path','Distinct known project paths; unknown projects excluded',partial),linkedChildren:metric(!this.policyAvailable&&!entries.length?null:children,'supported_child_source','declared_parent_identity','Distinct selected child conversations with declared parent identities',partial)},semantics:{...this.current.semantics,eligiblePrompts:eligible.length},commitment:digest(JSON.stringify(entries.map(e=>[e.conversation.id,e.hash]))),warnings:[...this.gaps]});
  this.callback?.({type:'progress',snapshotId:this.id,sequence:this.sequence,progress:this.current.progress,sources:this.current.sources});this.callback?.({type:'snapshot',snapshot:this.current});
 }
 private gap(code:string,harness?:AuditHarness):void{this.gaps.add(code);if(harness)this.update({sources:this.current.sources.map(s=>s.harness===harness?{...s,state:'partial',firstUnsupportedStep:s.firstUnsupportedStep??code,gapCodes:[...new Set([...s.gapCodes,code])]}:s)});}
 /** Verified Claude UUID+declared session_id relationships only; no text similarity. */
 private originProofs():void{
  const previous=this.lineageGaps;for(const code of previous)this.gaps.delete(code);this.update({sources:this.current.sources.map(s=>({...s,gapCodes:s.gapCodes.filter(code=>!previous.has(code)),firstUnsupportedStep:s.firstUnsupportedStep&&previous.has(s.firstUnsupportedStep)?null:s.firstUnsupportedStep}))});this.lineageGaps=new Set();
  const originGap=(code:string,harness:AuditHarness)=>{this.lineageGaps.add(code);this.gap(code,harness);};
  const bySource=new Map<string,Map<string,{prompt:AuditPrompt;proof:OriginProof}>>(),groups=new Map<string,{source:string;prompt:AuditPrompt;proof:OriginProof}[]>();
  for(const [id,entry] of this.entries){if(entry.conversation.harness!=='claude')continue;const records=new Map<string,{prompt:AuditPrompt;proof:OriginProof}>();bySource.set(id,records);
   for(const prompt of entry.prompts){const proof=entry.proofs?.get(prompt.id);if(!proof)continue;records.set(proof.recordId,{prompt,proof});const group=groups.get(proof.recordId)??[];group.push({source:id,prompt,proof});groups.set(proof.recordId,group);}
  }
  for(const [id,records] of bySource)for(const {prompt,proof} of records.values()){
   if(!proof.declaredOrigin||prompt.excludedReason==='child_initialization'||prompt.excludedReason==='maintenance_exclusion_marker')continue;
   const originId=sourceId('claude',proof.declaredOrigin),original=bySource.get(originId)?.get(proof.recordId);
   prompt.eligibleHuman=false;prompt.originBasis='unknown';
   if(original&&original.proof.commitment===proof.commitment&&original.proof.declaredOrigin!==this.entries.get(id)?.conversation.nativeSessionId){prompt.excludedReason='inherited_native_event';prompt.identityBasis='declared_parent_native_record_commitment_v1';}
   else{prompt.excludedReason='inherited_identity_unverified';originGap(original?'inherited_record_commitment_unverified':'inherited_origin_source_unavailable','claude');}
  }
  for(const group of groups.values()){
   if(group.length<2)continue;const owners=group.filter(item=>!item.proof.declaredOrigin);
   if(owners.length>1){for(const item of owners){item.prompt.eligibleHuman=false;item.prompt.originBasis='unknown';item.prompt.excludedReason='cross_source_identity_unverified';}originGap('cross_source_event_identity_collision','claude');}
  }
  // These are individual native sources, not a verified chain count. Other
  // harnesses have no repository-qualified copied-prefix record identity rule.
  if([...this.entries.values()].filter(e=>e.conversation.harness==='codex'&&!e.conversation.child).length>1)originGap('codex_cross_source_lineage_unverified','codex');
  for(const entry of this.entries.values()){const unknown=entry.prompts.filter(p=>p.originBasis==='unknown'&&!['unpaired_user_response','child_initialization','tool_result','maintenance_exclusion_marker','inherited_native_event'].includes(p.excludedReason??'')).length;entry.conversation={...entry.conversation,promptCount:entry.conversation.harness==='pi'||entry.conversation.harness==='opencode'?null:entry.prompts.filter(p=>p.eligibleHuman).length,unknownOriginEvents:unknown,coverage:{...entry.conversation.coverage,unknownOriginEvents:unknown,excludedEvents:entry.prompts.filter(p=>!p.eligibleHuman).length-unknown}};}
 }
 private memoryScope():Scope{return {...(this.current.scope.project?{project:this.current.scope.project}:{}),...(this.current.scope.eventFrom?{eventFrom:this.current.scope.eventFrom}:{}),...(this.current.scope.asOf?{asOf:this.current.scope.asOf}:{})};}
 private invalidate():void{
  if(this.stale)return;this.stale=true;this.controller.abort();this.semanticRunner.invalidate();this.dayMemo.clear();this.entries.clear();this.routes.clear();this.launchSegments=[];this.totalPrompts=0;
  const metrics=Object.fromEntries(Object.entries(this.current.metrics).map(([key,value])=>[key,{...value,value:null,numerator:null,state:'unavailable'}])) as AuditSnapshot['metrics'];
  this.update({...(this.current.launch?{launch:{...this.current.launch,languageByModel:[],facts:null,semantics:null,stage:'ready' as const}}:{}),status:'partial',sequence:++this.sequence,metrics,projects:[],activity:[],conversations:[],insights:[],phrases:[],judgments:[],profanity:undefined,semantics:{...this.current.semantics,state:this.current.semantics.state==='not_run'||this.current.semantics.state==='no_key'?this.current.semantics.state:'cancelled',qualified:false,classifiedPrompts:0,eligiblePrompts:0,uncertainPrompts:0,unclassifiedPrompts:0,work:[],errorCode:'source_or_policy_changed'},coverage:{...this.current.coverage,state:'partial',gapCodes:[...new Set([...this.current.coverage.gapCodes,'audit_snapshot_stale'])]}});
 }
 private fresh(content=false):boolean{
  if(this.stale)return false;try{if(content)this.storeSnapshot?.assertCurrent();else this.storeSnapshot?.assertIdentityCurrent();const verifiedReaders=new Set<()=>void>();for(const entry of this.entries.values()){const verify=entry.open?(content?entry.open.assertCurrent:entry.open.assertIdentityCurrent):null;if(verify&&!verifiedReaders.has(verify)){verify();verifiedReaders.add(verify);}if(this.options.launch&&entry.file&&entry.fileStat){const stat=fs.statSync(entry.file,{bigint:true});if(Number(stat.size)!==entry.fileStat.size||String(stat.dev)!==entry.fileStat.dev||String(stat.ino)!==entry.fileStat.ino||String(stat.mtimeNs)!==entry.fileStat.mtimeNs||String(stat.ctimeNs)!==entry.fileStat.ctimeNs)return false;if(content&&entry.fileHash!==null&&digest(boundedBytes(entry.file,this.limits.source))!==entry.fileHash)return false;}}if(!this.hadStore&&fs.existsSync(paths.dbPath(this.root)))return false;const config=paths.configPath(this.root),current=fs.existsSync(config)?digest(boundedBytes(config,1024*1024)):null;if(current!==this.policyCommitment)return false;
   if(this.db&&this.epochs){const next=readEpochs(this.db);if(['evidence','notes','lineage','deletion'].some(k=>next[k as keyof Epochs]!==this.epochs![k as keyof Epochs]))return false;}return true;
  }catch{return false;}
 }
 private policy():void{
  this.policyChecked=true;const config=paths.configPath(this.root);try{if(fs.existsSync(config)){const s=fs.statSync(config);if(!s.isFile()||s.size>1024*1024)throw new Error('ignore_policy_unavailable');fs.accessSync(config,fs.constants.R_OK);this.policyCommitment=digest(boundedBytes(config,1024*1024));const ignored=readIgnoreConfig(this.root);if(ignored.error)throw new Error('ignore_policy_unavailable');this.ignored=ignored.list;}}
  catch{this.policyAvailable=false;this.gap('ignore_policy_unavailable');}
  this.hadStore=fs.existsSync(paths.dbPath(this.root));if(!this.hadStore)return;
  try{this.storeSnapshot=openAuditSqliteSnapshot(paths.dbPath(this.root),this.limits.store);this.db=this.storeSnapshot.db;assertMemorySchema(this.db);this.epochs=readEpochs(this.db);}
  catch(error){this.db?.close();this.db=null;this.storeSnapshot=null;this.policyAvailable=false;this.gap('store_policy_unavailable');if(error instanceof Error&&error.message.startsWith('audit_sqlite_'))this.gap(error.message);}
 }
 private denied(id:string,project:string|null):boolean{if(project&&isIgnoredProject(project,this.ignored))return true;return !!this.db?.prepare("SELECT 1 FROM forget_tombstones WHERE source_id=? AND state<>'reversed'").get(id);}
 private selected(event:NativeEvent):boolean{
  if(this.ignored.length&&event.project&&isIgnoredProject(event.project,this.ignored))return false;
  if(this.current.scope.project&&event.project!==this.current.scope.project){if(event.project===null)this.gap('project_unknown');return false;}
  if(!event.eventAt){this.gap('event_time_unknown');return !this.current.scope.eventFrom&&!this.current.scope.asOf;}
  return (!this.current.scope.eventFrom||event.eventAt>=this.current.scope.eventFrom)&&(!this.current.scope.asOf||event.eventAt<=this.current.scope.asOf);
 }
 private add(harness:AuditHarness,facts:NativeFacts,file:string,fileHash:string,canonical?:{revisionId:string;refs:Map<number,AuditEvidenceRoute>}):void{
  const id=sourceId(harness,facts.nativeId);if(this.denied(id,facts.project))return;
  const existing=this.entries.get(id);if(existing){if(existing.hash===facts.hash)return;if(existing.committedBytes&&(existing.committedBytes.subarray(0,facts.bytes.length).equals(facts.bytes)||facts.bytes.subarray(0,existing.committedBytes.length).equals(existing.committedBytes))){if(existing.committedBytes.length>=facts.bytes.length)return;this.remove(id);}else{this.gap('source_alias_conflict',harness);return;}}
  for(const code of facts.gaps)this.gap(code,harness);const events=facts.events.filter(e=>this.selected(e));if(this.current.scope.project&&facts.project!==this.current.scope.project&&!events.length)return;if((this.current.scope.eventFrom||this.current.scope.asOf)&&!events.length)return;
  const prompts:AuditPrompt[]=[];const nativeKeys=new Map<string,string>();const proofs=new Map<string,OriginProof>();
  for(const event of events){if(this.totalPrompts>=this.limits.prompts){this.gap('prompt_limit',harness);break;}const route=canonical?.refs.get(event.evidenceStart??event.rawStart)??{basis:'transient_snapshot' as const,sourceId:id,artifactHash:facts.hash,sourcePath:file,recordKey:event.key,rawStart:event.rawStart,rawEnd:event.rawEnd,startUtf16:0,endUtf16:event.text.length,snapshotId:this.id};
   const prompt:AuditPrompt={id:digest(`${id}:${event.identity}`).slice(0,32),conversationId:id,role:'user',originBasis:event.origin,identityBasis:event.identity,eligibleHuman:event.eligible,excludedReason:event.excluded,eventAt:event.eventAt,text:event.text,route};prompts.push(prompt);for(const key of [event.key,event.identity,String(event.rawStart),...(event.evidenceStart!==undefined?[String(event.evidenceStart)]:[])])nativeKeys.set(key,prompt.id);if(event.nativeRecordId&&event.recordCommitment)proofs.set(prompt.id,{recordId:event.nativeRecordId,commitment:event.recordCommitment,declaredOrigin:event.declaredOrigin??null});else if(event.declaredOrigin)this.gap('inherited_record_identity_unavailable',harness);this.routes.set(routeKey(route),prompt);this.totalPrompts++;}
  const ownUnknown=prompts.filter(p=>p.originBasis==='unknown').length;const dates=prompts.map(p=>p.eventAt).filter((t):t is string=>t!==null).sort();
  const coverage={...emptyCoverage(),knownSources:1,parsedSources:1,unknownOriginEvents:ownUnknown,excludedEvents:prompts.filter(p=>!p.eligibleHuman).length,state:facts.gaps.length?'partial' as const:'complete_snapshot' as const,gapCodes:facts.gaps};
  const measuredProject=this.current.scope.project??facts.project;
  const title=this.current.scope.project||this.ignored.length?null:facts.title;
  this.entries.set(id,{conversation:{id,sourceId:id,harness,nativeSessionId:facts.nativeId,projectId:measuredProject?digest(measuredProject).slice(0,20):null,title,alias:`Conversation ${this.entries.size+1}`,promptCount:harness==='pi'||harness==='opencode'?null:prompts.filter(p=>p.eligibleHuman).length,unknownOriginEvents:ownUnknown,eventFrom:dates[0]??null,eventTo:dates.at(-1)??null,child:facts.child,parentId:facts.parent?sourceId(harness,facts.parent):null,coverage},project:measuredProject,prompts,proofs,nativeKeys,hash:facts.hash,committedBytes:facts.bytes,file,fileHash,...(file&&fileHash?{fileStat:(({size,dev,ino,mtimeNs,ctimeNs})=>({size:Number(size),dev:String(dev),ino:String(ino),mtimeNs:String(mtimeNs),ctimeNs:String(ctimeNs)}))(fs.statSync(file,{bigint:true}))}:{})});this.parsed++;
 }
 private remove(id:string):void{const old=this.entries.get(id);if(old){this.totalPrompts-=old.prompts.length;for(const prompt of old.prompts)this.routes.delete(routeKey(prompt.route));this.entries.delete(id);}}
 private sourceCandidate(harness:AuditHarness,countFile=true):void{this.candidates++;this.update({sources:this.current.sources.map(s=>s.harness===harness?{...s,candidateFiles:s.candidateFiles+(countFile?1:0),state:'available'}:s)});}
 private launchPublish(patch:Partial<LaunchAudit>):void{if(!this.current.launch)return;if(!this.fresh()){this.invalidate();return;}this.update({launch:{...this.current.launch,...patch},sequence:++this.sequence});this.callback?.({type:'snapshot',snapshot:this.current});}
 private cacheBinding(id:string,identity:string,contentHash:string,currentness:string):DerivedCacheBinding{return {sourceId:id,sourceIdentity:identity,contentHash,currentness,privacyPolicy:digest(JSON.stringify([this.policyCommitment,this.current.scope.project,this.ignored])),forgetEpoch:digest(JSON.stringify(this.epochs??'no-store')),normalizationVersion:NORMALIZATION_VERSION};}
 private launchAllowed(project:string|null):boolean{return !(project&&isIgnoredProject(project,this.ignored))&&(!this.current.scope.project||project===this.current.scope.project);}
 private async assembleLaunch(period?:SemanticPeriod):Promise<void>{
  if(!this.fresh(true)){this.invalidate();return;}this.launchPublish({stage:'sizing'});
  const records:RecordedInference[]=[],contexts:ContextRecord[]=[],contextGaps=new Set<string>();
  for(const entry of this.entries.values()){
   if(this.controller.signal.aborted)break;
   const bytes=entry.nativeRecords?Buffer.from(entry.nativeRecords.map(r=>JSON.stringify(r)).join('\n')+'\n'):entry.committedBytes;
   if(!bytes?.length){contextGaps.add('native_context_unavailable');continue;}
   const id=entry.conversation.id,binding={...this.cacheBinding(id,entry.file??id,entry.hash,digest(JSON.stringify(entry.fileStat??entry.hash))),scopeHash:digest(JSON.stringify([this.current.scope.eventFrom,this.current.scope.asOf,this.current.scope.harnesses]))};
   const validateUsage=(v:unknown):v is RecordedInference[]=>Array.isArray(v)&&v.every(r=>r&&typeof r==='object'&&typeof r.id==='string'&&r.conversationId===id&&['claude','codex','pi','opencode'].includes(r.harness)&&Array.isArray(r.gaps)&&['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'].every(k=>r[k]===null||Number.isSafeInteger(r[k])&&r[k]>=0));
   let usage=this.derived?.read('native-usage',binding,validateUsage)??null;
   if(!usage){usage=extractNativeUsage(bytes,entry.conversation.harness,id,{project:entry.project,maxRecords:this.limits.records,acceptRecord:(_record,scope)=>this.launchAllowed(scope.project)&&(!this.current.scope.eventFrom||scope.eventAt!==null&&scope.eventAt>=this.current.scope.eventFrom)&&(!this.current.scope.asOf||scope.eventAt!==null&&scope.eventAt<=this.current.scope.asOf)});try{if(this.fresh())this.derived?.write('native-usage',binding,usage,validateUsage);}catch{contextGaps.add('derived_cache_unavailable');}}
   records.push(...usage);
   const eligible=new Map<string,{id:string;route:AuditEvidenceRoute}>();for(const [key,id] of entry.nativeKeys??[]){const prompt=entry.prompts.find(p=>p.id===id);if(prompt?.eligibleHuman)eligible.set(key,{id,route:prompt.route});}
   for(const prompt of entry.prompts){if(!prompt.eligibleHuman)continue;const value={id:prompt.id,route:prompt.route};eligible.set(prompt.identityBasis,value);if(prompt.route.basis==='transient_snapshot'){if(prompt.route.recordKey)eligible.set(prompt.route.recordKey,value);if(prompt.route.rawStart!==null)eligible.set(String(prompt.route.rawStart),value);}else if(prompt.route.basis==='projection_snapshot')eligible.set(prompt.identityBasis.replace(/^message:/,''),value);}
   const parsed=parseContextualNative({bytes,harness:entry.conversation.harness,conversationId:id,parentId:entry.conversation.parentId,project:entry.project,allowRecord:project=>this.launchAllowed(project),eligiblePrompts:eligible,maxBytes:this.limits.source,maxRecords:this.limits.records});contexts.push(...parsed.records);for(const gap of parsed.gaps)contextGaps.add(gap);
  }
  const facts=aggregateLaunchFacts(records,this.catalog??undefined);const known=(fields:readonly (keyof RecordedInference)[]):number|null=>{const values=records.flatMap(r=>fields.map(k=>r[k])).filter((n):n is number=>typeof n==='number');return values.length?values.reduce((a,b)=>a+b,0):null;};this.update({usage:{state:records.length?facts.gaps.length?'partial':'observed':'unavailable',inputTokens:known(['inputTokens']),outputTokens:known(['outputTokens']),cacheTokens:known(['cacheReadTokens','cacheWriteTokens']),reasoningTokens:known(['reasoningTokens']),costUsd:facts.valueUsd,measurementBasis:'recorded_native_response_usage_current_catalog',inclusion:'Native cache and reasoning inclusion normalized per host; unknown records excluded from known totals',priceVersion:facts.pricing.sha256}});
  this.update({sources:this.current.sources.map(source=>{const rows=records.filter(r=>r.harness===source.harness);return {...source,usage:rows.length?rows.some(r=>r.inputTokens===null||r.outputTokens===null)?'partial' as const:'reported' as const:'unavailable' as const};})});
  this.launchPublish({facts,languageByModel:attributeDirectLanguage(this.current.profanity,contexts),stage:'preparing'});
  const segmented=segmentContext(contexts,{gaps:[...contextGaps]});this.launchSegments=segmented.segments;const sourceVersion=this.current.commitment??digest(JSON.stringify(this.epochs));
  const cacheBase=this.cacheBinding('semantic-job','selected-context',sourceVersion,digest(JSON.stringify(this.epochs??'no-store')));
  let provider:FreeJevProvider|undefined;
  // OpenCode's official zero-cost model loader uses this public credential.
  // It carries no account secret and has no paid fallback.
  if(!this.options.launchPrepareOnly&&process.env['POTSHERD_OFFLINE']!=='1')provider=new FreeJevProvider({route:{kind:'zen-public'},cache:{get:key=>{const saved=this.derived?.read('semantic-answer',{...cacheBase,sourceId:key,questionVersion:LAUNCH_QUESTION_VERSION,model:FREE_JEV_MODEL,segmentationVersion:CONTEXT_SEGMENTATION_VERSION},(v):v is {model:string;answers:{id:string;answer:unknown}[];usage:FreeJevResponse['usage']}=>v!==null&&typeof v==='object'&&'model' in v&&typeof v.model==='string'&&'answers' in v&&Array.isArray(v.answers)&&v.answers.every(a=>a&&typeof a.id==='string'&&a.answer&&typeof a.answer==='object')&&'usage' in v);return saved?{...saved,answers:Object.fromEntries(saved.answers.map(a=>[a.id,a.answer]))}:null;},set:(key,value)=>{if(this.fresh())this.derived?.write('semantic-answer',{...cacheBase,sourceId:key,questionVersion:LAUNCH_QUESTION_VERSION,model:FREE_JEV_MODEL,segmentationVersion:CONTEXT_SEGMENTATION_VERSION},{...value,answers:Object.entries(value.answers).map(([id,answer])=>({id,answer}))},(v):v is {answers:unknown[]}=>v!==null&&typeof v==='object'&&'answers' in v&&Array.isArray(v.answers));}}});
  this.launchPublish({stage:'analyzing'});
  const semantics=await runLaunchSemantics({segments:segmented.segments,period,tokenLimit:Math.max(0,100000-this.semanticReservedTokens),gaps:segmented.gaps,preparationMs:0,tone:this.options.tone,until:this.current.scope.asOf??new Date().toISOString(),provider,isCurrent:()=>this.fresh(true),privacyVersion:cacheBase.privacyPolicy,sourceVersion,signal:this.controller.signal});
  if(this.options.launchPrepareOnly||process.env['POTSHERD_OFFLINE']==='1')semantics.gaps=[...semantics.gaps.filter(g=>g!=='free_access_unverified'),this.options.launchPrepareOnly?'developer_prepare_only':'offline_requested'];this.semanticReservedTokens+=semantics.reservedTokens??0;if(this.options.tone)semantics.tone=this.options.tone;
  this.launchPublish({semantics,stage:'assembling'});this.launchPublish({stage:'ready'});
 }
 private async primary(file:string,harness:'claude'|'codex'|'pi',canonical?:{revisionId:string;refs:Map<number,AuditEvidenceRoute>;hash:string;nativeId:string;parent:string|null}):Promise<void>{
  const stat=fs.statSync(file,{bigint:true}),stamp=digest([stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':'));
  const pointerBinding=this.cacheBinding(digest(file),file,'file-pointer-v1',stamp);
  const validPointer=(v:unknown):v is {artifactHash:string}=>v!==null&&typeof v==='object'&&'artifactHash' in v&&typeof v.artifactHash==='string'&&/^[a-f0-9]{64}$/.test(v.artifactHash);
  const pointer=this.derived?.read('file-pointer',pointerBinding,validPointer)??null;
  if(pointer&&(this.current.scope.eventFrom||this.current.scope.asOf)){
   const binding=this.cacheBinding(digest(file),file,pointer.artifactHash,stamp),index=this.derived?.read('date-index',binding,validateHistoryDateIndex)??null;
   if(!historyMayOverlap(index,binding,this.current.scope.eventFrom,this.current.scope.asOf))return;
  }
  const bytes=boundedBytes(file,Math.min(this.limits.source,this.limits.total-this.totalBytes));this.totalBytes+=bytes.length;
  if(this.derived){const binding=this.cacheBinding(digest(file),file,digest(bytes),stamp);const index=indexHistoryBytes(bytes,harness,binding,{maxRecords:this.limits.records});try{if(this.fresh()){this.derived.write('date-index',binding,index,validateHistoryDateIndex);this.derived.write('file-pointer',pointerBinding,{artifactHash:digest(bytes)},validPointer);}}catch{this.gap('derived_cache_unavailable');}}
  const facts=await nativeFacts(file,harness,bytes,this.limits.records);
  if(canonical){facts.nativeId=canonical.nativeId;facts.parent=canonical.parent;facts.child=canonical.parent!==null;if(facts.child)for(const event of facts.events){event.eligible=false;event.excluded='child_initialization';}}
  if(canonical&&facts.hash!==canonical.hash)throw new Error('retained_artifact_hash_mismatch');
  if(harness!=='pi'){
   const evidence=await collectEvidence(file,harness,0,{snapshot:facts.bytes,readCurrent:()=>boundedBytes(file,this.limits.source)});
   for(const key of Object.keys(evidence.unknownTypes))if(!facts.gaps.includes(key))facts.gaps.push('record_coverage_partial');
  }
  const current=boundedBytes(file,this.limits.source);if(digest(current)!==digest(bytes))throw new Error('source_changed');
  this.add(harness,facts,file,digest(bytes),canonical);
 }
 private async canonical():Promise<void>{
  if(!this.db)return;const db=this.db,scope=this.memoryScope(),filter=scopeSql(scope);const harnesses=this.current.scope.harnesses;
  const rows=db.prepare(`SELECT s.source_id,s.native_session_id,s.harness,s.project,s.active_revision_id,(SELECT parent.native_session_id FROM source_relations rel JOIN memory_sources parent ON parent.source_id=rel.from_source_id WHERE rel.to_source_id=s.source_id AND rel.evidence_revision_id=s.active_revision_id AND rel.kind='spawn' LIMIT 1) parent_native_id FROM memory_sources s JOIN source_revisions r ON r.revision_id=s.active_revision_id WHERE s.harness IN (${harnesses.map(()=>'?').join(',')||'NULL'}) AND EXISTS(SELECT 1 FROM revision_units ru JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ru.revision_id=r.revision_id AND ${filter.sql}) ORDER BY s.source_id LIMIT ?`).all(...harnesses,...filter.params,this.limits.candidates+1) as {source_id:string;native_session_id:string;harness:AuditHarness;project:string|null;active_revision_id:string;parent_native_id:string|null}[];
  if(rows.length>this.limits.candidates){this.omitted++;this.gap('candidate_limit');}
  const coverageBinding=this.cacheBinding('canonical-coverage',this.root,this.storeSnapshot!.hash,digest(JSON.stringify([this.storeSnapshot!.hash,this.current.scope.eventFrom,this.current.scope.asOf,this.current.scope.harnesses])));
  const validateCoverage=(v:unknown):v is ReturnType<typeof inspectCoverage>=>v!==null&&typeof v==='object'&&'omittedKinds' in v&&Array.isArray(v.omittedKinds)&&v.omittedKinds.every(g=>typeof g==='string');
  const cachedCoverage=this.derived?.read('source-coverage',coverageBinding,validateCoverage);
  const coverage=cachedCoverage??inspectCoverage(db,scope,'disabled',{harnesses:[...harnesses]});if(!cachedCoverage&&this.derived){try{if(this.fresh())this.derived.write('source-coverage',coverageBinding,coverage,validateCoverage);}catch{this.gap('derived_cache_unavailable');}}for(const gap of coverage.omittedKinds)this.gap(gap);
  for(const row of rows.slice(0,this.limits.candidates)){
   if(this.controller.signal.aborted)break;if(this.denied(row.source_id,row.project))continue;this.sourceCandidate(row.harness);
   const revision=getSourceRevision(db,row.source_id,row.active_revision_id);if(!revision)continue;
   const unitRows=db.prepare(`SELECT u.unit_key,u.text,u.event_at,u.project,u.normalization_version,u.locator_json,(SELECT rs.span_id FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id WHERE rs.revision_id=r.revision_id AND p.unit_revision_id=u.unit_revision_id ORDER BY p.start_utf16 LIMIT 1) span_id FROM revision_units ru JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id JOIN source_revisions r ON r.revision_id=ru.revision_id JOIN memory_sources s ON s.source_id=r.source_id WHERE r.revision_id=? AND u.role IN ('user','ghost_prompt') AND length(CAST(u.text AS BLOB))<=? AND ${filter.sql} ORDER BY ru.ordinal LIMIT ?`).iterate(row.active_revision_id,this.limits.source,...filter.params,this.limits.records+1) as IterableIterator<Record<string,unknown>>;
   const boundedUnits:Record<string,unknown>[]=[];let unitBytes=0;
   for(const unit of unitRows){if(boundedUnits.length>=this.limits.records){this.gap('source_records_limit',row.harness);break;}const length=Buffer.byteLength(String(unit.text));if(unitBytes+length+this.totalBytes>this.limits.total){this.gap('total_bytes_limit',row.harness);break;}unitBytes+=length;boundedUnits.push(unit);}
   const refs=new Map<number,AuditEvidenceRoute>();const events:NativeEvent[]=[];let retainedBytes=0;
   for(const [unitIndex,unit] of boundedUnits.entries()){
    const text=String(unit.text);retainedBytes+=Buffer.byteLength(text);if(retainedBytes+this.totalBytes>this.limits.total){this.gap('total_bytes_limit');break;}
    if(requiresPrivacyRefresh(text,String(unit.normalization_version))){this.gap('privacy_refresh_required');continue;}
    const locator=JSON.parse(String(unit.locator_json)) as Record<string,unknown>;const start=typeof locator.rawStart==='number'?locator.rawStart:-(unitIndex+1);
    const route:AuditEvidenceRoute={basis:'canonical',refs:unit.span_id?[{sourceId:row.source_id,revisionId:row.active_revision_id,spanId:String(unit.span_id)}]:[],scope:{...scope,sourceIds:[row.source_id]}};if(route.refs.length)refs.set(start,route);
    events.push({key:String(unit.unit_key),rawStart:start,rawEnd:typeof locator.rawEnd==='number'?locator.rawEnd:-1,role:'user',text,eventAt:clock(unit.event_at),project:typeof unit.project==='string'?unit.project:null,origin:'unknown',eligible:false,excluded:row.parent_native_id?'child_initialization':'human_origin_unavailable',identity:String(unit.unit_key)});
   }
   if(revision.archiveRelativePath&&revision.artifactBasis==='raw_prefix'&&(row.harness==='claude'||row.harness==='codex')){
    const file=path.resolve(this.root,revision.archiveRelativePath);if(file.startsWith(this.root+path.sep))try{await this.primary(file,row.harness,{revisionId:row.active_revision_id,refs,hash:revision.artifactHash,nativeId:row.native_session_id,parent:row.parent_native_id});this.emit('parsing');await pause();continue;}catch{this.gap('canonical_origin_unavailable',row.harness);}
   }
   this.totalBytes+=retainedBytes;const facts:NativeFacts={nativeId:row.native_session_id,project:row.project,parent:row.parent_native_id,child:row.parent_native_id!==null,title:null,events,gaps:['human_origin_unavailable'],hash:revision.artifactHash,consumed:0,bytes:Buffer.alloc(0)};
   this.add(row.harness,facts,'','', {revisionId:row.active_revision_id,refs});const entry=this.entries.get(row.source_id);if(entry){entry.file=null;entry.fileHash=null;entry.committedBytes=undefined;}
   this.emit('parsing');await pause();
  }
 }
 async run(onEvent?: (event:AuditEvent)=>void):Promise<AuditSnapshot>{
  this.assertOpen();if(this.started)throw new Error('audit_session_already_run');this.started=true;this.callback=onEvent;
  this.emit('discovering');this.policy();if(this.options.launch&&!this.options.launchPrepareOnly&&this.catalog)void refreshPublicCatalog(this.derived,this.catalog,this.controller.signal);if(this.policyAvailable)await this.canonical();
  if(this.policyAvailable)for(const harness of this.current.scope.harnesses){
   if(this.controller.signal.aborted)break;const roots=harness==='claude'?[path.join(paths.claudeDir(this.options.claudeDir),'projects')]:harness==='codex'?[paths.codexPaths(paths.codexDir(this.options.codexDir)).sessions,paths.codexPaths(paths.codexDir(this.options.codexDir)).archived]:harness==='pi'?[paths.piSessionsDir(this.options.piDir)]:[paths.opencodeDir(this.options.opencodeDir)];
   for(const root of roots){try{for await(const file of walk(root,this.limits.candidates*32,this.controller.signal,harness==='opencode'?3:8)){
    if(this.controller.signal.aborted)break;const isDatabase=harness==='opencode';if(isDatabase?!/\.(db|sqlite|sqlite3)$/i.test(file):!file.endsWith('.jsonl'))continue;
    if(this.candidates>=this.limits.candidates){this.omitted++;this.gap('candidate_limit',harness);break;}
    if(this.totalBytes>=this.limits.total){this.omitted++;this.gap('total_bytes_limit',harness);break;}
    if(harness==='opencode')this.update({sources:this.current.sources.map(s=>s.harness===harness?{...s,candidateFiles:s.candidateFiles+1,state:'available'}:s)});else this.sourceCandidate(harness);this.emit('parsing');
    try{if(harness==='opencode')await this.openCode(file);else await this.primary(file,harness);}catch(error){this.omitted++;this.gap(error instanceof Error&&(['source_bytes_limit','source_changed'].includes(error.message)||error.message.startsWith('audit_sqlite_'))?error.message:'source_unreadable',harness);}
    this.emit('parsing');await pause();
   }}catch(error){this.gap(error instanceof Error?error.message:'discovery_failed',harness);}}
  }
  if(!this.policyAvailable){this.gap('raw_lane_policy_hold');}
  this.emit(this.controller.signal.aborted?'cancelled':this.gaps.size||this.omitted?'partial':'ready');if(this.options.launch&&!this.controller.signal.aborted&&this.policyAvailable){this.launchRunning=true;try{await this.assembleLaunch();}finally{this.launchRunning=false;}}else if(this.current.launch){this.update({launch:{...this.current.launch,stage:'ready',semantics:{state:this.controller.signal.aborted?'cancelled':'unavailable',recipientNotice:this.current.launch.notice,model:null,window:{selected:null,choices:[],tokenLimit:100000,reason:'Source policy is unavailable; no conversation transfer occurred.'},stories:[],hallOfFame:[],work:[],tone:'elegant',judgments:[],attempts:0,cacheHits:0,inputTokens:0,outputTokens:0,gaps:[...this.gaps]}}});this.callback?.({type:'snapshot',snapshot:this.current});}this.callback=undefined;return this.current;
 }
 private async openCode(file:string):Promise<void>{
  boundedBytes(file,this.limits.source);const discovered=openSessions(file,Math.max(1,this.limits.candidates-this.candidates),this.limits.source);if('gap' in discovered){this.candidates++;this.gap(discovered.gap,'opencode');return;}if(discovered.more)this.gap('candidate_limit','opencode');
  for(const row of discovered.sessions){if(this.controller.signal.aborted)break;if(this.candidates>=this.limits.candidates){this.omitted++;this.gap('candidate_limit','opencode');break;}const id=sourceId('opencode',row.id);if(this.entries.has(id)||this.denied(id,row.project))continue;this.sourceCandidate('opencode',false);const maxBytes=Math.min(this.limits.source,this.limits.total-this.totalBytes);const snapshot=openPrompts(discovered.schema,row.id,this.limits.records,maxBytes,this.limits.source);this.totalBytes+=snapshot.bytes;
   const events:NativeEvent[]=snapshot.prompts.map(p=>({key:p.key,rawStart:p.seq,rawEnd:p.seq,role:'user',text:p.text,eventAt:p.time,project:row.project,origin:'unknown',eligible:false,excluded:'projection_origin_unverified',identity:`message:${p.key}`}));
   const facts:NativeFacts={nativeId:row.id,project:row.project,parent:row.parent,child:row.parent!==null,title:row.title,events,gaps:snapshot.gaps,hash:snapshot.hash,consumed:0,bytes:Buffer.alloc(0)};this.add('opencode',facts,file,'');const entry=this.entries.get(id);if(entry){entry.open={schema:discovered.schema,id:row.id,maxBytes,assertCurrent:discovered.assertCurrent,assertIdentityCurrent:discovered.assertIdentityCurrent};entry.committedBytes=undefined;entry.fileHash=null;entry.nativeRecords=snapshot.nativeRecords.map(record=>({...record,cwd:row.project}));entry.prompts=entry.prompts.map((p,i)=>{this.routes.delete(routeKey(p.route));const route:AuditEvidenceRoute={basis:'projection_snapshot',sourceId:id,artifactHash:snapshot.hash,sourcePath:file,nativeSessionId:row.id,seq:p.route.basis==='transient_snapshot'&&p.route.rawStart!==null?p.route.rawStart:i+1,snapshotId:this.id,fidelity:'exchange_projection'};const prompt={...p,originBasis:'opencode_user_projection' as const,route};this.routes.set(routeKey(route),prompt);return prompt;});}
  }
 }
 async previewLaunch(){this.assertOpen();if(!this.options.launchPrepareOnly||!this.fresh(true))throw new Error('launch_preview_unavailable');const semantic=this.current.launch?.semantics,selected=semantic?.window.selected;const segments=selected?selectedSegments(semantic!.window,this.launchSegments):[];const requests=segments.map(segment=>{const request=buildLaunchRequest(segment),serialized=JSON.stringify(request);return {segmentId:segment.id,hash:digest(serialized),bytes:Buffer.byteLength(serialized),request};});if(!this.fresh(true))throw new Error('audit_snapshot_stale');return {scope:this.current.scope,sourceVersion:this.current.commitment??digest(JSON.stringify(this.epochs)),privacyVersion:digest(JSON.stringify([this.policyCommitment,this.current.scope.project,this.ignored])),model:FREE_JEV_MODEL,window:semantic?.window??null,requests};}
 async analyzePeriod(period:SemanticPeriod,onEvent?:(event:AuditEvent)=>void):Promise<AuditSnapshot>{this.assertOpen();if(!this.options.launch||!this.started||this.launchRunning||!['all',45,30,7,3].includes(period))throw new Error('semantic_period_unavailable');if(!this.fresh()){this.invalidate();throw new Error('audit_snapshot_stale');}this.launchRunning=true;this.callback=onEvent;try{await this.assembleLaunch(period);return this.current;}finally{this.launchRunning=false;this.callback=undefined;}}
 async prompts(conversationId:string,offset=0,limit=20){this.assertOpen();if(!this.fresh()){this.invalidate();throw new Error('audit_snapshot_stale');}if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('invalid audit pagination');const entry=this.entries.get(conversationId);if(!entry)throw new Error('audit_conversation_unavailable');const page=immutable({snapshotId:this.id,conversationId,prompts:entry.prompts.slice(offset,offset+limit),offset,total:entry.prompts.length,nextOffset:offset+limit<entry.prompts.length?offset+limit:null,coverage:entry.conversation.coverage});if(!this.fresh()){this.invalidate();throw new Error('audit_snapshot_stale');}return page;}
 async evidence(route:AuditEvidenceRoute):Promise<AuditEvidence>{
  this.assertOpen();const unavailable=(state:'stale'|'unavailable',code:string):AuditEvidence=>immutable({state,text:null,role:null,eventAt:null,route,gapCodes:[code]});if(this.stale)return unavailable('stale','audit_snapshot_stale');const prompt=this.routes.get(routeKey(route));if(!prompt)return unavailable('unavailable','unknown_evidence_route');
  if(!this.fresh(true)){this.invalidate();return unavailable('stale','source_or_policy_changed');}
  if(route.basis==='canonical'){
   if(!this.db)return unavailable('unavailable','canonical_store_unavailable');const service=new LocalMemoryService(this.db,{root:this.root,semanticDisabled:true});const result=service.read({refs:[...route.refs],scope:route.scope,budget:{...defaultBudget(),maxBytes:32768}}).response as MemoryResponse;const item=result.evidence?.[0];if(!item)return unavailable('unavailable',result.warnings?.[0]??'canonical_evidence_unavailable');if(!this.fresh(true)){this.invalidate();return unavailable('stale','source_or_policy_changed');}return immutable({state:'available',text:item.text,role:item.role,eventAt:item.sourceEventAt,route,gapCodes:result.coverage.omittedKinds});
  }
  if(route.snapshotId!==this.id)return unavailable('stale','snapshot_changed');const entry=this.entries.get(prompt.conversationId);if(!entry?.file)return unavailable('unavailable','source_unavailable');
  try{if(entry.open){const current=openPrompts(entry.open.schema,entry.open.id,this.limits.records,entry.open.maxBytes,this.limits.source);if(current.hash!==entry.hash)return unavailable('stale','source_changed');}else if(digest(boundedBytes(entry.file,this.limits.source))!==entry.fileHash)return unavailable('stale','source_changed');}
  catch{return unavailable('unavailable','source_missing_or_unreadable');}
  if(!this.fresh(true)){this.invalidate();return unavailable('stale','source_or_policy_changed');}return immutable({state:'available',text:prompt.text,role:prompt.role,eventAt:prompt.eventAt,route,gapCodes:entry.conversation.coverage.gapCodes});
 }
 private semanticInputs(ids:readonly string[]):SemanticConversationInput[]{return ids.map(id=>{const entry=this.entries.get(id);if(!entry)throw new Error('audit_conversation_unavailable');return {id,sourceVersion:entry.hash,prompts:entry.prompts};});}
 private semanticCurrent(ids:readonly string[]):boolean{
  if(!this.fresh(true)){this.invalidate();return false;}
  try{for(const id of ids){const entry=this.entries.get(id);if(!entry)throw new Error('source unavailable');entry.open?.assertCurrent();if(entry.file&&entry.fileHash!==null&&digest(boundedBytes(entry.file,this.limits.source))!==entry.fileHash)throw new Error('source changed');}return true;}catch{this.invalidate();return false;}
 }
 async preview(selection:Omit<AuditSemanticSelection,'consent'>):Promise<AuditSemanticPreview>{this.assertOpen();if(!this.semanticCurrent(selection.conversationIds))throw new Error('audit_snapshot_stale');const result=this.semanticRunner.preview(this.current,selection,this.semanticInputs(selection.conversationIds));if(!this.semanticCurrent(selection.conversationIds))throw new Error('audit_snapshot_stale');return immutable(result);}
 async classify(selection:AuditSemanticSelection,onEvent?: (event:AuditEvent)=>void):Promise<AuditSnapshot>{
  this.assertOpen();if(selection.consent!==true)throw new Error('semantic_consent_required');if(!this.semanticCurrent(selection.conversationIds))throw new Error('audit_snapshot_stale');const signal=selection.signal?AbortSignal.any([this.controller.signal,selection.signal]):this.controller.signal;
  const update=(semantics:AuditSemantics,judgments:readonly AuditPromptJudgment[],gaps:readonly string[])=>{if(!this.semanticCurrent(selection.conversationIds))return;this.update({sequence:++this.sequence,semantics,judgments,warnings:[...new Set([...this.current.warnings,...gaps])]});onEvent?.({type:'snapshot',snapshot:this.current});};
  const result=await this.semanticRunner.classify(this.current,{...selection,signal},this.semanticInputs(selection.conversationIds),()=>this.semanticCurrent(selection.conversationIds),update);if(this.semanticCurrent(selection.conversationIds))update(result.semantics,result.judgments,result.gaps);else{this.update({sequence:++this.sequence,semantics:{...this.current.semantics,state:'cancelled',requestCount:result.semantics.requestCount,cacheHits:result.semantics.cacheHits,estimatedCostUsd:result.semantics.estimatedCostUsd,reportedCostUsd:result.semantics.reportedCostUsd,unresolvedCostUsd:result.semantics.unresolvedCostUsd,errorCode:'source_or_policy_changed'}});onEvent?.({type:'snapshot',snapshot:this.current});}return this.current;
 }
}
