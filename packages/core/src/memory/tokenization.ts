import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MODEL_ID, RUNTIME_SUBDIR, requiredFiles } from '../embeddings.js';

export type SourceBoundary = {offsetUtf16:number; tokenEndOrdinal:number};
export interface EvidenceTokenizer { id: string; assetHash: string; boundaries(text: string): number[]; sourceBoundaries(text:string):SourceBoundary[]; count(text: string): number }
type Tokenizer = { splitter_unnormalized:{split(text:string):string[]}; splitter_normalized:{split(text:string):string[]}; added_tokens_map:Map<string,{lstrip?:boolean;rstrip?:boolean}>; pre_tokenizer:((text:string,options:{section_index:number})=>string[])|null; model:(tokens:string[])=>string[]; normalizer: { normalize(text: string): string } | null; tokenize(text: string, options: {add_special_tokens: boolean}): string[]; encode(text: string, options: {add_special_tokens: boolean}): {ids:number[]} };

/** Synchronous public-asset readiness for discovery pipeline identity; no model load. */
export function inspectSpanTokenizerHash(cacheDir:string):string|null {
 const blobs:Buffer[]=[];
 for(const name of [`${MODEL_ID}/tokenizer.json`,`${MODEL_ID}/tokenizer_config.json`,`${RUNTIME_SUBDIR}/tokenizers.mjs`]) {
  const file=requiredFiles().find(asset=>asset.name===name)!;
  try {const bytes=fs.readFileSync(path.join(cacheDir,name));if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)return null;blobs.push(bytes);}catch{return null;}
 }
 return createHash('sha256').update(blobs[0]!).update(blobs[1]!).update(blobs[2]!).digest('hex');
}
/** Initialize only from hash-verified cached assets; never acquire assets on a read path. */
export async function loadSpanTokenizer(cacheDir: string): Promise<EvidenceTokenizer | null> {
  const names = [`${MODEL_ID}/tokenizer.json`, `${MODEL_ID}/tokenizer_config.json`, `${RUNTIME_SUBDIR}/tokenizers.mjs`];
  const blobs: Buffer[] = [];
  for (const name of names) {
    const file = requiredFiles().find((asset) => asset.name === name)!;
    let bytes: Buffer;
    try { bytes = fs.readFileSync(path.join(cacheDir, name)); } catch { return null; }
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return null;
    blobs.push(bytes);
  }
  const runtime = await import(pathToFileURL(path.join(cacheDir, names[2]!)).href) as { Tokenizer: new (spec: unknown, config: unknown) => Tokenizer };
  const tokenizer = new runtime.Tokenizer(JSON.parse(blobs[0]!.toString()), JSON.parse(blobs[1]!.toString()));
  const assetHash = createHash('sha256').update(blobs[0]!).update(blobs[1]!).update(blobs[2]!).digest('hex');
  return {
    id: 'bge-small-en-v1.5/wordpiece@0.1.3', assetHash,
    count: (text) => tokenizer.encode(text, {add_special_tokens:false}).ids.length,
    sourceBoundaries: (text) => sourceBoundaries(tokenizer,text),
    boundaries(text) {
      if (!text.length) return [0];
      // Preserve coordinates through lowercasing/accent stripping/CJK spacing.
      let normalized = '';
      const sourceEnds: number[] = [];
      let offset = 0;
      for(const run of text.matchAll(/[ -~]+|[^ -~]/gu)){
        const value=run[0],part=tokenizer.normalizer?.normalize(value)??value;
        if(/^[ -~]+$/u.test(value)&&part.length===value.length){normalized+=part;for(let i=1;i<=part.length;i++)sourceEnds.push(offset+i);offset+=value.length;}
        else for(const scalar of value){offset+=scalar.length;const piece=tokenizer.normalizer?.normalize(scalar)??scalar;normalized+=piece;for(let i=0;i<piece.length;i++)sourceEnds.push(offset);}
      }
      const tokens = tokenizer.tokenize(text, {add_special_tokens:false});
      const ends = [0];
      let cursor = 0;
      for (const token of tokens) {
        const piece = token.startsWith('##') ? token.slice(2) : token;
        if (piece === '[UNK]') {
          const rest = normalized.slice(cursor);
          const matched = rest.match(/^\s*([^\s]+)/u);
          cursor += matched?.[0].length ?? rest.length;
        } else {
          const at = normalized.indexOf(piece, cursor);
          if (at < 0) throw new Error('Tokenizer offset mapping is unavailable for this source');
          cursor = at + piece.length;
        }
        const end = sourceEnds[Math.max(0, cursor - 1)] ?? text.length;
        if (end > ends[ends.length - 1]!) ends.push(end);
      }
      // Assign trailing whitespace to the final piece without inventing a token.
      if (ends.length > 1) ends[ends.length - 1] = text.length;
      else ends.push(text.length);
      return ends;
    },
  };
}

/** V2 source coordinates only: the verified runtime still owns normalization and IDs.
 * In particular [UNK] consumes its PRETOKEN interval, not the remaining word.
 * The generated stream must match actual whole-input tokenization before any
 * source descriptor is exposed. V1's immutable geometry remains untouched.
 */
function sourceBoundaries(tokenizer:Tokenizer,text:string):SourceBoundary[] {
  if(!text.length)return [{offsetUtf16:0,tokenEndOrdinal:0}];
  const actual=tokenizer.tokenize(text,{add_special_tokens:false});
  const mappedTokens:string[]=[],tokenEnds:number[]=[];
  const fail=()=>{throw new Error('Tokenizer v2 source offset mapping is unavailable for this source');};
  let sectionOffset=0;
  for(const [section_index,section] of tokenizer.splitter_unnormalized.split(text).entries()) {
    if(tokenizer.added_tokens_map.has(section)) {mappedTokens.push(section);tokenEnds.push(sectionOffset+section.length);sectionOffset+=section.length;continue;}
    let normalized='',ends:number[]=[];let offset=sectionOffset;
    for(const run of section.matchAll(/[ -~]+|[^ -~]/gu)) {
      const value=run[0],part=tokenizer.normalizer?.normalize(value)??value;
      if(/^[ -~]+$/u.test(value)&&part.length===value.length) {
        normalized+=part;for(let i=1;i<=part.length;i++)ends.push(offset+i);offset+=value.length;
      } else for(const scalar of value) {
        offset+=scalar.length;const piece=tokenizer.normalizer?.normalize(scalar)??scalar;normalized+=piece;
        for(let i=0;i<piece.length;i++)ends.push(offset);
        if(!piece.length&&ends.length)ends[ends.length-1]=offset;
      }
    }
    if(normalized!==(tokenizer.normalizer?.normalize(section)??section))fail();
    let subsectionOffset=0;
    for(const subsection of tokenizer.splitter_normalized.split(normalized)) {
      if(tokenizer.added_tokens_map.has(subsection)) {mappedTokens.push(subsection);tokenEnds.push(ends[subsectionOffset+subsection.length-1]??offset);subsectionOffset+=subsection.length;continue;}
      const pretokens=tokenizer.pre_tokenizer?.(subsection,{section_index})??[subsection];let cursor=0;
      for(const pretoken of pretokens) {
        const at=subsection.indexOf(pretoken,cursor);
        if(at<0||subsection.slice(cursor,at).trim())fail();
        const pieces=tokenizer.model([pretoken]);let pieceCursor=0;
        for(const piece of pieces) {
          if(piece==='[UNK]') {if(pieces.length!==1)fail();pieceCursor=pretoken.length;}
          else {const value=piece.startsWith('##')?piece.slice(2):piece;if(pretoken.slice(pieceCursor,pieceCursor+value.length)!==value)fail();pieceCursor+=value.length;}
          mappedTokens.push(piece);tokenEnds.push(ends[subsectionOffset+at+pieceCursor-1]??offset);
        }
        if(pieceCursor!==pretoken.length)fail();cursor=at+pretoken.length;
      }
      if(subsection.slice(cursor).trim())fail();subsectionOffset+=subsection.length;
    }
    sectionOffset+=section.length;
  }
  if(mappedTokens.length!==actual.length||mappedTokens.some((token,i)=>token!==actual[i])||tokenizer.encode(text,{add_special_tokens:false}).ids.length!==actual.length)fail();
  const result:SourceBoundary[]=[{offsetUtf16:0,tokenEndOrdinal:0}];
  for(let i=0;i<tokenEnds.length;i++) {
    const end=tokenEnds[i]!;
    if(end<(tokenEnds[i-1]??0)||end>text.length||isSurrogateSplit(text,end))fail();
    if(end===(result.at(-1)?.offsetUtf16))result[result.length-1]!.tokenEndOrdinal=i+1;
    else result.push({offsetUtf16:end,tokenEndOrdinal:i+1});
  }
  // Whitespace/elided tails belong to the final token; zero-token units still
  // have exact source coverage and an ordinal of zero.
  if(result.length===1)result.push({offsetUtf16:text.length,tokenEndOrdinal:0});
  else result[result.length-1]!.offsetUtf16=text.length;
  // Newline ends in a verified whitespace gap are safe source coordinates
  // with the same preceding complete token ordinal. No token is invented.
  // This permits paragraph preference without changing the encoder stream.
  const lines:SourceBoundary[]=[];let boundaryIndex=0;
  for(const match of text.matchAll(/\n/gu)){const end=match.index+1;while(boundaryIndex+1<result.length&&result[boundaryIndex+1]!.offsetUtf16<=end)boundaryIndex++;const previous=result[boundaryIndex]!;if(previous.offsetUtf16<end&&!text.slice(previous.offsetUtf16,end).trim())lines.push({offsetUtf16:end,tokenEndOrdinal:previous.tokenEndOrdinal});}
  return [...result,...lines].sort((a,b)=>a.offsetUtf16-b.offsetUtf16);
}
function isSurrogateSplit(text:string,offset:number):boolean {return offset>0&&offset<text.length&&/[\uD800-\uDBFF]/u.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/u.test(text[offset]!);}
