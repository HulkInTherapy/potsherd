#!/usr/bin/env node
// The published entry point. `dist/potsherd.js` is a single bundled file so
// that `npx potsherd audit` needs no workspace resolution and no build step.
import('../dist/potsherd.js').catch((err) => {
  console.error('potsherd failed to start:', err?.message ?? err);
  // NOT `npm i -g potsherd`: the package is unpublished, so that is a 404
  // and telling somebody whose install is already broken to run it twice is
  // the worst kind of fix line. Phase 7 publishes; until then this is it.
  console.error('this usually means the package did not build. try: pnpm install && pnpm build');
  process.exit(1);
});
