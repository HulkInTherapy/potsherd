// Optional regeneration: POTSHERD_121_PRODUCER=/absolute/installed/dist/potsherd.js node produce.mjs
// All database rows are produced by the authentic old CLI, never a schema rewind.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
const dir=path.dirname(fileURLToPath(import.meta.url)),producer=process.env.POTSHERD_121_PRODUCER;
if(!producer||!path.isAbsolute(producer))throw new Error('POTSHERD_121_PRODUCER must name an absolute authentic 1.2.1 CLI bundle');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'potsherd-121-producer-')),store=path.join(root,'store'),claude=path.join(root,'claude');
const env={...process.env,POTSHERD_DIR:store,CLAUDE_CONFIG_DIR:claude,POTSHERD_OFFLINE:'1',POTSHERD_SQLITE:'node',NO_COLOR:'1',CODEX_HOME:path.join(root,'codex')};
for(const host of ['CODEX','PI','OPENCODE','CURSOR','GEMINI','COPILOT'])env[`POTSHERD_${host}_DIR`]=path.join(root,host.toLowerCase());
const commands=[];
function run(args){const child=spawnSync(process.execPath,[producer,...args],{env,encoding:'utf8',timeout:15000});if(child.status!==0)throw new Error(JSON.stringify({args,status:child.status,stderr:child.stderr,stdout:child.stdout}));commands.push({args,status:child.status,stdout:child.stdout});return child.stdout;}
try{
 const version=run(['--version']).trim();if(version!=='1.2.1')throw new Error('wrong producer version '+version);
 const session='33333333-3333-4333-8333-333333333333',project=path.join(claude,'projects','synthetic-upgrade');fs.mkdirSync(project,{recursive:true});fs.copyFileSync(path.join(dir,'seed.jsonl'),path.join(project,session+'.jsonl'));
 const indexed=JSON.parse(run(['index','--harness','claude','--no-embed','--json']));
 if(indexed.totals.exchanges!==1||indexed.totals.toolCalls!==1||indexed.totals.failed!==0)throw new Error('producer failed to capture synthetic exchange/tool fixture');
 run(['note',session,'--decided','Synthetic pool remains in transaction mode','--open','Synthetic latency still unmeasured','--next','Run the synthetic check','--by','fixture-author','--json']);
 run(['pin',session,'--json']);
 run(['tag',session,'synthetic-upgrade','--json']);
 const bytes=fs.readFileSync(path.join(store,'potsherd.db')),sha=b=>createHash('sha256').update(b).digest('hex');
 fs.writeFileSync(path.join(dir,'store.sqlite.gz'),gzipSync(bytes));
 fs.writeFileSync(path.join(dir,'PROVENANCE.json'),JSON.stringify({producerVersion:version,producerBundleSha256:sha(fs.readFileSync(producer)),fixtureSha256:sha(bytes),seedSha256:sha(fs.readFileSync(path.join(dir,'seed.jsonl'))),producedAt:new Date().toISOString(),node:process.version,driver:'node:sqlite',models:false,network:false,fixtureOnly:true,commands},null,2)+'\n');
 console.log(JSON.stringify({version,bytes:bytes.length,fixtureSha256:sha(bytes)}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
