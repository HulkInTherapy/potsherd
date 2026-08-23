# potsherd — an audit from the agent that has to use it

**Auditor:** Claude Opus 5, running as the host agent in Claude Code.
**Date:** 2026-08-23 · **Version under test:** potsherd 1.1.0 (marketplace install), node v24.9.0
**Corpus:** the auditor's own live archive — 428 MB, 54 sessions, 277 subagents, 299 ghosts, 331 indexed transcripts, 16 projects, nov 2025 → aug 2026.

> This audit was not written from the README. Every number below came from running the tool
> against a real question I genuinely needed answered and could not answer. I failed that task
> using potsherd, then succeeded using `grep`. This document is the post-mortem.

---

> **A note on the identifiers in this document.** This is the audit as written, with one
> mechanical change: every session id has been replaced by a stable placeholder
> (`a1a1a1a1`, `a2a2a2a2`, …) and every project directory name by `<project-a>`, `<project-b>`,
> `<project-c>`. The substitution is one-to-one, so every claim that depends on two ids being
> the same or different still reads correctly — including the F4 fixture, where `a1a1a1a1`
> shares 1,660 of its 1,738 uuids with `a2a2a2a2`. The unredacted copy lives outside this
> repository. Session ids are the join key back to a real transcript; this repository does not
> publish them, and `scripts/check-privacy.py` refused this file until it did not carry any.


## 0. The score

| | | |
|---|---:|---|
| **Overall, as an agent-facing product** | **4 / 10** | good bones, wrong defaults, dead on arrival for half its verbs |
| Concept & scope discipline | 9 / 10 | correctly identifies the unserved half of the category |
| Archive capture (rescue, ghosts, sidechains, multi-harness) | 9 / 10 | genuinely excellent, and nobody else does it |
| CLI ergonomics for a **human** | 8 / 10 | the output design is the best part of the product |
| **Retrieval quality** | **3 / 10** | uncalibrated, never empty, punishes natural language |
| **Reliability of a default install** | **2 / 10** | 3 of the 6 headline verbs cannot run |
| **Agent ergonomics (the actual target)** | **3 / 10** | four doors to one capability; the model-facing door is the worst one |
| Re-entry / "get it back into my session" | 5 / 10 | `graft` is the right idea, defeated by the session model |

**The one-sentence verdict:** potsherd has solved the hard, unglamorous half — *getting the corpus,
intact, including what Claude Code deleted* — and then hands it to the agent through a retrieval
layer that cannot tell a match from noise, and a model layer that isn't installed.

---

## 1. What I was actually trying to do

The user left a large project (<project-a>) for ~30 days and asked: *where did we leave off, what's
built, what's left.* This is the canonical problem-3 + problem-4 case. It is exactly what potsherd
is for. There are 4 real sessions and ~1,100 prompts about this project on disk.

I dispatched the `session-archaeologist` agent twice, per `remembering-sessions/SKILL.md`.

**Both runs failed.** They returned "SOURCES" lines that were *repo files* — `HANDOFF.md §3`,
`PHASE-9-FIRST-JOB.md` — dressed in the citation format. Zero session ids. Zero transcript quotes.
One fabricated a project start date of June 3; the real first commit is July 7. I then answered the
question myself with `git log`, `find`, and 40 lines of Python over the raw JSONL — in about ten
minutes — and got the complete, correct answer including material the repo did not contain.

That is the headline result: **the tool built to answer this question lost to `grep` on its own
corpus.** Everything below is why.

---

## 2. Findings, ranked by how much damage they do

### F1 — `find` never returns nothing, and its scores carry no information ★★★★★

This is the root cause of the failure above.

```
potsherd find "gate-probe"                              → 10 hits, top score 0.0184  (correct)
potsherd find "kubernetes ingress payment service"      → 10 hits, top score 0.0110  (absent topic)
potsherd find "zzzqqq flurblewomp aardvark protocol"    → 10 hits, top score 0.0110  (nonsense)
```

A real hit and pure gibberish differ by **1.67×**, in a band from 0.0095 to 0.0275, with no
normalisation and no floor. `find` returned ten confident-looking rows for a word that does not
exist in any human language.

For a human this is survivable — you glance at the titles and know. **For an agent it is fatal.**
I have no way to distinguish "the archive contains your answer" from "the archive contains nothing
and I am showing you the ten least-bad rows." So the agent does the rational thing: it treats the
whole result set as unreliable and falls back to a source it *can* verify — the repo in front of
it. Which is precisely what my two archaeologists did.

It also makes the agent's own instructions dead code. `session-archaeologist.md` says:

> *"If nothing comes back, widen once — then once more... Two widenings is the limit. If three
> searches find nothing, say so and stop."*

Nothing ever comes back empty, so the widening path is unreachable and `NOT FOUND` can never be
correctly emitted.

**Fix:** normalise scores to 0–1 against the query's own score distribution; establish a floor
below which you print `no match` and return zero rows; and put a one-word confidence label
(`strong` / `weak` / `none`) on every row and in `--json`. An agent needs a cliff, not a ranking.

### F2 — Three of the six headline verbs are dead on a default install ★★★★★

The tour advertises "the six": `audit rescue ls find ask graft`. On a clean marketplace install:

```
potsherd ask "..."                → cannot reach a model: @anthropic-ai/claude-agent-sdk is not installed
potsherd ask ... --readers-in ... → same error
potsherd card                     → same dependency
potsherd find (semantic)          → "text search only" — sqlite-vec / embedding runtime absent
```

So **`ask` (verb 5 of 6), `card`, and the entire semantic half of `find` do not run**, and nothing
says so until you invoke them. `doctor` reports `vectors —` on one line while `index` reports
`vectors 1,561` on another; the two subsystems disagree in print.

The dependency is real and the error message is genuinely good — it names the exact install
command, and the 677 MB / 17 MB trade-off is a defensible default. The failure is that this is
discovered at the moment of use rather than at install, and that the docs present these verbs as
core rather than as an upgrade tier.

**The worst part:** `SKILL.md` documents a beautiful seam — `--readers-out` records the reader
inputs with **zero model calls** (verified: 0.36 s, genuinely no backend constructed), the host
agent runs the six readers for free on its own subscription, and `--readers-in` does the single
synthesis call plus in-code citation filtering. That is exactly the right architecture for a
subscription-based world. **And it still fails at the last step**, because that one synthesis call
needs the 677 MB SDK. The free path is free for 6/7 of its work and then hits a wall.

**Fix, and this is the highest-leverage change in the whole document:** add `--synthesis-out` /
`--filter-in`. Emit the synthesis prompt for the host agent to run; accept the host's answer back
and run `filterAnswer` over it in code. Then **potsherd never needs model access at all** — the
host agent is the model, the citation guarantee is preserved because filtering is code, and the
677 MB dependency becomes genuinely optional instead of load-bearing. This single change makes
the tool work identically on Claude Code, Codex, Cursor, or any SDK harness, on a subscription,
with a 17 MB install.

### F3 — The archaeologist agent can read the filesystem, so it does ★★★★☆

`agents/session-archaeologist.md` grants `Read` alongside the four potsherd MCP tools. The prompt
is emphatic and well-written — *"You do not answer it from the repository you are sitting in"* —
but the tool is there, the repo is there, and when F1 makes the archive look like noise, the model
takes the path that produces a confident answer.

Both of my runs cited repo markdown in the `SOURCES` block, in the correct format, with the
session-id and exchange-count fields left as `—`. The format made the fabrication look like
evidence. A reviewer skimming the output would not catch it; I only caught it because I knew the
real dates.

**Fix:** remove `Read` from that agent (it is used only for the `--readers-*` round trip, which
the archaeologist does not perform). Then make the citation format machine-checkable: refuse to
emit a `SOURCES` line whose `id8` does not resolve against the index. You already do exactly this
for quotes in `filterAnswer` — apply the same discipline one level up. **A citation format that
accepts unverified rows is worse than no format**, because it converts a guess into something that
reads like a receipt.

### F4 — There is no lineage model; sessions are documents, but work is a chain ★★★★☆

The session I was last working in is `a1a1a1a1`. Its JSONL is 37 MB with 101 human prompts spanning
08-12 → 08-20.

```
potsherd graft a1a1a1a1 --no-model  →  "4 exchanges"
```

Four. And the four are about a blog-post colour theme.

**This is not a parsing bug, and I want to be precise because I initially mis-diagnosed it.** I
checked: 1,660 of that file's 1,738 records are byte-identical to `a2a2a2a2`. `a1a1a1a1` is a
fork/resume that copied its parent's history, and potsherd's dedup correctly attributes the shared
records to the session that had them first. The dedup is *right*.

The **model** is wrong. Claude Code sessions form chains — fork, resume, compact — and potsherd
treats each link as an independent document with no pointer to the others. The consequences are
all user-facing:

- `graft` on "the session I was in yesterday" returns a 4-line stub and calls it *"Brief from a
  past session"*, with no hint that 1,660 records of context live one hop away.
- `find` and `ls` date `a1a1a1a1` as **12 aug** — inherited from the fork point — while its actual
  content is **20 aug**. That silently corrupts `--since`, `--until`, and every "newest first"
  ordering. I nearly reported the wrong last-activity date to the user because of this.
- The only lineage tool is `link`, which is **manual**, and `link --suggest` proposes cross-project
  links for a human to accept by hand. It is not exposed over MCP at all, so an agent cannot even
  see or create a link.

**Fix:** derive the chain automatically at index time — uuid-overlap ≥ some threshold, or Claude
Code's own resume metadata — and make **the thread**, not the session, the primary object. `ls`
shows threads. `graft <any id>` grafts the whole thread. Date a session by its content, never by
inherited history. This is the difference between "I found the file" and "I found the work".

### F5 — Excerpt selection is one small contiguous window per session ★★★★☆

From the recorded `--readers-out` payload for *"what is left to build in <project-a> and what did we
decide to do next"*:

| session | project | excerpt chars | seqs given to the reader |
|---|---|---:|---|
| b1b1b1b1 | <project-a> (subagent) | 8,013 | `[1]` |
| a2a2a2a2 | <project-a> | 5,418 | `[1, 2, 3]` |
| b2b2b2b2 | <project-a> (subagent) | 4,014 | `[2]` |
| b3b3b3b3 | <project-a> | 3,963 | `[1, 2, 3]` |
| c1c1c1c1 | **<project-b>** | 4,427 | `[30, 31, 32]` |
| c2c2c2c2 | **potsherd** (subagent) | 6,683 | `[1, 2, 3]` |

Total ≈ 32.5 KB ≈ 8.1 k tokens across six sessions — about **1.3 k tokens per session**, against a
119-exchange, 8-day session. Roughly 2.5% of the transcript, in **one contiguous run**.

Two things break here:

1. **Long multi-topic sessions are unanswerable by construction.** An 8-day session covers twenty
   subjects; the answer to "what's left" is distributed across the last day. Handing the reader
   exchanges 1–3 of day one cannot produce it. The window needs to be *relevance-selected and
   discontiguous* — five 200-token windows from across the session beat one 1,300-token window
   from its opening, every time.
2. **The shortlist itself was wrong.** It included a session from `potsherd`'s own development and
   a 2-exchange Java sidechain, and **omitted `a1a1a1a1` entirely** — the session containing the
   answer. That is F1 and F4 compounding: uncalibrated ranking picks the wrong six, and the
   lineage gap makes the right one look 4 exchanges long.

There is a genuinely poignant detail here. The excerpt potsherd *did* return from `a2a2a2a2` is the
user, on 12 August, typing:

> *"i left the project for some 10 to 20 days and now i came back to the project again. now i want
> your help to continue with whatever we have left"*

The archive contains the user asking this exact question a month ago. potsherd surfaced the
question and not one word of the answer.

### F6 — Cards can outrank transcripts, and 90% of sessions have none ★★★☆☆

`find` matches against session cards as well as transcript text, and prints an honest note when it
does:

> `the session card matched; the transcript does not use those words`

Honest, and still wrong-headed: for the query *"where did we leave off on <project-a> what is left to
build"*, **three of the top five hits were card-only matches on potsherd's own dev sessions**, and
they outranked every real <project-a> transcript. A generated summary beat primary evidence.

Meanwhile `card` requires the missing SDK (F2), so coverage is ~32 titled of 353. The retrieval
layer therefore leans hardest on the artefact that is least available and least authoritative.

**Fix:** score cards in a separate lane; never let a card-only hit outrank a transcript hit; and
expose `--no-cards`. Cards are a browsing aid, not evidence.

### F7 — Four doors to one capability, and the model picks the worst one ★★★★☆

An agent in a live session confronts:

1. `skills/potsherd/SKILL.md` — 20+ verbs, `disable-model-invocation: true` (user-typed only)
2. `skills/remembering-sessions/SKILL.md` — model-invocable, and **its entire content is "dispatch
   the subagent"**
3. `agents/session-archaeologist.md` — haiku, 4 MCP tools + `Read`
4. six `mcp__..._potsherd_*` tools, callable directly by anyone

These overlap almost totally and are ranked, in practice, worst-first. The only door the model may
open on its own initiative (#2) routes to the weakest engine (#3): a haiku agent, denied `graft`
and `tag`, granted `Read`, given prompt-only instructions to compensate for an uncalibrated
retrieval layer. **The strong model in the main loop — the one with the full conversation context,
which knows what "we" means and what was already ruled out — is architecturally excluded from
touching the archive directly.**

That is backwards. Compression is a good reason to delegate; *capability* is a good reason not to.
The archaeologist's real job is to keep six transcripts out of my context — that is worth doing.
But it should be a **windowing** subagent handing back cited excerpts, not a **reasoning** subagent
handing back conclusions I cannot check.

There is also a self-defeating instruction in `remembering-sessions`:

> *"You already dispatched the archaeologist for this question in this turn. Once is enough; a
> second dispatch on the same question returns the same thing."*

Combined with F1, the first dispatch is the *only* dispatch, and if it lands on noise the skill
forbids the retry that would have worked with better keywords.

**Fix:** collapse to **one** model-invocable skill and **two** MCP tools (see §4). Give the main-loop
agent direct `find`/`read`. Keep the subagent strictly for fan-out reading, and forbid it from
drawing conclusions.

### F8 — BM25 punishes the phrasing the skill mandates ★★★☆☆

`session-archaeologist.md` instructs: *"Pass the user's own words as `query`."* With a BM25-only
index and no vectors installed, that is the worst available strategy — stopwords dilute, and long
questions drift toward whatever session happens to contain the most common words.

```
find "where did we leave off on <project-a> what is left to build"
  → top hit: a <project-b> session matching on a file path; the two correct sessions absent from top 5

find "<project-a>"
  → top 3 are exactly the right sessions, correctly ranked, ★-marked
```

The one-word query beat the natural-language one decisively. The skill tells the agent to do the
thing that fails. (With `--embed` installed this may well reverse — but `--embed` is not installed,
and the instruction does not condition on that.)

**Fix:** either install vectors by default (see F2), or have the CLI extract keyphrases from a
long query internally, or instruct the agent to search with 2–4 distinctive nouns *first* and the
full sentence only as a fallback. Right now the tool's advertised behaviour and its actual
behaviour are opposites.

### F9 — Smaller things ★★☆☆☆

- `--json` returns absolute filesystem paths as `project` where the pretty view shows a short name,
  and omits `title` on many rows. An agent parsing JSON gets a strictly worse object than a human
  reading the terminal.
- Cross-project recall, the flagship claim, underperformed on my one test: `find "longmemeval
  reflector consolidation"` returned only `<project-a>` sessions and no `<project-c>` sessions, though
  <project-c> is the donor project the term originates in (34 MB, 51 files). Not conclusive — BM25
  may legitimately rank <project-a> higher — but it is the exact query the product promises to win.
- `doctor` and `index` disagree about vectors in the same session.

---

## 3. What is genuinely good, and should not be touched

I want this on the record, because the fix list above is long and the foundation is not the problem.

- **`rescue` + ghosts is the moat.** 299 sessions and 2,971 prompts recovered from Claude Code's
  30-day sweep, with the assistant side honestly marked unrecoverable rather than hallucinated.
  Every competitor starts empty on install day. This is the retroactive wedge and it is real.
- **Sidechains as first-class sessions.** 277 subagent transcripts indexed and individually
  addressable, with `↑ parent` and `↳ subagent` cross-links printed in results. For my workflow
  that is where most findings actually live, and no other tool indexes it.
- **The honesty discipline throughout.** `the session card matched; the transcript does not use
  those words`. `no model call was made (0)`. `assistant side not recoverable`. `2 ghost hits ·
  relaxed to any-word matching`. This is a tool that tells you when it is guessing. That instinct
  is rare and it is the reason the fixes above are worth making — the scaffolding for trustworthy
  output already exists, it just isn't wired to retrieval.
- **The `--readers-out` seam.** Zero model calls, verified. Correct architecture, one step short.
- **Speed.** 23–270 ms for `find`; 976 ms to incrementally re-index 432 MB. Nothing here is slow.
- **`graft` self-ignores.** It writes `.potsherd/graft-<id>.md` into the cwd *and ships a
  `.potsherd/.gitignore`* so the user's `git status` stays clean. I checked specifically to catch
  it polluting my repo, and it had already handled it. That is real care.
- **Error messages name the fix.** Every failure I hit printed the command that resolves it.
- **The output design.** 80 columns, one accent colour, last line names the next verb. For a human
  this is the best-designed CLI I have used this year. The problem is that the *agent* path does
  not inherit any of that quality.

---

## 4. What I actually need — the agent's-eye specification

You asked what I want. Not features; these are the things that decide whether I use the tool or
route around it.

**1. A cliff, not a ranking.** Give me `confidence: strong|weak|none` and return **zero rows** for
`none`. I will happily tell the user "your archive does not contain this" — that is a good answer
and I can act on it. What I cannot act on is ten rows scored 0.0110. An honest empty result buys
more trust than a full page of maybes, and trust is what determines whether I call you again.

**2. Threads, not sessions.** Model the fork/resume chain and make it the unit. When I ask for "the
session we were in", give me the whole chain, dated by content. Today I get a 4-exchange stub.

**3. Relevance-windowed, discontiguous excerpts.** Five 200-token windows from across a long
session, each with its seq and timestamp, beat one 1,300-token window from its opening. Let me ask
for `--windows 5` when the session is long.

**4. A zero-model path that goes all the way through.** `--synthesis-out` / `--filter-in`. I am
already a model, running on the user's subscription, with their whole context. Do not make me
install 677 MB so you can call a different model that knows less than I do. Hand me the prompt,
take my answer back, run your citation filter over it in code. This is the single change that makes
potsherd harness-agnostic — identical on Claude Code, Codex, Cursor, or any SDK host — and it
answers the subscription-not-API question completely.

**5. Two tools, not six, and one skill, not two.**

```
potsherd_recall(query, scope?, want: "hits"|"context")
    → hits:    calibrated, thread-aware, with confidence and an explicit empty
    → context: the windows themselves, ready to read, budgeted

potsherd_graft(thread_or_query, about?, budget?)
    → the brief, for carrying forward
```

Everything else (`tag`, `pin`, `link`, `card`, `ls`, `stats`, `doctor`) is a **human** CLI verb and
should not be in my tool list at all. Six tools with overlapping descriptions cost me a decision
every time; two with disjoint jobs cost me none. Same for skills: one model-invocable skill that
routes, not two that overlap.

**6. Let the strong model search directly.** Give the main-loop agent `recall`. Use the subagent
for *fan-out reading* only — many transcripts, cited excerpts back, no conclusions. Delegate
context, never judgement. The model holding the conversation is the one that knows what the
question means.

**7. Write-back — the missing half of the loop.** Every verb is read-only, so the archive never
learns. Let me leave a marker at the end of a session: *this thread decided X, left Y open, next
step Z.* Cheap for me (I already know it, it costs one tool call), and it turns your corpus from
raw transcript into something with a spine. This is also how you get card coverage above 10%
without a 677 MB dependency — **I** write the cards, as I go, for free.

**8. Re-entry that actually re-enters.** `graft` writes a file and prints a brief, and the skill
then tells me to `Read` it. That works, and it is more than any competitor does. The next step is
a `resume` that hands the *user* a live continuation — the thread's brief plus `claude --resume`
already wired — so "continue that session" is one command and not a copy-paste.

**9. Tell me what you can't do, at the top.** If vectors are absent, say `SEMANTIC SEARCH
UNAVAILABLE — results are keyword-only` on **every** `find`, not once in `doctor`. I calibrate my
strategy on your capabilities; when you degrade silently I keep using a strategy that cannot work.

---

## 5. The fix list, in the order I would do it

| # | Fix | Effort | What it buys |
|---|---|---|---|
| 1 | Score normalisation + floor + explicit empty (F1) | S | The whole tool becomes trustable. Without this, nothing else matters. |
| 2 | `--synthesis-out` / `--filter-in` (F2) | S–M | `ask` works on a 17 MB install, on any harness, on a subscription. |
| 3 | Strip `Read` from the archaeologist; verify `SOURCES` ids against the index (F3) | S | Kills silent fabrication. |
| 4 | Loud degradation banner when vectors/SDK are absent (F2, F9) | S | Agents stop using strategies that cannot work. |
| 5 | Thread/lineage model; date by content not fork point (F4) | M | `graft` and `ls` stop lying about long work. |
| 6 | Discontiguous relevance windows, `--windows n` (F5) | M | Long sessions become answerable at all. |
| 7 | Collapse to 2 MCP tools + 1 skill; give main-loop agent `recall` (F7) | M | Removes the routing tax and the haiku bottleneck. |
| 8 | Cards in a separate scoring lane, never outranking transcripts (F6) | S | Primary evidence wins. |
| 9 | Agent write-back (`note` / `close`) | M | The archive compounds instead of accumulating. |
| 10 | Ship vectors by default, or keyphrase-extract long queries server-side (F8) | M | The documented strategy stops being the losing one. |

Items 1–4 are days of work and would move my score from **4/10 to roughly 7/10**. Items 5–7 are the
difference between 7 and 9. Item 9 is what makes it a category-definer rather than a better
`grep` — and it is the one no competitor is positioned to build, because it requires the agent to
be a *writer* of the archive and not just a reader of it.

---

## 6. For Digsite v0.1 specifically

The positioning document is right about the market and wrong about one thing.

**Right, and hold the line:** scoping to problems 3 and 4 and refusing to fight claude-mem on
capture-and-inject. The retrieval lane really is empty — 5.2 k stars across six tools against 187 k
across five — and the retroactive wedge is real and defensible.

**Bet 02 needs restating.** "Embed the cards, not the chunks" is elegant, and on my machine it
produced the *opposite* of the intended effect: cards outranked transcripts and the top three hits
for my most important query were summaries of unrelated sessions (F6). Cards are lossy artefacts of
a model call. Embed them for *routing* — to pick which threads to open — and then always retrieve
evidence from transcript text. If a card can be cited as evidence, you have rebuilt the
hallucination problem inside the tool that exists to prevent it.

**Bet 03 is the product, and it is currently the broken part.** "Interrogate, don't just match" is
exactly right, and `ask` is where it lives, and `ask` does not run on a default install. Making the
map-reduce work with **zero model access of its own** — host-agent readers, host-agent synthesis,
code-side citation filtering — is not a nice-to-have. It is what makes the bet shippable to the
subscription users who are 90% of the market.

**The stat to lead with.** The doc says *"0 have a title."* The sharper version, from my own
archive: **the session I was working in three days ago indexes as 4 exchanges, and its other 1,660
records live under a different id with no link between them.** "Your agent can't find yesterday" is
a more visceral pitch than "your sessions are untitled," and unlike the title problem it is not
something Anthropic might fix in a release and eliminate your wedge.

**And one missing bet.** Digsite as specified is read-only, like everything else in the retrieval
lane. The compounding asset is the agent writing back — a two-line verdict at the end of every
thread, produced by the agent that just lived it, at zero marginal cost. That is a corpus nobody
else can bootstrap, because it requires being inside the session, which is exactly where a
Claude Code plugin already is.

---

## 7. Method, for reproducibility

Everything above came from these commands, run against the auditor's live archive on 2026-08-23:

```
potsherd doctor · stats · index                      capability + corpus baseline
potsherd find × 11 queries                           natural-language vs keyword; two nonsense controls
potsherd find --json × 3                             score distribution
potsherd ls --limit 12 / 400                         listing, titles, ordering
potsherd show a1a1a1a1                               date-vs-content inconsistency
potsherd graft a1a1a1a1 --no-model                   re-entry, before and after a clean re-index
potsherd ask "..." --readers-out <file>              seam verification (0 model calls, 0.36 s)
potsherd ask "..." --readers-in <file>               SDK dependency on the "free" path
potsherd ask "..."                                   full binary path
potsherd help link / card                            lineage + card surface
bin/potsherd-mcp  ← initialize + tools/list          MCP server health (6 tools, healthy)
python3 over ~/.claude/projects/*.jsonl              ground truth: prompt counts, uuid overlap
```

Ground-truth checks used to falsify my own findings, and worth keeping as regression fixtures:

- `a1a1a1a1` — 1,738 uuids, **1,660 shared with `a2a2a2a2`** → dedup correct, lineage missing.
  I initially recorded this as a parser bug and was wrong; the check is what caught it.
- `a1a1a1a1` — 101 human prompts / 811 assistant messages, 08-12 → 08-20, indexed as *4 exchanges*,
  dated *12 aug*.
- Nonsense query returning 10 rows at 0.0110 against a true hit at 0.0184.

---

*Written by the agent that failed the task first and passed it with `grep`. The failure is the
finding; the corpus was never the problem.*
