import {auditProfanity} from './profanity.js';
import type {AuditProfanity,AuditPrompt} from './contracts.js';
import type {ContextRecord} from './launch-contracts.js';
export interface ModelLanguage {model:string|null;provider:string|null;occurrences:number;containingInputs:number;promptIds:readonly string[];}
function responseAttributions(records:readonly ContextRecord[]):Map<string,{model:string|null;provider:string|null}>{
 const groups=new Map<string,ContextRecord[]>();
 for(const record of records){const key=JSON.stringify([record.conversationId,record.project]);const group=groups.get(key)??[];group.push(record);groups.set(key,group);}
 const attribution=new Map<string,{model:string|null;provider:string|null}>();
 for(const group of groups.values())for(let i=0;i<group.length;i++){const user=group[i]!;if(user.role!=='user'||!user.directUser)continue;const models=new Map<string,{model:string;provider:string|null}>();for(let j=i+1;j<group.length;j++){const next=group[j]!;if(next.role==='user')break;if(next.role==='assistant'&&next.model)models.set(JSON.stringify([next.model,next.provider]),{model:next.model,provider:next.provider});}attribution.set(user.id,models.size===1?[...models.values()][0]!:{model:null,provider:null});}
 return attribution;
}
/** Attribute only a direct input's own response turn, never a session-last model. */
export function attributeDirectLanguage(profanity:AuditProfanity|undefined,records:readonly ContextRecord[],prompts?:readonly AuditPrompt[]):ModelLanguage[]{
 const matches=prompts?prompts.flatMap(p=>{const count=auditProfanity([p]).terms?.filter(t=>t.kind==='direct_prose').reduce((n,t)=>n+t.occurrences,0)??0;return count?[{promptId:p.id,kind:'direct_prose' as const,occurrences:count}]:[];}):(profanity?.matches??[]).filter(m=>m.kind==='direct_prose').map(m=>({...m,occurrences:1})),attribution=responseAttributions(records);
 const result=new Map<string,{model:string|null;provider:string|null;occurrences:number;ids:Set<string>}>();
 for(const match of matches){const owner=attribution.get(match.promptId)??{model:null,provider:null},key=JSON.stringify(owner);let row=result.get(key);if(!row){row={...owner,occurrences:0,ids:new Set()};result.set(key,row);}row.occurrences+=match.occurrences;row.ids.add(match.promptId);}
 return [...result.values()].map(row=>({model:row.model,provider:row.provider,occurrences:row.occurrences,containingInputs:row.ids.size,promptIds:[...row.ids]})).sort((a,b)=>b.occurrences-a.occurrences||(a.model??'').localeCompare(b.model??''));
}

/** Full term counts, independently attributed; sample references never drive totals. */
export function attributeLanguageTerms(profanity:AuditProfanity,records:readonly ContextRecord[],prompts:readonly AuditPrompt[]):AuditProfanity {
 const attribution=responseAttributions(records);const modelRows=new Map<string,Map<string,{provider:string|null;model:string|null;occurrences:number}>>();
 for(const prompt of prompts){const lexical=auditProfanity([prompt]);const attributed=attribution.get(prompt.id);for(const term of lexical.terms??[]){const key=JSON.stringify([term.term,term.kind]),models=modelRows.get(key)??new Map();const owner=term.kind==='direct_prose'&&attributed?{provider:attributed.provider,model:attributed.model}:{provider:null,model:null},modelKey=JSON.stringify(owner),row=models.get(modelKey)??{...owner,occurrences:0};row.occurrences+=term.occurrences;models.set(modelKey,row);modelRows.set(key,models);}}
 return {...profanity,terms:profanity.terms?.map(term=>({...term,models:[...modelRows.get(JSON.stringify([term.term,term.kind]))?.values()??[]].sort((a,b)=>b.occurrences-a.occurrences)}))};
}
