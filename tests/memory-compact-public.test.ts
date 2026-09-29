import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { spawnSync } from 'node:child_process';import { createRequire } from 'node:module';import { createHash } from 'node:crypto';
import { open } from '../packages/core/src/db.js';
import { publishSource, readSpan } from '../packages/core/src/memory/source.js';
import { hash } from '../packages/core/src/memory/spans.js';
import { countTokens, defaultBudget } from '../packages/core/src/memory/budget.js';
import { decodeCompactMemoryPacket, canonicalPacketRef } from '../packages/core/src/memory/packet.js';
import { decodeCursor } from '../packages/core/src/memory/context.js';
import type { EvidenceItem, MemoryResponse, SpanRef } from '../packages/core/src/memory/contracts.js';
import type { ParseResult } from '../packages/core/src/adapters/types.js';

const roots:string[]=[];const observations:Record<string,unknown>[]=[];
const driver=process.env['POTSHERD_SQLITE']??'node';
const env={...process.env,POTSHERD_SQLITE:driver,POTSHERD_OFFLINE:'1'};
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
afterAll(()=>{const receipt=process.env['POTSHERD_COMPACT_RECEIPTS'];if(receipt){fs.mkdirSync(receipt,{recursive:true});fs.writeFileSync(path.join(receipt,`${driver}-public-emissions.json`),JSON.stringify({classification:'public synthetic model-free CLI/stdio MCP observations; not Stage A/B/C',driver,observations},null,2)+'\n');}});
function fixture(empty=false,longSpan=false):string {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'potsherd-compact-owned-'));roots.push(root);if(empty)return root;
 const db=open({root});
 const records:NonNullable<ParseResult['records']>=[{unitKey:'assistant',role:'assistant',text:'cache.X_9 configured 日本語 😀\n'+'bounded source context '.repeat(70),eventAt:'2026-09-01T00:00:00Z',timeBasis:'record',project:'/toy',locator:{recordKey:'assistant',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'assistant'}, {unitKey:'user',role:'user',text:'Please inspect cache.X_9; this recorded request is not completion.',eventAt:null,timeBasis:'unknown',project:'/toy',locator:{recordKey:'user',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'user'}];
 // Declared toy geometry only, deliberately dense transport text; no BGE/model quality claim.
 if(longSpan)records[0]!.text+='encoded_payload:'+'xYz_9日本語😀'.repeat(120);
 const parsed:ParseResult={session:{id:'compact-toy-native',harness:'claude',sourcePath:'/public-toy/native',project:'/toy',projectSlug:'toy',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:1,assistantTurns:1,toolCalls:0,bytes:10},status:'live'},exchanges:[],unknownTypes:{},endOffset:10,malformedLines:0,evidenceVersion:'public-toy-v1',records};
 const tokenEnds=(text:string)=>[0,...Array.from(text.matchAll(/\S+\s*/gu),m=>m.index+m[0].length)];
 const tokenizer=longSpan?{id:'public-toy-whitespace-only',assetHash:hash('public-toy-tokenizer'),count:(text:string)=>text.match(/\S+/gu)?.length??0,boundaries:tokenEnds,sourceBoundaries:(text:string)=>tokenEnds(text).map((offsetUtf16,tokenEndOrdinal)=>({offsetUtf16,tokenEndOrdinal}))}:undefined;
 publishSource(db,{parsed,artifactHash:hash('public-toy-raw'),artifactBytes:14,...(tokenizer?{tokenizer}:{})});db.prepare("UPDATE maintenance_jobs SET state='done'").run();db.close();return root;
}
function parsedBody(text:string):MemoryResponse|{error?:string} {
 const body=JSON.parse(text);return body.packetFormat==='compact-v1'?decodeCompactMemoryPacket(body):body;
}
function observe(surface:string,tool:string,format:string,raw:string,budget:ReturnType<typeof defaultBudget>,status?:number|null,requestInput?:Record<string,unknown>):MemoryResponse|{error?:string} {
 const outer=JSON.parse(raw);const text=surface==='mcp'?outer.content[0].text:raw;const body=parsedBody(text);const tokens=countTokens(raw),bytes=Buffer.byteLength(raw);
 expect(tokens).toBeLessThanOrEqual(Math.min(budget.maxTokens,budget.remainingJourneyTokens??budget.maxTokens));expect(bytes).toBeLessThanOrEqual(budget.maxBytes!);
 if('evidence' in body){expect(body.budget.usedTokens).toBe(tokens);expect(body.budget.remainingTokens).toBe(Math.max(0,Math.min(budget.maxTokens,budget.remainingJourneyTokens??budget.maxTokens)-tokens));}
 observations.push({surface,tool,format,requestInput,requestedBudget:budget,status:status??null,tokens,bytes,rawSha256:createHash('sha256').update(raw).digest('hex'),raw,receipt:'evidence' in body?body.budget:undefined});
 return body;
}
function cli(root:string,verb:string,input:Record<string,unknown>,format:string,budget=defaultBudget(8192)) {
 const requestInput={...input,budget,...(format==='default'?{}:{responseFormat:format})};
 const child=spawnSync(process.execPath,[path.resolve('packages/cli/bin/potsherd.js'),'--potsherd-dir',root,verb,'--input-json',JSON.stringify(requestInput)],{encoding:'utf8',env,timeout:15000});
 if(child.error)throw child.error;expect(child.stdout.endsWith('\n')).toBe(true);
 return {status:child.status,raw:child.stdout,body:observe('cli',verb,format,child.stdout,budget,child.status,requestInput)};
}
async function mcp(root:string) {
 const require=createRequire(path.resolve('packages/mcp/package.json'));
 const {Client}=require('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
 const client=new Client({name:'public-compact-control',version:'1'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('packages/mcp/dist/index.js'),'--potsherd-dir',root],env,stderr:'pipe'});
 const launched=performance.now(),instance=observations.filter(x=>x.classification==='mcp-lifecycle').length+1;
 const lifecycle:Record<string,unknown>={classification:'mcp-lifecycle',instance,driver,phases:[],stderr:''};observations.push(lifecycle);
 const phases=lifecycle.phases as Record<string,unknown>[];
 const record=(phase:string,started:number,extra:Record<string,unknown>={})=>phases.push({phase,ms:performance.now()-started,...extra});
 transport.stderr?.on('data',(chunk:Buffer)=>{lifecycle.stderr=String(lifecycle.stderr).concat(chunk.toString()).slice(-8192);});
 await client.connect(transport);record('connect',launched);
 const processHandle=transport._process;let closingAt=0;
 processHandle?.stdout?.once('end',()=>record('stdout_eof',closingAt||launched));
 processHandle?.stdin?.once('finish',()=>record('stdin_eof_sent',closingAt||launched));
 processHandle?.once('exit',(code:number|null,signal:string|null)=>record('process_exit',closingAt||launched,{code,signal}));
 const originalCall=client.callTool.bind(client);client.callTool=async(...args:any[])=>{const at=performance.now();try{return await originalCall(...args);}finally{record(args[0]?.name==='potsherd_write'?'write':'request',at,{tool:args[0]?.name});}};
 return {client,async call(tool:string,input:Record<string,unknown>,format:string,budget=defaultBudget(8192)){
  const requestInput={...input,budget,...(format==='default'?{}:{responseFormat:format})};
  const result=await client.callTool({name:tool,arguments:requestInput});expect(result.structuredContent).toBeUndefined();expect(result.content).toHaveLength(1);expect(Object.keys(result)).toEqual(['content']);
  return {raw:JSON.stringify(result),body:observe('mcp',tool,format,JSON.stringify(result),budget,undefined,requestInput)};
 },async close(){closingAt=performance.now();await client.close();await transport.close();record('close',closingAt);record('process_total',launched);}};
}
function semanticOnly(response:any):unknown { const copy=structuredClone(response);delete copy.requestId;delete copy.budget;return copy; }
const refKey=(ref:SpanRef):string=>`${ref.sourceId}:${ref.revisionId}:${ref.spanId}`;
function diagnoseRead(surface:string,format:string,limit:number,raw:string,body:MemoryResponse|{error?:string},original:EvidenceItem):void {
 const successful='evidence' in body;const evidence=successful?body.evidence:[],candidates=successful?body.candidates:[];
 const cursor=successful&&body.continuation?decodeCursor(body.continuation):undefined;
 for(const item of evidence){expect(item.ref).toEqual(original.ref);expect(item.text).toBe(original.text.slice(item.startUtf16-original.startUtf16,item.endUtf16-original.startUtf16));}
 let marginal=0;
 if(cursor){const outer=JSON.parse(raw),inner=surface==='mcp'?JSON.parse(outer.content[0].text):outer;delete (inner.packetFormat==='compact-v1'?inner.response:inner).continuation;const counterfactual=surface==='mcp'?JSON.stringify({content:[{type:'text',text:JSON.stringify(inner)}]}):JSON.stringify(inner)+'\n';marginal=countTokens(raw)-countTokens(counterfactual);}
 const key=refKey(original.ref),delivered=evidence.some(e=>refKey(e.ref)===key),candidate=candidates.some(c=>refKey(c.ref)===key),inCursor=Boolean(cursor?.positions.some(p=>refKey(p.ref)===key));
 observations.push({classification:'toy read envelope/cursor diagnosis; no policy threshold',surface,format,limit,usedTokens:countTokens(raw),exactSourceCharacters:evidence.reduce((n,e)=>n+e.text.length,0),usableExactSourceRead:delivered&&evidence.some(e=>e.text.length>0),continuationCharacters:successful?body.continuation?.length??0:0,continuationMarginalTokens:marginal,marginalMethod:'remove continuation only, retaining original receipt digits; non-additive analysis, not valid replacement output',refInEvidence:delivered,refInCandidates:candidate,refInCursor:inCursor,refLostFromPacket:!delivered&&!candidate&&!inCursor,state:successful?body.coverage.state:'budget_error',warnings:successful?body.warnings:undefined});
}

describe(`public compact emitters (${driver}; no model calls)`,()=>{
 it('captures CLI compact/default accounting and ordinary immutable reads across process restarts',()=>{
  const root=fixture(),input={query:'cache.X_9',mode:'literal',scope:{project:'/toy'}};
  const compact=cli(root,'find',input,'compact-v1'),full=cli(root,'find',input,'default');expect(compact.status).toBe(0);expect(full.status).toBe(0);
  expect(semanticOnly(compact.body)).toEqual(semanticOnly(full.body));const packet=JSON.parse(compact.raw);expect(packet.packetFormat).toBe('compact-v1');const ref=canonicalPacketRef(packet,0);
  const expectedDb=open({root});const expected=readSpan(expectedDb,ref);expectedDb.close();expect(expected).not.toBeNull();expected!.citation=`span:${ref.sourceId}:${ref.revisionId}:${ref.spanId}@${expected!.startUtf16}-${expected!.endUtf16}`;
  const read=cli(root,'show',{refs:[ref],scope:{project:'/toy'}},'compact-v1');expect(read.status).toBe(0);if('evidence' in read.body)expect(read.body.evidence[0]).toEqual(expected);
  const graft=cli(root,'graft',{refs:[ref],scope:{project:'/toy'}},'compact-v1');expect(semanticOnly(graft.body)).toEqual(semanticOnly(read.body));
  const invalid=cli(root,'find',input,'future',defaultBudget(128));expect(invalid.status).toBe(1);if('evidence' in invalid.body)expect(invalid.body.warnings).toContain('unsupported_response_format');
  const tiny=cli(root,'find',input,'compact-v1',{...defaultBudget(64),maxBytes:256});expect(tiny.status).toBe(1);expect(tiny.body).toEqual({error:'budget_too_small'});
 });
 it('captures actual stdio MCP accounting, interleaved formats, canonical restart reads and expanded writes',async()=>{
  const root=fixture(),input={query:'cache.X_9',mode:'literal',scope:{project:'/toy'}};let server=await mcp(root);
  try {
   const [compact,full]=await Promise.all([server.call('potsherd_recall',input,'compact-v1'),server.call('potsherd_recall',input,'default')]);expect(semanticOnly(compact.body)).toEqual(semanticOnly(full.body));
   const packet=JSON.parse(JSON.parse(compact.raw).content[0].text);expect(packet.packetFormat).toBe('compact-v1');const ref=canonicalPacketRef(packet,0);
   const again=await server.call('potsherd_recall',input,'default');expect(JSON.parse(JSON.parse(again.raw).content[0].text).packetFormat).toBeUndefined();
   const read=await server.call('potsherd_read',{refs:[ref],scope:{project:'/toy'}},'compact-v1');const graft=await server.call('potsherd_graft',{refs:[ref],scope:{project:'/toy'}},'compact-v1');expect(semanticOnly(graft.body)).toEqual(semanticOnly(read.body));
   const legacyGraft=await server.call('potsherd_graft',{thread:'compact-toy-native',scope:{project:'/toy'}},'compact-v1');expect(JSON.parse(JSON.parse(legacyGraft.raw).content[0].text).packetFormat).toBe('compact-v1');
   const invalid=await server.call('potsherd_recall',input,'future',defaultBudget(128));expect(invalid.body).toEqual({error:'budget_too_small'});
   for(const responseFormat of [null,17,{format:'compact-v1'}]){
    const requestedBudget=defaultBudget(64),requestInput={...input,budget:requestedBudget,responseFormat};
    const rejected=await server.client.callTool({name:'potsherd_recall',arguments:requestInput});const raw=JSON.stringify(rejected);
    expect(rejected.isError).toBeUndefined();expect(observe('mcp','potsherd_recall','unsupported-selector-handler',raw,requestedBudget,undefined,requestInput)).toEqual({error:'budget_too_small'});
   }
   const sdkInput={query:17,scope:{project:'/toy'},responseFormat:'compact-v1',budget:defaultBudget(64)};
   const sdkRejected=await server.client.callTool({name:'potsherd_recall',arguments:sdkInput});expect(sdkRejected.isError).toBe(true);
   observations.push({classification:'existing SDK input rejection before handler; not controlled by product finalizer, caller must count actual result',surface:'mcp',tool:'potsherd_recall',requestInput:sdkInput,requestedBudget:sdkInput.budget,raw:JSON.stringify(sdkRejected),tokens:countTokens(JSON.stringify(sdkRejected)),bytes:Buffer.byteLength(JSON.stringify(sdkRejected)),productBudgetReceipt:false});
   const malformed=await server.call('potsherd_read',{refs:[{sourceId:ref.sourceId,revisionId:ref.revisionId,spanId:ref.spanId,unitIndex:0}],scope:{project:'/toy'}},'compact-v1');if('evidence' in malformed.body){expect(malformed.body.evidence).toEqual([]);expect(malformed.body.warnings).toContain('invalid_memory_input');}
   const write=await server.client.callTool({name:'potsherd_write',arguments:{requestKey:'public-toy-write',scope:{project:'/toy'},entries:[{kind:'observation',text:'unverified author assertion'}],budget:defaultBudget()}});const receipt=JSON.parse(write.content[0].text);expect(receipt.packetFormat).toBeUndefined();expect(receipt.budget.usedTokens).toBe(countTokens(JSON.stringify(write)));observations.push({surface:'mcp',tool:'potsherd_write',format:'expanded-v2',tokens:receipt.budget.usedTokens,raw:JSON.stringify(write)});
   await server.close();server=await mcp(root);const restarted=await server.call('potsherd_read',{refs:[ref],scope:{project:'/toy'}},'compact-v1');if('evidence' in restarted.body&&'evidence' in read.body)expect(restarted.body.evidence).toEqual(read.body.evidence);
  }finally{await server.close();}
 });
 it('bounds unavailable stores and schema/read failures without asserting absence',async()=>{
  const empty=fixture(true);const cliEmpty=cli(empty,'find',{query:'cache.X_9',mode:'literal',scope:{}},'compact-v1');expect(cliEmpty.status).toBe(1);if('evidence' in cliEmpty.body)expect(cliEmpty.body.coverage.state).toBe('unavailable');
  let server=await mcp(empty);try{const unavailable=await server.call('potsherd_recall',{query:'cache.X_9',mode:'literal',scope:{}},'compact-v1');if('evidence' in unavailable.body){expect(unavailable.body.coverage.state).toBe('unavailable');expect(unavailable.body.support.state).toBe('insufficient');}}finally{await server.close();}
  const root=fixture();server=await mcp(root);try{
   const invalidCursor=await server.call('potsherd_read',{cursor:'not_valid_cursor',scope:{}},'compact-v1');if('evidence' in invalidCursor.body){expect(invalidCursor.body.coverage.state).toBe('unavailable');expect(invalidCursor.body.warnings).toContain('read_failed');}
   const db=open({root});db.prepare('DELETE FROM schema_migrations WHERE version=18').run();db.close();
   const schema=await server.call('potsherd_recall',{query:'cache.X_9',mode:'literal',scope:{}},'compact-v1');if('evidence' in schema.body)expect(schema.body.coverage.state).toBe('upgrade_required');
   const cliSchema=cli(root,'show',{legacyRef:{sessionId:'compact-toy-native'},scope:{}},'compact-v1');expect(cliSchema.status).toBe(1);if('evidence' in cliSchema.body)expect(cliSchema.body.coverage.state).toBe('upgrade_required');
  }finally{await server.close();}
 });
 it('diagnoses actual read/cursor envelope costs and ref loss on the same public long span without changing policy',async()=>{
  const root=fixture(false,true);const db=open({root});const source=db.prepare('SELECT r.source_id,r.revision_id,p.span_id FROM revision_spans p JOIN source_revisions r ON r.revision_id=p.revision_id JOIN evidence_spans e ON e.span_id=p.span_id JOIN evidence_units u ON u.unit_revision_id=e.unit_revision_id WHERE u.unit_key=? ORDER BY p.ordinal LIMIT 1').get('assistant') as {source_id:string;revision_id:string;span_id:string};
  const ref={sourceId:source.source_id,revisionId:source.revision_id,spanId:source.span_id};const original=readSpan(db,ref)!;db.close();expect(original.text.length).toBeGreaterThan(500);
  observations.push({classification:'source-instrumented public toy fixture construction; fake whitespace tokenizer, zero models, no real-corpus/semantic quality claim',sourceRef:ref,expectedEvidence:original,artifactInput:'public-toy-raw',artifactBytes:14,tokenizerId:'public-toy-whitespace-only',tokenizerHash:hash('public-toy-tokenizer')});
  const server=await mcp(root);try{
   for(const format of ['expanded-v2','compact-v1'])for(const limit of [64,640,1024,1400,8192]){
    const budget=defaultBudget(limit),input={refs:[ref],scope:{project:'/toy'}};
    const c=cli(root,'show',input,format,budget);diagnoseRead('cli',format,limit,c.raw,c.body,original);
    const m=await server.call('potsherd_read',input,format,budget);diagnoseRead('mcp',format,limit,m.raw,m.body,original);
    if(limit===640){
     for(const [surface,initial] of [['cli',c],['mcp',m]] as const){
      if('evidence' in initial.body&&initial.body.continuation){
       const cursor=initial.body.continuation,repeatInput={cursor,scope:{project:'/toy'}};
       const repeated=surface==='cli'?cli(root,'show',repeatInput,format,budget):await server.call('potsherd_read',repeatInput,format,budget);
       diagnoseRead(surface,format,limit,repeated.raw,repeated.body,original);
       const repeatBody=repeated.body;const advanced='evidence' in repeatBody&&(repeatBody.evidence.some(e=>e.endUtf16>original.startUtf16)||repeatBody.continuation!==cursor);
       expect(advanced).toBe(false);
       observations.push({classification:'existing no-progress cursor on nonempty targeted source; separate policy defect, not usable read/codec delivery success',surface,format,limit,sourceRef:ref,requestedNonemptySourceCharacters:original.text.length,initialCursor:cursor,returnedSameCursor:'evidence' in repeatBody&&repeatBody.continuation===cursor,advanced,emptyEof:false,metadataOnlySource:false});
      }
     }
    }
   }
   for(const format of ['expanded-v2','compact-v1']){
    const input={query:'cache.X_9',mode:'literal',scope:{project:'/toy'}};const full=await server.call('potsherd_recall',input,format);expect('evidence' in full.body).toBe(true);
    const limited=await server.call('potsherd_recall',input,format,defaultBudget(1024));const delivered='evidence' in limited.body?limited.body.evidence.map(e=>refKey(e.ref)):[],candidates='evidence' in limited.body?limited.body.candidates.map(c=>refKey(c.ref)):[];
    const cursor='evidence' in limited.body&&limited.body.continuation?decodeCursor(limited.body.continuation).positions.map(p=>refKey(p.ref)):[];
    observations.push({classification:'toy recall budget-removal navigation diagnosis; no retention policy change',surface:'mcp',format,limit:1024,refs:('evidence' in full.body?full.body.evidence:[]).map(e=>({ref:e.ref,delivered:delivered.includes(refKey(e.ref)),inCandidates:candidates.includes(refKey(e.ref)),inCursor:cursor.includes(refKey(e.ref)),lostFromPacket:![...delivered,...candidates,...cursor].includes(refKey(e.ref))}))});
   }
  }finally{await server.close();}
 },20000);
});
