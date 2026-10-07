import type {AuditProfanity} from './contracts.js';
import type {ContextRecord} from './launch-contracts.js';
export interface ModelLanguage {model:string|null;provider:string|null;occurrences:number;containingInputs:number;promptIds:readonly string[];}
/** Attribute only a direct input's own response turn, never a session-last model. */
export function attributeDirectLanguage(profanity:AuditProfanity|undefined,records:readonly ContextRecord[]):ModelLanguage[]{
 const matches=(profanity?.matches??[]).filter(m=>m.kind==='direct_prose'),groups=new Map<string,ContextRecord[]>();
 for(const record of records){const key=JSON.stringify([record.conversationId,record.project]);const group=groups.get(key)??[];group.push(record);groups.set(key,group);}
 const attribution=new Map<string,{model:string|null;provider:string|null}>();
 for(const group of groups.values())for(let i=0;i<group.length;i++){const user=group[i]!;if(user.role!=='user'||!user.directUser)continue;const models=new Map<string,{model:string;provider:string|null}>();for(let j=i+1;j<group.length;j++){const next=group[j]!;if(next.role==='user')break;if(next.role==='assistant'&&next.model)models.set(JSON.stringify([next.model,next.provider]),{model:next.model,provider:next.provider});}attribution.set(user.id,models.size===1?[...models.values()][0]!:{model:null,provider:null});}
 const result=new Map<string,{model:string|null;provider:string|null;occurrences:number;ids:Set<string>}>();
 for(const match of matches){const owner=attribution.get(match.promptId)??{model:null,provider:null},key=JSON.stringify(owner);let row=result.get(key);if(!row){row={...owner,occurrences:0,ids:new Set()};result.set(key,row);}row.occurrences++;row.ids.add(match.promptId);}
 return [...result.values()].map(row=>({model:row.model,provider:row.provider,occurrences:row.occurrences,containingInputs:row.ids.size,promptIds:[...row.ids]})).sort((a,b)=>b.occurrences-a.occurrences||(a.model??'').localeCompare(b.model??''));
}
