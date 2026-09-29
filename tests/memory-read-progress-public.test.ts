import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { spawnSync } from 'node:child_process';import { createRequire } from 'node:module';import { createHash } from 'node:crypto';
import { open } from '../packages/core/src/db.js';
import { publishSource, readSpan } from '../packages/core/src/memory/source.js';
import { hash } from '../packages/core/src/memory/spans.js';
import { LocalMemoryService } from '../packages/core/src/memory/service.js';
import { writeMemoryNotes } from '../packages/core/src/memory/notes-store.js';
import { encodeCursor, decodeCursor } from '../packages/core/src/memory/context.js';
import { countTokens, defaultBudget } from '../packages/core/src/memory/budget.js';
import { decodeCompactMemoryPacket } from '../packages/core/src/memory/packet.js';
import type { MemoryResponse, SpanRef } from '../packages/core/src/memory/contracts.js';
import type { ParseResult } from '../packages/core/src/adapters/types.js';

const driver=process.env['POTSHERD_SQLITE']??'node';const env={...process.env,POTSHERD_SQLITE:driver,POTSHERD_OFFLINE:'1'};
const roots:string[]=[];const observations:Record<string,unknown>[]=[];
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
afterAll(()=>{const output=process.env['POTSHERD_READ_PROGRESS_RECEIPTS'];if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,`${driver}-public-emissions.json`),JSON.stringify({classification:'read forward-progress synthetic controls only; no Stage A/B/C/model/corpus claim',driver,observations},null,2)+'\n');}});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'potsherd-read-progress-owned-'));roots.push(root);const db=open({root});
 const text='cache.X_9 configured 日本語 😀\n'+'bounded source context '.repeat(70)+'encoded_payload:'+'xYz_9日本語😀'.repeat(120);
 const records:NonNullable<ParseResult['records']>=[{unitKey:'assistant',role:'assistant',text,eventAt:'2026-09-01T00:00:00Z',timeBasis:'record',project:'/toy',locator:{recordKey:'assistant',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'assistant'},{unitKey:'user',role:'user',text:'Please inspect cache.X_9; this recorded request is not completion.',eventAt:null,timeBasis:'unknown',project:'/toy',locator:{recordKey:'user',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'user'}];
 const parsed:ParseResult={session:{id:'compact-toy-native',harness:'claude',sourcePath:'/public-toy/native',project:'/toy',projectSlug:'toy',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:1,assistantTurns:1,toolCalls:0,bytes:10},status:'live'},exchanges:[],unknownTypes:{},endOffset:10,malformedLines:0,evidenceVersion:'public-toy-v1',records};
 const ends=(value:string)=>[0,...Array.from(value.matchAll(/\S+\s*/gu),m=>m.index+m[0].length)];
 const published=publishSource(db,{parsed,artifactHash:hash('public-toy-raw'),artifactBytes:14,tokenizer:{id:'public-toy-whitespace-only',assetHash:hash('public-toy-tokenizer'),count:value=>value.match(/\S+/gu)?.length??0,boundaries:ends,sourceBoundaries:value=>ends(value).map((offsetUtf16,tokenEndOrdinal)=>({offsetUtf16,tokenEndOrdinal}))}});
 const rows=db.prepare('SELECT p.span_id,u.unit_key FROM revision_spans r JOIN evidence_spans p ON p.span_id=r.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id WHERE r.revision_id=? ORDER BY r.ordinal').all(published.revisionId) as {span_id:string;unit_key:string}[];
 const ref={sourceId:published.sourceId,revisionId:published.revisionId,spanId:rows.find(row=>row.unit_key==='assistant')!.span_id};
 const other={...ref,spanId:rows.find(row=>row.unit_key==='user')!.span_id};const original=readSpan(db,ref)!;
 db.prepare("UPDATE maintenance_jobs SET state='done'").run();const coverage=new LocalMemoryService(db,{semanticDisabled:true}).inspect({project:'/toy'});db.close();
 observations.push({classification:'source-instrumented synthetic fixture construction, declared fake whitespace tokenizer, zero real models',ref,other,expectedEvidence:original,tokenizerId:'public-toy-whitespace-only',tokenizerHash:hash('public-toy-tokenizer'),artifactInput:'public-toy-raw'});
 return {root,ref,other,original,scope:{project:'/toy'},epochs:coverage.snapshotEpochs};
}
function body(raw:string,surface:string):MemoryResponse|{error?:string} {const outer=JSON.parse(raw),value=surface==='mcp'?JSON.parse(outer.content[0].text):outer;return value.packetFormat==='compact-v1'?decodeCompactMemoryPacket(value):value;}
function record(surface:string,raw:string,input:Record<string,unknown>,status?:number|null){
 const budget=input.budget as ReturnType<typeof defaultBudget>,tokens=countTokens(raw),bytes=Buffer.byteLength(raw);expect(tokens).toBeLessThanOrEqual(Math.min(budget.maxTokens,budget.remainingJourneyTokens??budget.maxTokens));expect(bytes).toBeLessThanOrEqual(budget.maxBytes!);
 const decoded=body(raw,surface);if('evidence' in decoded)expect(decoded.budget.usedTokens).toBe(tokens);
 observations.push({surface,requestInput:input,status:status??null,raw,rawSha256:createHash('sha256').update(raw).digest('hex'),tokens,bytes});return decoded;
}
function cli(root:string,input:Record<string,unknown>){const result=spawnSync(process.execPath,[path.resolve('packages/cli/bin/potsherd.js'),'--potsherd-dir',root,'show','--input-json',JSON.stringify(input)],{encoding:'utf8',env,timeout:15000});if(result.error)throw result.error;expect(result.stdout.endsWith('\n')).toBe(true);return {status:result.status,body:record('cli',result.stdout,input,result.status)};}
async function mcp(root:string){const require=createRequire(path.resolve('packages/mcp/package.json'));const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');const client=new Client({name:'read-progress-public-control',version:'1'},{capabilities:{}});const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('packages/mcp/dist/index.js'),'--potsherd-dir',root],env,stderr:'pipe'});await client.connect(transport);return {async call(input:Record<string,unknown>){const value=await client.callTool({name:'potsherd_read',arguments:input});expect(value.isError).toBeUndefined();expect(Object.keys(value)).toEqual(['content']);return record('mcp',JSON.stringify(value),input);},async close(){await client.close();await transport.close();}};}
function oldCursor(f:ReturnType<typeof fixture>,historical=true,startUtf16=f.original.startUtf16){return encodeCursor({version:1,kind:'memory_read',scope:f.scope,epochs:f.epochs,historical,positions:[{ref:f.ref,startUtf16}]});}
function prove(response:MemoryResponse|{error?:string},f:ReturnType<typeof fixture>):asserts response is MemoryResponse {
 if(!('evidence' in response))throw new Error('viable control needs delivered range');expect(response.evidence.length).toBeGreaterThan(0);
 for(const item of response.evidence)if(item.ref.spanId===f.ref.spanId){expect(item.text).toBe(f.original.text.slice(item.startUtf16-f.original.startUtf16,item.endUtf16-f.original.startUtf16));expect(item.text.length).toBeGreaterThan(0);expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(item.text)).toBe(false);}
}
describe(`actual read forward-progress controls (${driver})`,()=>{
 it.each(['expanded-v2','compact-v1'])('turns the same low-budget source/cursor into bounded failure and recovers exact partial/full reads (%s)',async responseFormat=>{
  const f=fixture(),server=await mcp(f.root);try{
   const input={refs:[f.ref],scope:f.scope,budget:defaultBudget(640),responseFormat};const c=cli(f.root,input);expect(c.status).toBe(1);expect(c.body).toEqual({error:'budget_too_small'});expect(await server.call(input)).toEqual({error:'budget_too_small'});
   const cursor=oldCursor(f);const repeating={cursor,scope:f.scope,budget:defaultBudget(640),responseFormat};for(let i=0;i<2;i++){expect(cli(f.root,repeating).body).toEqual({error:'budget_too_small'});expect(await server.call(repeating)).toEqual({error:'budget_too_small'});}
   const slicedCursor=oldCursor(f,true,19);const sliced={cursor:slicedCursor,scope:f.scope,budget:defaultBudget(640),responseFormat};expect(await server.call(sliced)).toEqual({error:'budget_too_small'});
   const partialInput={...repeating,budget:defaultBudget(1400)};const cp=cli(f.root,partialInput);expect(cp.status).toBe(0);prove(cp.body,f);const mp=await server.call(partialInput);prove(mp,f);expect(cp.body.continuation).toBeTruthy();expect(mp.continuation).toBeTruthy();
   const resumed=await server.call({cursor:mp.continuation,scope:f.scope,budget:defaultBudget(8192),responseFormat});prove(resumed,f);expect(resumed.evidence[0]!.startUtf16).toBe(mp.evidence[0]!.endUtf16);expect(resumed.evidence[0]!.endUtf16).toBe(f.original.endUtf16);
   const complete=await server.call({...input,budget:defaultBudget(8192)});prove(complete,f);expect(complete.evidence[0]!.text).toBe(f.original.text);expect(complete.continuation).toBeUndefined();
  }finally{await server.close();}
 },15000);
 it.each(['expanded-v2','compact-v1'])('preserves other-ref/note progress, explicit source/scope/reset failures and cancellation (%s)',async responseFormat=>{
  const f=fixture(),server=await mcp(f.root);try{
   const multiple=await server.call({refs:[f.ref,f.other],scope:f.scope,budget:defaultBudget(2100),responseFormat});prove(multiple,f);expect(multiple.evidence.some(item=>item.ref.spanId===f.other.spanId)).toBe(true);
   const db=open({root:f.root});const receipt=writeMemoryNotes(db,{requestKey:'read-progress-note',scope:f.scope,entries:[{kind:'observation',text:'Explicit unverified public toy assertion'}],origin:'api'});db.close();
   const noted=await server.call({refs:[f.ref],noteIds:receipt.noteIds,scope:f.scope,budget:defaultBudget(1024),responseFormat});expect(noted.assertions).toHaveLength(1);expect(noted.evidence).toHaveLength(0);expect(noted.continuation).toBeTruthy();
   const eof=await server.call({scope:{},budget:defaultBudget(640),responseFormat});expect(eof.evidence).toEqual([]);expect(eof.continuation).toBeUndefined();
   const unavailable=await server.call({refs:[{...f.ref,spanId:hash('missing-public-span')}],scope:f.scope,budget:defaultBudget(),responseFormat});expect(unavailable.warnings).toContain('source_span_unavailable');expect(unavailable.coverage.state).toBe('partial');
   const wrongScope=await server.call({cursor:oldCursor(f),scope:{project:'/different'},budget:defaultBudget(),responseFormat});expect(wrongScope.warnings).toContain('read_failed');
   const currentCursor=oldCursor(f,false);const writer=open({root:f.root});writer.prepare('UPDATE memory_epochs SET evidence_epoch=evidence_epoch+1').run();writer.close();
   const reset=await server.call({cursor:currentCursor,scope:f.scope,budget:defaultBudget(),responseFormat});expect(reset.warnings).toContain('snapshot_changed');
   const local=open({root:f.root}),controller=new AbortController(),cancel=new Error('owned cancellation');const service=new LocalMemoryService(local,{transport:'mcp',sourceSelection:()=>{controller.abort(cancel);return undefined;}});
   expect(()=>service.read({refs:[f.ref],scope:f.scope,budget:defaultBudget(640),responseFormat},controller.signal)).toThrow(cancel);service.close();local.close();
   const recovered=await server.call({refs:[f.ref],scope:f.scope,budget:defaultBudget(8192),responseFormat});prove(recovered,f);
  }finally{await server.close();}
 },15000);
});
