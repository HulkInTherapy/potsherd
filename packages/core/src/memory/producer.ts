import type {Db} from '../db.js';
import type {SpanRef} from './contracts.js';
export const nativeRecordPipeline=(harness:string,version:string)=>new RegExp(`^${harness}-records-v[0-9]+$`).test(version)&&['claude','codex'].includes(harness);
const pairs:Record<string,string>={'claude:tool_result':'claude:tool_use','codex:function_call_output':'codex:function_call','codex:custom_tool_call_output':'codex:custom_tool_call','codex:tool_search_output':'codex:tool_search_call','codex:local_shell_call_output':'codex:local_shell_call'};
export function producerView(db:Db,ref:SpanRef,unitId:string,harness:string,version:string,role:string,storedName:string|null,callId:string|null,locator:Record<string,unknown>):{name:string|null;basis:'recorded'|'verified_prior_unit'|'unavailable'|'unverified'|'projection';refresh:boolean}{
 if(role!=='tool_result')return {name:storedName,basis:'recorded',refresh:false};
 if(!nativeRecordPipeline(harness,version))return {name:storedName,basis:'projection',refresh:false};
 const unavailable={name:null,basis:storedName!==null?'unverified' as const:'unavailable' as const,refresh:storedName!==null};
 const expected=pairs[String(locator.nativeKind??'')];if(!callId||!expected||!String(locator.nativeKind).startsWith(harness+':'))return unavailable;
 const rows=db.prepare(`SELECT cu.tool_name,cu.locator_json FROM revision_units result JOIN revision_units prior ON prior.revision_id=result.revision_id AND prior.ordinal<result.ordinal JOIN evidence_units cu ON cu.unit_revision_id=prior.unit_revision_id WHERE result.revision_id=? AND result.unit_revision_id=? AND cu.source_id=? AND cu.role='tool_input' AND cu.tool_call_id=?`).all(ref.revisionId,unitId,ref.sourceId,callId) as {tool_name:string|null;locator_json:string}[];
 if(rows.length!==1||!rows[0]!.tool_name)return unavailable;
 const call=rows[0]!,location=JSON.parse(call.locator_json) as Record<string,unknown>;
 if(location.nativeKind!==expected||(storedName!==null&&storedName!==call.tool_name)||!Number.isSafeInteger(location.rawStart)||!Number.isSafeInteger(location.rawEnd)||!Number.isSafeInteger(locator.rawStart)||Number(location.rawStart)<0||Number(location.rawEnd)<=Number(location.rawStart)||Number(locator.rawStart)<0||Number(location.rawEnd)>Number(locator.rawStart))return unavailable;
 return {name:call.tool_name,basis:'verified_prior_unit',refresh:false};
}
