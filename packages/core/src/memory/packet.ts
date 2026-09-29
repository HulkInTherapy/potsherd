import type { Candidate, EvidenceItem, MemoryResponse, SpanRef } from './contracts.js';

/** Wire links are meaningful in this packet only. Durable requests always use SpanRef. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Facts = { [key: string]: JsonValue };
type SourceRevisionDescriptor = { sourceId: string; revisionId: string; provenance: Facts };
type UnitDescriptor = { facts: Facts; provenance: Facts };
export type PackedEvidence = {
  sourceRevisionIndex: number; unitIndex: number; spanId: string;
  provenancePresent: boolean; spanProvenance: Facts; facts: Facts;
  chunkPolicyIndex?: number; citationForm?: 'ref' | 'range';
};
export type CompactMemoryPacketV1 = {
  packetFormat: 'compact-v1'; packetVersion: 1; indexLifetime: 'packet';
  sourceRevisions: SourceRevisionDescriptor[]; units: UnitDescriptor[]; chunkPolicies: string[];
  response: Omit<MemoryResponse, 'evidence'|'candidates'> & { evidence: PackedEvidence[]; candidates:(Candidate&{previewIndex?:number})[] };
  /** Only opt-in inspect clients receive this explicitly versioned extension. */
  navigation?: {version:1;previews:PackedEvidence[]};
};
export class MemoryPacketError extends Error {
  constructor(code: string) { super(`invalid_memory_packet:${code}`); }
}
const sourceKeys = ['harness','nativeSessionId','artifactHash','artifactBytes','artifactBasis','adapterVersion','normalizationVersion','availability','manifestHash','parentNativeSessionId','transcriptAvailability'];
const unitKeys = ['role','sourceEventAt','observedAt','project','branch','toolOutcome','authority','historical','quoteBasis'];
const unitProvenanceKeys = ['locator','locatorFidelity','timeBasis','unitRevisionId','unitKey','unitTextHash','unitToolName','producerNameBasis','unitToolCallId'];
const has = (o: object, k: string): boolean => Object.hasOwn(o,k);
const fail = (code: string): never => { throw new MemoryPacketError(code); };
function object(v: unknown): Facts {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('object');
  return v as Facts;
}
function keys(v: unknown, allowed: readonly string[], required: readonly string[] = allowed): Facts {
  const o=object(v);
  if (Object.keys(o).some(k=>!allowed.includes(k)) || required.some(k=>!has(o,k))) fail('fields');
  return o;
}
function string(v: unknown): asserts v is string { if(typeof v!=='string') fail('string'); }
function integer(v: unknown): asserts v is number { if(!Number.isSafeInteger(v)||Number(v)<0) fail('integer'); }
function nullableString(v: unknown): void { if(v!==null) string(v); }
function boolean(v: unknown): void { if(typeof v!=='boolean') fail('boolean'); }
function array(v: unknown, maximum=256): unknown[] { if(!Array.isArray(v)||v.length>maximum) fail('array'); return v as unknown[]; }
/** Validate JSON without invoking getters/toJSON or assigning prototype-like keys. */
function json(v: unknown, maxBytes=2097152): void {
  let nodes=0; const ancestors=new Set<object>();
  function visit(value: unknown, depth: number): void {
    if(++nodes>100000||depth>32) fail('size');
    if(value===null||typeof value==='string'||typeof value==='boolean') return;
    if(typeof value==='number') { if(!Number.isFinite(value)) fail('number'); return; }
    if(!value||typeof value!=='object') return fail('json');
    if(ancestors.has(value)) fail('cycle');
    const proto=Object.getPrototypeOf(value);
    if(Array.isArray(value)?proto!==Array.prototype:proto!==Object.prototype&&proto!==null) fail('prototype');
    ancestors.add(value);
    for(const key of Reflect.ownKeys(value)) {
      if(Array.isArray(value)&&key==='length') continue;
      if(typeof key!=='string') fail('json');
      const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
      if(!descriptor.enumerable||!has(descriptor,'value')) fail('property');
      visit(descriptor.value,depth+1);
    }
    if(Array.isArray(value)&&(Object.keys(value).length!==value.length||Object.keys(value).some((key,i)=>key!==String(i)))) fail('sparse_array');
    ancestors.delete(value);
  }
  visit(v,0);
  if(Buffer.byteLength(JSON.stringify(v))>maxBytes) fail('size');
}
function ref(v: unknown): void {
  const r=keys(v,['sourceId','revisionId','spanId']);
  for(const value of Object.values(r)) { string(value); if(!value.length) fail('empty_ref'); }
}
function provenance(v: unknown): void {
  const p=object(v);
  for(const key of [...sourceKeys,...unitProvenanceKeys,'spanTextHash','chunkPolicy']) {
    if(!has(p,key)) continue;
    if(key==='artifactBytes') integer(p[key]);
    else if(key==='locator') { const l=object(p[key]); string(l.recordKey); if(!['exact','record_container','unavailable'].includes(String(l.mapping)))fail('locator'); for(const coordinate of ['rawStart','rawEnd'])if(has(l,coordinate))integer(l[coordinate]);if(has(l,'rawStart')&&has(l,'rawEnd')&&Number(l.rawEnd)<Number(l.rawStart))fail('locator_range'); }
    else if(['parentNativeSessionId','unitToolName','unitToolCallId'].includes(key)) nullableString(p[key]);
    else string(p[key]);
  }
  for(const key of ['spanStartUtf16','spanEndUtf16']) if(has(p,key)) integer(p[key]);
  if(has(p,'artifactBasis')&&!['raw_prefix','legacy_projection','history_records'].includes(String(p.artifactBasis)))fail('artifact_basis');
  if(has(p,'transcriptAvailability')&&p.transcriptAvailability!=='unavailable')fail('transcript_availability');
  if(has(p,'producerNameBasis')&&!['recorded','verified_prior_unit','unavailable','unverified','projection'].includes(String(p.producerNameBasis)))fail('producer_basis');
  if(has(p,'spanStartUtf16')&&has(p,'spanEndUtf16')&&Number(p.spanEndUtf16)<Number(p.spanStartUtf16)) fail('span_range');
}
function unitFacts(v: unknown): void {
  const e=partition(v,unitKeys);
  for(const key of ['role','observedAt','authority'])string(e[key]);
  for(const key of ['sourceEventAt','project','branch'])nullableString(e[key]);
  boolean(e.historical);if(e.quoteBasis!=='redacted_unit')fail('quote_basis');
  if(has(e,'toolOutcome')&&!['success','error','unknown'].includes(String(e.toolOutcome)))fail('outcome');
}
function evidence(v: unknown): void {
  const e=object(v); ref(e.ref);
  for(const key of ['text','role','observedAt','authority','citation']) string(e[key]);
  for(const key of ['sourceEventAt','project','branch']) nullableString(e[key]);
  boolean(e.historical); if(e.quoteBasis!=='redacted_unit') fail('quote_basis');
  if(has(e,'toolOutcome')&&!['success','error','unknown'].includes(String(e.toolOutcome)))fail('outcome');
  integer(e.startUtf16);integer(e.endUtf16);
  if(Number(e.endUtf16)-Number(e.startUtf16)!==String(e.text).length) fail('delivered_range');
  // Well-formed source text cannot acquire a dangling surrogate through clipping.
  const text=String(e.text);
  if(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(text))fail('surrogate_boundary');
  if(has(e,'provenance')) {
    provenance(e.provenance); const p=object(e.provenance);
    if(has(p,'spanStartUtf16')&&Number(e.startUtf16)<Number(p.spanStartUtf16)||has(p,'spanEndUtf16')&&Number(e.endUtf16)>Number(p.spanEndUtf16))fail('span_bounds');
  }
}
function response(v: unknown): asserts v is MemoryResponse {
  const r=object(v); if(has(r,'navigation')&&r.navigation!=='inspect-v1')fail('navigation_version'); if(r.contractVersion!==2)fail('contract_version'); string(r.requestId);
  const c=object(r.coverage); if(!['complete_snapshot','partial','unavailable','upgrade_required'].includes(String(c.state)))fail('coverage');
  if(!['ready','building','missing_assets','disabled','failed'].includes(String(c.semantic)))fail('semantic');
  object(c.scope); nullableString(c.capturedThrough);integer(c.pendingSources);integer(c.failedSources);
  for(const key of ['evidence','notes','lineage','deletion','vector'])integer(object(c.snapshotEpochs)[key]);
  for(const code of array(c.omittedKinds))string(code);
  if(has(c,'unavailableKinds'))for(const code of array(c.unavailableKinds))string(code);
  const s=object(r.support);if(!['sufficient','insufficient','conflict','unassessed'].includes(String(s.state)))fail('support');
  if(!['literal','structured_note','host_reader','none'].includes(String(s.method)))fail('method');
  for(const requirement of array(s.requirements)){const q=object(requirement);string(q.id);string(q.text);if(!['supported','missing','conflict','unassessed'].includes(String(q.state)))fail('requirement');for(const item of array(q.refs))ref(item);if(has(q,'noteIds'))for(const id of array(q.noteIds))string(id);}
  if(has(s,'assessor')){const a=object(s.assessor);string(a.kind);string(a.version);}
  for(const value of array(s.unresolved))string(value);
  for(const item of array(r.evidence))evidence(item);
  for(const item of array(r.candidates,r.navigation==='inspect-v1'?8:256)){const c=object(item);ref(c.ref);if(typeof c.score!=='number')fail('score');for(const lane of array(c.lanes))if(!['lexical','dense','literal'].includes(String(lane)))fail('lane');if(has(c,'evidence')){evidence(c.evidence);if(r.navigation==='inspect-v1'&&canonical(object(c.evidence).ref!)!==canonical(c.ref!))fail('candidate_preview_ref');}if(r.navigation==='inspect-v1'&&has(c,'previewIndex'))fail('preview_index_semantic');}
  for(const item of array(r.assertions)){
    const n=object(item);for(const key of ['noteId','batchId','text','project','observedAt','authorClaim'])string(n[key]);
    for(const key of ['branch','eventAt','validFrom','validUntil','originSourceId','lineageAnchorSourceId'])nullableString(n[key]);
    if(!['decision','open','next','observation','retraction'].includes(String(n.kind)))fail('note_kind');
    if(!['user_attested','agent_assertion','unknown'].includes(String(n.authority)))fail('note_authority');
    if(!['linked','unverified','orphaned'].includes(String(n.supportStatus)))fail('note_support');
    if(!['cli','mcp','api','migration'].includes(String(n.origin)))fail('note_origin');
    if(has(n,'availability')&&n.availability!=='privacy_refresh_required')fail('note_availability');
    boolean(n.current);for(const support of array(n.supportRefs))ref(support);for(const id of array(n.supersedes))string(id);
  }
  const b=object(r.budget);string(b.tokenizerId);integer(b.usedTokens);integer(b.remainingTokens);integer(b.omittedItems);boolean(b.truncated);
  for(const warning of array(r.warnings))string(warning);if(has(r,'continuation'))string(r.continuation);
}
// Define own properties: a JSON extension named __proto__ stays ordinary data.
function put(o: Facts,k: string,v: JsonValue): void { Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true}); }
function take(o: Facts, names: readonly string[]): Facts {
  const result: Facts={};for(const key of names)if(has(o,key)){put(result,key,o[key]!);delete o[key];}return result;
}
function canonical(v: JsonValue): string {
  if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  if(v&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k]!)}`).join(',')}}`;
  return JSON.stringify(v);
}
function intern<T>(rows: T[], value: T): number {
  const encoded=canonical(value as JsonValue);const index=rows.findIndex(row=>canonical(row as JsonValue)===encoded);
  if(index>=0)return index; rows.push(value);return rows.length-1;
}
/** Exact JSON facts only; this codec does not authenticate provenance or assess support. */
export function encodeCompactMemoryPacket(value: MemoryResponse): CompactMemoryPacketV1 {
  json(value);response(value);
  const copy=structuredClone(value);const sourceRevisions:SourceRevisionDescriptor[]=[];const units:UnitDescriptor[]=[];const chunkPolicies:string[]=[];
  const packItem=(item:EvidenceItem):PackedEvidence=>{
    const e=structuredClone(item) as unknown as Facts;const r=e.ref as unknown as SpanRef;delete e.ref;
    const provenancePresent=has(e,'provenance');const p=provenancePresent?object(e.provenance):{};delete e.provenance;
    const source={sourceId:r.sourceId,revisionId:r.revisionId,provenance:take(p,sourceKeys)};
    const unit={facts:take(e,unitKeys),provenance:take(p,unitProvenanceKeys)};
    const row:PackedEvidence={sourceRevisionIndex:intern(sourceRevisions,source),unitIndex:intern(units,unit),spanId:r.spanId,provenancePresent,spanProvenance:p,facts:e};
    if(has(p,'chunkPolicy')){row.chunkPolicyIndex=intern(chunkPolicies,p.chunkPolicy as string);delete p.chunkPolicy;}
    const base=`span:${r.sourceId}:${r.revisionId}:${r.spanId}`;
    if(e.citation===base){row.citationForm='ref';delete e.citation;}
    else if(e.citation===`${base}@${e.startUtf16}-${e.endUtf16}`){row.citationForm='range';delete e.citation;}
    return row;
  };
  const packed=copy.evidence.map(packItem),previews:PackedEvidence[]=[];
  const candidates=copy.candidates.map(candidate=>{
    if(copy.navigation!=='inspect-v1'||!candidate.evidence)return candidate;
    const {evidence:preview,...rest}=candidate;const previewIndex=previews.length;previews.push(packItem(preview));return {...rest,previewIndex};
  });
  return {packetFormat:'compact-v1',packetVersion:1,indexLifetime:'packet',sourceRevisions,units,chunkPolicies,response:{...copy,evidence:packed,candidates},...(copy.navigation==='inspect-v1'?{navigation:{version:1 as const,previews}}:{})};
}
function index(v: unknown, rows: unknown[]): number { integer(v);if(v>=rows.length)fail('index');return v; }
function merge(target: Facts, source: Facts): void { for(const [key,value] of Object.entries(source)){if(has(target,key))fail('collision');put(target,key,value);} }
function partition(v: unknown, allowed: readonly string[]): Facts { return keys(v,allowed,[]); }
/** Stateless, bounded expansion. Packet-local links never reach source readers. */
export function decodeCompactMemoryPacket(value: unknown): MemoryResponse {
  json(value);
  const packet=keys(value,['packetFormat','packetVersion','indexLifetime','sourceRevisions','units','chunkPolicies','response','navigation'],['packetFormat','packetVersion','indexLifetime','sourceRevisions','units','chunkPolicies','response']);
  if(packet.packetFormat!=='compact-v1'||packet.packetVersion!==1||packet.indexLifetime!=='packet')fail('version');
  const sources=array(packet.sourceRevisions).map(v=>{const row=keys(v,['sourceId','revisionId','provenance']);string(row.sourceId);string(row.revisionId);if(!row.sourceId||!row.revisionId)fail('empty_ref');partition(row.provenance,sourceKeys);provenance(row.provenance);return row;});
  const units=array(packet.units).map(v=>{const row=keys(v,['facts','provenance']);unitFacts(row.facts);partition(row.provenance,unitProvenanceKeys);provenance(row.provenance);return row;});
  const policies=array(packet.chunkPolicies);for(const policy of policies)string(policy);
  const copy=structuredClone(object(packet.response));
  const unpackItem=(v:unknown):Facts=>{
    const row=keys(v,['sourceRevisionIndex','unitIndex','spanId','provenancePresent','spanProvenance','facts','chunkPolicyIndex','citationForm'],['sourceRevisionIndex','unitIndex','spanId','provenancePresent','spanProvenance','facts']);
    const source=sources[index(row.sourceRevisionIndex,sources)]!;const unit=units[index(row.unitIndex,units)]!;
    string(row.spanId);boolean(row.provenancePresent);
    const e=structuredClone(object(row.facts));const p=structuredClone(object(row.spanProvenance));
    if(['ref','provenance',...unitKeys].some(k=>has(e,k))||[...sourceKeys,...unitProvenanceKeys,'chunkPolicy'].some(k=>has(p,k)))fail('partition');
    merge(e,object(unit.facts));
    const r={sourceId:source.sourceId as string,revisionId:source.revisionId as string,spanId:row.spanId};put(e,'ref',r);
    merge(p,object(source.provenance));merge(p,object(unit.provenance));
    if(has(row,'chunkPolicyIndex'))put(p,'chunkPolicy',policies[index(row.chunkPolicyIndex,policies)] as string);
    if(row.provenancePresent)put(e,'provenance',p);else if(Object.keys(p).length)fail('provenance_presence');
    if(has(row,'citationForm')){
      if(has(e,'citation')||!['ref','range'].includes(String(row.citationForm)))fail('citation');
      const base=`span:${r.sourceId}:${r.revisionId}:${r.spanId}`;put(e,'citation',row.citationForm==='ref'?base:`${base}@${e.startUtf16}-${e.endUtf16}`);
    }
    return e;
  };
  copy.evidence=array(copy.evidence).map(unpackItem);
  const previewRows:Facts[]=[];
  if(has(packet,'navigation')){
    const nav=keys(packet.navigation,['version','previews']);if(nav.version!==1||copy.navigation!=='inspect-v1')fail('navigation_version');
    previewRows.push(...array(nav.previews,8).map(unpackItem));
  }else if(copy.navigation==='inspect-v1')fail('navigation_extension_missing');
  const used=new Set<number>();
  copy.candidates=array(copy.candidates).map(value=>{
    const c=object(value);
    if(has(c,'previewIndex')){
      if(!has(packet,'navigation')||has(c,'evidence'))fail('preview_index');
      const i=index(c.previewIndex,previewRows);if(used.has(i))fail('preview_reuse');used.add(i);
      const preview=previewRows[i]!;ref(c.ref);if(canonical(c.ref!)!==canonical(preview.ref!))fail('candidate_preview_ref');
      delete c.previewIndex;put(c,'evidence',structuredClone(preview));
    }else if(has(packet,'navigation')&&has(c,'evidence'))fail('preview_inline');
    return c;
  });
  if(used.size!==previewRows.length)fail('preview_orphan');
  json(copy);response(copy);return copy;
}
export function canonicalPacketRef(packet: CompactMemoryPacketV1, evidenceIndex: number): SpanRef {
  const expanded=decodeCompactMemoryPacket(packet);return structuredClone(expanded.evidence[index(evidenceIndex,expanded.evidence)]!.ref);
}
