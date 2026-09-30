import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Epochs, EvidenceItem, MemoryResponse, MemoryResponseFormat, Requirement, ResponseBudget, Scope, SpanRef } from './contracts.js';
import { planResponse, planBudgetFailure, type PlannedResponse, type Transport } from './budget.js';
import { validateMemoryInput } from './input.js';
import { defaultBudget } from './budget.js';
import { refKey } from './support.js';

export type ReadPosition = { ref: SpanRef; startUtf16: number };
export type ReadCursor = { version: 1; kind: 'memory_read'; scope: Scope; epochs: Epochs; historical: boolean; selectionId?:string; positions: ReadPosition[]; scan?: { legacyRef: {sessionId:string;seq?:number;fromSeq?:number;toSeq?:number}; offset:number } };
export function encodeCursor(value: ReadCursor): string { return deflateRawSync(Buffer.from(JSON.stringify(value))).toString('base64url'); }
export function decodeCursor(encoded: string): ReadCursor {
  if (encoded.length > 16384 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('invalid_cursor');
  let value: unknown;
  try { value = JSON.parse(inflateRawSync(Buffer.from(encoded, 'base64url'), {maxOutputLength:65536}).toString()); } catch { throw new Error('invalid_cursor'); }
  const v = value as ReadCursor;
  if (!v || v.version !== 1 || v.kind !== 'memory_read' || typeof v.scope !== 'object' || !v.epochs || typeof v.historical !== 'boolean'
      || !Array.isArray(v.positions) || (!v.positions.length && !v.scan) || v.positions.length > 16
      || !v.positions.every((p) => p && Number.isSafeInteger(p.startUtf16) && p.startUtf16 >= 0 && p.ref
        && typeof p.ref.sourceId === 'string' && typeof p.ref.revisionId === 'string' && typeof p.ref.spanId === 'string')
      || (v.scan && (!Number.isSafeInteger(v.scan.offset) || v.scan.offset < 0 || !v.scan.legacyRef || typeof v.scan.legacyRef.sessionId !== 'string'))
      || (v.selectionId!==undefined&&(typeof v.selectionId!=='string'||!/^[a-f0-9]{64}$/.test(v.selectionId)))
      || !Object.values(v.epochs).every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid_cursor');
  if(v.scan)validateMemoryInput('read',{legacyRef:v.scan.legacyRef,scope:v.scope,budget:defaultBudget()});
  return v;
}
export function sameEpochs(a: Epochs, b: Epochs): boolean { return ['evidence','notes','lineage','deletion','vector'].every((key) => a[key as keyof Epochs] === b[key as keyof Epochs]); }

/** Immutable source reads do not depend on background representation progress. */
export function sameEvidenceEpochs(a: Epochs, b: Epochs): boolean { return ['evidence','notes','lineage','deletion'].every((key) => a[key as keyof Epochs] === b[key as keyof Epochs]); }

/** Exact returned items establish progress; an encoded cursor or scan offset alone does not. */
function unchangedNonemptyRead(original:MemoryResponse,delivered:MemoryResponse,positions:readonly ReadPosition[]):boolean {
  // Existing source/privacy operation outcomes must not become budget diagnoses.
  if(original.coverage.state==='unavailable'||original.coverage.state==='upgrade_required'
    ||original.warnings.some(code=>['privacy_refresh_required','source_span_unavailable','note_unavailable'].includes(code)))return false;
  const positive=original.evidence.filter(item=>item.endUtf16>item.startUtf16&&item.text.length>0);
  if(!positive.length)return false; // EOF, scanner-only and metadata-only originals.
  const usefulEvidence=delivered.evidence.some(item=>original.evidence.some(requested=>{
    if(refKey(item.ref)!==refKey(requested.ref))return false;
    if(requested.endUtf16===requested.startUtf16&&requested.text.length===0)
      return item.startUtf16===requested.startUtf16&&item.endUtf16===requested.endUtf16&&item.text.length===0;
    return item.text.length>0&&item.startUtf16>=requested.startUtf16&&item.endUtf16<=requested.endUtf16&&item.endUtf16>requested.startUtf16;
  }));
  const usefulAssertion=delivered.assertions.some(item=>original.assertions.some(requested=>requested.noteId===item.noteId));
  return !usefulEvidence&&!usefulAssertion&&positive.every(item=>positions.some(position=>refKey(position.ref)===refKey(item.ref)&&position.startUtf16===item.startUtf16));
}

/** Continuation describes exactly the source subranges omitted by the actual renderer. */
export function planReadResponse(response: MemoryResponse, budget: ResponseBudget, scope: Scope, transport: Transport, historical: boolean, scan?: ReadCursor['scan'], selectionId?:string,responseFormat:MemoryResponseFormat='expanded-v2'): PlannedResponse {
  const originals = response.evidence;
  let positions: ReadPosition[] = [];
  const planned = planResponse(response, budget, {transport,responseFormat,readContinuation: delivered => {
    const shown = new Map(delivered.evidence.map(item => [refKey(item.ref), item]));
    positions = originals.flatMap(item => {
      const shownItem = shown.get(refKey(item.ref));
      return !shownItem || shownItem.endUtf16 < item.endUtf16
        ? [{ref:item.ref,startUtf16:shownItem?.endUtf16 ?? item.startUtf16}] : [];
    });
    return positions.length || scan ? encodeCursor({version:1,kind:'memory_read',scope,epochs:response.coverage.snapshotEpochs,historical,positions,...(selectionId?{selectionId}:{}),...(scan?{scan}: {})}) : undefined;
  }});
  if ('evidence' in planned.response && unchangedNonemptyRead(response,planned.response,positions))
    return planBudgetFailure(budget,transport,responseFormat);
  return planned;
}

/** Match-centered exact subrange; quote coordinates refer only to delivered text. */
export function centerEvidence(item: EvidenceItem, query: string, literals: readonly string[] = [], maxCharacters = 2200): EvidenceItem {
  if (item.text.length <= maxCharacters) return item;
  const needle = literals.find((literal) => item.text.includes(literal)) ?? query;
  const match = item.text.indexOf(needle);
  if (match < 0) return item; // Semantic spans preserve their actual late hit, not a source-prefix projection.
  let start = Math.max(0, match - Math.floor((maxCharacters - needle.length) / 2));
  let end = Math.min(item.text.length, Math.max(start + maxCharacters, match + needle.length));
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(item.text[start]!)) start--;
  if (end < item.text.length && /[\uDC00-\uDFFF]/u.test(item.text[end]!)) end++;
  const from = item.startUtf16 + start, to = item.startUtf16 + end;
  return {...item,text:item.text.slice(start,end),startUtf16:from,endUtf16:to,citation:`span:${item.ref.sourceId}:${item.ref.revisionId}:${item.ref.spanId}@${from}-${to}`};
}
