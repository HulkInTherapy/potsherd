import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {gunzipSync} from 'node:zlib';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {openSqliteReadOnly} from '../packages/core/src/db.js';
const fixtures=path.resolve('tests/fixtures/upgrade-1.2.1');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const legacyTables=['sessions','exchanges','tool_calls','notes','tags','pins'];
function legacyRows(file:string){const db=openSqliteReadOnly(file);try{return Object.fromEntries(legacyTables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));}finally{db.close();}}

describe('authentic installed 1.2.1 upgrade',()=>{
 it('preserves producer-created data and pre-upgrade backup through public migrate and restart',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'authentic-121-upgrade-')),file=path.join(root,'potsherd.db');
  const provenance=JSON.parse(fs.readFileSync(path.join(fixtures,'PROVENANCE.json'),'utf8'));
  const original=gunzipSync(fs.readFileSync(path.join(fixtures,'store.sqlite.gz')));
  expect(provenance.producerVersion).toBe('1.2.1');expect(sha(original)).toBe(provenance.fixtureSha256);
  fs.writeFileSync(file,original);const before=legacyRows(file);
  expect(before.exchanges).toHaveLength(1);expect(before.tool_calls).toHaveLength(1);expect(before.notes).toHaveLength(1);expect(before.pins).toHaveLength(1);expect(before.tags).toHaveLength(1);
  const cli=path.resolve('packages/cli/dist/potsherd.js');
  const run=()=>spawnSync(process.execPath,[cli,'maintain','--migrate','--json','--potsherd-dir',root],{env:{...process.env,POTSHERD_OFFLINE:'1'},encoding:'utf8',timeout:15000});
  try{
   const migrated=run();expect(migrated.status,migrated.stderr).toBe(0);expect(JSON.parse(migrated.stdout).initialization).toMatchObject({state:'ready',schemaVersion:18});
   expect(legacyRows(file)).toEqual(before);
   const backups=fs.readdirSync(path.join(root,'backups'));expect(backups).toHaveLength(1);const backup=path.join(root,'backups',backups[0]!);expect(legacyRows(backup)).toEqual(before);
   const old=openSqliteReadOnly(backup);try{expect(old.prepare('SELECT MAX(version) version FROM schema_migrations').get()).toMatchObject({version:12});}finally{old.close();}
   const db=openSqliteReadOnly(file);try{
    expect(db.prepare('SELECT COUNT(DISTINCT legacy_note_id) n FROM memory_note_events WHERE legacy_note_id=1').get()).toMatchObject({n:1});
    expect(db.prepare("SELECT COUNT(*) n FROM evidence_units WHERE role='assistant' AND text LIKE '%transaction mode%'").get()).toMatchObject({n:1});
   }finally{db.close();}
   const backupHash=sha(fs.readFileSync(backup));const restarted=run();expect(restarted.status,restarted.stderr).toBe(0);expect(legacyRows(file)).toEqual(before);expect(fs.readdirSync(path.join(root,'backups'))).toEqual(backups);expect(sha(fs.readFileSync(backup))).toBe(backupHash);
   expect(sha(gunzipSync(fs.readFileSync(path.join(fixtures,'store.sqlite.gz'))))).toBe(provenance.fixtureSha256);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
});
