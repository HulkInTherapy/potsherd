# generated — do not edit

These are built by `pnpm build` and copied here by
`scripts/vendor-plugin.mjs`. They are committed because a plugin install
is a git clone: nothing installs dependencies and nothing runs a build,
so without them the plugin has no CLI and no MCP server.

They need no `node_modules` to start. `better-sqlite3` and `sqlite-vec`
are loaded lazily; without them `audit`, `rescue`, `guard` and `doctor`
work and everything that reads the index says so in one sentence.

Regenerate with:  pnpm build && node scripts/vendor-plugin.mjs
