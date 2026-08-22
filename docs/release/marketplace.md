# the Claude Code plugin listing

**Status: the plugin is installable today from this repository. The community
directory listing is a form that only a person can submit, and it is not
submitted.**

## what the process actually is, verified 22 August 2026

The phase-9 plan assumed this was a pull request to
`anthropics/claude-plugins-official` and could be opened with `gh`. **It is
neither of those things**, and the difference matters enough to write down.

Read from `code.claude.com/docs/en/plugins` and from the repository itself, on
the day:

- **`claude-plugins-official`** is *"a curated set of plugins maintained by
  Anthropic"*. The documentation is explicit: *"Anthropic decides which plugins
  to include at its discretion. **There is no application process, and the
  submission form does not add plugins to the official marketplace.**"* Its
  repository's own README points third parties at a form, not at a PR — there is
  no `external_plugins` contribution path to open.
- **`claude-plugins-community`** is where third-party submissions land after
  review. Approved plugins are pinned to a commit SHA and the public catalog
  syncs nightly, so there is a delay between approval and installability.
- Submission is **an authenticated in-app form**, one of:
  - `claude.ai/admin-settings/directory/submissions/plugins/new` — **requires a
    Team or Enterprise organization** and directory-management access
  - `platform.claude.com/plugins/submit` — the Console form, for individual
    authors who are not in such an organization

**So T9.5's "marketplace submission, executed" cannot be executed by the
orchestrator.** It is an authenticated web form tied to a person's account and,
on one of the two paths, to an organization's directory permissions. Rule 7's
re-scope authorises publishing potsherd's own artefacts — npm, a GitHub release,
one comment on a thread already open. It does not turn a form on somebody's
account into an agent's job, and no reading of it should.

`plans/09 §10.1` in one more shape: **a claim about somebody else's software is
a lead until it is run.** Six such claims in this project have been false, and
this one would have had an agent forking a repository that does not accept forks
for this purpose.

## what is ready, and checked

```
$ claude plugin validate ./plugins/claude-code
  ✔ Validation passed
$ claude plugin validate ./plugins/claude-code --strict
  ✔ Validation passed
$ claude plugin validate .
  Validating marketplace manifest: .claude-plugin/marketplace.json
  ✔ Validation passed
```

`--strict` is the one that matters: the review pipeline runs the same check and
treats warnings as errors under it. There are no warnings.

`.claude-plugin/marketplace.json` describes one plugin, `potsherd`, sourced from
`./plugins/claude-code`, at the same version string as every other manifest in
the repository — pinned by a test that enumerates all of them.

The plugin carries:

- `skills/potsherd/SKILL.md` — `/potsherd <verb>`, user-invocable
- `skills/remembering-sessions/SKILL.md` — model-invocable, dispatches the agent
- `agents/session-archaeologist.md` — haiku-class, **four** MCP tools and `Read`
  (`find`, `read`, `ls`, `ask`; not `graft` or `tag`). The server itself serves six
- `hooks/hooks.json` — `SessionStart` rescue, `SessionEnd` index
- `.mcp.json` — the stdio server, six tools
- **`dist/potsherd.js` and `dist/mcp.js`, committed** — an install is a git
  clone, so this is what makes it work at all, and it is why `pnpm vendor` is
  step 2 of the release

## it already installs, from here

No listing is required for anyone to use it. This works today:

```
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd@potsherd
```

The listing buys discovery, not function. That is worth remembering before
treating it as a release blocker.

## test what a stranger gets, not what the checkout has

From a clone with no `node_modules` and no build:

```bash
git clone https://github.com/HulkInTherapy/potsherd /tmp/market-test
cd /tmp/market-test
sh plugins/claude-code/bin/potsherd --version
sh plugins/claude-code/bin/potsherd audit
```

Then in Claude Code:

```
/plugin marketplace add /tmp/market-test
/plugin install potsherd@potsherd
/potsherd audit
```

and check the six MCP tools are present — `session-archaeologist` holding only
`Read` is exactly the failure v1.0.0 existed to fix, and it is the kind that
only shows up once the artefact has moved.

## what a person needs, to submit it

Everything the form asks for is in `docs/release/RELEASE-NOTES-v1.1.0.md` and in
the README. In short:

- **name** `potsherd` · **repository** `HulkInTherapy/potsherd` · **licence** MIT
- **what it does:** archives, indexes and searches every coding-agent session on
  a machine, including ones the harness has already deleted
- **why it is safe:** no network by default, no telemetry, no account; every
  path it reads and writes is printed by `potsherd doctor --privacy`, and CI
  fails if that receipt drifts from what the program does
- `claude plugin validate --strict` passes
