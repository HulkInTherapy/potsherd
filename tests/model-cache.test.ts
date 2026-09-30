import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { testModelCache } from './model-cache.js';
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true}));});
function directory(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'potsherd-cache-routing-owned-'));roots.push(root);return root;}
describe('explicit test cache routing, no model/runtime calls',()=>{
 it('preserves unset caller defaults without probing or requiring the ordinary fallback',()=>{
  const probe=vi.spyOn(fs,'statSync');const fallback='/definitely/missing/ordinary-cache';
  expect(testModelCache(fallback,{})).toBe(fallback);expect(testModelCache(undefined,{})).toBeUndefined();expect(probe).not.toHaveBeenCalled();
 });
 it('honors an explicit directory exclusively even when a different fallback and legacy model env exist',()=>{
  const override=directory(),fallback=directory();fs.writeFileSync(path.join(override,'marker'),'owned public fixture');
  expect(testModelCache(fallback,{POTSHERD_TEST_MODELS_DIR:override,POTSHERD_MODELS_DIR:fallback})).toBe(override);
  expect(testModelCache(undefined,{POTSHERD_TEST_MODELS_DIR:override,POTSHERD_MODELS_DIR:fallback})).toBe(override);
  expect(fs.readFileSync(path.join(override,'marker'),'utf8')).toBe('owned public fixture');
 });
 it.each(['','   ','relative/cache','./cache','../cache','file:///cache'])('rejects supplied invalid value %j rather than choosing a usable fallback',supplied=>{
  const fallback=directory();expect(()=>testModelCache(fallback,{POTSHERD_TEST_MODELS_DIR:supplied,POTSHERD_MODELS_DIR:fallback})).toThrow(/Invalid POTSHERD_TEST_MODELS_DIR/);
 });
 it('rejects a supplied nonexistent absolute directory and a regular file',()=>{
  const root=directory(),file=path.join(root,'file');fs.writeFileSync(file,'not a directory');
  for(const supplied of [path.join(root,'missing'),file])expect(()=>testModelCache(root,{POTSHERD_TEST_MODELS_DIR:supplied})).toThrow(/Invalid POTSHERD_TEST_MODELS_DIR/);
 });
 it('rejects an unreadable supplied directory without probing a different fallback',()=>{
  const override=directory(),fallback=directory();const access=vi.spyOn(fs,'accessSync').mockImplementation(()=>{throw new Error('controlled EACCES');});
  expect(()=>testModelCache(fallback,{POTSHERD_TEST_MODELS_DIR:override})).toThrow(/Invalid POTSHERD_TEST_MODELS_DIR/);expect(access).toHaveBeenCalledTimes(1);expect(access).toHaveBeenCalledWith(override,fs.constants.R_OK|fs.constants.X_OK);
 });
 it('leaves asset readiness with callers and keeps linked shared cache intact after owned fixture cleanup',()=>{
  const cache=directory(),fixture=directory(),marker=path.join(cache,'marker');fs.writeFileSync(marker,'shared input survives');
  const resolved=testModelCache('/unused/fallback',{POTSHERD_TEST_MODELS_DIR:cache});expect(resolved).toBe(cache);
  fs.symlinkSync(resolved,path.join(fixture,'models'),'dir');fs.rmSync(fixture,{recursive:true,force:true});
  expect(fs.readFileSync(marker,'utf8')).toBe('shared input survives');expect(fs.readdirSync(cache)).toEqual(['marker']);
 });
});
