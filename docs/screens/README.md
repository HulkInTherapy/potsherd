# screens

Verbatim stdout from the `potsherd` binary at `--width 80 --no-color`. Nothing here is written, aligned, trimmed or prettified by hand; regenerate every file with `bash scripts/make-screens.sh`.

| file | command | what it is for |
|---|---|---|
| `01-audit.txt` | `audit` | the shock: what is gone, and what goes next |
| `02-rescue.txt` | `rescue --yes` | the relief: what was copied and rebuilt |
| `03-audit-after.txt` | `audit` | the same card once the sweep is off |
| `04-doctor.txt` | `doctor` | parse coverage, per-harness, and every unconsumed record type |
| `05-doctor-privacy.txt` | `doctor --privacy` | every path read, every path written |
| `06-audit-sweep.txt` | `audit --sweep` | the sessions the next sweep takes, by name |
| `07-index.txt` | `index --full --no-embed` | four adapters, redaction, ghosts, fts5 — no model, no network |
| `08-ls.txt` | `ls` | the archive by title, newest first |
| `09-find.txt` | `find pgbouncer` | one live session, three the sweep deleted, one subagent |
| `10-stats.txt` | `stats` | what the index holds and how fresh it is |
| `11-show.txt` | `show 9c4d2f18` | one session end to end |
| `12-ls-ghosts.txt` | `ls --ghosts only` | only what the sweep took, still legible |
| `13-find-redacted.txt` | `find "redacted aws"` | a masked credential, still searchable |
| `14-ask.txt` | `ask "…prepared statements behind the pooler?"` | ANSWER / EVIDENCE / OPEN THREADS, with the catch |
| `15-graft.txt` | `graft 9c4d2f18 --about pgbouncer --no-model` | the re-entry brief, and where it was written |

The file numbers are the order the readme reads them in, which is not the capture order: every screen reports on the state the one before it left. `index` runs before anything that searches; both `doctor` screens come after those, so they report a populated index rather than "nothing indexed yet"; and `ask` and `graft` come last of all, because both need cards and a card would put a model-written title on the `ls` and `find` screens above them.

## the two screens that need a model

`14-ask.txt` and `15-graft.txt` are the only ones here that are not offline. Both need a **card**, and a card is a model call; `ask` additionally makes its reader and synthesizer calls at capture time. `scripts/make-screens.sh` cards all 31 surviving transcripts first — 39 calls, about six and a half minutes — and skips both screens, keeping the committed copies and saying so, on a machine with no backend (or with `POTSHERD_SCREENS_NO_MODEL=1`). They are still asserted either way.

They are also the two screens with a wrinkle the others do not have. Everything else runs with `HOME` pointed at the demo corpus, which is what makes every path render as `~`; a model call cannot, because on every subscription path the harness's login lives under the *developer's* `HOME` and inside the demo one `claude -p` answers `Not logged in`. So `card` and `ask` run with `HOME` left alone and `--potsherd-dir` / `--claude-dir` pointed at the demo corpus instead — safe, because neither prints a path belonging to the machine it ran on: the only paths on an `ask` screen are the corpus's own `/home/dev/<name>` project directories, which is how `open-threads.ts` names a project. `graft` does print one (the brief it just wrote, in the directory you ran it in), so it stays under the demo `HOME` and takes `--no-model`: the stored card verbatim, labelled unsummarised. A model-path brief is the better screen — it is shorter and reads as prose — and it cannot be had at the same time as a `~` on that line.

## why a demo corpus

`scripts/make-screens.sh` points `HOME` at a throwaway directory holding a **demo corpus** ([`scripts/make-demo-corpus.mjs`](../../scripts/make-demo-corpus.mjs)) rather than at anyone's real `~/.claude`.
The corpus is synthetic — invented project names, generated prompts, `/home/dev` paths — but its counts are the ones measured on the reference machine on 21 aug 2026, so the headline numbers on these screens are the real ones and none of the private data behind them is published.

Phase 1 added content as well as counts, because a search screen taken over independently generated prompts is a screenshot of coincidences. One thread runs through the corpus — a connection-pooling decision taken in a project the sweep has since wiped, reused twice, and needed again today — and it is what `09-find.txt` and `11-show.txt` are about. Every line of it was written for that generator; none of it came from a transcript. It is planted by *overwriting* prompt text, so no headline count can move.

Phase 4 added the other side of that thread, for the same reason. `ask`'s open-thread pass answers *"decided in A, never seen in B"*, and it can only answer it when the corpus holds such a pair. Everything the corpus had was one thread and its own history — the projects the sweep wiped had already decided the same thing, which is a *closed* thread, and the rule pass is right to raise nothing from it. So `event-bus` also runs postgres workers behind the same pooler and reached it from the other end: it ran out of connections, moved its consumers behind the pooler, sized the pool and put a timeout on acquiring one. It never asked what transaction pooling *breaks*, so nothing in it mentions prepared statements. The word `pgbouncer` does not appear in it either, deliberately — `09-find.txt` is a screen about one live hit and three ghosts, and these two projects share no search vocabulary at all, which is the point: nothing a text query returns would have connected them.

The corpus also leaks five generated credentials, in the two places credentials really reach a transcript: a `cat .env` and a CI log, plus one connection string pasted into a prompt. Without them `index` would print "secrets masked 0", which demonstrates nothing. `13-find-redacted.txt` is what the index kept of them.

The one figure the corpus does not reproduce is size: half a megabyte against the reference machine's 329 MB, and the readme says so where it matters.

## what moves between captures, and what must not

Three things are expected to change from one run to the next, and are real output rather than captions:

- the date in every heading, from the system clock;
- the node version in `04-doctor.txt`;
- the wall times printed by `index`, `find` and `stats`.

The readme quotes these screens verbatim, so a regeneration can leave its code blocks a millisecond or two out of date on those three wall-time lines and nothing else. Sync them when you regenerate.

Everything else is byte-identical between consecutive runs — except the two model screens. `14-ask.txt`'s ANSWER, its open-thread notes, how many threads survive and its wall time differ every capture. `15-graft.txt` is `--no-model`, but what it prints verbatim is the stored *card*, which a model wrote, so re-carding rewords its title and its four decisions too. Neither is diffed; what must not change about them is asserted instead.

### what makes the script fail

`scripts/make-screens.sh` **fails** if:

- any screen has a line over 80 characters. `15-graft.txt` is the one exception, and only below the `─` rule: `graft` prints the brief byte for byte as it wrote it to `./.potsherd/graft-<id8>.md`, because the thing you read and the thing you paste into an agent cannot be two different strings. The brief is markdown for a model, not a table for a terminal, and its lines run long. The receipt above the rule is held to 80 like everything else.
- a screen or `README.md` contains a real project name or a `/Users/` path;
- an unredacted credential of any planted shape reaches a page;
- any line of any screen, or of `README.md`, carries an unbalanced `‹` or `›`. Those two characters are reserved for the redaction and elision markers and cannot occur in base64, in a shell token or in a json key, so an unbalanced one is a mask that was cut in half — which is how `13-find-redacted.txt` came to publish `postgres://ingest:‹redacted…` for three phases;
- `04-doctor.txt`'s heading does not name the version the binary prints, or its `database` line does not name the schema the store migrates to. Those are the only two numbers on that screen that describe the build rather than the corpus, and both had been stale since phase 2. A CI step asserts the same two without a capture;
- `09-find.txt` loses its live row, its ghost rows, its `↳ subagent` line, its subagent count or the "assistant side not recoverable" line;
- `13-find-redacted.txt` comes back with no mask on it;
- `14-ask.txt` has no `OPEN THREADS` block, no `possible open thread` label, no `not seen in`, or an open thread that cites no exchange a reader can open. A capture where the model confirms nothing produces a screen with no catch on it, and that must fail rather than be committed as a screenshot of the feature;
- `15-graft.txt` has no `source:` line or does not say where the brief was written.
