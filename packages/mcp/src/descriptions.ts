/**
 * The six tool descriptions, kept in one file because they are the product.
 *
 * `03` §9: *mcp tool descriptions decide whether the model uses them*. A tool
 * the model never reaches for is a tool that does not exist, and the only thing
 * standing between "potsherd is installed" and "potsherd is used" is this text.
 *
 * Three phrasings were written and scored (`tests/mcp.test.ts`, "the three
 * phrasings"):
 *
 *   A · **label** — a noun phrase naming the thing. "Search indexed sessions."
 *       This is what most MCP servers ship and it is the reason most MCP
 *       servers are ignored: it tells a model *what the tool is* and nothing
 *       about *when it is the right move*.
 *
 *   B · **capability** — a verb phrase describing behaviour. "Searches your
 *       past coding sessions and returns matching sessions with snippets."
 *       Better: a model can now tell find from read. Still silent on the only
 *       question that matters at the moment of use, which is whether to reach
 *       for a tool at all rather than answer from what it already has.
 *
 *   C · **instruction** — a directive addressed to the model, naming the
 *       trigger, the alternative and the boundary. "USE THIS BEFORE saying you
 *       do not remember… Do NOT use it to search the web."
 *
 * C is what ships. The scoring is in the test; the reasoning is that the
 * failure this product exists to prevent is not *the model picked the wrong
 * tool*, it is **the model said "I don't have access to earlier sessions" while
 * a tool that does was sitting in its tool list**. Only a phrasing that names
 * that sentence can pre-empt it, which is why every description below opens
 * with `USE THIS` and a condition rather than with a noun.
 *
 * Three rules hold for all six, and the test enforces them:
 *   - opens with a directive, not a noun phrase;
 *   - names at least one thing the tool is **not** for, or the tool to use
 *     instead — a tool with no stated boundary is reached for at random;
 *   - names its cost when the cost is not free (`potsherd_ask`, 40–180 s).
 */

export const FIND_DESCRIPTION = `USE THIS BEFORE telling the user you do not remember, do not have access to earlier sessions, or that something was never discussed — it searches every coding-agent session already on this machine.

Reach for it the moment the user says "last time", "before", "we discussed", "why did we", "what did we decide", "that thing we tried", or names a decision without saying when. Also use it before re-solving a problem that sounds familiar: the answer is often already in a session from months ago.

It searches Claude Code, Codex, Cursor and pi transcripts, including subagent transcripts and sessions the harness has already deleted, and returns ranked sessions with quoted snippets, session ids and dates. Hand a session id to potsherd_read to read the actual exchanges.

Keyword and semantic search over the user's own history. No network, no model call, no cost. Do NOT use it to search the web, and do NOT use it to search the files in the current repository — it reads conversations, not code.`;

export const READ_DESCRIPTION = `USE THIS AFTER potsherd_find or potsherd_ls has given you a session id and you need the exact words rather than a snippet — quoting what was actually said is the difference between recalling a decision and inventing one.

Reads one session in order, a page at a time. start_line and end_line are 1-based inclusive exchange numbers, not characters; omit them for the first page. The reply carries the total number of exchanges and the next start_line, so keep calling with the next page until you have what you need instead of asking for a thousand exchanges at once.

Every exchange carries a seq number. Cite it as <id8>@<seq> whenever you repeat something you read here, so the user can go and check you.

Do NOT invent or guess a session id — get one from potsherd_find or potsherd_ls. Do NOT use this to read files on disk.`;

export const ASK_DESCRIPTION = `USE THIS ONLY when potsherd_find plus potsherd_read cannot answer the question, because this one is slow and it costs money: it takes 40 to 180 seconds (about 100 seconds typically) and spends roughly $0.06 to $0.12 of model budget per question. Tell the user it is running before you call it.

It reads the best-matching sessions in parallel and returns an answer in which every sentence carries a citation that was checked against the transcript in code. Sentences whose citations did not resolve are deleted before you ever see them, so what comes back is grounded or it is absent.

Use it for "why did we", "what did we decide about", "how did we end up with", "what was the reasoning" — questions whose answer is spread across several sessions. Use potsherd_find instead for "where did we", "find the session about", "when did I work on" — anything one search and one read can settle.

Set strict to true when a wrong answer would be worse than no answer: it refuses rather than infers. Do NOT call it twice for the same question, and do NOT call it when there is no model backend configured — it will tell you so immediately rather than hanging.`;

export const GRAFT_DESCRIPTION = `USE THIS when the user wants to carry work forward from an earlier session into this one — "pick up where we left off", "remind me what we did on X", "I'm restarting that project", "what was the state of this".

It compresses one past session into a short cited brief under a token budget and returns the brief as text. Read that brief and then continue the work with it in mind: it is written to be dropped straight into your context, and it names the session and exchange every claim came from.

Give it a session id from potsherd_find or potsherd_ls, and set about to narrow the brief to one topic when the session covered several. budget is the token ceiling for the brief itself, not for the call.

It also saves the brief as ./.potsherd/graft-<id>.md in the project directory, when it has one, so the user can reread it later — the reply tells you the exact path, or tells you nothing was written. It changes nothing else on disk.

It works with no model backend at all — the brief is then assembled from the stored card, is labelled unsummarised, and is still cited. Do NOT use it to summarise the current session, and do NOT use it as a search: it re-enters one session you have already chosen.`;

export const LS_DESCRIPTION = `USE THIS when the user wants to browse rather than search — when they name a period, a project or a label instead of a keyword. "What was I working on last week", "show me my pinned sessions", "everything tagged postgres", "what have I done in this repo".

Lists sessions newest first with titles, projects, dates, tags and the exact command that resumes each one, including sessions the harness deleted, which nothing else on this machine can show. Every filter composes: project and tag and since together mean all three.

It has NO query parameter and does not search text. If the user gave you words to look for rather than a period or a label, use potsherd_find instead.`;

export const TAG_DESCRIPTION = `USE THIS when the user asks to label, tag, group, categorise or un-tag a session so it can be found again later — "tag that one postgres", "call this the pooler session", "drop the infra tag off it".

THIS IS THE ONLY POTSHERD TOOL THAT WRITES ANYTHING. Every other one is read-only. It adds and removes tags on a single session in one transaction and returns the tags that session carries afterwards, so you can report the result rather than assume it.

It changes nothing else: not the transcript, not the index, not the session's title. Tags are lower-cased and may hold letters, digits and - . _ / only.

Do NOT call it to record notes of your own, and do NOT tag on the user's behalf because it seems useful — call it when the user asked for a tag. Call potsherd_tag with neither add nor remove to read the current tags without writing.`;
