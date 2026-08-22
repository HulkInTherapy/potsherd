# phase 9 — go live

**orchestrator 4, 22–23 August 2026.** Phase 9 ran solo, as `RESUME-PROMPT.md §4` permits; the
verifier at the end did not. Release candidate `3264e6d`, CI green on all four legs.

**Status at the time of writing: `v1.1.0` is prepared and NOT yet tagged.** The verifier's report,
the tag, and then `docs/release/GO-LIVE.md` come after this section is written — that ordering is
the phase file's and it is not negotiable, because a runbook written after the fact is a story.

---

## 1. what was done

| task | state |
|---|---|
| T9.1 version, changelog, artefacts | done |
| T9.2 fresh-machine proof, three ways | **two of three done, the third correctly not run** |
| T9.3 npm readiness short of publish | done |
| T9.4 release notes, marketplace, upstream comment | done — **and the marketplace task changed shape entirely, see §4** |
| T9.6 verifier and tag | verifier ran; tag pending its findings |
| T9.5 go live | pending, per `GO-LIVE.md` |

**Version 1.1.0** in all eight manifests — `core/src/version.ts`, four `package.json`s, both plugin
manifests, and `.claude-plugin/marketplace.json` — pinned to one another by a test that enumerates
them rather than by the four somebody remembered.

**Gates at `3264e6d`:** `pnpm test` **1,532 / 38 files**, and the same under `POTSHERD_SQLITE=node`.
`check-privacy.py` **0 pins, 25 probes, exit 0** (read directly, not through a pipe). `pnpm evals`
**exit 0**; `--vector-weight 0` exits 1. `ask-selftest` PASS on 16 cases. `pnpm vendor` no diff.
`claude plugin validate --strict` passes on the plugin and on the marketplace manifest.

## 2. the fresh-machine proofs

From a **bare `git clone`** — no `pnpm install`, no build. The vendored bundle and the plugin shim
are all a stranger gets, which is the whole point of the test.

```
node:24-bookworm-slim   --version 57ms · audit 122 · rescue 230 · index 397 · ls 75 · find 89 · show 59
node:22-bookworm-slim   --version 62ms · audit 146 · rescue 214 · index 420 · ls 77 · find 87 · show 69
```

Both reproduced `330 / 31 / 299 / 2971` through
`audit --verify --json | jq -r .snippet | sh` **run as printed, in a shell told nothing** — the
phase-7 defect did not recur — and both listed all six MCP tools over stdio.

**Cleared macOS `$HOME`**, `env -i`, every override unset:

```
--version 118ms · audit 183 · rescue 436 · index 471 · ls 393 · find 258   TOTAL 1.86 s
models directory created?  NO
```

**The second-account test was not run.** `sudo -n true` fails on this machine, and the phase file
makes passwordless sudo the deciding condition. Recorded here rather than skipped quietly. The two
containers and the cleared `$HOME` exercise every path a new account would, minus the account
itself.

**Note on the walk timings.** These are an idle machine. Phase 8's own evidence records the same
walk at **24.6–65.0 s under load**, when five workers were saturating eight cores. The 30 s target
is met and the number should not be quoted as "what a stranger will see".

## 3. npm, everything short of publish

```
npm view potsherd                 -> E404, the name is free
npm publish --dry-run             -> potsherd@1.1.0 · 8 files · 957.3 kB packed · 3.5 MB unpacked
npm pack + install into an empty project
                                  -> 17 MB in node_modules, `potsherd audit` runs
```

The dry run had exactly one warning — `bin[potsherd]` carrying a leading `./` — and it is fixed
rather than tolerated. **A warning on a publish trains people to ignore publishes.**

`npm.md` records the publish form and, more usefully, the two options **refused**: `--provenance`
needs an OIDC token from a trusted CI runner and produces nothing worth having from a laptop, and
`--tag next` would leave `npx potsherd audit` — the first line of the README — resolving to nothing.

## 4. the marketplace task was not what the plan thought it was

**This is the substantive finding of the phase.**

`phase-9-go-live.md` said the listing was *"a submission the orchestrator prepares and sends per the
live docs (if it is a PR to `anthropics/claude-plugins-official`, fork + PR with `gh`)"*. Checked on
the day rather than assumed, from the live documentation and from the repository itself:

- the **official** marketplace is curated by Anthropic at its discretion, and its own documentation
  says *"there is no application process, and **the submission form does not add plugins to the
  official marketplace**"*;
- third-party submissions go to **`claude-plugins-community`** through an **authenticated in-app
  form** — `claude.ai/admin-settings/directory/submissions/plugins/new`, which requires a Team or
  Enterprise organization with directory-management access, or `platform.claude.com/plugins/submit`
  for individual authors.

**So T9.5 step 6 is struck**, and it is not a judgement call. That form sits on a person's account
and, on one path, needs an organization's permissions. Rule 7's re-scope authorises publishing
potsherd's own artefacts — npm, a GitHub release, one comment on a thread already open. It does not
turn a form on somebody's account into an agent's job.

What could be done was done: `claude plugin validate` and `--strict` pass on the plugin **and** on
the marketplace manifest, and everything the form asks for is written down in `marketplace.md`.

**Nothing is blocked by this.** `/plugin marketplace add HulkInTherapy/potsherd` installs it today.
The listing buys discovery, not function — worth remembering before treating it as a blocker.

`plans/09 §10.1` in one more shape: **a claim about somebody else's software is a lead until it is
run.** Six such claims in this project have been false. This one would have had an agent forking a
repository that does not accept forks for the purpose.

## 5. the `#128` comment, and the number in it

`obra/episodic-memory#128` is open, unmerged, by `d-walp`, with 0 comments. It fixes the same
hard-coded `AND e.is_sidechain = 0` our prepared patch addressed, and does it better — de-ranking
rather than gating, on both the vector and text paths, with nine tests. **No pull request is
opened.** One comment is posted, adding a measurement the PR does not have.

**The first draft of that comment quoted `228 / 197 / 31` while describing a real machine. Those are
the demo corpus's numbers.** Corrected to the measured **227 transcripts, 197 sidechains, 30 live
sessions**, established two independent ways on the frozen snapshot:

```
potsherd stats                                              claude  30 · 197 · 299
find <archive>/projects -name '*.jsonl'                                     -> 227
find <archive>/projects -path '*subagents*' -name '*.jsonl'                 -> 197
```

It was going into somebody else's repository. That is the check that mattered most in this phase.

## 6. the model screens, and a judgement to second-guess

`make-screens.sh` was re-run with a model. It **failed `14-ask.txt`'s open-thread assertion** — the
catch is stochastic and phase 7 recorded hitting the same thing. Because the script stages its
output, **nothing moved**, which is `09 §13.4` working rather than a skip.

The committed model screens were kept, on this reasoning: phase 8's reader-progress lines go to
**stderr** and `shot_model` discards them, and every row of `17-ls-cards.txt` is a **card** title,
which overrides a derived one — so 8.2 cannot have changed them. **This is a judgement, not a
measurement**, and the verifier was told to second-guess it.

## 7. open at the end of phase 9

| # | item |
|---|---|
| 1 | **the marketplace listing is not submitted** — a form on a person's account (§4). Everything it asks for is prepared |
| 2 | **29 unaccounted id-shaped tokens**, pinned at 130 occurrences. A real id remains the canonical `--help` example for several verbs across `packages/**`, seven tests and both bundles; exact edits are in `phases/phase-8/registration-W7.txt`. **The largest remaining privacy item** |
| 3 | the second-macOS-account install (§2) — not run, no passwordless sudo |
| 4 | the frozen snapshot reads 329/30 where published artefacts read 330/31; the loss numbers are identical either way (`phases/phase-8/HANDOFF.md` §4) |
| 5 | the demo corpus reproduces the headline counts and none of the mess — 0 slash-command-only ghosts against a real archive's 140, so every screenshot is taken against a tidier archive than any real one |
| 6 | `--cheap` answered 7/10 where the default answered 10/10 — disclosed on the screen, still a real cost |
| 7 | everything in `plans/08` §§2, 3, 6 that phases 8 and 9 did not touch: the missed targets, the three unverified adapters, the four documentation-only `setup` clients |

## 8. how to check this handoff

```bash
git log --oneline -1                      # 3264e6d or later
pnpm install && pnpm build
pnpm test && POTSHERD_SQLITE=node pnpm test          # 1,532, twice
python3 scripts/check-privacy.py ; echo "exit=$?"    # 0 pins, exit 0 — on its own line
pnpm evals ; echo "exit=$?"                          # 0
pnpm evals -- --vector-weight 0 ; echo "exit=$?"     # 1
node scripts/vendor-plugin.mjs && git status --short plugins/   # empty
claude plugin validate ./plugins/claude-code --strict           # passes
npm view potsherd                                    # E404 until T9.5 runs
cd packages/cli && npm publish --dry-run             # 8 files, 957.3 kB, no warnings
```

and the fresh-machine proof, which is the one worth re-running from scratch:

```bash
docker run --rm -i node:24-bookworm-slim bash -lc '
  apt-get update -qq && apt-get install -y -qq git python3 jq >/dev/null
  git clone -q --depth 1 https://github.com/HulkInTherapy/potsherd /w && cd /w
  node scripts/make-demo-corpus.mjs /root/.claude >/dev/null
  sh plugins/claude-code/bin/potsherd audit
  sh plugins/claude-code/bin/potsherd audit --verify --json | jq -r .snippet | sh'
```
