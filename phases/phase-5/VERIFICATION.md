# phase 5 — VERIFICATION

**verifier:** a fresh worker that authored none of phase 5, ran against `8f63d20`, did not
sub-delegate, and carried the command it ran and its output for every finding.
**result: 15 defects.** The run is **12 · 8 · 9 · 7 · 13 · 15**.

Every defect and its disposition is in `HANDOFF.md`. This file records how the check behaved, what
it declined to do, and what the orchestrator re-confirmed before acting — because that is what
decides whether the number means anything.

---

## the two critical findings

**D1 was the orchestrator's own.** During the phase-5 integration commit I pasted T5.6's two
forwarding lines into `find.action` instead of `ask.action`. So `ask --readers-out` declared its
options, never received them, wrote no file, and made **four real agent-SDK calls** — under a flag
whose own privacy receipt says *"no model was called to write it."* The receipt was stating
something false and I had put it there.

The verifier's diagnosis of *why it shipped green* is the part worth keeping:

> `grep -rn readersOut tests/` shows every T5.6 test calls `writeReadersFile` / `replayReaders`
> directly. **Nothing in 1,137 tests goes through commander.**

**D2: a SKILL.md's frontmatter truncated by its own comment block.** A `# ------` line is read as
the closing `---` fence, so Claude Code's loader saw `name:` and stopped — losing the `description`
(the only field that decides whether a model-invocable skill fires) and `user-invocable: false`
(which would have turned a deliberately model-only skill into a slash command). It bisected the
failure to the line *shape*:

```
dashline          description LOST
blank-hash-line   description SEEN
middot            description SEEN
two-comments      description SEEN
```

The three-candidate comparison block T5.2 was proudest of is exactly what broke it.

## what it declined to do, and said so

- **It did not run `claude plugin marketplace add`**, because that installs into `~/.claude`, which
  the brief made read-only. It answered the marketplace question with `git archive HEAD` instead —
  and found the situation *worse* than the worker had reported.
- **It marked the hand-edited-quote attack `UNVERIFIED`.** `--readers-in` still makes one
  synthesizer call and the machine answers `Not logged in`, so the attack could not complete. It
  reasoned through why the code *should* be safe — `filterAnswer` resolves each quote against the
  **live** transcript bytes, not the file's assertion — and then refused to call that a pass.
- It listed six things it could not verify. **That section being empty would itself have been
  suspicious**, and it was not empty.

## what held up under attack, checked hard

Recorded because a verification that only lists failures says nothing about what is solid.

- **`setup` merges, never clobbers.** Every pre-existing server survived in all six JSON clients,
  plus unrelated top-level keys; the codex TOML result is a **byte-prefix** of the original.
  Malformed JSON, JSONC with comments, a read-only file, an existing `potsherd` key, and a symlink
  were each attacked: refused cleanly, file untouched, symlink preserved.
- **The MCP server never crashed** — raw garbage, truncated JSON, unknown tool, wrong types, a
  **2 MB** query, `1e12` pagination, `../../etc/passwd` to the one writer. Tool errors, and
  `tools/list` answered normally afterwards.
- **Six `--readers-in` replay attacks all rejected before any model call**: different question,
  different `k`, mismatched `sessionIds`, missing outputs, truncated file, missing version.
- **The CI privacy guard is not itself lying** — it verified that *removing* a line from the
  published receipt makes the guard fail, not just changing one.

## the orchestrator's own re-confirmation

`plans/08` rule 4: never act on a worker's conclusion you have not seen the output for.

| claim | how it was re-confirmed |
|---|---|
| `--readers-out` was mis-wired | re-ran after the fix: the file is written and the receipt reads `no model call was made (0)` |
| the frontmatter fence | `claude plugin validate` warned `No description in frontmatter` before, passes clean after |
| the guard catches all three families | planted my own violation, not the worker's: three families flagged, exit 1, exit 0 once reverted |
| the hooks now fail loudly | read T5.9's two-machine red/green harness, then confirmed `hook-failures.log` is written and read back |
| the model-invoked skill fires | ran it, with a negative control that used **no tools** |
| graft changes the next answer | ran it, with a control that took **16 turns and answered wrongly** |

## three CI-only defects, none reproducible locally

Recorded because the pattern is now the phase's most transferable lesson.

1. **The MCP deadline test** asserted `/gave up after/` unconditionally. On CI there is no `claude`
   and `@anthropic-ai/sdk` is an uninstalled `optionalDependency`, so the tool correctly answers
   *"no way to reach a model"* — which the test above it already asserts. **It cannot be made to
   fail on a machine with Claude Code installed**: `availability()` finds a `claude` at a well-known
   absolute path even with `PATH` emptied. Three reproduction attempts all passed.
2. **`XDG_CONFIG_HOME`** was not cleared alongside `HOME` in the privacy-receipt guard, so
   opencode's line resolved outside the throwaway home and could not be tildified. **T5.5 had
   flagged this exact gap and called it "insurance, not a live failure."** It was live.
3. **`ENOTEMPTY` on Linux only** — the hook tests are the first here to exercise something designed
   to outlive its caller, and a detached `rescue` was still writing while the recursive remove
   walked the sandbox. Cleanup made patient; the hook left detached, because making it synchronous
   to suit the test would delete the property the test exists to check.

And one the guard caught on the orchestrator: the commit explaining why a home path leaked
**contained a literal home path**. Rephrased, not allowlisted.

## the honest residue

Three definition-of-done boxes do not pass and are recorded in `HANDOFF.md` as failures rather than
smoothed over — chiefly that **a marketplace install does not produce a working plugin**, which is
the install story for everyone who is not us. `03 §9` and `03 §11` are both now false in ways
logged in `plans/04-DECISIONS.md`, and the codex plugin is documented as inferred rather than tested.
