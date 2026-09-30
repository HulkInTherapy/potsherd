import {randomUUID} from 'node:crypto';
import type {Db} from '../db.js';
import {validatedSpanVectorBlob} from './vector-validation.js';
export type PendingSpan={span_id:string;ordinal:number;input_hash:string};
const reservations=new WeakMap<Db,EmbeddingWorkset>();
function setting(db:Db,name:string):number {return Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string,unknown>)[0]);}
/** Exclusive, connection-local disposable metadata. Durable vectors remain the authority. */
export class EmbeddingWorkset {
 readonly pendingTable:string;readonly targetTable:string;
 readonly statistics={scanPages:0,scannedRows:0,targetScans:0,maxPageRows:0,pendingLookups:0};
 readonly configuration:{tempStore:number;tempCacheKiB:number;compileTempStore:number};
 cleanup:{settingsRestored:boolean;foreignTempObjectsPresent:boolean}|null=null;
 private closed=false;private previousStore:number;private previousCache:number;
 constructor(private db:Db,readonly spaceId:string,private assertOwner:()=>void){
  // temp_store changes DELETE all TEMP objects. Never configure a shared/live TEMP schema.
  if(reservations.has(db)||db.prepare('SELECT name FROM temp.sqlite_master LIMIT 1').get())throw new Error('embedding_workset_connection_busy');
  this.assertOwner();this.previousStore=setting(db,'temp_store');this.previousCache=setting(db,'temp.cache_size');
  const options=db.prepare('PRAGMA compile_options').all() as Record<string,string>[];
  const declared=options.map(row=>Object.values(row)[0]!).find(value=>value.startsWith('TEMP_STORE='));
  const compiled=Number(declared?.split('=')[1]);
  if(![0,1,2].includes(compiled))throw new Error('embedding_file_temp_unsupported');
  const name='memory_embedding_'+randomUUID().replaceAll('-','');this.pendingTable=name+'_pending';this.targetTable=name+'_targets';
  try{
   db.exec('PRAGMA temp_store=FILE;PRAGMA temp.cache_size=-2048');
   const tempStore=setting(db,'temp_store'),tempCacheKiB=setting(db,'temp.cache_size');
   if(tempStore!==1||tempCacheKiB!==-2048)throw new Error('embedding_temp_configuration_failed');
   this.configuration={tempStore,tempCacheKiB,compileTempStore:compiled};
   db.exec(`CREATE TEMP TABLE ${this.pendingTable}(space_id TEXT NOT NULL,revision_id TEXT NOT NULL,ordinal INTEGER NOT NULL,span_id TEXT NOT NULL,input_hash TEXT NOT NULL,PRIMARY KEY(space_id,revision_id,ordinal,span_id)) WITHOUT ROWID;CREATE TEMP TABLE ${this.targetTable}(space_id TEXT NOT NULL,revision_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,PRIMARY KEY(space_id,revision_id)) WITHOUT ROWID`);reservations.set(db,this);
  }catch(error){this.dropOwn();this.restoreSettings();throw error;}
 }
 static forConnection(db:Db):EmbeddingWorkset|undefined {return reservations.get(db);}
 /** Unique scan names borrow only this verified connection owner and never touch progress rows. */
 validationScan<T>(operation:(membership:string,debt:string)=>T):T {
  this.assertOpen();if(setting(this.db,'temp_store')!==1||setting(this.db,'temp.cache_size')!==-2048)throw new Error('embedding_temp_configuration_changed');const name=randomUUID().replaceAll('-',''),membership='memory_vector_membership_'+name,debt='memory_vector_debt_'+name;let madeMembership=false,madeDebt=false;
  try{
   this.db.exec(`CREATE TEMP TABLE ${membership}(span_id TEXT NOT NULL,revision_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(span_id,revision_id)) WITHOUT ROWID`);madeMembership=true;
   this.db.exec(`CREATE TEMP TABLE ${debt}(revision_id TEXT PRIMARY KEY,source_id TEXT NOT NULL)`);madeDebt=true;
   return operation('temp.'+membership,'temp.'+debt);
  }finally{if(madeDebt)this.db.exec(`DROP TABLE IF EXISTS temp.${debt}`);if(madeMembership)this.db.exec(`DROP TABLE IF EXISTS temp.${membership}`);}
 }
 private assertOpen():void {if(this.closed)throw new Error('embedding_workset_closed');this.assertOwner();}
 /** A failed/aborted scan never installs a scanned-target marker or completes work. */
 private scan(revisionId:string,manifestHash:string,signal?:AbortSignal):void {
  this.assertOpen();this.db.transaction(()=>{
   this.assertOpen();signal?.throwIfAborted();
   this.db.prepare(`DELETE FROM temp.${this.pendingTable} WHERE space_id=? AND revision_id=?`).run(this.spaceId,revisionId);
   let ordinal=-1;for(;;){signal?.throwIfAborted();this.assertOwner();
    const page=this.db.prepare(`SELECT rs.ordinal,p.span_id,p.embedding_input_hash,e.vector_blob FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id LEFT JOIN span_embeddings e ON e.span_id=p.span_id AND e.space_id=? AND e.input_hash=p.embedding_input_hash WHERE rs.revision_id=? AND rs.ordinal>? ORDER BY rs.ordinal LIMIT 128`).all(this.spaceId,revisionId,ordinal) as {ordinal:number;span_id:string;embedding_input_hash:string;vector_blob:Buffer|null}[];
    if(!page.length)break;this.statistics.scanPages++;this.statistics.scannedRows+=page.length;this.statistics.maxPageRows=Math.max(this.statistics.maxPageRows,page.length);
    for(const row of page){signal?.throwIfAborted();ordinal=row.ordinal;if(!validatedSpanVectorBlob(row.vector_blob))this.db.prepare(`INSERT INTO temp.${this.pendingTable} VALUES(?,?,?,?,?)`).run(this.spaceId,revisionId,row.ordinal,row.span_id,row.embedding_input_hash);}
   }
   signal?.throwIfAborted();this.assertOwner();this.db.prepare(`INSERT OR REPLACE INTO temp.${this.targetTable} VALUES(?,?,?)`).run(this.spaceId,revisionId,manifestHash);this.statistics.targetScans++;
  }).immediate();
 }
 take(revisionId:string,manifestHash:string,signal?:AbortSignal):PendingSpan[]{
  this.assertOpen();const known=this.db.prepare(`SELECT manifest_hash FROM temp.${this.targetTable} WHERE space_id=? AND revision_id=?`).get(this.spaceId,revisionId) as {manifest_hash:string}|undefined;
  if(known&&known.manifest_hash!==manifestHash)throw new Error('embedding_revision_changed');
  if(!known)this.scan(revisionId,manifestHash,signal);
  this.statistics.pendingLookups++;
  const rows=this.db.prepare(`SELECT span_id,ordinal,input_hash FROM temp.${this.pendingTable} WHERE space_id=? AND revision_id=? ORDER BY ordinal,span_id LIMIT 2`).all(this.spaceId,revisionId) as PendingSpan[];
  if(rows.length||!known)return rows;
  // A cached empty frontier is not completeness: revalidate every persisted payload.
  this.scan(revisionId,manifestHash,signal);this.statistics.pendingLookups++;
  return this.db.prepare(`SELECT span_id,ordinal,input_hash FROM temp.${this.pendingTable} WHERE space_id=? AND revision_id=? ORDER BY ordinal,span_id LIMIT 2`).all(this.spaceId,revisionId) as PendingSpan[];
 }
 committed(revisionId:string,spanId:string,inputHash:string,ordinal:number):void {this.assertOpen();this.db.prepare(`DELETE FROM temp.${this.pendingTable} WHERE space_id=? AND revision_id=? AND ordinal=? AND span_id=? AND input_hash=?`).run(this.spaceId,revisionId,ordinal,spanId,inputHash);}
 reset():void {this.assertOpen();this.db.exec(`DELETE FROM temp.${this.pendingTable};DELETE FROM temp.${this.targetTable}`);}
 private dropOwn():void {this.db.exec(`DROP TABLE IF EXISTS temp.${this.pendingTable};DROP TABLE IF EXISTS temp.${this.targetTable}`);}
 private restoreSettings():void {
  const foreign=Boolean(this.db.prepare('SELECT name FROM temp.sqlite_master LIMIT 1').get());
  if(!foreign)this.db.exec(`PRAGMA temp_store=${this.previousStore};PRAGMA temp.cache_size=${this.previousCache}`);
  this.cleanup={settingsRestored:!foreign,foreignTempObjectsPresent:foreign};
 }
 close():void {if(this.closed)return;this.closed=true;this.dropOwn();if(reservations.get(this.db)===this)reservations.delete(this.db);this.restoreSettings();}
}
