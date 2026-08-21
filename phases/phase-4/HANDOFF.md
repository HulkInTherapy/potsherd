# phase 4 — ask & graft · HANDOFF

**date:** 22 aug 2026 · **tests:** 1,033 green, 25 files · **`--version`:** 0.4.0 → tag `v0.5.0`

The two verbs nobody else has. Both shipped. **The ask gate passed and was earned; three
definition-of-done boxes did not, and are recorded below as failures rather than smoothed over.**

**15 verbs ship:** `audit rescue guard index ls find show card tag pin unpin link stats ask graft doctor`.

---

## the headline: the gate passed, and the two halves never met

```
potsherd ask evals · ask.jsonl · 10 gold · 3 decoys · k=6 · 33 cards, 120 vectors

plans/06 §ask evals · the three gates
(a) citations    18 lines ✓ 0 faults, 100% clean required
(b) coverage      8/10  ✓ >= 7/10
(c) refusals      3/3   ✓ refused === true and cli exit 2
    the set                 ✓ overlap as recorded  ✓ decoys still unanswerable
PASS — plans/06 phase 4 would accept this ask
```

Full output: `phases/phase-4/evidence-evals-ask.txt`.

**Why this number is worth trusting**, where phase 1's 10/10 was not: T4.0 wrote the ten gold
questions and three decoys **without reading the implementation**, and T4.1 wrote `ask` without
seeing the questions. Every gold answer was located by grep *before* its question was written;
every decoy was proven absent by grep. Max question/answer word overlap is **0.50** against a 0.60
flag bar — no question is a quotation of its own answer, which is exactly how phase 1's set faked
its score. Two golds (`g03`, `g10`) missed outright and the harness said so rather than rounding up.

The scorer proves itself on **12 hand-built `AskResult` objects, 11 of which must fail**, each
failing the gate it is named for. `npx tsx evals/ask-selftest.ts` — and CI now runs it, which
nothing did before.

---

## what shipped

| deliverable | state |
|---|---|
| `ask` — recall shortlist → parallel readers → synthesizer → **a code-level citation filter** | done |
| `graft` — token-budgeted brief, `[id8@seq]` citations, `--about`, `--clip`, `--no-model` | done |
| open threads — rule pass (no model) + batched model confirmation, advisory and labelled | done |
| `evals/ask.jsonl` + `evals/ask-run.ts` + `pnpm evals:ask`, exits non-zero on failure | done |
| T4.4 — `ask` as a library with an injectable `readerFn`, for phase 5's plugin | done |

### the citation filter, which is the whole claim

`answer` is assigned at exactly one place, as `sentences.map(s => s.text).join(' ')`. The renderer
builds prose from `r.sentences` and never from `r.answer`. The verifier attacked it five ways —
fabricated seq, fabricated quote, paraphrase-not-quote, dangling evidence index, unknown session —
and **all five were dropped, with the control passing.** Its verdict: *"I found no path by which
rejected text reaches the user."*

A quote survives only if it **occurs byte-for-byte** in the cited `(sessionId, seq)`. Folding is
used to *locate* the passage; the span is then sliced out of the transcript's own bytes, so a model
that re-cased or re-wrapped its quote has that undone rather than forgiven.

---

## measured, on this machine

| | measured | target | verdict |
|---|---|---|---|
| `ask` wall, k=6 | 40–183 s across 15 runs; **p50 ≈ 100–116 s** | < 20 s | **MISSED ~5x, structural** |
| `ask` spend, k=6 | **$0.037–$0.194**, all `est.` api-equivalent | < $0.05 | missed on the dear runs |
| `graft` wall | 1m 01s – 2m 13s, one call | — | recorded |
| `graft` budget | 137/150 · 222/1200 · 397/1200 · 487/1200 | ≤ `--budget` | **hard ceiling holds** |
| `graft` citations | 3/3 · 5/5 · 7/7 · 10/10 · 13/13 resolve | 100% | met |
| open-thread rule pass | 26 candidates from 45 cards in 69 ms; model confirmed **1 of 8** | — | see below |

**The `ask` miss is structural, not tuning.** One real haiku-class call through the agent SDK is
60–160 s, and `ask` is six readers plus a synthesizer. `03 §12` was written before any such call had
been measured; it is corrected there with the measurement and logged in `04-DECISIONS.md`. **`k` was
not narrowed to hit the target.**

**Every `$` and every token count on the subscription path is `est.`** — the SDK reports a constant
`input_tokens: 10`, which `llm.ts` discards in favour of its own chars/3.6 estimate and labels.

### open threads: the honest number

T4.2 built the rule pass, then measured it against a control and reported the result that damages
its own feature: **8 of 8 candidates were genuinely absent from project B, but only 1–2 of 8 were
genuinely worth raising.** Two failure kinds — unrelated projects joined by a generic filename
(`HANDOFF.md`), and a decision local to A, where one candidate was *the decision that created
project B*, reported as never having reached it.

`MENTION_COSINE` moved 0.30 → 0.35 from 194 hand-read control pairs whose measured maximum was
0.3223, with `MEASURED_NONMATCH_MAX` exported and a test asserting the inequality. But the honest
limit is stated too: **the positive side is n = 0.** Synthetic paraphrases score 0.20–0.57 and
overlap the measured negatives outright, so *no threshold on this statistic separates "B said this"
from "B used these words."* `MIN_ANCHOR_TOKENS` and the model pass are what make open threads safe,
not the cosine.

---

## the definition of done, rated honestly

| box | verdict |
|---|---|
| `06` standard met, ask evals green | **PASS** — evals green; the two `06` sub-boxes that failed are now fixed |
| ask p50 < 20 s and < $0.05 api path, k=6 | **FAIL, recorded with its measurement and reason** (`03 §12` corrected) |
| the screenshot: one `ask` with an open-thread catch in `docs/screens/` | **OPEN** — assigned to T4.8; `05` requires a *real* catch and one may not be honestly producible |
| `ask` conforms to `05` and legible whole at 80×24 | **FAIL** — 80 columns is clean; **25–33 rows against 24.** `ANSWER_MAX_WORDS` is now enforced in code (167→129 words), but the EVIDENCE block is 4–8 entries and the cap has no authority over it. Half the overflow was never the answer's |
| all tests pass; CI green macos + ubuntu | **PASS locally** (1,033). CI: verified config, not observed |
| verification commands run and pasted into the handoff | **PASS** — this file |
| `doctor` 0 fatal parse errors, unknown types with counts | **PASS** on the real corpus, 1,508 exchanges: `fatal parse errors 0`, 10 unknown types listed |
| no write outside `~/.potsherd` (`doctor --privacy`) | **PASS** — live receipt discloses `./.potsherd/graft-<id8>.md` and names `ask` + `graft`; the published copy is now guarded by CI |
| every new verb has `--json` and `--help` with one example | **PASS** — both carry 3–5 examples; both `--json` match the pinned interfaces |
| no number in a readme/doc/screenshot not produced by a command | **PARTIAL** — the privacy receipt is fixed and guarded; `docs/screens/04-doctor.txt` still publishes `0.1.0` / `schema v4` and is assigned to T4.8 |
| `03 §12` targets met or the miss recorded | **PASS** — recorded with measurements |

---

## verification: 13 defects, continuing the run 12 / 8 / 9 / 7 / **13**

The verifier authored none of this, did not sub-delegate, and carried command output for every
finding. It also **corrected itself twice unprompted** — withdrawing a `doctor` 80-column overflow
claim on realising `awk` was counting UTF-8 bytes rather than display columns, and declining to rate
the three defects already assigned elsewhere.

**The critical one.** `graft <session>` with no `--about` **and** no card sent the model a prompt
containing **no session content at all** — `buildPrompt` gated transcript text behind
`if (src.slice.length)` and `slice` was only ever populated by `--about`. The model could only
refuse, and **that refusal was written to disk as the user's brief**, under a header promising every
claim carries a citation. The plan's own verification command `potsherd graft "instagram client"
--clip` takes that path, and `--clip` would have put the refusal on the clipboard. Confirmed in
source by the orchestrator before dispatch.

Fixed twice over: a recency slice so a cardless session yields a real brief (7/7 citations
resolving, measured against the pure guard which produced `- hello [@1]`), and `hasMaterial()` as a
backstop that throws rather than build an empty prompt.

### everything else found and fixed

| # | defect | found by | state |
|---|---|---|---|
| 1 | `graft` wrote the model's refusal to disk as the brief | verifier | fixed, T4.7a |
| 2 | the **published** privacy receipt omitted the graft write path and still said "later phases add ask and graft" — while the live one was correct. **CI never regenerated `docs/screens/`** | verifier | fixed + **a CI step that diffs published against live** |
| 3 | `ask` printed open threads the model had **rejected**, and a note reading "unconfirmed and not shown" while showing it | verifier | fixed (its one ≤5-line fix); test added, T4.7b |
| 4 | `Budget.admit` ran before a call and `record` after, so at concurrency 6 all six readers cleared the gate against $0 — **shipping in `card --all` since v0.3.0** | T4.1, in a file it did not own | fixed, T4.5 |
| 5 | `graft`'s "cited or dropped" covered bullet lines only; a prose claim with a *fabricated* citation kept the claim and silently deleted the citation | verifier | fixed, T4.7a |
| 6 | `ANSWER_MAX_WORDS` was prompt-only, never enforced in code | verifier | fixed, T4.7b |
| 7 | `potsherd --version` printed `0.2.0` at tag `v0.4.0` | verifier | fixed, single-sourced with a test |
| 8 | harness boilerplate (`<local-command-caveat>` and 12 more markers) reached the brief as a cited claim — injection-adjacent on the one verb designed to be pasted into a live agent | verifier | fixed, T4.7a |
| 9 | `[id8@24, 158]` — a citation displayed inside the group, never checked, absent from `citations` | verifier | fixed, T4.7a |
| 10 | an 8-digit seq truncated into a fabricated one (`@12345678` → `seq 1234567`) | verifier | fixed, T4.7a |
| 11 | a ghost `graft` brief said `· 241 exchanges ·` three lines under "prompts only" — **`03 §8`'s own wording** | orchestrator, by eye | fixed, T4.5; `03 §8` corrected |
| 12 | `citations 0/0 · "distinct, and all resolve"` read green on a brief with no citations | verifier | fixed, T4.7a |
| 13 | eval gate (a) reported 100% on **zero** evidence lines | verifier | fixed, `lines > 0` required |
| 14 | `evals/ask-selftest.ts` was run by **nothing** — not `pnpm test`, not CI | T4.7b | fixed, CI step added |
| 15 | `unpin` was in neither `MODEL_CALL_VERBS` nor `OFFLINE_VERBS`, so `doctor --privacy` answered by omission | verifier | fixed + a test that both lists cover every command |
| 16 | `render/ask.ts` printed an open thread with **no seq**, so "cited or dropped" held through the rule pass and stopped at the render | T4.5, reported not fixed | fixed by orchestrator |
| 17 | `--about <topic>` matching nothing still wrote "about **topic**" into the header the receiving agent reads | T4.7a, reported not fixed | fixed by orchestrator |
| 18 | `OpenThreadCandidate.evidenceSeq` lossy against `CardClaim.evidence_seq: number[]` | T4.2, reported not changed mid-wave | fixed, T4.5 |

**Two workers found bugs they had introduced themselves, by measuring on the real corpus rather
than trusting a unit test**: T4.7a's boilerplate strip left `you:` standing over nothing, emitting
`- you: [id8@1]` — an empty bullet with a citation on it; T4.7b's first cut of the word cap aliased
an array and silently produced an **empty ANSWER** on three real runs.

---

## what phase 5 must know

1. **`ask` is already a library.** `ask(db, question, opts)` returns `AskResult`, and
   `AskOptions.readerFn` lets the plugin run the reader fan-out with Claude Code's **native Agent
   tool** instead of the SDK — zero extra cost, and it sidesteps the 60–160 s per-call wall.
   Interface in `phases/phase-4/registration-T4.1.txt`.
2. **`ask` at k=6 takes ~100 s.** Any surface that calls it needs progress output, not a spinner.
   Inside Claude Code, `readerFn` is the way around this.
3. `graft` writes `./.potsherd/graft-<id8>.md` in the **current working directory** — the one place
   potsherd writes outside `~/.potsherd`. The privacy receipt discloses it and **CI now fails if the
   published receipt drifts from the live one.** Any new write path must go through both.
4. `MODEL_CALL_VERBS` is `['card', 'ask', 'graft']` and the guard now follows a command's core
   imports through the barrel — a verb that reaches a model *indirectly* is caught. Add a verb that
   calls a model and this test will tell you.
5. Schema is still at **8**. No migration this phase.

## open items carried forward

| item | picked up by |
|---|---|
| `ask` p50 ~100 s vs the 20 s target — structural, `03 §12` corrected | 7 re-check |
| `ask` output is 25–33 rows against `05`'s 24 — the EVIDENCE block, not the answer | 7 |
| the open-thread screenshot; a genuine catch may not be honestly producible | T4.8, then 7 |
| `docs/screens/04-doctor.txt` publishes `potsherd 0.1.0` and `schema v4 of v4` | T4.8 |
| `scripts/make-screens.sh` fails its own assertion: `13-find-redacted.txt` elides mid-mask, `09-find.txt` reshuffles on bm25 ties | T4.8, else 7 |
| `--max-usd` is a ceiling to within **one call's actual cost** — an estimate that is too low is not catchable by any pre-call gate | 7 |
| open-thread precision measured at **n = 8**; too small to generalise, and the cosine's positive side is n = 0 | 7 |
| `evals/ask-selftest.ts` still has no case for `quote-empty` or `answer-missing` | 7 |
| the README is stale by three phases (status line and roadmap corrected; the rest is phase 7's rewrite) | 7 |
| `Fulcrum` / `meghbrain` — the user's own project names — remain as examples in `--help` and fixtures | 7 |
| the fusion gate still fails: hybrid 22/25 ties vec-only (inherited from phase 3) | 7 |
