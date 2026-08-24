# FIX-A — the agent-ergonomics defects

**Branch** `work/FIX-A`, cut from `origin/main` at `82bb538`.
**Defects assigned** D1 ★★★★★, D7 ★★★, D8 ★★, D9 (part).
**Verdict** three fixed, one reproduced and blocked on a reserved file.

| defect | verdict | where the fix landed |
|---|---|---|
| D1 | **fixed** | `packages/core/src/threads.ts`, the core barrel, `packages/mcp/src/tools/thread.ts` |
| D7 | **reproduced, not fixed** — the repair is inside `packages/core/src/ask.ts`, reserved | lines below, §D7 |
| D8 | **fixed** | `packages/core/src/adapters/{opencode,copilot,types}.ts`; one line per adapter owed in `doctor.ts` |
| D9 (part) | **fixed** | `plugins/{claude-code,codex}/bin/potsherd-mcp` |

Every fix was written test-first: the test was added, run, watched fail for the
stated reason, and only then repaired. The failing output is quoted per defect.

---

## D1 — `potsherd_read` could not see a thread, and told the model so

### what was actually wrong

`packages/mcp/src/tools/thread.ts` read `core.resolveThread` at runtime and,
finding `undefined`, returned a thread consisting of exactly the session it was
handed, labelled `via: "session-only"`, with a note explaining the gap **to the
model**. The name was never written. Core had `threadOf(db, sessionId)`,
`threadTotals`, `storedThreads`, `inThread` — and exported **none of them**:
`packages/core/src/index.ts` had no line for `./threads.js` at all.

So the probe never once succeeded, and `potsherd_read` — one of the
archaeologist's two tools and the stated replacement for filesystem `Read` —
reproduced audit F4 verbatim at the model door, in the release that claims to
have fixed it.

Two independent alarms failed to ring, which is why it survived the phase:

1. the fallback was **silent by design**;
2. `threadsAvailable()`, the function whose entire job was to report the
   capability missing, had **no callers** — confirmed by
   `grep -rn "threadsAvailable" packages tests plugins scripts docs skills agents`,
   which returned only its own definition.

A missing capability therefore announced itself only to the model, in prose, at
the moment it mattered. That is the worst possible audience for it.

### the test, red first

```
FAIL tests/threads.test.ts > the chain reaches the model, not just the CLI
  > core resolves a thread from any member id8, chain order oldest first
TypeError: resolveThread is not a function

FAIL tests/threads.test.ts > the chain reaches the model, not just the CLI
  > potsherd_read on the fork child returns the whole chain, via core
AssertionError: expected 3 to be 13
```

The fixture is `writeChain(parentPairs: 10, copiedRecords: 20, ownPairs: 3)` —
the shape `claude --resume` actually writes, already used by this file: records
copied whole with their uuids, `sessionId` rewritten, `promptId` lost. The
parent holds 10 exchanges, the fork child 3, the thread 13.

### the fix

**`packages/core/src/threads.ts`** — `resolveThread(db, ref)`, the signature
`T10.6-REPORT.md` §g asked for, plus one field:

```ts
export interface ThreadResolution {
  threadId: string;
  sessionIds: string[];
  startedAt: string | null;
  endedAt: string | null;
  exchanges: number;
  ambiguous?: SessionCandidate[];
}
```

It is a join of three functions that already existed — `resolveSession` for the
reference, `threadOf` for the chain, `threadTotals` for the arithmetic. **No new
lineage rule, nothing re-derived**: a second uuid-overlap threshold at the MCP
surface would be a second answer to "which sessions are the same work".
Resolution is `resolveSession`'s so `potsherd show <id8>` and
`potsherd_read {"thread":"<id8>"}` cannot mean two different sessions. A session
no fork touched resolves to a chain of one, never null, so a caller may treat
"the thread" as the unit without asking first; `null` means only that the
reference named nothing.

`ambiguous` is the one addition to the owed signature (a superset, so it is
compatible). Without it the MCP layer could no longer distinguish "nothing
matched" from "eight characters that match four threads", and showing someone
the wrong conversation confidently is the one failure a memory tool cannot
recover from.

**The core barrel** now exports the threads module — `resolveThread`,
`threadOf`, `threadTotals`, `storedThreads`, `inThread`, `sessionDate`,
`sessionDay`, `LINEAGE_HARNESSES`, `OVERLAP_THRESHOLD`, `MIN_SHARED_RECORDS`
and the types. It had exported nothing from that file.

**`packages/mcp/src/tools/thread.ts`** — the probe, the fallback,
`CORE_THREAD_RESOLVER` and the dead `threadsAvailable()` are **deleted**.
`resolveThread` is a plain import, so its absence is a build failure rather
than a note to the model. `via` is retained on the reply — it is what tells a
reader the chain came from the index rather than from the caller's reference —
and now has one legal value.

### the fallback is loud, per the orchestrator's mid-task ruling

All three parts covered:

1. `resolveThread` exists in core and is exported from the barrel.
2. The fallback is **deleted**, and two tests fail if it returns:
   `tests/threads.test.ts` asserts `via === 'core'` and `note === null` on the
   chain fixture; `tests/mcp.test.ts` — which used to accept
   `['core', 'session-only']` on **two** assertions, and that latitude is
   exactly how the defect passed a release — now asserts `via === 'core'`,
   `note === null`, and that the string *"does not model fork/resume chains"*
   appears nowhere in the reply.
3. `threadsAvailable()` is **deleted**.

I also swept for the general pattern:
`grep -rn "typeof .* === 'function'" packages/*/src` returns exactly one hit,
`packages/bridges/src/claude-mem.ts:123` (`process.getuid`), which is a platform
check, not a cross-module capability probe. There is no second instance of this
defect in the tree.

### THE ARTIFACT — `potsherd_read` on a fork/resume child

Same fixture, same call, same second. `potsherd_read {"thread":"bbbbbbbb", "from":1, "to":200}`
where `bbbbbbbb` is the resume child of `aaaaaaaa`.

**BEFORE**

```json
{
  "thread": {
    "id": "bbbbbbbb-…", "id8": "bbbbbbbb",
    "via": "session-only",
    "note": "this build of potsherd does not model fork/resume chains yet, so this thread is the one session you named. If the work continued under another id, it is not in this reply.",
    "links": [ { "sessionId": "bbbbbbbb-…", "total": 3, "offset": 1 } ]
  },
  "total": 3,
  "shown": 3,
  "exchanges": ["1: bbbbbbbb@1", "2: bbbbbbbb@2", "3: bbbbbbbb@3"],
  "citations": ["bbbbbbbb · potsherd-threads · claude · 3 exchanges · 2026-08-20"]
}
```

**AFTER**

```json
{
  "thread": {
    "id": "aaaaaaaa-…", "id8": "aaaaaaaa",
    "via": "core",
    "note": null,
    "links": [
      { "sessionId": "aaaaaaaa-…", "total": 10, "offset":  1, "endedAt": "2026-08-12T00:21:00.000Z" },
      { "sessionId": "bbbbbbbb-…", "total":  3, "offset": 11, "endedAt": "2026-08-20T00:07:00.000Z" }
    ]
  },
  "total": 13,
  "shown": 13,
  "exchanges": [
    "1: aaaaaaaa@1",  "2: aaaaaaaa@2",  "3: aaaaaaaa@3",  "4: aaaaaaaa@4",
    "5: aaaaaaaa@5",  "6: aaaaaaaa@6",  "7: aaaaaaaa@7",  "8: aaaaaaaa@8",
    "9: aaaaaaaa@9", "10: aaaaaaaa@10", "11: bbbbbbbb@1", "12: bbbbbbbb@2",
   "13: bbbbbbbb@3"
  ],
  "citations": [
    "aaaaaaaa · potsherd-threads · claude · 10 exchanges · 2026-08-12",
    "bbbbbbbb · potsherd-threads · claude ·  3 exchanges · 2026-08-20"
  ]
}
```

The thread is addressed by its **root**, both links are measured, `position` is
thread-global and `seq` stays session-local — because `<id8>@<seq>` is what a
citation means everywhere else in the product — and there is now a citation for
the parent, so the ten exchanges of real evidence that used to be invisible are
quotable.

### what D1 did NOT change, and why

`packages/mcp/src/tools/recall.ts` groups `recall` rows by `threadIdOf(row)`,
which reads a `threadId` field off a core `RecallSession`. **Core's recall row
still carries none**, so a `recall` reply still reports `threadOf: "session"`
for a session that is in fact a link in a chain. That is the same class of
silent degradation as D1 and it is **not fixed here**: the field is added in
`packages/core/src/recall.ts`, which is reserved. It is not a `potsherd_read`
defect, so it was out of D1's stated scope, but it is the obvious next one and
should not be left to be rediscovered. See §"lines I owe you" for the shape.

---

## D7 — the prompt hands the model quotes its own filter rejects

**Real, reproduced exactly, and NOT fixed — the repair is inside a reserved
file.**

### the mechanism, end to end

`cards/transcript.ts:unitText()` renders an excerpt as
`user: …\n\nassistant: …`. The readers quote from that, so a reader's quote
carries the label. `synthPrompt` echoes the reader's quotes verbatim and closes
with **"Copy each quote exactly as printed, including its seq."**
`filterAnswer` then matches the model's quote against
`quotableText(unit.text)` — which strips the labels, correctly, because they
are not in the transcript.

So the filter strips the label from the **haystack** and nothing strips it from
the **needle**. Reproduced in a scratch probe against the shipped code:

```
PROMPT (as sent):
  quotes:
    seq 12  "user: the pooler is 500ing on deploy"
  Use only the session_id values printed above. Copy each quote exactly as printed, including its seq.

filterAnswer(… quote: "user: the pooler is 500ing on deploy" …):
  evidence: []
  drops: [ {"kind":"evidence","reason":"not-a-quote", …},
           {"kind":"sentence","reason":"no-citation","text":"The pooler was 500ing."} ]
```

Every sentence dropped, for a perfectly real quotation of a real exchange. It
is silent loss of TRUE evidence, on the path the phase's headline claim rests
on, and it punishes precisely the model that obeyed the instruction.

### where the fix belongs: **the filter's normalisation**

**The excerpt — rejected.** Removing the labels from `unitText()` fixes the
symptom by removing information. The labels are what make the two sides of an
exchange legible to a reader model, and `unitText` also feeds the cards and the
markdown mirror, which would then be worse for a human too. It also fixes only
this one prefix: any future excerpt decoration reopens the same hole.

**The instruction — rejected.** "Copy each quote exactly, except the speaker
label" makes the citation guarantee depend on compliance. The whole architecture
of `ask` is that the guarantee is **arithmetic, not obedience** — that is why
`filterAnswer` exists and why F2's `--filter-in` seam is worth anything. It also
scales badly: the reader prompt would need the same clause, and so would every
prompt added later.

**The filter's normalisation — CHOSEN.** `quotableText()` already encodes the
rule *"the speaker labels are not part of the transcript."* The bug is that the
rule was applied to one side of a comparison. Applying it to the other side
costs nothing in trust: the emitted quote is still `body.slice(span.start,
span.end)` — the transcript's own bytes — so nothing is forgiven and no
fabrication becomes reachable. It fixes every producer at once (binary path,
`--readers-in`, `--filter-in`, MCP) and cannot be un-fixed by a prompt edit.

One constraint the fix must not overreach: only a **leading** label comes off.
An interior `assistant:` must keep failing, because a quote carrying one is a
quote of both sides of the join presented as continuous prose — a fabrication
of contiguity, which `tests/ask.test.ts` has pinned since phase 4.

### the test

`packages/core/src/ask.ts` is on FIX-A's do-not-touch list, so the defect ships
as a **self-destructing marker**:
`tests/ask.test.ts` → `it.fails('D7 (UNFIXED): drops a quote copied exactly as
the prompt instructs')`. Vitest passes it *because the body throws*. Apply the
lines below and it goes **red**, forcing the `.fails` to be removed and the
marker to become a normal regression test. Beside it, a plain passing test —
`still refuses a quote that carries the join, label and all` — pins the half the
fix must not overreach into.

---

## D8 — the adapter relabelling, half-applied

T10.12 measured two adapters against real builds and split their labels. Only
copilot's human line was updated.

### what was still wrong

- `OPENCODE_DOCTOR_NOTE` opened *"this adapter was written from documentation,
  not from a real store"* — a sentence the **same phase** falsified by running
  `opencode-ai 1.18.21` end to end and indexing what it wrote (§4: *"the only
  full round trip of the four"*).
- All four of opencode's `doctorLine()` notes still ended `unverified format`,
  about the one harness of the four that got a full round trip.
- copilot's rewritten ready line said *"format known wrong — see `doctor
  --json`"*, and `doctor --json` carries a bare `unverified: true` that reads as
  *nobody looked*. The one surface it pointed at was the one contradicting it.

### the tests, red first

```
FAIL tests/adapters/opencode.test.ts > the opencode label says what was measured (D8)
  > the doctor note no longer claims nobody ran this against a real store
AssertionError: expected 'opencode: format unverified — this ad…' not to match /not from a real store/

FAIL … > no doctor line calls the format unverified any more
AssertionError: opencode ready … 3 sessions · 1 store unsupported · unverified format:
               expected … not to contain 'unverified'

FAIL tests/adapters/copilot.test.ts > the copilot label points at nothing that contradicts it (D8)
  > the ready line says where the turns are instead of deferring to --json
AssertionError: expected 'copilot ready …' not to contain 'doctor --json'

FAIL (both files) > exports the provenance as data, not only as a sentence
TypeError: Cannot read properties of undefined (reading 'measured')
```

### the fix — and the one claim I did NOT invent

`OPENCODE_DOCTOR_NOTE` now carries **both halves of §4's split label**:
discovery and session metadata verified CORRECT (the store is at
`~/.local/share/opencode/opencode.db` exactly where the adapter looks;
`describeStore` accepts it; title, directory and both timestamps parse), and
message content verified UNREAD (at 1.18.21 `message` has no role column and no
text column — the role is inside a `data` JSON blob and the turn text is in the
child `part` table, which this adapter does not join — so a real session indexes
with 0 prompts). The four doctor lines lose `unverified format`; the ready line
carries `content unread at 1.18.21 — text is in part.data` instead.

copilot's ready line is self-sufficient now:
`format known wrong at 1.0.80 — turns are in session-store.db`.

**Both booleans stay `true`, deliberately.** §5 instructs it in words —
*"Until then `COPILOT_FORMAT_UNVERIFIED` should stay `true`"* — and §6 records
both adapters keeping *a form of* the label ("Two of five keep a form of
`unverified`, and gemini keeps it outright"). Flipping them would have been a
new claim, which the brief forbids. What changed is that **a boolean is no
longer the whole answer**: `FormatProvenance` (new, in `adapters/types.ts`)
carries the build measured, the parts observed correct and the parts observed
wrong, and each adapter exports one — `OPENCODE_FORMAT_PROVENANCE`,
`COPILOT_FORMAT_PROVENANCE`. Every string in them is a measurement from §4 or
§5; there is no claim in this commit that T10.12 did not make.

The reason a boolean could not hold it: the two ways of squashing the split are
both lies. `true` says *nobody looked* about the one harness that got a full
round trip; `false` says *it works* about an adapter that returns 0 prompts from
a real session.

The remaining half of D8 — `doctor --json` publishing the provenance so the
human line and the JSON stop disagreeing — is one line per adapter in
`packages/cli/src/commands/doctor.ts`, which is FIX-B's. Exact lines below.

---

## D9 (part) — the shim said six tools

`plugins/claude-code/bin/potsherd-mcp` is the last thing a user sees when the
server does not start, and the only place that says what a failed start costs
them. It said *"Its six tools all read the index"* (there are three), and *"the
session-archaeologist agent is left with no tools but Read"* — an agent that has
had no `Read` since T10.6 removed it for audit F3. Both shims' headers still
described that agent as holding *"five `mcp__plugin_potsherd_potsherd__*`
entries plus `Read`"*.

The tests derive both facts rather than restating them, so a fourth tool or a
renamed one fails the suite instead of ageing the shim: the count word in the
prose must equal `TOOLS.length`, the tool names it lists must be exactly
`TOOLS`, and neither shim may promise a `Read` whose absence is asserted from
the agent's own frontmatter.

One detail worth keeping: the count assertion unwraps shell-comment line breaks
first. The stale claim was `six\n# tools`, which is one phrase to a reader and
two lines to a regex — the first version of the test passed against the defect.

```
FAIL tests/plugin-install.test.ts > the shim shims describe the server that exists
  > counts the tools the server actually registers
AssertionError: claude-code: shim claims "six tools": expected 'six' to be 'three'

FAIL … > does not promise the archaeologist a Read it no longer has
AssertionError: claude-code: expected … not to match /no tools but `?Read`?/
```

---

## Lines I owe you in reserved files

### 1. `packages/core/src/ask.ts` — the D7 fix (2 edits + 1 helper)

Immediately after `quotableText()` (currently ends around line 702), add:

```ts
/**
 * The speaker label `unitText()` puts at the head of an excerpt.
 *
 * `quotableText()` strips it from the HAYSTACK; nothing stripped it from the
 * NEEDLE, and `synthPrompt` says "Copy each quote exactly as printed" — so a
 * model that obeyed produced `user: …`, `matchSpan` looked for a string that is
 * in no exchange, every quote was dropped `not-a-quote` and every sentence
 * behind it `no-citation`. The instruction and the filter disagreed, and the
 * filter is the half that is code.
 *
 * Only a LEADING label is removed, and only one. An interior `assistant:` is
 * left exactly where it is: a quote carrying one is a quote of both sides of
 * the join presented as continuous prose — a fabrication of contiguity, not a
 * label — and it must keep failing.
 */
const LEADING_SPEAKER_LABEL = /^\s*(?:user|assistant):[ \t]*/;

export function unlabelQuote(quote: string): string {
  return quote.replace(LEADING_SPEAKER_LABEL, '');
}
```

In `filterAnswer`, replace these two lines (currently 854 and 859):

```ts
    if (normaliseQuote(p.quote).length < MIN_QUOTE_CHARS) {
…
    const span = matchSpan(p.quote, body);
```

with:

```ts
    if (normaliseQuote(unlabelQuote(p.quote)).length < MIN_QUOTE_CHARS) {
…
    // The excerpt is printed labelled and the prompt says to copy it exactly;
    // the stored exchange has no label. Strip it from the quote as well as
    // from the body so both sides of the comparison are the same text. The
    // emitted quote is still `body.slice(...)` below — the transcript's own
    // bytes — so this forgives a model nothing.
    const span = matchSpan(unlabelQuote(p.quote), body);
```

(The `MIN_QUOTE_CHARS` edit matters on its own: today a six-character quote can
clear the length gate on the strength of the label.)

Then in `packages/core/src/index.ts` — mine, but it cannot export a symbol that
does not exist yet, so it is deliberately **not** in this branch — add
`unlabelQuote,` beside `quotableText,` (currently line 504).

Finally, delete `.fails` from
`tests/ask.test.ts > D7 (UNFIXED): drops a quote copied exactly as the prompt
instructs` and rename it to `keeps a quote copied exactly as the prompt
instructs`. It will already be asserting the right things.

### 2. `packages/cli/src/commands/doctor.ts` — the other half of D8 (FIX-B)

One line added to each of the two entries. At the `opencode` entry (currently
around line 743), after `unverified: opencodeAdapter.OPENCODE_FORMAT_UNVERIFIED,`:

```ts
    provenance: opencodeAdapter.OPENCODE_FORMAT_PROVENANCE,
```

At the `copilot` entry (currently around line 752), after
`unverified: copilotAdapter.COPILOT_FORMAT_UNVERIFIED,`:

```ts
    provenance: copilotAdapter.COPILOT_FORMAT_PROVENANCE,
```

Both constants are exported and typed `FormatProvenance` (exported from the
core barrel) on this branch, so each line is additive and compiles as written.
`tests/cli.test.ts`'s `doctor --json flags the adapters whose format is
unverified` still passes unchanged — the booleans did not move.

### 3. `packages/core/src/recall.ts` — the D1 remainder (not assigned to me)

`packages/mcp/src/tools/recall.ts` reads `threadId` off each `RecallSession` and
gets `undefined`, so a `recall` reply reports `threadOf: "session"` for a
session that is a link in a chain. The row needs the field:

```ts
  /** The chain this session belongs to (`threads.ts`); its own id when alone. */
  threadId: string;
```

populated from `session_threads` — `threadOf(db, row.id).id` — in whichever
function builds `RecallSession`. `resolveThread`/`threadOf` are now exported
from the core barrel, so no new plumbing is needed. Nothing in `packages/mcp`
needs to change: `threadIdOf` already reads the field and `groupThreads` already
folds on it.

---

## Verification

| | |
|---|---|
| `pnpm test` last line | `Tests  1851 passed (1851)` — 49 files, 147.70s |
| `pnpm typecheck` | 4 of 4 packages `Done`, **0 errors** (core, bridges, cli, mcp) |
| `pnpm build` | 4 of 4 `Done`; `node scripts/vendor-plugin.mjs` re-run, 2 files / 2.6 MB |
| `scripts/check-privacy.py` | **EXIT CODE 0** |
| working tree | clean |

Test count moved 1849 → 1851 across the run; the earlier full run at the D8
commit was 1849, and D7's two markers are the difference.

Invented identifiers in tests and in this report use the fixture ids already in
`tests/threads.test.ts` (`aaaaaaaa…`, `bbbbbbbb…`, `cccccccc…`): one distinct
hex digit in the first eight characters. No real session id, project name, home
path or transcript prose appears in any file this branch touched.

## Commits

```
49e2b91  fix(D1): give core the resolveThread the MCP layer was asking for
a42df8c  fix(D9): the MCP shim describes the three tools that exist, not six
402407a  fix(D8): finish the adapter relabelling on the surfaces a caller reads
ef7306c  D7: reproduce the quote the prompt asks for and the filter rejects
```
