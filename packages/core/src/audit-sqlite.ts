import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {openDatabase,type Db} from './sqlite-driver.js';

export interface AuditSqliteSnapshot {db:Db;hash:string;assertCurrent():void;/** Progress-only identity fence; authority boundaries retain full verification. */assertIdentityCurrent():void;}
export interface AuditSqliteSnapshotOptions {/** Elapsed guard around synchronous capture/setup; individual OS/SQLite calls are not preemptible. */maxCaptureMs?:number;}
interface SourceIdentity {database:string;wal:string|null;journal:string|null;databaseBytes:number;walBytes:number;shm:string|null;shmHeader:Buffer|null;}
interface Captured {identity:SourceIdentity;databaseHeader:Buffer;walHeader:Buffer|null;hash:string;}
const MAX_DISK_BYTES=4*1024*1024*1024,BUFFER_BYTES=1024*1024,DISK_HEADROOM=32*1024*1024;
const fingerprint=(s:fs.BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const same=(a:SourceIdentity,b:SourceIdentity)=>a.database===b.database&&a.wal===b.wal&&a.journal===b.journal&&a.shm===b.shm;
function optionalStat(file:string):fs.BigIntStats|null {try{return fs.lstatSync(file,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
const nativeBigEndian=os.endianness()==='BE';
function checksum(bytes:Buffer,start:number,length:number,bigEndian:boolean,seed:readonly number[]=[0,0]):[number,number] {
 let s0=seed[0]!,s1=seed[1]!;for(let i=start;i<start+length;i+=8){const a=bigEndian?bytes.readUInt32BE(i):bytes.readUInt32LE(i),b=bigEndian?bytes.readUInt32BE(i+4):bytes.readUInt32LE(i+4);s0=(s0+a+s1)>>>0;s1=(s1+b+s0)>>>0;}return [s0,s1];
}
const native32=(bytes:Buffer,offset:number)=>nativeBigEndian?bytes.readUInt32BE(offset):bytes.readUInt32LE(offset);
function readShm(file:string):{identity:string;header:Buffer} {
 const stat=optionalStat(file);if(!stat?.isFile()||stat.size<96n)throw new Error('audit_sqlite_wal_index_unavailable');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const header=Buffer.alloc(96);let offset=0;while(offset<96){const n=fs.readSync(fd,header,offset,96-offset,offset);if(!n)throw new Error('audit_sqlite_wal_index_unavailable');offset+=n;}
  const current=fs.fstatSync(fd,{bigint:true});if(current.dev!==stat.dev||current.ino!==stat.ino||current.size!==stat.size)throw new Error('audit_sqlite_snapshot_stale');
  const sum=checksum(header,0,40,nativeBigEndian);if(!header.subarray(0,48).equals(header.subarray(48,96))||native32(header,0)!==3007000||native32(header,4)!==0||header[12]!==1||sum[0]!==native32(header,40)||sum[1]!==native32(header,44))throw new Error('audit_sqlite_wal_index_unavailable');
  return {identity:[stat.dev,stat.ino,stat.size,createHash('sha256').update(header).digest('hex')].join(':'),header};
 }finally{fs.closeSync(fd);}
}
function inspect(file:string,maxBytes:number):SourceIdentity {
 const journal=optionalStat(file+'-journal');if(journal&&journal.size>0n)throw new Error('audit_sqlite_rollback_journal_unavailable');
 const database=fs.lstatSync(file,{bigint:true}),wal=optionalStat(file+'-wal');
 if(!database.isFile()||(wal&&!wal.isFile())||(journal&&!journal.isFile()))throw new Error('audit_sqlite_format_unavailable');
 const databaseBytes=Number(database.size),walBytes=wal?Number(wal.size):0;
 if(!Number.isSafeInteger(databaseBytes)||!Number.isSafeInteger(walBytes)||databaseBytes<100||databaseBytes+walBytes>maxBytes)throw new Error('audit_sqlite_snapshot_byte_limit');
 const shm=walBytes>0?readShm(file+'-shm'):null;return {database:fingerprint(database),wal:wal?fingerprint(wal):null,journal:journal?fingerprint(journal):null,databaseBytes,walBytes,shm:shm?.identity??null,shmHeader:shm?.header??null};
}
function deadline(maxMs:number):()=>void {const start=performance.now();return ()=>{if(performance.now()-start>maxMs)throw new Error('audit_sqlite_snapshot_time_limit');};}
/** One reusable buffer streams source bytes; only the owned destination receives writes. */
function stream(file:string,size:number,identity:string,buffer:Buffer,check:()=>void,destination?:string):{header:Buffer;hash:string} {
 check();let fd:number;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('audit_sqlite_snapshot_stale');throw error;}
 let out:number|undefined;
 try{if(fingerprint(fs.fstatSync(fd,{bigint:true}))!==identity)throw new Error('audit_sqlite_snapshot_stale');if(destination)out=fs.openSync(destination,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  const header=Buffer.alloc(Math.min(size,100)),hash=createHash('sha256');let offset=0;
  while(offset<size){check();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,size-offset),offset);if(!n)throw new Error('audit_sqlite_snapshot_stale');const chunk=buffer.subarray(0,n);hash.update(chunk);if(offset<header.length)chunk.copy(header,offset,0,Math.min(n,header.length-offset));
   if(out!==undefined){let written=0;while(written<n){check();const count=fs.writeSync(out,buffer,written,n-written,offset+written);if(!count)throw new Error('audit_sqlite_snapshot_copy_unavailable');written+=count;}}offset+=n;
  }
  if(out!==undefined)fs.fsyncSync(out);check();if(fingerprint(fs.fstatSync(fd,{bigint:true}))!==identity)throw new Error('audit_sqlite_snapshot_stale');return {header,hash:hash.digest('hex')};
 }finally{fs.closeSync(fd);if(out!==undefined)fs.closeSync(out);}
}
function capture(file:string,maxBytes:number,check:()=>void,buffer:Buffer,directory?:string):Captured {
 check();const identity=inspect(file,maxBytes),copy=directory?path.join(directory,'snapshot.db'):undefined;
 const database=stream(file,identity.databaseBytes,identity.database,buffer,check,copy),wal=identity.wal===null?null:stream(file+'-wal',identity.walBytes,identity.wal,buffer,check,copy?copy+'-wal':undefined);
 if(!same(identity,inspect(file,maxBytes)))throw new Error('audit_sqlite_snapshot_stale');check();
 const hash=createHash('sha256').update(JSON.stringify([identity.database,identity.wal,identity.journal,identity.shm])).update(database.hash).update(wal===null?'absent':wal.hash).digest('hex');check();return {identity,databaseHeader:database.header,walHeader:wal?.header??null,hash};
}
/** Header and frame-shape checks; committed WAL checksum verification follows. */
function validateEnvelope(captured:Captured):void {
 const db=captured.databaseHeader,wal=captured.walHeader;if(db.subarray(0,16).toString('binary')!=='SQLite format 3\0')throw new Error('audit_sqlite_format_unavailable');
 if(!captured.identity.walBytes)return;if(!wal||wal.length<32)throw new Error('audit_sqlite_wal_header_unavailable');
 const magic=wal.readUInt32BE(0),version=wal.readUInt32BE(4),pageSize=wal.readUInt32BE(8),databasePageSize=db.readUInt16BE(16)===1?65536:db.readUInt16BE(16);
 if((magic!==0x377f0682&&magic!==0x377f0683)||version!==3007000||pageSize<512||pageSize>65536||(pageSize&(pageSize-1))!==0||pageSize!==databasePageSize)throw new Error('audit_sqlite_wal_header_unavailable');
 // A stable partial frame cannot establish whether its lost tail was a commit.
 if((captured.identity.walBytes-32)%(pageSize+24)!==0)throw new Error('audit_sqlite_wal_incomplete_tail');
}

/** Certify the published commit boundary, without interpreting or replaying database pages. */
function validateCommittedWal(captured:Captured,walFile:string,buffer:Buffer,check:()=>void):number {
 if(!captured.identity.walBytes)return 0;const wal=captured.walHeader!,shm=captured.identity.shmHeader!;
 const bigEndian=wal.readUInt32BE(0)===0x377f0683,pageSize=wal.readUInt32BE(8),rawShmPage=nativeBigEndian?shm.readUInt16BE(14):shm.readUInt16LE(14),shmPage=rawShmPage===1?65536:rawShmPage;
 let sum=checksum(wal,0,24,bigEndian);const mxFrame=native32(shm,16),nPage=native32(shm,20),committedBytes=32+mxFrame*(pageSize+24);
 const fail=()=>{throw new Error('audit_sqlite_wal_integrity_unavailable');};
 if(sum[0]!==wal.readUInt32BE(24)||sum[1]!==wal.readUInt32BE(28)||shm[13]!==Number(bigEndian)||shmPage!==pageSize||!shm.subarray(32,40).equals(wal.subarray(16,24))||committedBytes>captured.identity.walBytes)fail();
 const fd=fs.openSync(walFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{for(let frame=1;frame<=mxFrame;frame++){check();const length=pageSize+24,position=32+(frame-1)*length;let offset=0;while(offset<length){const n=fs.readSync(fd,buffer,offset,length-offset,position+offset);if(!n)fail();offset+=n;}
   if(buffer.readUInt32BE(0)===0||!buffer.subarray(8,16).equals(wal.subarray(16,24)))fail();sum=checksum(buffer,0,8,bigEndian,sum);sum=checksum(buffer,24,pageSize,bigEndian,sum);
   if(sum[0]!==buffer.readUInt32BE(16)||sum[1]!==buffer.readUInt32BE(20))fail();
   if(frame===mxFrame&&(buffer.readUInt32BE(4)===0||buffer.readUInt32BE(4)!==nPage||sum[0]!==native32(shm,24)||sum[1]!==native32(shm,28)))fail();
  }
 }finally{fs.closeSync(fd);}
 check();return committedBytes;
}
/**
 * Stable bounded source bytes are streamed without opening source through SQLite.
 * The selected driver resolves committed WAL on a private copy. Only the owned
 * directory may receive SQLite coordination files; source DB/WAL/SHM never do.
 * Official checksums and stable duplicated WAL-index metadata certify the commit
 * boundary; only the owned WAL is truncated past that boundary before SQLite reads.
 * Pages actually queried are validated by SQLite; this is not a whole-DB integrity
 * certification. Full currentness streams hashes; progress uses identities only.
 */
export function openAuditSqliteSnapshot(file:string,maxBytes=MAX_DISK_BYTES,options:AuditSqliteSnapshotOptions={}):AuditSqliteSnapshot {
 if(!Number.isSafeInteger(maxBytes)||maxBytes<100||maxBytes>MAX_DISK_BYTES)throw new Error('invalid audit SQLite byte limit');
 const initial=inspect(file,maxBytes);
 // Large snapshots need bounded copy/verification headroom: 20s per started GiB,
 // bounded at 60s, while explicit caller guards remain authoritative.
 const maxCaptureMs=options.maxCaptureMs??Math.min(60000,Math.max(20000,Math.ceil((initial.databaseBytes+initial.walBytes)/(1024*1024*1024))*20000));
 if(!Number.isFinite(maxCaptureMs)||maxCaptureMs<1||maxCaptureMs>60000)throw new Error('invalid audit SQLite time limit');
 const check=deadline(maxCaptureMs);check();const free=fs.statfsSync(os.tmpdir(),{bigint:true});
 if(free.bavail*free.bsize<BigInt(initial.databaseBytes+initial.walBytes+DISK_HEADROOM))throw new Error('audit_sqlite_snapshot_disk_limit');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'slopie-audit-sqlite-'));let db:Db|undefined;
 try{fs.chmodSync(directory,0o700);const buffer=Buffer.allocUnsafe(BUFFER_BYTES),captured=capture(file,maxBytes,check,buffer,directory);validateEnvelope(captured);const confirmed=capture(file,maxBytes,check,buffer);
  if(captured.hash!==confirmed.hash||!same(captured.identity,confirmed.identity))throw new Error('audit_sqlite_snapshot_stale');
  const copy=path.join(directory,'snapshot.db');const committedBytes=validateCommittedWal(captured,copy+'-wal',buffer,check);if(captured.identity.walBytes)fs.truncateSync(copy+'-wal',committedBytes);db=openDatabase(copy,{readonly:true,fileMustExist:true});db.pragma('temp_store = MEMORY');db.pragma('query_only = ON');db.prepare('SELECT count(*) FROM sqlite_schema').get();
  for(const name of fs.readdirSync(directory))fs.chmodSync(path.join(directory,name),0o600);check();
  const assertCurrent=()=>{const now=capture(file,maxBytes,deadline(maxCaptureMs),Buffer.allocUnsafe(BUFFER_BYTES));if(now.hash!==captured.hash||!same(now.identity,captured.identity))throw new Error('audit_sqlite_snapshot_stale');};
  const assertIdentityCurrent=()=>{if(!same(inspect(file,maxBytes),captured.identity))throw new Error('audit_sqlite_snapshot_stale');};
  // The preceding full hash confirmation plus this final identity fence binds
  // setup to the same source; no redundant third complete read during opening.
  assertIdentityCurrent();check();const handle=db,rawClose=handle.close.bind(handle);let closed=false;handle.close=()=>{if(!closed){closed=true;try{rawClose();}finally{fs.rmSync(directory,{recursive:true,force:true});}}return handle;};
  return {db,hash:captured.hash,assertCurrent,assertIdentityCurrent};
 }catch(error){try{db?.close();}finally{fs.rmSync(directory,{recursive:true,force:true});}const code=(error as NodeJS.ErrnoException).code;if(code?.startsWith('SQLITE_')||code==='ERR_SQLITE_ERROR')throw new Error('audit_sqlite_snapshot_corrupt',{cause:error});throw error;}
}

/** Cheap policy guard: certify ONLY published WAL integrity, never read/copy DB
 * history pages. Missing committed SHM boundary is an explicit refusal. */
export function verifyAuditPolicyWal(file:string):{assertCurrent():void} {
 const check=deadline(10000),initial=inspect(file,MAX_DISK_BYTES);if(initial.walBytes>256*1024*1024)throw new Error('audit_policy_wal_byte_limit');
 const header=(name:string,length:number)=>{const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const bytes=Buffer.alloc(length);let offset=0;while(offset<length){const n=fs.readSync(fd,bytes,offset,length-offset,offset);if(!n)throw new Error('audit_sqlite_format_unavailable');offset+=n;}return bytes;}finally{fs.closeSync(fd);}};
 const captured:Captured={identity:initial,databaseHeader:header(file,100),walHeader:initial.walBytes?header(file+'-wal',32):null,hash:''};validateEnvelope(captured);validateCommittedWal(captured,file+'-wal',Buffer.allocUnsafe(65536+24),check);
 // SQLite may rebuild SHM and reset iChange without changing any history.
 // readShm independently validates both full headers/checksums before this
 // semantic comparison; the original snapshot whole-header fence is unchanged.
 const semantic=(header:Buffer|null)=>header?Buffer.concat([header.subarray(0,8),header.subarray(12,40)]).toString('hex'):null;
 const assertCurrent=()=>{const next=inspect(file,MAX_DISK_BYTES);if(initial.database!==next.database||initial.wal!==next.wal||initial.journal!==next.journal||semantic(initial.shmHeader)!==semantic(next.shmHeader))throw new Error('audit_policy_changed');};assertCurrent();return {assertCurrent};
}
