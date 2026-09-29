import fs from 'node:fs';
import path from 'node:path';

/** Test routing only: ordinary unset defaults/readiness stay with each existing caller. */
export function testModelCache(fallback:string,env?:NodeJS.ProcessEnv):string;
export function testModelCache(fallback?:undefined,env?:NodeJS.ProcessEnv):string|undefined;
export function testModelCache(fallback?:string,env:NodeJS.ProcessEnv=process.env):string|undefined {
  const supplied=env['POTSHERD_TEST_MODELS_DIR'];
  if(supplied===undefined)return fallback;
  const invalid=()=>new Error('Invalid POTSHERD_TEST_MODELS_DIR: expected an absolute readable directory');
  if(!supplied.trim()||!path.isAbsolute(supplied))throw invalid();
  try {
    if(!fs.statSync(supplied).isDirectory())throw invalid();
    fs.accessSync(supplied,fs.constants.R_OK|fs.constants.X_OK);
  }catch{throw invalid();}
  return supplied;
}
