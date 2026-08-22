# potsherd — final report

**v1.1.0, 23 August 2026.** Nine phases, from an empty directory to a published
release. This file is the one place that says what exists, how to check each
claim in it yourself in under five minutes, and everything that is still open.

Everything below is measured. Where a number could not be measured it says so;
where a measurement missed its target it says that too, with the target.

---

## 1. what this is

Claude Code deletes your session transcripts after 30 days and does not tell
you. On the machine this was built on, **299 of 330 sessions were already gone,
taking 2,971 prompts and 33 whole projects with them.**

potsherd archives what survives, rebuilds the deleted sessions as "ghosts" from
`~/.claude/history.jsonl`, indexes all of it, and lets you search it, ask it
questions, and carry one past session into the agent you are talking to now.

**The claim is not "a search tool". The claim is that its output can be
checked.** Every card decision cites the exchanges that support it and is
dropped if they do not resolve. Every number it prints is measured or labelled
`est.` `potsherd audit --verify` prints standalone Python that recomputes its
own headline numbers, so nobody has to trust potsherd to check potsherd.

## 2. what exists

**21 verbs:** `audit rescue guard index ls find show card tag pin unpin link
stats ask graft setup export stack ignore unignore doctor` (+ `help`).

| surface | what it is |
|---|---|
| CLI | one binary, `--json` on every verb, an example in every `--help` |
| Claude Code plugin | `/potsherd <verb>`, a model-invocable recall skill, a haiku-class agent, two hooks |
| MCP server | six tools, stdio; works in Cursor, Codex, Gemini CLI, opencode, Copilot CLI, pi |
| bridges | claude-mem, agentmemory and `CLAUDE.md`, read-only, federated into `find --with` |
| adapters | Claude Code, Codex, Cursor, pi — verified. Gemini, opencode, Copilot — **documentation only** |

**1,532 tests, 38 files.** Green on macOS and Ubuntu × Node 22 and 24, and green
again with `POTSHERD_SQLITE=node` — the whole suite on Node's own SQLite, which
is what makes a plugin install work with nothing else on the machine.

**The privacy guard** (`python3 scripts/check-privacy.py`) sweeps 505 tracked
files and is a ratchet that only shrinks: **34 pinned known violations at the
start of phase 7, 14 at the start of phase 8, 0 now.** Phase 8 also inverted its
id rule from a blocklist of ids somebody had noticed into an **inventory**: every
id-shaped token in tracked text and tracked file names is accounted for against a
source this repository can derive, and anything left over is a finding, pinned so
it can only shrink. 177 tokens, 148 accounted for, 29 unaccounted and pinned.
25 probes in `--selftest`.

## 3. install, on a machine that has never seen this

```bash
git clone https://github.com/HulkInTherapy/potsherd
cd potsherd
sh plugins/claude-code/bin/potsherd audit
```

That is the whole thing. No `pnpm install`, no build, no native module — the
plugin carries its own bundled CLI and MCP server, and Node's own SQLite covers
the database. **Measured in a fresh Debian container: `audit` in 122 ms.**

In Claude Code:

```
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd@potsherd
/potsherd audit
```

From a checkout, for development:

```bash
pnpm install && pnpm build && pnpm test
```

From a tarball, for a global install (**17 MB, ~1.6 s**):

```bash
cd packages/cli && npm pack
npm install -g ./potsherd-1.1.0.tgz
```

`npm view potsherd` is a 404 until phase 9's runbook runs. Rule 7 was re-scoped
on 22 August 2026 and the orchestrator publishes; `npm login` is the one act
that is still a person's. The commands are
in [`docs/release/npm.md`](docs/release/npm.md).

## 4. how to check each shareable moment yourself, in five minutes

All five run against the **synthetic demo corpus**, which reproduces the
reference machine's measured counts with none of its content. Build it first:

```bash
export DEMO=$(mktemp -d)
node scripts/make-demo-corpus.mjs "$DEMO/.claude"
P="node packages/cli/bin/potsherd.js --claude-dir $DEMO/.claude --potsherd-dir $DEMO/.potsherd"
```

| # | moment | command | what to look for |
|---|---|---|---|
| 1 | the shock | `$P audit` | 330 ever · 31 on disk · 299 deleted · 2,971 prompts lost. Under a second. |
| 2 | the relief | `$P rescue --yes` | 278 files copied, 299 ghosts rebuilt, 2,971 prompts recovered |
| 3 | before/after | `ls $DEMO/.claude/projects/*` then `$P index --full --no-embed && $P ls` | uuids, then titles — and the 299 are back |
| 4 | the catch | `$P card --all --yes` then `$P ask "what did we decide about prepared statements behind the pooler?"` | ANSWER / EVIDENCE / OPEN THREADS in 24 rows, every `[n]` resolving. **Needs a model; ~6 min of carding first.** |
| 5 | the magic | `$P graft 9c4d2f18 --about pgbouncer --no-model` | a brief under its token budget, every claim `[id8@seq]`, a `source:` line |

Two more worth a minute:

```bash
$P doctor --privacy      # every path read and written, and what leaves the machine
$P audit --verify --json | jq -r .snippet | sh    # python that recomputes the four numbers
```

The last one is the honesty contract in a single command: it does not use
potsherd at all.

And without a corpus at all:

```bash
python3 scripts/check-privacy.py --selftest    # the guard proving it can fail
pnpm test                                       # 1,532
POTSHERD_SQLITE=node pnpm test                  # the same, on Node's own sqlite
```

## 5. what was measured

| | measured | target | verdict |
|---|---|---|---|
| audit, 329 MB | 0.23 s | < 2 s | met |
| archive | 278 files, byte-exact, 0600 | byte-exact | met |
| index, no embeddings | 8.7 s for 236 transcripts | — | met |
| index, with embeddings | 4m 11s | 3 min | **missed** |
| `find` p50 | 8–12 ms local | < 150 ms | met |
| `find` p95 | 201 ms on the reference corpus | — | recorded |
| recall@5, 25 queries | bm25 11 · vectors 22 · **hybrid 22** | hybrid > both | **missed, red on purpose** |
| recall@1, same 25 | bm25 9 · vectors 6 · **hybrid 11** | — | fusion nearly doubles vectors-only |
| `find --with`, 3 bridges, worst case | 5,005 ms concurrent (6,525 in series) | — | recorded; `03 §12`'s target is the local query |
| cards, 35 sessions | 225 calls, 55m 25s, $12.93 equivalent, **$0 charged** | 15 min / $2 | **missed** |
| card citations | 374/374 resolve | 100% | met |
| `ask` p50, k=6 | ~100 s (40–183 s over 15 runs) | 20 s | **missed, structural** |
| `ask` block height | **24 rows** | 24 | met (was 25–33) |
| `ask` citation gate | 18 lines, 0 faults | 100% | met |
| `ask` coverage | 8/10 | ≥ 7/10 | met |
| `ask` refusals | 3/3 | 3/3 | met |
| `graft` budget | 137/150 · 222/1200 · 397/1200 · 487/1200 | ≤ budget | met |
| `graft` citations | 3/3 · 5/5 · 7/7 · 10/10 · 13/13 | 100% | met |
| plugin `SessionStart` | 6.5–10.5 ms hook time, 128–146 ms total | < 1 s | met |
| fresh Debian container, node 24, clone only | audit 122 ms, index 397 ms | < 60 s to first audit | met |
| fresh Debian container, node 22, clone only | audit 146 ms, index 420 ms | < 60 s | met |
| fresh macOS `$HOME`, every override cleared | audit 183 ms, whole `audit→find` walk 1.86 s | — | **not a target.** That `$HOME` holds a synthetic demo corpus and this row exists to show the walk is *offline* — no model directory is created — not to clear a time budget. A walk over a small corpus cannot miss 60 s, so scoring it `met` was a gate that could not fail. The timed walk that does carry a target is the reference-scale one: **12.3 s median against 30 s** |
| npm tarball into an empty project | 17 MB installed, `audit` runs | — | met |
| tarball install | 17 MB; 1.6 s on one run and 2.9 s on another | — | recorded (was 764 MB) |

The three misses are recorded rather than hidden, and in each case the *target*
was corrected in the plan rather than the measurement being reshaped to fit it.
`ask`'s is structural: one haiku-class call through the agent SDK is 60–160 s
and `ask` is six of them plus a synthesizer. `k` was **not** narrowed to make
the number look better.

## 6. everything still open

### it fails honestly, and that is the point

| # | item | why it is still open |
|---|---|---|
| 1 | **the fusion gate fails, and the reason is more interesting than the failure.** Re-run at v1.0.0: bm25-only 11/25, vectors-only **22/25**, hybrid **22/25** at recall@5 — a tie, and the gate requires hybrid to *beat* both, so `pnpm evals` exits 1. But at **recall@1** — which is the number a user actually experiences, because it is whether the answer is the first row — vectors-only is **6/25** and hybrid is **11/25**. Fusion nearly doubles it. The gate measures the metric that saturates and ignores the one that does not. | Two ways to close it and neither is honest. Raising the vector weight to 2.0 reaches 23/25 (the phase-3 sweep measured that), which is tuning a constant against the 25 queries that score it — the overfitting phase 3 deliberately refused, and 1.5 is recorded there as a stopping rule rather than an argmax. Adding recall@1 to the gate would be rewriting the gate around the result. **So it stays red.** `plans/06` says a gate that cannot fail is worth nothing; a gate that fails and is then moved is worth less. |
| 2 | `ask` p50 ~100 s | Structural. See above. |
| 3 | the card estimator is ~2× optimistic, one-directionally | It self-corrects from recorded runs, and the receipt prints the quote beside the outcome, so the bias is visible rather than hidden. |
| 4 | one ghost summary of ten oversteps | Read by hand by the phase-2 verifier. 9 of 10 clean. Recorded rather than smoothed. |

### never met real data

| # | item | why |
|---|---|---|
| 5 | **gemini, opencode and copilot adapters are `unverified — documentation only`** | There are no gemini, opencode or copilot transcripts on this machine. The Copilot CLI *has run here* and has still written no `session-state/`. Running them against invented data would make the label false rather than true. The label is theirs to keep. |
| 6 | **the Codex plugin is inferred from documentation** | `codex` is not installed here. |
| 7 | four of `setup`'s seven clients are documentation-only | Carried in `ClientSpec.verified`, printed as `unverified` on the consent screen, and asserted by a test. |
| 8 | `stack` grades potsherd by exercise and every competitor by documentation | Disclosed in the `claim` column and in the terminal, with the count and the fetch date. It is still a thumb on the scale. |

### not done, and small

| # | item |
|---|---|
| 9 | version 1.1.0, the changelog, three fresh-machine proofs, `npm publish`, the GitHub release and one upstream comment — run from `docs/release/GO-LIVE.md`. **The marketplace listing is an authenticated form on a person's account and is not submitted by the agent** |
| 10 | the upstream PR to obra/episodic-memory — prepared, unsubmitted, and **`#128` is already open and overlaps it** |
| 11 | **closed in phase 8 (T8.A).** All fourteen were phase-0..4 evidence and prose across nine files; **none was a forbidden-string list** — those three are `ALLOW` entries, not `DEBT`, and an earlier version of this row said otherwise, which is where phase 8's own acceptance criterion got its wrong "3 pins". Five pasted command outputs were re-run against the demo corpus; six prose and code records had the identity substituted with a visible note. Every one was confirmed by the guard as *"pinned at N, now clean"* before its line was deleted. `DEBT` is empty |
| 12 | `evals/ask-selftest.ts` has no case for `quote-empty` or `answer-missing` |
| 13 | full index with embeddings is 4m 11s; `--no-embed` at 8.7 s is the shippable path |
| 14 | a real macOS *user account* was never created — a clean `$HOME` with every override cleared was, and `doctor --privacy` was grepped to prove it |

## 7. what this project learned, in four sentences

**A verifier that did not write the code finds something every single time.**
Twelve, eight, nine, seven, thirteen, fifteen, fourteen. The run has never
fallen, and the worst defects in it were the orchestrator's own, at integration,
and every one of them shipped green.

**Tests catch regressions. They do not catch a number that is confidently
wrong, a string that has quietly become false, or a benchmark that cannot
fail.** Only reading the output like a suspicious human catches those.

**A test whose premise is the environment will eventually assert the opposite of
what it means.** Seven instances across four phases, including two written in
this final phase — one of which reported that a fallback worked while never
once loading it.

**When a guard refuses something you are certain about, the guard is the one
with the evidence.** Every single time.

---

*Built on [episodic-memory](https://github.com/obra/episodic-memory) by Jesse
Vincent (MIT). Redaction rules ported from gitleaks and secretlint. See
[NOTICE](NOTICE).*
