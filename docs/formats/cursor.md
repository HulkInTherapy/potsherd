# cursor agent transcripts — the format, and what it does not contain

> characterised in phase 1 (T1.3b) against the four real transcripts on the author's machine —
> **857 records**, written 2026-05-03 → 2026-05-08. This supersedes the "record shape to be
> characterised in phase 1" placeholder in `plans/research/formats.md` and corrects three details
> in `docs/upstream/PHASE-1-SCOUT.md` §C2 (marked **correction** below).
>
> adapter: `packages/core/src/adapters/cursor.ts` · fixtures: `tests/fixtures/cursor/` ·
> tests: `tests/adapters/cursor.test.ts`

## scope

potsherd reads **`~/.cursor` and nothing else**. Cursor keeps the title, the model, the git branch
and the authoritative cwd in VS Code's `globalStorage`/`workspaceStorage` sqlite databases, which
are outside the five read-only inputs `plans/00-README.md` names. Decision logged in
`plans/04-DECISIONS.md`, 2026-08-21, "cursor adapter reads ~/.cursor only". Fields that cannot be
known are left **undefined**; none is guessed.

## paths

```
~/.cursor/projects/<project-slug>/agent-transcripts/<uuid>/<uuid>.jsonl
~/.cursor/projects/<project-slug>/agent-transcripts/<uuid>/subagents/<uuid2>.jsonl
```

- `<uuid>` is Cursor's `composerId`. It is the **session id**: the directory name and the file
  basename repeat it. Nothing inside the file carries it.
- `subagents/*.jsonl` → `isSidechain: true`, `parentSessionId` = the enclosing `<uuid>`. The path
  *is* the join; there is no id linking a `Subagent` tool call to the child transcript it spawned.
  Same rule as Claude Code's `*/subagents/*.jsonl`.
- `<project-slug>` has **three shapes**, and discovery must survive all three:

  | shape | example | meaning |
  |---|---|---|
  | path slug | `Users-example-demo-app` | a workspace folder. leading `/` dropped, then every `/` **and every `_`** replaced by `-` |
  | ms-epoch integer | `1769488977462` | a Cursor window with **no folder open**, keyed by creation time. 9 of 47 dirs here |
  | literal `empty-window` | `empty-window` | same, unkeyed |

  Temp workspaces show up as path slugs of `/var/folders/…` . On this machine **45** project
  directories exist and only **3** have an `agent-transcripts/` at all; only **2** are non-empty
  (the third is `1769488977462`, whose `agent-transcripts/` is empty).
- `~/.cursor/projects/.agent-data-cleanup-2026-08-20` is a **zero-byte marker proving Cursor prunes
  this tree**. The two surviving sessions are a remnant — the same disease potsherd exists to
  treat, on a second harness. Worth a line in `audit`.
- **no version marker anywhere in `~/.cursor`.** `argv.json` is stock VS Code boilerplate and
  carries no version; there is no `product.json`, no changelog key. The Cursor build that wrote
  these files is **not recorded in any file potsherd is allowed to read**, so
  `doctor`'s "coverage per harness+version" is per-harness only for cursor.

## records

**There is no `type` field.** Every record on disk is exactly two keys, 857/857:

```
{"role": "user" | "assistant", "message": {"content": [ …blocks… ]}}
```

`message` has exactly one key (`content`, an array) in all 857. No `id`, no `uuid`, no
`parentUuid`, no `sessionId`, no `timestamp`, no `version`, no `cwd` — at any level.

| role | records | block types |
|---|---:|---|
| `assistant` | 748 | `text` 433, `tool_use` 958 |
| `user` | 109 | `text` 109 |

There are **no `tool_result` blocks, no `system` role and no thinking/reasoning block type**.
Reasoning is flattened into `text` as bold-headed prose. Block key sets are fixed:
`{type, text}` and `{type, name, input}`.

### shape (a) — `role:"user"`, a genuine human prompt

```json
{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Friday, May 8, 2026, 6:05 AM (UTC+5:30)</timestamp>\n<user_query>\nadd a health check endpoint and wire it into the router\n</user_query>"}]}}
```

### shape (b) — `role:"user"`, a system-injected continuation (no human typed this)

```json
{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Monday, May 4, 2026, 12:47 AM (UTC+5:30)</timestamp>\n\n<user_query>The above subagent result is already visible to the user. DO NOT reiterate or summarize its contents unless asked, or if multi-task result synthesis is required. Otherwise do not say anything and end your turn.</user_query>"}]}}
```

### shape (c) — `role:"user"` behind an attachment preamble (still a genuine prompt)

```json
{"role":"user","message":{"content":[{"type":"text","text":"[Image]\n<image_files>\nThe following images were provdied by the user and saved to the workspace for future use:\n1. /Users/example/demo-app/assets/image-00000000-0000-4000-8000-000000000000.png\n\nThese images can be copied for use in other locations.\n</image_files>\n<timestamp>Monday, May 4, 2026, 2:45 AM (UTC+5:30)</timestamp>\n<user_query>\nmatch the button colour in the screenshot\n</user_query>"}]}}
```

### shape (d) — `role:"assistant"`, text only

```json
{"role":"assistant","message":{"content":[{"type":"text","text":"I will look at the router first, then add the endpoint."}]}}
```

### shape (e) — `role:"assistant"`, text plus batched `tool_use`, object `input`

```json
{"role":"assistant","message":{"content":[{"type":"text","text":"**Planning the change**\n\nRouter first, then the handler."},{"type":"tool_use","name":"ReadFile","input":{"path":"/Users/example/demo-app/src/router.ts","offset":1,"limit":200}},{"type":"tool_use","name":"Glob","input":{"target_directory":"/Users/example/demo-app","glob_pattern":"src/**/*.ts"}}]}}
```

### shape (f) — `tool_use` with a **string** `input` (every `ApplyPatch`)

```json
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"ApplyPatch","input":"*** Begin Patch\n*** Add File: /Users/example/demo-app/src/health.ts\n+export function health() {\n+  return { ok: true };\n+}\n*** End Patch"}]}}
```

### shape (g) — the malformed tool name (sole instance, subagent file line 6)

```json
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Grep path\n/Users/example/demo-app","input":{"pattern":"^export function","glob":"*.ts"}}]}}
```

*(every example above is redacted and synthetic: paths, prompts and uuids are invented; only the
literal boilerplate Cursor itself emits — including its own typo, "provdied" — is reproduced.)*

## telling a human prompt from an injected one

All 109 user records wrap their body in `<user_query>`, so the tag proves nothing.
**The discriminator is the character immediately after the opening tag:**

- newline → a genuine human prompt. **105 / 109.**
- text → a system-injected continuation. **4 / 109**, two fixed literals: the
  "The above subagent result is already visible…" body after each `Subagent` call, and
  "Briefly inform the user about the task result…" after each background task.

Structural preambles sit **before** the first `<user_query>`: `<timestamp>`, `[Image]` markers,
`<image_files>`, `<uploaded_documents>`. Anything angle-bracketed *inside* the query is user-pasted
content — Python tracebacks contributed `<module>` — so only the region before the first
`<user_query>` is ever treated as structure, and the body ends at the **last** `</user_query>`.

## time

**Correction to the scout:** the scout reported 93 timestamped prompts and treated `<timestamp>` as
a line-leading prefix. It is not always leading — 10 records put an attachment preamble in front of
it. Non-anchored, **107 of 109 user records carry a `<timestamp>`**; the 2 without are the first
records of the two subagent transcripts.

```
<timestamp>Friday, May 8, 2026, 6:05 AM (UTC+5:30)</timestamp>
```

- minute precision, offset always present in this corpus, weekday always present.
- **assistant records have no timestamp at all.** Everything between two prompts is undated.
- subagent transcripts have **no timestamp anywhere**.

**`new Date()` must not be used on this string.** V8 treats the parenthesised `(UTC+5:30)` as a
comment and parses the rest in the *host's* zone, so the same transcript indexes at `00:35Z` on a
machine in IST and `06:05Z` in a UTC CI container — a five-and-a-half-hour lie in every `--since`
filter. `parseCursorTimestamp()` reads the offset explicitly. An absent offset is treated as UTC.

Consequently:

- `startedAt` = the first prompt's own stamp when the file has one, else **file mtime**.
- `endedAt` = **file mtime**, always. The last prompt stamp is not the end of the session; an
  undated assistant run follows it. (Checked: mtime lands 1 minute after the last prompt stamp in
  one main transcript and 6 minutes after it in the other — always after, never before.)
- an exchange with no stamp of its own inherits the last stamp seen, and failing that the
  session start. Never invented, always explained.

## ordering

Line order is **the only ordering information the format contains**. No ids, no parent pointers,
no per-turn times. An exchange therefore opens on a genuine human prompt and stays open until the
next one; every assistant record in between belongs to it. That grouping is not a convenience —
runs reach **42 consecutive assistant records** before the next prompt, and parallel tool calls
batch into a single record, so nothing else reconstructs a turn.

Assistant records are whole messages, never streaming deltas. Blocks per record run 1–10 (355
records of 1, 285 of 2, 44 of 3, 1 of 10); the common shapes across the corpus are
`(text, tool_use)` 261, `(tool_use)` 261, `(text)` 94, `(text, tool_use, tool_use)` 29.

## what fills `03 §2`, and what cannot

| field | cursor | how |
|---|---|---|
| `id` | ✅ | directory / file basename (the `composerId`) |
| `harness` | ✅ | `cursor` |
| `sourcePath` | ✅ | |
| `project` | ⚠️ **recovered** | an absolute directory found in this session's own tool inputs whose `cursorSlug()` equals the project directory name. Both real projects resolve, including the underscore case (`Users-zebra-maths-practice` → `/Users/zebra/maths_practice`) that slug inversion can never reach. Corroboration, not proof: `/a/b_c` and `/a/b-c` slug alike. `''` when nothing agrees — window-id and `empty-window` projects never have a cwd |
| `projectSlug` | ✅ | the directory name, verbatim |
| `startedAt` | ⚠️ | first prompt stamp, else **mtime** |
| `endedAt` | ⚠️ | **mtime** |
| `title` | ❌ | `composerData.name` in VS Code sqlite. Out of scope. A *derived* title is phase 2's job (`card`), not L0's |
| `gitBranch` | ❌ | `composerData.trackedGitRepos[].branches[].branchName` in VS Code sqlite |
| `entrypoint` | ❌ | `agentBackend` in VS Code sqlite. The tree shape hints at the IDE agent; hinting is not knowing |
| `model` | ❌ | `composerData.modelConfig.modelName` in VS Code sqlite |
| `isSidechain` | ✅ | path contains `/subagents/` |
| `parentSessionId` | ✅ | the enclosing `agent-transcripts/<uuid>` directory |
| `agentName` | ❌ | the parent's `Subagent.subagent_type` exists but no id joins it to a child file |
| `counts.userPrompts` | ✅ | genuine human prompts only (105 across the corpus) |
| `counts.assistantTurns` | ✅ | `role:"assistant"` records (748) |
| `counts.toolCalls` | ✅ | `tool_use` blocks (958) |
| `counts.bytes` | ✅ | file size |
| `status` | ✅ | `live` |
| `Exchange.ts` | ⚠️ | see **time** |
| `Exchange.toolCalls[].result` | ❌ | **cursor persists no tool output at all** |
| `Exchange.toolCalls[].isError` | ❌ | same reason |
| `Exchange.parentUuid` | ❌ | no record carries an id |
| `Exchange.filesTouched` | ✅ | `path`, `file_path`, `paths[]`, `target_notebook`, and `*** Add/Update/Delete File:` headers inside `ApplyPatch` strings. Directory-valued keys (`target_directory`, `working_directory`, `target_directories`) are excluded |

## tool calls

958 calls, 19 distinct names plus one malformed:
`Shell` 241, `ReadFile` 189, `ApplyPatch` 120, `Read` 72, `TodoWrite` 64, `Glob` 58,
`EditNotebook` 41, `ReadLints` 34, `AwaitShell` 27, `rg` 22, `Delete` 17, `StrReplace` 16,
`Write` 13, `WebSearch` 11, `WebFetch` 11, `Grep` 11, `updateCurrentStep` 6, `SemanticSearch` 2,
`Subagent` 2.

`tool_use` has **no `id`**, so there is no correlation key even if results existed. `input` is an
object 838× and a **raw string 120×** (every `ApplyPatch`, up to 15,424 chars) — `input.path` on
those yields `undefined` at best.

## what breaks a naive parser

1. **no `type` field** — `record.type` is `undefined` on 100% of records; the discriminator is `role`.
2. **polymorphic `tool_use.input`** — object 838×, string 120×.
3. **a tool name with an embedded newline** — `"Grep path\n/Users/…"`, one occurrence. Truncated at
   the first newline so the tool histogram stays clean; the full text survives in `input`.
4. **no trailing newline on any file.** `wc -l` under-reports by exactly one on all four. A reader
   that requires `\n` termination drops the last record of every cursor session. But an
   unterminated final line is also what a session *still being written* looks like, so the adapter
   consumes it only if it parses as whole JSON, and otherwise rewinds `endOffset` to its first byte.
5. **byte-identical duplicate records.** **Correction to the scout:** it reported one duplicate
   pair; there are **12** across the four files (9 in the largest, 1 in each of the others). Content-hash
   dedup would silently drop real records, so exchange ids key on `(sessionId, seq)` and duplicates
   are kept verbatim.
6. **version drift with no version field** — subagent transcripts omit `<timestamp>` entirely and
   their first "user" record is the parent's prompt. Infer from the path.
7. **long lines** — max 57,934 bytes; max single text block 39,576 chars.
8. **non-path project directories** — bare ms-epoch integers and `empty-window`, plus session
   directories whose `.jsonl` Cursor already deleted. None may throw.
9. **slug ambiguity** — `_` and `/` both became `-`. Never invert the slug; corroborate it.
10. **no base64, no embedded images.** Images live as separate PNGs under
    `~/.cursor/projects/<slug>/assets/` and are referenced by path only.

## the doctor line

```
cursor: no timestamps on assistant turns (session times come from file mtime), no tool results
recorded at all, and title/model/git-branch are unavailable — they live in VS Code's
workspaceStorage, which potsherd does not read.
```

Exported as `CURSOR_DOCTOR_NOTE` from `packages/core/src/adapters/cursor.ts`.

## corrections to `docs/upstream/PHASE-1-SCOUT.md` §C2

1. **timestamp coverage** — the scout said 93 of 109 prompts carry a `<timestamp>` and implied the
   tag leads the record. Non-anchored, it is **107 of 109**; 10 records put an attachment preamble
   in front of it. The 2 genuine misses are the subagent transcripts' first records.
2. **duplicate records** — the scout found one duplicated pair. There are **12**.
3. **cwd is not unknowable from `~/.cursor`** — the scout concluded the cwd requires
   `workspace.json` outside `~/.cursor`. It does not: absolute paths in the session's own tool
   inputs, filtered by a slug match, recover both real project roots including the underscore case.
   It remains corroboration rather than proof, and is reported as such.
4. **counts that drifted since the scout ran** (Cursor keeps pruning): 45 project directories now,
   not 47; longest line 57,934 bytes, not 57,862. The 857-record total and all per-record
   statistics are unchanged.

Everything else the scout recorded about this format was verified true, including the 857-record
count, the two-key record shape, the zero `tool_result` blocks, the polymorphic `input`, the
malformed tool name, the missing trailing newline, and the `<user_query>`-newline discriminator.
