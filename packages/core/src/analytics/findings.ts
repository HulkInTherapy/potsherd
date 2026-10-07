import {digest} from './source.js';
import type {AuditConversation,AuditEvidenceRoute,AuditInsight,AuditPhrase,AuditPrompt} from './contracts.js';

export const EXACT_REPEAT_LIMITS=Object.freeze({rows:20,supports:8,maxRowBytes:8192});
const inputBasis='exact_redacted_whole_prompt_equality_v1';
const elapsedBasis='eligible_native_input_event_time_range_v1';
const eligible=(prompt:AuditPrompt)=>prompt.eligibleHuman&&prompt.excludedReason===null&&['claude_prompt_id','codex_human_marker'].includes(prompt.originBasis);
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
function duration(ms:number):string{
 const seconds=ms/1000;if(seconds<60)return `${Number(seconds.toFixed(3))}s`;
 const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes}m`;
 const hours=Math.floor(minutes/60);if(hours<24)return `${hours}h ${minutes%60}m`;
 return `${Math.floor(hours/24)}d ${hours%24}h`;
}

/** Final-view arithmetic only: literal equality and recorded clocks, never inferred work. */
export function deterministicFindings(conversations:readonly AuditConversation[],prompts:readonly AuditPrompt[],timezone:string,partial:boolean,scopeHash:string):{insights:AuditInsight[];phrases:AuditPhrase[]}{
 const inputs=prompts.filter(eligible),byConversation=new Map<string,AuditPrompt[]>(),wordings=new Map<string,AuditPrompt[]>();
 for(const prompt of inputs){const group=wordings.get(prompt.text)??[];group.push(prompt);wordings.set(prompt.text,group);const conversation=byConversation.get(prompt.conversationId)??[];conversation.push(prompt);byConversation.set(prompt.conversationId,conversation);}
 const repeated=[...wordings].filter(([,group])=>group.length>=2).sort(([textA,a],[textB,b])=>b.length-a.length||textA.localeCompare(textB));
 const phrases:AuditPhrase[]=repeated.filter(([text])=>Buffer.byteLength(text)<=EXACT_REPEAT_LIMITS.maxRowBytes).slice(0,EXACT_REPEAT_LIMITS.rows).map(([text,group])=>{
  const ordered=[...group].sort((a,b)=>a.conversationId.localeCompare(b.conversationId)||a.id.localeCompare(b.id)),supports:AuditPrompt[]=[];const selected=new Set<string>();
  for(const prompt of ordered){if(supports.length>=EXACT_REPEAT_LIMITS.supports)break;if(!selected.has(prompt.conversationId)){supports.push(prompt);selected.add(prompt.conversationId);}}
  for(const prompt of ordered){if(supports.length>=EXACT_REPEAT_LIMITS.supports)break;if(!supports.some(p=>p.id===prompt.id))supports.push(prompt);}
  return {id:digest(`${scopeHash}:${inputBasis}:${text}`).slice(0,32),text,prompts:group.length,occurrences:group.length,denominator:inputs.length,measurementBasis:inputBasis,conversationIds:[...new Set(supports.map(p=>p.conversationId))],promptIds:supports.map(p=>p.id),evidenceRoutes:supports.map(p=>p.route)};
 });
 const insights:AuditInsight[]=[];let longest:{conversation:AuditConversation;first:AuditPrompt;last:AuditPrompt;ms:number;datesMissing:boolean}|null=null;
 for(const conversation of conversations){const group=byConversation.get(conversation.id)??[],dated=group.filter(p=>p.eventAt!==null&&Number.isFinite(Date.parse(p.eventAt))).sort((a,b)=>a.eventAt!.localeCompare(b.eventAt!)||a.id.localeCompare(b.id));if(dated.length<2)continue;
  const first=dated[0]!,last=dated.at(-1)!,ms=Date.parse(last.eventAt!)-Date.parse(first.eventAt!);if(longest===null||ms>longest.ms||ms===longest.ms&&conversation.id<longest.conversation.id)longest={conversation,first,last,ms,datesMissing:dated.length!==group.length};
 }
 if(longest){const definition='Elapsed span between the first and last dated eligible native inputs in one selected conversation. Original record clocks only; unknown dates excluded. This is an observed input span, not working time or proof of completion.';
  const date=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'short',day:'numeric'});const span=duration(longest.ms),caption=`${longest.conversation.alias}: ${span} observed input span · ${date.format(new Date(longest.first.eventAt!))}–${date.format(new Date(longest.last.eventAt!))}`;
  insights.push({id:'observed-conversation-input-span-v1',basis:'deterministic',caption,publicCaption:`Longest observed input span: ${span}`,value:{value:longest.ms,numerator:longest.ms,denominator:null,unit:'milliseconds_observed_input_span',measurementBasis:elapsedBasis,state:partial||longest.datesMissing?'partial':'observed',definition},conversationIds:[longest.conversation.id],promptIds:[longest.first.id,longest.last.id],definition});
 }
 if(repeated.length){const count=repeated.reduce((n,[,group])=>n+group.length,0),supports=repeated.flatMap(([,group])=>group.slice(0,EXACT_REPEAT_LIMITS.supports)).slice(0,EXACT_REPEAT_LIMITS.supports),definition='Eligible scoped native input events whose entire redacted text equals another eligible event. Equality is exact after existing redaction/elision; case, whitespace and wording are not normalized. All members are counted once; this is not keyword, substring, semantic or personality analysis. Private rows show at most20 groups,8192 UTF-8 bytes each and8 supporting routes.';
  const caption=`${plural(count,'input')} in ${plural(repeated.length,'exact repeat group')} · ${inputs.length} eligible inputs`;
  insights.push({id:'exact-repeated-input-wording-v1',basis:'deterministic',caption,publicCaption:caption,value:{value:count,numerator:count,denominator:inputs.length,unit:'eligible_input_in_exact_repeat_group',measurementBasis:inputBasis,state:partial?'partial':'observed',definition},conversationIds:[...new Set(supports.map(p=>p.conversationId))],promptIds:supports.map(p=>p.id),definition});
 }
 return {insights:insights.slice(0,2),phrases};
}
