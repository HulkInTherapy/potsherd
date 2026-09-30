import type {EvidenceItem, MemoryResponse, ReadInput, ResponseBudget, SpanRef} from './contracts.js';
import type {PlannedResponse} from './budget.js';
import {refKey} from './support.js';

/** Coverage is a delivery fact, never source authentication or semantic support. */
export function completeDeliveredSpan(items:readonly EvidenceItem[],ref:SpanRef):boolean {
 const matching=items.filter(item=>refKey(item.ref)===refKey(ref));
 const bounds=matching.map(item=>item.provenance).filter(p=>p!==undefined);
 if(!bounds.length)return false;
 const start=bounds[0]!.spanStartUtf16,end=bounds[0]!.spanEndUtf16;
 if(bounds.some(p=>p.spanStartUtf16!==start||p.spanEndUtf16!==end))return false;
 let position=start;
 for(const item of [...matching].sort((a,b)=>a.startUtf16-b.startUtf16)){
  if(item.startUtf16>position)break;
  position=Math.max(position,item.endUtf16);
 }
 return position>=end;
}

/** One bounded batch shares provenance/envelope cost. Authored support links,
 * then completion of clipped sources, precede bare discovery routes.
 * No query interpretation, newest-is-truth rule, or private corpus input.
 */
export function complementaryReadRefs(packet:MemoryResponse,delivered:readonly EvidenceItem[]=packet.evidence,attempted:ReadonlySet<string>=new Set()):SpanRef[]{
 const out:SpanRef[]=[];const seen=new Set(attempted);
 for(const ref of [...packet.assertions.flatMap(note=>note.supportRefs),...packet.evidence.map(item=>item.ref),...packet.candidates.map(candidate=>candidate.ref)]){
  const key=refKey(ref);if(seen.has(key)||completeDeliveredSpan(delivered,ref))continue;
  seen.add(key);out.push({...ref});if(out.length===2)break;
 }
 return out;
}

function newRange(item:EvidenceItem,delivered:readonly EvidenceItem[]):boolean {
 let position=item.startUtf16;
 for(const previous of delivered.filter(other=>refKey(other.ref)===refKey(item.ref)).sort((a,b)=>a.startUtf16-b.startUtf16)){
  if(previous.endUtf16<=position)continue;
  if(previous.startUtf16>position)return true;
  position=Math.max(position,previous.endUtf16);if(position>=item.endUtf16)return false;
 }
 return position<item.endUtf16;
}

export type ComplementaryReadPlan={state:'complete'|'ready'|'budget_incomplete'|'unavailable';request?:ReadInput;planned?:PlannedResponse;usedTokens:number;usedBytes:number};
/** Local service/helper admission: plan the actual read once and retain its
 * counted immutable emission. This accounts for quote, provenance, cursor and
 * transport, rather than guessing a global minimum. Do not invoke a remote
 * tool as `read`: this callback is the local, side-effect-free read planner.
 * A host may emit `planned.emission` directly; never execute the read twice.
 */
export function planComplementaryRead(packet:MemoryResponse,budget:ResponseBudget,read:(input:ReadInput)=>PlannedResponse,delivered:readonly EvidenceItem[]=packet.evidence,attempted:ReadonlySet<string>=new Set()):ComplementaryReadPlan {
 const refs=complementaryReadRefs(packet,delivered,attempted);
 if(!refs.length)return {state:'complete',usedTokens:0,usedBytes:0};
 const request:ReadInput={refs,scope:structuredClone(packet.coverage.scope),budget:{...budget},responseFormat:'compact-v1'};
 const planned=read(request);const response=planned.response;
 const progress='evidence' in response&&response.evidence.some(item=>item.text.length>0&&newRange(item,delivered));
 const state='error' in response&&response.error==='budget_too_small'?'budget_incomplete':!('evidence' in response)||response.coverage.state!=='complete_snapshot'?'unavailable':progress?'ready':'budget_incomplete';
 return {state,request,planned,usedTokens:planned.usedTokens,usedBytes:Buffer.byteLength(planned.emission.serialized)};
}
