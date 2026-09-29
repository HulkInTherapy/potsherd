import {openDatabase} from '../packages/core/src/sqlite-driver.js';
import {createRequire} from 'node:module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { open } from '../packages/core/src/db.js';
import { publishSource } from '../packages/core/src/memory/source.js';
import { hash } from '../packages/core/src/memory/spans.js';
import { countTokens, defaultBudget } from '../packages/core/src/memory/budget.js';
import { makeContext,closeMemoryService } from '../packages/mcp/src/context.js';
import { connectInMemory,callRaw } from '../packages/mcp/src/testing.js';
import type { ParseResult } from '../packages/core/src/adapters/types.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach((root)=>fs.rmSync(root,{recursive:true,force:true})));
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'p12-mcp-'));roots.push(root);const db=open({root});const parsed:ParseResult={session:{id:'native-memory',harness:'claude',sourcePath:'/synthetic/native',project:'/p',projectSlug:'p',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:0,assistantTurns:1,toolCalls:0,bytes:22},status:'live'},exchanges:[],unknownTypes:{},endOffset:22,malformedLines:0,evidenceVersion:'test-v1',records:[{unitKey:'record',role:'tool_result',text:'Exact cache.X_9 recovered',eventAt:null,timeBasis:'unknown',outcome:'success',project:'/p',locator:{recordKey:'record',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'tool_result'}]};publishSource(db,{parsed,artifactHash:hash('raw'),artifactBytes:3});db.close();return root;}
describe('actual canonical MCP surface',()=>{
 it('returns one measured JSON text block and exact immutable read refs without modifying the DB',async()=>{
  const root=fixture(),ctx=makeContext({potsherdDir:root,env:{}});const before=fs.readFileSync(path.join(root,'potsherd.db'));
  const {client,close}=await connectInMemory(ctx,'phase12-test');
  try {
   const result=await callRaw(client,'potsherd_recall',{query:'cache.X_9',mode:'literal',scope:{project:'/p'},budget:defaultBudget()});
   expect(result.structuredContent).toBeUndefined();expect(result.content).toHaveLength(1);
   const text=(result.content[0] as {type:'text';text:string}).text;const response=JSON.parse(text);
   expect(response.contractVersion).toBe(2);expect(response.evidence[0].role).toBe('tool_result');expect(response.evidence[0].toolOutcome).toBe('success');
   expect(response.budget.usedTokens).toBe(countTokens(JSON.stringify({content:result.content})));
   const read=await callRaw(client,'potsherd_read',{refs:[response.evidence[0].ref],scope:{project:'/p'},budget:defaultBudget()});
   expect(JSON.parse((read.content[0] as {text:string}).text).evidence[0].text).toBe('Exact cache.X_9 recovered');
  }finally{await close();closeMemoryService(ctx);}
  expect(fs.readFileSync(path.join(root,'potsherd.db'))).toEqual(before);
 });
 it('honors project ignore preferences on public unscoped recall and explicit project override',async()=>{
  const root=fixture();fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({ignore:['/p']}));const ctx=makeContext({potsherdDir:root,env:{}}),{client,close}=await connectInMemory(ctx,'phase12-ignore');
  try {
   const hidden=await callRaw(client,'potsherd_recall',{query:'cache.X_9',mode:'literal',budget:defaultBudget()});expect(JSON.parse((hidden.content[0] as {text:string}).text).evidence).toHaveLength(0);
   const explicit=await callRaw(client,'potsherd_recall',{query:'cache.X_9',mode:'literal',scope:{project:'/p'},budget:defaultBudget()});expect(JSON.parse((explicit.content[0] as {text:string}).text).evidence).toHaveLength(1);
  }finally{await close();closeMemoryService(ctx);}
 });
 it('durably writes idempotent author assertions and immediately recalls current supersession',async()=>{
  const root=fixture(),ctx=makeContext({potsherdDir:root,env:{}}),{client,close}=await connectInMemory(ctx,'phase12-write');
  try {
   const input={requestKey:'same-write',scope:{project:'/p'},authorClaim:'user',entries:[{kind:'decision',text:'Retry cache policy requires review'}]};
   const first=await callRaw(client,'potsherd_write',input);const receipt=JSON.parse((first.content[0] as {text:string}).text);
   expect(receipt.authority).toBe('agent_assertion');expect(receipt.supportStatus).toBe('unverified');expect(receipt.budget.usedTokens).toBe(countTokens(JSON.stringify({content:first.content})));
   const second=await callRaw(client,'potsherd_write',{...input,budget:defaultBudget(8192)});expect(JSON.parse((second.content[0] as {text:string}).text).noteIds).toEqual(receipt.noteIds);
   await callRaw(client,'potsherd_write',{requestKey:'superseding-write',scope:{project:'/p'},entries:[{kind:'decision',text:'Retry cache policy is now explicit',supersedes:receipt.noteIds}]});
   const recall=await callRaw(client,'potsherd_recall',{query:'retry cache policy',scope:{project:'/p'},budget:defaultBudget()});const response=JSON.parse((recall.content[0] as {text:string}).text);
   expect(response.assertions).toHaveLength(1);expect(response.assertions[0].text).toBe('Retry cache policy is now explicit');expect(response.assertions[0].authority).toBe('agent_assertion');
   const read=await callRaw(client,'potsherd_read',{noteIds:receipt.noteIds,scope:{project:'/p'},budget:defaultBudget()});const old=JSON.parse((read.content[0] as {text:string}).text);expect(old.assertions).toHaveLength(1);expect(old.assertions[0].current).toBe(false);expect(old.assertions[0].text).toBe('Retry cache policy requires review');
  }finally{await close();closeMemoryService(ctx);}
 });
 it('reports unavailable memory explicitly for an uncreated isolated root',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p12-empty-'));roots.push(root);const ctx=makeContext({potsherdDir:root,env:{}});const {client,close}=await connectInMemory(ctx,'phase12-empty');
  try {const result=await callRaw(client,'potsherd_recall',{query:'cache',budget:defaultBudget()});const response=JSON.parse((result.content[0] as {text:string}).text);expect(response.coverage.state).toBe('unavailable');expect(response.support.state).toBe('insufficient');expect(fs.existsSync(path.join(root,'potsherd.db'))).toBe(false);}finally{await close();closeMemoryService(ctx);}
 });
});
it('actual stdio MCP rechecks declared schema on the same inode and refuses unsupported future versions',async()=>{const root=fixture();let db=open({root});db.prepare("UPDATE maintenance_jobs SET state='done'").run();db.close();const sdkRequire=createRequire(path.resolve('packages/mcp/package.json'));const {Client}=sdkRequire('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=sdkRequire('@modelcontextprotocol/sdk/client/stdio.js');const client=new Client({name:'schema-boundary',version:'1'},{capabilities:{}});const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('packages/mcp/dist/index.js'),'--potsherd-dir',root],env:{...process.env,POTSHERD_SQLITE:'node'}});try{await client.connect(transport);const initial=await client.callTool({name:'potsherd_recall',arguments:{query:'cache.X_9',mode:'literal'}});expect(JSON.parse((initial.content as {text:string}[])[0]!.text).evidence).toHaveLength(1);db=open({root});db.prepare('DELETE FROM schema_migrations WHERE version=17').run();db.close();const before=openDatabase(path.join(root,'potsherd.db'),{readonly:true});const epochsBefore=before.prepare('SELECT * FROM memory_epochs').get();before.close();const outdated=await client.callTool({name:'potsherd_recall',arguments:{query:'cache.X_9',mode:'literal'}});const response=JSON.parse((outdated.content as {text:string}[])[0]!.text);expect(response.coverage.state).toBe('upgrade_required');expect(response.support.state).toBe('insufficient');expect(response.evidence).toEqual([]);expect(response.budget.usedTokens).toBe(countTokens(JSON.stringify({content:outdated.content})));db=openDatabase(path.join(root,'potsherd.db'));expect(db.prepare('SELECT * FROM memory_epochs').get()).toEqual(epochsBefore);db.prepare("INSERT INTO schema_migrations VALUES(20,'future','now')").run();db.close();const future=await client.callTool({name:'potsherd_read',arguments:{legacyRef:{sessionId:'native-memory'}}});expect(JSON.parse((future.content as {text:string}[])[0]!.text).warnings).toContain('unsupported_future_schema');}finally{await client.close();await transport.close();}});
it('actual stdio rejects legacy-flat, misspelled and conflicting source boundaries with measured errors',async()=>{const root=fixture();const db=open({root});const p:ParseResult={session:{id:'B',harness:'claude',sourcePath:'/synthetic/B',project:'/b',projectSlug:'b',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:1,assistantTurns:0,toolCalls:0,bytes:1},status:'live'},records:[{unitKey:'b',role:'user',text:'Exact cache.X_9 from B',project:'/b',eventAt:null,timeBasis:'unknown',locator:{recordKey:'b',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'user'}],exchanges:[],unknownTypes:{},endOffset:1,malformedLines:0,evidenceVersion:'test'};publishSource(db,{parsed:p,artifactHash:hash('B'),artifactBytes:1});db.prepare("UPDATE maintenance_jobs SET state='done'").run();db.close();const sdkRequire=createRequire(path.resolve('packages/mcp/package.json'));const {Client}=sdkRequire('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=sdkRequire('@modelcontextprotocol/sdk/client/stdio.js');const client=new Client({name:'scope-boundary',version:'1'},{capabilities:{}});const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('packages/mcp/dist/index.js'),'--potsherd-dir',root],env:{...process.env,POTSHERD_SQLITE:'node'}});try{await client.connect(transport);for(const malformed of [{project:'/p',scope:{}},{scope:{projcet:'/p'}},{scope:{project:'/p',repository:'/b'}},{project:'/b',scope:{project:'/p'}}]){const output=await client.callTool({name:'potsherd_recall',arguments:{query:'cache.X_9',mode:'literal',budget:defaultBudget(),...malformed}});const result=JSON.parse((output.content as {text:string}[])[0]!.text);expect(result.warnings).toContain('invalid_memory_input');expect(result.evidence).toEqual([]);expect(result.budget.usedTokens).toBe(countTokens(JSON.stringify({content:output.content})));}const control=await client.callTool({name:'potsherd_recall',arguments:{query:'cache.X_9',mode:'literal',scope:{project:'/p'}}});expect(JSON.parse((control.content as {text:string}[])[0]!.text).evidence.every((e:{project:string})=>e.project==='/p')).toBe(true);}finally{await client.close();await transport.close();}});
