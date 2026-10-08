import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {redact} from '../redact.js';
import {elideBinary} from '../redact-elide.js';

export const digest=(value:string|Buffer):string=>createHash('sha256').update(value).digest('hex');
export const clean=(text:string):string=>redact(elideBinary(text)).text;
export const clock=(value:unknown):string|null=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export interface NativeEvent {observed?:boolean;languageEligible?:boolean;key:string;rawStart:number;rawEnd:number;role:'user';text:string;eventAt:string|null;project:string|null;origin:'claude_prompt_id'|'codex_human_marker'|'pi_user_projection'|'opencode_user_projection'|'unknown';eligible:boolean;excluded:string|null;identity:string;evidenceStart?:number;nativeRecordId?:string;recordCommitment?:string;declaredOrigin?:string;}
export interface NativeFacts {nativeId:string;project:string|null;parent:string|null;child:boolean;title:string|null;events:NativeEvent[];gaps:string[];hash:string;consumed:number;bytes:Buffer;}

/** A size check and a bounded fd read, with identity rechecked after reading. */
export function boundedBytes(file:string,max:number):Buffer {
 const fd=fs.openSync(file,'r');
 try{const before=fs.fstatSync(fd);if(!before.isFile()||before.size>max)throw new Error('source_bytes_limit');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new Error('source_changed');offset+=n;}
  const after=fs.fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.dev!==after.dev||before.ino!==after.ino)throw new Error('source_changed');
  return bytes;
 }finally{fs.closeSync(fd);}
}
