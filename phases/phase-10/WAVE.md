# phase 10 — wave log

**orchestrator 5.** the loop protocol in `RESUME-PROMPT.md` is in force: this file and
`HANDOFF.md` are written incrementally and committed, so a restart loses nothing.

## inherited state, verified before anything was written (23 aug, HEAD `99bbb8b`)

Every line here is a command that was run, not a claim that was read.

| check | expected (from `plans/08`) | measured |
|---|---|---|
| `git rev-parse HEAD origin/main` | equal | equal, `99bbb8b` |
| `gh run list` | green | green on `99bbb8b` and the two before it |
| `pnpm test` | 1,532 / 38 files | **1,536 / 39 files** — the plugin-install regression added 4 |
| `check-privacy.py --selftest` | 25 probes | 25 probes, all as expected |
| `check-privacy.py` | 510 swept, 0 pinned, 29 unaccounted ids | **517 swept**, 0 pinned, 29 unaccounted at 130 occurrences / 35 files |
| `npx tsx evals/ask-selftest.ts` | PASS | PASS, 16 cases |
| `pnpm evals` | exit 0 | exit 0 · recall@5 12/22/22 · recall@1 10/6/11 |
| `vendor-plugin.mjs` + `git status plugins/` | no diff | no diff |
| `make-screens.sh` | ok 17 screens | ok 17 screens, widest 80 |
| `make-fixtures.mjs` + `git diff` | no diff | no diff |
| `npm view potsherd version` | 1.1.0 | 1.1.0 |
| `gh release list` | v1.1.0 latest | v1.1.0 latest |

**The inherited state is the state I was told about.** Two drifts, both benign and both explained
by `99bbb8b`: four more tests, seven more swept files.

## F1 re-measured on the real archive, and it is not what the audit said

The audit's nonsense control no longer reproduces, **and the reason matters**: the audit itself is
now in the corpus, so `find "zzzqqq flurblewomp aardvark protocol"` matches the *audit session that
typed those words*. A control that has been written down is no longer a control. Two fresh nonsense
strings were used instead.

Real archive, `index --no-embed`, 332 transcripts / 1,678 exchanges / 433 MB:

| query | class | rows | top score |
|---|---|---:|---:|
| `potsherd` | true topic, one word | 10 | **0.02754** |
| `privacy guard redaction` | true topic, phrase | 4 | **0.01836** |
| `kubernetes ingress payment service` | **absent topic** | 2 | **0.01639** |
| `quarterly dividend reinvestment tax` | **absent topic** | 6 (relaxed) | 0.01102 |
| `wibble frotz zagnut quux` | fresh nonsense | **0** | — |
| `blorptastic zibbleflux` | fresh nonsense | **0** | — |

Two corrections to the audit, both of which change the fix:

1. **Pure nonsense already returns an honest empty.** F1's most quotable line — "ten confident rows
   for a word that does not exist in any human language" — does not reproduce at `99bbb8b` on
   uncontaminated tokens. FTS finds no term and `find` prints nothing. That half is already right.
2. **The real defect is tighter and worse than 1.67×.** A genuine phrase hit scores `0.01836`; a
   topic that is definitively absent from this archive scores `0.01639`. That is **1.12×** — a 12%
   gap between "the archive answers this" and "the archive has never heard of this". The audit
   measured 1.67× and called it fatal; the true figure is seven times tighter.

**And the root cause is structural, not cosmetic.** The fused score is **reciprocal rank fusion**
(`recall.ts` ~line 1452): `contribution = weight * rrfScore(rank, k)`. RRF is a function of *rank
only*. It has already discarded how well anything matched by the time the number exists. So the
audit's prescription — "normalise scores to 0–1 against the query's own score distribution" —
**cannot work**: normalising a rank-derived score against its own set maps the top row to 1.0
whether it is a bullseye or the least-bad of two bad rows. `kubernetes ingress payment service`
would normalise to a confident 1.0.

Calibration has to be computed from the **raw per-list evidence**, which `recall.ts` already
carries and throws away: `from[].raw` holds each list's own bm25 magnitude / cosine, alongside
`rank` and `contribution`. That is the input. This is recorded in `plans/04` and is binding on T10.1.

## waves

| wave | tasks | why grouped |
|---|---|---|
| 1 | T10.1 calibration · T10.2 model ladder · T10.4 lazy WASM vectors | disjoint modules: `recall`+`find`, `llm`+`ask`, `embeddings`+`index` |
| 2 | T10.3 threads · T10.5 windows · T10.6 MCP+skills+agent · T10.7 cards lane | 3 and 7 need 1's scoring; 5 needs 2's seam |
| 3 | T10.8 `note` write-back · T10.9 keyphrase · C leftovers | |
| 4 | fresh verifier → fixes → v1.2.0 via the provenance workflow | |

## the orchestrator's own first defect, logged before anything else

`docs/AGENT-AUDIT-2026-08-23.md` was left **untracked** by orchestrator 4. Orchestrator 5 committed
and pushed it in `96a0166` without reading it against the guard. It carried **seven real session
ids** and **three real project directory names**, on a public repository, for about thirty minutes.

Two rules already written down, both broken in the same minute:

- **`09 §16.7` — read the exit code, not the last line.** The guard *was* run. `tail -2` printed its
  header caveat, which reads like a pass. The run had already failed with exit 1, and the `&&` chain
  committed because the `tail`, not the guard, was the last command in it.
- **`09 §13.9` — a guard's stated limitation is an open item.** The `project-name` rule is an
  exact-substring list whose own header says *"exact is the whole weakness"*. It did not know
  the name in question, so twelve occurrences walked through the rule that exists to catch them.

Repaired: session ids became stable placeholders drawn from the guard's own hand-typed-literal class
(≤ 3 distinct hex digits), project names became `<project-a>`…`<project-c>`, one-to-one so every
claim that depends on two ids being the same or different still reads. A header note in the document
says the substitution happened. The unredacted copy lives outside the repo. Both casings of the
name were added to `REAL_PROJECT_NAMES`, and `tests/open-threads.test.ts` gave up the copy it held
in an example path.

**And then the guard caught this very file** — the paragraph above named the name while explaining
that the guard had not known it. `09 §13.5`, verbatim: *the guard caught something in the commit
that created it*. Worse, it was caught by a run whose **exit code I again did not read**, because I
chained the commit after an `echo` rather than after the guard. Twice in one hour, the same rule.
The standing fix is now mechanical rather than remembered: **the guard runs as the first clause of
the `&&` chain that commits, never after anything that can succeed on its own.**

History rewritten and force-pushed. **Verified from a fresh clone, not from this machine:** HEAD
`595413c`, zero real ids in the audit, orphan commit absent. The orphan may stay addressable by
exact SHA on GitHub until it is garbage-collected; that is recorded rather than hidden.

## lineage measured on the real archive, for T10.3

`uuid` overlap across the 35 transcripts with more than 20 records:

| overlap | shared uuids | child | parent |
|---:|---:|---|---|
| **0.99** | 1,660 | 1,836 rec · 12→20 aug · 37 MB | 2,409 rec · 12→19 aug · 38 MB |
| **0.96** | 194 | 292 rec · 16 jul→29 jul · 1.3 MB | 483 rec · 16 jul→3 aug · 27 MB |

The audit found the first chain. **The second is new** — it was never reported, and it is the same
defect a month earlier. Two chains, **4 of 35 sessions (11%)**, and both children are among the
largest files in the archive: the sessions the thread model fails on are exactly the sessions with
the most work in them. Record dates are present on the records themselves, so dating by content
needs no new source of truth — only for the ranker to stop inheriting the fork point.

## reading real output by eye (`09 §10.4`) — three things the audit did not say

**1. `show` contradicts itself four lines apart.** The header dates the session by its fork point;
its own first exchange is eight days later. Both are on the same screen:

```
  claude · live · <project-a> · 12 aug 19:21 · main
  4 exchanges
    1  20 aug 23:26  you
```

The audit reported this as "`find` and `ls` date it as 12 aug". It is worse than that: the date and
the evidence that contradicts it are printed together, by one verb, in one render.

**2. `graft` already dates by content, and nothing else does.** The same session, same index:
`graft` prints `2026-08-20` — the content date, correct — while `show`, `ls` and `find` print
12 aug. So the fix for F4 is not "teach potsherd to date by content"; potsherd already knows how,
in one verb. It is **one source of truth**, and `graft.ts` is where the right answer already lives.

**3. `ls` is still drowning in the build's own sessions.** `08 §8` item 25 says phase 8.4 addressed
this. On the default `ls --limit 12`, **eight of twelve rows** are potsherd's own development or its
test probes — two rows are sessions whose entire content is `Reply with exactly: PONG`, under
projects `w6-ask` and `tmp`. An item marked closed in a handoff is not an item that was closed.

`graft` writing `.potsherd/graft-<id>.md` into the cwd **is** correctly self-ignoring — `git status`
stayed clean, as the audit credited. Verified deliberately, then deleted.

## codex is installable, and the subprocess ladder writes into the corpus it reads

Two findings from verifying third-party flags before documenting them (`09 §10.1`, the rule six
false plan claims wrote).

**1. `codex` is not uninstallable here, and has not been since phase 5.** `@openai/codex@0.149.0`
installs from npm in 39 seconds. Against the real `codex exec --help`, **every flag potsherd's
`CodexTransport` guessed from documentation is real**: `exec`, `--skip-git-repo-check`,
`-C/--cd <DIR>`, `-m/--model <MODEL>`, and `-` for stdin. The plumbing was right. The
`unverified — documentation only` label can narrow to what is still genuinely unverified — a real
authenticated round trip — instead of covering the argv it now covers.

**2. The subprocess ladder writes new sessions into the archive potsherd indexes.** Already true in
the reference archive, from phase 6's probes:

```
~/.claude/projects/-Users-zebra-randomness-wt-w6-ask/    1 session
~/.claude/projects/-private-tmp/                          2 sessions
```

They are visible in `ls` today as rows titled `Reply with exactly: PONG`, sitting in the user's own
history beside their real work — and they are part of why `ls` reads the way item 25 says it does.

The SDK path never had this problem; it is in-process. **Rung 2 of A1 introduces it at production
scale**: `card --all` is ~39 calls, so 39 junk sessions injected into the user's archive, which
potsherd then indexes, cards, ranks and surfaces. A tool whose premise is *your archive is the
record* cannot write to the archive as a side effect of reading it, and the project already has a
rule saying agent dirs are read-only inputs.

The levers, both verified against the real binaries: `claude` has no ephemeral flag, so
**`CLAUDE_CONFIG_DIR`** must point at a scratch dir; `codex exec` has **`--ephemeral`**, *"run
without persisting session files to disk"*. Handed to T10.2 with a test added to its acceptance
list: a subprocess model call must leave `~/.claude` and `~/.codex` untouched, proved by copying the
trap rather than building a clean room.

## T10.1 integrated, and its one unverifiable claim verified — favourably

T10.1 shipped a genuine negative it refused to tune away: at the floor, **17 of 25 eval queries
return an empty page and 3 of 7 rank-1 answers are lost**, with correct-vs-wrong calibration
distributions (median 0.370 vs 0.264) that overlap almost completely. It measured and rejected IDF
weighting and a cosine lane, with numbers for each, and named the one-line lever to turn the floor
off. That is the report this project wants.

It also flagged what it could not check (`§d5`): whether thresholds tuned on a **546 KB** demo corpus
survive a **433 MB** archive. That check is the orchestrator's, and it is the reason integration code
gets read rather than trusted. Measured on the real archive, frozen index, 332 transcripts:

| query | class | result |
|---|---|---|
| `privacy guard` · `session card` · `ghost sessions rescue` | true topic | **strong**, 6 / 10 / 6 rows |
| `npm publish provenance` · `eval recall gate` | true topic | **strong**, 4 / 10 rows |
| `what did we decide about the privacy guard` | true topic, **natural language** | **strong**, 2 rows |
| `mortgage escrow refinance appraisal` | absent | **no match** |
| `sourdough hydration bulk ferment` | absent | **no match** |
| `trombone embouchure brass mouthpiece` | absent | **no match** |
| `vaccine cold chain refrigeration logistics` | absent | **no match** |
| `wibble frotz zagnut quux` | nonsense | **no match** |

**The separation is clean at scale, including for the natural-language query class T10.1 measured as
inseparable.** `§d1`'s pessimism is a property of a 546 KB fixture in which stopword-heavy queries
have almost nothing to match; it is not a property of an archive. The floor ships on.

**And the control trap caught me a second time.** `kubernetes ingress payment service` returns
2 rows at `strong` on the real archive — which looks like the cliff failing, and is not. Both rows
are sessions in which *the audit typed that control string*, verbatim, all four words. Coverage is
genuinely 4/4 and `strong` is genuinely the right label. I wrote *"a control that has been written
down is no longer a control"* at the top of this file and then reused a written-down control to
check somebody else's work six hours later. **The four absent-topic controls above were invented
after the index was frozen and have never been typed on this machine**, which is the only property
that makes a negative control mean anything.

Integration owed four lines T10.1 could not write. The one that matters: `packages/mcp/src/tools/
find.ts` now calls `recall()` with `minConfidence: 'weak'`, so the **agent-facing** door has the same
cliff as the human one. Suite 1,536 → **1,566 green on 40 files**; the single red T10.1 reported was
the MCP parity test and this patch is its fix. `pnpm evals` exit 0 with three confidence controls.

## the eval gate now fails, and the decision is not the one it looks like

`pnpm evals` exits 1 on `main`. **`main` is knowingly red on exactly one test**
(`tests/evals-gate.test.ts`) and everything else is green: 1,691 of 1,692.

Measured by the orchestrator, both runs on the same commit and the same fixture:

| runtime | vectors-only R@5 | hybrid R@5 | hybrid **R@1** | bm25 R@1 | gate |
|---|---:|---:|---:|---:|---|
| **wasm** (shipping) | 21/25 | 22/25 | **10/25** | 10/25 | **FAIL** — not *strictly* above bm25 |
| native (control) | 22/25 | 22/25 | **11/25** | 10/25 | PASS |

The isolation is exact: one query at recall@1, one at vectors-only recall@5. T10.4 traced it to
onnxruntime-web's int8 kernels — tokenizers byte-identical, pooling precision irrelevant, every
optimisation level the same. Nothing about the storage change moved a number.

**The tempting reading is "wasm is worse, so keep native".** That is wrong twice: native is the
677 MB native-addon class the whole task exists to remove, and — the part that matters — **the gate
was never measuring anything at n = 25.** `plans/08` has recorded *"the margin at recall@1 is one"*
since phase 8.5. σ ≈ 2.2 on this set. A criterion whose pass/fail turns on a margin four times
smaller than its own noise was going to flip on the next change whatever that change was; wasm is
simply what flipped it first.

**Ruling: widen the measuring instrument, do not touch the criterion.** Re-basing the gate on
whatever the shipping runtime happens to score is the thing phases 3–7 all refused — *rewriting the
test around the result*. Widening the query set changes no clause; it raises the power of a test
that currently cannot tell 10 from 11. Phase 3's best decision was building the instrument with a
worker who had **no stake in the score**, and that is how this one is commissioned: the eval-set
worker is told nothing about wasm, native, or which way the number needs to go, and its set must
still fail at `--vector-weight 0`.

If the gate still fails at n ≈ 50, that is a real finding about the wasm runtime and it will be
reported as one rather than tuned away.

## status

**Five workers running**, each in its own worktree with disjoint deliverables:

| task | what | owns |
|---|---|---|
| T10.1 | the cliff: calibrated confidence, honest empty | `recall` `calibration` `find` + renderer |
| T10.2 | the model ladder: host agent → `claude -p` → SDK | `llm` `ask` `card` |
| T10.3 | threads: derive the chain, date by content | `db`(mig 11) `ingest` `threads` `graft` `ls` `show` |
| T10.4 | vectors always on, lazily, in WASM | `embeddings` `vec` `index` `doctor` (mig 10) |
| T10.6 | three MCP tools, one skill, fabrication killed in code | `packages/mcp` `agents/` `skills/` |

Migration numbers were allocated **before** the wave, per `09 §6.6`: 10 → T10.4, 11 → T10.3,
12 → the `note` write-back, 13 → the cards lane. No worker takes the next free number.

Deferred on purpose, because they collide with a live worker:
- **W7 id substitution** (`phases/phase-8/registration-W7.txt`) — the largest remaining privacy item.
  It rewrites a real session id used as the `--help` example across `packages/cli`, `packages/core`,
  `packages/mcp`, seven tests and both bundles. Four of those files are owned by live workers.
  Runs after wave 2 merges, in one commit, by the orchestrator.
- T10.5 windows (needs T10.2's seam) · T10.7 cards lane (needs T10.1's scoring) · T10.8 `note` ·
  T10.9 keyphrase.

**Blocked on a human:** `NPM_TOKEN` is not set — `gh secret list -R HulkInTherapy/potsherd` returns
empty. v1.2.0 publishes through the provenance workflow, which needs it. Asked meghavi. Everything
up to the tag proceeds without it.

> **CORRECTED, same day, and the correction is the interesting part.** There is no `NPM_TOKEN` and
> there must never be one. meghavi configured npm **trusted publishing** — `potsherd` → Trusted
> Publisher → GitHub Actions / `HulkInTherapy/potsherd` / `publish.yml`, allowed action `npm publish`
> only — so the runner authenticates with the OIDC id-token it already requests for `--provenance`,
> and an empty `NODE_AUTH_TOKEN` would be *worse* than none because npm would try to use it.
> `gh secret list` returning empty is the **desired** state, and this paragraph read it as a blocker
> because it was looking for the thing the old plan named rather than for the thing the workflow
> does. `.github/workflows/publish.yml` has said so in its own header since `03fbba0`, and its
> `workflow_dispatch` dry run passed every step on that commit (run 32675772351). Logged in
> `plans/04` on 24 aug; `plans/08 §0` already carried the correct state while this file did not.
> **The rule it belongs to is `09 §10.1` inverted: verify a prerequisite is still required before
> waiting on it.**


---

## the gate ran, and it FAILED — 6/10 against 8

A fresh verifier re-ran the audit's §7 on the real archive and re-scored §0.
Full report: `phases/phase-10/VERIFICATION.md`.

| row | was | now | gate |
|---|---:|---:|---|
| **overall** | 4 | **6** | ≥ 8 · **FAIL** |
| retrieval quality | 3 | **7** | ≥ 7 · PASS |
| reliability of a default install | 2 | **6** | ≥ 8 · **FAIL** |
| agent ergonomics | 3 | **6** | ≥ 8 · **FAIL** |
| re-entry | 5 | 7 | — |
| human CLI ergonomics | 8 | **7** | — (four printed numbers disagree) |

Nine defects, twenty claims that held, and a could-not-check list with a reason for each.
**It confirmed the control trap a third time**: the audit's own nonsense string now returns three
`strong` hits, because the audit document is indexed. It invented two fresh controls after freezing
the corpus and said so. It changed nothing while scoring. It could not reproduce one thing the
orchestrator had reported by eye — `show` past 80 columns — across 38,488 lines, max 79. **The
orchestrator was wrong and the verifier was right to say so.**

### the fix round

**D1 was the orchestrator's, and it is the fifth consecutive phase where integration was the weak
point.** `potsherd_read` probed `core.resolveThread`, which **was never written and never
exported**. T10.6 wrote out the signature and asked for it; the orchestrator applied T10.6's *other*
owed line and missed this one. Two independent alarms failed to fire: the probe degraded politely,
and `threadsAvailable()` — the function whose job is to report the capability missing — **had no
callers**. So a missing capability announced itself only to the model, in prose, at the moment it
mattered.

Fixed at the root: `resolveThread` exists, threads is exported, and **the probe, the fallback and
`threadsAvailable()` are all deleted**. `via` has one legal value; two tests fail if a fallback ever
returns. `tests/mcp.test.ts` no longer accepts `session-only`, because that latitude is how this
passed a release. The worker swept for the pattern and found one other hit — a platform check, not
a probe.

**D7** was the prompt and the filter disagreeing. The excerpt is printed labelled, the prompt says
copy it exactly, so a model that *obeyed* produced quotes the filter dropped as fabrications. Fixed
in the filter's normalisation, and only a leading label comes off — an interior `assistant:` stays
refused, because that is a fabrication of contiguity rather than a label.

**Standing rule this produced, for `09`:** *when a module probes for a capability and falls back,
the fallback must be loud in tests, or it becomes the permanent behaviour.*

---

## rounds 2 and 3: the score moved 6 → 7 → 7, and every remaining defect was the same defect

Two more fresh verifiers, each cloning the commit under test to a private directory, each
relocating `HOME` onto an APFS clone of the seven harness directories, each inventing its own
negative controls **after** freezing the corpus because the audit's own nonsense string is now
indexed and returns `strong`.

| round | commit | overall | retrieval | reliability | agent ergonomics | report |
|---|---|---:|---:|---:|---:|---|
| 1 | `9c663e9` | 6 | 7 | 6 | 6 | `VERIFICATION.md` |
| 2 | `9c663e9` | 7 | 7 | 8 | 7 | `VERIFICATION-2.md` |
| 3 | `339df63` | **7** | 7 ✅ | 8 ✅ | **7** | `VERIFICATION-3.md` |

Retrieval and reliability have passed since round 2 and have not moved since. **Everything still
under the gate is one failure wearing costumes: an instruction aimed at an agent that the agent
cannot follow.** `potsherd_recall`'s caller has three MCP tools and no shell.

- **round 2** found `--vectors on` in the model-facing capability string — a flag the schema does
  not accept.
- **round 3** found that the fix had changed **one branch of three** in the same function, and
  that the untouched branch — the one **every fresh install** hits, at zero vectors — said
  `SEMANTIC SEARCH UNAVAILABLE … run potsherd index --embed`. A shell command, on the agent
  surface, whose falseness the repository's own comments in `render/find.ts:229` and
  `render/stats.ts:158` already recorded. It had been deleted from both **human** screens with a
  comment explaining why, and left on the **agent** one.
- and `scope.project`'s error answered an agent with `potsherd ls --json | jq …`, which is
  un-runnable by the reader *and* wrong on its own terms: `ls --json` returns the 15 newest, so
  the pipeline reported 5 projects where the database holds 18.

**FIX-C** (`8c6fb8e`, merged at `4e8ebe6`) closed all three at their source rather than where they
surfaced: the shell verb is dead in `core/recall.ts`, all three branches of `capabilityLine` carry
`N of M embedded` read from the same `vecStatus` the human verbs read, the no-match note discloses
that only the keyword half ran, and `scope.project` returns *the projects the index holds* with the
tail disclosed instead of silently slicing to five. Eight tests, seven red first, one green on
purpose — the guard that a genuinely unavailable runtime still says so had to survive the change.

**The verifier sized the vector half's contribution and it is not small**: the same query returns
1 session with vectors on and 0 with them off, and evals put bm25-only at 40/60 against hybrid's
51/60. So during the warm window ~11 of every 60 answerable questions were coming back as
`noMatch: true` carrying *"The archive does not contain this … do not widen into a guess"*.

**A discrepancy worth keeping.** FIX-C's worker reported, correctly and in its own §0, that
`VERIFICATION-3.md` did not exist in its worktree or anywhere in git history — it had been briefed
from quoted excerpts while the file was still uncommitted on the orchestrator's disk. It checked
every quoted claim itself before acting on any of it, and said which of its conclusions depended on
the missing file (none). That is the right behaviour and it is why the round is trustworthy;
the orchestrator's sequencing was the defect, not the worker's.

## the fourth thing I did not read: CI

`main` was **red for three consecutive pushes** — `9c663e9`, `339df63`, `e593dee` — and I pushed
the third without looking. `09 §7.3` is titled *CI is not a formality; it is the only machine that
is not yours*, and this phase has now broken `09 §16.7` (**read the exit code, not the last line**)
three times: twice on the privacy guard in one hour, and once on a workflow whose result I simply
never opened.

The failure was not in any product code. `docs/screens/05-doctor-privacy.txt` was regenerated when
FIX-B added `.potsherd/.gitignore` and the two `ask --*-out` paths to the receipt; **README.md
quotes that screen verbatim and was not regenerated with it**. CI diffs the two, and it is right
to: the receipt a reader trusts is the published copy, not the source. Fourteen lines the product
prints that the README did not — including the note that the one directory appearing under
claude's own `projects/` is created by claude code rather than by potsherd.

Fixed at `15a31cf`. The screen-versus-live half of the same check passed on both runners
throughout; only the published copy was stale. **`10-MASTER-VERIFICATION.md`'s block does not
include a CI check, and that is the gap that let this run for eleven hours.** Added to the loop
protocol in `RESUME-PROMPT.md`: `gh run list -L 3` is part of the wake-up state, beside
`git log --oneline -5`.

## FIX-D: the residue

Round 3's two remaining items, in `wt-FIX-D` off `15a31cf`:

- **C4** — `tests/plugin-install.test.ts` compares **mtimes**, so a byte-for-byte `cp`, a `touch`,
  a `git checkout` away and back, or a rebase turns it red while `pnpm vendor` reports no diff.
  Rule 7 again (*a test's premise must be something the test establishes*), and the third
  instance this phase. It must compare content, and the worker must show it going red on a real
  drift — `vectors-lazy.test.ts` was accepted last round only because its author proved that.
- **C5** — the top `hits[]` row can be labelled weaker than the rows beneath it (order is the RRF
  fused score, label is the calibration score, and RRF is a rank artifact); the receipt's new
  `.gitignore` line is the only `writes:` entry with no explanatory sub-line; and the suite has
  leaked `hang.mjs` children that were still alive after **two days**.
