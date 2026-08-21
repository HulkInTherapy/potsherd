# DoD box: "model-invoked recall fires on a natural 'last time…' prompt without being asked"

**PASS**, with a negative control. Run by the orchestrator on 22 aug 2026 against `9c0b21e`+,
Claude Code 2.1.239, plugin loaded with `--plugin-dir` (nothing installed into `~/.claude`).

`plans/07` assigns the in-Claude-Code tests to the orchestrator because they need an interactive
session. They do not: `claude -p --plugin-dir … --output-format stream-json --verbose` exercises the
same path non-interactively and, unlike an interactive session, **leaves a machine-readable record
of every tool the model chose.** That is what makes this box checkable rather than anecdotal.

The prompts and the tool sequence are recorded here. **The transcripts themselves are not committed**
— they contain real session titles from the live corpus, and this repo is public
(`scripts/check-privacy.py`, `00-README.md` ground rules). They are kept at
`/private/tmp/claude-501/-Users-zebra-randomness/169ced20-27ee-4647-9d2c-8fac9217f6bd/scratchpad/skill-{positive,control}.jsonl`.

## the positive case

> what did we decide about pgbouncer and prepared statements last month?

4 turns, 48.6 s, `subtype: success`. Nothing in the prompt names potsherd, a skill, or a tool.

```
TOOL: Skill  {'skill': 'potsherd:remembering-sessions', …}          ← fired unprompted
TOOL: Agent  {'subagent_type': 'potsherd:session-archaeologist', …} ← the skill dispatched the agent
TOOL: mcp__plugin_potsherd_potsherd__potsherd_find  {'query': 'pgbouncer prepared statements'}
TOOL: mcp__plugin_potsherd_potsherd__potsherd_find  {'query': 'pgbouncer'}
TOOL: mcp__plugin_potsherd_potsherd__potsherd_find  {'query': 'prepared statements pooling'}
TOOL: mcp__plugin_potsherd_potsherd__potsherd_find  {'query': 'connection pooling transaction mode'}
TOOL: mcp__plugin_potsherd_potsherd__potsherd_find  {'query': 'asyncpg SQLAlchemy prepared statement'}
TOOL: mcp__plugin_potsherd_potsherd__potsherd_ls    {'since': '2026-07-01', 'limit': 20}
```

Four things this proves at once, none of which a unit test could:

1. **The description works.** The model reached for a `user-invocable: false` skill on a natural
   question. This is also the first evidence that the D2 fix landed — before it, Claude Code saw no
   description at all, and the box could not have passed.
2. **The dispatch chain is real**: skill → `Agent` → `session-archaeologist`.
3. **The MCP tool prefix is `mcp__plugin_potsherd_potsherd__`**, exactly as T5.2 warned it must be.
   Had the plugin name or the `.mcp.json` server key differed, the agent would have loaded with **no
   tools** and answered NOT FOUND — silently.
4. **The agent obeyed its cheap-verb-first rule.** Five `find` calls (sub-second each) widening the
   search, then `ls` — and **never `potsherd_ask`**, which is ~100 s. That ordering was designed in
   T5.2's brief and it held under a real model with no reminder.

## the negative control

> what does a connection pooler do, in general?

1 turn, 19.7 s, **tools used: NONE**. Answered directly from knowledge.

This is the half that makes the positive result mean something. A description that fires on every
question mentioning a pooler is not recall — it is noise, and it would have burned a subagent and
~50 s on a question the model could answer itself. T5.2 proposed three candidate descriptions and
argued for the imperative-first one; that is the one shipped, and it discriminates.

## what this does NOT close

- `/potsherd find|ask|graft` as **user-invoked** slash commands — a different code path
  (`allowed-tools`, `${CLAUDE_PLUGIN_ROOT}/bin/potsherd`), still ORCHESTRATOR.
- `/potsherd graft <x>` **visibly changing the next answer** in the same session — still open.
- A **marketplace** install, which the phase-5 verifier showed is non-functional today
  (`dist/` is gitignored, the npm package is unpublished). This run used `--plugin-dir` against a
  built checkout, which is a strictly easier case and is recorded as such.
