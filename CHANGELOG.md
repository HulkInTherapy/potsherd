# changelog

Every entry is a tag. **Every number in this file was produced by a command
whose output is recorded under `phases/phase-N/`** — in that phase's
`HANDOFF.md`, its `VERIFICATION.md`, or a worker's evidence file beside them.

The rule used to name `HANDOFF.md` alone, which was too narrow in a way that
mattered: a figure measured by a phase's own verifier had nowhere legitimate to
be cited from, and one was rounded and restated instead of quoted. If a number
here cannot be traced to a file under `phases/`, it does not belong here.

## v1.2.0 — 24 August 2026 · the audit's fix list, and a tool an agent can act on

An agent audited potsherd on its own 428 MB archive and scored it **4/10**
(`docs/AGENT-AUDIT-2026-08-23.md`). It failed the task potsherd exists for —
*where did we leave off* — and then succeeded with `grep` and forty lines of
Python. This release is that fix list. Every number below is traceable to a
report under `phases/phase-10/`.

### `find` returns nothing when it has nothing

The fused score is **reciprocal rank fusion** — a function of rank alone, which
has already discarded how well anything matched by the time the number exists.
So the audit's own prescription, *normalise the score against its own
distribution*, could not work: it maps the top row to 1.0 whether it is a
bullseye or the least-bad of two bad rows.

Calibration is now a **second, independent axis**, computed from the raw
per-list evidence `recall.ts` was already carrying and throwing away:

    calibrated = coverage x (0.60 + 0.25*strength + 0.15*agreement)

The weights partition 1, which makes coverage a **ceiling**: nothing lifts a row
whose words are absent from it. Every row and every result carries
`confidence: strong | weak | none`, in the human view and in `--json` alike, and
below a floor `find` prints `no match` and returns **zero rows**. The agent-facing
MCP door runs at the same floor — an unlabelled least-bad row is
indistinguishable from an answer to a caller that cannot glance at the titles.

Measured on the real archive: a genuine phrase hit and a topic definitively
absent from it differed by **1.12x** before. Four freshly-invented absent-topic
controls now return `no match`; six true topics, including a natural-language
question, return `strong`.

### `ask`, `card` and `graft` run with no SDK and no API key

The model is the subscription you already have. Inside a coding agent, potsherd
emits the prompts and **the agent answers them** — `--synthesis-out` writes the
synthesis prompt, `--filter-in` takes the answer back and runs the citation
filter **in code**, so the guarantee never depends on trusting the model that
produced the answer. In a bare terminal it uses the `claude` binary already
installed. An SDK or API key is used if present and never asked for.

Verified end to end with **zero model calls**: six readers, four of which
honestly found nothing, then the same round trip with one invented quote —
dropped, with the sentence citing it, `1 sentence dropped - no citation that
resolves`.

The subprocess rungs no longer write into the archive they read. potsherd's own
probes had been landing in `~/.claude/projects` as ordinary sessions; `card
--all` would have injected one per call.

### semantic search, with no flag and no tier

`--no-embed` stops being the default. On the first `index` the embedding runtime
is fetched in the background, in WebAssembly, and `index` returns in under a
second with text search live. `find` upgrades to hybrid when the vectors are
ready and says `warming (N of M embedded)` until then.

`sqlite-vec` is dropped as a search path: at 1,678 vectors a JS cosine scan is
**4.7 ms** against vec0's **0.9 ms**, and 3.8 ms does not buy an entire native
failure class. WASM costs **6.5x** native per exchange, so embedding runs
**newest-first** — index to first hybrid `find`, **11 s**; all 439, **40 s**.

### the thread is the unit, and work is dated by its content

`claude --resume` writes a new transcript whose head is a copy of the old one.
potsherd stored each as an independent document, so the session someone was
working in grafted as **4 exchanges** when it held **123**, and `show` dated it
eight days before the first exchange it printed *on the same screen*.

Chains are derived at index time — two on the reference archive, which is
exactly the number present; every other pair scores 0.000, so the threshold sits
in an empty gap rather than on a slope. Claude Code's own resume metadata was
checked first and is **wrong here**: alone it claims ten chains, eight false, one
asserting 2,097 records from a 98-record file. It is used only where the records
corroborate it. Lineage costs **+2.0 s** on 435 MB.

### long sessions become answerable

Readers received one contiguous window per session — for four of six, exchanges
1-3, the opening of the conversation. They now receive up to five
relevance-selected windows spanning the thread, each with its seq and timestamp.
A gap prints a marker naming how many exchanges were skipped, emitted on
transcript **positions** rather than window order, so a splice that reads as
continuous is structurally impossible.

### three tools, one skill, and fabrication refused in code

The MCP server is `potsherd_recall`, `potsherd_read` and `potsherd_graft`.
`find`, `ls`, `ask` and `tag` are retired into them. Six overlapping tools cost a
model a decision on every call; three disjoint ones cost it none.

The `session-archaeologist` agent loses filesystem `Read` — it had been citing
repository markdown in a `SOURCES` block, in the correct format, with the
session-id fields blank. v1.1.0's only citation check was a regex for `id8@seq`,
and run over the block that agent actually produced it matches **nothing**: every
fabricated row survived. `verifySources` now refuses in code, and a card-only
thread gets **no citation at all** — checking an id is not checking a provenance.

### cards route; they do not testify

A card-only hit can no longer outrank a transcript hit, and that is structural:
lanes are compared before scores, proved by sweeping the card weights **x1000**
and watching the ordering not move. A card-only hit is capped at `weak`, labelled,
and excluded from `SOURCES`. `--no-cards` turns the lane off. Cards keep routing:
a query whose words appear in no transcript still finds the thread.

### `note` — the archive can learn

`potsherd note <thread> --decided ... --open ... --next ...`, the one verb that
writes. An append-only lane beside the archive with no `UPDATE` and no `DELETE`
in the module; a second note appends rather than superseding, because a changed
mind is the most valuable thing in the lane. The transcript is never touched, and
that is proved by hashing every transcript in the fixture tree before and after,
through both the library and the CLI path.

### the phrasing the skill mandates stops being the losing one

The skill tells an agent to pass the user's own words, which against a bm25 index
was the worst available strategy. Keyphrase extraction now happens in code: the
query's content words are ranked by document frequency **on this index** and the
more selective half is kept, so the rule is a ratio rather than a corpus-size
constant. bm25 recall@5 moves **32 -> 40** on the 60-query set.

### the measuring instrument

The 25-query eval set decided its verdict on a margin of one against noise of
about 2.2. It is now **60 queries** covering all twelve ghosts where the old
covered five, built by a worker told nothing about what change prompted the
widening. Hybrid beats bm25 at recall@5 with **p = 2.4e-7**; at recall@1 the two
rankers disagree on only 4 of 60, **p = 0.625** — still a coin flip, and now
labelled as one.

The absolute floor becomes a **ratchet** at its measured value: it may tighten,
never loosen. And per-query pass/fail is pinned, so a regression **names the query
that fell** rather than only how many did.

### what five independent verifications changed

Every fix above was re-scored by a verifier that authored none of it, against the
audit's own rubric, on the real archive, scoring it **4 → 6 → 7 → 7 → …** —
every FAIL kept on the record, and no criterion moved to meet a number. What the
rounds found, and what changed because of it:

- **`potsherd_read` could not see a thread, in the release that claims to fix
  threads.** It probed for a core function that had been specified, asked for,
  and never written, then degraded politely — so the missing capability announced
  itself only to the model, in prose, at the moment it mattered. The probe, the
  fallback and the function whose job was to report the gap are all deleted;
  `via` has one legal value and two tests fail if a fallback ever returns.
- **Every `index` spawned another embedder and they accumulated**, while the
  code's own comment claimed the lock meant two of them never race. Six
  concurrent `index --quiet` now leave one embedder: the pre-existing one.
- **The quote filter and the prompt disagreed**, so a model that *obeyed* the
  instruction to copy an excerpt exactly produced quotes the filter dropped as
  fabrications. Fixed in the filter's normalisation — and only a leading label
  comes off, because an interior `assistant:` is a fabrication of contiguity
  rather than a label.
- **Three strings at the model door told an agent to do something it cannot
  do.** `potsherd_recall`'s caller has three tools and no shell. It was offered
  `--vectors on` (a flag the schema does not accept), then `run potsherd index
  --embed` (a shell command, on the branch **every fresh install** hits, whose
  falseness the repository's own source comments already recorded), then
  `potsherd ls --json | jq …` for a project that does not exist — a pipeline the
  reader cannot run and which reports 5 projects where the database holds 18.
  All three are gone: the shell verb is dead at its source, the counts carry a
  denominator read from the same status the human verbs read, and a bad project
  name is answered with **the projects the index holds**, tail disclosed.
- **A no-match reply now says which half produced it.** "The archive does not
  contain this" is a much stronger claim when both halves ran than when only
  keyword search did, and the gap is measurable: bm25 alone answers 40 of 60
  eval queries at recall@5 against hybrid's 51.
- **The first row is the best row.** `hits[]` were ordered by the fused score and
  labelled from calibration — and the fused score is reciprocal rank fusion, a
  function of rank alone. The worst real case put a **card**, marked
  `not-a-transcript` and labelled `none`, at the top of a reply whose envelope
  said `strong`, above a real transcript. Ordering is by the label now, not by
  the calibration number, because a routing row's score is deliberately not
  rewritten when the ceiling caps its label. No row is added, dropped or
  rescored; the same rows, moved.
- **potsherd kills what it started, and what that started.** A model backend is a
  shell script or a launcher that forks the real work, and `kill()` reaches one
  pid — so a timed-out call, a cancelled call, and **a terminal Ctrl-C** each
  left the forked process alive with `PPID 1`. Measured: two 'never hangs' test
  cases left four orphans; a real Ctrl-C at a live call left the backend running.
  Backends now get their own process group, and one signal handler — installed
  with the first live child and removed with the last — kills every tree and
  re-raises, so potsherd still dies of the signal and a shell still reads 130.

- **The model door said "semantic search is warming" when nothing was
  warming.** After `index --no-embed`, or on any offline first run, with no
  worker alive and the model directory never created — in the same reply that
  told the agent the archive did not contain what it had asked for. So an agent
  was told to wait for a half that would never run. The lock file has always
  carried the worker's pid; `git grep` for it found **one line in the whole
  product**, deciding whether to spawn. `doctor`, `index`, `find` and both model
  tools now read one flag derived from that lock, and say `not running` when
  nothing is.
- **A session that matched only on its title was citable, and outranked the
  transcripts.** On one real query, eighteen of twenty-eight hits were not
  transcripts and the first one that was sat at position eighteen; five of ten
  threads matched on nothing but their title, and each carried a ready-made
  citation. Claude Code writes those titles with a model, so a citation for one
  is a citation for a summary of a session nobody read. A summary-only result is
  capped, sorted behind anything with transcript evidence, and carries no
  citation at all. Afterwards the first transcript hit is position one, and the
  page carries eight threads with real evidence instead of five. Agents also get
  the `--no-cards` control the terminal has always had.
- **Asking for context could return nothing at all.** An exchange longer than the
  whole token budget was skipped rather than clipped, so a reply said it had
  matched, contained no text, and withheld the one sentence worth printing —
  *read the thread*. It is clipped and marked now.
- **The model-free seam reported a capability failure as an empty archive.** If a
  host agent stored its model's answer as JSON text rather than as a JSON object
  — which is what a model returns, and what potsherd's own instruction invited —
  the run said *"the readers found nothing that answers the question"* and
  printed *"1 answered"* on the next line. The honest empty is what this release
  asks an agent to trust, so a failure wearing its clothes is the one bug that
  poisons the rest. Text is parsed and checked exactly as an object is; anything
  genuinely unusable is refused **by name**, and never reported as an absence.
  The instruction that caused it is rewritten, and now travels inside the file
  as well as on the screen, because an agent handed a path never sees a terminal.
- **`--synthesis-out` said it made no model call and made six.** It now refuses
  unless the readers are already recorded, which is the composition that is
  genuinely free. **This changes what the flag does**: a script calling it alone
  used to get a file and six calls, and now gets an error naming the two
  commands that produce the same file for nothing.
- **`ask` blamed the archive for a dead backend.** `no grounded answer in 6
  sessions searched` was the headline over a run in which no session was read at
  all. An earlier release fixed the line beneath it and left the headline, which
  is the line a reader acts on.

### the guards that let those through

- **Another project's git tags were sitting in this checkout, and one of them
  held the name of this release.** The repository fetches `obra/episodic-memory`
  on purpose, for the upstream comparison, and twenty-three of its tags had
  landed under plain `v*` names — including a `v1.2.0`. The test that checks the
  version is not behind the newest tag counted every tag the checkout held; it
  counts only this repository's now.
- **A published screen pinned a number that was not a property of anything.**
  `stats` reported the database size with a filesystem call on a write-ahead-log
  store, which answers *how much has been checkpointed*: measured with one writer
  holding the log, it reported 4,096 bytes for a database holding 442,368. It
  measures the database now — and the remaining wobble, which is real, is normalised in the
  check rather than published as if it were stable.
- **The screen-capture script raced its own background worker.** Two screens
  showed a semantic-search line only if an embedding worker happened to still be
  alive when they were taken, so CI compared them in a state they had never been
  captured in. The script waits for the lane, and kills the worker it started.

- **A published screen still printed an instruction the product had deleted**,
  because CI diffed two of seventeen screens against a live run. Ten are diffed
  now. The two cheaper guards were tried and rejected in writing: both pass on
  this exact violation, because the flag still exists and the command still
  appears in the source — it is the *sentence* that died, and only running the
  command catches that.
- **The vendored-bundle freshness test compared file timestamps**, so a
  `git checkout` away and back, a rebase, a `cp`, or a fresh clone turned it red
  while nothing about the content had moved — and a test that is red for reasons
  unrelated to its subject stops being read. It compares the bytes `pnpm vendor`
  produces now, with the artifact list pinned to that script's own text so a
  renamed or added bundle fails loudly rather than leaving the test checking a
  path nothing writes.
- **The README's copy of the privacy receipt had drifted from the receipt.** The
  screen was regenerated when three paths were added; the published copy a reader
  actually trusts was not.

### and

- **The real session id used as the `--help` example is gone** — from `tag`,
  `pin`, `link`, `graft`, `card`, seven tests, two fixtures and both plugin
  bundles. Unaccounted id-shaped tokens: **29 -> 19**; pinned occurrences
  **130 -> 41**.
- `doctor --privacy` listed `index` as opening no socket while it fetched 46 MB;
  it now has its own category. That receipt has published four false claims, and
  the guard cannot catch them because it proves *screen == live output*, never
  *live output == truth*.
- `--json` returned an absolute path where the terminal showed a short project
  name, so a caller parsing JSON got a strictly worse object than a human.
- Publishing moved to **npm trusted publishing over OIDC**. There is no npm token
  and there should never be one.

## v1.1.0 — 22 August 2026 · hardening before the public moment

**Nothing on the first screen reads as broken any more, and the guard that
checks this repository stopped being a list of leaks it had already seen.**

### the archive looks like your work again

- **8.2 ghost titles.** 165 of 299 recovered sessions displayed as `/resume`,
  `/model`, `/mcp` or `clear` — the first line of `history.jsonl`, whatever it
  was. They take the first **substantive** prompt now, preferring the harness's
  own summary where one exists, and falling back to `<project>-<id8>` rather
  than to a slash command ever. **165 → 0.** Live sessions with no harness
  title get the same treatment: **204 gained a name**, and `ls --untitled`
  keeps meaning *"nothing a card would not improve"* because a new
  `title_source` column says who did the naming.
- A title is the **words**, not the furniture around them. A pasted screenshot
  arrives as `[Image: source: …/clipboard-….png]` on the line above what the
  person typed, and cutting a title from the raw string produced 60 characters
  of placeholder — and half a home directory — with the real words pushed off
  the end. **Derived titles carrying a home path: 19 → 0.**
- **8.4 `potsherd ignore <project>` / `unignore`.** On a machine that builds
  agents, 14 of the top 15 `ls` rows were potsherd's own worker sessions.
  Honoured by `ls`, `find`, `ask` and `stats`; `--all` overrides; **nothing is
  ignored by default and nothing is ever hidden silently** — each surface says
  how many rows the list cost it, and `doctor` prints the list. A subagent
  worktree rendered as a project slug was a discovery bug and is fixed there.

### the first run is offline again

- **8.6 `index` is text-only by default.** It used to fetch a 32 MB model and
  take **6m 44s**; the same index without embeddings is **9.6 s**. Semantic
  search is an explicit `potsherd index --embed`, offered in one line at the
  end of every run. A fresh-`$HOME` walk of `audit → rescue → index → ls →
  find`, with the network denied by sandbox and proven denied, completes in
  **12.3 s** on an idle machine against a 30 s target — the median of three runs
  in `phases/phase-8/W5-T8E-evidence.txt`; an independent re-run recorded in
  `phases/phase-8/VERIFICATION.md` measured 14.5 s. Under load the same walk has
  measured 24.6–65.0 s; the target is met, and that is the honest range.
- `card --limit N` errored without `--all`. It is a scope now: `--limit` implies
  `--all`, newest first, and the dry-run's quote and the run agree.

### you can watch `ask` work, and it says what it costs

- **8.7** prints one line per reader as it returns —
  `reader 3/6 · 9c4d2f18 · found · 12.1s · $0.031 est.` — on **stderr**, so
  `--json` stays parseable.
- **`ask --cheap`**: k 3, a haiku-class synthesizer, and a session's card in
  place of a long slice. It was called `--fast` until it was measured against a
  control over ten runs each of five questions: **p50 50.5 s against the
  default's 45.0 s**, **$0.065 a run against $0.139**, answered 7/10 against
  10/10, citations 100% on both. About half the cost, and **not faster** — the
  unit of latency is a model call rather than a token. It ships under the name
  that is true, and its own screen says so on every run.

### the honesty surfaces

- **8.5 the fusion gate is closed.** `pnpm evals` had exited 1 since phase 3.
  Amended by the author of the original: hybrid must be **≥** both singles at
  recall@5 **and strictly above both** at recall@1. Weights untouched at the
  phase-3 stopping rule of 1.5. Measured: recall@5 12/22/22, recall@1 10/6/11 —
  **exit 0**, and `pnpm evals -- --vector-weight 0` still exits 1 on two
  independent clauses. The margin at recall@1 is **one**.
- **`audit` discloses what the deleted sessions contained.** No count changed:
  330 ever, 299 deleted, 2,971 prompts lost are all still exactly what they
  were. But `history.jsonl` records no field distinguishing a session from a
  resume-picker invocation, and **143 of the 299 recorded nothing but a slash
  command or a stub** — so a conditional row says so, and **the standalone
  python that `audit --verify` prints recomputes that number too**.
- **8.8** `stack` states its claim asymmetry in a legend above the table rather
  than only per row; the README's synthetic-corpus caption sits above the block
  it qualifies, where a screenshot crop cannot lose it.

### the privacy guard

- **14 pinned violations → 0.** The phase-0..4 evidence pastes were re-run
  against the synthetic demo corpus and replaced; the phase prose had its
  identity substituted and its findings kept, each with a visible note.
- **A new `transcript-record` rule** flags a JSON transcript sample in `docs/**`
  whose prose payload runs past 100 characters unless something nearby declares
  the samples synthetic — the shape of the leak that survived six phases while
  every automated check passed it.
- **The id rule is an inventory, not a blocklist.** It used to hold hashes of
  ids somebody had happened to notice, so an id nobody had noticed was
  invisible — and `phases/phase-2/VERIFICATION.md` had published ten real
  session ids since phase 2. Every id-shaped token in tracked text and tracked
  file names is now accounted for against a source this repository can
  **derive**, and the residue is pinned twice over: per file, and as a
  repository-wide ceiling that a substitution cannot walk around. **Real ids in
  the tree: 25 → 11**, and the remaining 29 unaccounted tokens are an open item
  in `phases/phase-8/HANDOFF.md`, not a clean bill.
- **25 probes** in `--selftest`, each with a control. An unknown flag is a usage
  error: `check-privacy.py --list-pins` used to be read as a file name and
  reported every pin as *"now clean — delete the DEBT line"*, exiting non-zero
  with confident, wrong advice.

### fixed after the verifier said so

Its verdict was *not releasable as described*, and the worst of its fifteen
findings was this: **`audit` printed 143 where its own standalone receipt
printed 140** on a real archive, on the row this release added. The whole point
of that receipt is that nobody has to trust potsherd to check potsherd. All
three implementations of the rule agree now, and a test builds the case the demo
corpus cannot produce — a deleted session whose only prompt is a pasted
screenshot — and requires the card, the snippet **run as printed**, and the
standalone script to return the same number.

Also from that report: both plugin `SessionStart` hooks announced a model
download that this release made impossible, and the test suite was **pinning the
false sentence**; `docs/demo.gif` was a recording of the previous release; the
documented verb count was `20` against a build of 21 with a list of 19; and the
published test count was wrong in five places. All fixed, and the counts are now
checked against commander's own registry rather than against prose.

**1,532 tests, 38 files**, green on macOS and Ubuntu × Node 22 and 24, and green
again under `POTSHERD_SQLITE=node`.

## v1.0.0 — 22 August 2026 · polish and release

**A marketplace install now produces a working plugin.** It did not, for three
phases, and this was the largest single item outstanding. A Claude Code plugin
install is a git clone: nothing runs `pnpm install`, nothing runs a build, and
`better-sqlite3` is a native addon — so the CLI would not start, the MCP server
died before it spoke a word, and `session-archaeologist` was left holding
`Read`. Three changes close it:

- `plugins/claude-code/dist/{potsherd,mcp}.js` are **vendored** — built by
  `pnpm build`, copied by `pnpm vendor`, and rebuilt and byte-compared by CI on
  every push.
- `commander`, the MCP SDK and `zod` are **bundled** rather than external, and
  `better-sqlite3` is loaded on first `open()` rather than at import, so the
  bundles start beside an empty `node_modules`.
- **Node's own SQLite is the fallback.** FTS5, WAL, named parameters, `iterate`,
  and `sqlite-vec` all work under it. The whole suite runs green on it in CI,
  on the same matrix as the addon.

Measured on a fresh Debian container with nothing installed: clone, then `audit`
in **117 ms**, `rescue`, `index` over 228 transcripts in **333 ms**, `find`,
`show --html`, `audit --verify`, and an MCP server answering `tools/list` with
all six tools. Same on a clean `$HOME` on macOS, `audit` in **183 ms**.

**`npx potsherd audit` installed 764 MB. It installs 17 MB, in 1.6 s.** The two
model SDKs and the embedding runtime are optional peers now — npm installs
`optionalDependencies` regardless, which is what nobody had checked.

### new

- `potsherd show --html` — one self-contained page, no script, no network.
- `potsherd setup --status` answers for all seven clients without being told one.
- `potsherd` with no arguments is a six-verb tour, not a second `--help`.
- `docs/demo.cast` and `docs/demo.gif` — audit → rescue → index → find → ask.
- `docs/screens/16-before-after.txt` and `17-ls-cards.txt`.
- `docs/release/` — the checklists for the four things a person, not an agent,
  has to do.
- `FINAL-REPORT.md`.

### fixed

- **`ask` ran 25–33 rows against an 80×24 screen.** Held to a row budget now,
  with a stated order of what gives way, and evidence is never cut to save rows.
- **`ask` said "the readers found nothing" when no reader had run at all** — a
  claim about the user's archive from a verb that never read it.
- **`detectBackend` chose a backend from a signal, not from the module.** A
  `claude` binary on PATH with no agent SDK installed silently produced the
  above.
- **`potsherd ls | head -5` ended in a Node stack trace** (EPIPE).
- **The version was three releases stale**, and the test written to prevent that
  checked four surfaces that were all wrong together.
- `scripts/make-screens.sh` deleted committed screens before regenerating them.
- `find` was the only verb that stopped teaching the next one.
- `doctor --privacy` overflowed 60 columns on fourteen lines; `setup --status`
  on one; `guard --status` on one.
- `artifact-comment-monitor` had been reported as an undocumented format change
  on every `index` run since phase 1.
- `index`'s record-type table lost its columns on names over 30 characters.
- The MCP server decided it was the entry point by filename, then by a path
  comparison that was wrong through a symlink on macOS.

### removed

- The repository owner's own two project names, which had been the worked
  example in `find --help`, in two MCP tool descriptions, in four core
  docstrings and in two fixtures since phase 4.
  **34 pinned privacy violations → 14.**

### still open

Listed with reasons in `FINAL-REPORT.md`. The two that matter: the fusion gate
fails honestly (hybrid ties vector-only at 22/25 rather than beating it), and
the gemini, opencode and copilot adapters have never met real data and keep
their `unverified — documentation only` label.

## v0.7.0 — ecosystem
gemini/opencode/copilot adapters, claude-mem/agentmemory/notes bridges,
`export`, `stack`, `link --suggest`. 14 defects at verification.

## v0.6.0 — surfaces
The MCP server (six tools), the Claude Code plugin, the Codex plugin, `setup`,
`ask --readers-out/--readers-in`, `scripts/check-privacy.py`. 15 defects.

## v0.5.0 — ask and graft
`ask` with a code-level citation filter, `graft`, open threads, the ask evals.
18 defects.

## v0.4.0 — recall
Six-list hybrid fusion, 25-query evals, `find --explain`, composable filters.
7 defects.

## v0.3.0 — cards
`llm.ts`, verified per-session cards, ghost cards, `tag` `pin` `link`,
`ls --resume-menu`. 9 defects.

## v0.2.0 — foundation
The fork, four adapters, redaction, `index` `find` `ls` `show` `stats`.
8 defects.

## v0.1.0 — rescue
`audit` `rescue` `guard` `doctor`. 12 defects.
