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

## what `find` does and does not answer — read this before you judge it

**potsherd answers questions asked in words the archive uses, and stays silent on questions asked
in words it does not.** Ask it about `pgbouncer` and it finds the session. Ask it *"database handles
ran out during heavy traffic"* about the same session and it returns nothing.

That is a real limit and this release does not fix it. The measurement, on a 60-query set built by
someone told nothing about which way any number should go: **the ranker puts the right session
first for 42 of 60 questions; `find` prints it for 7.** Fifty-two pages come back empty.

It is not a threshold that wants nudging — an exhaustive search over every scoring feature bounds
what any tuning could recover at 16 of 60. The cause is that a dense vector is blind to
composition: on a question the archive genuinely cannot answer, a *wrong* session reaches a higher
similarity than 90% of correct ones. Literal word overlap is the only evidence that separates the
two, which is exactly why silence is trustworthy here and exactly why paraphrase is lost. Closing
it needs term-level semantic matching — an index change, and the named target of the next release
(`phases/phase-12/FIRST-JOB.md`).

The same gap has a second face, and it is worth knowing before you trust a `weak`: **an invented
word alongside two ordinary ones can clear the floor**, because the scorer discards terms the index
has never seen — so the one distinctive word in the query is dropped before the bar is applied. A
fix exists and is measured; it is held back because on the small evaluation corpus it cannot tell a
made-up word from a real one that simply does not appear there. Same missing capability, same
target.

**What you get instead of a wrong answer:**

- an empty verdict that shows its work — the closest sessions appear under a rule that says
  *nearest by meaning · not an answer*, with nothing quotable and nothing to act on;
- `potsherd find --min-confidence none`, which prints what was withheld;
- and for an agent, `potsherd_recall`'s new `minConfidence`, so the tool told to trust the silence
  can ask what the silence hid.

The trade is deliberate. A tool that answers eight questions in ten and invents the ninth is worse
than one that answers seven and says so — that was the audit's own finding, and it is the reason
this release exists.

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

Independent verifiers — eight of them, none of whom wrote any of it — re-ran the audit's own command
list on the real archive and re-scored its rubric. The first seven **found fifty-seven defects the
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
2,038 tests, 55 files · macOS and Ubuntu × Node 22 and 24
the same suite again on Node's own SQLite (POTSHERD_SQLITE=node) — 2,038 on both, of which 4 are loud environment skips
privacy guard: 0 pinned violations, 25 probes, 19 unaccounted ids (ceiling 19)
evals, 60 queries, blind — the set was built by someone told nothing about which way
       any number needed to move:
         bm25 only     recall@5 40/60   recall@1 31/60
         vectors only  recall@5 57/60   recall@1 40/60
         hybrid        recall@5 57/60   recall@1 42/60   ← strictly above both
       and the set still fails, on two independent clauses, with the vector lists removed
       the same run reports what `find` returns, not only what the ranker finds: 7/60, with
       52 of 60 pages empty — the gap is stated on the screen and is the next release's target
ten published screens diffed against what this build actually prints, in CI
a database written by 1.1.0 upgraded and indexed, on both SQLite drivers, on a Node
       where the schema pragma is silently ignored and on one where it is not
published npm package built by GitHub Actions with a sigstore provenance attestation
```

MIT.
