import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {open} from '../packages/core/src/db.js';
import {openAuditSqliteSnapshot} from '../packages/core/src/audit-sqlite.js';
import {describeStore} from '../packages/core/src/adapters/opencode.js';
import {readArchiveState,ARCHIVE_UNAVAILABLE_WARNING} from '../packages/core/src/archive-state.js';
import {audit} from '../packages/core/src/audit.js';
import {renderAuditCard} from '../packages/core/src/render/audit-card.js';
import {Theme} from '../packages/core/src/theme.js';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'audit-sqlite-snapshot-'));dirs.push(dir);return {dir,file:path.join(dir,'potsherd.db')};}
function inventory(dir:string){return Object.fromEntries(fs.readdirSync(dir).sort().map(n=>[n,createHash('sha256').update(fs.readFileSync(path.join(dir,n))).digest('hex')]));}
describe('frozen audit SQLite checkpoint',()=>{
  it('reads a checkpointed WAL-mode store without new or changed files and blocks snapshot writes',()=>{
    const {dir,file}=fixture(),writer=open({file});writer.exec("CREATE TABLE audit_fixture(value TEXT);INSERT INTO audit_fixture VALUES('checkpoint')");writer.close();
    const before=inventory(dir),snapshot=openAuditSqliteSnapshot(file);
    try{expect(snapshot.db.prepare('SELECT value FROM audit_fixture').get()).toEqual({value:'checkpoint'});expect(()=>snapshot.db.exec("INSERT INTO audit_fixture VALUES('blocked')")).toThrow();snapshot.assertCurrent();}finally{snapshot.db.close();}
    expect(inventory(dir)).toEqual(before);
  });
  it('holds a live WAL rather than returning stale checkpoint rows or touching support files',()=>{
    const {dir,file}=fixture(),writer=open({file});try{writer.exec("CREATE TABLE audit_fixture(value TEXT);INSERT INTO audit_fixture VALUES('checkpoint')");writer.pragma('wal_checkpoint(TRUNCATE)');writer.exec("INSERT INTO audit_fixture VALUES('live')");const before=inventory(dir);expect(()=>openAuditSqliteSnapshot(file)).toThrow('audit_sqlite_live_journal_unavailable');expect(inventory(dir)).toEqual(before);}finally{writer.close();}
  });
  it('invalidates a frozen policy snapshot after a committed source edit',()=>{
    const {file}=fixture(),writer=open({file});writer.close();const snapshot=openAuditSqliteSnapshot(file);try{const changed=open({file});changed.exec("INSERT INTO sync_state(key,value,updated_at) VALUES('audit-fixture','changed','2026-10-01T00:00:00Z')");changed.close();expect(()=>snapshot.assertCurrent()).toThrow('audit_sqlite_snapshot_stale');}finally{snapshot.db.close();}
  });
  it('rejects a database larger than the explicit allocation cap before opening a reader',()=>{
    const {dir,file}=fixture(),writer=open({file});writer.close();const before=inventory(dir);expect(()=>openAuditSqliteSnapshot(file,100)).toThrow('audit_sqlite_snapshot_byte_limit');expect(inventory(dir)).toEqual(before);
  });
  it('reuses a supplied frozen OpenCode reader without reopening or closing the source',()=>{
    const {dir,file}=fixture(),writer=open({file});writer.exec('CREATE TABLE session(id TEXT,directory TEXT);CREATE TABLE message(id TEXT,session_id TEXT,role TEXT,content TEXT)');writer.close();const before=inventory(dir),snapshot=openAuditSqliteSnapshot(file);try{expect(describeStore(file,snapshot.db).ok).toBe(true);expect(snapshot.db.prepare('SELECT count(*) n FROM session').get()).toEqual({n:0});snapshot.assertCurrent();}finally{snapshot.db.close();}expect(inventory(dir)).toEqual(before);
  });
  it('preserves legacy archive counters without creating WAL support files',()=>{
    const {dir,file}=fixture(),writer=open({file});writer.close();const before=inventory(dir),state=readArchiveState(dir);expect(state?.ghosts).toBe(0);expect(state?.rescues).toBe(0);expect(inventory(dir)).toEqual(before);
  });
  it('keeps legacy local counts while disclosing live archive unavailability without a false rescue CTA',async()=>{
    const {dir,file}=fixture(),writer=open({file}),claude=fs.mkdtempSync(path.join(os.tmpdir(),'audit-legacy-claude-'));dirs.push(claude);fs.mkdirSync(path.join(claude,'projects'));fs.writeFileSync(path.join(claude,'history.jsonl'),JSON.stringify({sessionId:'missing-fixture',display:'A synthetic retained request',project:'/synthetic',timestamp:Date.now()})+'\n');try{writer.pragma('wal_checkpoint(TRUNCATE)');writer.exec("INSERT INTO sync_state(key,value,updated_at) VALUES('live','yes','2026-10-01T00:00:00Z')");const before=inventory(dir),report=await audit(claude,new Date(),{potsherdDir:dir});expect(report.archive).toBeNull();expect(report.warnings).toContain(ARCHIVE_UNAVAILABLE_WARNING);const card=renderAuditCard(report,new Theme({color:false}));expect(card).toContain('archive stats are unavailable');expect(card).not.toContain('potsherd rescue');expect(inventory(dir)).toEqual(before);}finally{writer.close();}
  });
});
