import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const roots:string[]=[];
const expectedVersion=JSON.parse(fs.readFileSync(path.resolve('packages/cli/package.json'),'utf8')).version;
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
describe('ordinary CLI render environment',()=>{
 for(const entry of ['slopie','potsherd'])for(const explicit of [undefined,'development','test',''] as const){
  it(`${entry} defaults unset environment to production and preserves ${JSON.stringify(explicit)}`,()=>{
   const root=fs.mkdtempSync(path.join(os.tmpdir(),'slopie-render-env-'));roots.push(root);
   const receipt=path.join(root,'receipt.json'),hook=path.join(root,'environment.mjs');
   fs.writeFileSync(hook,`import fs from 'node:fs';process.on('exit',()=>fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({environment:process.env.NODE_ENV})));`);
   const env={...process.env};delete env.NODE_ENV;if(explicit!==undefined)env.NODE_ENV=explicit;
   const result=spawnSync(process.execPath,['--import',hook,path.resolve(`packages/cli/bin/${entry}.js`),'--version'],{env,encoding:'utf8',timeout:10000});
   expect(result.status,result.stderr).toBe(0);expect(result.stdout.trim()).toBe(expectedVersion);
   expect(JSON.parse(fs.readFileSync(receipt,'utf8')).environment).toBe(explicit??'production');
  });
 }
});
