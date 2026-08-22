# potsherd v1.1.0

Claude Code deletes your session transcripts after 30 days. It does not tell you.

On the machine potsherd was built against, **330 sessions had ever been started
and 31 were still on disk** — 299 gone, taking 2,971 prompts and 33 whole
projects with them. potsherd archives what survives, reconstructs what did not
from `history.jsonl`, and makes the whole thing searchable.

## what it does

- **`audit`** — how much you have already lost, and when the next sweep runs.
- **`rescue`** — a byte-exact copy of every transcript still on disk, plus a
  "ghost" of every deleted session rebuilt from the prompts you typed.
- **`index` · `find` · `show`** — full-text search across Claude Code, Codex,
  Cursor and pi, including subagent transcripts. Offline; no model, no network.
- **`ask`** — a question answered from your archive, where **every sentence
  carries a citation and a sentence whose citation does not resolve is dropped
  before you see it.**
- **`graft`** — carry a past session into the agent you are in now.
- A **Claude Code plugin** and an **MCP server** (6 tools), so an agent can
  search your history itself instead of telling you it has no memory.

## what it does not do

- **No auto-injection.** Nothing is added to your context without you asking.
- **No server, no account, no telemetry.** It is a local binary and a SQLite file.
- **No knowledge graph.** It is an archive and a search index.
- **No network by default.** Model calls happen only in `card`, `ask` and
  `graft`, only when you run them, and every outgoing string is redacted first
  — there is no `--no-redact` flag.

`potsherd doctor --privacy` prints every path it reads, every path it writes,
which verbs open a socket, and what leaves the machine. CI fails if that receipt
drifts from what the program actually does.

## install

```bash
npx potsherd audit
```

Or as a Claude Code plugin:

```
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd@potsherd
```

## new in 1.1.0

The full list is in [CHANGELOG.md](../../CHANGELOG.md). The four that change
what the first five minutes feel like:

- **`index` is offline by default.** It used to fetch a 32 MB model and take
  6m 44s. It is 9.6 s now; semantic search is an explicit `index --embed`. A
  fresh-`$HOME` walk of `audit → rescue → index → ls → find` completes in
  **12.3 s** on an idle machine with the network denied — median of three runs;
  an independent re-run of the same walk measured 14.5 s, and under load it has
  measured 24.6–65.0 s. The target was 30 s.
- **Recovered sessions have readable names.** 165 of 299 used to display as
  `/resume`, `/model` or `clear`. Zero do.
- **`potsherd ignore <project>`** keeps a repository out of `ls`, `find`, `ask`
  and `stats` — and every surface says how many rows it is hiding.
- **`ask` shows its readers arriving** instead of one blind spinner, and
  **`ask --cheap`** costs about half as much. It is not faster, and it says so:
  it was called `--fast` until it was measured against a control.

## the part that matters

**The claim is not "a search tool". The claim is that potsherd's output can be
checked.**

- Every `ask` answer cites the exchanges that support it, and **every quote is
  re-checked, in code, as an exact substring of the stored exchange at the
  sequence number it claims** — not by asking a model whether it looks right. A
  sentence whose citation does not resolve is dropped before you see it.
  The check is against potsherd's own archived, redacted copy of the transcript,
  which for the 91% of sessions the harness has already deleted is the only copy
  there is.
- **Every number this project prints is measured or labelled `est.`**
- `potsherd audit --verify` prints **standalone Python that recomputes its own
  headline numbers**, so nobody has to trust potsherd to check potsherd. It
  shares no code with the tool. In this release it disagreed with the product by
  three on a real archive, and that was found, fixed, and pinned by a test
  before the tag.

## credit

potsherd's search is a fork of
[episodic-memory](https://github.com/obra/episodic-memory) by Jesse Vincent
(MIT). What was taken, what was adapted and what was refused is in
[`docs/upstream/PORT-LOG.md`](../upstream/PORT-LOG.md), and the upstream
revision is recorded in [NOTICE](../../NOTICE).

## verified at this tag

```
1,532 tests, 38 files · macOS and Ubuntu × Node 22 and 24
the same suite again on Node's own SQLite (POTSHERD_SQLITE=node)
privacy guard: 510 files swept, 0 pinned violations, 25 probes, 29 unaccounted ids (ceiling 29)
evals: recall@5 hybrid 22/25, recall@1 hybrid 11/25 — the gate passes and can still fail
```

MIT.
