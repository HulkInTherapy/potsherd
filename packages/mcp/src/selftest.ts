import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { VERSION, db as dbNs, format as fmt, indexAll, paths, defaultBudget, countTransportTokens } from '@potsherd/core';
import { makeContext } from './context.js';
import { TOOLS, WRITE_TOOLS } from './server.js';
import { verifySources } from './tools/sources.js';
import { call, callRaw, connectInMemory, textOf, type CallToolResult, type Client } from './testing.js';

export const DEFAULT_WIDTH=80;
/** Offline protocol smoke, using complete synthetic bytes owned by this run. */
export async function selftest(out:NodeJS.WritableStream=process.stderr,width=DEFAULT_WIDTH):Promise<number>{
 const start=Date.now(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'potsherd-mcp-selftest-')),root=path.join(tmp,'index'),project=path.join(tmp,'project'),claude=path.join(tmp,'claude');
 fs.mkdirSync(project,{recursive:true});const checks:{ok:boolean;message:string}[]=[];
 const say=(message:string)=>out.write(fmt.clip(message,width)+'\n');
 const check=(ok:boolean,message:string)=>{checks.push({ok,message});say(`  ${ok?'ok  ':'FAIL'}  ${message}`);};
 const id='11111111-0000-4000-8000-00000000f001',scope={project,branch:'main'};
 const rows=[
  {type:'user',uuid:'u1',promptId:'p1',timestamp:'2026-01-01T00:00:00Z',message:{role:'user',content:'SELFTEST_LITERAL binding_id.X_9 was requested'}},
  {type:'assistant',uuid:'a1',timestamp:'2026-01-01T00:00:01Z',message:{role:'assistant',content:'SELFTEST_LITERAL binding_id.X_9 is recorded here'}},
  {type:'user',uuid:'u2',promptId:'p2',timestamp:'2026-01-02T00:00:00Z',message:{role:'user',content:'SELFTEST_SECOND request'}},
  {type:'assistant',uuid:'a2',timestamp:'2026-01-02T00:00:01Z',message:{role:'assistant',content:'SELFTEST_SECOND response'}},
 ].map(row=>({...row,sessionId:id,cwd:project,gitBranch:'main'}));
 const transcripts=path.join(claude,'projects','synthetic');fs.mkdirSync(transcripts,{recursive:true});fs.writeFileSync(path.join(transcripts,id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 let close:(()=>Promise<void>)|undefined;
 try{
  say(`potsherd mcp selftest · v${VERSION}`);say('');say(`  index   ${fmt.elideMiddle(root,width-10)}`);
  const indexed=await indexAll({root,claudeDir:claude,harnesses:['claude'],embed:false});check(indexed.totals.failed===0&&indexed.totals.sessions===1,'complete synthetic capture, no real archive or model call');
  const harness=await connectInMemory(makeContext({potsherdDir:root,env:{},cwd:project}),'potsherd-selftest');close=harness.close;const client=harness.client;
  const listed=await client.listTools();check(JSON.stringify(listed.tools.map(tool=>tool.name))===JSON.stringify(TOOLS),'four v2 tools registered in declared order');
  const observed=new Set<string>();
  function snapshot(){const db=dbNs.openSqliteReadOnly(paths.dbPath(root));try{return JSON.stringify({notes:db.prepare('SELECT note_id,text FROM memory_note_events ORDER BY note_id').all(),tags:db.prepare('SELECT * FROM tags ORDER BY session_id,tag').all(),files:fs.readdirSync(project).sort()});}finally{db.close();}}
  async function measured(tool:string,args:Record<string,unknown>){const before=snapshot();const raw=await callRaw(client,tool,args);if(before!==snapshot())observed.add(tool);const value=JSON.parse(textOf(raw)) as Record<string,any>;if(value.budget)check(value.budget.usedTokens===countTransportTokens(JSON.stringify(raw))&&value.budget.usedTokens<=Number((args.budget as {maxTokens?:number}|undefined)?.maxTokens??4096),`${tool} complete MCP payload matches its token receipt`);return value;}
  const recalled=await measured('potsherd_recall',{query:'binding_id.X_9',mode:'literal',scope,budget:defaultBudget()});
  check(recalled.evidence.length>0&&recalled.evidence.every((item:any)=>item.text.includes('binding_id.X_9')&&item.provenance.nativeSessionId===id),'literal source bytes and native provenance returned');
  check(recalled.coverage.semantic==='disabled','literal recall uses no model');const ref=recalled.evidence[0].ref;
  const read=await measured('potsherd_read',{refs:[ref],scope,budget:defaultBudget()});check(read.evidence[0].text===recalled.evidence[0].text&&JSON.stringify(read.evidence[0].ref)===JSON.stringify(ref),'immutable read returns the same exact source span');
  let cursor:string|undefined,seen:string[]=[];let pages=0;
  do{if(++pages>20)throw new Error('bounded synthetic pagination did not terminate');const page=await measured('potsherd_read',{...(cursor?{cursor}:{legacyRef:{sessionId:id,fromSeq:2,toSeq:2}}),scope,budget:defaultBudget()});seen.push(...page.evidence.map((item:any)=>item.text));cursor=page.continuation;}while(cursor);
  check(seen.length===2&&seen.every(text=>text.includes('SELFTEST_SECOND')),'inclusive legacy exchange range pages without overlap');
  const grafted=await measured('potsherd_graft',{refs:[ref],scope,budget:defaultBudget()});check(grafted.evidence[0].text===read.evidence[0].text&&fs.readdirSync(project).length===0,'default graft returns source evidence and writes no project file');
  const writeArgs={requestKey:'selftest-retry',scope,authorClaim:'user',entries:[{kind:'next',text:'SELFTEST_HANDOFF inspect the recorded source',supports:[ref]}],budget:defaultBudget()};
  const written=await measured('potsherd_write',writeArgs),retry=await measured('potsherd_write',writeArgs);
  check(written.authority==='agent_assertion'&&JSON.stringify(retry.noteIds)===JSON.stringify(written.noteIds),'durable retry is idempotent; author claims do not attest a human');
  const note=await measured('potsherd_read',{noteIds:written.noteIds,scope,budget:defaultBudget()});check(note.assertions.length===1&&note.assertions[0].text.includes('SELFTEST_HANDOFF'),'acknowledged note is readable through the ordinary tool');
  check(JSON.stringify([...observed].sort())===JSON.stringify([...WRITE_TOOLS].sort()),'observed writers match the declared write tool');for(const tool of listed.tools)check(tool.annotations?.readOnlyHint===!observed.has(tool.name),`${tool.name} readOnlyHint matches observed behavior`);
  const invalid=await callRaw(client,'potsherd_recall',{query:42});check(invalid.isError===true&&textOf(invalid).length>0,'malformed input is a tool error');
  const badScope=await call(client,'potsherd_recall',{query:'binding_id.X_9',scope:{repository:'/unsupported'}});check((badScope.evidence as unknown[]).length===0&&(badScope.warnings as string[]).includes('invalid_memory_input'),'unsupported scope is rejected without an unscoped search');
  const missing=await call(client,'potsherd_read',{legacyRef:{sessionId:'missing-native'},scope});check((missing.evidence as unknown[]).length===0&&(missing.coverage as {state:string}).state==='unavailable','unavailable source is not reported as captured absence');
  const file=paths.dbPath(root),saved=file+'.selftest-hidden';fs.renameSync(file,saved);try{const unreadable=await call(client,'potsherd_recall',{query:'binding_id.X_9',mode:'literal',scope});check((unreadable.coverage as {state:string}).state==='unavailable','unreadable index produces an operational failure');}finally{fs.renameSync(saved,file);}
  const after=await call(client,'potsherd_recall',{query:'binding_id.X_9',mode:'literal',scope});check((after.evidence as unknown[]).length>0,'valid requests still work after the failure controls');
  const db=dbNs.openSqliteReadOnly(paths.dbPath(root));try{const verdict=verifySources(db,['SOURCES',`${id.slice(0,8)} · fixture · claude · 2 exchanges · 2026-01-01`,'  real source reference','HANDOFF.md §3 · fixture · claude · — exchanges · —','  invented repository citation','— · fixture · claude · — exchanges · —','  invented missing citation'].join('\n'));check(verdict.kept.length===1&&verdict.refused.length===2&&!verdict.text.includes('invented'),'legacy citation verifier preserves its fabricated-source refusal');}finally{db.close();}
  const failed=checks.filter(check=>!check.ok).length;say('');say(failed?`  ${failed} of ${checks.length} checks FAILED · ${Date.now()-start}ms`:`  ${checks.length} checks, all passed · ${Date.now()-start}ms`);return failed?1:0;
 }catch(error){say(`  selftest could not finish: ${error instanceof Error?error.message:String(error)}`);return 1;}
 finally{if(close)await close();fs.rmSync(tmp,{recursive:true,force:true});}
}
