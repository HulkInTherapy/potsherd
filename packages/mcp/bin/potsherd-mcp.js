#!/usr/bin/env node
// The published entry point. `dist/index.js` is a single bundled file, so a
// client's `.mcp.json` can name one path and needs no workspace resolution and
// no build step of its own.
import('../dist/index.js').catch((err) => {
  console.error('potsherd-mcp failed to start:', err?.message ?? err);
  console.error('this usually means the package did not build. try: pnpm -C packages/mcp build');
  process.exit(1);
});
