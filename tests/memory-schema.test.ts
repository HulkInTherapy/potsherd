import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { open } from '../packages/core/src/db.js';
import {MEMORY_SCHEMA_VERSION} from '../packages/core/src/memory/readiness.js';
describe('authoritative memory schema', () => {
 it('migrates additively with constraints and durable commits', () => {
  const db = open({file: ':memory:'});
  try {
   expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toMatchObject({v:MEMORY_SCHEMA_VERSION});
   expect(db.prepare('PRAGMA synchronous').get()).toMatchObject({synchronous:2});
   expect(db.prepare('SELECT * FROM memory_epochs').get()).toMatchObject({singleton:1,evidence_epoch:0});
   expect(()=>db.prepare("INSERT INTO forget_tombstones VALUES('x',NULL,NULL,'h','now','complete','{}')").run()).toThrow();
   expect(()=>db.prepare("INSERT INTO memory_sources VALUES('s','claude','n',NULL,NULL,'invented','now')").run()).toThrow();
   expect(()=>db.prepare("INSERT INTO maintenance_leases VALUES('x','owner',-1,1,'now','local','now','later')").run()).toThrow();
  } finally { db.close(); }
 });
});

it('does not create a missing directory while opening a read-only store',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'p12-readonly-'));try{const absent=path.join(root,'absent');expect(()=>open({root:absent,readonly:true})).toThrow();expect(fs.existsSync(absent)).toBe(false);}finally{fs.rmSync(root,{recursive:true,force:true});}});
