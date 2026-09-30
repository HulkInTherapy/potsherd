import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {defaultBudget} from '../packages/core/src/memory/budget.js';import {complementaryReadRefs} from '../packages/core/src/memory/delivery.js';
import {it,expect} from 'vitest';import {compactFixture} from './memory-compact-fixture.js';
it('installed reader command prepares exact task then rejects malformed raw output and scope changes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-cli-'));
 try{const p=compactFixture(),input={taskId:'cli-reader',query:'What did the tool record?',scope:p.coverage.scope,packets:[p]};const file=path.join(root,'task.json');fs.writeFileSync(file,JSON.stringify(input));
  const run=(op:string)=>spawnSync(process.execPath,[path.resolve('packages/cli/bin/potsherd.js'),'reader',op,'--input-file',file,'--json'],{encoding:'utf8'});
  fs.writeFileSync(file,JSON.stringify({...input,budget:defaultBudget(2048)}));const next=run('next-read');expect(next.status).toBe(0);const selected=JSON.parse(next.stdout);expect(selected.request.refs).toEqual(complementaryReadRefs(p));expect(selected.request.scope).toEqual(p.coverage.scope);expect(selected.semanticSupport).toBe('unassessed');
  const routes={...p,evidence:[],assertions:[],candidates:[0,1,2].map(i=>({...p.candidates[0]!,ref:{...p.candidates[0]!.ref,spanId:`route${i}`}}))};
  fs.writeFileSync(file,JSON.stringify({...input,packets:[routes,{...routes,candidates:[]}],budget:defaultBudget(2048),attemptedRefs:routes.candidates.slice(0,2).map(c=>c.ref)}));const later=run('next-read');expect(later.status).toBe(0);expect(JSON.parse(later.stdout).request.refs).toEqual([routes.candidates[2]!.ref]);
  fs.writeFileSync(file,JSON.stringify({...input,scope:{project:'/other'},budget:defaultBudget(2048)}));expect(run('next-read').status).toBe(1);
  fs.writeFileSync(file,JSON.stringify(input));const prepared=run('prepare');expect(prepared.status).toBe(0);const task=JSON.parse(prepared.stdout).task;expect(task.citations[0].ref).toEqual(p.evidence[0]!.ref);
  const raw=JSON.stringify({taskId:task.taskId,status:'supported',claims:[{text:'The tool recorded this exact string.',kind:'tool_observation',citationIds:[task.citations[0].id],quote:p.evidence[0]!.text}]});fs.writeFileSync(file,JSON.stringify({...input,raw}));const valid=run('validate');expect(valid.status).toBe(0);expect(JSON.parse(valid.stdout).semanticSupport).toBe('unassessed');
  fs.writeFileSync(file,JSON.stringify({...input,raw:raw+']}'}));const invalid=run('validate');expect(invalid.status).toBe(1);expect(JSON.parse(invalid.stdout).errors).toEqual(['invalid_json']);
  fs.writeFileSync(file,JSON.stringify({...input,scope:{project:'/other'}}));const wrongScope=run('prepare');expect(wrongScope.status).toBe(1);expect(JSON.parse(wrongScope.stdout).errors).toContain('reader_scope_mismatch');
  fs.writeFileSync(file,JSON.stringify(input)+']}');expect(run('prepare').status).toBe(1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
