/**
 * The three tool descriptions, kept in one file because they are the product.
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
 *       Better: a model can now tell recall from read. Still silent on the only
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
 * Three rules hold for all three, and the test enforces them:
 *   - opens with a directive, not a noun phrase;
 *   - names at least one thing the tool is **not** for, or the tool to use
 *     instead — a tool with no stated boundary is reached for at random;
 *   - names its cost when the cost is not free.
 *
 * ---------------------------------------------------------------- T10.6 · F7
 *
 * Six descriptions became three. The audit's sentence is the whole reason:
 *
 * > Six tools with overlapping descriptions cost me a decision every time; two
 * > with disjoint jobs cost me none.
 *
 * `find` and `ls` searched the same table and their descriptions had to spend
 * a paragraph each fencing themselves off from the other. They are one tool
 * now, and the fence is gone with them. `ask` and `tag` are retired for the
 * reasons in `server.ts`.
 *
 * `skills/remembering-sessions/SKILL.md` carries a **commented block of three
 * candidate descriptions with exactly one uncommented**, and its header says
 * why: this one field decides whether the model reaches for the thing at all,
 * so the alternatives stay in the file where the next person can try them
 * rather than having to reinvent them. That convention is followed here, per
 * T10.6's acceptance item 7. **Exactly one candidate per tool may be
 * uncommented.** The shipped choice is a judgement, not a result: a
 * description cannot be A/B-tested against a live model from inside this
 * repository, and the lexical proxy in `tests/mcp.test.ts` is a proxy.
 */

// ============================================================ potsherd_recall
//
// === candidate A · trigger-list first ======================================
// export const RECALL_DESCRIPTION = `USE THIS whenever the user says "last
// time", "before", "we discussed", "why did we", "what did we decide", "remind
// me", "that thing we tried", or names a decision without saying when. It
// searches every Claude Code, Codex, Cursor and pi session on this machine and
// returns ranked threads with confidence, quoted snippets and dates. Do NOT
// use it to search the web or the current repository.`;
//
// === candidate B · the empty result first ==================================
// export const RECALL_DESCRIPTION = `USE THIS BEFORE answering from memory
// about earlier work — and trust its silence. It returns confidence: strong,
// weak or none, and on none it returns ZERO rows, which means the archive does
// not contain this and you may say so. Search the user's own history of coding
// sessions, including subagent transcripts and sessions the harness deleted.
// Do NOT use it to search the web or the files in front of you.`;
//
// === candidate C · imperative first · SHIPPED ==============================
export const RECALL_DESCRIPTION = `USE THIS BEFORE telling the user you do not remember, do not have access to earlier sessions, or that something was never discussed — it searches every coding-agent session already on this machine, and it is the ONLY potsherd tool you need to reach for first.

Reach for it the moment the user says "last time", "before", "we discussed", "why did we", "what did we decide", "that thing we tried", "pick up where we left off", "what was I working on", or names a decision without saying when. Also use it before re-solving a problem that sounds familiar: the answer is often already in a session from months ago.

TRUST ITS SILENCE. Every reply carries confidence — strong, weak or none — and a none comes back with ZERO rows and a "no match" note. That is a real answer: the archive does not contain this, and saying so is better than widening into a guess. Never fill an empty result from the repository in front of you.

want: "hits" (the default) returns ranked threads with snippets, dates and a ready-made citation line for each. want: "context" returns the matching exchanges themselves — seq, timestamp and text, selected from across a long session rather than its opening — when you intend to quote rather than to choose. scope narrows by project, date, tag or harness; leave it out on the first call, because the answer is usually in a DIFFERENT project than the one you are in.

Keyword and semantic search over the user's own history. No network, no model call, no cost. Do NOT use it to search the web, and do NOT use it to search the files in the current repository — it reads conversations, not code.`;

// ============================================================== potsherd_read
//
// === candidate A · after-recall first ======================================
// export const READ_DESCRIPTION = `USE THIS AFTER potsherd_recall has given
// you a thread and you need the exact words rather than a snippet. Pages
// through the whole fork/resume chain in order, 25 exchanges at a time, each
// carrying its seq and timestamp. Do NOT guess a thread id, and do NOT use
// this to read files on disk.`;
//
// === candidate B · the quote-or-invent framing =============================
// export const READ_DESCRIPTION = `USE THIS when you are about to repeat
// something the user said or decided. Quoting what was actually said is the
// difference between recalling a decision and inventing one, and this is the
// only tool that gives you the transcript's own words. It pages a thread —
// the whole fork/resume chain, not one link of it — and every exchange carries
// the seq and citation you quote it by. Do NOT read files on disk with it.`;
//
// === candidate C · imperative first · SHIPPED ==============================
export const READ_DESCRIPTION = `USE THIS AFTER potsherd_recall has given you a thread and you need the exact words rather than a snippet — quoting what was actually said is the difference between recalling a decision and inventing one.

It reads a THREAD: the whole fork/resume chain, in order, a page at a time. from and to are 1-based inclusive exchange numbers across the thread, not characters and not one session's numbering; omit them for the first page. The reply carries the thread's total, the next from, and every link the chain is made of, so keep paging instead of asking for a thousand exchanges at once.

Every exchange carries its seq, its timestamp and the session it came from. Cite it as <id8>@<seq>, and copy the ready-made line from the reply's citations[] when you list sources — a source line you composed yourself, a file path, or a dash is refused as a citation by code, not by convention.

This is the tool that means you never need filesystem access to read a transcript. Do NOT invent or guess a thread id — get one from potsherd_recall. Do NOT use this to read files on disk; it reads conversations, not code.`;

// ============================================================= potsherd_graft
//
// === candidate A · re-entry first ==========================================
// export const GRAFT_DESCRIPTION = `USE THIS when the user wants to carry work
// forward from an earlier thread into this one. It compresses the thread into
// a short cited brief under a token budget. IT WRITES TO THE USER'S PROJECT:
// ./.potsherd/graft-<id>.md. Do NOT use it as a search.`;
//
// === candidate B · budget first ============================================
// export const GRAFT_DESCRIPTION = `USE THIS when you need a month of work in
// 1,200 tokens. Give it a thread or the words to find one, and it returns a
// cited brief written to be dropped straight into your context. IT WRITES TO
// THE USER'S PROJECT. Do NOT use it to summarise the current session.`;
//
// === candidate C · imperative first · SHIPPED ==============================
export const GRAFT_DESCRIPTION = `USE THIS when the user wants to carry work forward from an earlier thread into this one — "pick up where we left off", "remind me what we did on X", "I'm restarting that project", "what was the state of this".

It compresses one past thread into a short cited brief under a token budget and returns the brief as text. Read that brief and then continue the work with it in mind: it is written to be dropped straight into your context, and it names the session and exchange every claim came from. Every source line in it has been resolved against the index in code; lines whose citations did not resolve are removed before you see them, and the reply lists what was refused.

Give it a thread from potsherd_recall, or — when you have no id yet — the user's own words, and it will find the best-matching thread itself. Set about to narrow the brief to one topic when the thread covered several. budget is the token ceiling for the brief, not for the call.

IT WRITES TO THE USER'S PROJECT. It saves the brief as ./.potsherd/graft-<id>.md, creating ./.potsherd/ and a .gitignore inside it if they are not there, so the user can reread it later — the reply tells you the exact path, or tells you nothing was written. That is the only thing it writes, and the only potsherd write outside ~/.potsherd; it changes nothing else on disk.

It works with no model backend at all — the brief is then assembled from the stored card, is labelled unsummarised, and is still cited. Do NOT use it to summarise the current session, and do NOT use it instead of potsherd_recall when you are still looking for which thread you want.`;
