import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { VERSION } from '@potsherd/core';
import type { ServerContext } from './context.js';
import { registerGraft } from './tools/graft.js';
import { registerRead } from './tools/read.js';
import { registerRecall } from './tools/recall.js';

/**
 * The three names, in one array, so that "three tools, no more" is a thing the
 * build can check rather than a thing a reviewer has to count.
 *
 * It was six until T10.6, and six was a defensible number against the named
 * anti-pattern (`03` §9: agentmemory ships 54 and a model handed 54 tools picks
 * none of them). The agent audit measured the actual cost of six and it is not
 * the count, it is the **overlap**:
 *
 * > These overlap almost totally and are ranked, in practice, worst-first. […]
 * > Six tools with overlapping descriptions cost me a decision every time; two
 * > with disjoint jobs cost me none.
 *
 * `plans/phases/phase-10-agent-audit.md` §B7 rules three rather than the
 * audit's two, and names them. What happened to the other four:
 *
 *   `potsherd_find` → **folded into `potsherd_recall`**. Same search, same
 *   `recall` call underneath, plus the calibration T10.1 is adding and the
 *   minted citation F3 needs.
 *
 *   `potsherd_ls` → **folded into `potsherd_recall`**. `ls` was *browse by
 *   period, project or label*, which is `recall` with a `scope` and a thin
 *   query — and the audit's F8 measured that the short distinctive query wins
 *   over the long one anyway. Nothing an agent could list it can no longer
 *   list; what is gone is the decision between two tools that read one table.
 *   `ls` remains a human CLI verb, untouched, where the audit says it belongs.
 *
 *   `potsherd_ask` → **retired from the agent surface, not from the product.**
 *   The audit's §4.5 tool list does not contain it and §4.4 and §4.6 say why:
 *   *"I am already a model, running on the user's subscription, with their
 *   whole context. Do not make me install 677 MB so you can call a different
 *   model that knows less than I do."* `ask` dispatched six haiku-class readers
 *   and one synthesizer to do, worse, what the main-loop model can now do
 *   itself with `potsherd_recall(want: "context")` — which hands back the same
 *   relevance-selected windows the readers were given, with the citations
 *   minted rather than proposed. `potsherd ask` is still a CLI verb and still
 *   in the human skill; it is no longer a tool a model must choose between.
 *
 *   `potsherd_tag` → **a human verb**, per the audit: *"Everything else (tag,
 *   pin, link, card, ls, stats, doctor) is a human CLI verb and should not be
 *   in my tool list at all."* This is the one retirement that removes an
 *   agent capability rather than relocating it, and it is reported as such in
 *   `phases/phase-10/T10.6-REPORT.md` — the write-back verb §B9 specifies
 *   (`note`) is the one that should occupy that slot, and it does not exist in
 *   this tree yet.
 *
 * `tests/mcp.test.ts` asserts this list, in order, so a fourth tool cannot be
 * added by anyone who has not read this paragraph.
 */
export const TOOLS = ['potsherd_recall', 'potsherd_read', 'potsherd_graft'] as const;

/**
 * The tools that write, and therefore the tools annotated
 * `readOnlyHint: false`.
 *
 * `potsherd_graft` creates `./.potsherd/graft-<id8>.md` and a
 * `./.potsherd/.gitignore` beside it in the user's project. It was annotated
 * `readOnlyHint: true` until T5.9 on the reading that it "modifies no state
 * anything else reads", which told every client that a tool creating files in
 * a repository was safe to auto-approve.
 *
 * The list is not documentation to be kept in step by hand. `--selftest`
 * watches the project directory across every `tools/call` and fails unless the
 * tools observed to write are exactly the tools named here — so a tool added
 * to this list without writing, or removed from it while still writing, is
 * caught by running the server rather than by reading it.
 */
export const WRITE_TOOLS: readonly string[] = ['potsherd_graft'];

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: 'potsherd', version: VERSION, title: 'potsherd' },
    {
      capabilities: { tools: {} },
      instructions:
        'potsherd indexes every coding-agent session on this machine — Claude Code, Codex, ' +
        'Cursor, pi — including subagent transcripts and sessions the harness has already ' +
        'deleted. Search it BEFORE telling the user you have no memory of earlier work. ' +
        'Three tools, in the order you use them: potsherd_recall to find a thread (and to be ' +
        'told, in one word, whether the archive actually holds it — a "none" comes back with ' +
        'zero rows and that is a real answer), potsherd_read to page the thread and quote it ' +
        'exactly, potsherd_graft to carry a whole thread into this conversation as a brief. ' +
        'Citations are minted by potsherd, not composed by you: copy the citation line a reply ' +
        'gives you. A source line whose id does not resolve against the index is refused in ' +
        'code. Two of the three only read. potsherd_graft creates ' +
        './.potsherd/graft-<id8>.md in the current project and says so in its readOnlyHint — ' +
        'the only potsherd write outside ~/.potsherd. Everything else potsherd does — tag, pin, link, card, ls, ' +
        'stats, doctor — is a command the user runs in their own terminal.',
    },
  );

  // Registration order is the order the tool list is advertised in, and the
  // order is the teaching order from `plans/05`: find the thread, read what you
  // found, carry it forward.
  registerRecall(server, ctx);
  registerRead(server, ctx);
  registerGraft(server, ctx);

  return server;
}
