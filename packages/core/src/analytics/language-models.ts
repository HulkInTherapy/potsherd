import {hitsOf,languageEligibleInput} from './profanity.js';
import type {AuditProfanity,AuditPrompt} from './contracts.js';
import type {ContextRecord} from './launch-contracts.js';
export interface ModelLanguage {model:string|null;provider:string|null;occurrences:number;containingInputs:number;promptIds:readonly string[];}
function responseAttributions(records:readonly ContextRecord[]):Map<string,{model:string|null;provider:string|null}>{
 const groups=new Map<string,ContextRecord[]>(),seen=new Set<string>();
 for(const record of records){const unique=`${record.conversationId}\0${record.project}\0${record.role}\0${record.id}`;if(seen.has(unique))continue;seen.add(unique);const key=`${record.conversationId}\0${record.project}`;const group=groups.get(key)??[];group.push(record);groups.set(key,group);}
 const attribution=new Map<string,{model:string|null;provider:string|null}>();
 for(const group of groups.values())for(let i=0;i<group.length;i++){const user=group[i]!;if(user.role!=='user'||!user.directUser)continue;const models=new Map<string,{model:string|null;provider:string|null}>();for(let j=i+1;j<group.length;j++){const next=group[j]!;if(next.role==='user')break;if(next.role==='assistant')models.set(JSON.stringify([next.model,next.provider]),{model:next.model,provider:next.provider});}attribution.set(user.id,models.size===1?[...models.values()][0]!:{model:null,provider:null});}
 return attribution;
}
/** Attribute only a direct input's own response turn, never a session-last model. */
export function attributeDirectLanguage(profanity:AuditProfanity|undefined,records:readonly ContextRecord[],prompts?:readonly AuditPrompt[]):ModelLanguage[]{
 const matches=prompts?prompts.filter(languageEligibleInput).flatMap(p=>{const count=hitsOf(p)?.hits.filter(h=>h[1]===0).length??0;return count?[{promptId:p.id,kind:'direct_prose' as const,occurrences:count}]:[];}):(profanity?.matches??[]).filter(m=>m.kind==='direct_prose').map(m=>({...m,occurrences:1})),attribution=responseAttributions(records);
 const result=new Map<string,{model:string|null;provider:string|null;occurrences:number;ids:Set<string>}>();
 for(const match of matches){const owner=attribution.get(match.promptId)??{model:null,provider:null},key=JSON.stringify(owner);let row=result.get(key);if(!row){row={...owner,occurrences:0,ids:new Set()};result.set(key,row);}row.occurrences+=match.occurrences;row.ids.add(match.promptId);}
 return [...result.values()].map(row=>({model:row.model,provider:row.provider,occurrences:row.occurrences,containingInputs:row.ids.size,promptIds:[...row.ids]})).sort((a,b)=>b.occurrences-a.occurrences||(a.model??'').localeCompare(b.model??''));
}

/** Full term counts, independently attributed; sample references never drive totals. */
export function attributeLanguageTerms(profanity:AuditProfanity,records:readonly ContextRecord[],prompts:readonly AuditPrompt[]):AuditProfanity {
 const attribution=responseAttributions(records);const modelRows=new Map<string,Map<string,{provider:string|null;model:string|null;occurrences:number}>>();
 const kinds=['direct_prose','quoted','code','unknown'] as const;
 for(const prompt of prompts){if(!languageEligibleInput(prompt))continue;const found=hitsOf(prompt);if(!found)continue;const grouped=new Map<string,{term:string;kind:typeof kinds[number];occurrences:number}>();for(const [raw,label] of found.hits){const term=raw.toLowerCase(),kind=kinds[label]??'unknown',k=term+'\0'+kind,g=grouped.get(k)??{term,kind,occurrences:0};g.occurrences++;grouped.set(k,g);}const attributed=attribution.get(prompt.id);for(const term of grouped.values()){const key=JSON.stringify([term.term,term.kind]),models=modelRows.get(key)??new Map();const owner=term.kind==='direct_prose'&&attributed?{provider:attributed.provider,model:attributed.model}:{provider:null,model:null},modelKey=JSON.stringify(owner),row=models.get(modelKey)??{...owner,occurrences:0};row.occurrences+=term.occurrences;models.set(modelKey,row);modelRows.set(key,models);}}
 return {...profanity,terms:profanity.terms?.map(term=>({...term,models:[...modelRows.get(JSON.stringify([term.term,term.kind]))?.values()??[]].sort((a,b)=>b.occurrences-a.occurrences)}))};
}
