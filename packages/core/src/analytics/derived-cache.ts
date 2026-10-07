import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export interface DerivedCacheBinding {sourceId:string;sourceIdentity:string;contentHash:string;currentness:string;privacyPolicy:string;forgetEpoch:string;normalizationVersion:string;questionVersion?:string;model?:string;segmentationVersion?:string;scopeHash?:string;}
export type DerivedValidator<T>=(value:unknown)=>value is T;
export const derivedDigest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validDerivedBinding(v:unknown):v is DerivedCacheBinding {if(!v||typeof v!=='object')return false;const b=v as Record<string,unknown>;return ['sourceId','sourceIdentity','contentHash','currentness','privacyPolicy','forgetEpoch','normalizationVersion'].every(k=>typeof b[k]==='string'&&(b[k] as string).length>0)&&['questionVersion','model','segmentationVersion','scopeHash'].every(k=>b[k]===undefined||typeof b[k]==='string');}
function identity(b:DerivedCacheBinding):string {return derivedDigest([b.sourceId,b.sourceIdentity,b.contentHash,b.currentness,b.privacyPolicy,b.forgetEpoch,b.normalizationVersion,b.questionVersion??null,b.model??null,b.segmentationVersion??null,b.scopeHash??null]);}
const forbidden=new Set(['text','content','messages','prompt','prompts','request','requests','quote','caption','raw','body','transcript','conversationText','assistantContext','precedingUser']);
/** Reject transcript-bearing shapes even if a caller's domain validator is permissive. */
function bodyFree(v:unknown,depth=0):boolean {if(depth>20)return false;if(typeof v==='string')return v.length<=4096;if(v===null||typeof v==='boolean')return true;if(typeof v==='number')return Number.isFinite(v);if(Array.isArray(v))return v.length<=100_000&&v.every(x=>bodyFree(x,depth+1));if(v&&typeof v==='object')return Object.entries(v).every(([k,x])=>!forbidden.has(k)&&bodyFree(x,depth+1));return false;}
/** Separate derived store. Callers must recheck source authority before both read and write. */
export class DerivedCache {
 constructor(readonly directory:string,readonly maxEntryBytes=4*1024*1024){}
 private file(namespace:string,binding:DerivedCacheBinding):string {if(!/^[a-z0-9-]{1,64}$/.test(namespace)||!validDerivedBinding(binding))throw new Error('derived_cache_binding_invalid');return path.join(this.directory,`${namespace}-${derivedDigest(binding.sourceId)}.json`);}
 read<T>(namespace:string,binding:DerivedCacheBinding,validate:DerivedValidator<T>):T|null {
  const file=this.file(namespace,binding);let fd:number|undefined;
  try{const directory=fs.lstatSync(this.directory);if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077)!==0)return null;fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!st.isFile()||(st.mode&0o077)!==0||st.size>this.maxEntryBytes)return null;const text=fs.readFileSync(fd,'utf8'),r=JSON.parse(text) as Record<string,unknown>;if(r.schema!=='launch-derived-v1'||r.binding!==identity(binding)||!bodyFree(r.value)||!validate(r.value))return null;return r.value;}catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 write<T>(namespace:string,binding:DerivedCacheBinding,value:T,validate:DerivedValidator<T>):void {
  const file=this.file(namespace,binding);if(!bodyFree(value)||!validate(value))throw new Error('derived_cache_value_invalid');const text=JSON.stringify({schema:'launch-derived-v1',binding:identity(binding),value});if(Buffer.byteLength(text)>this.maxEntryBytes)throw new Error('derived_cache_entry_limit');
  fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const st=fs.lstatSync(this.directory);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('derived_cache_directory_invalid');fs.chmodSync(this.directory,0o700);
  const temp=path.join(this.directory,`.launch-${randomUUID()}.tmp`);let fd:number|undefined;
  try{fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);const dir=fs.openSync(this.directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{/* rename consumed temp */}}
 }
 /** Removes one derived source entry, never the retained source archive. */
 invalidate(namespace:string,binding:DerivedCacheBinding):void {try{fs.unlinkSync(this.file(namespace,binding));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
