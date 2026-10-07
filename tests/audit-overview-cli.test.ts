import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
const cli=path.resolve('packages/cli/bin/potsherd.js');
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'potsherd-overview-cli-'));dirs.push(root);
  const roots={claude:path.join(root,'claude'),codex:path.join(root,'codex'),pi:path.join(root,'pi'),opencode:path.join(root,'opencode'),owned:path.join(root,'owned')};
  const project=path.join(root,'PRIVATE-CUSTOMER-NAME');
  fs.mkdirSync(path.join(roots.claude,'projects','fixture'),{recursive:true});
  fs.writeFileSync(path.join(roots.claude,'projects','fixture','c1.jsonl'),JSON.stringify({type:'user',sessionId:'c1',uuid:'cu1',promptId:'p1',cwd:project,timestamp:'2026-10-01T12:00:00Z',message:{role:'user',content:'A private requested feature.'}})+'\n');
  fs.mkdirSync(path.join(roots.codex,'sessions','2026','10','01'),{recursive:true});
  const rows:unknown[]=[{type:'session_meta',timestamp:'2026-10-01T12:00:00Z',payload:{id:'x1',cwd:project}}];
  for(const [i,text] of ['continue','continue'].entries()){
    const timestamp=`2026-10-01T12:0${i+1}:00Z`;
    rows.push({type:'event_msg',timestamp,payload:{type:'user_message',message:text}});
    rows.push({type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
  }
  fs.writeFileSync(path.join(roots.codex,'sessions','2026','10','01','rollout-x1.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const trap=path.join(root,'trap-ui.mjs'),attempts=path.join(root,'ui-attempts.txt');
  fs.writeFileSync(trap,`import fs from 'node:fs';export async function resolve(specifier,context,next){if(['ink','react','string-width'].includes(specifier)){fs.appendFileSync(${JSON.stringify(attempts)},specifier+'\\n');throw new Error('UI dependency must remain deferred');}return next(specifier,context);}`);
  const network=path.join(root,'trap-network.mjs');
  fs.writeFileSync(network,"import http from 'node:http';import https from 'node:https';const block=()=>{throw new Error('Unexpected overview network request')};globalThis.fetch=block;http.request=block;https.request=block;");
  const common=['--claude-dir',roots.claude,'--codex-dir',roots.codex,'--pi-dir',roots.pi,'--opencode-dir',roots.opencode,'--potsherd-dir',roots.owned];
  const run=(flags:string[])=>spawnSync(process.execPath,['--experimental-loader',trap,'--import',network,cli,'audit',...flags,...common],{encoding:'utf8',timeout:20000,env:{...process.env,NO_COLOR:'1',NODE_NO_WARNINGS:'1'}});
  return {root,roots,attempts,run};
}
function inventory(root:string):Record<string,string>{
  const entries:Record<string,string>={};
  function walk(dir:string){if(!fs.existsSync(dir))return;for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else entries[path.relative(root,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}
  walk(root);return entries;
}

describe('compiled CLI audit route boundary',()=>{
  it('reports new safe local facts without network/UI initialization while writing only derived cache',()=>{
    const f=fixture(),before=inventory(f.root),result=f.run(['--overview','--json']);
    expect(result.status,result.stderr).toBe(0);
    const report=JSON.parse(result.stdout);
    expect(report.schemaVersion).toBe('audit-v1');
    expect(report.metrics.conversations.value).toBe(2);
    expect(report.metrics.humanPrompts.value).toBe(3);
    expect(result.stdout).not.toContain('PRIVATE-CUSTOMER-NAME');
    expect(result.stdout).not.toContain('A private requested feature.');
    expect(result.stdout).not.toContain('\u001b');
    expect(fs.existsSync(f.attempts)).toBe(false);
    const after=inventory(f.root);for(const [file,hash] of Object.entries(before))expect(after[file]).toBe(hash);expect(Object.keys(after).filter(file=>!(file in before)).every(file=>file.startsWith('owned/audit-derived/'))).toBe(true);expect(fs.existsSync(path.join(f.roots.owned,'potsherd.db'))).toBe(false);
  });
  it('renders noninteractive plain output with all UI dependencies blocked',()=>{
    const f=fixture(),result=f.run(['--overview','--plain','--ascii']);
    expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('SLOPIE');
    expect(result.stdout).not.toContain('\u001b');expect(result.stdout).toContain('PRIVATE-CUSTOMER-NAME');
    expect(fs.existsSync(f.attempts)).toBe(false);
  });
  it('keeps legacy JSON and verifier independent from the new renderer',()=>{
    const f=fixture(),legacy=f.run(['--legacy','--json']),verify=f.run(['--verify','--json']);
    expect(legacy.status,legacy.stderr).toBe(0);expect(verify.status,verify.stderr).toBe(0);
    expect(JSON.parse(legacy.stdout)).toHaveProperty('sessionsEver');
    expect(JSON.parse(legacy.stdout)).not.toHaveProperty('metrics');
    expect(JSON.parse(verify.stdout)).toHaveProperty('snippet');expect(fs.existsSync(f.attempts)).toBe(false);
  });
  it('rejects ambiguous new and legacy modes before rendering',()=>{
    const f=fixture(),result=f.run(['--overview','--verify']);
    expect(result.status).toBe(1);expect(result.stderr).toContain('cannot be combined');
    expect(result.stdout).toBe('');expect(fs.existsSync(f.attempts)).toBe(false);
  });
  it('writes only the explicitly selected safe SVG export',()=>{
    const f=fixture(),file=path.join(f.root,'share.svg'),result=f.run(['--overview','--export',file]);
    expect(result.status,result.stderr).toBe(0);const svg=fs.readFileSync(file,'utf8');
    expect(svg).toContain('<svg');expect(svg).not.toContain('PRIVATE-CUSTOMER-NAME');
    expect(svg).not.toContain('A private requested feature.');expect(fs.existsSync(path.join(f.roots.owned,'potsherd.db'))).toBe(false);
    expect(fs.existsSync(f.attempts)).toBe(false);
  });
});
