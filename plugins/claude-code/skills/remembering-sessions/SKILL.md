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
description: Use BEFORE answering anything that refers to work done earlier, and BEFORE saying you do not know or were not there. Triggers on "last time", "before", "we discussed", "why did we", "what did we decide", "remind me", "in the other project", and on any question that assumes a shared history you have no record of. Searches every past Claude Code, Codex, Cursor and pi session on this machine — including subagent transcripts and the sessions the 30-day sweep deleted — and returns an answer with session ids and dates.
# ===========================================================================
user-invocable: false
# `allowed-tools` is deliberately absent. It PRE-APPROVES the tools it lists and
# does not restrict anything, so the only thing it could buy here is skipping a
# prompt on the Agent tool — and the docs say skills cannot declare Agent. An
# invented entry would be dead weight in a field whose whole job is to be exact.
#
# ALTERNATIVE DISPATCH, if the body-instructed dispatch below does not fire.
# Uncomment all three together. This runs the body inside the archaeologist
# rather than asking the model to reach for the Agent tool; `background: false`
# matters, because the default is true and an async answer arrives after this
# turn has already been answered.
# context: fork
# agent: session-archaeologist
# background: false
---

# remembering sessions

The user has referred to something that happened before this conversation. It is in their
archive, not in your context. Go and get it — do not reconstruct it, and do not tell them you
were not there.

## do this

1. **Dispatch the `session-archaeologist` agent.** One agent, one question. Do not run the
   search yourself: the agent holds the read-only potsherd tools, it is haiku-class, and it
   keeps six searches and three transcripts out of this conversation's context.

   Pass it, in this order:
   - the user's question **in their own words** — not your restatement of it;
   - the cue they used, quoted ("they said 'last time'", "they said 'why did we'"), because the
     cue tells the agent whether they mean one session or a run of them;
   - the current project directory name and today's date, so it can read "last month" — and a
     warning not to *filter* on either, because the answer is often in a different project;
   - anything in this conversation that already narrows it: a file path, a library, a branch.

2. **Wait for it.** Do not answer in parallel and do not fill the silence with a guess. A
   `find` comes back in well under a second; the agent will only be slow if it had to fall
   through to `potsherd_ask`, which is ~100 s and which it is told to avoid.

3. **Answer from what it returned, and only from that.**

## how to use what comes back

- **Carry the citations through.** The agent returns `SOURCES` lines shaped
  `<id8> · <project> · <harness> · <n> exchanges · <date>`. Put the id8 and the date next to the
  claim they support. "You decided this on 4 July, in `<project>`, session `9c4d2f18`" is the
  sentence the user came for; "I remember we decided this" is the sentence that makes the whole
  archive worthless.
- **Its quotes are the user's own words.** Reproduce them as quotes. Do not smooth them.
- **A ghost is prompts only.** If a source line says `ghost, prompts only`, the assistant side of
  that session was deleted by Claude Code's 30-day sweep and is not recoverable. You may say what
  was *asked*. You may not say what was answered or what was done, however obvious it seems.
- **`NOT FOUND` is an answer.** Say it plainly — "I searched your history three ways and it is
  not there" — and say what was searched. Then answer from your own knowledge if you can, clearly
  labelled as *not* from their history. Never present the two as one thing.
- **Never add a claim the agent did not bring back.** If its answer is thinner than the user
  hoped, that is the true state of the archive. Offer `/potsherd ask "<their question>"` as the
  deeper, slower search rather than inventing the difference.

## when not to use this

- The user is asking about **this** conversation. Scroll up.
- The user is asking about **the code in front of you**. Read the code.
- The user is asking a general question with no "earlier" in it.
- You already dispatched the archaeologist for this question in this turn. Once is enough; a
  second dispatch on the same question returns the same thing.

## if it comes back with no tools

The agent's tools come from the potsherd MCP server. If it reports that it has none, the plugin's
MCP server is not connected — tell the user to check `/mcp`, and offer `/potsherd find <words>`,
which runs the bundled binary directly and does not need the server.
