import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {open} from '../packages/core/src/db.js';import {resetDriverCache,sqliteDriverName} from '../packages/core/src/sqlite-driver.js';
import {parseClaudeTranscript} from '../packages/core/src/parser/claude.js';import {publishSource,inspectCoverage} from '../packages/core/src/memory/source.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
for(const selected of ['better-sqlite3','node'] as const)describe(`unit-scoped coverage with ${selected}`,()=>{
 it('reports conservative spans only for their own eligible project unit',async()=>{
  const previous=process.env.POTSHERD_SQLITE;process.env.POTSHERD_SQLITE=selected;resetDriverCache();const db=open({file:':memory:'});
  try{expect(sqliteDriverName()).toBe(selected==='node'?'node:sqlite':'better-sqlite3');const root=fs.mkdtempSync(path.join(os.tmpdir(),'coverage-mixed-public-'));roots.push(root);const file=path.join(root,'fixture.jsonl');fs.writeFileSync(file,['A','B'].map(project=>JSON.stringify({type:'user',sessionId:'mixed',uuid:'u-'+project,promptId:'p-'+project,cwd:'/fixture/'+project,timestamp:'2026-10-07T05:00:00Z',message:{role:'user',content:'A public coverage fixture for project '+project}})).join('\n')+'\n');const parsed=await parseClaudeTranscript(file),raw=fs.readFileSync(file);publishSource(db,{parsed,artifactHash:createHash('sha256').update(raw).digest('hex'),artifactBytes:raw.length});
   db.exec("UPDATE evidence_spans SET chunk_policy='synthetic-qualified-tokenizer';UPDATE evidence_spans SET chunk_policy='span-conservative-utf8-v1' WHERE unit_revision_id IN (SELECT unit_revision_id FROM evidence_units WHERE project='/fixture/B')");
   expect(inspectCoverage(db,{project:'/fixture/A'}).omittedKinds).not.toContain('chunking_tokenizer_unavailable');expect(inspectCoverage(db,{project:'/fixture/B'}).omittedKinds).toContain('chunking_tokenizer_unavailable');expect(inspectCoverage(db).omittedKinds).toContain('chunking_tokenizer_unavailable');
  }finally{db.close();if(previous===undefined)delete process.env.POTSHERD_SQLITE;else process.env.POTSHERD_SQLITE=previous;resetDriverCache();}
 });
});
