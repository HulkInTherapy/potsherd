import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {openDatabase,type Db} from '../sqlite-driver.js';
import {assertMemorySchema} from '../memory/readiness.js';
import {readEpochs} from '../memory/source.js';
import {verifyAuditPolicyWal} from '../audit-sqlite.js';
import type {Epochs} from '../memory/contracts.js';

export interface AuditAuthority {
 epochs:Epochs|null; forgottenSourceIds:ReadonlySet<string>; commitment:string; configHash:string|null;
}
const identity=(file:string)=>{const s=fs.lstatSync(file,{bigint:true});if(!s.isFile())throw new Error('audit_policy_format_unavailable');return `${s.dev}:${s.ino}`;};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const verifiedWal=new Map<string,ReturnType<typeof verifyAuditPolicyWal>>();
function currentWal(file:string):ReturnType<typeof verifyAuditPolicyWal>{const previous=verifiedWal.get(file);if(previous){try{previous.assertCurrent();return previous;}catch{verifiedWal.delete(file);}}const next=verifyAuditPolicyWal(file);if(verifiedWal.size>=32)verifiedWal.delete(verifiedWal.keys().next().value!);verifiedWal.set(file,next);return next;}
function configHash(file:string):string|null {
 try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(fd,{bigint:true});if(!before.isFile()||before.size>1048576n)throw new Error('ignore_policy_unavailable');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('ignore_policy_unavailable');return hash(bytes);}finally{fs.closeSync(fd);}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
/** Normal read-only SQLite may coordinate through SHM; it cannot write history.
 * No immutable URI, checkpoint, journal mode change, migration or source copy.
 */
export function openAuditPolicyDb(file:string):Db {
 identity(file);try{if(fs.statSync(file+'-journal').size>0)throw new Error('audit_policy_rollback_journal_unavailable');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const db=openDatabase(file,{readonly:true,fileMustExist:true});try{db.pragma('query_only = ON');assertMemorySchema(db);return db;}catch(error){db.close();throw error;}
}
/** Short transactions read actual revocation rows, including manually inserted
 * tombstones. Ordinary evidence/notes/lineage appends do not revoke a capture.
 */
export function readAuditAuthority(dbFile:string,configFile:string):AuditAuthority {
 const configuration=configHash(configFile);if(!fs.existsSync(dbFile))return {epochs:null,forgottenSourceIds:new Set(),configHash:configuration,commitment:hash(JSON.stringify(['absent',configuration]))};
 const before=identity(dbFile),guard=currentWal(dbFile),db=openAuditPolicyDb(dbFile);try{
  db.exec('BEGIN');let epochs:Epochs,tombstones:{tombstone_id:string;source_id:string|null;note_id:string|null;scope_hash:string;state:string}[],forgotten:{source_id:string}[];
  try{epochs=readEpochs(db);tombstones=db.prepare("SELECT tombstone_id,source_id,note_id,scope_hash,state FROM forget_tombstones WHERE state<>'reversed' ORDER BY tombstone_id LIMIT 100001").all() as typeof tombstones;forgotten=db.prepare("SELECT source_id FROM memory_sources WHERE availability='forgotten' ORDER BY source_id LIMIT 100001").all() as typeof forgotten;if(tombstones.length>100000||forgotten.length>100000)throw new Error('audit_policy_row_limit');db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  guard.assertCurrent();if(identity(dbFile)!==before||configHash(configFile)!==configuration)throw new Error('audit_policy_changed');
  return {epochs,forgottenSourceIds:new Set([...forgotten.map(row=>row.source_id),...tombstones.flatMap(row=>row.source_id?[row.source_id]:[])]),configHash:configuration,commitment:hash(JSON.stringify([before,configuration,epochs.deletion,tombstones,forgotten]))};
 }finally{db.close();}
}
