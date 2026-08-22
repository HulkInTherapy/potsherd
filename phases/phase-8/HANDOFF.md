# phase 8 — hardening before the public moment

**orchestrator 4, 2026-08-22.** Cut from `origin/main` = `67dfaa5`; phase-8 work ends at `dbee0d2`,
CI green on all four legs. `v1.0.0` = `548b5b5`. **`v1.1.0` is not tagged — phase 9 tags it.**

Six workers in parallel worktrees, then two follow-up workers for what the first six found, then a
fresh verifier that authored none of it. `WAVE.md` has the partition and why it was cut that way.

---

## 0. the inherited state was verified before anything was written

`plans/MASTER-REPORT.md §9` was run in full on `67dfaa5` **before any edit**. Every check agreed
with the report: 1,434 tests / 35 files; guard 483 files, 14 pins, 11 probes; `ask-selftest` PASS;
`pnpm evals` exit 1 with recall@5 11/22/22 and recall@1 9/6/11 to the query; `vendor-plugin` no
diff; 17 screens; fixtures byte-identical; standalone bundle, plugin shim and MCP `tools/list` all
1.0.0; `npm view potsherd` 404; `gh release list` empty; the `audit --verify` pipeline reproducing
330/31/299/2971. `npm whoami` → `hulkintherapy`.

**This is the first phase in the build where the state inherited was the state described, with no
correction.** It is also the phase that found the most things nobody had described at all.

## 1. what shipped, item by item

| item | before | after |
|---|---|---|
| **8.1** guard probe | no rule could see a transcript record in `docs/**` | `transcript-record` rule; probes **11 → 25** |
| **8.2** ghost titles | 165 of 299 read `/resume`, `/model`, `clear` | **0**; 164 keep a real title, 135 take `<project>-<id8>` |
| **8.2** live titles | 10 rows named `<project>-<id8>` | **2**; 204 sessions gained a derived name |
| **8.3** privacy pins | 14 | **0** |
| **8.4** `ignore` | 14 of the top 15 `ls` rows were potsherd's own | **0**; `find pgbouncer` returns the user's session first |
| **8.4** subagent bug | a worktree dir rendered as a project slug | resolved to its owning project; `gitBranch` still names the worktree |
| **8.5** fusion gate | `pnpm evals` exit 1 since phase 3 | **exit 0**; weight-0 regression exits 1 on two independent clauses |
| **8.6** `index` default | 6m 44s, 32 MB model, network | **9.6 s**, no model, no socket; `--embed` is the opt-in |
| **8.6** `card --limit N` | errored without `--all` | a scope: implies `--all`, newest first |
| **8.7** `ask` progress | one blind spinner for 44–180 s | one line per reader as it returns, on **stderr** |
| **8.7** the fast path | — | ships as **`--cheap`**, because it measured slower — see §3 |
| **8.8** `stack` legend | the claim asymmetry was per-row only | a legend above the table, in `--json`, and in `docs/memory-stack.md` |
| **8.8** README caption | the disclaimer was two paragraphs below the block | above it, where a screenshot crop cannot lose it |
| **T8.H** *(not in the plan)* | the id rule was a blocklist | an **inventory**; real ids **25 → 11** |

**Gates at `dbee0d2`:** `pnpm test` **1,532 / 38 files**, and the same under `POTSHERD_SQLITE=node`.
*(This line read `1,530 / 69 files` until phase 9's verifier re-ran it — corrected against a
measurement rather than against memory.)*
`check-privacy.py` **506 files, 0 pins, 25 probes, exit 0**. `ask-selftest` PASS on 16 cases.
`pnpm evals` **exit 0**. `vendor-plugin` no diff. 17 screens. Fixtures byte-identical. **21 verbs** (plus `help`).

## 2. the two P0s that were not in the phase file

Both were raised by workers **outside their own scope**, and both were confirmed by hand before
being assigned. The brief line that produced them is *"anything of this class you found and did not
fix"*, and it is now in the template.

**Real session ids were published.** `phases/phase-2/VERIFICATION.md` carried ten real ghost-card
ids and six files under `phases/phase-4/evidence-T4.3/` carried more — family (2) violations by the
guard's own definition, in a public repo, through eight phases of a guard that passed every time.
The reason it passed is the finding: the id rule was an **enumerated blocklist**, so an id nobody
had noticed was invisible. Same structural blind spot as the prose leak, in a different shape.

The rule is inverted now. It inventories every id-shaped token in tracked text **and tracked file
names**, accounts for each against sources the repository can **derive** — a generated corpus tree,
hand-typed literals, documented placeholders, a sha the repo writes out in full — and treats the
residue as a finding, pinned so it can only shrink. **177 tokens, 148 accounted for, 29 unaccounted
and pinned at 130 occurrences across 35 files.**

**It caught a leak introduced during the same phase, out of the plan folder.** Phase 8.7's worked
example in `phases/phase-8-hardening.md` used a real session id from the reference machine. A worker
copied it into `packages/core/src/render/ask.ts`'s docstring and four times into its test — and
`render/ask.ts` is vendored into **both plugin bundles**. Nobody found it by reading. The blocklist
could never have found it. The plan file now carries a demo id and a warning, and `09 §3` has a
standing rule: **never copy an identifier out of a plan file into the repo.**

## 3. `--fast` measured slower than the default, so it is `--cheap`

W6 built the flag as specified and then measured it against a control — five questions, ten runs
each, on the reference corpus:

```
--cheap   p50 50.5s   $0.065/run   answered  7/10   citations 19/19  0 faults
default   p50 45.0s   $0.139/run   answered 10/10   citations 45/45  0 faults
```

2.1× cheaper, fractionally **slower**, misses more. The cause was established rather than guessed:
**the unit of latency is a model call, not a token** — each reader is a separate agent-SDK `query()`
that spawns a process, so cutting a reader's prompt by 31% moved wall time not at all, and three
readers finish in the wall time six do. Nothing that only shrinks prompts can make this verb faster.

`k` was not cut below 3, citations were not relaxed, the question set was not changed. `09 §13.11`
gives three honest options and this is the first — change the thing — where **what was wrong was the
claim the name made.** A flag called `--fast` that is slower is a false string in the product's own
vocabulary, in a product whose whole pitch is that its numbers are measured. Its note says
*"about half the cost, not faster … and it can miss"*, and the numbers are in the docstring.

## 4. "299 deleted" keeps its number and gains a second one

`history.jsonl` rows carry exactly five fields and **none distinguishes a session from a
resume-picker invocation**. Of 299 ghosts, **92 are exactly one `/resume` entry and none of the 92
ever had a transcript**; 122 have exactly one entry, 98 of those a slash command. The signature is
behavioural, not structural: it cannot separate *the picker was opened* from *a session was started,
one slash command typed, then abandoned*, and both are real events with real ids.

So no count moved. `audit` gained one conditional row — **`only commands and stubs 140 of the 299
deleted`** — and **the standalone receipt computes it too**: `audit --verify --json | jq -r .snippet
| sh`, run as printed in a shell told nothing, reproduces all five numbers, and a test diffs the
snippet's output against the rendered card row by row. The row renders only above zero, so the demo
corpus is silent and `docs/screens/01-audit.txt` did not move.

**The frozen snapshot says 329/30 where every published artefact says 330/31.** Recomputed by hand:
321 distinct `sessionId`s in `history.jsonl`, 30 transcript files, 8 absent from history, union 329.
The delta is the session that was running when the snapshot was taken, and it is consistent —
329−30 = 299 and 330−31 = 299. **Every load-bearing number is identical: deleted 299, prompts lost
2,971, and 91% rounds the same from 90.6% and 90.9%.** Ruled: change nothing, record it.

## 5. what the orchestrator broke and how it was caught

Four defects, all the orchestrator's own, all at integration, **all found by running the verb rather
than reading it** — the fifth consecutive phase in which that has been true.

- `card --limit 5 --dry-run` quoted five targets and closed on `run potsherd card --all`, which is
  123 targets on the reference archive. Following the screen's own instruction spends 25× what the
  screen quoted. Now tested, and mutation-checked.
- a sidechain reader printed `01` as its identity. `potsherd show 01` matches six sessions —
  checked, not assumed. It prints `<parent>↳<tag>` now.
- the first rewrite of the privacy receipt reintroduced the bare sentence **`no network.`**, the
  exact claim this project shipped once when it was false. `tests/cli.test.ts` forbids it by regex
  and went red. **The wording changed; the guard did not.**
- a hand-edit to the README's copy of the privacy receipt, which is **machine-synced** from the
  screen. Three drifts from one manual edit; **CI caught it**, which is what CI is for.

And one more, found by eye rather than by any test: on a text-only index — which 8.6 made the
default — `find`'s footer read *"the words matched; `--vectors on` adds semantic search"*. There are
no vectors to turn on until a model is fetched, so **the first `find` a stranger runs was the case
it was wrong for.**

## 6. a title is the words, not the furniture around them

W8 shipped 8.2's live half and flagged, honestly, that it had narrowed one assertion to hold: the
stopping rule admitted `[Image: source: …/clipboard-2026-06-20.png]`, so a session became titled by
a paste placeholder — and by the home directory inside it.

Rejecting such a prompt would also have been wrong: it *does* name its session. `stripBoilerplate`
is the same function `find` already uses to decide what may be quoted as **evidence**, which is the
right authority — a string too empty to quote is too empty to name, one with words left is worth
both. Composed into the **candidate** rule:

```
placeholder titles                 some  ->  0
derived titles with a home path      19  ->  0     <- W8's finding (d)4, closed as a side effect
ghosts keeping a real title         166  ->  164   <- three were only a placeholder; honest
bm25 recall@5 / recall@1          11 / 9  ->  12 / 10
```

The path was **inside** the placeholder, which is why no rule aimed at paths would have caught 14 of
those 19. The narrowed assertion is broad again, over the whole screen.

`docs/screens/08-ls.txt` is the point of all of it: four rows that read `report-builder-6fe53b91`
and `mobile-shell-532a725c` now read `why does the file uploader allocate…` and `move the cli
argument parser behind…`.

## 7. corrections made to the plan, all logged in `04-DECISIONS.md`

- **8.3's acceptance asked for 3 pins and the true target was 0.** It came from `FINAL-REPORT.md:181`
  mis-splitting the fourteen as *"eleven evidence pastes plus three forbidden-string lists"*. There
  were never forbidden-string-list entries in `DEBT`; those three are `ALLOW` entries. Three
  orchestrators and the master had read that line; the worker doing the work found it in an hour.
- **8.7's acceptance is recorded as missed**, with the measurement beside it and the rename.
- **`--claude-dir` plus `--potsherd-dir` is not isolation.** `index` reads all seven harnesses and
  the other six resolve to the developer's real `~/.codex`, `~/.cursor`, `~/.pi`. A corpus built the
  way every brief prescribed held **237 sessions where the demo corpus has 53**. Committed artefacts
  are unaffected — `make-screens.sh` relocates `$HOME` — but the brief template is corrected.
- **Never copy an identifier out of a plan file into the repo.**
- `03 §11` promised *"`~/.potsherd` and the four things inside it"* and had only ever listed three;
  `config.json` is the fourth and is now on the receipt.

## 8. open at the end of phase 8

| # | item |
|---|---|
| 1 | **29 unaccounted id-shaped tokens, pinned at 130 occurrences.** A real id remains the canonical `--help` example for several verbs across `packages/**`, seven tests and both bundles. Exact edits are in `registration-W7.txt`. **This is the largest remaining privacy item.** |
| 2 | **`docs/demo-ask.cast` is stale.** `ask` prints reader lines now and asciinema records stderr, so the cast shows a spinner the product no longer has. Phase 9 T9.1 re-records it. |
| 3 | the frozen snapshot's 329/30 against the published 330/31 (§4) — recorded, not changed |
| 4 | the demo corpus reproduces the headline counts and **none** of the mess: 0 slash-command-only ghosts against the real archive's 140. Every screenshot is therefore taken against a tidier archive than any real one |
| 5 | `ask --cheap` answered 7/10 where the default answered 10/10 — a real quality cost, disclosed on the screen |
| 6 | `doctor` says `21 harness-titled` and `stats` says `31 titled`; disambiguated, but nobody asked whether both belong |
| 7 | everything in `plans/08` §§2, 3, 6 that phase 8 did not touch — the missed targets, the three unverified adapters, the four documentation-only `setup` clients |

## 9. how to check this handoff in ten minutes

```bash
git log --oneline -1     # dbee0d2 or later
pnpm install && pnpm build
pnpm test && POTSHERD_SQLITE=node pnpm test                     # 1,530, twice
python3 scripts/check-privacy.py ; echo "exit=$?"               # 0 pins, exit 0 — NOT through a pipe
python3 scripts/check-privacy.py --selftest                     # 25 probes
npx tsx evals/ask-selftest.ts                                   # PASS
pnpm evals ; echo "exit=$?"                                     # 0
pnpm evals -- --vector-weight 0 ; echo "exit=$?"                # 1 — the gate is still a gate
node scripts/vendor-plugin.mjs && git status --short plugins/   # empty
POTSHERD_SCREENS_NO_MODEL=1 bash scripts/make-screens.sh        # ok 17 screens

# 8.2 on a real archive, isolated the way that actually isolates
H=$(mktemp -d)/home && mkdir -p "$H" && A=~/.potsherd/archive-manual-2026-08-21 && R=$PWD
run(){ ( cd "$H" && env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH \
  HOME="$H" node "$R/packages/cli/bin/potsherd.js" --claude-dir "$A" --potsherd-dir "$H/.potsherd" "$@" ); }
run rescue --yes --no-settings >/dev/null && run index >/dev/null
sqlite3 "$H/.potsherd/potsherd.db" \
  'select count(*) from ghosts where first_prompt like "/%" or length(first_prompt)<8;'   # 0
run ls --ghosts only | head -15        # read it by eye: nothing that reads as broken
run audit                             # the 'only commands and stubs' row
run audit --verify --json | jq -r .snippet | sh   # must reproduce all five numbers
```

## 10. one sentence, for whoever is next

*"Two of the four best findings this phase came from a worker reporting something that was not its
job, and the guard that caught the most was the one we inverted from 'flag what I recognise' to
'account for everything, and flag what is left' — so when a check keeps passing, ask what it cannot
see rather than what it has not been shown."*
