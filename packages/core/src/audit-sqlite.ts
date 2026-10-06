import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { openDatabaseSnapshot, type Db } from './sqlite-driver.js';

export interface AuditSqliteSnapshot { db: Db; hash: string; assertCurrent(): void; }
const fingerprint=(stat:fs.BigIntStats)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
function checkWal(file:string):void {
  for (const suffix of ['-wal','-journal']) {
    try { if (fs.statSync(file+suffix).size>0) throw new Error('audit_sqlite_live_journal_unavailable'); }
    catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  }
}
function readBounded(file:string,maxBytes:number):{bytes:Buffer;identity:string} {
  checkWal(file);
  const fd=fs.openSync(file,'r');
  try {
    const before=fs.fstatSync(fd,{bigint:true}),size=Number(before.size);
    if (!before.isFile()||!Number.isSafeInteger(size)||size<100||size>maxBytes) throw new Error('audit_sqlite_snapshot_byte_limit');
    const bytes=Buffer.alloc(size);let offset=0;
    while(offset<size){const n=fs.readSync(fd,bytes,offset,Math.min(1024*1024,size-offset),offset);if(!n)throw new Error('audit_sqlite_snapshot_stale');offset+=n;}
    const identity=fingerprint(before);
    if(fingerprint(fs.fstatSync(fd,{bigint:true}))!==identity||fingerprint(fs.statSync(file,{bigint:true}))!==identity)throw new Error('audit_sqlite_snapshot_stale');
    checkWal(file);return {bytes,identity};
  } finally { fs.closeSync(fd); }
}
function digest(bytes:Buffer):string{return createHash('sha256').update(bytes).digest('hex');}
function verifier(file:string,maxBytes:number,identity:string,hash:string):()=>void {
  return ()=>{const now=readBounded(file,maxBytes);if(now.identity!==identity||digest(now.bytes)!==hash)throw new Error('audit_sqlite_snapshot_stale');};
}

/**
 * Frozen checkpoint only: a nonempty WAL/journal is never ignored. SQLite's
 * documented deserialization workaround changes header bytes in our COPY,
 * never the source. No reader side files or temporary database are created.
 */
export function openAuditSqliteSnapshot(file:string,maxBytes=64*1024*1024):AuditSqliteSnapshot {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<100||maxBytes>256*1024*1024)throw new Error('invalid audit SQLite byte limit');
  const {bytes,identity}=readBounded(file,maxBytes),hash=digest(bytes);
  if(bytes.subarray(0,16).toString('binary')!=='SQLite format 3\0')throw new Error('audit_sqlite_format_unavailable');
  const copy=Buffer.from(bytes);copy[18]=1;copy[19]=1;
  const db=openDatabaseSnapshot(copy),assertCurrent=verifier(file,maxBytes,identity,hash);
  db.pragma('temp_store = MEMORY');
  db.pragma('query_only = ON');
  try{assertCurrent();return {db,hash,assertCurrent};}catch(error){db.close();throw error;}
}
