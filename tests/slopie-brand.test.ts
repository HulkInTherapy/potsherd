import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {describe,it,expect} from 'vitest';
const root=path.resolve('.'),env={...process.env,POTSHERD_OFFLINE:'1',NO_COLOR:'1'};
const run=(name:string,args:string[])=>spawnSync(process.execPath,[path.join(root,'packages/cli/bin',name+'.js'),...args],{encoding:'utf8',env});
describe('Slopie public identity with retained compatibility',()=>{
 it('publishes both launchers from one package without moving storage namespaces',()=>{const m=JSON.parse(fs.readFileSync(path.join(root,'packages/cli/package.json'),'utf8'));expect(m.name).toBe('slopie');expect(m.bin).toEqual({slopie:'bin/slopie.js',potsherd:'bin/potsherd.js'});expect(m.repository.url).toContain('HulkInTherapy/slopie');});
 it('both launchers report the same package version',()=>{const m=JSON.parse(fs.readFileSync(path.join(root,'packages/cli/package.json'),'utf8'));for(const name of ['slopie','potsherd']){const r=run(name,['--version']);expect(r.status,r.stderr).toBe(0);expect(r.stdout.trim()).toBe(m.version);}});
 it('primary help and tour name Slopie while alias help remains compatible',()=>{const primary=run('slopie',['--help']),alias=run('potsherd',['--help']);expect(primary.status).toBe(0);expect(primary.stdout).toContain('Usage: slopie');expect(primary.stdout).toContain('--potsherd-dir');expect(alias.stdout).toContain('Usage: potsherd');const tour=run('slopie',['--json']);expect(JSON.parse(tour.stdout).start).toBe('slopie audit');});
});
