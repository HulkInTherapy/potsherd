# FIX-C — the model door stops giving orders the agent cannot carry out

Branch `work/FIX-C`, cut from `339df63`.

The phase-10 gate has been scored 4 → 6 → 7 → 7. Retrieval and reliability pass; overall and agent
ergonomics are stuck at 7. Every remaining item is one failure wearing three costumes: **an
instruction aimed at an agent that the agent cannot follow.** `potsherd_recall`'s caller has three
MCP tools and no shell.

---

## 0. A DISCREPANCY, FIRST

**`phases/phase-10/VERIFICATION-3.md` does not exist** — not in the worktree, and not anywhere in
git history (`git log --all --diff-filter=A -- '*VERIFICATION-3*'` returns nothing; the phase-10
directory holds `VERIFICATION.md` and `VERIFICATION-2.md` only). `VERIFICATION-2.md` was written
against `9c663e9`, and `339df63` is the commit that answers it.

I did not have the third verifier's §(d). The task description quotes C1 and C3 in full — including
the source of `capabilityLine`, the `find "choosing which hues…"` measurement, and the 5-of-18
count — so the work was fully specified without it, and **every claim in it that I could check, I
checked and confirmed** (§1). Nothing below rests on the missing file.

---

## 1. THE CLAIMS, CHECKED BEFORE FIXING

All three verifier claims reproduce. None is a false alarm.

| claim | verdict | evidence |
|---|---|---|
| `capabilityLine`'s `!available` branch carries a shell command | **confirmed** | real server at 0 vectors returned `… (no embeddings in the index — run  potsherd index --embed)` |
| the repo's own comments say that string is false | **confirmed** | `render/find.ts:229` and `render/stats.ts:158` both record it; `tests/index.test.ts:636` already asserts the *human* path suppresses it — so the string survived only on the path the agent reads |
| the `used` branch prints a bare numerator | **confirmed** | real server returned `keyword + semantic search · 5 vectors` |
| `scope.project` offers a `jq` pipeline | **confirmed** | real server returned `try:  potsherd ls --json \| jq -r ".sessions[].project" \| sort -u` |
| the project list is silently truncated | **confirmed** | `filters.ts` `ambiguous()` did `candidates.slice(0, 5)` — this is the 5-of-18 |

One thing the verifier did not name, which the probe surfaced and which is the worst of the set:
at 0 vectors the **no-match** reply said `no match. The archive does not contain this` **beside**
`SEMANTIC SEARCH UNAVAILABLE — … run potsherd index --embed`. A flat "the archive does not contain
this", asserted while the semantic half never ran, and then a remedy the reader cannot execute.
That is the compound failure, and it is what C2 fixes.

---

## 2. WHAT CHANGED

### C1 — `capabilityLine`, all three branches (`packages/mcp/src/tools/recall.ts`)

The denominator is not on `VectorState`. It is now read from `vecStatus(db, root).report` — the
same object `doctor`, `index`, `find` and `stats` render — on the connection the search just ran
on. **Wired, not recomputed**, which was the point of the instruction.

- `used` → `keyword + semantic search (N of M embedded)`.
- `!available` **and the report says `warming` or `pending`** → `keyword search only — semantic
  search is warming (N of M embedded)`. `pending` is 0-embedded-with-work-queued and `warming` is
  partway through; both are transient, and `warming` is what `doctor-line.ts` already calls them.
- genuinely unavailable → lowercase `semantic search unavailable — results are keyword-only`,
  reason preserved. A real failure is still reported as one; there is a test pinning this so the
  warming wording cannot swallow it.
- `report` is **optional**, and when it is absent no count is printed at all — not a bare numerator.
  Silence beats a number that cannot be interpreted.

The shell verb is fixed **at its source**, `packages/core/src/recall.ts:1467`, so it cannot reach
any surface: `'no embeddings in the index — run  potsherd index --embed'` → `'no embeddings in the
index yet'`. No test asserted its presence; two already asserted its absence downstream.

### C2 — the honest empty says which half produced it (`packages/mcp/src/tools/recall.ts`)

`noMatch` now appends `. Only keyword search ran; the semantic half did not` when
`result.vectors.used` is false. "The archive does not contain this" is a far stronger claim when
both halves ran than when only bm25 did, and the verifier sized the gap: the same query answers 1
session with vectors on and 0 with them off; evals put bm25-only at 40/60 against hybrid's 51/60.

### C3 — `scope.project` (`packages/cli/src/filters.ts`)

The error now returns **the answer instead of a command that would produce the answer**:
`no indexed project matches "…". The index holds N: <names>`. A new `nameList()` caps the list and
**discloses the tail** (`, and K more`), so eighteen matches can never again report as five and look
complete. `ambiguous()` shares the helper and loses its `potsherd ls --project` hint for the same
reason. This serves the terminal reader too — it saves them the round trip.

---

## 3. THE ARTIFACT — the real server, `sh plugins/claude-code/bin/potsherd-mcp`

Driven over stdio with `initialize` + `notifications/initialized` + `tools/list` + a real
`potsherd_recall` call, `--potsherd-dir "$(mktemp -d)"`, `HOME` relocated to a temp dir.
`tools/list` returns exactly `potsherd_recall, potsherd_read, potsherd_graft`.

### at 0 vectors — the state every fresh install is in

| | `capability` |
|---|---|
| **before** (query hits) | `SEMANTIC SEARCH UNAVAILABLE — results are keyword-only (the words matched; semantic search adds to this as vectors land)` |
| **after** | `keyword search only — semantic search is warming (0 of 5 embedded)` |
| **before** (no match) | `SEMANTIC SEARCH UNAVAILABLE — results are keyword-only (no embeddings in the index — run  potsherd index --embed)` |
| **after** | `keyword search only — semantic search is warming (0 of 5 embedded)` |

The before-line is also self-contradictory: *UNAVAILABLE* … *adds to this as vectors land*.

`note`, at 0 vectors, no match:

- **before** — `no match. The archive does not contain this. Say so — do not widen into a guess…`
- **after** — `no match. The archive does not contain this. Only keyword search ran; the semantic half did not. Say so — do not widen into a guess…`

### with vectors — partial (2 of 5) and complete (5 of 5)

| state | | `capability` |
|---|---|---|
| partial, vector half contributed | **before** | `keyword + semantic search · 2 vectors` |
| | **after** | `keyword + semantic search (2 of 5 embedded)` |
| partial, bm25 sufficed | **after** | `keyword search only — semantic search is warming (2 of 5 embedded)` |
| complete (5 of 5), bm25 sufficed | **after** | `keyword search answered this one (the words matched, so the vector half was not needed)` |

`· 2 vectors` is indistinguishable from a *finished* index of two exchanges. `2 of 5 embedded` is
not. The last row is the `ready` phase falling through to the untouched third branch — proof the
warming wording does not leak into a complete index.

### C3, through the same server

- **before** — `no indexed project matches "no-such-project-4b1"` / `try:  potsherd ls --json | jq -r ".sessions[].project" | sort -u`
- **after** — `no indexed project matches "no-such-project-4b1". The index holds 2: <names elided>`

No `jq`, no pipe, and the count is stated.

---

## 4. TESTS — red first, every one

Eight tests appended to `tests/mcp.test.ts` (the existing MCP file, extended as instructed).
Run before the fix: **7 failed, 1 passed**. The one that passed is deliberate — it is the guard
asserting a genuinely unavailable runtime *still* says unavailable, and it had to stay green through
the change. After: **8 passed**.

Two are pure-unit on `capabilityLine` (the `used` denominator; the no-report silence case); the rest
drive the envelope at 0 vectors, which is the branch that matters.

---

## 5. NUMBERS

| | |
|---|---|
| source files changed | 3 (`core/recall.ts`, `cli/filters.ts`, `mcp/tools/recall.ts`) |
| source diff | +78 / −15 |
| **effective code lines changed** (comments and blanks excluded) | **37** |
| test diff | +102 / −1 |
| `pnpm test` | `Test Files 53 passed (53)` / `Tests 1883 passed (1883)` — was 1,875, +8 new, 0 regressions |
| `pnpm typecheck` | **4 of 4** packages `Done` |
| `python3 scripts/check-privacy.py` | **EXIT CODE 0** *(output withheld)* |

The verifier sized this at "about eight lines". The executable core is close to that — the three
branch bodies and the `vecStatus` wiring. The remainder is C3's `nameList` helper, the C2 clause,
and comments recording *why* each string changed, which is this repo's house style at every
comparable site.

---

## 6. WHAT I COULD NOT DO

1. **Read `VERIFICATION-3.md`.** It does not exist (§0).
2. **Observe a naturally partial index.** The test fixture holds 5 exchanges, so a real embed run
   reaches 5 of 5 in one pass. The 2-of-5 row was produced by clearing `embedding_version` on three
   rows directly — a real warming state in the database, but reached by hand rather than by
   interrupting an embedder. The 19.6%-of-4,725 case the verifier saw is the same code path.
3. **Re-run `pnpm evals`.** `tests/evals-gate.test.ts` runs it inside the suite and passes; I did
   not run it standalone.
4. The model cache was copied from `~/.potsherd/models` (read, never written) into the temp
   `--potsherd-dir`, and indexing ran under `POTSHERD_OFFLINE=1`. **No embedder survived: `ps` count 0.**
