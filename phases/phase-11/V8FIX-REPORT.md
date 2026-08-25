# V8FIX — the token potsherd hands you to check its work, and five surface defects

**Branch** `work/V8FIX`, cut from `origin/main` @ `14b5a83`. Six items assigned (C8-1, C8-2, C8-5,
C8-6, C8-7, C8-8). Five were defects and are fixed; **one sub-claim of C8-1 was not a defect** and is
closed below with the evidence. Nothing in §D of VERIFICATION-8 was touched.

Every id, project name and path in this report is a placeholder. `<P8>` is a parent session's id8,
`<S8>` one of its subagents', `<proj-1>` / `<proj-2>` two project names. `check-privacy.py` findings
are elided; it exits 0 (§3).

---

## §0 — the claims, checked before anything was changed

Measured on an APFS clone of the real `~/.potsherd` under a relocated `HOME`, with
`CLAUDE_CONFIG_DIR POTSHERD_DIR XDG_CONFIG_HOME NODE_PATH CODEX_HOME ANTHROPIC_API_KEY` unset. The
real archive was never opened for write; its mtime is unchanged (§3).

**C8-1 — confirmed, and the arithmetic is worse than "331 of 369 ambiguous".** The verifier's shape
is one number; the property that matters is another. Resolving every session's own `slice(0, 8)`
back through `resolveSession`:

```
sessions 369 · distinct slice(0,8) 58 · shared 20 · largest group 41
slice(0,8) resolves to a DIFFERENT session for   311 of 369
of those, resolveSession reported ambiguous for    0 of 311     ← silent, every time
idTag(id) resolves to the same session for       369 of 369 sessions and 299 of 299 ghosts
```

The last line is the finding the fix turns on: **`idTag` was already right and already unique**, and
had been printed by `find`, `ls` and `show` since it was written. What was wrong was that the places
that *mint a citation* did not call it, and that the resolver could not look an agent tag up as an
id in its own right. Both doors, before:

```
potsherd_read {"thread":"<full subagent id>"}   thread.id8 <P8>   total  6
                                               citations ["<P8> · <proj-1> · claude · 6 exchanges · 2026-07-07"]
potsherd_read {"thread":"<P8>"}                thread.id8 <P8>   total 41
                                               citations ["<P8> · <proj-2> · claude · 41 exchanges · 2026-07-07"]
```

One id, two threads, two projects, 35 exchanges apart, no ambiguity notice at either door.

**C8-2 — confirmed.** `potsherd find "<three invented words>" --width 80`:
`31 sessions matched some of those words and none of them enough`, on a run whose every FTS list
returned 0 candidates and whose 31 withheld rows all came from the vector lane.

**C8-5 — confirmed, and the cause is not the one the ticket names.** `potsherd_recall
{query, minConfidence:"none"}` over the real archive: `confidence: "weak"`, `noMatch: false`,
`note: null`, and rows 1–6 of 7 labelled `"confidence":"none"` with `"citable": true` and a minted
citation each. The guard existed — it was keyed on the **envelope**, and an envelope of `weak` over
rows of `none` is a state the archive reaches on ordinary queries.

**C8-6 — confirmed, verbatim.** A bad `scope.project` returned
`The index holds 55: /Users/<user>/<proj>, … (twelve absolute paths) … and 43 more`.

**C8-7 — confirmed.** Same database, same second: `find` → `semantic search: not running (4,589 of
4,774 embedded) — it stopped partway`; `potsherd_recall` → `keyword + semantic search (4,589 of
4,774 embedded)`.

**C8-8 — confirmed, through the binary.** On the rewound 1.1.0 fixture with `sqlite-vec` present,
before any writable open: `doctor` printed `0 of 2` over a store holding 2 (the same shape as the
archive's `0 of 4,774` over 4,589).

**Not a defect — C8-1's third sentence, `potsherd show <P8>` "silently picks the parent".** It does
pick the parent, which is right (refusing would make every session that ever spawned a subagent
unshowable), and it has never done so silently. `renderShow` has always printed, on that screen:

```
40 subagent transcripts:  agent <id8> · agent <id8> · agent <id8> · agent <id8> · …
```

— each named by an `idTag` that resolves to it. The committed screen `docs/screens/11-show.txt`
carries the same block (`9 subagent transcripts: …`). What was wrong at the human door was the *id
inside the citation*, not the disclosure, and it is fixed where it is minted. I wrote a second
disclosure block for `show`, measured it as redundant against that line, and **removed it** rather
than churn a published screen to say a thing the screen already said (§1).

---

## §1 — what changed, and why that shape

### The identity decision

Three shapes were on the table.

1. **An id8 unique across sessions rather than across parent uuids** — i.e. make the minted token
   `idTag`, whose subagent half is the agent tag.
2. **A subagent citation carrying the parent *and* the agent tag** — `<parent8>:<tag8>`.
3. **An explicit ambiguity refusal wherever a prefix is not unique.**

**I took (1) as the identity and (3) as the guard, and rejected (2).** The argument is the
measurement in §0. (1) is not a new identity: `idTag` is the function this project has printed on
every human surface since it was written, its docstring already states the exact defect ("every one
of the 197 subagents on the reference machine would be labelled identically"), and it resolves
1-to-1 for all 369 sessions and all 299 ghosts on the real archive. Nothing had to be invented — the
mint sites simply had to stop calling `slice(0, 8)`. (2) was rejected because it makes the human
screens and the machine citations carry *different* tokens for one thread, and the whole point of a
citation is that the string a model copies is the string a human can type; it also breaks the
`<id8>@<seq>` grammar `graft`'s citation filter is written against. (3) alone was rejected because
it does not fix anything: a subagent's `slice(0, 8)` is not *ambiguous* under the parent-wins rule,
it is confidently **wrong**, so a refusal path would never have fired on the 311 cases that matter.

**What breaks, and how it is handled.** The shape of a published id changes for exactly one class of
session: a claude subagent transcript. Its citation id8 goes from its parent's eight characters to
its own. Concretely:

- **`--help` examples, published screens, README.** Nothing breaks. Every id printed on a published
  screen is either a top-level session (`idTag` ≡ `slice(0, 8)` there, unchanged) or was *already*
  rendered by `idTag` — `docs/screens/09-find.txt`'s `↳ subagent 01` and `11-show.txt`'s
  `schema-checker 01 · schema-checker 02` are `idTag` output on the demo corpus. **All ten CI-diffed
  screens match this build byte for byte after normalisation** (§3), so `docs/screens/**` was not
  regenerated.
- **Existing tests.** One fixture had to change and it is the reason eight rounds missed this. The
  test corpus named its subagents `agent-01` / `agent-02`, so `idTag` returned `01` — a
  two-character tag that *cannot collide with an eight-character prefix*. The fixture could not
  express the defect, so no assertion over it could catch it. The tags are now seventeen hex
  characters, which is what the harness actually writes (`tests/fixtures/claude/**`,
  `tests/fixtures/make-fixtures.mjs`, and the eleven references in five test files).
- **A citation minted by an older build.** A `<parent8> · …` line for a subagent still resolves —
  to the parent — exactly as it did before. It was wrong then and it is wrong now; nothing this
  change does makes a previously-correct citation stop resolving. The reverse case (a new
  `<agentTag8>` handed to an older binary) resolves through the substring lane that has always been
  there.

### The code

**Identity — every place an id8 is minted or resolved.** This is the list the task asked for.

*Minted* (all now `idTag`; each was `X.slice(0, 8)`):

| where | what it mints |
|---|---|
| `packages/mcp/src/tools/sources.ts` `mintCitation` | **the citation string itself** |
| `packages/mcp/src/tools/recall.ts` | `threads[].id8`, `threads[].links[].id8` |
| `packages/mcp/src/tools/read.ts` | `thread.id8`, the `nextCall` hint |
| `packages/mcp/src/tools/thread.ts` | `links[].id8`, the empty-thread error |
| `packages/mcp/src/tools/graft.ts` | `thread.id8` |
| `packages/core/src/graft.ts` | the `id8` on every unit, every `[id8@seq]` the brief carries, the chain line, the no-body error |
| `packages/cli/src/commands/` `show`, `tag`, `note`, `link`, `pin`, `card`, `ask` | every `potsherd <verb> <id8>` the screen tells you to run; `ask`'s reader line, envelope errors and `--verbose` drop log |
| `packages/core/src/` `link-suggest.ts`, `notes.ts`, `render/audit-card.ts`, `render/card-run.ts`, `cards/extract.ts`, `cards/pipeline.ts` | suggested commands, card labels and fallback titles |

Already correct and left alone: `packages/core/src/recall.ts` (`idTag`, `fallbackTitle`),
`render/find.ts`, `render/show.ts`, `open-threads.ts`, `ask.ts`.

*Resolved* — and there were **three** resolvers, which is one of the reasons this survived:

- `packages/core/src/browse.ts` `resolveSession` — the one everything else is supposed to go
  through. Three changes. (a) An **agent-tag lane** runs beside the prefix lane
  (`id LIKE '%:agent-<ref>%'`), so an id8 is looked up as an id8 and not only as a prefix that
  happens to fall through to a substring scan. (b) The parent-wins rule is scoped to **actual
  descendants**: it was "exactly one candidate is top-level, take it", which answered a reference
  naming one session *plus a stranger* with the session the caller had not named; it is now
  `others.every(c => c.id.startsWith(parent.id + ':'))`, and anything else is `ambiguous` — the
  refusal the CLI already claimed to make. (c) `LIMIT 25 → 1000`, because every count built from
  that list is only true if the list is complete, and at 25 a parent with forty subagents disclosed
  twenty-four.
- `packages/core/src/threads.ts` `resolveThread` — carries the new `collapsed` list through, the way
  it already carried `ambiguous`.
- `packages/core/src/graft.ts` `citationResolves` — **the third resolver, and it would have
  regressed.** Its fast path was `expected.startsWith(needle)`, which a subagent's id8 (the right
  half) can never satisfy; under the new mint every `[id8@seq]` in a subagent's brief would have
  been *deleted as unresolvable*. It now tests `idTag(expected) === needle` first and falls back to
  `resolveSession` — one resolver, which is the rule this project already states — so an ambiguous
  citation id is refused there too rather than matched by a bare prefix scan.

`packages/mcp/src/tools/sources.ts` `verifySources` already resolved through `resolveSession` and
already had an `'ambiguous'` refusal reason; both now fire correctly because the resolver does.

**Disclosure, at the door that had none.** `potsherd_read`'s `note` (documented "always null") now
says, when a parent uuid was taken over its own children: how many subagent transcripts the
reference also opens, that the parent conversation is what was read, and each subagent's own id8.
The CLI got no such block — see §0, it already had one.

**C8-2** — `keywordCandidates(lists)` is a new named read in `packages/core/src/recall.ts`
(exported), and `render/find.ts`'s `withheldNote` uses it: when no keyword list produced a
candidate, the sentence is `N sessions matched on meaning alone — none of them uses those words`,
which is the same thing `--min-confidence none` captions those rows with one flag later. When the
keyword lanes *did* find something, the old sentence is unchanged. `belowFloor` counts rows and has
never known which lane produced them; this is the read that does.

**C8-5** — moved off the envelope and onto the row, in `packages/mcp/src/tools/recall.ts`:
`citable = lead.citable === true && confidenceOf(lead) !== 'none'`. A row labelled `none` now
carries `citable: false`, `citation: null`, and a `citableNote` in the same words the CLI uses; and
the reply-level `note` states the caveat whenever any published row is labelled `none`, whatever the
envelope says. There is no envelope state in which the permission and the label can come apart.

**C8-6** — `packages/cli/src/filters.ts`. The not-found message names projects by their **last path
segment** (deduplicated), which is what `resolveProject` matches on and what the caller's next call
should carry; the *ambiguous* message, where short names cannot disambiguate by construction, prints
paths with the home directory elided through `paths.tildify`. The count is now exact on both
(`holds 55 projects under 54 names` when two directories share a leaf), because "holds 55" over a
list of 54 is the kind of one-off a reader is right not to trust.

**C8-7** — `capabilityLine`'s `if (v.used) return …` was unconditional, which made the
`report.working === false` branch below it unreachable on any index holding a single vector. It now
carries both facts, because both are true: `keyword + semantic search (4,589 of 4,774 embedded) —
the rest is not being embedded`. Dropping the "the lane ran" half would be the opposite lie.

**C8-8** — `vectorCounts`' `catch { have = 0 }` in `packages/core/src/vec.ts` is right for a
database that never embedded anything and wrong for the one screen a 1.1.0 user runs first: their
vectors are in the `vec0` virtual tables migration 10 converts, and the blob table does not exist
yet. The catch now counts the legacy store, joined to the rows the same way, guarded on the table
actually being a 1.1.0 `vec0` table **and** on this connection being able to read it — without
`sqlite-vec` the vectors exist and no query can reach them, and `0` is the true answer there.

---

## §2 — artifacts

**Every new assertion red first.** Ran against the unfixed source (`git stash push -- packages/`,
rebuilt for the through-the-binary ones), then restored.

```
tests/id-identity.test.ts                        6 failed | 2 passed (8)
  × every session in the index: the citation minted for it resolves to it
  × so the subagent is cited by its own id8, never by its parent uuid
  × and its own minted citation survives verifySources, which is what a citation is for
  × the two doors agree: full id and minted id8 return the same thread
  × a parent uuid still means the conversation — and now says what else it opens
  × and a reference that names one session plus a stranger is refused, not answered
  (the 2 that pass pre-fix are the fixture precondition and `idTag`'s own uniqueness —
   which is the diagnosis: idTag was never the bug, the mint sites were)

tests/verification-8.test.ts                     6 failed | 3 passed (9)
  × counts the keyword lanes and only the keyword lanes          → keywordCandidates is not a function
  × does not claim the rows matched words when no keyword list returned anything
  × and still says the old, true thing when the keyword lanes did find something
  × returns the withheld rows, labelled none, with no citation on any of them
  × names the projects and discloses the tail, with no absolute path in the reply
  × says the lane ran AND that the rest is stalled, when it is

tests/upgrade-from-1.1.test.ts -t C8-8           2 failed | 1 passed (3)
  × vectorCounts reads the 1.1.0 store …                → expected +0 to be 2
  × and doctor says so, through the binary …            → expected 'potsherd doctor …' not to match /0 of 2/
  (the 1 that passes is the guard: no extension, still counts zero)
```

### C8-1, after — both doors, real archive, largest shared-prefix group (41 sessions, 1 parent + 40)

```
potsherd_read {"thread":"<full subagent id>"}
  thread.id  <full subagent id>
  thread.id8 <S8>   total 6
  citations  ["<S8> · <proj-1> · claude · 6 exchanges · 2026-07-07"]

potsherd_read {"thread":"<S8>"}                       ← the id8 the citation above carries
  thread.id  <full subagent id>                       ← the same thread
  thread.id8 <S8>   total 6                           ← the same count
  citations  ["<S8> · <proj-1> · claude · 6 exchanges · 2026-07-07"]   ← the same citation

potsherd_read {"thread":"<P8>"}                       ← the parent, still the parent
  thread.id  <parent uuid>    thread.id8 <P8>   total 41
  note "<P8>" is also a prefix of 40 subagent transcripts this session spawned; the parent
       conversation is what was read. Each subagent has an id8 of its own: <id8>, <id8>,
       <id8>, <id8>, <id8>, and 35 more
```

Universal, not anecdotal — over the whole real archive, through `resolveSession`:
`idTagResolvesElsewhere 0 · idTagAmbiguous 0 · idTagUnresolved 0` across 369 sessions and 299 ghosts.

### C8-1, after — an ambiguous prefix is refused, not guessed

Through the binary, on the real archive, a four-character prefix four top-level sessions share:

```
$ potsherd show <4-char prefix>
  "<ref>" matches 4 sessions:
    <full id>  13 may  Hello, so what is this projec…
    <full id>  13 may  hello what is this project ab…
    <full id>  13 may  <slug>-<id8>
    <full id>  13 may  <slug>-<id8>
  run  potsherd show <full id>
```

And the case the old rule could not see — one top-level session plus a subagent of a *different*
parent wearing the same eight characters (`tests/id-identity.test.ts`, built where it can be built):
`resolveSession` names both and picks neither, `resolveThread` reports `ambiguous: 2`, and each is
still reachable by its full id.

### C8-2 — before / after, through the binary

```
before   31 sessions matched some of those words and none of them enough
after    31 sessions matched on meaning alone — none of them uses those words
         --min-confidence none  shows them anyway              ← the escape hatch is unmoved
```

### C8-5 — before / after, real MCP server, `minConfidence: "none"`

```
before   confidence weak · note null
         row0 weak citable=True  citation="<id8> · <proj> · claude · 3 exchanges · …"
         row1 none citable=True  citation="<id8> · <proj> · claude · ghost, prompts only · …"
         … rows 2-6 identical in shape: none, citable=True, minted citation

after    confidence weak
         note "9 of these 10 rows are labelled none: the closest text in the archive to your
               words, not an answer to your question. They carry no citation and may not be
               cited. Read them to judge for yourself, and do not report them to the user as
               what was decided."
         row0 weak citable=True  citation="<id8> · <proj> · claude · 3 exchanges · …"
         row1 none citable=False citation=None
              citableNote "labelled none: this is the closest text in the archive to your
                           words, not an answer to your question. Not citable. …"
         … rows 2-6 identical: none, citable=False, citation None, citableNote present
```

### C8-6 — before / after, real MCP server

```
before   no indexed project matches "<x>". The index holds 55:
         /Users/<user>/<proj>, /Users/<user>/<proj>, … twelve absolute paths … and 43 more
after    no indexed project matches "<x>". The index holds 55 projects under 54 names:
         <proj>, <proj>, … twelve short names … and 42 more
```

### C8-7 — before / after, same database, same second

```
find     semantic search: not running (4,589 of 4,774 embedded) — it stopped partway
before   capability "keyword + semantic search (4,589 of 4,774 embedded)"
after    capability "keyword + semantic search (4,589 of 4,774 embedded) — the rest is not
                     being embedded"
```

### C8-8 — before / after, through the binary, 1.1.0 fixture with `sqlite-vec` present

```
before   doctor:  vectors   —   not running, 0 of 2          (over a store holding 2)
after    doctor:  vectors   2   …                            schema v9 of v12, unchanged
```

---

## §3 — numbers

```
pnpm test                       Test Files 57 passed (57)   Tests 2058 passed (2058)   exit 0
POTSHERD_SQLITE=node pnpm test  Test Files 57 passed (57)   Tests 2058 passed (2058)   exit 0
pnpm typecheck                  4/4, exit 0
pnpm evals                      exit 0 · verb (ratchet) recall@5 7/60 · recall@1 7/60   (see below)
check-privacy.py                exit 0 read from $?  ·  608 files swept · 0 pinned violations
                                · 19 unaccounted (ceiling 19)  ·  --selftest exit 0
pnpm build && pnpm vendor       git status plugins/  →  clean
CI screens step, run locally    ten published screens match what this build prints
git status --short               empty (everything above re-run on the committed tree)
```

Baseline was **2,038 on 55 files** (VERIFICATION-8 §C8-3: 2,034 passed + 4 skipped). This branch is
**2,058 on 57 files**, 0 failed, 0 regressions: two new files (`tests/id-identity.test.ts` 8,
`tests/verification-8.test.ts` 9) and 3 new assertions in `tests/upgrade-from-1.1.test.ts`. The four
environment skips VERIFICATION-8 recorded (`tests/adapters/codex.test.ts` 3, `tests/adapters/pi.test.ts`
1) ran rather than skipped on this machine; they are environment-gated and I did not touch them.

`check-privacy.py` went red **twice, on me**, and both are worth recording because the guard caught
what a reviewer would not have. First: the comment I wrote in `packages/cli/src/commands/show.ts`
quoted two real subagent id8s off the archive — the guard named both lines and the ceiling moved
19 → 21. Second: the synthetic id I first invented for the ambiguity test had eight distinct
hex digits and is therefore indistinguishable from a real one to the inventory — 19 → 20. The first
was elided to `<id8>`; the second was rewritten to a one-distinct-digit literal in the fixture's own
style. Back to 19, exit 0, on the committed tree.

**Isolation, disk, processes.** `~/.potsherd` was APFS-cloned (`cp -Rc`, free space unchanged) into
a scratch `HOME`; every measurement ran under that `HOME` with the five named variables and
`ANTHROPIC_API_KEY` unset. The real `~/.potsherd/potsherd.db` mtime is unchanged (`25 Aug 00:45`,
hours before this session). No `index` was run with embedding on, so no detached embedder was
spawned; `pgrep -f potsherd-mcp` returns nothing and the only `mcp.js` processes on the machine
belong to the harness's installed 1.1.0 plugin and predate or are unrelated to this work — none was
signalled. `df -h`: **4.1 GiB free at start, 3.9 GiB at finish**; the scratch tree is an APFS clone
that costs nothing, `.tmp/demo-home` was removed after the screens run. Nothing was abandoned for
lack of space. `&&` throughout; no `git fetch --tags`; no commit outside `work/V8FIX`.

---

## §4 — what I could not do

- **CI itself.** One macOS machine, Node v24.9.0, one architecture. The screens step was reproduced
  locally, command for command and normaliser for normaliser, from `.github/workflows/ci.yml`; the
  matrix, the provenance attestation and the packed-tarball `npx` step were read, not run.
- **The `ask` model path end to end.** No credentials in the isolated `HOME`. `citationResolves`'
  new `idTag` fast path is covered by unit assertions and by `verifySources` over a real minted
  subagent citation, not against a live model answer — which matters here, because that function is
  the one place my change could have *deleted* true citations rather than fixed wrong ones.
- **`ask`, `graft` and `card` id8s on a real archive.** Their mint sites were changed and are
  covered by the suite, but the verbs themselves need a backend I do not have.
- **The `--privacy` receipt regenerated against a live `~/.claude`**, which the isolation rules
  forbid. Read and diffed only.
- **Whether a harness other than claude can produce a colliding `idTag`.** The rule is now
  "collision ⇒ refuse", and the refusal is tested; but the *frequency* of that refusal on a
  non-claude archive is unmeasured, because every subagent id on this machine is claude's
  seventeen-hex form. A harness whose agent tags are two characters would refuse more often than it
  should, and the honest remedy there is a longer tag, not a looser resolver.
- **C8-3, C8-4, C8-9 through C8-13** were not assigned and are untouched.
