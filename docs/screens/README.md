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

The file numbers are the order the readme reads them in, which is not the capture order: every screen reports on the state the one before it left, so `index` runs before anything that searches, and both `doctor` screens are captured last so they report a populated index rather than "nothing indexed yet".

## why a demo corpus

`scripts/make-screens.sh` points `HOME` at a throwaway directory holding a **demo corpus** ([`scripts/make-demo-corpus.mjs`](../../scripts/make-demo-corpus.mjs)) rather than at anyone's real `~/.claude`.
The corpus is synthetic — invented project names, generated prompts, `/home/dev` paths — but its counts are the ones measured on the reference machine on 21 aug 2026, so the headline numbers on these screens are the real ones and none of the private data behind them is published.

Phase 1 added content as well as counts, because a search screen taken over independently generated prompts is a screenshot of coincidences. One thread runs through the corpus — a connection-pooling decision taken in a project the sweep has since wiped, reused twice, and needed again today — and it is what `09-find.txt` and `11-show.txt` are about. Every line of it was written for that generator; none of it came from a transcript. It is planted by *overwriting* prompt text, so no headline count can move.

The corpus also leaks five generated credentials, in the two places credentials really reach a transcript: a `cat .env` and a CI log, plus one connection string pasted into a prompt. Without them `index` would print "secrets masked 0", which demonstrates nothing. `13-find-redacted.txt` is what the index kept of them.

The one figure the corpus does not reproduce is size: half a megabyte against the reference machine's 329 MB, and the readme says so where it matters.

## what moves between captures, and what must not

Three things are expected to change from one run to the next, and are real output rather than captions:

- the date in every heading, from the system clock;
- the node version in `04-doctor.txt`;
- the wall times printed by `index`, `find` and `stats`.

The readme quotes these screens verbatim, so a regeneration can leave its code blocks a millisecond or two out of date on those three wall-time lines and nothing else. Sync them when you regenerate.

Everything else is byte-identical between consecutive runs. `scripts/make-screens.sh` **fails** if any screen has a line over 80 characters, if a screen or `README.md` contains a real project name or a `/Users/` path, if an unredacted credential of any planted shape reaches a page, if `09-find.txt` loses its live / ghost / sidechain rows or the "assistant side not recoverable" line, or if `13-find-redacted.txt` comes back with no mask on it.
