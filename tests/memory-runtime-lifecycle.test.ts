import { testModelCache } from './model-cache.js';
import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const sdkRequire=createRequire(path.resolve('packages/mcp/package.json'));
const {Client}=await import(pathToFileURL(sdkRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const {StdioClientTransport}=await import(pathToFileURL(sdkRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
import {openSqliteReadOnly} from '../packages/core/src/db.js';
import {defaultBudget} from '../packages/core/src/memory/budget.js';
import {inspectAssets} from '../packages/core/src/memory/assets.js';
const cache=testModelCache('/nonexistent/potsherd-test-models');
const cli=path.resolve('packages/cli/dist/potsherd.js'),mcp=path.resolve('packages/mcp/dist/index.js');
function record(id:string,key:string,text:string){return JSON.stringify({type:'user',uuid:key,sessionId:id,promptId:key,cwd:'/synthetic/runtime',message:{role:'user',content:text}})+'\n';}
async function until(fn:()=>boolean,ms=5000){const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw new Error('freshness timeout');await new Promise<void>(r=>setTimeout(r,40));}}
describe('built runtime lifecycle',()=>{
 it.skipIf(inspectAssets(cache).state!=='ready')('discovers only enrolled synthetic roots, encodes dense offline, captures active append and closes within5s',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p12-runtime-life-')),source=path.join(root,'claude'),project=path.join(source,'projects','p'),id='11111111-1111-4111-8111-111111111111';fs.mkdirSync(project,{recursive:true});fs.symlinkSync(cache,path.join(root,'models'),'dir');const file=path.join(project,id+'.jsonl');fs.writeFileSync(file,record(id,'r1','The scheduler recovers durable interrupted work.'));
  execFileSync(process.execPath,[cli,'index','--no-embed','--harness','claude','--claude-dir',source,'--potsherd-dir',root,'--quiet'],{env:{...process.env,POTSHERD_OFFLINE:'1'},timeout:15000});
  const transport=new StdioClientTransport({command:process.execPath,args:[mcp,'--potsherd-dir',root],env:{...process.env,POTSHERD_OFFLINE:'1'} as Record<string,string>});const client=new Client({name:'runtime-lifecycle',version:'test'},{capabilities:{}});let closed=false;
  try {await client.connect(transport);
   const inspect=()=>{const db=openSqliteReadOnly(path.join(root,'potsherd.db'));try{return db.prepare('SELECT COUNT(*) n FROM span_embeddings').get() as {n:number};}finally{db.close();}};await until(()=>inspect().n>0);
   const dense=await client.callTool({name:'potsherd_recall',arguments:{query:'scheduler recovery',scope:{project:'/synthetic/runtime'},budget:defaultBudget()}});const response=JSON.parse((dense.content as {text:string}[])[0]!.text);expect(response.coverage.semantic).toBe('ready');expect(response.evidence.length).toBeGreaterThan(0);
   const start=Date.now();fs.appendFileSync(file,record(id,'r2','Append marker runtime_freshness_verified.'));
   await until(()=>{const db=openSqliteReadOnly(path.join(root,'potsherd.db'));try{return Boolean(db.prepare("SELECT 1 FROM evidence_units WHERE instr(text,'runtime_freshness_verified')>0").get());}finally{db.close();}});expect(Date.now()-start).toBeLessThan(5000);
   const exact=await client.callTool({name:'potsherd_recall',arguments:{query:'runtime_freshness_verified',mode:'literal',budget:defaultBudget()}});expect(JSON.parse((exact.content as {text:string}[])[0]!.text).evidence.length).toBeGreaterThan(0);
   const stop=Date.now();await client.close();closed=true;await until(()=>{const db=openSqliteReadOnly(path.join(root,'potsherd.db'));try{return (db.prepare("SELECT COUNT(*) n FROM maintenance_leases WHERE process_started_at<>'released'").get() as {n:number}).n===0;}finally{db.close();}});expect(Date.now()-stop).toBeLessThan(5000);
   const db=openSqliteReadOnly(path.join(root,'potsherd.db'));try{expect(db.prepare("SELECT COUNT(*) n FROM maintenance_leases WHERE process_started_at<>'released'").get()).toMatchObject({n:0});expect(db.prepare("SELECT COUNT(*) n FROM memory_sources WHERE native_session_id<>?").get(id)).toMatchObject({n:0});}finally{db.close();}
  }finally{if(!closed)await client.close();fs.rmSync(root,{recursive:true,force:true});}
 },30000);
 it('preserves spool when store cannot be opened and explicit maintain recovers it',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'p12-spool-life-'));try{
  execFileSync(process.execPath,[cli,'maintain','--enqueue-session','synthetic-session','--enqueue-only','--quiet','--potsherd-dir',root],{timeout:10000});expect(fs.readdirSync(path.join(root,'maintenance-spool')).filter(n=>n.endsWith('.json'))).toHaveLength(1);expect(fs.existsSync(path.join(root,'potsherd.db'))).toBe(false);
  const result=spawn(process.execPath,[cli,'maintain','--migrate','--quiet','--potsherd-dir',root],{stdio:'ignore'});return new Promise<void>((resolve,reject)=>{result.once('error',reject);result.once('close',()=>{try{const db=openSqliteReadOnly(path.join(root,'potsherd.db'));try{expect(db.prepare("SELECT state,error_code FROM maintenance_jobs WHERE target_id='synthetic-session'").get()).toMatchObject({state:'blocked',error_code:'source_enrollment_required'});}finally{db.close();}expect(fs.readdirSync(path.join(root,'maintenance-spool')).filter(n=>n.endsWith('.json'))).toHaveLength(0);resolve();}catch(error){reject(error);}finally{fs.rmSync(root,{recursive:true,force:true});}});});
 }catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}});
});
