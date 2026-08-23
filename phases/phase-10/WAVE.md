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
  `Proteus`, so twelve occurrences walked through the rule that exists to catch them.

Repaired: session ids became stable placeholders drawn from the guard's own hand-typed-literal class
(≤ 3 distinct hex digits), project names became `<project-a>`…`<project-c>`, one-to-one so every
claim that depends on two ids being the same or different still reads. A header note in the document
says the substitution happened. The unredacted copy lives outside the repo. `Proteus`/`proteus` were
added to `REAL_PROJECT_NAMES`, and `tests/open-threads.test.ts` gave up its `/Users/example/proteus`.

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

## status

- **wave 1: running.** T10.1 calibration · T10.2 model ladder · T10.4 lazy vectors.
- orchestrator, in parallel: the traffic workflow (`ci: keep the traffic numbers…`), the audit
  redaction above, and the lineage measurement above.
- **`NPM_TOKEN` is NOT set** (`gh secret list -R HulkInTherapy/potsherd` is empty). Asked meghavi.
