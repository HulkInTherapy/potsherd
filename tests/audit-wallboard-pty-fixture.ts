/** Controlled PUBLIC fixture only. No native corpus or provider/network use. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createBackgroundAuditSession} from '../packages/cli/src/audit-background.js';
import {runLaunchTerminal} from '../packages/cli/src/audit-ui/launch-terminal.js';
import {reportFixture,loadingFixture} from './audit-report-fixture.js';
import {promptFixture,evidenceFixture} from './audit-ui/fixture.js';
import type {AuditSnapshot} from '../packages/core/src/analytics/contracts.js';
const proof=process.env['SLOPIE_PTY_PROOF']!,scenario=process.env['SLOPIE_PTY_SCENARIO']??'journey';
const record=(value:unknown)=>fs.appendFileSync(path.join(proof,'events.jsonl'),JSON.stringify({at:Date.now(),pid:process.pid,...value as object})+'\n',{mode:0o600});
const localFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.startsWith('data:')){record({kind:'local-bundled-data-uri'});return localFetch(input,init);}record({kind:'forbidden-network',where:new Error('blocked network').stack?.split('\n').slice(1,6)});throw new Error('network forbidden');};
if(process.argv[2]==='__audit_worker'){
 let snapshot=loadingFixture(),runId:number|null=null,dispatches=0,expectedDispatches=scenario.startsWith('transfer-two')?2:1;
 const send=(message:unknown)=>process.connected&&process.send?.(message);
 const finish=()=>{snapshot={...reportFixture(),snapshotId:snapshot.snapshotId,sequence:10};send({kind:'event',event:{type:'snapshot',snapshot}});send({kind:'result',id:runId,value:snapshot});};
 process.on('message',(message:any)=>{
  if(message.kind==='init'){snapshot.snapshotId=message.options.sessionIdentity;record({kind:'worker-init',ownedTemporary:process.env['TMPDIR']});send({kind:'ready',snapshot});return;}
  if(message.kind==='cancel'){process.disconnect();return;}
  if(message.kind==='transfer_ack'){record({kind:'synthetic-dispatch-after-ack',ackId:message.ackId});dispatches++;if(dispatches===expectedDispatches)finish();return;}
  if(message.kind!=='request')return;
  if(message.op==='run'){
   runId=message.id;snapshot.sequence=1;snapshot.sources=snapshot.sources.map((source,i)=>({...source,state:'available',candidateFiles:20+i,census:{checked:true,files:20+i,bytes:1000,roots:1,unit:source.harness==='opencode'?'database':'file'}}));snapshot.progress.label='Reading controlled public history';send({kind:'event',event:{type:'snapshot',snapshot}});record({kind:'worker-busy-start'});
   const until=Date.now()+1600;while(Date.now()<until){}record({kind:'worker-busy-end'});
   if(scenario==='crash'){process.exit(12);}
   if(scenario.startsWith('transfer')){for(let i=1;i<=expectedDispatches;i++)send({kind:'event',event:{type:'transfer',snapshotId:snapshot.snapshotId,sequence:7+i,model:'jev-public-fixture',recipients:['OpenCode Zen','TypeSafe/Jev'],attempt:i,selectedSegments:1,notice:expectedDispatches===1?'Selected redacted conversation text will be sent to OpenCode Zen and TypeSafe/Jev.':`Selected redacted conversation ${i} will be sent to OpenCode Zen and TypeSafe/Jev.`,ackId:`controlled-${i}`}});}
   else finish();return;
  }
  if(message.op==='prompts'){const page=promptFixture();page.snapshotId=snapshot.snapshotId;send({kind:'result',id:message.id,value:page});}
  if(message.op==='evidence')send({kind:'result',id:message.id,value:{...evidenceFixture(),text:'Captured PUBLIC fixture evidence remains available.'}});
 });
 process.on('disconnect',()=>process.exit(0));
}else{
 fs.mkdirSync(proof,{recursive:true,mode:0o700});fs.chmodSync(proof,0o700);
 record({kind:'parent-ready'});
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'slopie-public-pty-fixture-'));let bytes=0;
 const original=process.stdout.write.bind(process.stdout);
 process.stdout.write=((chunk:any,...args:any[])=>{const text=typeof chunk==='string'?chunk:Buffer.isBuffer(chunk)?chunk.toString():'';bytes+=Buffer.byteLength(text);const last=args.length-1;if(scenario.endsWith('-cancel')&&text.includes('Selected redacted')&&typeof args[last]==='function'){const callback=args[last];args[last]=(error:any)=>setTimeout(()=>callback(error),750);}return original(chunk,...args as [any]);}) as typeof process.stdout.write;
 const session=createBackgroundAuditSession({launch:true,launchPrepareOnly:true,potsherdDir:path.join(temporary,'owned'),claudeDir:path.join(temporary,'claude'),codexDir:path.join(temporary,'codex'),piDir:path.join(temporary,'pi'),opencodeDir:path.join(temporary,'opencode')},process.argv[1]);
 const ack=session.acknowledgeTransfer;session.acknowledgeTransfer=(ackId)=>{record({kind:'parent-ack-after-flush',ackId,stdoutBytes:bytes});ack?.(ackId);};
 const result=await runLaunchTerminal(session,{ascii:scenario==='ascii',motion:scenario!=='reduced',color:scenario!=='noColor'});
 session.dispose();record({kind:'terminal-result',reason:result.reason,status:result.snapshot.status,sourceCalls:0,networkCalls:0});fs.rmSync(temporary,{recursive:true,force:true});process.exitCode=result.snapshot.status==='error'?1:0;
}
