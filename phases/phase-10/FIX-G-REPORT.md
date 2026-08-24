# FIX-G — the model-free seam stops calling a broken input an empty archive

Branch `work/FIX-G`, cut from `origin/main` at `4064c4e`. Three items from `VERIFICATION-4.md`:
**C4** (the false honest-empty on a string `reply`), **C5** (`--synthesis-out` promising no model
call and making six), **C7's second bullet** (an emptiness headline over a capability failure).

Every measurement below ran under a relocated `HOME` holding an entirely synthetic corpus
(`scripts/make-demo-corpus.mjs`), with `CLAUDE_CONFIG_DIR`, `POTSHERD_DIR`, `XDG_CONFIG_HOME`,
`NODE_PATH`, `CODEX_HOME` and `ANTHROPIC_API_KEY` unset, and writes confined to a scratch
`--potsherd-dir`. No byte was written to `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.gemini`,
`~/.copilot`, `~/.local/share/opencode` or `~/.potsherd`. Paths in the pasted output are elided to
`<b>` one-to-one; session ids and project names below are the demo corpus's own invented ones, not
anybody's.

---

## 0. THE CLAIMS, CHECKED BEFORE FIXING

All three reproduce on `4064c4e`. None is a false alarm. One detail of C4's evidence is wrong and
the correction makes it slightly worse, not better.

| claim | verdict | how |
|---|---|---|
| C4 — a `reply` that is a JSON string is reported as "the readers found nothing" | **confirmed** | §0.1 |
| C4 — the identical file with `reply` as an object answers and drops a planted fabrication | **confirmed** | §0.1 |
| C4 — `filterHostAnswer` checks only `undefined`/`null` | **confirmed** | `ask.ts:1090`, read |
| C4 — "exit 0" | **corrected: exit 1** | §0.1. It is the honest empty's own code either way, which is the defect |
| C5 — `--synthesis-out` alone makes six reader calls | **confirmed** | §0.2 |
| C5 — the composed form is free and says so | **confirmed** | `no model call was made (0)` |
| C7 — an emptiness headline over a capability failure | **confirmed** | §0.3 |
| **new** — the suite pinned the defect as the specification | **found** | §0.4 |
| **new** — the receipt can print `no model call was made (6)` | **found** | §0.2 |
| **new** — the refusal path leaked ten characters of the reply | **found and fixed** | §1.4 |

### 0.1 C4, end to end, on the unfixed build

The same synthesis file, answered twice with the same content — once as an object, once as the JSON
text of that object, which is what a model returns. A fabrication is planted in both: evidence `[2]`
quotes a sentence that is not in the transcript.

```
$ potsherd ask "why does the retry budget allocate so much?" --filter-in s-object.json --debug
  filter: 2 dropped
    evidence not-a-quote      <idE>@3     we raised the retry budget to 5000 after the incident
    sentence no-citation                     The budget was raised to 5000 after the incident.
potsherd ask "why does the retry budget allocate so much?"

ANSWER
  The allocation happens inside the loop rather than in the parser. [1]

EVIDENCE
  [1] notes-api/<idA>  23 jul 14:12  "The allocation is in the loop, not th…"

  6 of 6 sessions read · 3 answered · 9ms
  1 sentence dropped · no citation that resolves
  run  potsherd graft <idA>  to carry it into the agent you are in
EXIT=0

$ potsherd ask "why does the retry budget allocate so much?" --filter-in s-string.json --debug
  filter: nothing dropped
potsherd ask "why does the retry budget allocate so much?"

  no grounded answer in 6 sessions searched

  the readers found nothing that answers the question.

  6 of 6 sessions read · 3 answered · 8ms
EXIT=1
```

`3 answered` on the line below `the readers found nothing`, and `filter: nothing dropped` above a
run in which the filter was handed nothing to drop. Under `--json` the same run writes a complete,
well-formed `AskResult` to stdout with `"answer": "", "sentences": [], "dropped": [],
"refused": false` and three readers reporting `"found": true`.

**The verifier's "exit 0" is wrong: it is 1.** That is not a mitigation. `ask`'s codes are `0` a
grounded answer, `1` the archive was read and had nothing, `2` potsherd declined — so `1` is
*precisely* the code a genuine honest empty returns, and a caller branching on the exit status
learns exactly the wrong thing. The correction moves the failure from "looks like a success" to
"is byte-identical to an honest empty", which is the worse of the two.

### 0.2 C5, on the unfixed build

```
$ potsherd ask "why does the retry budget allocate so much?" --synthesis-out synth-bare.txt
  reader 1/6 · <idC>    · failed  ·   5.8s · $0
  reader 2/6 · <idE>    · failed  ·   5.8s · $0
  reader 3/6 · <idA>↳<idA-sub> · failed  ·   5.8s · $0
  reader 4/6 · <idA>    · failed  ·   5.9s · $0
  reader 5/6 · <idB>    · failed  ·   5.9s · $0
  reader 6/6 · <idD>    · failed  ·   5.9s · $0
  no reader found anything — no synthesis prompt written to <b>/w/synth-bare.txt
EXIT=1
```

Six calls against a flag whose `--help` line ends `makes no model call`. This machine's backend
answers `Not logged in`, so the six were free here and would not be on a machine that works.

**A second lie in the same path, which the verifier did not name.** `synthesisOutReceipt` printed
`no model call was made (${probe.spend.calls})` unconditionally. On a machine with a working backend
the bare flag writes the file *and* prints `no model call was made (6)` — a sentence contradicted by
its own parenthesis. Fixed in §1.3 regardless of the guard, so it is true by construction rather
than true by precondition.

### 0.3 C7, on the unfixed build

```
$ potsherd ask "why does the retry budget allocate so much?"
  reader 1/6 · <idD>    · failed  ·   4.3s · $0
  … six readers …
potsherd ask "why does the retry budget allocate so much?"

  no grounded answer in 6 sessions searched

  no reader could run, so nothing was read: claude --print could not answer: Not logged in ·…

  6 of 81 sessions read · 0 answered · 4.5s
```

The second line is exact. The headline is an emptiness frame over a capability failure, and it is
the same frame C4 wears.

### 0.4 The blind spot, still there, and worse than "the fixture is small"

The task said to assume `09 §7.2` — a test whose premise is its environment — until proved
otherwise. It is there, in two forms.

**(a) The fixture.** `seedDb()` still seeds one session, and 28 of the file's 33 tests run on it.
`seedTwo()` exists but is used by exactly one test, the one added when the last defect in this file
was found. Every test I added runs on `seedTwo`: two sessions shortlisted, one reader answering and
one not. A false honest-empty is precisely the class a one-session premise cannot see, because with
one session "the archive had nothing" and "this file was unreadable" produce the same screen.

**(b) Worse: the suite asserted the defect.** `tests/synthesis-seam.test.ts` contained

```js
  it('a reply that is not the right shape at all is the empty answer, not a crash', async () => {
    answerWith(synth, { some: 'other thing entirely' });
    const r = await filterHostAnswer(db, QUESTION, { root }, synth);
    expect(r.answer).toBe('');
    expect(r.sentences).toHaveLength(0);
  });
```

That is C4(b) written down as the specification: an unusable reply *is* the empty answer. The test
is green on `4064c4e` and green on any build with this defect. I inverted it (§1.5) — a refusal is
not a crash, and both halves it was really pinning (no exception escapes, nothing unchecked reaches
the answer) are still pinned, in §7 of the file.

---

## 1. WHAT CHANGED, AND WHY THAT SHAPE

One source file: `packages/cli/src/commands/ask.ts`. Nothing in `packages/core`, nothing in the
three reserved index files.

### 1.1 C4(a) — the string form is accepted, by parsing it

`filterHostAnswer` now runs every recorded `reply` through one gate, `hostReply()`, before `ask()`
is entered.

**Accepted:** the object; a JSON string of that object (parsed); a ```` ```json ```` fence around
that string (the fence is stripped, then the contents must still parse); and an object whose
`evidence` and `answer` arrays are both empty — the host synthesizer's own honest empty, which is
the one case where an empty result is the truth and which the refusal must never swallow.

**A string that is not JSON at all** — prose, an empty string, a fenced block that is not JSON — is
refused, naming what it is. **A JSON string containing something that is not the expected shape** —
an array, a number, a bare string — is refused, naming the type it found. So is a JSON string that
parses to an object with neither an `evidence` nor an `answer` array.

The ruling was: if accepting the string would let something through that the object catches, reject
it loudly instead. It does not. The parsed value re-enters at exactly the point the object form
enters — `validateSynth`, then `filterAnswer`, against the transcript bytes at the `(sessionId,
seq)` each quote names. A test plants the same fabrication in both spellings and compares the two
`AskResult`s field for field; §2 does the same end to end.

**The fence.** Stripping a ```` ``` ```` fence widens what is accepted, so it is worth saying why it
is not a guess: only a fence wrapping the *entire* value is removed, and what is inside must still
parse as JSON or the run refuses. `answerWith(synth, '```\nThe client cache was set to zero.\n```')`
is a refusal, and there is a test for it.

### 1.2 C4(b) — nothing unusable is silent, and the exit code is 2

Every refusal above carries `UserError(message, fix, 2)`.

**Why 2 and not 1.** `ask`'s documented codes are `0` a grounded answer, `1` the archive was read and
had nothing, `2` potsherd declined to answer (`--strict`, phase-4 T4.1 §4). The whole of C4 is that
a broken input was being reported in the vocabulary of `1` — §0.1 measured it *at* 1 — so `1` is the
one code these must not use. `2` already means *this run declined to answer and that is not a
statement about your corpus*, which is exactly what an unusable `reply` is. Both refusals about the
field share it: a missing `reply` and an unusable one are the same problem at two stages, and giving
them two codes would be a distinction with nothing behind it. The pre-existing "has no reply"
refusal therefore moves from 1 to 2; nothing else in the file changes code.

Three signals now separate a refusal from an honest empty, so no consumer has to rely on one:
stdout is **empty** (an honest empty writes a full `AskResult`, and under `--json` a JSON object);
stderr carries `potsherd: <exactly what is wrong>` and a `try:` line; the exit code is 2, which no
honest empty uses.

**The one case that is deliberately not refused:** `{"evidence":[],"answer":[]}`. A synthesizer that
read the evidence and concluded nothing is supportable is answering, not failing. It reaches the
empty-answer render, as it should. There is a test pinning that the refusal cannot swallow it.

**The case between the two:** arrays that are present and non-empty but not one of whose entries
meets the schema — the input on which `validateSynth` returns `null` and the run would print an
empty archive. That is refused, naming the counts and the missing fields. Catching it needs a
usability probe in the CLI, which is discussed in §4.2, because the file's own docstring argues
against a second validator and I did not want to quietly become one.

### 1.3 C5 — the flag is made to keep its promise, and **what it does changes**

`--synthesis-out` without `--readers-in` is now **refused**.

```
potsherd: --synthesis-out makes no model call only when the readers are already recorded; on its
own it would spend one reader call per shortlisted session before it had a prompt to write
  try:  potsherd ask "…" --readers-out r.json   # run your readers, then --readers-in r.json --synthesis-out …
```

The guard sits above `openIndex` and above `detectBackend`, so the refusal is instant and no reader
can have run before it. `--readers-in … --synthesis-out …` — the seam's real second leg, and the
composition every document prints — is untouched and still free.

**Why refusal rather than a reworded help line.** The `.option()` line lives in
`packages/cli/src/index.ts`, which is reserved to another worker this phase, so the sentence could
not be qualified from inside my boundary. That forced the choice, and I think it is the right one
anyway: the flag belongs to the seam, the seam's composed form is free, and the paying composition
was never a documented shape. The exact patch for the reserved file is in §1.6 for whoever owns it —
it is worth applying *as well*, because a user reading `--help` should learn the shape rather than
discover it from an error.

**This changes what the flag does, and someone's scripts may call it.** A script running
`ask "…" --synthesis-out s.json` on a machine with a working backend used to get a file and six
reader calls; it now gets exit 1 and two commands that produce the same file for nothing. The
counter-argument is in the code it overrides: `writeSynthesisFile`'s docstring defended the bare
form as "a legitimate thing to want (a bare terminal recording a prompt for a colleague's agent),
with `probe.spend.calls` printed so the difference is never hidden". I have rewritten that docstring
rather than deleted it, because the argument is real and the reason it loses is narrow: the
difference *was* hidden, by a receipt that said `no model call was made` and a `--help` line that
said the same. If the orchestrator prefers to keep the capability, the whole change is the one
`if (synthesisOut && !readersIn)` block plus its three tests, and §1.6's patch is then the fix.

**Independently of the guard,** `synthesisOutReceipt` no longer prints `no model call was made (N)`
for non-zero N. It prints `6 model calls were made — the readers ran here.` The guard makes that
branch unreachable from the CLI; the exported `writeSynthesisFile` is driven directly by tests and
by anything that calls it later, so the sentence is now true by construction.

`modelless` is simplified from `(readersOut || filterIn || (synthesisOut && readersIn))` to
`(readersOut || filterIn || synthesisOut)`. Same set of runs, one name per free run, and a reader
can now check it against `--help` without holding a second condition in their head. That expression
*was* the code correctly knowing what the help line was getting wrong, which is why C5 is the
project's ninth-plus "a flag that is documented and does nothing" inverted.

### 1.4 C4(c) — the instruction, which was part of the defect

The old sentence:

```
  answer "prompt" in the shape of "schema", add it to the file as "reply", then:
```

"it" is the ambiguity. A model answers a prompt with *text*; `schema` is itself a JSON string in the
file; so "add it as reply" resolves perfectly reasonably to "store the model's text". The verifier
hit that from two independent directions before reading the source. This is FIX-C's D7 in the other
direction: there a prompt and a filter disagreed and a model that *obeyed* produced output the code
rejected; here a prompt was vague and a model that obeyed one reading of it produced output the code
silently discarded.

The receipt now reads:

```
  answer "prompt" in the shape of "schema" and add that answer to the file as "reply" —
  the JSON object {"evidence":[…],"answer":[…]}, or the JSON text of it. then:
    potsherd ask "…" --filter-in <b>/w/s2.json
```

and the same instruction is written **into the file** as `instruction`, and into the `--json`
receipt, because the agent that is handed a path never sees the terminal:

```
  answer "prompt" in the shape of "schema" and store that answer here as "reply". "reply" is the
  JSON object itself — {"evidence":[…],"answer":[…]} — or the JSON text of that object, which
  potsherd will parse. Prose, or a JSON value that is not that object, is refused rather than read
  as an empty answer.
```

`instruction` is advisory: `readSynthesisFile` reads it back for completeness, checks nothing, and
accepts a file written by an older build that has none. No version bump.

**A leak I introduced and removed in the same pass.** The first version of the not-JSON refusal
printed `JSON.parse`'s own message, which quotes back ten characters of what it was given:
`Unexpected token 'T', "The alloca"… is not valid JSON`. Those ten characters are a model's prose
about the user's own transcripts, on the way into a terminal, a CI log or a pasted bug report. The
parser's message is no longer printed at all, and there is a test asserting that no refusal contains
the first ten characters of the reply. `shapeOf()` exists for the same reason: every refusal names a
*type*, never a value.

### 1.5 Tests

`tests/synthesis-seam.test.ts` +14 tests in a new §7, all on the two-session fixture; one existing
test inverted (§0.4b) with a comment saying what it used to assert and why. `tests/ask.test.ts` +3
tests for C5, driving `runAsk` — which had no test at all before, so none of the flag-combination
guards in that function were covered.

### 1.6 Lines I owe you — patches for files outside my list

**(a) `packages/cli/src/index.ts:390` (RESERVED).** Optional after the guard above, and worth
applying anyway so `--help` teaches the composition instead of an error doing it:

```diff
-      .option('--synthesis-out <path>', 'write the synthesis prompt to this file; makes no model call')
+      .option('--synthesis-out <path>', 'with --readers-in: write the synthesis prompt to this file; makes no model call')
```

**(b) `packages/core/src/render/ask.ts:571-598` — C7's second bullet.** Not in my deliverable list,
so I stopped. The headline is `nothing()`'s, and the fix is to move the `allFailed` computation
above it and branch the headline on it, so *nothing was read* and *nothing was found* are different
sentences and not only different sub-lines:

```diff
@@ function nothing(r: AskResult, t: Theme): string[] {
+  // FIX-G C7. `no grounded answer in N sessions searched` is an emptiness
+  // headline and it was printed over a capability failure: on a machine whose
+  // backend is not logged in, no session was read at all. The dim line below
+  // was exact and rescued it, but the headline is what an agent acts on, and
+  // it is the same frame C4 wore on the `--filter-in` path.
+  const failed = r.readers.filter((x) => x.error);
+  const allFailed = r.readers.length > 0 && failed.length === r.readers.length;
   out.push(
     INDENT +
       f.clip(
-        `no grounded answer in ${f.num(r.searched)} ${f.plural(r.searched, 'session')} searched`,
+        allFailed
+          ? `nothing was read — all ${f.num(r.readers.length)} ${f.plural(r.readers.length, 'reader')} failed`
+          : `no grounded answer in ${f.num(r.searched)} ${f.plural(r.searched, 'session')} searched`,
         t.width - 2,
         t,
       ),
   );
   out.push('');
-  const failed = r.readers.filter((x) => x.error);
-  const allFailed = r.readers.length > 0 && failed.length === r.readers.length;
   out.push(
     INDENT +
       t.dim(
         allFailed
           ? `no reader could run, so nothing was read: ${f.clip(failed[0]?.error ?? 'the backend did not answer', t.width - 30, t)}`
           : r.dropped.length > 0
             ? `every sentence was dropped for want of a citation that resolves (${f.num(r.dropped.length)}).`
-            : 'the readers found nothing that answers the question.',
+            : r.readers.some((x) => x.found)
+              ? 'the readers found material, and the answer built from it was empty.'
+              : 'the readers found nothing that answers the question.',
       ),
   );
```

The second hunk is a **third** instance of the same frame that I found while working and did not
otherwise report: when readers answer and the synthesizer legitimately returns
`{"evidence":[],"answer":[]}`, the screen says *"the readers found nothing"* about readers that
found plenty. It is reachable from the seam (§1.2's deliberately-allowed case) and from a backend
that declines.

**(c) `packages/core/src/render/ask.ts:522` — `refusal()`** carries the identical headline, and
`why()`'s `'no-answer'` branch says *"no session read addressed the question"*. Same frame, same
argument, but I did not reach it in any measurement and am not proposing a patch for a path I have
not seen fire.

---

## 2. THE ARTIFACTS

### 2.1 The round trip, run the way the docs print it — both forms

Isolated demo corpus, 228 transcripts, six sessions shortlisted, readers answered **by hand** (three
`found: true`, three `found: false` — the ordinary mix, and the one a single-session fixture cannot
produce). A fabrication is planted in the reply in each form: evidence `[2]` quotes
`we raised the retry budget to 5000 after the incident`, which no transcript contains.

```
$ potsherd ask "why does the retry budget allocate so much?" --readers-out r2.json
  6 reader inputs → <b>/w/r2.json
  of 81 matching sessions, k 6

    06  notes-api  subagent  seq 1
    <idA>  notes-api  seq 1, 2, 3
    <idB>  notes-api  seq 1, 2, 3
    <idC>  notes-api  seq 1, 2, 3
    <idD>  notes-api  seq 1, 2, 3
    <idE>  notes-api  seq 1, 2, 3

  no model call was made (0). the excerpts are redacted, as sent.
  these 6 sessions are the shortlist. --readers-in reads exactly them, however much the index has embedded since.

  run your readers, add an "outputs" array to the file, then:
    potsherd ask "why does the retry budget allocate so much?" --readers-in <b>/w/r2.json
EXIT=0

--- I answer the six targets by hand, in the file ---

$ potsherd ask "why does the retry budget allocate so much?" --readers-in r2.json --synthesis-out s2.json
  answered over the 6 sessions recorded in <b>/w/r2.json, not the shortlist this question produces now
  1 synthesis prompt → <b>/w/s2.json
  built from 3 sessions of 6 read · 817 chars

    06  notes-api  subagent  seq 1
    <idA>  notes-api  seq 1, 2, 3
    <idE>  notes-api  seq 1, 2, 3

  no model call was made (0). the prompt is redacted, as sent.

  answer "prompt" in the shape of "schema" and add that answer to the file as "reply" —
  the JSON object {"evidence":[…],"answer":[…]}, or the JSON text of it. then:
    potsherd ask "why does the retry budget allocate so much?" --filter-in <b>/w/s2.json
EXIT=0

--- I answer s2.json's prompt by hand, twice: once as an object, once as its JSON text ---

$ potsherd ask "why does the retry budget allocate so much?" --filter-in s2-object.json --debug
  filter: 2 dropped
    evidence not-a-quote      <idE>@3     we raised the retry budget to 5000 after the incident
    sentence no-citation                     The budget was raised to 5000 after the incident.
potsherd ask "why does the retry budget allocate so much?"

ANSWER
  The allocation happens inside the loop rather than in the parser. [1]

EVIDENCE
  [1] notes-api/<idA>  23 jul 14:12  "The allocation is in the loop, not th…"

  6 of 6 sessions read · 3 answered · 8ms
  1 sentence dropped · no citation that resolves
  run  potsherd graft <idA>  to carry it into the agent you are in
EXIT=0

$ potsherd ask "why does the retry budget allocate so much?" --filter-in s2-string.json --debug
  the recorded "reply" was a JSON string; parsed it into the object the filter checks.
  filter: 2 dropped
    evidence not-a-quote      <idE>@3     we raised the retry budget to 5000 after the incident
    sentence no-citation                     The budget was raised to 5000 after the incident.
potsherd ask "why does the retry budget allocate so much?"

ANSWER
  The allocation happens inside the loop rather than in the parser. [1]

EVIDENCE
  [1] notes-api/<idA>  23 jul 14:12  "The allocation is in the loop, not th…"

  6 of 6 sessions read · 3 answered · 8ms
  1 sentence dropped · no citation that resolves
  run  potsherd graft <idA>  to carry it into the agent you are in
EXIT=0
```

Identical answer, identical evidence, identical drops, identical exit, zero model calls in both. The
string form differs by exactly one line, above the answer, saying that it had to parse. Compare
against §0.1's string run on the unfixed build, which is the same file.

### 2.2 The refusals, on the same file

```
$ potsherd ask "…" --filter-in s2-prose.json          # "reply" is the model's prose
potsherd: <b>/w/s2-prose.json's "reply" is a string and it is not JSON. potsherd will parse a JSON
string for you, but this is prose, and prose carries no quote it can check
  try:  answer its "prompt" in the shape of its "schema", then store that object as "reply"
EXIT=2
  stdout, under --json:  (empty)

$ potsherd ask "…" --filter-in s2-empty.json          # "reply" is "  "
potsherd: <b>/w/s2-empty.json's "reply" is an empty string, so there is no answer in it to filter —
that is a file nobody has answered, not an archive with nothing in it
  try:  answer its "prompt" in the shape of its "schema", then store that object as "reply"
EXIT=2
  stdout, under --json:  (empty)

$ potsherd ask "…" --filter-in s2-wrong.json          # "reply" is {"summary": "…"}
potsherd: <b>/w/s2-wrong.json's "reply" is an object with neither an "evidence" array nor an
"answer" array, so there is nothing in it for the citation filter to check
  try:  answer its "prompt" in the shape of its "schema", then store that object as "reply"
EXIT=2
  stdout, under --json:  (empty)
```

None of the three names a byte of the reply.

### 2.3 C5, after

```
$ potsherd ask "why does the retry budget allocate so much?" --synthesis-out synth-bare3.txt
potsherd: --synthesis-out makes no model call only when the readers are already recorded; on its own
it would spend one reader call per shortlisted session before it had a prompt to write
  try:  potsherd ask "why does the retry budget allocate so much?" --readers-out r.json   # run your
        readers, then --readers-in r.json --synthesis-out synth-bare3.txt
EXIT=1
$ ls synth-bare3.txt
ls: synth-bare3.txt: No such file or directory
```

Instant, no reader line, no file. Compare §0.2: six calls, 5.9 s. The composed form still prints its
receipt and its instruction (§2.1).

### 2.4 Red first

New tests against the unfixed `packages/cli/src/commands/ask.ts` (stashed; the two test files
unchanged) — **15 failed, 135 passed**:

```
 FAIL  tests/ask.test.ts > --synthesis-out without --readers-in > is refused rather than quietly spending one reader call per shortlisted session
 FAIL  tests/ask.test.ts > --synthesis-out without --readers-in > refuses before it opens the index, so nothing is read and nothing is spent
 FAIL  tests/synthesis-seam.test.ts > a reply recorded as a JSON string > answers exactly as the same reply recorded as an object does
 FAIL  tests/synthesis-seam.test.ts > a reply recorded as a JSON string > drops a fabrication planted inside the string exactly as it drops one in the object
 FAIL  tests/synthesis-seam.test.ts > a reply recorded as a JSON string > parses a fenced string, which is what a model returns when it is being helpful
 FAIL  tests/synthesis-seam.test.ts > a reply recorded as a JSON string > refuses a fence with prose inside it rather than guessing at the prose
 FAIL  tests/synthesis-seam.test.ts > … > refuses prose, and says it is prose rather than answering nothing
 FAIL  tests/synthesis-seam.test.ts > … > refuses an empty string as an unanswered file, not an empty archive
 FAIL  tests/synthesis-seam.test.ts > … > refuses a JSON string that parses to something other than an object, and names what it found
 FAIL  tests/synthesis-seam.test.ts > … > refuses a reply that is not an object at all
 FAIL  tests/synthesis-seam.test.ts > … > refuses an object with neither an "evidence" nor an "answer" array
 FAIL  tests/synthesis-seam.test.ts > … > refuses arrays whose every entry is malformed, the case validateSynth nulls
 FAIL  tests/synthesis-seam.test.ts > … > exits 2 on every reply refusal — the code no honest empty uses
 FAIL  tests/synthesis-seam.test.ts > … > never prints the reply back, because it is prose about the user's transcripts
 FAIL  tests/synthesis-seam.test.ts > the instruction the host is given names the shape > is written into the file, for the agent that only ever sees the file
 Test Files  2 failed (2)
      Tests  15 failed | 135 passed (150)
```

**Two of the new tests were green before the fix and had to stay green through it**, which is the
point of them: `allows an object with both arrays empty — the host's own honest empty` (the refusal
must not swallow a real empty) and `leaves the composed form — the seam's real second leg — alone`
(the C5 guard must not touch `--readers-in … --synthesis-out …`).

After the fix, the same two files: **150 passed**.

---

## 3. THE NUMBERS

| | |
|---|---|
| source files changed | **1** — `packages/cli/src/commands/ask.ts` |
| source diff | +376 / −28 |
| **effective source lines added** (comments and blanks excluded) | **133** |
| test diff | `tests/synthesis-seam.test.ts` +285 / −10 · `tests/ask.test.ts` +82 / −0 |
| tests | **+17, −1** (the inverted one) |
| `pnpm test` | `Test Files 53 passed (53)` / `Tests 1909 passed (1909)` — was 1,893, **0 regressions** |
| `POTSHERD_SQLITE=node pnpm test` | `Test Files 53 passed (53)` / `Tests 1909 passed (1909)`, exit 0 |
| `pnpm typecheck` | **4 of 4** packages `Done` |
| `pnpm evals` | **`EVALS_EXIT=0`**, `hybrid (auto) recall@5 51/60, recall@1 27/60`, `PASS` |
| `python3 scripts/check-privacy.py` | **`PRIV_EXIT=0`, read from `$?`** — see below |
| `pnpm build && pnpm vendor` | `vendored 2 files, 2.6 MB total`; `git status plugins/` clean after the commit |

**The privacy guard caught me, and that is worth writing down.** The first draft of this report
pasted the demo corpus's own eight-character session ids. Staged, `check-privacy.py` exited **1**:

```
NEW VIOLATIONS:
  phases/phase-10/FIX-G-REPORT.md  [corpus-id-inventory]  an id-shaped token that no derivable
  source in this repository accounts for
  24 distinct, ceiling 19.
```

They were synthetic — generated by `scripts/make-demo-corpus.mjs`, not anybody's — and the guard was
still right: the rule is that an id-shaped token in a tracked file must be derivable, and these were
not. Every one is labelled `<idA>`…`<idE>` above, one-to-one. After the relabel the inventory is
back to the baseline exactly: *19 unaccounted (ceiling 19), pinned at 41 occurrences across 17
files*, `PRIV_EXIT=0`. **The offending token is not quoted here**, per the constraint — pasting the
guard's output would re-commit what it caught.

`tests/plugin-install.test.ts` is green after `pnpm build && pnpm vendor`, and `git status
plugins/` is clean. The vendored `plugins/claude-code/dist/potsherd.js` changed (+127 lines) because
`packages/cli` changed; `mcp.js` did not, because nothing in `packages/mcp` or `packages/core` did.

---

## 4. WHAT I COULD NOT DO

**1. C7's second bullet is specified, not fixed.** The headline is rendered by `nothing()` in
`packages/core/src/render/ask.ts`, which is not in this task's file list and is not one of the files
another worker owns either. The instruction was to stop at the boundary and put the exact patch in
the report, so I did: §1.6(b), two hunks, one of which closes a third instance of the same frame
that I found while working (readers answer, synthesizer returns a legitimate empty, screen says *"the
readers found nothing"*). **C4's instance of that frame is fixed** — the `--filter-in` path no longer
reaches an emptiness render at all when the input is unusable — but the no-backend instance the
verifier measured still prints the old headline on this branch.

**2. C5's `--help` line is not reworded**, because `packages/cli/src/index.ts` is reserved. It is
made *true* instead (§1.3), which is a behaviour change I have flagged three times because someone's
scripts may call the bare flag. §1.6(a) has the one-line patch if the owner would rather keep the
capability and qualify the sentence; in that case my guard is the thing to drop.

**3. The usability probe duplicates two of `validateSynth`'s filters.** `usableEvidence` and
`usableSentence` in `ask.ts` are copies of the conditions in
`packages/core/src/ask.ts`'s `validateSynth`, and copies drift. I could not call the real function:
it is not exported from `@potsherd/core`'s barrel, `packages/core/src/index.ts` is **reserved**, and
`packages/core/package.json`'s `exports` map exposes only `"."`, so a deep import from the CLI does
not resolve. The probe is a strict subset of `validateSynth`'s conditions, so it cannot refuse
anything the binary path would accept, and there is a test on the exact input that separates them.
If the barrel's owner adds one name, the duplication goes away:

```diff
 export {
   ask,
   filterAnswer,
+  validateSynth,
   excerptUnits,
```

and `hostReply`'s last check becomes `if (n > 0 && validateSynth(value) === null) throw …`.

**4. I did not bisect when the string form stopped working** — `VERIFICATION-4 §E7` left that open
and it is still open. I fixed the behaviour without establishing whether it ever worked.

**5. No real model backend.** `claude --print` answers `Not logged in` on this machine, which is why
the seam exists and is why every reader-failure measurement here is the no-backend path. So C5's
"six reader calls" is counted from the six reader lines the run printed and their 5.8–5.9 s each,
not from a billed call; I have not watched the bare flag spend money on a machine that can. The
composed path, the `--filter-in` path and every refusal are exercised for real end to end.

**6. macOS only, one platform.** Same gap every phase-10 branch has declared.

**7. `seedDb()`'s 28 other tests still run on one session.** I added the two-session fixture to
everything I wrote and did not rewrite what was there — the existing tests check things a second
session does not change, and rewriting 28 tests to prove a point I proved with 17 new ones would
have been noise. The blind spot in §0.4 is narrowed, not closed.

**8. The model door is untouched and unchecked.** `packages/mcp` imports nothing from
`packages/cli/src/commands/ask.ts` (`grep` over `packages/mcp/src` and `packages/bridges/src`: no
match), so `potsherd_recall`/`_read`/`_graft` cannot have been affected by any of this. I did not
drive the MCP server, because there is nothing on it for this change to have broken.

**9. The known red I was told about.** `POTSHERD_SQLITE=node` printed
`MaxListenersExceededWarning: 11 error listeners added to [Socket]` during the run — the listener
issue in `tests/llm.test.ts` that another worker owns. It is a warning, not a failure: the run finished `53 passed / 1909 passed`, exit 0, with no red test under either driver. I am naming it because I was told to name it if I saw it, and what I saw was the warning without the failure. I touched none of
`tests/llm.test.ts`, `.github/workflows/ci.yml`, `docs/screens/**`, `packages/mcp/src/tools/recall.ts`,
`packages/core/src/recall.ts`, `packages/core/src/vec.ts`, `packages/core/src/render/doctor-line.ts`,
`tests/mcp.test.ts`, `tests/find-warming.test.ts` or `tests/vectors-lazy.test.ts`.

**Disk and processes.** `df` before 5.2 GiB, after 3.6 GiB — three other worktrees are live on this machine and two other suites ran alongside mine, so the delta is not mine alone; my own scratch corpus is deleted. Every `index` in this branch's
measurements ran `--no-embed`; `ps -eo pid,command | grep "[i]ndex --quiet"` returned nothing at
every check, so no background embedder was started and none had to be killed. The demo corpus, its
index and the scratch worktree files are outside the repository and are deleted.
