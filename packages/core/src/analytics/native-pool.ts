import {Worker,parentPort} from 'node:worker_threads';
import {serialize,deserialize} from 'node:v8';
import {createHash} from 'node:crypto';
import {streamNativeFacts,type StreamedNative} from './native-stream.js';
import {sourceId} from '../memory/source-identity.js';
import {isIgnoredProject} from '../ignore.js';
export interface NativeScanPolicy {authorityCommitment:string;ignoredProjects:readonly string[];forgottenSourceIds:readonly string[];project:string|null;eventFrom:string|null;asOf:string|null;}
export interface NativeScanJob {jobId:string;ordinal:number;file:string;harness:'claude'|'codex'|'pi';bytes:number;stamp:{dev:string;ino:string;size:number;mtimeNs:string;ctimeNs:string};maxBytes:number;maxRecords?:number;maxPromptBytes:number;policy:NativeScanPolicy;}
export interface NativeScanExecutor {scan(job:NativeScanJob,signal:AbortSignal):Promise<StreamedNative>;close():Promise<void>;}
const PROTOCOL='audit-native-v1',FRAME=1024*1024;
const code=(error:unknown)=>error instanceof Error&&/^(?:[a-z][a-z0-9_]{0,95})$/.test(error.message)?error.message:'native_worker_failed';
interface Pending {job:NativeScanJob;signal:AbortSignal;resolve:(v:StreamedNative)=>void;reject:(e:Error)=>void;remove:()=>void;}
interface Slot {worker:Worker;ready:boolean;pending:Pending|null;frames:Buffer[];bytes:number;next:number;}
/** Two owned parser threads; policy authority and ordered aggregation stay in the caller. */
export function createNativeScanPool(entry:URL|string,options:{workers?:1|2;maxActiveBytes?:number;maxResultBytes?:number;maxRssBytes?:number}={}):NativeScanExecutor {
 const count=options.workers??2,maxActive=options.maxActiveBytes??256*1024*1024,maxResult=options.maxResultBytes??256*1024*1024,maxRss=options.maxRssBytes??1280*1024*1024;if(![1,2].includes(count)||![maxActive,maxResult,maxRss].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('native_pool_options_invalid');
 const slots:Slot[]=[],queue:Pending[]=[];let closed=false,failure:string|null=null,activeBytes=0;const terminations:Promise<unknown>[]=[];
 const rejectAll=(reason:string)=>{if(closed)return;failure=reason;closed=true;for(const pending of queue.splice(0)){pending.remove();pending.reject(new Error(reason));}for(const slot of slots){const pending=slot.pending;slot.pending=null;slot.frames=[];if(pending){pending.remove();pending.reject(new Error(reason));}terminations.push(slot.worker.terminate().catch(()=>undefined));}activeBytes=0;clearInterval(monitor);};
 const dispatch=()=>{if(closed)return;for(const slot of slots){if(!slot.ready||slot.pending||!queue.length)continue;const next=queue[0]!;if(next.signal.aborted){queue.shift();next.remove();next.reject(new Error('cancelled'));continue;}if(activeBytes>0&&activeBytes+next.job.bytes>maxActive)continue;queue.shift();slot.pending=next;slot.frames=[];slot.bytes=0;slot.next=0;activeBytes+=next.job.bytes;slot.worker.postMessage({protocol:PROTOCOL,kind:'scan',job:next.job,maxResultBytes:maxResult});}};
 const monitor=setInterval(()=>{if(!closed&&process.memoryUsage().rss>maxRss)rejectAll('native_pool_memory_limit');},250);monitor.unref();
 for(let i=0;i<count;i++){
  const worker=new Worker(entry,{resourceLimits:{maxOldGenerationSizeMb:384},stdout:true,stderr:true}),slot:Slot={worker,ready:false,pending:null,frames:[],bytes:0,next:0};slots.push(slot);worker.stdout?.resume();worker.stderr?.resume();
  worker.on('message',(message:unknown)=>{if(closed||!message||typeof message!=='object')return;const m=message as Record<string,unknown>;if(m.protocol!==PROTOCOL){rejectAll('native_worker_protocol_invalid');return;}if(m.kind==='ready'){slot.ready=true;dispatch();return;}const pending=slot.pending;if(!pending||m.jobId!==pending.job.jobId)return;
   if(m.kind==='frame'){if(m.sequence!==slot.next++||!(m.data instanceof Uint8Array)||m.data.byteLength>FRAME||slot.bytes+m.data.byteLength>maxResult){rejectAll('native_pool_result_bytes_limit');return;}const bytes=Buffer.from(m.data.buffer,m.data.byteOffset,m.data.byteLength);slot.frames.push(bytes);slot.bytes+=bytes.length;return;}
   if(m.kind==='result'||m.kind==='error'){slot.pending=null;activeBytes-=pending.job.bytes;pending.remove();if(m.kind==='error'){slot.frames=[];pending.reject(new Error(typeof m.code==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(m.code)?m.code:'native_worker_failed'));dispatch();return;}
    try{if(m.authorityCommitment!==pending.job.policy.authorityCommitment||m.bytes!==slot.bytes||typeof m.hash!=='string')throw new Error('native_worker_result_invalid');const buffer=Buffer.concat(slot.frames,slot.bytes);slot.frames=[];if(createHash('sha256').update(buffer).digest('hex')!==m.hash)throw new Error('native_worker_result_invalid');const result=deserialize(buffer) as StreamedNative;if(!result||!Array.isArray(result.usage)||!Array.isArray(result.language)||!Array.isArray(result.facts?.events)||result.bytes!==pending.job.bytes||typeof result.hash!=='string')throw new Error('native_worker_result_invalid');if(pending.signal.aborted)throw new Error('cancelled');pending.resolve(result);}catch(error){pending.reject(new Error(code(error)));}dispatch();
   }
  });worker.on('error',()=>rejectAll('native_worker_failed'));worker.on('exit',()=>{if(!closed)rejectAll('native_worker_exited');});
 }
 return {scan(job,signal){if(!closed&&process.memoryUsage().rss>maxRss)rejectAll('native_pool_memory_limit');if(closed)return Promise.reject(new Error(failure??'native_pool_closed'));if(!Number.isSafeInteger(job.bytes)||job.bytes<0||job.bytes>job.maxBytes)return Promise.reject(new Error('native_usage_total_bytes_limit'));return new Promise((resolve,reject)=>{const abort=()=>rejectAll('cancelled'),pending:Pending={job,signal,resolve,reject,remove:()=>signal.removeEventListener('abort',abort)};signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();reject(new Error('cancelled'));return;}queue.push(pending);dispatch();});},async close(){rejectAll('native_pool_closed');await Promise.allSettled(terminations);}};
}
/** Minimal published sidecar: no catalogue, semantic provider, UI or database work. */
export function runNativeScanWorker():void {
 if(!parentPort)throw new Error('native_worker_requires_port');const port=parentPort;let busy=false;
 port.on('message',async(message:{protocol?:string;kind?:string;job?:NativeScanJob;maxResultBytes?:number})=>{if(message.protocol!==PROTOCOL||message.kind!=='scan'||!message.job||busy)return;busy=true;const job=message.job;
  try{const policy=job.policy,forgotten=new Set(policy.forgottenSourceIds),accept=(project:string|null,time:string|null)=>!(project&&isIgnoredProject(project,policy.ignoredProjects))&&(!policy.project||project===policy.project)&&(!policy.eventFrom||time!==null&&time>=policy.eventFrom)&&(!policy.asOf||time!==null&&time<=policy.asOf);
   const snapshot=await streamNativeFacts(job.file,job.harness,{signal:new AbortController().signal,maxBytes:job.maxBytes,maxRecords:job.maxRecords,maxPromptBytes:job.maxPromptBytes,captureBytes:0,captureFileBytes:job.bytes,expectedIdentity:{dev:job.stamp.dev,ino:job.stamp.ino},sourceAllowed:(id,project)=>!forgotten.has(sourceId(job.harness,id))&&!(project&&isIgnoredProject(project,policy.ignoredProjects)),accept});
   const buffer=serialize(snapshot);if(buffer.length>(message.maxResultBytes??256*1024*1024))throw new Error('native_pool_result_bytes_limit');const hash=createHash('sha256').update(buffer).digest('hex');let sequence=0;for(let at=0;at<buffer.length;at+=FRAME){const chunk=Uint8Array.from(buffer.subarray(at,at+FRAME));port.postMessage({protocol:PROTOCOL,kind:'frame',jobId:job.jobId,sequence:sequence++,data:chunk},[chunk.buffer]);}port.postMessage({protocol:PROTOCOL,kind:'result',jobId:job.jobId,authorityCommitment:policy.authorityCommitment,bytes:buffer.length,hash});
  }catch(error){port.postMessage({protocol:PROTOCOL,kind:'error',jobId:job.jobId,code:code(error)});}finally{busy=false;}
 });port.postMessage({protocol:PROTOCOL,kind:'ready'});
}
