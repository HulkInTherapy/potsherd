# report to the master — orchestrator 3's postscript, 22–23 aug 2026

**What this file is.** `MASTER-REPORT.md` was my handoff at `v1.0.0`, and you verified it in
`10-MASTER-VERIFICATION.md`. Everything below happened **after** that exchange, in the same session.
It is three commits of mine and one large correction I owe you about what the rest of that log is.

As before: every claim names the command that checks it, and **nothing here is true until you have
run one.**

---

## 0. the correction, first, because it changes how you read the rest

**Phases 8 and 9 have run since `v1.0.0`, and they are not mine.** The repository is at `v1.1.0`,
published to npm, with 42 commits between `v1.0.0` and now, 39 of them somebody else's. I did not write, verify, or
review any of that work, and this report says nothing about whether it is sound.

```bash
git rev-list --count v1.0.0..HEAD             # 42; exactly 3 are mine
ls potsherd/phases/                          # phase-8/ and phase-9/ now exist
```

**Exactly three commits in that range are mine.** Everything else belongs to whoever ran phases 8
and 9 — including all of `phases/phase-8/` and `phases/phase-9/`, the fusion-gate amendment, the
`ignore` verb, the ghost-title work, `--cheap`, the privacy-guard rewrite that took its debt to
zero, and the `v1.1.0` publish itself.

| commit | date | what |
|---|---|---|
| `e7e189e` | 22 aug | the plan folder brought up to date for a fourth orchestrator |
| `67dfaa5` | 22 aug | corrected after your `PHASE-1-SCOUT` fix and history rewrite |
| `1a2984b` | 23 aug | the publish workflow, with provenance |

Verify: `git log --format='%h %an %s' v1.0.0..HEAD | cat`.

**Read that as a caveat on my earlier report too.** `MASTER-REPORT.md` describes `v1.0.0`. Several
of its open items — the fusion gate, the privacy pins, publication — appear to have been acted on
by phase 8 or 9. **I have not checked whether they were closed correctly**, and you should not take
my earlier §8 as current.

---

## 1. what I did: the handoff for orchestrator 4 (`e7e189e`)

You asked for the plan folder to be brought to a state where the next session could pick up
seamlessly. That is what phases 8 and 9 then ran from, so it is worth you knowing what was in it.

**`09-RUNNING-WORKERS.md`** — 732 → 934 lines. Phase 7's section went from three subsections to
thirteen, plus a checklist and a closing:

| § | what |
|---|---|
| 13.7 | the verifier's seven findings, and the generalisation from the worst: **if the documentation prints a command, the test runs that command as printed** — `sh` does not inherit a flag, and that broke the honesty contract |
| 13.8 | how to brief a verifier so its report is worth something, from the one that worked. The two sections that make it trustworthy are "claims I checked that held" and "what I could not check, and why" |
| 13.9 | **a guard's stated limitation is an open item, not boilerplate**, and **an item marked "assigned" in a handoff is not an item that was done** — both learned from `PHASE-1-SCOUT` |
| 13.10 | wall-time budgets, with the measured cost of every expensive loop, because none of them runs once |
| 13.11 | when a budget cannot be met, split the artefact — do not widen it and do not stop measuring |
| 13.12 | four documents, four values for one number, and the test that refuses it |
| 13.13 | seven small things that cost an hour each (running-script edits, `pipefail`+`head`, `;` vs `&&`, globs on `-`-prefixed dirs, awk counting bytes, heredoc self-termination, asciinema v2 vs v3) |
| 14 | the phase-7 checklist, added to `§12` rather than replacing it |
| 15 | one sentence from each of the three orchestrators |

**`08-STATE-OF-PLAY.md`** — rewritten from phase 6's table-kept-as-history into a live document: 23
open items in seven groups, each with its measurement or the reason it was open, and the rules list
grown from ten to thirteen.

**`RESUME-PROMPT.md`** — rewritten for whoever came next. It said plainly that phase 8 did not exist
yet, that the first action was to *run* the verification block rather than believe the report, and
carried the full file map.

All three were mirrored into `potsherd/docs/`.

## 2. what I did: the correction after your fix (`67dfaa5`)

You fixed the `PHASE-1-SCOUT` prose leak and **purged the file's git history** between my writing
that handoff and pushing it. So three of my documents were reporting a closed item as open and
citing `5ae62a0`, a SHA that no longer resolves.

I verified the fix rather than assuming it:

```bash
sed -n '1246p;1531p' docs/upstream/PHASE-1-SCOUT.md            # synthetic records
git log --all -S "the user is asking about the project" --oneline   # empty
```

Then corrected `08`, `RESUME-PROMPT` and `MASTER-REPORT` §8.6b: `v1.0.0` is `548b5b5`, the history
was rewritten, and older SHAs will not resolve.

**I kept the entry rather than deleting it, marked CLOSED.** How it survived six phases is the
lesson; that it existed is not. Two permanent rules came out of it and are now in `08`'s list:
`check-privacy.py` passed that file because its own header says *"no regex recognises prose"*, and
phase 5's handoff said "assigned" when nothing had been done.

## 3. what I did: the npm question, answered with data (no commit)

You asked why a brand-new package had 121 downloads in 15 hours. **Almost none of it is people, and
the GitHub data proves it rather than my guessing.**

```
npm downloads      121   all on 22 Aug (publish day) · 0 on every prior day
GitHub page views   47   ← 4 UNIQUE VISITORS in 14 days
GitHub clones      770   ← 147 unique cloners
stars / forks        0 / 0
referrers          Google, 1 unique visitor
```

Three things settle it:

1. **147 unique cloners against 4 unique page viewers.** A human who clones a repo looks at the page
   first. ~143 of those never rendered the HTML.
2. **The clones started 20 Aug — two days before the npm publish**, and before anything was
   announced anywhere. They tracked the repo going public, not the package.
3. **Zero stars, forks and watchers.** If 147 developers had cloned this, some non-zero number would
   have starred it.

The fleet that does this: malware-hunting pipelines (supply-chain attacks arrive *as new packages*,
so every publish is pulled within minutes), registry mirrors and caching proxies, dataset builders,
and code-search/AI crawlers — the last of which explains the clone/view mismatch specifically.

**npm gives package authors no source breakdown at all** — no IPs, no user-agents, no geography, no
dashboard. Only the count. Triangulating with GitHub traffic is the whole method. Reproduce:

```bash
curl -s "https://api.npmjs.org/downloads/range/last-month/potsherd" | jq -r '.downloads[] | "\(.day)  \(.downloads)"'
gh api repos/HulkInTherapy/potsherd/traffic/views
gh api repos/HulkInTherapy/potsherd/traffic/clones
gh api repos/HulkInTherapy/potsherd/traffic/popular/referrers
```

⚠️ **GitHub traffic is a 14-day rolling window and the data is deleted after that.** Not snapshotted
daily, it is gone permanently. That is a live gap — nothing in this repository records it.

**The signal that would actually mean adoption** is downloads that persist on days with no publish.
Bots hit once and decay; humans return. As of 23 Aug the range still shows one spike and nothing
since.

**And a recommendation I want on the record: do not add telemetry to find out.**
`doctor --privacy` publishes *"no telemetry. no account. potsherd stores no credential of its own"*,
`00-README.md` forbids it, and a CI step diffs that receipt against the live command. Instrumenting
the tool to count users would break the central claim to learn something the npm API already tells
you badly.

## 4. what I did: the publish workflow, with provenance (`1a2984b`)

You asked why the GitHub sidebar says "No packages published" and how to connect npm to GitHub.

**The sidebar cannot be fixed and should not be.** It shows **GitHub Packages**
(`npm.pkg.github.com`) — GitHub's own registry, unrelated to npmjs.com. Publishing there instead
would force a scoped name (`@hulkintherapy/potsherd`) and require consumers to authenticate with a
GitHub token **even for a public package**, which breaks `npx potsherd audit` — the first command in
the README. `docs/release/npm.md` now says this so nobody rediscovers it.

**The real link is npm provenance**, and `docs/release/npm.md` had already reasoned this out for
`v1.1.0`: it refused `--provenance` for the correct reason (it needs a trusted CI runner with an
OIDC token; from a laptop it produces nothing worth having) and wrote down that it was *"the right
thing for a later release that publishes from a workflow."* **This is that workflow.** I was
following through on a decision already in the file, not overriding one.

`.github/workflows/publish.yml` — fires on a `v*` tag with `id-token: write`, publishes
`--provenance`. Everything before the publish step is a reason **not** to publish, because a release
pipeline whose only job is to publish will publish anything:

- the tag and `packages/cli/package.json` disagree → refuse
- that version is already on the registry → refuse
- `check-privacy.py --selftest` or the full sweep red → refuse
- `pnpm typecheck` or `pnpm test` red → refuse
- the suite red under `POTSHERD_SQLITE=node` → refuse
- `plugins/*/dist` not what this source builds → refuse
- the packed tarball will not install and run in a clean directory → refuse

**And it verifies the attestation landed afterwards.** `npm publish --provenance` **succeeds
silently** when the job lacks `id-token: write`. A flag that is documented and does nothing is this
project's most-recorded failure mode; it is checked, not assumed.

`workflow_dispatch` runs everything except the publish, so the pipeline can be exercised without
spending a version number.

**Measured state of the published package:**

```bash
npm view potsherd@1.1.0 --json | jq .dist.attestations    # null — no provenance
```

`1.1.0` was published from a laptop and **provenance cannot be added retroactively**. That is now
stated plainly in `docs/release/npm.md` rather than left to be discovered. The next version gets it.

**One human action is outstanding and no agent may take it:** an npm automation token in the
repository secret `NPM_TOKEN`. Until that exists the workflow cannot publish, which is the correct
default.

```bash
# npmjs.com/settings/~/tokens → Granular Access, scoped to `potsherd`, Read and write
gh secret set NPM_TOKEN --repo HulkInTherapy/potsherd
gh workflow run publish.yml -f dry_run=true && gh run watch   # everything except the publish
```

---

## 5. what I did not do, and what I am not claiming

- **I did not verify phases 8 or 9.** 39 commits, two handoffs, two verification reports, a version
  bump and a live publish, none of it mine and none of it checked by me.
- **I did not run the workflow.** It has never executed. The dry run above is the first thing that
  should happen to it, and it needs the secret first.
- **I did not re-run the `v1.0.0` verification block** against the current tree. `MASTER-REPORT.md`
  §9 still exists and still works, but its expected values (1,434 tests, 14 pins, `548b5b5`) are
  `v1.0.0`'s and phase 8 appears to have changed at least the pin count to zero.
- **I did not touch the product.** My three commits are two documentation changes and one CI file.
- **The npm/GitHub traffic figures in §3 are 22–23 August.** They will have moved.

## 6. the one thing I would look at first

**Nothing records GitHub traffic, and GitHub deletes it after 14 days.** The clone and view numbers
in §3 — the only data that distinguishes a bot from a person — are already partly expired and the
rest will be gone by 5 September. A four-line cron appending those four endpoints to a JSON file
costs nothing and cannot be reconstructed later. It is the only thing in this report that gets
strictly worse by waiting.
