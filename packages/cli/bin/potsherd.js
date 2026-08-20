#!/usr/bin/env node
// The published entry point. `dist/potsherd.js` is a single bundled file so
// that `npx potsherd audit` needs no workspace resolution and no build step.
import('../dist/potsherd.js').catch((err) => {
  console.error('potsherd failed to start:', err?.message ?? err);
  console.error('this usually means the package did not build. try: npm i -g potsherd@latest');
  process.exit(1);
});
