import {clean,digest} from './source.js';
import {NORMALIZATION_VERSION} from '../memory/privacy.js';
import {JEV_MODEL,JEV_QUESTION_VERSION,JEV_ATTEMPT_RESERVATION_USD} from './jev-contract.js';
import {JevProvider,jevKeyFromEnvironment,type JevJob,type JevCacheIdentity} from './jev-provider.js';
import {promptQuestionRequest,primaryIntent} from './jev-questions.js';
import {AUDIT_INTENTS,type AuditPrompt,type AuditPromptJudgment,type AuditSemanticSelection,type AuditSemanticPreview,type AuditSemanticPreparedRequest,type AuditSemantics,type AuditSnapshot} from './contracts.js';

export interface SemanticConversationInput {id:string;sourceVersion:string;prompts:readonly AuditPrompt[];}
type Selection=Omit<AuditSemanticSelection,'consent'>;
interface Prepared {prompt:AuditPrompt;sourceVersion:string;request:ReturnType<typeof promptQuestionRequest>;windowCoverage:'partial'|'truncated';contentHash:string;}
const isEligible=(p:AuditPrompt)=>p.eligibleHuman&&p.excludedReason===null&&['claude_prompt_id','codex_human_marker'].includes(p.originBasis);
function prefix(text:string,maxBytes:number):{text:string;truncated:boolean}{let bytes=0,end=0;for(const char of text){const n=Buffer.byteLength(char);if(bytes+n>maxBytes)break;bytes+=n;end+=char.length;}return {text:text.slice(0,end),truncated:end<text.length};}
function validate(selection:Selection):void{
 if(!Array.isArray(selection.conversationIds)||!selection.conversationIds.length||selection.conversationIds.length>20||selection.conversationIds.some(id=>typeof id!=='string'||!id)||new Set(selection.conversationIds).size!==selection.conversationIds.length)throw new Error('invalid semantic conversations');
 if(!Number.isSafeInteger(selection.maxPrompts)||selection.maxPrompts<1||selection.maxPrompts>200||!Number.isSafeInteger(selection.maxRequests)||selection.maxRequests<0||selection.maxRequests>50||!Number.isFinite(selection.budgetUsd)||selection.budgetUsd<0||selection.budgetUsd>10)throw new Error('invalid semantic bounds');
 if(selection.confidenceThreshold!==undefined&&(!Number.isFinite(selection.confidenceThreshold)||selection.confidenceThreshold<0||selection.confidenceThreshold>1))throw new Error('invalid semantic threshold');
}
function prepare(selection:Selection,conversations:readonly SemanticConversationInput[]):{prepared:Prepared[];eligible:number;gapCodes:string[]}{
 validate(selection);const byId=new Map(conversations.map(c=>[c.id,c])),prepared:Prepared[]=[];let eligible=0;const gaps=new Set<string>(['assistant_context_unavailable','semantic_gold_unavailable']);
 for(const id of selection.conversationIds){const conversation=byId.get(id);if(!conversation)throw new Error('audit_conversation_unavailable');const native=conversation.prompts.filter(isEligible);eligible+=native.length;
  for(let i=0;i<native.length;i++){
   if(prepared.length>=selection.maxPrompts){gaps.add('semantic_selection_bounded');continue;}
   const prompt=native[i]!,target=prefix(clean(prompt.text),3500),preceding=native.slice(Math.max(0,i-2),i).map(p=>prefix(clean(p.text),768));
   const state={target:{role:'user' as const,text:target.text},precedingUser:preceding.map(p=>({role:'user' as const,text:p.text})),assistantContext:'unavailable' as const};
   try{const request=promptQuestionRequest(state);prepared.push({prompt,sourceVersion:conversation.sourceVersion,request,windowCoverage:target.truncated||preceding.some(p=>p.truncated)?'truncated':'partial',contentHash:digest(JSON.stringify({sourceText:prompt.text,sentState:state}))});}
   catch{gaps.add('semantic_request_bytes_limit');}
  }
 }
 return {prepared,eligible,gapCodes:[...gaps]};
}
const semantics=(state:AuditSemantics['state'],eligible:number,errorCode:string|null=null):AuditSemantics=>({state,qualified:false,model:JEV_MODEL,classifiedPrompts:0,eligiblePrompts:eligible,uncertainPrompts:eligible,unclassifiedPrompts:eligible,work:[],requestCount:0,cacheHits:0,estimatedCostUsd:0,reportedCostUsd:0,unresolvedCostUsd:0,errorCode});

/** Local display policy only: preserves provider costs/raw evidence and never makes a request. */
export function composeJevJudgments(judgments:readonly AuditPromptJudgment[],base:AuditSemantics,confidenceThreshold=0.65):{judgments:AuditPromptJudgment[];semantics:AuditSemantics}{
 const recomposed=judgments.map(j=>{const decision=primaryIntent(j.answers.primary_intent,confidenceThreshold);return {...j,primaryIntent:j.windowCoverage==='truncated'?null:decision.intent,abstained:j.windowCoverage==='truncated'||decision.abstained};}),accepted=recomposed.filter(j=>!j.abstained&&j.primaryIntent!==null),denominator=base.eligiblePrompts;
 const work=AUDIT_INTENTS.map(label=>({label,count:accepted.filter(j=>j.primaryIntent===label).length,denominator,state:'partial' as const})).filter(bar=>bar.count>0);
 return {judgments:recomposed,semantics:{...base,qualified:false,classifiedPrompts:accepted.length,unclassifiedPrompts:Math.max(0,denominator-accepted.length),uncertainPrompts:Math.max(0,denominator-accepted.length),work}};
}

export class JevSessionRunner {
 private provider:JevProvider|null=null;private keyHash:string|null=null;private job:JevJob|null=null;private busy=false;
 preview(snapshot:AuditSnapshot,selection:Selection,conversations:readonly SemanticConversationInput[]):AuditSemanticPreview{
  const selected=prepare(selection,conversations),scopeHash=digest(JSON.stringify({scope:snapshot.scope,conversationIds:selection.conversationIds}));
  const preparedRequests:AuditSemanticPreparedRequest[]=selected.prepared.map(input=>({promptId:input.prompt.id,conversationId:input.prompt.conversationId,sourceRoute:input.prompt.route,sourceVersion:input.sourceVersion,contentHash:input.contentHash,scopeHash,normalizationVersion:NORMALIZATION_VERSION,questionVersion:JEV_QUESTION_VERSION,windowCoverage:input.windowCoverage,requestHash:digest(JSON.stringify(input.request)),requestBytes:Buffer.byteLength(JSON.stringify(input.request)),request:structuredClone(input.request) as unknown as AuditSemanticPreparedRequest['request']}));
  return {snapshotId:snapshot.snapshotId,model:JEV_MODEL,selectedConversations:selection.conversationIds.length,eligiblePrompts:selected.eligible,selectedPrompts:selected.prepared.length,maxRequests:selection.maxRequests,budgetUsd:selection.budgetUsd,estimatedReservationUsd:Math.min(selection.maxRequests,selected.prepared.length*2)*JEV_ATTEMPT_RESERVATION_USD,keyAvailable:jevKeyFromEnvironment()!==null,outgoingFields:['target.role','target.text (redacted prefix, max3500 UTF-8 bytes)','precedingUser[].role','precedingUser[].text (at most2 redacted prefixes, max768 bytes each)','assistantContext:unavailable'],windowCoverage:selected.prepared.some(p=>p.windowCoverage==='truncated')?'truncated':'partial',samples:selected.prepared.slice(0,3).map(p=>({promptId:p.prompt.id,excerpt:prefix(p.request.state&&typeof p.request.state==='object'&&!Array.isArray(p.request.state)?String((p.request.state as any).target.text):'',160).text})),gapCodes:[...selected.gapCodes,'reservation_is_estimate_not_invoice_cap'],preparedRequests};
 }
 invalidate():void{this.job?.cancel();this.provider?.clearCache();}
 dispose():void{this.invalidate();this.provider=null;this.keyHash=null;}
 async classify(snapshot:AuditSnapshot,selection:AuditSemanticSelection,conversations:readonly SemanticConversationInput[],isCurrent:()=>boolean,onUpdate:(semantics:AuditSemantics,judgments:readonly AuditPromptJudgment[],gaps:readonly string[])=>void):Promise<{semantics:AuditSemantics;judgments:AuditPromptJudgment[];gaps:string[]}>{
  if(selection.consent!==true)throw new Error('semantic_consent_required');if(this.busy)throw new Error('semantic_job_running');const selected=prepare(selection,conversations),denominator=selected.eligible;const key=jevKeyFromEnvironment();
  if(!key)return {semantics:{...semantics('no_key',denominator),model:null,estimatedCostUsd:null,reportedCostUsd:null,unresolvedCostUsd:null},judgments:[],gaps:selected.gapCodes};
  if(!isCurrent())throw new Error('audit_snapshot_stale');this.busy=true;const signature=digest(key);if(!this.provider||signature!==this.keyHash){this.provider?.clearCache();this.provider=new JevProvider({apiKey:key});this.keyHash=signature;}
  const scopeHash=digest(JSON.stringify({scope:snapshot.scope,conversationIds:selection.conversationIds})),judgments:AuditPromptJudgment[]=[];let errorCode:string|null=null;let skipped=0;
  const job=this.provider.beginJob({consent:true,maxRequests:selection.maxRequests,budgetUsd:selection.budgetUsd,signal:selection.signal,isCurrent});this.job=job;
  const summarize=(state:AuditSemantics['state']):AuditSemantics=>composeJevJudgments(judgments,{...semantics(state,denominator,errorCode),...job.stats()},selection.confidenceThreshold??0.65).semantics;
  onUpdate(summarize('running'),[],selected.gapCodes);
  try{
   await Promise.all(selected.prepared.map(async input=>{
    const identity:JevCacheIdentity={contentHash:input.contentHash,scopeHash,privacyVersion:'audit-private-selection-v1',normalizationVersion:NORMALIZATION_VERSION,questionVersion:JEV_QUESTION_VERSION,sourceVersion:input.sourceVersion,segmentationVersion:'target-prefix3500-prior-user2-prefix768-v1'};
    const result=await job.evaluate(input.request,identity);if(!isCurrent()){this.invalidate();errorCode='privacy_changed';return;}
    if(result.state==='ok'){const decision=primaryIntent(result.response.answers.primary_intent,selection.confidenceThreshold??0.65);judgments.push({promptId:input.prompt.id,conversationId:input.prompt.conversationId,sourceRoute:input.prompt.route,contentHash:input.contentHash,scopeHash,normalizationVersion:NORMALIZATION_VERSION,questionVersion:JEV_QUESTION_VERSION,questionDefinitions:input.request.questions,model:result.response.model,answers:result.response.answers,windowCoverage:input.windowCoverage,primaryIntent:input.windowCoverage==='truncated'?null:decision.intent,abstained:input.windowCoverage==='truncated'||decision.abstained});}
    else{skipped++;errorCode=result.code;}
    onUpdate(summarize('running'),judgments,selected.gapCodes);
   }));
   const state:AuditSemantics['state']=job.signal.aborted?'cancelled':skipped||selected.prepared.length<selected.eligible||selected.gapCodes.includes('semantic_request_bytes_limit')?'partial':'complete';
   return {semantics:summarize(state),judgments:judgments.sort((a,b)=>a.promptId.localeCompare(b.promptId)),gaps:selected.gapCodes};
  }finally{job.dispose();this.job=null;this.busy=false;}
 }
}
