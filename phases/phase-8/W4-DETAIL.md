# W4 (honesty) — detail

branch `p8/w4-honesty` · items **8.5** (the fusion gate) and **8.8** (the honesty
surfaces) · all evidence in `/tmp/w4-evidence-u8Pn`

---

## 8.5 — the fusion gate

### what was wrong

`plans/06`'s gate was *hybrid ≥ 22/25 at recall@5 **and** hybrid beats bm25-only
and vec-only on the same set*, and "beats" was implemented as a strict `>` at
recall@5. On a 25-query set recall@5 saturates: bm25 11, vectors 22, hybrid 22 —
a three-way tie at the ceiling. A strict `>` against a saturated metric can only
be passed by making the set easier or by fitting the weights to it, which is why
phases 3–7 each refused both available fixes and shipped red.

### the amendment, as ruled

`plans/phases/phase-8-hardening.md` §8.5, written by the author of the original
gate: **hybrid must be ≥ both singles at recall@5 *and* strictly above both at
recall@1.** Weights untouched — `WEIGHTS.vec_* = 1.5`, the phase-3 stopping
rule. `plans/06`'s absolute floor (≥ 22/25 at recall@k) is kept: the amendment
changed how hybrid is compared *against the singles*, not the floor, and a
fusion that fell under 22/25 is still refused.

### what changed

| file | what |
|---|---|
| `evals/gate.ts` (new) | the rule as a **pure function over counts** — `judge(mode, {bm25, vectors, hybrid}, total, k)` — plus `PHASE_1_GATE`, `PHASE_3_GATE`, `ruleLine(k, total)`. Pure so it can be tested with numbers a test writes itself rather than numbers a machine happens to produce. |
| `evals/run.ts` | `gateFor` now calls `judge`; the gate block prints the amended rule in words with both operators named; `--vector-weight <n>`; the vector weight is on the header of every run; `--json` carries both halves separately. |
| `tests/evals-gate.test.ts` (new) | six shapes of result the gate must refuse, plus an end-to-end run of the real eval at weight 1.5 and weight 0. |

### the printed gate block, verbatim (`pnpm evals`, `--no-color` equivalent)

```
  vector weight 1.5 · the phase-3 stopping rule, unchanged by the §8.5 amendment
  ...
  phase-3 gate · amended 22 aug 2026 (phase 8.5), by the author of the original
  hybrid ≥ both singles at recall@5 (a 25-query set saturates there) and strictly > both at
  recall@1 (the row the user actually sees), with recall@5 ≥ 22/25
  hybrid (auto)     recall@5  22/25   ✓ ≥ bm25 (11)      ✓ ≥ vectors (22)     ✓ ≥ 22/25
                    recall@1  11/25   ✓ > bm25 (9)       ✓ > vectors (6)      PASS
  hybrid (always)   recall@5  22/25   ✓ ≥ bm25 (11)      ✓ ≥ vectors (22)     ✓ ≥ 22/25
                    recall@1  11/25   ✓ > bm25 (9)       ✓ > vectors (6)      PASS
  PASS — the amended phase-3 gate would merge this fusion
```

Two lines per mode, one per half of the rule. One line would fit at 100 columns;
it would also hide *which* of the four conditions went red.

### the numbers (this checkout, 22 aug 2026, `evals/queries.jsonl`, 25 queries)

| mode | recall@5 | recall@1 |
|---|---|---|
| bm25 only | 11/25 (44%) | 9/25 (36%) |
| vectors only | 22/25 (88%) | 6/25 (24%) |
| hybrid (auto) | 22/25 (88%) | 11/25 (44%) |
| hybrid (always) | 22/25 (88%) | 11/25 (44%) |

Identical to the orchestrator's re-measurement and to the `v1.0.0` figures.
`pnpm evals` → **exit 0**.

### the regression: `pnpm evals -- --vector-weight 0` → exit 1

```
  vector weight 0 · OVERRIDDEN (shipped: 1.5) · this is a probe, not the release gate
  ...
  hybrid (auto)     recall@5  11/25   ✓ ≥ bm25 (11)      ✓ ≥ vectors (5)      ✗ ≥ 22/25
                    recall@1   9/25   ✗ > bm25 (9)       ✓ > vectors (4)      FAIL
  hybrid (always)   recall@5  11/25   ✓ ≥ bm25 (11)      ✓ ≥ vectors (5)      ✗ ≥ 22/25
                    recall@1   9/25   ✗ > bm25 (9)       ✓ > vectors (4)      FAIL
  FAIL — the amended phase-3 gate would not merge this fusion
```

Weight 0 removes the semantic half of the fusion, collapsing hybrid onto bm25.
It fails on **two independent conditions** — the strict win at recall@1 (a tie,
9 = 9) and the 22/25 floor — and the recall@1 clause is the one that would still
catch a subtler regression.

`--vector-weight` is not a tuning knob and the code says so in three places: the
`--help` text, the `Options` doc comment, and a `warn`-coloured header line on
every overridden run, so a screenshot of a doctored run cannot be mistaken for a
screenshot of the release run. `--json` carries `weights.overridden`.

### the JSON, machine-checkable per condition

```json
"gates": {
  "rule": "hybrid ≥ both singles at recall@5 … and strictly > both at recall@1 …",
  "phase3": [{
    "mode": "hybrid", "k": 5, "total": 25,
    "wide":  { "comparison": ">=", "hybrid": 22, "bm25": 11, "vectors": 22,
               "beatsBm25": true, "beatsVectors": true },
    "tight": { "comparison": ">",  "hybrid": 11, "bm25":  9, "vectors":  6,
               "beatsBm25": true, "beatsVectors": true },
    "clearsBar": true, "bar": 22, "pass": true
  }]
},
"weights": { "vectorWeight": 1.5, "shipped": 1.5, "overridden": false,
             "lists": ["vec_exchanges","vec_ghost_prompts","vec_cards"] }
```

### the test that proves the gate can still fail

`tests/evals-gate.test.ts`, two layers.

**Layer 1 — the rule, over numbers the test writes.** Always runs, no model, no
index, no corpus, ~10 ms. Each case is a shape that must be refused and each is
refused by a different clause, so relaxing any single clause turns exactly one
test red:

1. the measured v1.1.0 run passes, and recall@5 passes *on the tie*;
2. the measured weight-0 regression fails, **on `> bm25` at recall@1**;
3. a tie at recall@1 against either single fails;
4. a fusion below either single at recall@5 fails;
5. a fusion under 22/25 fails even when it beats both singles;
6. a three-way tie at recall@5 with a strict recall@1 win **passes** — this one
   goes red if anyone restores the pre-amendment strict `>` at recall@5;
7. `ruleLine` names both operators.

Mutation-checked: changing `>` to `>=` in `gate.ts`'s recall@1 half turns 3 of
the 8 tests red (cases 2, 3 and the end-to-end one).

**Layer 2 — the whole eval, end to end.** Runs `evals/run.ts --json` twice in a
subprocess, at the shipped weight and at 0, and asserts exit 0 / pass true then
exit 1 / pass false, having first established its own premise (`index.skipped ===
null`, i.e. the vector modes really ran, so there really was a gate). 23.6 s.

**Its one honest limitation:** it needs the 34 MB bge-small model already on
disk, so it is `describe.skipIf(MODEL === null)`. Without a model there are no
vector modes; without vector modes there is no gate at all, and a green tick
under those conditions would be exactly the "benchmark that cannot fail" this
file exists to prevent. Downloading 34 MB inside `pnpm test` is not acceptable,
so the premise cannot be established by the test on a bare machine. Where the
model is absent, the documented one-line command is:

```
POTSHERD_EVALS_EMBED=1 pnpm evals -- --vector-weight 0     # must exit 1
```

The always-on pin is layer 1, which needs nothing from the machine at all.

---

## 8.8 — the honesty surfaces

`stack` grades potsherd **by exercise** and every competitor **by
documentation**. Until now that was disclosed only inside the per-row `claim`
column and in a footer under the recommendation — both true, both skippable. A
reader scans the header and the rows; a screenshot crops the footer. And at 60
columns the `claim` column is **dropped from the table entirely**, which left the
narrow rendering with no disclosure on screen at all.

### what changed

| file | what |
|---|---|
| `packages/core/src/stack.ts` | `claimLegend(verifiedOn?)` and `CLAIM_SOURCE`; `StackReport` gains `claimLegend` and `claimSource` so the terminal and `--json` cannot drift. |
| `packages/cli/src/commands/stack.ts` | the legend rendered, wrapped, directly above the table header — before any tool is named; carried in `--json`. |
| `docs/memory-stack.md` | the same disclosure as a blockquote **above** the table; the old paragraph below it reduced to a pointer. |
| `tests/stack.test.ts` | three tests: both halves present and the legend above the table; the legend survives 60 columns and `--ascii`; the docs page carries it above its table. |

### the legend, as it renders at 80 columns

```
  claim: potsherd's row was measured by running potsherd on this machine.
  every other row was read from that project's own documentation on 22 aug
  2026 and was never run here. sources and fetch dates: docs/memory-stack.md
```

Three lines at 80, four at 60. Per the ruling it wraps rather than shortening:
a shorter version of this sentence is a less true one.

### widths, counted in code points

`python3` over the captured renders in `/tmp/w4-evidence-u8Pn`:

```
stack-60--ascii.txt   max 60   over 0
stack-60.txt          max 60   over 0
stack-80--ascii.txt   max 79   over 0
stack-80.txt          max 79   over 0
```

`tests/stack.test.ts` also asserts `[...line].length <= width` (code points, not
utf-16 units) for every line at both widths and under `--ascii`.

### the test is not silently deletable

Mutation-checked: deleting the two render lines that push the legend turns 2 of
the 53 stack tests red. The "both halves" assertion is separate from the "it is
there" assertion on purpose — `expect(out).toContain('measured')` alone would
pass on a legend that printed only the flattering half.

### what was NOT done, deliberately

- The asymmetry was **not** levelled by grading potsherd from its docs too. It
  is the one tool on the list that is actually installed here; throwing that
  evidence away to make the table look even would be worse, not better.
- The phase file says *"link the fetch date to `research/competitors.md`"*.
  `research/competitors.md` lives in the **planning folder** and is deliberately
  not published — pointing a user's terminal at it would be a dangling
  reference. The legend links `docs/memory-stack.md`, which is in the repo, holds
  every source url with its fetch date, and is checked into the same commit as
  the table, so a reader can open the exact sources that produced the exact
  table. Flagged for the orchestrator.
- `README.md` untouched. Exact wording for the first-screen caption is in
  `phases/phase-8/registration-W4.txt` §1.
- `docs/screens/**` untouched. `make-screens.sh` was run and rewrote three
  timing digits (`265ms`→`277ms`, `12ms`→`13ms`, `11ms`→`12ms`) with no other
  diff; the files were reverted because they are reserved for the orchestrator.

---

## verification, in full

```
pnpm typecheck                                          Done (4 packages)
pnpm test                       Test Files 36 passed (36) · Tests 1445 passed (1445) · 176.0s
pnpm evals                                              exit 0
pnpm evals -- --vector-weight 0                         exit 1
POTSHERD_SCREENS_NO_MODEL=1 bash scripts/make-screens.sh
  ok  17 screens, widest line 80 characters, no forbidden strings,
      no unredacted credentials, no cut masks
python3 scripts/check-privacy.py
  privacy: 483 tracked text files swept, no real-corpus content,
           14 pinned known violations all at their expected counts.
```

Test count moved 1,434 → 1,445: +8 in `tests/evals-gate.test.ts`, +3 in
`tests/stack.test.ts`.

Every `potsherd` invocation for evidence ran with `--claude-dir` and
`--potsherd-dir` inside `/tmp/w4-evidence-u8Pn`. The eval runner builds its own
`mkdtemp` root from `evals/fixture/` and reads the cached embedding model
read-only. Nothing under `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi` or
`~/.potsherd/archive-manual-2026-08-21` was written.

## evidence

`/tmp/w4-evidence-u8Pn/`

```
evals-shipped.txt    evals-shipped.json     the release run, exit 0
evals-weight0.txt    evals-weight0.json     the regression, exit 1
stack-80.txt  stack-80--ascii.txt
stack-60.txt  stack-60--ascii.txt           the legend at both widths, both glyph sets
stack.json                                  claimLegend / claimSource in --json
```
