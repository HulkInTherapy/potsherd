import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import type {Db} from '../db.js';import {openSqliteReadOnly} from '../db.js';import type {Harness} from '../adapters/types.js';
import {findStores,describeStore} from '../adapters/opencode.js';import {stateFileIn} from '../adapters/copilot.js';
export type CaptureCapability={version:1;harness:Harness;rootHash:string;present:boolean;fidelity:'record'|'projection'|'unknown';state:'absent'|'ready'|'empty'|'limited'|'unsupported'|'unverified'|'failed';codes:string[];discovered:number;layoutFingerprint?:string;lastObservedAt:string};
const key=(harness:string)=>`memory:capture-capability:${harness}`;
/** Writer-side native-store inspection. No version guessing, writes, or transcript export. */
export function inspectCaptureCapability(harness:Harness,root:string,discovered:number,failed:number):CaptureCapability{
 const value:CaptureCapability={version:1,harness,rootHash:createHash('sha256').update(path.resolve(root)).digest('hex'),present:false,fidelity:['claude','codex'].includes(harness)?'record':'projection',state:'absent',codes:[],discovered,lastObservedAt:new Date().toISOString()};
 try{value.present=fs.statSync(root).isDirectory();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){value.state='failed';value.codes=['source_root_unreadable'];}return value;}
 value.state=discovered?'ready':'empty';if(failed){value.state='failed';value.codes.push('capture_failed');}
 if(harness==='cursor'||harness==='pi'){value.codes.push('exchange_projection_fidelity');if(discovered)value.state='limited';}
 if(harness==='gemini'&&discovered){value.state='unverified';value.codes.push('gemini_checkpoint_unverified','exchange_projection_fidelity','native_turn_time_unavailable');}
 if(harness==='copilot'){
  let native=false;try{native=fs.statSync(path.join(root,'session-store.db')).isFile();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){value.state='failed';value.codes.push('native_store_probe_failed');}}
  const sessions=path.join(root,'session-state');if(fs.existsSync(sessions))for(const entry of fs.readdirSync(sessions,{withFileTypes:true})){if(entry.isDirectory()&&fs.existsSync(path.join(sessions,entry.name,'workspace.yaml'))&&!stateFileIn(path.join(sessions,entry.name)))native=true;}
  if(native){value.layoutFingerprint=nativeFingerprint(path.join(root,'session-store.db'));value.state='unsupported';value.codes.push('copilot_native_conversations_unread');}else if(discovered){value.state='limited';value.codes.push('exchange_projection_fidelity','copilot_export_format_only');}
 }
 if(harness==='opencode'){
  let unsupported=false,inconclusive=false;for(const file of findStores(root)){const described=describeStore(file);if(!described.ok){unsupported=true;continue;}const db=openSqliteReadOnly(file);try{const parts=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN('part','parts')").get());if(parts&&!described.schema.messages.columns['role']&&!described.schema.parts)unsupported=true;}catch{inconclusive=true;}finally{db.close();}}
  if(unsupported){value.state='unsupported';value.codes.push('opencode_native_message_parts_unread');}else if(inconclusive){value.state='failed';value.codes.push('native_store_probe_inconclusive');}else if(discovered){value.state='limited';value.codes.push('exchange_projection_fidelity');}
 }
 value.codes=[...new Set(value.codes)].sort();return value;
}
/** Observation time alone is not a semantic epoch change. */
export function persistCaptureCapability(db:Db,value:CaptureCapability,beforeCommit?:()=>void):void{
 db.transaction(()=>{beforeCommit?.();const old=db.prepare('SELECT value FROM sync_state WHERE key=?').get(key(value.harness)) as {value:string}|undefined;const semantic=(entry:CaptureCapability)=>JSON.stringify({...entry,lastObservedAt:undefined});const changed=!old||semantic(JSON.parse(old.value) as CaptureCapability)!==semantic(value);db.prepare('INSERT INTO sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key(value.harness),JSON.stringify(value),value.lastObservedAt);if(changed)db.prepare('UPDATE memory_epochs SET evidence_epoch=evidence_epoch+1,lineage_epoch=lineage_epoch+1 WHERE singleton=1').run();}).immediate();
}
/** Read paths consume only saved health tied to the saved enrollment. */
export function storedCaptureLimitations(db:Db,sourceIds?:string[],harnesses?:string[]):{codes:string[];incomplete:boolean}{
 const row=db.prepare("SELECT value FROM sync_state WHERE key='memory:source-enrollment'").get() as {value:string}|undefined;if(!row)return{codes:[],incomplete:false};const enrollment=JSON.parse(row.value) as {harnesses:string[];options:Record<string,string>};const names:Record<string,string>={claude:'claudeDir',codex:'codexHome',cursor:'cursorDir',pi:'piDir',gemini:'geminiDir',opencode:'opencodeDir',copilot:'copilotDir'};
 let selected=harnesses??enrollment.harnesses;if(!harnesses&&sourceIds?.length)selected=(db.prepare(`SELECT DISTINCT harness FROM memory_sources WHERE source_id IN (${sourceIds.map(()=>'?').join(',')})`).all(...sourceIds) as {harness:string}[]).map(item=>item.harness);
 if(!harnesses&&sourceIds&&!sourceIds.length)return {codes:[],incomplete:false};const codes:string[]=[];let incomplete=false;
 for(const harness of selected){if(!enrollment.harnesses.includes(harness))continue;const saved=db.prepare('SELECT value FROM sync_state WHERE key=?').get(key(harness)) as {value:string}|undefined;if(!saved){incomplete=true;codes.push(`${harness}:capture_capability_unverified`);continue;}const health=JSON.parse(saved.value) as CaptureCapability;const root=enrollment.options[names[harness]!];if(!root||health.rootHash!==createHash('sha256').update(path.resolve(root)).digest('hex')){incomplete=true;codes.push(`${harness}:capture_capability_unverified`);continue;}if(!health.present&&health.state!=='failed')continue;codes.push(...health.codes.map(code=>`${harness}:${code}`));if(['limited','unsupported','unverified','failed'].includes(health.state))incomplete=true;}
 return {codes:[...new Set(codes)].slice(0,16),incomplete};
}

function nativeFingerprint(file:string):string|undefined{
 try{const stat=fs.statSync(file);const fd=fs.openSync(file,'r');try{const bytes=Buffer.alloc(Math.min(stat.size,65536));const n=fs.readSync(fd,bytes,0,bytes.length,0);return createHash('sha256').update(String(stat.size)).update(bytes.subarray(0,n)).digest('hex');}finally{fs.closeSync(fd);}}catch{return undefined;}
}
