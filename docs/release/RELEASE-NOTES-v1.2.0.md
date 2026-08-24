# potsherd v1.2.0

An agent audited potsherd on its own 428 MB archive and scored it **4 out of 10**.

It was trying to answer the question potsherd exists for — *where did we leave off on this
project* — and it failed, then got the complete answer in about ten minutes with `grep`, `find`
and forty lines of Python. The audit is in the repository as
[`docs/AGENT-AUDIT-2026-08-23.md`](../AGENT-AUDIT-2026-08-23.md), unedited except that the session
ids and project names are replaced by placeholders. Its verdict:

> potsherd has solved the hard, unglamorous half — *getting the corpus, intact, including what
> Claude Code deleted* — and then hands it to the agent through a retrieval layer that cannot tell
> a match from noise, and a model layer that isn't installed.

**This release is that fix list.** Nothing in the archive half changed; it was already the good
part. Everything an agent touches did.

## the four things that were actually wrong

**`find` could not return nothing.** Its score came out of reciprocal rank fusion, which is a
function of *rank alone* — by the time the number existed, how well anything matched had already
been thrown away. So a topic the archive had never heard of scored within 12% of a genuine phrase
hit, and the tool answered every question with the same confidence. There is now a second,
independent axis computed from the raw per-list evidence, and a floor: **a query the archive cannot
answer returns zero rows and says so.** Both surfaces, human and agent.

**Three of six verbs needed a 677 MB dependency to run at all.** `ask`, `card` and `graft` now use
the subscription you already have — the host agent first, then the `claude` or `codex` binary you
installed to get here — with the SDK used only if it happens to be present. No key, no tier, no
flag. Semantic search acquires its runtime by itself, in the background, on first use.

**Sessions are chains, and potsherd treated them as documents.** A fork or a `--resume` starts a new
file that shares most of its history with the old one; potsherd indexed the file. On the audit's own
fixture that meant a session displayed as **4 exchanges dated three weeks before its own first
message**, while 119 more sat one hop away. The **thread** is the unit now, and work is dated by its
content rather than by the fork it inherited. The same fixture reads 123 exchanges across 2
sessions, spanning the eight days it actually covers.

**The subagent sent to search the archive fabricated its citations** — it returned repository
filenames dressed in the citation format, and invented a project start date a month off. It has
`Read` taken away from it, and **a citation that does not resolve against the index is now refused
in code**, along with the sentence resting on it. Not asked about. Refused.

## what an agent sees now

Six MCP tools became **three**, disjoint, and none of them needs a filesystem read:

- **`potsherd_recall`** — search. Returns hits ordered so the first row is the best row, each
  labelled with how well it actually matched, and **nothing at all when there is nothing**.
- **`potsherd_read`** — read a thread, paginated, across the link boundary, with per-page citations.
- **`potsherd_graft`** — carry a past thread into the session you are in now.

Three properties are worth stating plainly, because they are what the release is for:

- **A summary can never testify.** A session that matched only on its title — and Claude Code writes
  those titles with a model — is capped, sorted behind anything with a real transcript hit, and
  carries no citation at all. The same is true of session cards. They route; they are not evidence.
- **Silence is an answer.** When the archive does not contain something, the tool says so, and says
  which half of the search produced that verdict. If only keyword search ran because the vectors are
  still warming, it says that too — and if *nothing* is warming, it says that instead of telling the
  reader to wait.
- **No string an agent reads asks it to run a shell command.** It has three tools and no shell. This
  was wrong in four separate places at the start of the phase.

## what did not change

- **No auto-injection.** Nothing enters your context unless you ask.
- **No server, no account, no telemetry.** A local binary and a SQLite file.
- **No opt-in quality.** There is no tier, no flag that unlocks a better answer, and nothing to
  configure. A capability the tool needs, it acquires.
- **No `--no-redact`.** Every string that leaves the machine is redacted first, and there is no way
  to turn that off.

`potsherd doctor --privacy` prints every path it reads, every path it writes, which verbs open a
socket, and what leaves the machine. CI fails if that receipt drifts from what the program does —
and, since this release, if the copy of it published in the README drifts from the receipt.

## install

```bash
npx potsherd audit
```

Or as a Claude Code plugin:

```
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd@potsherd
```

## upgrading from 1.1.0

One behaviour change worth reading before you upgrade:

- **`ask --synthesis-out <path>` now refuses without `--readers-in`.** Its help text said it made no
  model call, and on its own it made one per shortlisted session. The composed form — `--readers-out`
  to run the readers, then `--readers-in … --synthesis-out …` — is the free one, and is what every
  document printed. A script calling the flag alone now gets an error naming the two commands that
  produce the same file for nothing.

Everything else is additive. The index migrates itself.

## the part that matters

**The claim is not "a search tool". The claim is that potsherd's output can be checked** — and this
release is the first one where that claim was tested by something other than its authors.

Independent verifiers — five of them, none of whom wrote any of it — re-ran the audit's own command
list on the real archive and re-scored its rubric. The first four **found twenty-seven defects the
authors had reported as green**, including three of the worst in the project's history: a tool that
could not see a thread in the release that claimed to fix threads; a citation minted for a session
whose transcript nobody had read; and a capability failure that reported itself as an honest empty,
in the one place the whole design asks an agent to trust silence.

Every one of them is in the repository, with the command that found it. So is every score, including
the ones that failed the gate.

- Every `ask` answer cites the exchanges that support it, and **every quote is re-checked, in code,
  as an exact substring of the stored exchange at the sequence number it claims.** A sentence whose
  citation does not resolve is dropped before you see it.
- **Every number this project prints is measured or labelled `est.`** Two numbers in this release
  turned out to be measurements of the wrong thing, and both were fixed rather than restated: a
  search score that measured a row's rank rather than how well it matched, and a database size that
  measured how much had been written back to disk rather than how much was in the database.
- `potsherd audit --verify` prints **standalone Python that recomputes its own headline numbers**, so
  nobody has to trust potsherd to check potsherd. It shares no code with the tool.

## credit

potsherd's search is a fork of [episodic-memory](https://github.com/obra/episodic-memory) by Jesse
Vincent (MIT). What was taken, what was adapted and what was refused is in
[`docs/upstream/PORT-LOG.md`](../upstream/PORT-LOG.md), and the upstream revision is recorded in
[NOTICE](../../NOTICE).

## verified at this tag

```
1,932 tests, 53 files · macOS and Ubuntu × Node 22 and 24
the same suite again on Node's own SQLite (POTSHERD_SQLITE=node) — 1,932, 0 skipped
privacy guard: 586 files swept, 0 pinned violations, 25 probes, 19 unaccounted ids (ceiling 19)
evals: 60 queries — recall@5 hybrid 51/60 vs bm25 40/60 (p = 2.4e-7), recall@1 hybrid 27/60,
       strictly above both single rankers, and the set still fails at --vector-weight 0
published npm package built by GitHub Actions with a sigstore provenance attestation
```

MIT.
