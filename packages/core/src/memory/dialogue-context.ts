import type {Db} from '../db.js';
import type {EvidenceItem} from './contracts.js';
import {readSpan} from './source.js';
import {queryTerms} from './retrieval.js';
import {refKey} from './support.js';

export type DialogueEvidenceGroup={anchor:EvidenceItem;context:EvidenceItem[]};
export type DialogueContextOptions={maxAnchors?:number;precedingUnits?:number;maxUnitUtf16?:number;maxTotalUtf16?:number;roles?:readonly ('user'|'assistant'|'tool_result')[];allowComparison?:boolean};

/** Source context, never an inferred decision or supersession relationship.
 * Short preceding records share distinctive words with their assistant
 * anchor, or human dialogue supplies context for an explicit comparison.
 * Query/entity words alone do not link adjacent topics. The caller owns final group ordering and wire budget.
 */
export function adjacentDialogueContext(db:Db,anchors:readonly EvidenceItem[],query:string,filter:{sql:string;params:unknown[]},options:DialogueContextOptions={}):DialogueEvidenceGroup[]{
 const maxAnchors=Math.max(0,Math.min(16,options.maxAnchors??5));
 const distance=Math.max(0,Math.min(8,options.precedingUnits??3));
 const maxUnit=Math.max(0,Math.min(1024,options.maxUnitUtf16??384));
 let remaining=Math.max(0,Math.min(4096,options.maxTotalUtf16??1536));
 const roles=options.roles??['user'];if(!roles.length)return anchors.map(anchor=>({anchor,context:[]}));
 const queryWords=new Set(queryTerms(query));const expanded=new Set<string>();
 const groups:DialogueEvidenceGroup[]=anchors.map(anchor=>({anchor,context:[]}));
 let visited=0;
 for(const group of groups){
  const anchor=group.anchor;if(anchor.role!=='assistant'||visited>=maxAnchors||remaining<=0)continue;
  const row=db.prepare(`SELECT ru.ordinal,u.unit_revision_id FROM memory_sources s JOIN source_revisions r ON r.source_id=s.source_id JOIN revision_units ru ON ru.revision_id=r.revision_id JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id JOIN revision_spans rs ON rs.revision_id=r.revision_id JOIN evidence_spans p ON p.span_id=rs.span_id AND p.unit_revision_id=u.unit_revision_id WHERE ${filter.sql} AND s.source_id=? AND r.revision_id=? AND p.span_id=?`).get(...filter.params,anchor.ref.sourceId,anchor.ref.revisionId,anchor.ref.spanId) as {ordinal:number;unit_revision_id:string}|undefined;
  if(!row||expanded.has(`${anchor.ref.revisionId}:${row.unit_revision_id}`))continue;
  const canonical=readSpan(db,anchor.ref);if(!canonical||canonical.role!=='assistant')continue;
  // An anchor may be a deliberately clipped exact range; never alter it here.
  if(anchor.startUtf16<canonical.startUtf16||anchor.endUtf16>canonical.endUtf16||anchor.text!==canonical.text.slice(anchor.startUtf16-canonical.startUtf16,anchor.endUtf16-canonical.startUtf16))continue;
  expanded.add(`${anchor.ref.revisionId}:${row.unit_revision_id}`);visited++;
  const words=new Set(queryTerms(canonical.text).filter(word=>!queryWords.has(word)));
  // Explicit backward comparison is a source-context route, not proof that
  // either neighboring statement was adopted. Paraphrases need not repeat
  // the assistant's words; preserve exact roles/times for the host reader.
  const comparesPrior=options.allowComparison!==false&&/\b(replaces?|replaced|previous|earlier|instead|rather than|original|reversed?)\b/iu.test(canonical.text);
  const nearby=db.prepare(`SELECT u.unit_revision_id,u.text,ru.ordinal FROM memory_sources s JOIN source_revisions r ON r.source_id=s.source_id JOIN revision_units ru ON ru.revision_id=r.revision_id JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ${filter.sql} AND s.source_id=? AND r.revision_id=? AND ru.ordinal>=? AND ru.ordinal<? AND u.role IN (${roles.map(()=>'?').join(',')}) AND length(u.text)<=? ORDER BY ru.ordinal`).all(...filter.params,anchor.ref.sourceId,anchor.ref.revisionId,Math.max(0,row.ordinal-distance),row.ordinal,...roles,maxUnit) as {unit_revision_id:string;text:string;ordinal:number}[];
  for(const unit of nearby){
   if(unit.text.length>maxUnit||unit.text.length>remaining||!unit.text.trim())continue;
   if(!comparesPrior&&queryTerms(unit.text).filter(word=>words.has(word)).length<2)continue;
   const context:EvidenceItem[]=[];let position=0;
   // Cover the complete short record with existing immutable spans. This does
   // not cap anchor spans or discard any long-source range selected upstream.
   while(position<unit.text.length){
    const span=db.prepare('SELECT p.span_id,p.end_utf16 FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id WHERE rs.revision_id=? AND p.unit_revision_id=? AND p.start_utf16<=? AND p.end_utf16>? ORDER BY p.end_utf16 DESC,p.span_id LIMIT 1').get(anchor.ref.revisionId,unit.unit_revision_id,position,position) as {span_id:string;end_utf16:number}|undefined;
    if(!span)break;
    const ref={...anchor.ref,spanId:span.span_id},item=readSpan(db,ref);if(!item)break;
    const end=Math.min(unit.text.length,span.end_utf16),text=item.text.slice(position-item.startUtf16,end-item.startUtf16);
    if(text!==unit.text.slice(position,end))break; // privacy-redacted/unavailable ranges cannot be expanded
    context.push({...item,text,startUtf16:position,endUtf16:end,citation:`span:${ref.sourceId}:${ref.revisionId}:${ref.spanId}@${position}-${end}`});position=end;
   }
   if(position!==unit.text.length)continue;
   group.context.push(...context);remaining-=unit.text.length;
  }
 }
 return groups;
}

/** Insert source dialogue immediately before its anchor, retaining all anchors
 * and all nonoverlapping exact ranges. It does not impose a new evidence cap.
 */
export function flattenDialogueGroups(groups:readonly DialogueEvidenceGroup[]):EvidenceItem[]{
 const out:EvidenceItem[]=[];const seen=new Set<string>();
 for(const group of groups)for(const item of [...group.context,group.anchor]){
  const key=`${refKey(item.ref)}:${item.startUtf16}:${item.endUtf16}`;
  if(!seen.has(key)){seen.add(key);out.push(item);}
 }
 return out;
}
