/**
 * The paths `doctor --privacy` names for the verbs that touch another tool's
 * store — `export --to …` and `find --with …`.
 *
 * ## why this file exists at all
 *
 * T6.6 D13. Two holes, one address.
 *
 *   1. `commands/export.ts` declared `EXPORT_WRITE_PATHS` and labelled it
 *      *"Exported for the registration file's `doctor --privacy` line"*.
 *      `grep -rn EXPORT_WRITE_PATHS` found **zero consumers**: the receipt
 *      never printed it, so `export --to markdown` — the one verb besides
 *      `graft` and `ask --readers-out` that writes outside `~/.potsherd` —
 *      appeared nowhere in the list of what potsherd writes.
 *   2. The `reads:` block named no bridge store. Not claude-mem's database,
 *      not agentmemory's app-data directory, and not the `CLAUDE.md` files
 *      the `notes` bridge walks up from the working directory and
 *      demonstrably reads. `03` §11: *"`potsherd doctor --privacy` lists
 *      every path read and every path written."*
 *
 * ## why the entries are written out rather than computed
 *
 * `doctor` is on `OFFLINE_VERBS` — it must not open a socket, and it must not
 * become a verb that can. Importing `@potsherd/bridges` to call
 * `claudeMemDbPath()` would pull the module that does
 * `fetch('http://127.0.0.1:…')` into `doctor`'s import graph, and the guard in
 * `tests/llm.test.ts` that keeps the offline list honest would be right to
 * object. So these are strings, and the drift that costs is paid for by
 * `tests/bridges.test.ts`, which asserts each one against the bridge's own
 * path helper — a test may import anything.
 *
 * They are also written the way the rest of this receipt writes conditional
 * paths (`<the path you give to  ask --readers-out>`): a shape the reader can
 * recognise, not an absolute path that is only true on the machine that
 * printed it.
 */

/** Paths `potsherd export` may write, both only on an explicit request. */
export const EXPORT_WRITE_PATHS: readonly string[] = [
  '<the dir you give to  export --to markdown>',
  "<your agentmemory store>  — export --to agentmemory --yes",
];

/**
 * Stores belonging to other tools that `find --with` and `export --to` read.
 *
 * Read-only, and only when the flag names them. `03` §10: *"never duplicate
 * their capture"* — potsherd reads these to say what they already hold, and
 * writes into exactly one of them, only with `--yes`, and that write is listed
 * in {@link EXPORT_WRITE_PATHS}.
 */
export const BRIDGE_READ_PATHS: readonly { path: string; note: string }[] = [
  {
    path: '~/.claude-mem/claude-mem.db',
    note: 'claude-mem, or wherever CLAUDE_MEM_DATA_DIR points. read-only.',
  },
  {
    path: "<agentmemory's app-data dir>",
    note: '~/Library/Application Support/agentmemory on macOS, $XDG_DATA_HOME',
  },
  {
    path: '<cwd>/CLAUDE.md, and .claude/CLAUDE.md above it',
    note: 'the notes bridge, walking up from the directory you run in.',
  },
  {
    path: '~/.claude/projects/<slug>/memory',
    note: "Claude Code's own auto-memory for this project. read-only.",
  },
];
