import crypto from 'node:crypto';
export function hash(text: string | Buffer): string { return crypto.createHash('sha256').update(text).digest('hex'); }
/** Length framing avoids ambiguous identity tuples. */
export function identity(...parts: string[]): string {
    const h = crypto.createHash('sha256');
    for (const p of parts) {
        const b = Buffer.from(p);
        const n = Buffer.alloc(4);
        n.writeUInt32BE(b.length);
        h.update(n);
        h.update(b);
    }
    return h.digest('hex');
}
export type SpanTokenizer = {
    assetHash: string;
    id: string;
    boundaries(text: string): number[];
    count?(text:string):number;
    sourceBoundaries?(text:string):SourceBoundary[];
};
export type SpanWindow = {
    startUtf16: number;
    endUtf16: number;
    text: string;
    chunkPolicy: string;
    embeddingInputHash: string;
    embeddingContextJson: string;
    isPartition?: boolean;
};
/** Exact embedding recipe. Context is metadata, never quoted evidence. */
export function spanEmbeddingText(text:string,embeddingContextJson:string):string {
 const context=JSON.parse(embeddingContextJson).context as string|undefined;
 return context?`${context}\n\n${text}`:text;
}
export function spanWindows(text: string, tokenizer?: SpanTokenizer, recordContext=''): SpanWindow[] {
    if (!text)
        return [];
    const out: SpanWindow[] = [];
    const contextOffsets=tokenizer?tokenizer.boundaries(recordContext):[0];
    const context=tokenizer?recordContext.slice(0,contextOffsets[Math.min(64,contextOffsets.length-1)]??0):'';
    const contextTokens=tokenizer?.count?tokenizer.count(context):Math.max(0,contextOffsets.length-1>64?64:contextOffsets.length-1);
    const payloadTokens=382-contextTokens;
    const count=tokenizer?.count??((value:string)=>tokenizer?tokenizer.boundaries(value).length-1:Buffer.byteLength(value));
    const inputText=(value:string)=>context?`${context}\n\n${value}`:value;
    // With missing assets use a conservative byte bound, explicitly a different policy.
    // Every UTF-8 byte is an upper bound on one BGE wordpiece; no guessed tokenizer hash.
    const policy = tokenizer ? `span-v1:${tokenizer.assetHash}:record-context-v1` : 'span-conservative-utf8-v1';
    const offsets = tokenizer ? tokenizer.boundaries(text) : [0, ...Array.from(text).reduce<number[]>((a, c) => { a.push((a.at(-1) ?? 0) + c.length); return a; }, [])];
    if (offsets[0] !== 0 || offsets.at(-1) !== text.length || offsets.some((v, i) => i > 0 && v <= offsets[i - 1]!))
        throw new Error('invalid tokenizer boundaries');
    let i = 0;
    while (i < offsets.length - 1) {
        let j = i + 1;
        while (j < offsets.length - 1 && (tokenizer ? j - i < payloadTokens : Buffer.byteLength(text.slice(offsets[i], offsets[j + 1])) <= 382))
            j++;
        // Prefer complete paragraph/newline boundaries in the latter half of a window.
        const maxEnd = offsets[j]!;
        const newline = text.lastIndexOf('\n', maxEnd - 1) + 1;
        if (newline > offsets[Math.floor((i + j) / 2)]!) {
            const boundary = offsets.indexOf(newline);
            if (boundary > i)
                j = boundary;
        }
        while(tokenizer&&j>i+1&&count(inputText(text.slice(offsets[i],offsets[j])))>382)j--;
        const start = offsets[i]!, end = offsets[j]!;
        if(tokenizer&&count(inputText(text.slice(start,end)))>382)throw new Error('wordpiece window exceeds384 including special tokens');
        if (isSplit(text, start) || isSplit(text, end))
            throw new Error('surrogate split');
        const value = text.slice(start, end);
        out.push({ startUtf16: start, endUtf16: end, text: value, chunkPolicy: policy, embeddingInputHash: hash(inputText(value)), embeddingContextJson: JSON.stringify({ partition: [start, end], tokenizerId: tokenizer?.id ?? null, tokenizerHash: tokenizer?.assetHash ?? null, context,contextTokens,recipe:'record-context-v1' }), isPartition: true });
        if (tokenizer && i > 0) {
            const overlapStart = offsets[Math.max(0, i - 32)]!;
            let overlapIndex=Math.min(j,i+payloadTokens-32);
            while(overlapIndex>i&&count(inputText(text.slice(overlapStart,offsets[overlapIndex])))>382)overlapIndex--;
            const overlapEnd = offsets[overlapIndex]!;
            const overlapText = text.slice(overlapStart, overlapEnd);
            out.push({ startUtf16: overlapStart, endUtf16: overlapEnd, text: overlapText, chunkPolicy: policy, embeddingInputHash: hash(inputText(overlapText)), embeddingContextJson: JSON.stringify({ partition: null, neighborOverlap: 32, tokenizerId: tokenizer.id, tokenizerHash: tokenizer.assetHash, context,contextTokens,recipe:'record-context-v1' }), isPartition: false });
        }
        i = j;
    }
    return out;
}
function isSplit(t: string, i: number): boolean { return i > 0 && i < t.length && t.charCodeAt(i) >= 0xdc00 && t.charCodeAt(i) <= 0xdfff && t.charCodeAt(i - 1) >= 0xd800 && t.charCodeAt(i - 1) <= 0xdbff; }
export function reassembleUnit(windows: SpanWindow[]): string {
    let end = 0;
    let text = '';
    for (const s of windows) {
        if (s.isPartition === false)
            continue;
        if (s.startUtf16 !== end || s.endUtf16 - s.startUtf16 !== s.text.length)
            throw new Error('invalid partition');
        text += s.text;
        end = s.endUtf16;
    }
    return text;
}

export type SourceBoundary = {offsetUtf16:number;tokenEndOrdinal:number};
export const SPAN_MANIFEST_VERSION='span-manifest-v2';
export const SPAN_CONTEXT_RECIPE='record-context-v1';
export function currentSpanPolicy(tokenizer?:Pick<SpanTokenizer,'assetHash'>):string {return tokenizer?`span-v2:${tokenizer.assetHash}:${SPAN_CONTEXT_RECIPE}`:'span-conservative-utf8-v1';}
/** Window policy is geometry, not model coordinate-space identity. */
export function compatibleSpanPolicies(tokenizerHash:string):string[] {return [`span-v1:${tokenizerHash}:${SPAN_CONTEXT_RECIPE}`,`span-v2:${tokenizerHash}:${SPAN_CONTEXT_RECIPE}`];}
export type CoveragePartition={startUtf16:number;endUtf16:number;windowOrdinal:number;relativeStartUtf16:number;relativeEndUtf16:number};
export type SpanManifest={policy:string;manifestVersion:string;windows:SpanWindow[];coveragePartitions:CoveragePartition[]};

/** One retrieval family; exact disjoint coverage is derived from advancing ends. */
export function buildSpanManifest(text:string,tokenizer?:SpanTokenizer,recordContext=''):SpanManifest {
 const policy=currentSpanPolicy(tokenizer);
 if(!tokenizer) {
  const windows=spanWindows(text);
  return {policy,manifestVersion:SPAN_MANIFEST_VERSION,windows,coveragePartitions:deriveCoveragePartitions(windows,text,false)};
 }
 if(!tokenizer.count||!tokenizer.sourceBoundaries)throw new Error('verified v2 source token coordinates required');
 const count=tokenizer.count,contextBounds=tokenizer.sourceBoundaries(recordContext);
 let context='';
 for(const b of contextBounds){if(b.tokenEndOrdinal>64)break;const candidate=recordContext.slice(0,b.offsetUtf16);if(count(candidate)<=64)context=candidate;}
 const contextTokens=count(context),input=(value:string)=>context?`${context}\n\n${value}`:value;
 const offsets=tokenizer.sourceBoundaries(text);
 if(offsets[0]?.offsetUtf16!==0||offsets.at(-1)?.offsetUtf16!==text.length||offsets.some((b,i)=>isSplit(text,b.offsetUtf16)||(i>0&&(b.offsetUtf16<=offsets[i-1]!.offsetUtf16||b.tokenEndOrdinal<offsets[i-1]!.tokenEndOrdinal))))throw new Error('invalid v2 tokenizer source boundaries');
 const windows:SpanWindow[]=[];
 let startIndex=0,previousEnd=0,actualOverlap=0;
 while(startIndex<offsets.length-1) {
  const start=offsets[startIndex]!,capacity=382-contextTokens;
  let endIndex=startIndex+1;
  while(endIndex<offsets.length-1&&offsets[endIndex+1]!.tokenEndOrdinal-start.tokenEndOrdinal<=capacity)endIndex++;
  while(endIndex>startIndex&&count(input(text.slice(start.offsetUtf16,offsets[endIndex]!.offsetUtf16)))>382)endIndex--;
  if(endIndex===startIndex)throw new Error('v2 window cannot fit384 tokens including specials');
  // The source ordinal estimate may undershoot because a detached substring
  // tokenizes differently. Every accepted complete input is independently counted.
  while(endIndex<offsets.length-1&&count(input(text.slice(start.offsetUtf16,offsets[endIndex+1]!.offsetUtf16)))<=382)endIndex++;
  const maxEnd=offsets[endIndex]!.offsetUtf16;
  const newline=text.lastIndexOf('\n',maxEnd-1)+1;
  if(newline>offsets[Math.floor((startIndex+endIndex)/2)]!.offsetUtf16) {
   const candidate=offsets.findIndex(b=>b.offsetUtf16===newline);
   if(candidate>startIndex&&offsets[candidate]!.offsetUtf16>previousEnd&&offsets[candidate]!.tokenEndOrdinal-start.tokenEndOrdinal>32&&count(input(text.slice(start.offsetUtf16,newline)))<=382)endIndex=candidate;
  }
  const end=offsets[endIndex]!;
  if(end.offsetUtf16<=previousEnd)throw new Error('v2 window must advance');
  const value=text.slice(start.offsetUtf16,end.offsetUtf16);
  if(count(input(value))>382)throw new Error('v2 wordpiece window exceeds384 including specials');
  windows.push({startUtf16:start.offsetUtf16,endUtf16:end.offsetUtf16,text:value,chunkPolicy:policy,embeddingInputHash:hash(input(value)),embeddingContextJson:JSON.stringify({tokenizerId:tokenizer.id,tokenizerHash:tokenizer.assetHash,context,contextTokens,recipe:SPAN_CONTEXT_RECIPE,targetSourceOverlap:32,actualSourceOverlap:actualOverlap,sourceOverlapRounding:Math.max(0,actualOverlap-32),sourceTokenStart:start.tokenEndOrdinal,sourceTokenEnd:end.tokenEndOrdinal}),isPartition:false});
  previousEnd=end.offsetUtf16;
  if(endIndex===offsets.length-1)break;
  const target=end.tokenEndOrdinal-32;
  let nextIndex=endIndex-1;
  while(nextIndex>0&&offsets[nextIndex]!.tokenEndOrdinal>target)nextIndex--;
  if(nextIndex<=startIndex)throw new Error('v2 overlap cannot make forward progress');
  actualOverlap=end.tokenEndOrdinal-offsets[nextIndex]!.tokenEndOrdinal;
  startIndex=nextIndex;
 }
 const coveragePartitions=deriveCoveragePartitions(windows,text);
 return {policy,manifestVersion:SPAN_MANIFEST_VERSION,windows,coveragePartitions};
}
export function deriveCoveragePartitions(windows:SpanWindow[],expectedText:string,requireOverlap=true):CoveragePartition[] {
 let frontier=0,assembled='';const coverage:CoveragePartition[]=[];
 for(const [windowOrdinal,w] of windows.entries()) {
  if(w.startUtf16<0||w.startUtf16>frontier||w.endUtf16<=frontier||w.endUtf16-w.startUtf16!==w.text.length||w.text!==expectedText.slice(w.startUtf16,w.endUtf16)||isSplit(expectedText,w.startUtf16)||isSplit(expectedText,w.endUtf16))throw new Error('invalid v2 source coverage');
  if(windowOrdinal>0&&(w.startUtf16<=windows[windowOrdinal-1]!.startUtf16||(requireOverlap&&w.startUtf16>=frontier)))throw new Error('invalid v2 window progress');
  const relativeStartUtf16=frontier-w.startUtf16,relativeEndUtf16=w.text.length;
  if(assembled.slice(w.startUtf16)!==w.text.slice(0,relativeStartUtf16))throw new Error('v2 overlap mismatch');
  coverage.push({startUtf16:frontier,endUtf16:w.endUtf16,windowOrdinal,relativeStartUtf16,relativeEndUtf16});
  assembled+=w.text.slice(relativeStartUtf16);frontier=w.endUtf16;
 }
 if(frontier!==expectedText.length||assembled!==expectedText)throw new Error('v2 unit reconstruction mismatch');
 return coverage;
}
/** Canonical v2 serialization commits the policy even for an empty source. */
export function spanManifestHash(policy:string,units:{id:string;manifest:SpanManifest}[]):string {
 return hash(JSON.stringify({manifestVersion:SPAN_MANIFEST_VERSION,policy,units:units.map(({id,manifest})=>({id,coverage:manifest.coveragePartitions,retrieval:manifest.windows.map(w=>({startUtf16:w.startUtf16,endUtf16:w.endUtf16,policy:w.chunkPolicy,sourceOverlap:JSON.parse(w.embeddingContextJson).actualSourceOverlap??0,sourceOverlapRounding:JSON.parse(w.embeddingContextJson).sourceOverlapRounding??0}))}))}));
}
export function hasCurrentSpanManifest(gapsJson:string|null|undefined,tokenizer?:Pick<SpanTokenizer,'assetHash'>):boolean {
 if(!gapsJson)return false;
 try {const gaps=JSON.parse(gapsJson);return gaps!==null&&typeof gaps==='object'&&!Array.isArray(gaps)&&gaps.chunkPolicy===currentSpanPolicy(tokenizer)&&gaps.manifestVersion===SPAN_MANIFEST_VERSION;}catch{return false;}
}
