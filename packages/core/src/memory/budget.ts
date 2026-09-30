import { createHash } from 'node:crypto';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/cl100k_base';
import type { Candidate, EvidenceItem, MemoryResponse, MemoryResponseFormat, ResponseBudget, Requirement, NoteView, Scope, SpanRef } from './contracts.js';
import { encodeCompactMemoryPacket } from './packet.js';
import { assessSupport } from './support.js';
import { refKey } from './support.js';
import { wrap } from '../format.js';
import { toAscii } from '../theme.js';

/** Exact local transport accounting, not an assertion about the host model. */
export const TOKENIZER_ASSET_HASH = createHash('sha256').update(JSON.stringify(ranks)).digest('hex');
export const TOKENIZER_ID = `cl100k-base/js-tiktoken@1.0.21/${TOKENIZER_ASSET_HASH}`;
export const DEFAULT_RESPONSE_TOKENS = 4096;
export const DEFAULT_RESPONSE_BYTES = 65536;
const tokenizer = new Tiktoken(ranks);
export function countTokens(text: string): number { return tokenizer.encode(text, [], []).length; }
export type Transport = 'json'|'mcp'|'cli_json'|'human'|{kind:'human';width:number;ascii?:boolean};
/** Structurally compatible with MCP, without a dependency on its SDK. */
export type McpTextResult = { content: {type:'text';text:string}[] };
export type FinalizedEmission =
  | {kind:'mcp';format:MemoryResponseFormat;result:McpTextResult;serialized:string}
  | {kind:'json'|'cli_json';format:MemoryResponseFormat;serialized:string}
  | {kind:'human';format:'expanded-v2';serialized:string};
export function assertResponseFormat(transport:Transport,format:MemoryResponseFormat):void {
  if(format!=='expanded-v2'&&format!=='compact-v1')throw new RangeError('Unsupported response format');
  if(format==='compact-v1'&&(transport==='human'||typeof transport==='object'))throw new RangeError('Compact response format requires JSON transport');
}
/** One immutable counted emission. Never regenerate it from the semantic response. */
export function finalizeEmission(value:unknown,transport:Transport='json',format:MemoryResponseFormat='expanded-v2'):FinalizedEmission {
  assertResponseFormat(transport,format);
  if(transport==='human'||typeof transport==='object')return Object.freeze({kind:'human',format:'expanded-v2',serialized:serializeResponse(value,transport)});
  const body=format==='compact-v1'&&value&&typeof value==='object'&&'evidence' in value?encodeCompactMemoryPacket(value as MemoryResponse):value;
  const text=JSON.stringify(body);
  if(transport==='mcp') {
    const block=Object.freeze({type:'text' as const,text});
    const result={content:[block]};Object.freeze(result.content);Object.freeze(result);
    return Object.freeze({kind:'mcp',format,result,serialized:JSON.stringify(result)});
  }
  return Object.freeze({kind:transport,format,serialized:transport==='cli_json'?text+'\n':text});
}
export function emittedMcpResult(planned:{emission:FinalizedEmission}):McpTextResult {
  if(planned.emission.kind!=='mcp')throw new TypeError('Planned emission is not MCP');
  return planned.emission.result;
}
export function serializeResponse(value: unknown, transport: Transport = 'json'): string {
  if (transport === 'human'||typeof transport==='object') {
    const text=renderMemory(value);const width=typeof transport==='object'?transport.width:80;
    return wrap(typeof transport==='object'&&transport.ascii?toAscii(text):text,width).join('\n')+'\n';
  }
  const text = JSON.stringify(value);
  if (transport === 'cli_json') return text + '\n';
  return transport === 'mcp' ? JSON.stringify({ content: [{ type: 'text', text }] }) : text;
}
function renderMemory(value: unknown): string {
  if(value&&typeof value==='object'&&'noteIds' in value&&Array.isArray(value.noteIds)){
    const receipt=value as import('./contracts.js').WriteReceipt&{budget:MemoryResponse['budget']};
    return [`Memory committed: ${receipt.noteIds.length} authored assertion(s).`,`Request: ${receipt.requestKey}`,`Batch: ${receipt.batchId}`,`Authority: ${receipt.authority}; support: ${receipt.supportStatus}.`,`Committed at: ${receipt.committedAt}`,...receipt.noteIds.map(id=>`note:${id}`),`Tokens: ${receipt.budget.usedTokens}; remaining: ${receipt.budget.remainingTokens}.`,'Run: potsherd show --input-json with the noteIds above.'].join('\n')+'\n';
  }
  const response = value as MemoryResponse;
  if (!response.evidence) return `${(value as {error?:string}).error ?? 'budget_too_small'}\n`;
  const lines = [`Memory: ${response.coverage.state}; support: ${response.support.state}; semantic: ${response.coverage.semantic}.`,
    `Tokens: ${response.budget.usedTokens}; remaining: ${response.budget.remainingTokens}; omitted: ${response.budget.omittedItems}.`,
    ...response.warnings];
  if(response.coverage.unavailableKinds?.includes('original_transcript'))lines.push('Original transcript unavailable; retained prompts establish requests, not assistant answers or tool outcomes.');
  for (const item of response.evidence) lines.push('', `${item.citation} · ${item.role} · ${item.project ?? 'unknown project'} · ${item.branch ?? 'unknown branch'} · ${item.sourceEventAt ?? 'unknown event time'}`, item.text);
  for (const note of response.assertions) lines.push('', `note:${note.noteId} · ${note.kind} · ${note.authority} · ${note.current ? 'current' : 'history'} · ${note.supportStatus}`, note.availability==='privacy_refresh_required'?'Assertion text unavailable; privacy refresh required.':note.text);
  lines.push(...response.support.unresolved);
  if (response.continuation) lines.push('', `Continue: ${response.continuation}`);
  return lines.join('\n') + '\n';
}
export function defaultBudget(maxTokens = DEFAULT_RESPONSE_TOKENS): ResponseBudget {
  return { maxTokens, tokenizerId: TOKENIZER_ID, maxBytes: DEFAULT_RESPONSE_BYTES };
}
export function safeBoundary(text: string, offset: number): number {
  if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!)) return offset - 1;
  return offset;
}
/** Keep exact source characters, never decode a partial byte token into replacement text. */
export function clipText(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (countTokens(text) <= maxTokens) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(text.slice(0, safeBoundary(text, mid))) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, safeBoundary(text, lo));
}
/** response is semantic data for support/cursors/status; only emission is transport data. */
export type PlannedResponse = { response: MemoryResponse | { error?: string }; emission:FinalizedEmission; serialized: string; usedTokens: number; usedBytes: number };

/** Development caps, not certified viable-envelope minima. Overrides are internal control inputs only. */
export type InspectNavigationPlan = {pool:readonly Candidate[];query:string;terms:readonly string[];profile?:{seeds:number;previewTokens:number}};
const INSPECT_ROUTE_LIMIT=8,INSPECT_SEEDS=3,INSPECT_PREVIEW_TOKENS=32;
const PREVIEW_SCAN_CHARACTERS=16384,PREVIEW_WINDOW_CHARACTERS=256,PREVIEW_ANCHORS=8;
export type PreviewWork = {scanCharacters:number;anchors:number;windows:number};
/** One bounded original-text window. No token-decoding, normalization or noncontiguous quote splice. */
export function inspectPreview(item:EvidenceItem,query:string,terms:readonly string[],maxTokens=INSPECT_PREVIEW_TOKENS,work?:PreviewWork):EvidenceItem {
  if(!Number.isSafeInteger(maxTokens)||maxTokens<0||maxTokens>64)throw new RangeError('Invalid inspect preview cap');
  const scan=item.text.slice(0,safeBoundary(item.text,Math.min(item.text.length,PREVIEW_SCAN_CHARACTERS)));
  const anchors:number[]=[];const add=(at:number)=>{if(at>=0&&anchors.length<PREVIEW_ANCHORS&&!anchors.includes(at))anchors.push(at);};
  if(maxTokens>0){
    if(query.length&&query.length<=8000)add(scan.indexOf(query));
    for(const term of terms.slice(0,8)){
      if(!term.length||term.length>256)continue;
      const pattern=new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');let hit:RegExpExecArray|null;
      while(anchors.length<PREVIEW_ANCHORS&&(hit=pattern.exec(scan)))add(hit.index);
      if(anchors.length===PREVIEW_ANCHORS)break;
    }
  }
  if(!anchors.length)anchors.push(0);
  let bestStart=0,bestText='',bestCoverage=-1,windows=0;
  const queryTerms=[...new Set(terms.slice(0,8).map(term=>term.toLowerCase()))];
  for(const anchor of anchors){
    for(const before of [48,0]){
      const start=safeBoundary(item.text,Math.max(0,anchor-before));
      const end=safeBoundary(item.text,Math.min(item.text.length,start+PREVIEW_WINDOW_CHARACTERS));
      const text=maxTokens?clipText(item.text.slice(start,end),maxTokens):'';windows++;
      const lower=text.toLowerCase(),coverage=queryTerms.filter(term=>term.length&&lower.includes(term)).length;
      if(coverage>bestCoverage||(coverage===bestCoverage&&start<bestStart)){bestStart=start;bestText=text;bestCoverage=coverage;}
    }
  }
  if(work){work.scanCharacters=scan.length;work.anchors=anchors.length;work.windows=windows;}
  const startUtf16=item.startUtf16+bestStart,endUtf16=startUtf16+bestText.length;
  return {...structuredClone(item),text:bestText,startUtf16,endUtf16,citation:`span:${item.ref.sourceId}:${item.ref.revisionId}:${item.ref.spanId}@${startUtf16}-${endUtf16}`};
}

function responseLimits(budget:ResponseBudget):{limit:number;byteLimit:number} {
  if (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens < 1) throw new RangeError('maxTokens must be a positive safe integer');
  if (budget.tokenizerId !== TOKENIZER_ID) throw new RangeError('Unsupported transport tokenizer');
  const limit = Math.min(budget.maxTokens, budget.remainingJourneyTokens ?? budget.maxTokens);
  const byteLimit = budget.maxBytes ?? DEFAULT_RESPONSE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(byteLimit) || byteLimit < 2) throw new RangeError('Invalid response budget');
  return {limit,byteLimit};
}
/** Same bounded operational failure used by ordinary budget exhaustion and no-progress reads. */
export function planBudgetFailure(budget:ResponseBudget,transport:Transport='json',format:MemoryResponseFormat='expanded-v2'):PlannedResponse {
  const {limit,byteLimit}=responseLimits(budget);
  for(const response of [{error:'budget_too_small'},{}]) {
    const emission=finalizeEmission(response,transport,format),serialized=emission.serialized;
    const usedTokens=countTokens(serialized),usedBytes=Buffer.byteLength(serialized);
    if(usedTokens<=limit&&usedBytes<=byteLimit)return {response,emission,serialized,usedTokens,usedBytes};
  }
  throw new RangeError('Budget cannot encode the transport envelope');
}

/** Count the entire emitted surface, including escaping and the receipt's own digits. */
export function planResponse(original: MemoryResponse, budget: ResponseBudget, options: { transport?: Transport; responseFormat?:MemoryResponseFormat; navigation?:InspectNavigationPlan; readContinuation?:(response:MemoryResponse)=>string|undefined; evidenceFirst?:boolean; requirements?: readonly Requirement[]; noteScopeEligible?:(note:NoteView,scope:Scope)=>boolean; knownLiteralMatches?:readonly {literal:string;ref:SpanRef}[] } = {}): PlannedResponse {
  const {limit,byteLimit}=responseLimits(budget);
  const transport = options.transport ?? 'json';
  const format=options.responseFormat??'expanded-v2';assertResponseFormat(transport,format);
  if(options.navigation&&format!=='compact-v1')throw new RangeError('Inspect navigation requires compact-v1');
  const response = structuredClone(original);
  response.budget.tokenizerId = TOKENIZER_ID;
  let trimmed = response.budget.truncated;
  let originalItems = response.evidence.length + response.assertions.length + response.candidates.length + response.budget.omittedItems;
  const hinted = new Set<string>();
  const nav=options.navigation;
  const profile=nav?.profile??{seeds:INSPECT_SEEDS,previewTokens:INSPECT_PREVIEW_TOKENS};
  if(nav&&(!Number.isSafeInteger(profile.seeds)||profile.seeds<1||profile.seeds>8||!Number.isSafeInteger(profile.previewTokens)||profile.previewTokens<0||profile.previewTokens>64||nav.pool.length>256))throw new RangeError('Invalid inspect navigation profile');
  const initialEvidence=new Set(response.evidence.map(item=>refKey(item.ref)));
  const available=new Map<string,Candidate>();
  if(nav){
    for(const candidate of nav.pool)if(candidate.evidence&&refKey(candidate.ref)===refKey(candidate.evidence.ref)&&!available.has(refKey(candidate.ref)))available.set(refKey(candidate.ref),candidate);
    // Literal multi-span covers can contain exact refs not represented by the fused anchor.
    for(const item of response.evidence)if(!available.has(refKey(item.ref)))available.set(refKey(item.ref),{ref:item.ref,score:0,lanes:['literal'],evidence:item});
    response.navigation='inspect-v1';
  }
  const seeds=[...available.keys()].filter(key=>!initialEvidence.has(key)).slice(0,profile.seeds);
  const previews=new Map<string,EvidenceItem>();
  if(nav)for(const key of seeds){const item=available.get(key)!.evidence!;previews.set(key,inspectPreview(item,nav.query,nav.terms,profile.previewTokens));}
  let seedLimit=seeds.length,offeredLimit=INSPECT_ROUTE_LIMIT,previewText=profile.previewTokens>0;
  const navItemCount=available.size+response.assertions.length+response.budget.omittedItems;
  const rebuildNavigation=(hint:SpanRef|undefined,mechanicallySatisfied:boolean):number=>{
    const visible=new Set(response.evidence.map(item=>refKey(item.ref)));
    // Recover selected source items lost to the budget before exploring new
    // independent seeds. A selected-but-clipped bundle remains navigable.
    const omittedSelected=[...initialEvidence].filter(key=>!visible.has(key)&&available.has(key));
    const protect=mechanicallySatisfied||response.coverage.state==='unavailable'||response.coverage.state==='upgrade_required'?[]:[...omittedSelected,...seeds].slice(0,seedLimit);
    if(hint&&available.has(refKey(hint))&&!visible.has(refKey(hint)))protect.unshift(refKey(hint));
    // If clipping removes every selected item without independent seeds,
    // retain one exact recovery route rather than a successful dead end.
    if(!mechanicallySatisfied&&response.coverage.state!=='unavailable'&&response.coverage.state!=='upgrade_required'&&!visible.size&&!protect.length){
      const recovery=available.keys().next().value;if(recovery)protect.push(recovery);
    }
    const protectedKeys=[...new Set(protect)].filter(key=>!visible.has(key)).slice(0,Math.max(1,seedLimit));
    const keys=[...protectedKeys,...available.keys()].filter((key,index,all)=>!visible.has(key)&&all.indexOf(key)===index).slice(0,Math.max(offeredLimit,protectedKeys.length));
    response.candidates=keys.map(key=>{
      const candidate=available.get(key)!;const result:Candidate={ref:structuredClone(candidate.ref),score:candidate.score,lanes:[...candidate.lanes]};
      if(protectedKeys.includes(key)){
        if(!previews.has(key)){previews.set(key,inspectPreview(candidate.evidence!,nav!.query,nav!.terms,profile.previewTokens));}
        // No quote means no packed preview or orphan provenance-table cost.
        if(previewText&&previews.get(key)!.text.length)result.evidence=previews.get(key)!;
      }
      return result;
    });
    return protectedKeys.length;
  };
  const settle = (): { emission:FinalizedEmission; serialized: string; tokens: number; bytes: number } => {
    for (let i = 0; i < 32; i++) {
      const emission=finalizeEmission(response,transport,format),encoded=emission.serialized;
      const tokens = countTokens(encoded);
      if (response.budget.usedTokens === tokens && response.budget.remainingTokens === Math.max(0, limit - tokens)) {
        return { emission,serialized: encoded, tokens, bytes: Buffer.byteLength(encoded) };
      }
      response.budget.usedTokens = tokens;
      response.budget.remainingTokens = Math.max(0, limit - tokens);
    }
    throw new Error('Token receipt did not converge');
  };
  // Never duplicate full source text in the exploratory candidate section.
  if(!nav)response.candidates = response.candidates.map(({ evidence: _e, ...candidate }) => candidate);
  for (;;) {
    response.budget.truncated = trimmed;
    response.budget.omittedItems = originalItems - response.evidence.length - response.assertions.length - response.candidates.length;
    if (options.requirements) response.support = assessSupport(options.requirements, response.evidence, response.assertions, response.coverage.state === 'complete_snapshot',options.noteScopeEligible);
    const missingKnown = (options.knownLiteralMatches??[]).filter(match=>options.requirements?.some(requirement=>requirement.literal===match.literal&&response.support.requirements.some(check=>check.id===requirement.id&&check.state==='missing')));
    if (missingKnown.length&&!nav) {
      response.support.unresolved.push('Matching canonical source text exists, but the complete literal is not in the delivered ranges. Read the candidate spans or increase the response budget.');
      // One bounded handle survives ordinary evidence clipping. Extremely small
      // packets may still omit it, while retaining honest unresolved support.
      const match = missingKnown.find(match=>!response.evidence.some(item=>JSON.stringify(item.ref)===JSON.stringify(match.ref))) ?? missingKnown[0]!;
      const key = JSON.stringify(match.ref);
      if (!hinted.has(key)) {
        hinted.add(key);
        if (!response.candidates.some(candidate=>JSON.stringify(candidate.ref)===key)) {
          response.candidates.unshift({ref:match.ref,score:0,lanes:['literal']}); originalItems++;
        }
      }
    }
    const mechanical=Boolean(options.requirements?.length)&&options.requirements!.every(requirement=>requirement.literal!==undefined||requirement.note!==undefined)&&response.support.state==='sufficient'&&response.support.requirements.every(requirement=>requirement.state==='supported');
    const protectedCount=nav?rebuildNavigation(missingKnown[0]?.ref,mechanical):0;
    response.budget.omittedItems = (nav?navItemCount:originalItems) - response.evidence.length - response.assertions.length - response.candidates.length;
    // Read pagination participates in this monotone trim pass. Recompute from
    // actual ranges before counting, so a cursor can never be priced then lost.
    if(options.readContinuation){
      const continuation=options.readContinuation(response);
      if(continuation)response.continuation=continuation;else delete response.continuation;
    }
    let payload = settle();
    if (payload.tokens <= limit && payload.bytes <= byteLimit) {
      // A large evidence removal can leave room after navigation was reduced.
      // Restore only bare routes to originally selected, now omitted sources.
      // Each exact wire check is bounded and never re-enters the trim loop.
      if(nav&&!mechanical&&response.coverage.state==='complete_snapshot'){
        const exposed=new Set([...response.evidence.map(item=>refKey(item.ref)),...response.candidates.map(candidate=>refKey(candidate.ref))]);
        for(const key of initialEvidence){
          if(response.candidates.length>=INSPECT_ROUTE_LIMIT)break;
          if(exposed.has(key)||!available.has(key))continue;
          const candidate=available.get(key)!,previousBudget={...response.budget};
          response.candidates.push({ref:structuredClone(candidate.ref),score:candidate.score,lanes:[...candidate.lanes]});
          response.budget.omittedItems--;
          const proposed=settle();
          if(proposed.tokens<=limit&&proposed.bytes<=byteLimit){payload=proposed;exposed.add(key);}
          else {response.candidates.pop();response.budget=previousBudget;}
        }
      }
      return { response, emission:payload.emission,serialized: payload.serialized, usedTokens: payload.tokens, usedBytes: payload.bytes };
    }
    trimmed = true;
    if(nav){
      if(response.candidates.length>protectedCount){offeredLimit=response.candidates.length-1;continue;}
      if(previewText&&protectedCount){previewText=false;continue;}
      // One affordable recovery route is enough while useful selected evidence remains.
      // Independent preview seeds must not evict an already selected evidence bundle.
      if(protectedCount>1){seedLimit=protectedCount-1;offeredLimit=seedLimit;continue;}
    }else if (response.candidates.length && (!missingKnown.length || response.candidates.length>1 || !response.evidence.length)) { response.candidates.pop(); continue; }
    if(options.evidenceFirst&&response.evidence.length&&response.assertions.length){response.assertions.pop();continue;}
    if (!nav&&response.warnings.length) { response.warnings.pop(); continue; }
    // Budget shares protect complementary evidence: shrink the longest item, not all tails.
    const longest = response.evidence.reduce((best, item, index, all) => item.text.length > (all[best]?.text.length ?? 0) ? index : best, 0);
    const item = response.evidence[longest];
    if (item && countTokens(item.text) > 48) {
      const target=Math.max(48, Math.floor(countTokens(item.text)*0.72));
      const literal=(options.requirements??[]).map((r)=>r.literal).find((l)=>l!==undefined&&item.text.includes(l));
      const match=literal===undefined?0:safeBoundary(item.text,item.text.indexOf(literal));
      const reduced=clipText(item.text.slice(match),target);
      item.startUtf16+=match;
      item.text = reduced;
      item.endUtf16 = item.startUtf16 + reduced.length;
      item.citation = `span:${item.ref.sourceId}:${item.ref.revisionId}:${item.ref.spanId}@${item.startUtf16}-${item.endUtf16}`;
      continue;
    }
    if (response.evidence.length) { response.evidence.pop(); continue; }
    if (response.assertions.length) { response.assertions.pop(); continue; }
    if (response.continuation && !options.readContinuation) { delete response.continuation; continue; }
    if(nav&&protectedCount>1){seedLimit=protectedCount-1;offeredLimit=seedLimit;continue;}
    return planBudgetFailure(budget,transport,format);
  }
}

/** Durable receipts are never clipped; if transport is too small, preserve retry identity. */
export function planWriteReceipt(receipt: import('./contracts.js').WriteReceipt, budget: ResponseBudget = defaultBudget(), transport:Transport='json'): {response:Record<string,unknown>;emission:FinalizedEmission;serialized:string;usedTokens:number;usedBytes:number} {
  if(budget.tokenizerId!==TOKENIZER_ID)throw new RangeError('Unsupported transport tokenizer');
  const limit=Math.min(budget.maxTokens,budget.remainingJourneyTokens??budget.maxTokens);
  const value={...receipt,budget:{tokenizerId:TOKENIZER_ID,usedTokens:0,remainingTokens:0,truncated:false,omittedItems:0}};
  for(let i=0;i<32;i++) {
    const emission=finalizeEmission(value,transport),encoded=emission.serialized,used=countTokens(encoded);
    if(value.budget.usedTokens===used&&value.budget.remainingTokens===Math.max(0,limit-used)) {
      if(used<=limit&&Buffer.byteLength(encoded)<=(budget.maxBytes??DEFAULT_RESPONSE_BYTES))return {response:value,emission,serialized:encoded,usedTokens:used,usedBytes:Buffer.byteLength(encoded)};
      break;
    }
    value.budget.usedTokens=used;value.budget.remainingTokens=Math.max(0,limit-used);
  }
  const error={error:'write_receipt_over_budget',committed:true,requestKey:receipt.requestKey};
  const emission=finalizeEmission(error,transport),encoded=emission.serialized,used=countTokens(encoded);
  if(used>limit||Buffer.byteLength(encoded)>(budget.maxBytes??DEFAULT_RESPONSE_BYTES))throw new RangeError('Budget cannot encode durable write acknowledgement');
  return {response:error,emission,serialized:encoded,usedTokens:used,usedBytes:Buffer.byteLength(encoded)};
}
