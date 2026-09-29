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

/**
 * The name of the one directory potsherd ever spawns `claude -p` in.
 *
 * A copy of `llm.ts`'s `CLAUDE_CWD_NAME`, written out for the reason every
 * other path in this file is written out: `doctor` is on `OFFLINE_VERBS` and
 * must not become a verb that *can* open a socket, and `llm.ts` is the module
 * that talks to backends. `tests/cli.test.ts` imports the real constant and
 * asserts the receipt against it, so the copy cannot drift — a test may import
 * anything.
 */
export const CLAUDE_SCRATCH_CWD_NAME = 'potsherd-llm-cwd';

/**
 * What Claude Code creates in the user's own archive because potsherd ran it.
 *
 * FIX-B D6, and the fifth false claim this receipt has published. It listed
 * `~/.claude/projects` under **reads (never modified)** while the model path
 * caused `~/.claude/projects/<slug>/memory/` to exist — measured, on the real
 * machine, and documented inside `llm.ts` as *"litter in someone else's
 * directory"*. So the code knew and the receipt did not.
 *
 * potsherd does not call `mkdir` here: Claude Code does, for whatever cwd it
 * is spawned in. That distinction is worth nothing to the person reading a
 * privacy receipt — a directory exists in their archive that would not exist
 * if they had not run potsherd — so it is listed as a write, with the sentence
 * that says who creates it and why there is exactly one of them.
 *
 * `--no-session-persistence` is what keeps it *empty*: no transcript JSONL is
 * written, so nothing a potsherd model call creates can ever be indexed,
 * carded, ranked or shown in `potsherd ls`. The fixed name is what keeps it
 * *one*: a fresh temp name per call would leave one entry per call, and
 * `card --all` over the reference corpus is 39 calls.
 */
export const CLAUDE_SPAWN_WRITE_PATH =
  `~/.claude/projects/<slug of the scratch cwd, ending ${CLAUDE_SCRATCH_CWD_NAME}>/`;

export const CLAUDE_SPAWN_WRITE_NOTE =
  'created by claude code, not by potsherd, because potsherd spawned it there — ' +
  'only on the verbs that call a model, and only when the model is the claude ' +
  'cli. one directory however many calls, because the cwd has a fixed name. it ' +
  'stays empty: potsherd passes --no-session-persistence, so no transcript is ' +
  'written and nothing it creates can be indexed. potsherd never removes it.';
