# release

**Nothing in this directory has been submitted, published or posted, and no
agent may do it.** Every file here is a checklist with the exact commands
filled in, for a human to run.

That is a rule from `plans/00-README.md` and it is not a formality: potsherd's
whole claim is that its output can be checked, and an agent that published a
package, opened a pull request or submitted a marketplace listing on somebody's
behalf would have made a claim about them that they never made.

| file | what it is |
|---|---|
| [`npm.md`](npm.md) | publishing `potsherd` to npm, and what `npx potsherd audit` needs |
| [`marketplace.md`](marketplace.md) | the Claude Code plugin listing |
| [`upstream.md`](upstream.md) | the prepared pull request to obra/episodic-memory — **read `#128` first** |
| [`checklist.md`](checklist.md) | the tag-day sequence, in order |

## what is already true without any of it

A `git clone` of this repository is a complete install. The plugin carries its
own bundled CLI and MCP server (`plugins/claude-code/dist/`), neither of which
needs `npm install`, a build step or a native module, and Node's own SQLite is
the fallback when `better-sqlite3` is not there. Publishing to npm makes
`npx potsherd audit` work for somebody who has never heard of the repository;
it is not what makes the product work.
