import { defaultBudget, TOKENIZER_ID } from './budget.js';
import type { MemoryResponseFormat, NavigationMode } from './contracts.js';
export type PublicMemoryKind='recall'|'read'|'graft'|'write';
export class MemoryInputError extends Error {constructor(readonly code:string,message=code){super(message);}}
const fail=(code:string):never=>{throw new MemoryInputError(code);};
export function validateMemoryResponseFormat(value:unknown):MemoryResponseFormat {
 if(value===undefined)return 'expanded-v2';
 if(value!=='expanded-v2'&&value!=='compact-v1')fail('unsupported_response_format');
 return value as MemoryResponseFormat;
}
export function validateRecallNavigation(value:unknown,format:unknown):NavigationMode|undefined {
 if(value===undefined)return undefined;
 if(value!=='inspect-v1')fail('unsupported_navigation');
 if(format!=='compact-v1')fail('navigation_requires_compact');
 return 'inspect-v1';
}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid_input_object');return value as Record<string,unknown>;};
function keys(value:unknown,allowed:string[],code:string):Record<string,unknown>{const result=object(value);if(Object.keys(result).some(k=>!allowed.includes(k)))fail(code);return result;}
function text(value:unknown,max=8000):void{if(typeof value!=='string'||value.length>max)fail('invalid_input_text');}
function integer(value:unknown,min:number,max:number):void{if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)fail('invalid_input_number');}
function strings(value:unknown,max:number):void{if(!Array.isArray(value)||value.length>max)fail('invalid_input_list');for(const v of value as unknown[])text(v);}
function date(value:unknown):void{text(value);if(!Number.isFinite(Date.parse(value as string)))fail('invalid_input_date');}
function scope(value:unknown):void {const s=keys(value,['project','branch','sourceIds','lineage','eventFrom','asOf','learnedBy','includeHistory'],'unknown_scope_field');for(const k of ['project','branch'])if(s[k]!==undefined)text(s[k]);if(s.sourceIds!==undefined)strings(s.sourceIds,64);if(s.lineage!==undefined&&!['self','ancestors','descendants','conversation'].includes(String(s.lineage)))fail('invalid_lineage');for(const k of ['eventFrom','asOf','learnedBy'])if(s[k]!==undefined)date(s[k]);if(s.includeHistory!==undefined&&typeof s.includeHistory!=='boolean')fail('invalid_input_boolean');if(s.eventFrom!==undefined&&s.asOf!==undefined&&Date.parse(String(s.eventFrom))>Date.parse(String(s.asOf)))fail('invalid_event_range');}
function budget(value:unknown):void {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new MemoryInputError('invalid_budget_object','budget must be a JSON object.');
 const b=keys(value,['maxTokens','tokenizerId','remainingJourneyTokens','maxBytes'],'unknown_budget_field');
 for(const key of ['maxTokens','remainingJourneyTokens','maxBytes']){
  if(key!=='maxTokens'&&b[key]===undefined)continue;
  const min=key==='maxBytes'?256:64,max=key==='maxBytes'?1048576:65536;
  if(!Number.isInteger(b[key])||Number(b[key])<min||Number(b[key])>max)throw new MemoryInputError('invalid_budget_'+key,`budget.${key} must be an integer from ${min} to ${max}.`);
 }
 // The bundled transport accountant is pinned; omission does not select a host tokenizer.
 if(b.tokenizerId===undefined)b.tokenizerId=TOKENIZER_ID;
 if(typeof b.tokenizerId!=='string'||b.tokenizerId.length>256)throw new MemoryInputError('invalid_budget_tokenizerId','budget.tokenizerId must be text; omit it to use the bundled accounting tokenizer.');
 if(b.tokenizerId!==TOKENIZER_ID)throw new MemoryInputError('unsupported_budget_tokenizerId','budget.tokenizerId is unsupported; omit it to use the bundled accounting tokenizer.');
}
function refs(value:unknown):void {if(!Array.isArray(value)||value.length>16)fail('invalid_ref_list');for(const r of value as unknown[]){const ref=keys(r,['sourceId','revisionId','spanId'],'unknown_ref_field');for(const key of ['sourceId','revisionId','spanId']){text(ref[key]);if(!ref[key])fail('empty_ref');}}}
function requirements(value:unknown):void {if(!Array.isArray(value)||value.length>16)fail('invalid_requirements');for(const item of value as unknown[]){const r=keys(item,['id','text','literal','note'],'unknown_requirement_field');text(r.id);text(r.text,2000);if(r.literal!==undefined&&r.note!==undefined)fail('conflicting_requirement_conditions');if(r.literal!==undefined)text(r.literal,2000);if(r.note!==undefined){const n=keys(r.note,['kind','scope','status','eventFrom','eventUntil'],'unknown_note_selector_field');if(n.scope!==undefined)scope(n.scope);if(n.kind!==undefined&&!['decision','open','next','observation','retraction'].includes(String(n.kind)))fail('invalid_note_kind');if(n.status!==undefined&&!['current','history'].includes(String(n.status)))fail('invalid_note_status');for(const key of ['eventFrom','eventUntil'])if(n[key]!==undefined)date(n[key]);}}}
/** Undeclared boundaries are rejected, never stripped into a broader request. */
export function validateMemoryInput(kind:PublicMemoryKind,value:unknown,mcp=false):Record<string,unknown> {
 const common=['scope','budget',...(kind==='write'?[]:['responseFormat'])];
 const fields:Record<PublicMemoryKind,string[]>={recall:['query','mode','navigation','requirements',...(mcp?['want']:[])],read:['refs','noteIds','legacyRef','cursor',...(mcp?['thread','from','to']:[])],graft:['query','refs','mode','requirements',...(mcp?['thread','about']:[])],write:['requestKey','originSourceId','lineageAnchorSourceId','entries','authorClaim',...(mcp?[]:['origin']),'authority','validFrom','validUntil']};
 const v=keys(value,[...common,...fields[kind]],'unknown_top_level_field');v.scope??={};v.budget??=defaultBudget();scope(v.scope);budget(v.budget);
 if(kind!=='write')validateMemoryResponseFormat(v.responseFormat);
 if(kind==='recall')validateRecallNavigation(v.navigation,v.responseFormat);
 if(v.refs!==undefined)refs(v.refs);if(v.noteIds!==undefined)strings(v.noteIds,16);if(v.requirements!==undefined)requirements(v.requirements);
 for(const key of ['query','cursor','thread','about','originSourceId','lineageAnchorSourceId','authorClaim'])if(v[key]!==undefined){const max=key==='cursor'?16384:8000;if(typeof v[key]!=='string'||String(v[key]).length>max)throw new MemoryInputError('invalid_'+key,`${key} must be text of at most ${max} characters.`);}
 if(kind==='recall'){if(!v.query)fail('missing_query');if(v.mode!==undefined&&!['hybrid','literal'].includes(String(v.mode)))fail('invalid_mode');if(v.want!==undefined&&!['hits','context'].includes(String(v.want)))fail('invalid_want');}
 if(kind==='graft'&&v.mode!==undefined&&![...(mcp?[]:['assisted']),'evidence'].includes(String(v.mode)))fail('unsupported_graft_mode');
 if(kind==='read'&&((v.thread!==undefined&&(v.refs!==undefined||v.legacyRef!==undefined))||(v.refs!==undefined&&v.legacyRef!==undefined)))fail('conflicting_read_targets');
 if(kind==='graft'&&v.thread!==undefined&&(v.refs!==undefined||v.query!==undefined))fail('conflicting_graft_targets');
 if(v.legacyRef!==undefined){const r=keys(v.legacyRef,['sessionId','seq','fromSeq','toSeq'],'unknown_legacy_ref_field');text(r.sessionId);if(r.seq!==undefined)integer(r.seq,0,Number.MAX_SAFE_INTEGER);for(const key of ['fromSeq','toSeq'])if(r[key]!==undefined)integer(r[key],1,Number.MAX_SAFE_INTEGER);if(r.seq!==undefined&&(r.fromSeq!==undefined||r.toSeq!==undefined))fail('conflicting_legacy_range');if(r.fromSeq!==undefined&&r.toSeq!==undefined&&Number(r.toSeq)<Number(r.fromSeq))fail('invalid_legacy_range');}
 for(const key of ['from','to'])if(v[key]!==undefined)integer(v[key],1,Number.MAX_SAFE_INTEGER);
 if(v.from!==undefined&&v.to!==undefined&&Number(v.to)<Number(v.from))fail('invalid_legacy_range');
 if(kind==='read'&&(v.from!==undefined||v.to!==undefined)&&v.thread===undefined)fail('legacy_range_requires_thread');
 if(kind==='write'){
 const writeScope=object(v.scope);
 if(['eventFrom','asOf','learnedBy','includeHistory'].some(key=>writeScope[key]!==undefined))fail('unsupported_write_scope_boundary');
 if(writeScope.lineage!==undefined&&writeScope.lineage!=='self')fail('unsupported_write_lineage');
 const sourceIds=writeScope.sourceIds as string[]|undefined;
 if(sourceIds){const anchors=[v.originSourceId,v.lineageAnchorSourceId].filter(value=>value!==undefined);if(!sourceIds.length)fail('empty_write_source_scope');if(!anchors.length)fail('source_scoped_write_requires_anchor');if(anchors.some(value=>!sourceIds.includes(String(value))))fail('write_anchor_outside_source_scope');}
 text(v.requestKey,256);if(!v.requestKey)fail('missing_request_key');if(!Array.isArray(v.entries)||v.entries.length<1||v.entries.length>8)fail('invalid_note_entries');for(const entry of v.entries as unknown[]){const e=keys(entry,['kind','text','eventAt','validFrom','validUntil','supports','contradicts','context','supersedes'],'unknown_note_entry_field');if(!['decision','open','next','observation','retraction'].includes(String(e.kind)))fail('invalid_note_kind');text(e.text,2000);for(const key of ['eventAt','validFrom','validUntil'])if(e[key]!==undefined)date(e[key]);for(const key of ['supports','contradicts','context'])if(e[key]!==undefined){refs(e[key]);if(sourceIds&&(e[key] as {sourceId:string}[]).some(ref=>!sourceIds.includes(ref.sourceId)))fail('write_ref_outside_source_scope');}if(e.supersedes!==undefined)strings(e.supersedes,16);}if(v.authority!==undefined&&!['agent_assertion','unknown'].includes(String(v.authority)))fail('invalid_authority');if(v.origin!==undefined&&!['cli','mcp','api','migration'].includes(String(v.origin)))fail('invalid_origin');for(const key of ['validFrom','validUntil'])if(v[key]!==undefined)date(v[key]);}
 return v;
}
