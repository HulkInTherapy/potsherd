# potsherd — re-audit, one day on

**Auditor:** Claude Opus 5, running as the host agent in Claude Code.
**Date:** 2026-08-24 · **Version under test:** potsherd 1.2.0 · node v24.9.0
**Previous:** `docs/AGENT-AUDIT-2026-08-23.md` — potsherd 1.1.0, scored **4/10**.
**Method:** the §7 command list of the previous audit, verbatim, plus its original failing
question and its nonsense controls.

> **Identifiers.** Same convention as the previous audit: session ids are stable placeholders
> (`a1a1a1a1`, `a2a2a2a2`), other people's project directories are `<project-a>`, `<project-b>`.
> The mapping is carried over unchanged, so the F4 fixture still reads correctly: `a1a1a1a1`
> shares 1,660 of its 1,738 uuids with `a2a2a2a2`. Sessions in this repository's own project
> directory are named, because that directory is this repository.

---

## 0. The score

| | 08-23 | 08-24 | |
|---|---:|---:|---|
| **Overall, as an agent-facing product** | **4/10** | **7/10** | every fix landed; one migration bug hides all of them |
| Concept & scope discipline | 9/10 | 9/10 | unchanged, still correct |
| Archive capture | 9/10 | 9/10 | unchanged, still the moat |
| CLI ergonomics for a **human** | 8/10 | 9/10 | `no match` prose, thread line, gap markers |
| **Retrieval quality** | **3/10** | **7/10** | the cliff is real; the label can still be wrong at the top |
| **Reliability of a default install** | **2/10** | **4/10** | clean install is good; **the upgrade path is broken** |
| **Agent ergonomics** | **3/10** | **8/10** | 3 disjoint tools, `Read` gone, fabrication refused in code |
| Re-entry | 5/10 | 9/10 | threads derived, content-dated, 4 exchanges → 123 |

**The headline is a split number, and the split is the whole story.** Measured against a
**clean install**, this is an **8/10** — I could not make it fabricate, could not make it
answer without evidence, and could not make it need an API key. Measured against **my own
machine, upgraded from 1.1.0**, it is a **3/10**, because `potsherd index` crashes and every
one of the ten fixes is gated behind indexing. I score the product **7/10**: the work is done,
and one migration bug is standing in front of it.

**One-sentence verdict:** last time the foundation was good and the retrieval layer could not
tell a match from noise; this time the retrieval layer is honest, the agent path is clean, and
the only thing between a user and all of it is a virtual table left behind by the previous
version.

---

## 1. The original failing question, re-run

Yesterday's headline result was that the tool built to answer *"where did we leave off"* lost
to `grep`. I re-ran that exact dispatch.

**It failed again — and this time it confessed.** I asked the archaeologist to append a
`TOOLING` section naming every tool it actually called. It returned:

> **Tools called:** Read (×10)
> **Searches:** No `potsherd_find`, `potsherd_read`, or `potsherd_ask` called — this was
> answered entirely from git log … all read from disk.

Its answer was *substantially correct* this time — but correct because it read the repository,
not the archive. Its `SOURCES` block cited git log entries. That is F3 reproducing verbatim.

**And it is not 1.2.0's fault.** This session pinned plugin 1.1.0 at launch (`.in_use/71134`,
19:15 today) and kept it after 1.2.0 was installed at 23:38. The agent I dispatched was the
1.1.0 definition — the one that still carries filesystem `Read` and expects four MCP tools that
1.2.0 has since retired. **The fix is on disk and was not in the room.** See N2.

---

## 2. What moved

### F1 — the cliff exists ✅ FIXED

The single most important finding of the previous audit is closed, and closed better than I
specified. I asked for score normalisation; the changelog correctly rejects that — the fused
score is reciprocal rank fusion, a function of rank alone, so normalising maps the top row to
1.0 whether it is a bullseye or the least-bad of two bad rows. Calibration was made a second,
independent axis instead. That is a better fix than the one I asked for, and I was wrong.

Measured, with **freshly invented** controls:

| query class | 08-23 | 08-24 |
|---|---|---|
| true phrase hit | 10 rows, 0.0184 | `strong`, rows returned |
| absent topic (novel) | 10 rows, 0.0110 | `weak`, 4 rows, 0.0102 top |
| plausible-but-absent (novel) | 10 rows | **`no match`, 0 rows** |
| pure nonsense (novel) | 10 rows, 0.0110 | **`no match`, 0 rows** |

`no match` prints prose a human and an agent can both act on — *"20 sessions matched some of
those words and none of them enough"* — plus the escape hatch `--min-confidence none`, which I
verified does return the withheld rows, labelled `none`. `--json` now carries `confidence`,
`minConfidence`, `withheld`, `cards`, `routing` and `vectors`. That is exactly the object I
asked for.

**A methodological note that cost me twenty minutes and is worth recording:** my two original
control strings now return `strong` — correctly, because the previous audit quoted them and
those sessions are now in the index. **A nonsense control is single-use.** The controls for
this audit were freshly invented and their strings are deliberately *not* written into this
file, so they survive the next one. Generate controls at runtime; never commit them.

### F2 — the zero-model path works end to end ✅ FIXED

`--synthesis-out` and `--filter-in` both shipped, exactly as specified. I ran the entire chain
with **zero potsherd model calls**:

| step | model calls | time |
|---|---:|---:|
| `ask --readers-out` | 0 | 1.6 s |
| 6 readers, on my own subscription via the Agent tool | 0 *(potsherd's)* | ~19 s wall, parallel |
| `ask --readers-in --synthesis-out` | 0 | 2.8 s |
| I synthesised | 0 *(potsherd's)* | — |
| `ask --filter-in` | 0 | 2.7 s |

**And I tried to break the citation guarantee.** I planted a fifth "quote" that was never said —
a fluent, plausible sentence about deployment blockers — and attached a sentence to it that
cited only that quote. The filter deleted both and said so:

```
1 sentence dropped · no citation that resolves
```

The four honestly-cited sentences survived with their evidence lines. **The guarantee is code,
not trust, and it holds under a deliberate attack.** This is the strongest single result of the
re-audit.

`--windows` also shipped (F5, below), and `graft --backend codex` exists, which is the
harness-agnostic seam the previous audit asked for.

> **Confound, stated plainly:** `@anthropic-ai/claude-agent-sdk@0.3.241` is now installed
> globally on this machine. I therefore **cannot** re-test the previous audit's central F2
> claim — "dead on a default install" — because this is no longer a default install. What I can
> and did verify is the stronger property: the whole chain completes with potsherd making zero
> model calls of its own, which makes the SDK's presence irrelevant rather than merely
> satisfied.

### F3 — fabrication refused in code ✅ FIXED (but see N2)

The 1.2.0 archaeologist's tool list is `potsherd_recall, potsherd_read`. **Filesystem `Read` is
gone.** The changelog adds something I had not thought to check and which is worse than what I
reported: 1.1.0's only citation check was a regex for `id8@seq`, and run against the block that
agent actually produced it matched *nothing* — every fabricated row passed. `verifySources` now
refuses in code, and a card-only thread gets no citation at all.

That is the right correction, and the right generalisation of it: checking that an id exists is
not checking that it is a provenance.

### F4 — threads, derived at index time ✅ FIXED, and it is the biggest change

Against a correctly-indexed database:

| | 08-23 | 08-24 |
|---|---|---|
| `show a1a1a1a1` date | `12 aug 19:21` (fork point) | **`20 aug 23:26`** (content) |
| `graft a1a1a1a1` | **4 exchanges** | **123 exchanges** |
| lineage line | none | `thread 123 exchanges across 2 sessions` |
| `note a1a1a1a1` | *(verb did not exist)* | `thread of 2 sessions` |

The fixture is unchanged and still passes as a regression test: `a1a1a1a1` = 1,738 uuids, 101
prompts, 811 assistant messages; 1,660 shared with `a2a2a2a2`. The changelog's claim that
Claude Code's own resume metadata is *wrong here* — ten chains, eight false, one asserting
2,097 records from a 98-record file — is the kind of detail that only comes from actually
looking, and it matches the shape of what I found by hand.

### F5 — discontiguous windows ✅ FIXED

Same session, same question, one day apart:

```
08-23   a2a2a2a2   seq 1, 2, 3
08-24   a2a2a2a2   seq 1, 2, 5, 6, 13, 14, 21, 22, 23, 118, 119   5 windows of 119
```

It now reaches seq **118, 119** — the end of the session, where the answer to *"what is left"*
actually lives. Yesterday the readers saw the opening of day one and nothing else. Gap markers
are emitted on transcript positions rather than window order, so a splice cannot read as
continuous.

### F6 — cards route, they do not testify ✅ FIXED

`--json` reports `cards: true` and `routing: 0` as separate facts, so an agent can see whether a
result set leaned on summaries. Lanes are compared before scores; a card-only hit is capped at
`weak` and excluded from `SOURCES`. Yesterday three of my top five hits for the most important
query were card-only matches on unrelated sessions. That cannot now happen.

### F7 — three tools, `Read` gone ✅ FIXED

MCP surface went **6 → 3**: `potsherd_recall`, `potsherd_read`, `potsherd_graft`. `find`, `ls`,
`ask` and `tag` are retired into them. I asked for two; three disjoint tools is a defensible
reading and `graft` genuinely does a different job from `recall`.

Not done: there are still **two skills** (`potsherd`, `remembering-sessions`). I asked to
collapse them to one. Minor, and the model-invocable one now routes to a much better engine, so
the cost of the duplication has fallen a lot.

### F8 — keyphrase extraction ⚠️ PARTIAL

bm25 recall@5 moved 32 → 40 on a 60-query set, and row counts on my long natural-language query
dropped from 10 to 2. But the query itself still fails: the top hit is a `<project-b>` session
matching on a **file path** that contains the project name, labelled `strong`, and the correct
sessions still do not surface. See N4 — this is now a calibration-semantics issue rather than a
ranking one.

### F9 — the small things ⚠️ PARTIAL

Fixed: `doctor` and `stats` now agree about vectors (both read one source of truth); `--json`
carries titles; degradation is announced on **every** `find`, not once in `doctor` —
`semantic search: not running (0 of 4,774 embedded)`. That last one is my fix #4 and it is
exactly right.

Not fixed: `--json` still reports `project` as an absolute filesystem path while the human view
shows a short name.

### #9 — `note`, the verb that writes ⚠️ SHIPPED BUT HALF-WIRED

`potsherd note <thread> --decided/--open/--next/--by` exists and works. Append-only, no `UPDATE`
and no `DELETE` in the module, transcript never touched and that proved by hashing. A second
note appends rather than superseding "because a changed mind is the most valuable thing in the
lane" — which is a better design decision than the one I asked for.

But the loop does not close. See N3.

---

## 3. New findings

### N1 — `potsherd index` crashes on a database upgraded from 1.1.0 ★★★★★ CRITICAL

```
$ potsherd index
potsherd: no such module: vec0
```

Stack: `clearExchanges` → `Object.prepare`. Cause, confirmed: 1.2.0 **drops `sqlite-vec` as a
search path** (correctly — a JS cosine scan is 4.7 ms against vec0's 0.9 ms, and 3.8 ms does not
buy a native failure class). But a database written by 1.1.0 contains `vec_exchanges`,
`vec_cards` and `vec_ghost_prompts` as `vec0` **virtual tables**. Without the extension loaded,
any statement touching them throws, and indexing touches them.

I isolated it decisively: **1.2.0 indexes a fresh directory perfectly** — 17.9 s, 376
transcripts, 1,810 exchanges, embeddings warming in the background. It is not a general break.
It is strictly a 1.1.0 → 1.2.0 migration bug.

**Why this is the highest-severity finding in the document:** every other fix is gated behind
indexing. On my upgraded database, `show` still dated `a1a1a1a1` to the fork point, `graft`
still returned 4 exchanges, and `note` still said *"thread of 1 session"* — I very nearly filed
F4 as "did not move". It moved; I could not see it. Any existing user upgrading in place gets
the 4/10 product and a changelog describing the 8/10 one.

Compounding it: `doctor` prints `schema v9 of v12 · run potsherd index` — **the tool instructs
the user to run the one command that cannot run.**

**Fix:** at migration, detect `vec0` tables and `DROP` them before touching anything (they are
a rebuildable cache; nothing is lost). Failing that, catch the module error and rebuild the
database from the byte-exact archive, which is exactly what that archive is for.

### N2 — a running session keeps the old plugin, and the old failure ★★★★☆

This session pinned 1.1.0 at launch and kept it after 1.2.0 was installed. The consequence is
not cosmetic: the archaeologist I dispatched had `Read`, used it ten times, called no potsherd
tool at all, and reproduced F3 exactly — the failure 1.2.0 fixes.

Worse is the skew *between* the two halves. The 1.1.0 agent definition names
`potsherd_find`, `potsherd_ls` and `potsherd_ask` — three tools the 1.2.0 MCP server no longer
serves. An agent from one version talking to a server from the other is a live failure mode,
and the more graceful the fallback (an agent with `Read`) the more silently it fails.

**Fix:** version-stamp the MCP handshake and have the server refuse, loudly, when the agent
definition it is serving is from a different minor. A hard error at the first tool call is much
better than an agent quietly reading the filesystem instead.

### N3 — `note` is write-only; the loop does not close ★★★☆☆

I wrote a note to a thread, then asked for it back three ways:

- `graft --no-model` — note absent
- `graft` **with** a model (22.9 s, $0.065, 8/8 citations resolving) — note absent
- `find "<the exact phrase I had just written>"` — **`no match`**

The note is stored. It is not indexed for search, and it does not reach the brief — even though
`note`'s own last line says *"run potsherd graft … to carry this thread into a new session"*.

This matters more than its severity suggests, because the write-back lane is the one thing in
the previous audit that no competitor can copy. Right now the archive can be told something and
cannot be asked about it. Notes should be a first-class retrieval lane — searchable, and
pinned to the top of every brief for their thread. That is where card coverage past 10% comes
from without any model call at all.

### N4 — calibration measures coverage, not relevance ★★★☆☆

The confidence axis is `coverage × (0.60 + 0.25·strength + 0.15·agreement)`, with coverage as a
ceiling. That correctly kills rows whose words are absent. It does **not** distinguish a session
that *discusses* a topic from one that merely *contains the string* — so a `<project-b>` session
whose only match is a file path containing the project name is labelled `strong` and ranks
first, above every session that actually discussed the question.

So the cliff is real at the bottom and still soft at the top: `none` is now trustworthy, `strong`
is not yet. For an agent that is a large improvement — a false negative costs a retry, a false
positive costs a wrong answer — but the top of the list is where the remaining work is.

**Fix:** discount matches that fall inside path-like or code-like spans, and let `agreement`
carry more weight when a query has several content words: a row matching one of four distinctive
nouns should not reach the same tier as a row matching all four.

### N5 — the audit contaminates the corpus it audits ★★☆☆☆

Beyond the burned controls, the shortlist for my original question is now polluted by sessions
*about* this audit. In the freshly-indexed database, four of six shortlisted sessions were
potsherd's own development and today's audit conversations. Any archive-search tool developed
against its author's own archive will drift this way, and the eval set will quietly become a
measurement of the tool's development history.

**Fix:** an `--ignore` default for the tool's own project directory during evaluation, and eval
fixtures pinned to a corpus snapshot taken before the work began.

---

## 4. What did not move

- **Two skills, not one** (F7 residual). Minor.
- **`--json` project is still an absolute path** (F9 residual). Minor, but it is the field an
  agent groups by.
- **`link` is still manual.** Now largely superseded by derived threads; the verb should
  probably say so, or become "correct a derived thread" rather than "create one".
- **The natural-language query still fails** (F8/N4).

Nothing I filed yesterday was rejected without a reason, and the one place my prescription was
wrong — score normalisation over an RRF score — was diagnosed correctly and replaced with
something better. That is the right response to an audit and it is rarer than it should be.

---

## 5. The fix list now

| # | Fix | Effort | Why |
|---|---|---|---|
| 1 | **Drop `vec0` tables at migration** (N1) | S | Unblocks every other fix for every existing user. Nothing else matters until this ships. |
| 2 | Make `doctor` detect the broken-migration state and print the recovery command, not `run potsherd index` (N1) | S | The tool currently prescribes the failing command. |
| 3 | Version-stamp the MCP handshake; refuse on minor mismatch (N2) | S | Turns a silent wrong answer into a loud error. |
| 4 | Index notes; pin them to the top of the brief (N3) | M | Closes the write-back loop — the differentiator. |
| 5 | Discount path/code-span matches in `coverage` (N4) | M | Makes `strong` mean what `none` already means. |
| 6 | Eval corpus snapshot + self-ignore (N5) | S | Stops the measuring instrument drifting. |
| 7 | Collapse to one skill; short project name in `--json` | S | Residual polish. |

Item 1 alone moves the **upgraded-install** experience from 3/10 to roughly 8/10, because
everything else is already built and sitting behind it.

---

## 6. Honest confounds in this re-audit

State them, because the previous audit's credibility rests on this one being as unsparing about
itself:

1. **The corpus is not byte-identical.** 428 MB → 478 MB, 47 → 49 sessions, 275 → 311
   sidechains. Yesterday's audit is now in it.
2. **The agent SDK is now installed**, so the central F2 claim is not re-testable here.
3. **Both original nonsense controls are burned** and were replaced with fresh ones.
4. **This session runs plugin 1.1.0**, so every agent-path result is 1.1.0's; all binary results
   are 1.2.0's, run explicitly by absolute path.
5. **I ran `1.1.0 index` once**, mid-audit, before discovering N1. That re-parsed 369
   transcripts and cleared the vector table, which is why the vector counts differ between my
   first `doctor` and later ones. It does not affect any finding above, but it is why the
   numbers are not identical across the transcript.

---

## 7. Method, for reproducibility

The previous audit's §7 list, verbatim, plus the new controls:

```
potsherd doctor · stats · index                      capability baseline; index CRASHED (N1)
potsherd index --potsherd-dir <fresh>                isolation test — clean install indexes fine
potsherd find × 9 queries                            4 fresh controls, natural-language, keyword
potsherd find --json × 3                             confidence, withheld, cards, routing, vectors
potsherd find --min-confidence none                  the escape hatch returns withheld rows
potsherd ls --limit 8                                listing, titles, ordering
potsherd show a1a1a1a1                               date-vs-content, both databases
potsherd graft a1a1a1a1 --no-model / with model      re-entry, both databases
potsherd note a1a1a1a1 --decided/--open/--next       write-back; thread resolution
potsherd ask --readers-out → 6 Agent readers →
  --readers-in --synthesis-out → --filter-in         the full zero-model chain, with a planted quote
potsherd ask "..."                                   full binary path (SDK now present)
potsherd help ask / graft / note / card / link       surface diff against 1.1.0
bin/potsherd-mcp ← initialize + tools/list           6 tools → 3
sqlite3 over ~/.potsherd/potsherd.db                 root cause of N1: vec0 virtual tables
python3 over the raw transcripts                     ground truth, unchanged
```

Regression fixtures, all still valid:

- `a1a1a1a1` — 1,738 uuids, **1,660 shared with `a2a2a2a2`**, 101 prompts, 811 assistant
  messages. Correctly indexed: `thread 123 exchanges across 2 sessions`, dated 20 aug.
  On a database upgraded in place: 4 exchanges, dated 12 aug. **That divergence is the N1 test.**
- A planted un-resolvable quote must produce `1 sentence dropped · no citation that resolves`.
- Four freshly-invented absent-topic controls must return `no match` and zero rows. **Keep the
  strings out of the repository** or they stop being controls.

---

*Yesterday the tool lost to `grep` and the fix list was long. Today the fix list is done and one
virtual table is standing in front of it. That is a much better problem.*
