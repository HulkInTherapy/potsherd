import type { EvidenceItem, NoteView, Requirement, SupportAssessment, SpanRef, Scope } from './contracts.js';

export function refKey(ref: SpanRef): string {
  return JSON.stringify([ref.sourceId, ref.revisionId, ref.spanId]);
}

/** Only actually delivered, contiguous coordinates in one immutable unit may join. */
export function deliveredLiteralRefs(evidence: readonly EvidenceItem[], literal: string): SpanRef[] {
  const refs = new Map<string, SpanRef>();
  const groups = new Map<string, EvidenceItem[]>();
  for (const item of evidence) {
    if (item.role === 'ghost_prompt' || item.endUtf16 - item.startUtf16 !== item.text.length) continue;
    if (item.text.includes(literal)) refs.set(refKey(item.ref), item.ref);
    if (!item.provenance?.unitRevisionId || item.quoteBasis !== 'redacted_unit') continue;
    const key = JSON.stringify([item.ref.sourceId, item.ref.revisionId, item.provenance.unitRevisionId, item.provenance.unitTextHash, item.role]);
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a,b)=>a.startUtf16-b.startUtf16 || b.endUtf16-a.endUtf16);
    let start = 0, text = '', chain: EvidenceItem[] = [];
    const flush = () => {
      const match = text.indexOf(literal);
      if (match >= 0) for (const item of chain) {
        if (item.startUtf16 < start + match + literal.length && item.endUtf16 > start + match) refs.set(refKey(item.ref), item.ref);
      }
    };
    for (const item of group) {
      const overlap = start + text.length - item.startUtf16;
      if (!chain.length || overlap < 0 || text.slice(item.startUtf16-start, Math.min(text.length,item.endUtf16-start)) !== item.text.slice(0, Math.max(0,Math.min(overlap,item.text.length)))) {
        flush(); start = item.startUtf16; text = item.text; chain = [item];
      } else {
        if (item.endUtf16 > start + text.length) text += item.text.slice(overlap);
        chain.push(item);
      }
    }
    flush();
  }
  return [...refs.values()];
}

/** Mechanical support is deliberately restricted to caller-declared constraints. */
export function assessSupport(requirements: readonly Requirement[], evidence: readonly EvidenceItem[], notes: readonly NoteView[], complete: boolean, noteScopeEligible?: (note:NoteView,scope:Scope)=>boolean): SupportAssessment {
  const checks: SupportAssessment['requirements'] = requirements.map((r) => {
    if(r.literal!==undefined&&r.note)return {id:r.id,text:r.text,state:'missing',refs:[]};
    if (r.literal !== undefined) {
      const refs = deliveredLiteralRefs(evidence, r.literal);
      return { id: r.id, text: r.text, state: refs.length ? 'supported' : 'missing', refs };
    }
    if (r.note) {
      const selector = r.note;
      const matches = notes.filter((n) => n.availability!=='privacy_refresh_required' && (!selector.kind || selector.kind === n.kind)
        && (selector.scope?.project === undefined || selector.scope.project === n.project)
        && (selector.scope?.branch === undefined || selector.scope.branch === n.branch)
        && (!selector.scope || (matchesNoteScope(n,selector.scope,Boolean(noteScopeEligible)) && (!noteScopeEligible || noteScopeEligible(n,selector.scope))))
        && (!selector.eventFrom || (n.eventAt !== null && Date.parse(n.eventAt) >= Date.parse(selector.eventFrom)))
        && (!selector.eventUntil || (n.eventAt !== null && Date.parse(n.eventAt) <= Date.parse(selector.eventUntil)))
        && (selector.status === 'history' || n.current) && n.supportStatus !== 'orphaned');
      return { id: r.id, text: r.text, state: matches.length ? 'supported' : 'missing', refs: [], noteIds: matches.map((n) => n.noteId) };
    }
    return { id: r.id, text: r.text, state: 'unassessed', refs: [] };
  });
  const arbitrary = checks.length === 0 || checks.some((r) => r.state === 'unassessed');
  const missing = checks.some((r) => r.state === 'missing');
  return {
    state: !complete || missing ? 'insufficient' : arbitrary ? 'unassessed' : 'sufficient',
    method: arbitrary ? 'none' : requirements.some((r) => r.note) ? 'structured_note' : 'literal',
    requirements: checks,
    unresolved: [
      ...(!complete ? ['Captured snapshot or retrieval capability is incomplete; a search miss does not establish absence.'] : []),
      ...(arbitrary ? ['The host reader must assess the natural-language claim against the delivered source evidence.'] : []),
      ...(requirements.some((r) => r.note) ? ['A note selector establishes an applicable author assertion, not the truth of that assertion.'] : []),
    ],
  };
}

/** Scalar nested boundaries remain exact even for callers without a database. */
function matchesNoteScope(note:NoteView, scope:Scope, resolved=false):boolean{
 if(scope.lineage && scope.lineage !== 'self' && !resolved) return false;
 if(scope.sourceIds && (!scope.lineage || scope.lineage==='self') && !scope.sourceIds.some(id=>id===note.originSourceId || id===note.lineageAnchorSourceId)) return false;
 if(scope.learnedBy && Date.parse(note.observedAt)>Date.parse(scope.learnedBy)) return false;
 if(scope.eventFrom && (!note.eventAt || Date.parse(note.eventAt)<Date.parse(scope.eventFrom))) return false;
 if(scope.asOf && (!note.eventAt || Date.parse(note.eventAt)>Date.parse(scope.asOf))) return false;
 return true;
}
