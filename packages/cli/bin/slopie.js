#!/usr/bin/env node
// Public Slopie launcher; storage and the potsherd launcher remain compatible.
process.env['POTSHERD_CLI_PUBLIC_NAME']='slopie';
import('../dist/potsherd.js').catch((err)=>{
 console.error('slopie failed to start:',err?.message??err);
 console.error('this usually means the package did not build. try: pnpm install && pnpm build');
 process.exit(1);
});
