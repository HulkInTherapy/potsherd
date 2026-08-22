# phase 6 — ecosystem · HANDOFF

**date:** 22 aug 2026 · **tests:** 1,354 green, 33 files · tag `v0.7.0`

potsherd now reads **every** harness in `03 §2`, federates three other memory tools read-only,
exports to markdown, and has a verb whose job is to say **which two of the four failures it loses**.

**20 verbs.** New this phase: `export`, `stack`, and `link --suggest`.

## what shipped

| deliverable | state |
|---|---|
| gemini, opencode, copilot adapters | done — **all three written from documentation**, see below |
| claude-mem, agentmemory, notes bridges; `find --with` | done, read-only, degrade with the tool absent |
| `potsherd export --to markdown\|agentmemory\|hindsight` | markdown + agentmemory done; **hindsight refuses and says why** |
| `potsherd stack` + `docs/memory-stack.md` | done |
| `link --suggest` | done — proposes, never writes, and prints its own precision |

### the three adapters are unverified, by construction

**None of gemini, opencode or copilot has real transcripts on this machine.** All three are written
from `research/formats.md`'s five-line **unmeasured** sections and are labelled
`unverified — documentation only` in the file header, the `doctor` line, the `doctor` note, the
`adapterSpecs()` comment, **and now `doctor --json` as a boolean** — the verifier found the label
never reached the machine surface, and vanished entirely when a tool was absent.

`doctor` distinguishes **empty / absent / unsupported**, because those are different facts about a
user's machine. The sharpest datum: **the Copilot CLI has run here** (logs dated 2026-08) and has
still written **no `session-state/`** — "installed and used" does not imply a transcript exists.

`03 §10`'s discover-the-schema-at-runtime rule is now **enforceable rather than promised**:
opencode's two committed fixtures share **no column name at all**, so a hard-coded schema cannot
pass the suite.

### `stack` says what potsherd loses

Potsherd scores **`no` on two of the four failures** — context rot (not its reach) and cold start
(refused on purpose; that lane is claude-mem's and CLAUDE.md is free and already on). Five other
tools beat it on that row. `tests/stack.test.ts` asserts `POTSHERD.coverage === ['no','no','yes','yes']`,
so turning the table into marketing means deliberately deleting three assertions.

**Five of its eight rows were read from documentation and never exercised**, and the terminal prints
that count and the fetch date unconditionally. The verifier's fair criticism stands and is recorded:
potsherd's row is graded by exercise while every competitor's is graded by documentation.

## measured

| | measured |
|---|---|
| `find --with`, three bridges, worst case | **6,525 ms in series → 5,005 ms concurrent** (the sum of the ceilings became the maximum) |
| plain `find` | 8–12 ms — `03 §12`'s p50 target is about the local query, and the comment now says so |
| `link --suggest` | 5 raised of 20 candidates over 45 cards; **2 worth accepting**, consistent with phase 4's measured 1–2 of 8 |

## verification: 14 defects. The run is 12 · 8 · 9 · 7 · 13 · 15 · **14**

**The headline was mine.** *"Phase 6 shipped four tasks and integrated two."* `registration-T6.4.txt`
was never applied, so `stack` and `link --suggest` were **45 tests and a 589-line module unreachable
from the command line**. The suite stayed green because `tests/stack.test.ts` calls `render()`
directly and `tests/cli.test.ts`'s *"every verb has `--help`"* passed **precisely because `stack` was
not a verb.**

Three findings worth carrying:

1. **The model-reach guard flagged `link`, and was right.** Fixed by splitting `confirmOpenThreads`
   out so `open-threads.ts` is pure — `link` stops being flagged *because it genuinely cannot reach
   a model.* No allowlist, no skip.
2. **`doctor --privacy`'s "open no socket at all" was false** for `export` and `find`, which
   federate. Third time this receipt has published something false. The sentence was made true
   **first**, then the screen and README regenerated in the same commit.
3. **The guard's workspace map had grown a hole once per phase**, so it is now derived from
   `pnpm-workspace.yaml` rather than hand-written, and it walks relative cross-package imports.

And a fifteenth: **the orchestrator pasted a live-corpus session id** out of a registration file into
`commands/link.ts`, so `check-privacy.py` was already red on the WIP branch. Registration files are
worker prose — **run the guard after applying one.**

## what phase 7 must know

1. **A marketplace install still does not work** (`dist/` gitignored, npm package unpublished). This
   is the install story for everyone who is not us, and it is phase 7's biggest single item.
2. **Six plan claims about third-party tools have proved false** across two phases: `rescue
   --background`, `index --card`, a `brief` verb, `codex features enable plugin_hooks`,
   `~/.agentmemory`, and claude-mem's `observations_fts`. **Verify before documenting.**
3. `03 §9`'s CLI list still names `mcp`; `03 §11`'s write list is stale in the plan though correct in
   the product and CI-guarded.
4. The three new adapters have **never met real data**. That label is theirs to keep until someone
   runs them on real transcripts.

## open items

| item | picked up by |
|---|---|
| marketplace install non-functional; repair specified, not implemented | 7 |
| gemini/opencode/copilot unverified against real data | 7 or later |
| `stack` grades potsherd by exercise and competitors by documentation | 7 |
| `03 §9` / `03 §11` stale in the plan | 7 |
| inherited: `ask` p50 ~100 s; `ask` 25–33 rows vs 24; the fusion gate; README stale | 7 |
