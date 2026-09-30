import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { requiredFiles, MODEL_ID, RUNTIME_VERSION, RUNTIME_SUBDIR, BGE_QUERY_PREFIX, EMBEDDING_DIMENSIONS, acquire } from '../embeddings.js';
import { identity } from './spans.js';
export const MODEL_HASH=requiredFiles().find(f=>f.name.endsWith('.onnx'))!.sha256;
/** SHA256(tokenizer.json || tokenizer_config.json || verified tokenizers.mjs), span-v1 policy. */
export const TOKENIZER_HASH='771b89c9f8734b4609b7b3629c606cbc42d57336b4ec899218af2c0cb272300f';
function namedSpace(pooling:'mean'|'cls'):string{return identity('span-space/v1',MODEL_ID,MODEL_HASH,TOKENIZER_HASH,RUNTIME_VERSION,'q8',pooling,BGE_QUERY_PREFIX,'l2','384','record-context-v1');}
export const DEFAULT_SPACE_ID=namedSpace('mean');
/** Reserved experimental identity; no CLS index is built/promoted by default. */
export const CLS_SPACE_ID=namedSpace('cls');
const verified=new Map<string,{signature:string;result:{state:'ready'|'missing_assets';missing:string[]}}>();
export function inspectAssets(cacheDir:string):{state:'ready'|'missing_assets';missing:string[]} {
 const signature=requiredFiles().map(f=>{try{const st=fs.statSync(path.join(cacheDir,f.name));return [st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':');}catch{return 'missing';}}).join('|');
 const cached=verified.get(cacheDir);if(cached?.signature===signature)return cached.result;
 const missing=requiredFiles().filter(f=>{try{const b=fs.readFileSync(path.join(cacheDir,f.name));return b.length!==f.bytes||createHash('sha256').update(b).digest('hex')!==f.sha256;}catch{return true;}}).map(f=>f.name);
 const result={state:missing.length?'missing_assets' as const:'ready' as const,missing};if(verified.size>=4)verified.delete(verified.keys().next().value!);verified.set(cacheDir,{signature,result});return result;
}
export async function acquireAssets(cacheDir:string):Promise<void> {await acquire(cacheDir);if(inspectAssets(cacheDir).state!=='ready')throw new Error('asset_hash_mismatch');}
/** Self-contained compute isolates WASM/tokenization from the ownership event loop. */
const COMPUTE_WORKER=String.raw`(async()=>{
 const {parentPort,workerData}=await import('node:worker_threads');const fs=await import('node:fs');const path=await import('node:path');const {pathToFileURL}=await import('node:url');
 const data=workerData;
 const dir=path.join(data.cacheDir,data.runtime),model=path.join(data.cacheDir,data.model);
 const ort=await import(pathToFileURL(path.join(dir,'ort.wasm.bundle.min.mjs')).href);
 const {Tokenizer}=await import(pathToFileURL(path.join(dir,'tokenizers.mjs')).href);
 ort.env.wasm.wasmPaths=dir+path.sep;ort.env.wasm.numThreads=data.threads??1;ort.env.logLevel='error';
 const tok=new Tokenizer(JSON.parse(fs.readFileSync(path.join(model,'tokenizer.json'),'utf8')),JSON.parse(fs.readFileSync(path.join(model,'tokenizer_config.json'),'utf8')));
 const session=await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(model,'onnx/model_quantized.onnx'))),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
 const padId=JSON.parse(fs.readFileSync(path.join(model,'tokenizer.json'),'utf8')).model.vocab['[PAD]']??0;
 parentPort.on('message',async (m)=>{try{
  const before=performance.now(),texts=m.texts??[m.text],encoded=texts.map(text=>tok.encode(text,{add_special_tokens:true,return_token_type_ids:true}));
  if(texts.length>8||encoded.some(e=>e.ids.length>(m.query?512:384)))throw new Error('span_token_limit');
  const tokenizeMs=performance.now()-before,compute=performance.now();
  const forward=async(encoded)=>{const n=Math.max(...encoded.map(e=>e.ids.length)),batch=encoded.length;
  const ids=new BigInt64Array(batch*n),mask=new BigInt64Array(batch*n),types=new BigInt64Array(batch*n);ids.fill(BigInt(padId));
  encoded.forEach((e,row)=>{e.ids.forEach((id,i)=>ids[row*n+i]=BigInt(id));e.attention_mask.forEach((v,i)=>mask[row*n+i]=BigInt(v));e.token_type_ids?.forEach((v,i)=>types[row*n+i]=BigInt(v));});
  const feeds={input_ids:new ort.Tensor('int64',ids,[batch,n]),attention_mask:new ort.Tensor('int64',mask,[batch,n])};
  if(session.inputNames.includes('token_type_ids'))feeds.token_type_ids=new ort.Tensor('int64',types,[batch,n]);
  const out=await session.run(feeds),hidden=out[session.outputNames[0]],width=hidden.dims.at(-1),vectors=[];
  for(let row=0;row<batch;row++){const v=new Float32Array(width);let count=0;
   for(let i=0;i<(m.pooling==='cls'?1:n);i++){if(!mask[row*n+i])continue;count++;for(let j=0;j<width;j++)v[j]=(v[j]??0)+hidden.data[(row*n+i)*width+j];}
   let norm=0;for(let j=0;j<width;j++){v[j]=(v[j]??0)/(count||1);norm+=(v[j]??0)**2;}norm=Math.sqrt(norm)||1;for(let j=0;j<width;j++)v[j]=(v[j]??0)/norm;vectors.push(Array.from(v));
  }
  return vectors;};
  // This graph's full-sequence batches regress throughput; bounded RPC batches reuse single forward passes.
  const vectors=[];if(data.batchInference)vectors.push(...await forward(encoded));else for(const one of encoded)vectors.push(...await forward([one]));
  parentPort.postMessage({id:m.id,vectors,metrics:{tokenizeMs,inferenceMs:performance.now()-compute,effectiveThreads:ort.env.wasm.numThreads,rows:encoded.length,tokens:encoded.reduce((sum,e)=>sum+e.ids.length,0)}});
 }catch{parentPort.postMessage({id:m.id,error:'embedding_compute_failed'});}});
})().catch(()=>process.exit(1));`;
export class LocalEncoder {
 private worker:Worker|null=null;private sequence=0;private closed=false;private busy:Promise<unknown>=Promise.resolve();private pending=0;
 readonly statistics={workerStarts:0,batches:0,rows:0,tokens:0,effectiveThreads:0,workerProgramHash:createHash('sha256').update(COMPUTE_WORKER).digest('hex'),tokenizeMs:0,inferenceMs:0};
 constructor(readonly cacheDir:string,readonly options:{threads?:number;batchInference?:boolean}={}){}
 private start():Worker {
  if(this.closed)throw new Error('encoder_closed');if(this.worker)return this.worker;
  if(inspectAssets(this.cacheDir).state!=='ready')throw new Error('missing_assets');
  const worker=new Worker(COMPUTE_WORKER,{eval:true,execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type')),workerData:{cacheDir:this.cacheDir,runtime:RUNTIME_SUBDIR,model:MODEL_ID,threads:Math.min(4,Math.max(1,this.options.threads??4)),batchInference:this.options.batchInference??false}});worker.unref();this.statistics.workerStarts++;this.worker=worker;return worker;
 }
 encode(text:string,signal?:AbortSignal,query=false,pooling:'mean'|'cls'='mean'):Promise<number[]>{return this.encodeBatch([text],signal,query,pooling).then(v=>v[0]!);}
 encodeBatch(texts:string[],signal?:AbortSignal,query=false,pooling:'mean'|'cls'='mean'):Promise<number[][]> {
  if(!texts.length||texts.length>8)return Promise.reject(new Error('embedding_batch_limit'));
  if(this.pending>=16)return Promise.reject(new Error('embedding_busy'));this.pending++;
  const run=async()=>{signal?.throwIfAborted();const worker=this.start(),id=++this.sequence;
   return new Promise<number[][]>((resolve,reject)=>{
    const stop=()=>{void worker.terminate();if(this.worker===worker)this.worker=null;};
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.off('message',message);worker.off('error',error);worker.off('exit',exit);};
    const error=()=>{cleanup();stop();reject(new Error('embedding_compute_failed'));};const exit=()=>error();
    const abort=()=>{cleanup();stop();reject(signal?.reason??new Error('cancelled'));};
    const message=(r:{id:number;vectors?:number[][];error?:string;metrics?:{effectiveThreads:number;rows:number;tokens:number;tokenizeMs:number;inferenceMs:number}})=>{if(r.id!==id)return;cleanup();if(r.error||r.vectors?.length!==texts.length||r.vectors.some(v=>v.length!==EMBEDDING_DIMENSIONS)){reject(new Error(r.error??'embedding_dimensions'));return;}this.statistics.batches++;if(r.metrics){this.statistics.effectiveThreads=r.metrics.effectiveThreads;this.statistics.rows+=r.metrics.rows;this.statistics.tokens+=r.metrics.tokens;this.statistics.tokenizeMs+=r.metrics.tokenizeMs;this.statistics.inferenceMs+=r.metrics.inferenceMs;}resolve(r.vectors);};
    const timer=setTimeout(()=>{cleanup();stop();reject(new Error('embedding_timeout'));},30000);timer.unref();worker.on('message',message);worker.once('error',error);worker.once('exit',exit);signal?.addEventListener('abort',abort,{once:true});worker.postMessage({id,texts,query,pooling});
   });
  };
  const result=this.busy.then(run,run).finally(()=>{this.pending--;});this.busy=result.catch(()=>{});
  if(!signal)return result;
  return new Promise<number[][]>((resolve,reject)=>{const abort=()=>reject(signal.reason??new Error('cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();result.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
 }
 async close():Promise<void>{this.closed=true;const w=this.worker;this.worker=null;if(w)await w.terminate();}
}
