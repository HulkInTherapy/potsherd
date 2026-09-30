import type { Candidate, EvidenceItem, Requirement } from './contracts.js';
import type { Db } from '../db.js';
import { readSpan } from './source.js';
import { safeBoundary } from './budget.js';
import { NORMALIZATION_VERSION } from './privacy.js';
import { redact } from '../redact.js';
import { deliveredLiteralRefs, refKey } from './support.js';

export const CANDIDATES_PER_LANE = 64;
export const EVIDENCE_LIMIT = 5;
export const LITERAL_EXPANSION_LIMIT = 64;
const literalCovers = Symbol('internal literal covers');
type LiteralCover = { literal: string; evidence: EvidenceItem[]; limited?:boolean };
type RetrievalCandidate = Candidate & { [literalCovers]?: LiteralCover[] };
const literalConnections = new WeakSet<Db>();

/** Eligibility, revision authority and exact full-unit matching all precede LIMIT. */
export function fullUnitLiteralCandidates(db: Db, query: string, filter: {sql:string;params:unknown[]}): Candidate[] {
  if (!query) return [];
  if (!literalConnections.has(db)) {
    // Connection-local registration is read-only; privacy is applied before
    // the bounded result limit, not by discarding an already-limited hit list.
    db.function('potsherd_literal_match_utf16',{deterministic:true},(text:string,normalization:string,literal:string)=>{
      if (normalization===NORMALIZATION_VERSION) return text.indexOf(literal)+1;
      const ranges = normalization===NORMALIZATION_VERSION ? [] : redact(text).hits;
      let scanned=0;
      for (let match=text.indexOf(literal);match>=0;match=text.indexOf(literal,match+1)) {
        if (++scanned>256) return -1;
        if (!ranges.some(hit=>hit.start<match+literal.length&&hit.start+hit.length>match)) return match+1;
      }
      return 0;
    });
    literalConnections.add(db);
  }
  const rows = db.prepare(`SELECT s.source_id,r.revision_id,u.unit_revision_id,u.text,potsherd_literal_match_utf16(u.text,u.normalization_version,?) match_utf16 FROM memory_sources s JOIN source_revisions r ON r.source_id=s.source_id JOIN revision_units ru ON ru.revision_id=r.revision_id JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ${filter.sql} AND instr(u.text,?)>0 AND potsherd_literal_match_utf16(u.text,u.normalization_version,?)<>0 ORDER BY s.source_id,r.revision_id,ru.ordinal LIMIT ?`).all(query,...filter.params,query,query,CANDIDATES_PER_LANE) as {source_id:string;revision_id:string;unit_revision_id:string;text:string;match_utf16:number}[];
  return rows.flatMap(row => {
    if (row.match_utf16<0) {
      const span=db.prepare('SELECT p.span_id FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id WHERE rs.revision_id=? AND p.unit_revision_id=? ORDER BY rs.ordinal LIMIT 1').get(row.revision_id,row.unit_revision_id) as {span_id:string}|undefined;
      return span?[{ref:{sourceId:row.source_id,revisionId:row.revision_id,spanId:span.span_id},score:0,lanes:['literal'],[literalCovers]:[{literal:query,evidence:[],limited:true}]} as RetrievalCandidate]:[];
    }
    const match = row.match_utf16-1;
    const start = safeBoundary(row.text,match);
    const rawEnd = match + query.length, safeEnd = safeBoundary(row.text,rawEnd);
    const end = safeEnd === rawEnd ? rawEnd : safeEnd + 2;
    const cover: EvidenceItem[] = [];
    let position = start, anchor: Candidate['ref'] | undefined;
    // Furthest-reaching interval at each step is the minimum existing-span cover.
    // A hard per-hit expansion cap prevents enormous literals allocating unbounded spans.
    for (let expansion = 0; position < end && expansion < LITERAL_EXPANSION_LIMIT; expansion++) {
      const span = db.prepare('SELECT p.span_id,p.end_utf16 FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id WHERE rs.revision_id=? AND p.unit_revision_id=? AND p.start_utf16<=? AND p.end_utf16>? ORDER BY p.end_utf16 DESC,p.span_id LIMIT 1').get(row.revision_id,row.unit_revision_id,position,position) as {span_id:string;end_utf16:number} | undefined;
      if (!span) break;
      const ref = {sourceId:row.source_id,revisionId:row.revision_id,spanId:span.span_id};
      anchor ??= ref;
      const item = readSpan(db,ref);
      const next = Math.min(end,span.end_utf16);
      if (item) {
        const text = item.text.slice(position-item.startUtf16,next-item.startUtf16);
        cover.push({...item,text,startUtf16:position,endUtf16:next,citation:`span:${ref.sourceId}:${ref.revisionId}:${ref.spanId}@${position}-${next}`});
      }
      position = next;
    }
    // Ordinary literal hits keep the useful source context. The precise cover
    // remains the fallback for privacy-constrained or multi-window matches.
    if (cover.length===1 && position>=end) {
      const whole=readSpan(db,cover[0]!.ref);
      if(whole&&whole.text.includes(query))cover[0]=whole;
    }
    return anchor ? [{ref:anchor,score:0,lanes:['literal'],evidence:cover[0],[literalCovers]:[{literal:query,evidence:cover,limited:position<end}]} as RetrievalCandidate] : [];
  });
}

export function literalSearchLimited(candidates:readonly Candidate[]):boolean {
  return candidates.some(candidate=>(candidate as RetrievalCandidate)[literalCovers]?.some(cover=>cover.limited));
}

export function knownLiteralMatches(candidates: readonly Candidate[]): {literal:string;ref:Candidate['ref']}[] {
  return candidates.flatMap(candidate => ((candidate as RetrievalCandidate)[literalCovers] ?? []).flatMap(cover=>(cover.evidence.length?cover.evidence.map(item=>item.ref):[candidate.ref]).map(ref=>({literal:cover.literal,ref}))));
}
const STOP = new Set('a an the is are was were be been being it this that these those to of for and or in on at by with from we i you our your did do does what which who where when why how have has had can could would should about find recall remember tell me please'.split(' '));

/** Query text is never rewritten according to what the corpus happens to contain. */
export function queryTerms(query: string): string[] {
  const terms = query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(terms.filter((term) => !STOP.has(term)))];
}
/** Coarse navigation intent only: roles and context routes, never claim truth. */
export function retrievalIntent(query:string):{requestForObservedOutcome:boolean;requestForDecisionContext:boolean}{
 return {
  requestForObservedOutcome:/\b(measurements?|measured|reports?|outcomes?|results?|verifiers?)\b/iu.test(query),
  requestForDecisionContext:/\b(current|currently|governs?|replaced?|replaces|reversed?|reversals?|previous|choices?)\b/iu.test(query)||(/\bdecisions?\b/iu.test(query)&&!/\b(parent|child|subagent|verifier)\b/iu.test(query)),
 };
}

export function ftsQuery(query: string): string | null {
  const terms = queryTerms(query);
  return terms.length ? terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ') : null;
}

/** Genuine independent lane union: no dense prefilter may erase lexical hits. */
export function fuseCandidates(lanes: readonly { lane: 'lexical'|'dense'|'literal'; candidates: readonly Candidate[] }[]): Candidate[] {
  const union = new Map<string, Candidate>();
  for (const { lane, candidates } of lanes) {
    const seen = new Set<string>();
    for (const [index, candidate] of candidates.slice(0, CANDIDATES_PER_LANE).entries()) {
      const key = refKey(candidate.ref);
      if (seen.has(key)) {
        const current = union.get(key) as RetrievalCandidate;
        const merged = current[literalCovers] ?? [];
        current[literalCovers] = [...merged,...((candidate as RetrievalCandidate)[literalCovers]??[]).filter(cover=>!merged.some(existing=>existing.literal===cover.literal))];
        continue;
      }
      seen.add(key);
      const current = union.get(key) ?? { ...candidate, score: 0, lanes: [] };
      current.score += 1 / (60 + index + 1);
      if (!current.lanes.includes(lane)) current.lanes.push(lane);
      if (!current.evidence && candidate.evidence) current.evidence = candidate.evidence;
      const covers = (candidate as RetrievalCandidate)[literalCovers];
      if (covers) {
        const merged = (current as RetrievalCandidate)[literalCovers] ?? [];
        (current as RetrievalCandidate)[literalCovers] = [...merged,...covers.filter(cover=>!merged.some(existing=>existing.literal===cover.literal))];
      }
      union.set(key, current);
    }
  }
  return [...union.values()].sort((a, b) => b.score - a.score || refKey(a.ref).localeCompare(refKey(b.ref)));
}

function words(text: string): Set<string> { return new Set(queryTerms(text)); }
function overlap(a: EvidenceItem, b: EvidenceItem): boolean {
  if(refKey(a.ref)===refKey(b.ref))return true;
  if(a.provenance?.unitRevisionId&&a.provenance.unitRevisionId===b.provenance?.unitRevisionId)
    return a.startUtf16<b.endUtf16&&b.startUtf16<a.endUtf16;
  const sameMetadata=a.role===b.role&&a.sourceEventAt===b.sourceEventAt&&a.project===b.project&&a.branch===b.branch&&a.toolOutcome===b.toolOutcome;
  const aParent=a.provenance?.locator.parentNativeSessionId,bParent=b.provenance?.locator.parentNativeSessionId;
  const lineage=typeof aParent==='string'&&(aParent===b.provenance?.nativeSessionId||aParent===bParent)||typeof bParent==='string'&&bParent===a.provenance?.nativeSessionId;
  const inherited=lineage&&a.provenance?.unitKey&&a.provenance.unitKey===b.provenance?.unitKey&&a.provenance.unitTextHash===b.provenance?.unitTextHash;
  return sameMetadata&&a.text===b.text&&(a.ref.sourceId===b.ref.sourceId||Boolean(inherited));
}
function similarity(a: Set<string>, b: Set<string>): number {
  const common = [...a].filter((term) => b.has(term)).length;
  return common / Math.max(1, Math.min(a.size, b.size));
}

/** Select useful complementary units rather than fill the response with candidates. */
export function selectEvidence(candidates: readonly Candidate[], query: string, requirements: readonly Requirement[] = [], limit = EVIDENCE_LIMIT): EvidenceItem[] {
  const queryWords = words(query);
  const observedOutcome=!requirements.some(requirement=>requirement.literal!==undefined)&&retrievalIntent(query).requestForObservedOutcome;
  const selected: EvidenceItem[] = [];
  // A boundary literal is one selection, even when its immutable cover needs
  // several spans. Deliver novel contiguous slices, never overlapping copies.
  const literals = requirements.flatMap(r=>r.literal===undefined?[]:[r.literal]);
  for (const literal of literals) {
    if (deliveredLiteralRefs(selected,literal).length) continue;
    const covers = candidates.flatMap(c=>(c as RetrievalCandidate)[literalCovers]??[]).filter(c=>c.literal===literal);
    const cover = covers.find(c=>deliveredLiteralRefs(c.evidence,literal).length) ?? covers[0];
    if (cover) for (const item of cover.evidence) {
      const index = selected.findIndex(existing=>refKey(existing.ref)===refKey(item.ref)&&existing.startUtf16<=item.endUtf16&&item.startUtf16<=existing.endUtf16);
      const existing = selected[index];
      if (existing) {
        const earlier = existing.startUtf16<=item.startUtf16?existing:item;
        const later = earlier===existing?item:existing;
        const start=earlier.startUtf16,end=Math.max(earlier.endUtf16,later.endUtf16);
        const text=earlier.text+later.text.slice(Math.max(0,earlier.endUtf16-later.startUtf16));
        selected[index]={...existing,text,startUtf16:start,endUtf16:end,citation:`span:${item.ref.sourceId}:${item.ref.revisionId}:${item.ref.spanId}@${start}-${end}`};
      } else if (selected.length<LITERAL_EXPANSION_LIMIT) selected.push(item);
    }
  }
  const covered = new Set<string>();
  for (const item of selected) for (const term of words(item.text)) if (queryWords.has(term)) covered.add(term);
  // Retained prompts are inspectable source evidence; support assessment still
  // prevents them from establishing assistant answers or observed outcomes.
  const remaining = candidates.filter((c) => c.evidence);
  const temporal=/\b(current|latest|recent|status|changed|remaining|superseded|reversed)\b/iu.test(query);
  const eventTimes=remaining.flatMap((c)=>c.evidence?.sourceEventAt?[Date.parse(c.evidence.sourceEventAt)]:[]).filter(Number.isFinite);
  const latest=Math.max(...eventTimes,0);
  const maximum = Math.max(...candidates.map((c) => c.score), 0.000001);
  while (remaining.length && selected.length < limit) {
    let bestIndex = -1;
    let bestUtility = -Infinity;
    for (const [i, candidate] of remaining.entries()) {
      const evidence = candidate.evidence!;
      if (selected.some((s) => overlap(evidence, s))) continue;
      const terms = words(evidence.text);
      const matching = [...queryWords].filter((t) => terms.has(t));
      const novel = matching.filter((t) => !covered.has(t)).length / Math.max(1, queryWords.size);
      const literalGain = requirements.filter((r) => r.literal !== undefined && evidence.text.includes(r.literal)
        && !selected.some((s) => s.text.includes(r.literal!))).length;
      const duplicate = selected.length ? Math.max(...selected.map((s) => {
        // Similar wording across independent source events is complementary evidence.
        // Only penalize repetition inside the same immutable record.
        const unit=evidence.provenance?.unitRevisionId;
        return unit&&unit===s.provenance?.unitRevisionId ? similarity(terms,words(s.text)) : 0;
      })) : 0;
      // An explicit request for measurements should inspect each independent result,
      // not spend its role preference on only the first result. This is not entailment.
      const outcomeText=/\b(measured|measurements?|reports?|reported|outcomes?|observations?|results?|passed|failed)\b/iu.test(evidence.text);
      const outcomeGain = evidence.role === 'tool_result' ? observedOutcome ? outcomeText ? 0.75 : 0 : !selected.some((s) => s.role === 'tool_result') ? 0.12 : 0 : 0;
      const timeGain=temporal&&evidence.sourceEventAt&&Date.parse(evidence.sourceEventAt)===latest?0.08:0;
      const utility = timeGain + candidate.score / maximum + novel * 0.2 + Math.min(1, literalGain) * 0.8 + outcomeGain - duplicate * 0.65;
      if (utility > bestUtility) { bestUtility = utility; bestIndex = i; }
    }
    if (bestIndex < 0) break;
    const chosen = remaining.splice(bestIndex, 1)[0]!.evidence!;
    selected.push(chosen);
    for (const term of words(chosen.text)) if (queryWords.has(term)) covered.add(term);
  }
  return selected;
}
