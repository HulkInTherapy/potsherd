---
name: remembering-sessions
# ===========================================================================
# THREE CANDIDATE DESCRIPTIONS. `03` §9 and phase 5's risk note both make this
# one field the whole product: it is the only thing that decides whether the
# model reaches for this skill unprompted. Exactly one may be uncommented.
# The orchestrator tests all three (phase-5 DoD: "model-invoked recall fires on
# a natural 'last time…' prompt without being asked").
#
# === candidate A · trigger-list first =====================================
# description: Search the user's own past coding-agent sessions instead of answering from memory. Use this whenever the user refers to earlier work — "last time", "before", "we discussed", "why did we", "what did we decide", "remind me", "that thing we did last month" — and whenever they treat something as shared history you have no record of. Returns an answer with the session ids and dates behind it.
#
# === candidate B · capability first =======================================
# description: The user's own history of coding-agent sessions — every prompt, every subagent transcript, and the sessions Claude Code's 30-day sweep already deleted — indexed and searchable on this machine. Use it BEFORE saying you do not know, do not have that context, or were not part of an earlier conversation. Triggers - "last time", "we discussed", "why did we", "what did we decide", "remind me", "in the other project".
#
# === candidate C · imperative first · SHIPPED =============================
description: Use BEFORE answering anything that refers to work done earlier, and BEFORE saying you do not know or were not there. Triggers on "last time", "before", "we discussed", "why did we", "what did we decide", "remind me", "in the other project", and on any question that assumes a shared history you have no record of. Searches every past Claude Code, Codex, Cursor and pi session on this machine — including subagent transcripts and the sessions the 30-day sweep deleted — with potsherd_recall, which you call yourself.
# ===========================================================================
user-invocable: false
# `allowed-tools` is deliberately absent. It PRE-APPROVES the tools it lists and
# does not restrict anything, so the only thing it could buy here is skipping a
# prompt on the Agent tool — and the docs say skills cannot declare Agent. An
# invented entry would be dead weight in a field whose whole job is to be exact.
#
# The `context: fork` / `agent: session-archaeologist` alternative dispatch that
# used to sit here has been REMOVED, not commented. It ran this whole body
# inside the haiku subagent, which is the architecture audit F7 is about: the
# strong model in the main loop, the one that knows what "we" refers to, was
# excluded from touching the archive. The body below is for the main loop to
# execute. Do not put it back.
---

# remembering sessions

The user has referred to something that happened before this conversation. It is in their
archive, not in your context. Go and get it — do not reconstruct it, and do not tell them you
were not there.

<!--
  T10.6 · F7 — WHAT CHANGED AND WHY.

  This skill's entire content used to be "dispatch the session-archaeologist".
  The agent audit measured what that costs:

    "The only door the model may open on its own initiative routes to the
     weakest engine: a haiku agent, denied graft and tag, granted Read, given
     prompt-only instructions to compensate for an uncalibrated retrieval
     layer. The strong model in the main loop — the one with the full
     conversation context, which knows what 'we' means and what was already
     ruled out — is architecturally excluded from touching the archive."

  So: YOU search. `potsherd_recall` is in your tool list, it costs nothing and
  it returns in under a second. The subagent is still here and still worth
  dispatching, for the one thing it is genuinely good at — keeping six
  transcripts out of this conversation's context — and for nothing else.

  Compression is a good reason to delegate. Capability is a good reason not to.
-->

## do this

1. **Search it yourself. `potsherd_recall`.** One call, right now, before you say anything about
   what you do or do not remember.

   ```
   potsherd_recall { "query": "<two to four distinctive nouns from what they said>" }
   ```

   - **Nouns, not the sentence.** The index is keyword-first; a whole question dilutes into
     stopwords. `"pgbouncer transaction pooling"` beats `"why did we end up moving off pgbouncer
     for the transaction pooling thing"`. The reply's `capability` line tells you whether semantic
     search was available on this call — when it says `SEMANTIC SEARCH UNAVAILABLE`, nouns are
     not a preference, they are the only strategy that works.
   - **No `scope` on the first call.** Do not add `project` because you happen to be in a
     repository. The archive's whole value is that the answer is usually somewhere else.

2. **Read `confidence` before you read the rows.**

   | `confidence` | what it means | what you do |
   |---|---|---|
   | `strong` | the archive holds this | go to step 3 |
   | `weak` | something matched, thinly | go to step 3, and say "possibly" out loud |
   | `none` | **zero rows.** the archive does not contain this | see below |
   | `null` | this build does not calibrate scores | judge the rows on their quotes, and say so |

   **`none` is an answer, and it is a good one.** "I searched your history for X and it is not
   there" is something the user can act on. Do not widen into a guess and do not fall back to the
   repository in front of you.

   **But search again before you accept it.** This skill used to say *"You already dispatched the
   archaeologist for this question in this turn. Once is enough."* That sentence, plus a retrieval
   layer that returned noise, meant the first search was the only search and the skill forbade the
   retry that would have worked with better keywords. It is deleted. The rule now:

   > **Search up to three times, with different nouns each time.** Drop a time word — people
   > misremember by weeks. Drop the project. Try the thing next to the thing. Stop at three, or
   > the moment `confidence` comes back `strong`. Repeating the *same* query is what is pointless;
   > trying a different one is the job.

3. **Get the words.** You have two ways in and they are for different shapes of question.

   - **`potsherd_read`, yourself** — when one or two threads obviously hold it. Page the thread,
     quote it exactly. Cheap, immediate, and you keep the judgement.
   - **`potsherd_recall` with `want: "context"`** — when you want breadth: the matching exchanges
     from across every thread, in one call, no second round trip.
   - **Dispatch the `session-archaeologist`** — when the honest answer is *six transcripts, and I
     do not want six transcripts in this conversation*. That is what it is for: it opens them,
     hands back cited excerpts, and its bulk never touches your context.

     It is a **windowing** agent. It returns `EXCERPTS`, not conclusions, and it is told in its own
     prompt that a sentence which is not a quote or a label on a quote gets deleted. If it hands
     you something that reads like a verdict, that is a defect — use its quotes and ignore its
     verdict. **You** decide what the archive means. Give it: the user's question in their own
     words, the cue they used, quoted, today's date and the current project name **as context and
     not as filters**, and anything already narrowing it.

4. **Answer from what you found, and only from that.**

## how to use what comes back

- **Carry the citations through, and do not write one.** Every row and every excerpt carries a
  `citation` string that potsherd built from its own index — `<id8> · <project> · <harness> ·
  <n> exchanges · <date>`. Copy it. "You decided this on 4 July, in `event-bus`, session
  `<id8>`" is the sentence the user came for; "I remember we decided this" is the sentence that
  makes the whole archive worthless.

  **A source line you compose yourself is not a citation.** potsherd refuses, in code, any source
  line whose id does not resolve against its index — a file path, a dash, an id you inferred. The
  audit that produced this rule found both archaeologist runs citing repository markdown in the
  correct citation format with the id field left blank, and a fabricated date two months wrong. A
  citation format that accepts unverified rows is worse than no format, because it converts a
  guess into something that reads like a receipt.

- **Its quotes are the user's own words.** Reproduce them as quotes. Do not smooth them.
- **A ghost is prompts only.** If a row says `ghost, prompts only`, the assistant side of that
  session was deleted by the 30-day sweep and is not recoverable. You may say what was *asked*.
  You may not say what was answered or what was done, however obvious it seems.
- **A card is not evidence.** A row marked `evidence: "not-a-transcript"` matched a generated
  summary, not the conversation. Use it to decide which thread to open; never quote it as
  something the user said.
- **A thread may be longer than it looks.** If `potsherd_read`'s `thread.via` is `session-only`,
  this build does not model fork/resume chains yet and you are holding one link. Say so rather
  than reporting a four-exchange stub as a month of work.
- **Never add a claim you did not bring back.** If the archive is thinner than the user hoped,
  that is the true state of the archive. Offer `/potsherd ask "<their question>"` — the human CLI
  verb, which the user runs — as the deeper, slower search rather than inventing the difference.

## when not to use this

- The user is asking about **this** conversation. Scroll up.
- The user is asking about **the code in front of you**. Read the code.
- The user is asking a general question with no "earlier" in it.
- `confidence` came back `none` three times, on three different queries. Then it is not there, and
  saying so is the answer.

## if it comes back with no tools

`potsherd_recall`, `potsherd_read` and `potsherd_graft` come from the potsherd MCP server. If they
are not in your tool list, the plugin's MCP server is not connected — tell the user to check
`/mcp`, and offer `/potsherd find <words>`, which runs the bundled binary directly and does not
need the server.
