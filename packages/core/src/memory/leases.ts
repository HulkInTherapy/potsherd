import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Db } from '../db.js';
export type Fence={lane:string;ownerToken:string;generation:number};
const HOST=os.hostname();
function processStart(pid:number):string|null {try{return execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()||null;}catch{return null;}}
const START=processStart(process.pid)??'unknown:'+new Date(Date.now()-process.uptime()*1000).toISOString();
export function claimLease(db:Db,lane:string,now=Date.now(),ttl=30000):Fence|null {
 return db.transaction(()=>{
  const old=db.prepare('SELECT * FROM maintenance_leases WHERE lane=?').get(lane) as {owner_token:string;generation:number;pid:number;host_id:string;process_started_at:string;expires_at:string}|undefined;
  if(old&&old.process_started_at!=='released'){
   // Local live identity wins over age. Unknown remote identities are never stolen.
   if(old.host_id!==HOST)return null;
   const live=processStart(old.pid);if(live===old.process_started_at)return null;
   if(live===null||old.process_started_at.startsWith('unknown:')||/^\d{4}-/u.test(old.process_started_at)){try{process.kill(old.pid,0);return null;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return null;}}
  }
  const ownerToken=randomUUID(),generation=(old?.generation??0)+1,at=new Date(now).toISOString(),expires=new Date(now+ttl).toISOString();
  db.prepare(`INSERT INTO maintenance_leases(lane,owner_token,generation,pid,process_started_at,host_id,heartbeat_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(lane) DO UPDATE SET owner_token=excluded.owner_token,generation=excluded.generation,pid=excluded.pid,process_started_at=excluded.process_started_at,host_id=excluded.host_id,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at`).run(lane,ownerToken,generation,process.pid,START,HOST,at,expires);
  return {lane,ownerToken,generation};
 }).immediate();
}
export function assertFence(db:Db,f:Fence):void {if(!db.prepare('SELECT 1 FROM maintenance_leases WHERE lane=? AND owner_token=? AND generation=? AND process_started_at<>\'released\'').get(f.lane,f.ownerToken,f.generation))throw new Error('lease_superseded');}
export function heartbeatLease(db:Db,f:Fence,now=Date.now(),ttl=30000):boolean {return Number(db.prepare('UPDATE maintenance_leases SET heartbeat_at=?,expires_at=? WHERE lane=? AND owner_token=? AND generation=? AND process_started_at<>\'released\'').run(new Date(now).toISOString(),new Date(now+ttl).toISOString(),f.lane,f.ownerToken,f.generation).changes)>0;}
export function releaseLease(db:Db,f:Fence):boolean {
 // Retain the generation after release, rather than reset the fencing counter.
 return Number(db.prepare('UPDATE maintenance_leases SET process_started_at=?,expires_at=? WHERE lane=? AND owner_token=? AND generation=? AND process_started_at<>\'released\'').run('released',new Date(0).toISOString(),f.lane,f.ownerToken,f.generation).changes)>0;
}
