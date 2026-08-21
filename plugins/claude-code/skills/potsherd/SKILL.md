---
name: potsherd
description: Run potsherd against your own archive of past coding-agent sessions — audit, rescue, index, ls, find, show, ask, graft, tag, pin, link, card, stats, doctor.
argument-hint: <verb> [args]
arguments: verb rest
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/potsherd *), Read
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

Inside Claude Code you do not have to pay that. Run the shortlist with the binary and the readers
with **your own Agent tool**, in parallel, in a single message. That is what `03` §8 means by
*"or inside claude code the native Agent tool via the skill"*.

**Route to the binary instead — `BIN ask "<question>" $rest` — when any of these is true:**
`$rest` contains `--strict`; the user asked for the citation-checked answer; the user wants
`--json`; or you ran the fast path and it produced nothing. Say that it will take a minute or two
before you start it.

Otherwise:

### 1. shortlist — the binary, no model, well under a second

```
BIN find "<the question>" --json --limit 6 --vectors on
```

`--limit 6` and `--vectors on` are not decoration. `recall` derives its candidate depth from
`limit`, so a wider limit silently re-orders the top six — measured, in `ask.ts`. And `ask`
defaults vectors **on** where `find` defaults to `auto`. Those two flags are what make this
shortlist the same shortlist `BIN ask` would have used. Do not change them.

Exit 1 means nothing matched. Say so, offer one narrower and one wider phrasing, and stop.

### 2. targets — at most six

Walk `sessions[]` in the order returned. For each, collect the distinct `hits[].sessionId`
values, highest `score` first, and append them. Stop at six distinct session ids.

**Use `hits[].sessionId`, never the block's `id`.** A block is a *conversation*: `recall` files a
parent and its subagents together. A subagent is indexed as its own session, and the hit that
matched may be the subagent's. Taking the block id hands a reader the wrong transcript and puts
the wrong session id on the answer.

A block that matched only on its title or its card has no hit with a `seq`. It is still worth
reading: use its own `id`.

### 3. excerpts — one command per target

```
BIN show <sessionId> --json --from <lo> --to <hi>
```

`lo = max(1, lowest hit seq − 1)`, `hi = highest hit seq + 1`, widened outward to at most **six**
exchanges. No seq at all (title or card match): `--from 1 --to 4`.

Note whether the response says the session is a ghost (`ghostPrompts` is present and
`exchanges` is empty). That changes the reader's contract.

### 4. readers — one Agent per target, all dispatched in one message

Dispatch them **together**, in a single message with one Agent tool call per target, so they run
in parallel. Six sequential agents is the slow path you came here to avoid.

Give each agent the excerpts inline — it must not have to go and fetch them — and this contract,
which is `READER_SYSTEM` from `packages/core/src/ask.ts`, quoted so the readers here behave
exactly as the readers there do:

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

For a **ghost** target, append:

> These excerpts are PROMPTS ONLY. This session was deleted by Claude Code's 30-day sweep and
> rebuilt from history; the assistant's replies are gone and are not recoverable. You may say
> what was asked. You may not say, or imply, what was answered or what was done.

Also tell each agent the question, the session's `id8`, its project, its harness, whether it is a
subagent transcript, and the list of citable seq numbers. A reader may cite no seq that is not on
that list.

An agent that fails is one session that contributed nothing — not a failed run. Note it and
carry on with the rest.

### 5. check every quote, then answer

Before a quote reaches the screen, find it in the `show --json` output you already hold for that
`sessionId` and that `seq`. Ignore differences of whitespace, case and quote glyphs; nothing else.
**Drop any quote you cannot locate, and drop any sentence whose only support was a dropped
quote.** Do not repair a near-miss into a match.

Then print:

```
ANSWER
  <at most ~120 words. every sentence carries an evidence number.>

EVIDENCE
  [1]  <id8>  seq <n>  <date>   "<the quote, ~90 chars then …>"
  [2]  <id8>  seq <n>  <date>   "<…>"

  read six sessions in <n>s · quotes checked against the excerpts above, not by potsherd's
  citation filter — for the code-checked answer, run:  potsherd ask "<the question>"
```

That last line is not optional and it is not a disclaimer to soften. The binary's `ask` verifies
every citation **in code**, after the model has replied, and drops what does not resolve. This
fast path verifies them by reading. It is roughly six times quicker and it is a weaker guarantee,
and the user is entitled to know which one they just got.

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
