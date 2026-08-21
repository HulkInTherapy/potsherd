---
name: potsherd
description: Run potsherd against your own archive of past coding-agent sessions — audit, rescue, index, ls, find, show, ask, graft, tag, pin, link, card, stats, doctor.
argument-hint: <verb> [args]
arguments: verb rest
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/potsherd *), Read, Write
---

# /potsherd

The user typed `/potsherd $verb $rest`.

## the binary

Every command below runs **`${CLAUDE_PLUGIN_ROOT}/bin/potsherd`**, written out in full. Call it
`BIN` when reading these instructions; type the real path when running one.

Never run a bare `potsherd`. The copy on `PATH` may be a different version, or absent, and a verb
that silently ran the wrong build against the user's archive is worse than one that did not run.
This is the same reason `potsherd guard` writes an absolute `node "<path>"` into its hook.

If `$verb` is empty, run `BIN` with no arguments — that prints the tour — and stop.

`Read` and `Write` are here for one thing only: the `ask` round trip below reads the file
`ask --readers-out` wrote and writes the reader outputs back into it. Do not read or write
anything else.

## how to report

**Print what the binary printed.** Every verb of this tool is designed to be read as it stands:
80 columns, one accent colour, and a last line that names the next verb. Do not reformat it into
a bullet list, do not re-order the numbers, do not drop the last line. Add at most one sentence of
your own, after the output, and only when you have something to add that the output does not say.

If a verb exits non-zero, show the error it printed. Its second line is the command that fixes it.

## routing

| `$verb` | run | then |
|---|---|---|
| `audit` | `BIN audit $rest` | print it. This is the number the user came for. |
| `rescue` | see **rescue and guard** below | |
| `guard` | see **rescue and guard** below | |
| `index` | `BIN index $rest` | print it |
| `ls` | `BIN ls $rest` | print it |
| `find` | `BIN find "$rest"` | print it. Quote the query; it is one argument, not several. |
| `show` | `BIN show $rest` | print it. Long sessions: suggest `--from`/`--to`. |
| `ask` | see **ask** below | |
| `graft` | see **graft** below | |
| `tag` | `BIN tag $rest` | print it |
| `pin` / `unpin` | `BIN $verb $rest` | print it |
| `link` | `BIN link $rest` | print it |
| `card` | `BIN card $rest` | print it. It may run for a long time; say so before starting. |
| `stats` | `BIN stats $rest` | print it |
| `doctor` | `BIN doctor $rest` | print it |

Anything else: run `BIN $verb --help`. If that fails, run `BIN` and show the tour.

Filters (`--project`, `--since`, `--until`, `--harness`, `--tag`, `--branch`, `--file`,
`--pinned`, `--ghosts`, `--sidechains`, `--status`, `--limit`) pass straight through on `find`,
`ls`, `ask` and `card`. Pass them exactly as the user typed them; do not add filters they did not
ask for, and in particular do not add `--project` because you happen to be in a repository. The
archive's value is that the answer is often somewhere else.

---

## graft — read the brief into context

This is the verb the plugin exists for, so do not just print it and stop.

1. Run `BIN graft $rest`. If `$rest` names no session, ask which one, or offer
   `BIN find "<words>"` first — `graft` also accepts a query in place of an id.
2. It writes `./.potsherd/graft-<id8>.md` in the current directory and prints the brief. Print
   what it printed.
3. **Then read the file with the Read tool and keep it.** That is the whole point: from here on,
   what that session established is context you have, not a document you saw. The brief is
   budgeted (1,200 tokens by default) precisely so it can live in context.
4. Say one line naming what you now know and where it came from — the brief's own last line is
   `source: <harness> <id> · <n> exchanges · <date>`, so use that. Then carry it into everything
   that follows in this conversation.

`--about <topic>` narrows the brief to one subject; `--budget <n>` changes the ceiling;
`--no-model` returns the stored card verbatim with no model call at all.

---

## ask — the reader fan-out

`ask` is a shortlist of six sessions, one reader per session, and one synthesizer over what the
readers found. Run through the binary it takes **40–183 s, p50 about 100 s**, because each of
those seven calls goes out through the agent SDK.

Inside Claude Code you do not have to pay for the six. The binary has a seam for exactly this:

- `BIN ask "…" --readers-out <file>` records what the readers would be given and stops. It makes
  **zero model calls** — not "skips them", *cannot make one*: the recorder is passed in as the
  reader function, so no reader backend is constructed at all. It needs no `claude` binary.
- you run the six readers with **your own Agent tool**, in parallel, in one message, for free.
- `BIN ask "…" --readers-in <file>` makes the **one** synthesizer call, then runs the citation
  filter in code over its reply, dropping every quote that does not resolve against the live
  transcript bytes.

**That last clause is the whole point, and it is new.** Earlier versions of this route rebuilt the
shortlist by hand out of `find --json` and `show --json`, checked quotes by *reading* them, and
had to end every answer by admitting it was the weaker guarantee. `--readers-in` runs the same
`filterAnswer` the binary path runs. **Do not print a caveat about the citation filter, and do not
tell the user to re-run `potsherd ask` for a checked answer. They already have one.**

`--strict` and `--json` need no special case either: pass them straight through to the
`--readers-in` call and they behave exactly as they do on the binary path.

**Route to the plain binary — `BIN ask "<question>" $rest` — only when** you cannot dispatch
Agents. Say that it will take a minute or two before you start it.

### 0. build the flag string once, and the path once

Two things must be identical across the two calls or the replay refuses:

- **the filters.** `--readers-in` rebuilds the live shortlist and compares it to the recorded one;
  any difference at all — a `--project` on one call and not the other, a different `--k` — is a
  refusal, not a partial match. So decide `$rest` once and paste the same string into both
  commands. Pass the filters the user typed and no others.
- **the question**, character for character, including the quoting.

Pick one scratch path and reuse it: `/tmp/potsherd-readers-<four hex digits you choose>.json`.
Fresh digits each run, so two questions in one session cannot collide.

### 1. record — one command, no model call, no cost

```
BIN ask "<the question>" $rest --readers-out /tmp/potsherd-readers-<hex>.json
```

It prints the shortlist it recorded, one line per target, and `no model call was made (0)`. Print
that receipt. Exit non-zero, or `nothing matched`, means the shortlist is empty: say so, offer one
narrower and one wider phrasing, and stop.

Then `Read` the file. It is one JSON object:

| field | what it is |
|---|---|
| `question` | the question **as redacted for sending**. Use this in the reader prompts, not the raw one. |
| `k`, `sessionIds` | the shortlist. Do not edit either. |
| `targets[]` | one entry per session to read |

Each `targets[]` entry carries `sessionId`, `id8`, `project`, `harness`, `isSidechain`, `isGhost`,
`excerpts` (already windowed, capped and redacted) and `seqs` (the seq numbers a reader may cite).
Everything a reader needs is in there. **Do not run `find` or `show` yourself to build this** —
the binary derives the shortlist with `recall` tuned to `k`, and a hand-built one is a different
shortlist that `--readers-in` will reject.

### 2. readers — one Agent per target, all dispatched in one message

Dispatch them **together**, in a single message with one Agent tool call per entry in `targets`,
so they run in parallel. Six sequential agents is the slow path you came here to avoid.

Give each agent its target's `excerpts` inline — it must not have to go and fetch them — along
with `question`, `id8`, `project`, `harness`, whether it is a subagent transcript, and its `seqs`
as the list of citable seq numbers. A reader may cite no seq that is not on that list.

Then this contract, which is `READER_SYSTEM` from `packages/core/src/ask.ts`, quoted so the
readers here behave exactly as the readers there do:

> You are given one session's excerpts with seq numbers. Answer the question using only quotes
> from the excerpts. Output json {found: bool, quotes:[{seq, ts, text}], answer_fragment}. If the
> excerpts do not address the question, found=false and nothing else.
>
> Set found=true whenever any excerpt bears on the question at all — a partial answer, a related
> decision, the question being raised and left open, or evidence that the question's premise is
> wrong. Quote what is there and say what is missing in answer_fragment; do not withhold a real
> quote because it is not the whole answer. found=false is for excerpts that are about a
> different subject.
>
> Every quote must be copied character for character from an excerpt and must carry the seq
> number of the excerpt it was copied from. Do not paraphrase inside a quote. Do not quote from
> memory. A quote that does not appear in the excerpts is discarded by code before anyone reads
> it, and the claim it was meant to support is discarded with it. Two to four short quotes is the
> right size for an answer.

When the target's `isGhost` is true, append:

> These excerpts are PROMPTS ONLY. This session was deleted by Claude Code's 30-day sweep and
> rebuilt from history; the assistant's replies are gone and are not recoverable. You may say
> what was asked. You may not say, or imply, what was answered or what was done.

An agent that fails is one session that contributed nothing — not a failed run. Give it
`{"found": false, "quotes": [], "answer_fragment": ""}` in step 3 and carry on with the rest.

### 3. write the outputs back into the same file

`Write` the file back with one new top-level key, `outputs`: an array with **one entry per entry
in `targets`, in any order**, each of them the agent's JSON plus the `sessionId` it came from:

```json
"outputs": [
  { "sessionId": "<the target's sessionId, in full>",
    "found": true,
    "quotes": [{ "seq": 12, "ts": null, "text": "<copied character for character>" }],
    "answer_fragment": "<one or two sentences>" }
]
```

Change nothing else in the file. `question`, `k`, `sessionIds` and `targets` are what the replay
checks itself against; edit one and the run refuses.

### 4. answer — one model call, citations checked in code

```
BIN ask "<the question>" $rest --readers-in /tmp/potsherd-readers-<hex>.json
```

Same question, same `$rest`, same path. **Print what it prints** — the answer, the evidence lines,
the cost and timing footer — and add nothing. It has already dropped every quote that did not
resolve, and its footer already says how many sessions were read and what it cost.

If it refuses with a stale-file error, the filters or the question drifted between the two calls.
Re-record from step 1 rather than editing the file.

---

## rescue and guard

Both of these propose a change to `~/.claude/settings.json`, and that file belongs to the user.

- **Never pass `-y` / `--yes`.** Not to save a round trip, not because the user said "go ahead"
  earlier about something else.
- `rescue`: run `BIN rescue --no-settings`. That archives every surviving transcript and rebuilds
  the ghosts, and touches nothing of Claude Code's. Print the receipt. Then, if the receipt shows
  the sweep is still live, tell the user that `potsherd rescue` **in their own terminal** will
  show them the diff and ask before changing `cleanupPeriodDays`.
- `guard`: run `BIN guard --status`, print it, and if the hook is not installed tell them to run
  `potsherd guard` in their own terminal.
- If either verb reports *"needs a terminal to confirm"*, that is it working correctly. Relay it;
  do not work around it.

`BIN rescue --dry-run` is always safe and is the right thing to offer first when the user is
unsure.
