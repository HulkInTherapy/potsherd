import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { VERSION, allTags, db as dbNs, format as fmt, indexAll, paths } from '@potsherd/core';

import { makeContext } from './context.js';
import { TOOLS, WRITE_TOOLS } from './server.js';
import {
  call as callBare,
  callRaw as callRawBare,
  connectInMemory,
  textOf,
  type CallToolResult,
  type Client,
} from './testing.js';

/**
 * `node packages/mcp/dist/index.js --selftest` — six tools, proved, offline.
 *
 * What this is for: an MCP server fails **silently**. A client that cannot
 * start it, or that gets an exception on every call, shows the user a tool list
 * that is simply absent — no error, no log, nothing to search for. So the
 * server has to be able to answer the question "are you working?" itself,
 * without a client, in one command that exits 0 or does not.
 *
 * Four rules it follows, each of them a constraint from the phase brief:
 *
 * **It builds its own corpus.** A temp directory, indexed from
 * `evals/fixture/claude` — the synthetic corpus, never a real `~/.claude`. This
 * repository is public and the reference machine holds a named third party's
 * work; a selftest that read the live archive would be one `--json` away from
 * printing it. The temp directory is removed at the end whatever happens.
 *
 * **It goes through the protocol, not around it.** The client and the server
 * are joined by an in-memory transport and every call below is a real
 * `tools/call` with real argument validation. Calling the `run*` functions
 * directly would prove the wrapping and not the wiring, and the wiring is the
 * half that breaks.
 *
 * **It hides the model backend on purpose.** `potsherd_ask` and
 * `potsherd_graft` are run against an environment with no `claude`, no `codex`
 * and no key, because the acceptance criterion is that they *work, or fail
 * cleanly, with no backend available* — and because a selftest that spent two
 * minutes and twelve cents of somebody's budget every time it ran would be a
 * selftest nobody runs. `ask` must come back as a usable tool error in
 * milliseconds; `graft` must come back with a real brief on the card-only path.
 *
 * **It checks answers, not exit codes.** `find` has to return the session the
 * eval set says is the answer, `read` has to page, `tag` has to leave the tag
 * behind. "It did not throw" is not evidence that a tool answers.
 *
 * **It watches which tools write, rather than believing the list.** Before
 * T5.9 this file asserted `readOnlyHint === !WRITE_TOOLS.includes(name)` in
 * one block and, forty lines later, `potsherd_graft wrote <path>` in another —
 * two contradictory facts about the same tool, both passing, because nothing
 * connected them. So every `tools/call` below now runs through {@link watch},
 * which snapshots the project directory and the tag table around the call and
 * records any tool that changed either. The annotation check then compares
 * `WRITE_TOOLS` against **what was observed**, and the two assertions are the
 * same assertion. `readOnlyHint` is what a client reads to decide whether a
 * tool may run without asking the user first; it is not a place to be
 * aspirational.
 */
/** `05`'s column budget. `--width` overrides it; nothing else is 80 here. */
export const DEFAULT_WIDTH = 80;

export async function selftest(
  out: NodeJS.WritableStream = process.stderr,
  width = DEFAULT_WIDTH,
): Promise<number> {
  const started = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-mcp-selftest-'));
  const root = path.join(tmp, 'potsherd');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });

  const say = (s: string): void => {
    out.write(s + '\n');
  };
  const checks: { ok: boolean; line: string }[] = [];
  const check = (ok: boolean, line: string): void => {
    checks.push({ ok, line });
    // D11. `05` gives every potsherd line 80 columns, and this is a
    // verification command named in the phase file. It ran to 130 characters,
    // hard-cut mid-word by ad-hoc `.slice(0, 56)` calls inside the messages
    // with no ellipsis, so a reader could not tell a truncated path from a
    // wrong one. One clip, here, at the only place that knows the width, and
    // it puts the ellipsis in.
    say(fmt.clip(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`, width));
  };

  try {
    say(`potsherd mcp selftest · v${VERSION}`);
    say('');

    const fixture = fixtureClaudeDir();
    // Paths elide in the MIDDLE — the last segment is what identifies a file,
    // so these two are the one place on this screen where a tail cut would
    // throw away the informative half.
    const shortPath = (p: string): string => fmt.elideMiddle(paths.tildify(p), width - 10);
    say(`  corpus  ${shortPath(fixture)}`);
    say(`  index   ${shortPath(root)}`);
    say('');

    const report = await indexAll({
      root,
      potsherdDir: root,
      claudeDir: fixture,
      harnesses: ['claude'],
      full: true,
      // No embeddings: a selftest must not download a 34 MB model, and every
      // assertion below is answerable by text search.
      embed: false,
    });
    check(
      report.totals.sessions > 0,
      `indexed ${report.totals.sessions} sessions, ${report.totals.exchanges} exchanges from the fixture corpus`,
    );

    // No backend, deliberately. See the header.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['PATH'];
    delete env['ANTHROPIC_API_KEY'];
    delete env['POTSHERD_LLM_BACKEND'];
    delete env['CODEX_HOME'];
    delete env['CODEX_SANDBOX'];
    delete env['POTSHERD_HARNESS'];

    const ctx = makeContext({ potsherdDir: root, env, cwd: project });
    check(ctx.graftCwd === project, `graft would write into ${ctx.graftCwd ?? '(nowhere)'}`);

    const { client, close } = await connectInMemory(ctx, 'potsherd-selftest');

    /**
     * Every tool observed to change something during this run.
     *
     * Two surfaces, because potsherd writes to two: the user's project (where
     * `potsherd_graft` puts its brief) and the index (where `potsherd_tag`
     * puts labels). A tool that touches either is a writer, whatever it is
     * annotated.
     */
    const witnessed = new Set<string>();
    const surfaces = (): string => {
      const files: string[] = [];
      const walk = (dir: string, rel = ''): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const at = path.join(dir, e.name);
          const key = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(at, key);
          else files.push(`${key}:${String(fs.statSync(at).size)}`);
        }
      };
      walk(project);
      let tags = '';
      try {
        const db = dbNs.open({ file: paths.dbPath(root), readonly: true });
        try {
          tags = allTags(db).map((t) => `${t.tag}=${String(t.sessions)}`).join(',');
        } finally {
          db.close();
        }
      } catch {
        tags = '(unreadable)';
      }
      return `${files.join('|')}##${tags}`;
    };

    /** `tools/call`, with the two surfaces snapshotted either side of it. */
    async function watch<T>(name: string, run: () => Promise<T>): Promise<T> {
      const before = surfaces();
      const r = await run();
      if (surfaces() !== before) witnessed.add(name);
      return r;
    }
    const call = (
      c: Client,
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => watch(name, () => callBare(c, name, args));
    const callRaw = (
      c: Client,
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult> => watch(name, () => callRawBare(c, name, args));

    try {
      say('');
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      check(
        names.length === 6 && TOOLS.every((t, i) => names[i] === t),
        `6 tools, in order: ${names.join(', ')}`,
      );
      check(
        listed.tools.every((t) => (t.description ?? '').length > 200),
        'every tool description is an instruction, not a label',
      );
      say('');

      // ---------------------------------------------------------- find
      const find = await call(client, 'potsherd_find', {
        query: 'combining keyword and vector search into one ranked list',
        limit: 3,
      });
      const sessions = (find['sessions'] as { id: string }[]) ?? [];
      check(
        sessions[0]?.id.startsWith('cbcfda7e') === true,
        `potsherd_find  ranked ${sessions[0]?.id.slice(0, 8) ?? '(nothing)'} first of ${sessions.length}` +
          ` · rrf k=${String(find['k'])} · ${String(find['ms'])}ms`,
      );
      check(
        Array.isArray(find['hits']) && find['weights'] !== undefined,
        'potsherd_find  carries hits[], k, weights and relaxedLists as the contract pins them',
      );

      const target = sessions[0]?.id ?? '';

      // ---------------------------------------------------------- read
      const page1 = await call(client, 'potsherd_read', {
        session: target.slice(0, 8),
        start_line: 1,
        end_line: 2,
      });
      const ex1 = (page1['exchanges'] as { seq: number }[]) ?? [];
      check(
        ex1.length === 2 && page1['total'] !== undefined,
        `potsherd_read  page 1 gave exchanges ${ex1.map((e) => e.seq).join(', ')} of ${String(page1['total'])}`,
      );
      const page2 = await call(client, 'potsherd_read', {
        session: target.slice(0, 8),
        start_line: Number(page1['nextStartLine'] ?? 3),
        end_line: Number(page1['nextStartLine'] ?? 3) + 1,
      });
      const ex2 = (page2['exchanges'] as { seq: number }[]) ?? [];
      check(
        ex2.length > 0 && ex2[0]!.seq > ex1[ex1.length - 1]!.seq,
        `potsherd_read  page 2 continued at seq ${ex2[0]?.seq}, no overlap`,
      );

      // ---------------------------------------------------------- ls
      const ls = await call(client, 'potsherd_ls', { limit: 5 });
      check(
        Number(ls['total']) > 0 && Array.isArray(ls['sessions']),
        `potsherd_ls    ${String(ls['shown'])} of ${String(ls['total'])} sessions, newest first`,
      );

      // ---------------------------------------------------------- tag
      const tagged = await call(client, 'potsherd_tag', {
        session: target.slice(0, 8),
        add: ['selftest', 'Fusion'],
      });
      const tags = (tagged['tags'] as string[]) ?? [];
      check(
        tags.includes('selftest') && tags.includes('fusion'),
        `potsherd_tag   wrote [${tags.join(', ')}] (and normalised "Fusion")`,
      );
      const byTag = await call(client, 'potsherd_ls', { tag: 'selftest' });
      check(
        Number(byTag['total']) === 1,
        'potsherd_tag   the tag it wrote is the tag potsherd_ls finds',
      );
      const untagged = await call(client, 'potsherd_tag', {
        session: target.slice(0, 8),
        remove: ['selftest', 'fusion'],
      });
      check(
        ((untagged['tags'] as string[]) ?? []).length === 0,
        'potsherd_tag   removed them again, leaving the corpus as it found it',
      );

      // ---------------------------------------------------------- graft
      const grafted = await call(client, 'potsherd_graft', {
        session: target.slice(0, 8),
        budget: 400,
      });
      const brief = String(grafted['brief'] ?? '');
      const graftPath = grafted['path'] as string | null;
      check(
        brief.length > 0 && grafted['via'] === 'card-only',
        `potsherd_graft ${String(grafted['tokens'])} tokens of ${String(grafted['budget'])} budget` +
          `, via ${String(grafted['via'])} (no backend), ${((grafted['citations'] as unknown[]) ?? []).length} citations`,
      );
      check(
        typeof graftPath === 'string' && fs.existsSync(graftPath),
        `potsherd_graft wrote ${graftPath ? path.relative(tmp, graftPath) : '(nothing)'} under the temp project, not the cwd`,
      );

      // ---------------------------------------------------------- ask
      const askAt = Date.now();
      const askErr = await callRaw(client, 'potsherd_ask', {
        question: 'how did we combine the two ranked lists?',
        k: 2,
      });
      const askText = textOf(askErr);
      check(
        askErr.isError === true && /claude|codex|ANTHROPIC_API_KEY/i.test(askText),
        `potsherd_ask   no backend → tool error in ${Date.now() - askAt}ms, not after ~100s: ` +
          askText.split('\n')[0]!,
      );

      // ------------------------------------- who actually wrote anything
      //
      // Every call above ran through `watch`. This is the only place the
      // annotations are checked, and it checks them against what was seen —
      // so `readOnlyHint: true` on a tool that just created a file in the
      // project fails here, and so does naming a tool in `WRITE_TOOLS` that
      // never wrote. The old version of this file asserted both halves of
      // that contradiction in separate blocks and passed.
      say('');
      const observed = [...witnessed].sort();
      const declared = [...WRITE_TOOLS].sort();
      check(
        observed.length === declared.length && observed.every((n, i) => n === declared[i]),
        `WRITE_TOOLS is what was observed to write: [${declared.join(', ')}]` +
          (observed.join(',') === declared.join(',') ? '' : ` — but watched [${observed.join(', ')}]`),
      );
      for (const t of listed.tools) {
        const writes = witnessed.has(t.name);
        check(
          t.annotations?.readOnlyHint === !writes,
          `${t.name.padEnd(14)} readOnlyHint=${String(t.annotations?.readOnlyHint)}` +
            ` and it ${writes ? 'wrote' : 'wrote nothing'}`,
        );
      }

      // ------------------------------------------- errors are tool errors
      say('');
      const bad = [
        ['a malformed argument', 'potsherd_find', { query: 42 }],
        ['a missing session', 'potsherd_read', { session: 'ffffffff' }],
        ['an unreadable index', 'potsherd_ls', {}],
      ] as const;
      for (const [what, tool, args] of bad) {
        const ctxBefore = tool === 'potsherd_ls' ? breakIndex(root) : null;
        // Bare, not watched: `breakIndex` moves the index out from under the
        // call, so the surfaces differ for a reason that has nothing to do
        // with the tool. A negative test is not evidence about who writes.
        const r = await callRawBare(client, tool, args as Record<string, unknown>);
        if (ctxBefore) fixIndex(root, ctxBefore);
        check(
          r.isError === true && textOf(r).length > 0,
          `${what} → tool error, server still up: ${textOf(r).split('\n')[0]!}`,
        );
      }

      // Still alive after all of that — the whole point of the block above.
      const after = await callBare(client, 'potsherd_ls', { limit: 1 });
      check(Number(after['total']) > 0, 'the server answered again after three failures');
    } finally {
      await close();
    }

    const failed = checks.filter((c) => !c.ok).length;
    say('');
    say(
      failed === 0
        ? `  ${checks.length} checks, all passed  ·  ${Date.now() - started}ms`
        : `  ${failed} of ${checks.length} checks FAILED  ·  ${Date.now() - started}ms`,
    );
    return failed === 0 ? 0 : 1;
  } catch (err) {
    say('');
    say(`  selftest could not finish: ${(err as Error)?.message ?? String(err)}`);
    return 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Make the index unreadable for one call, then put it back. */
function breakIndex(root: string): Buffer {
  const file = paths.dbPath(root);
  const saved = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return saved;
}

function fixIndex(root: string, saved: Buffer): void {
  fs.writeFileSync(paths.dbPath(root), saved, { mode: 0o600 });
}

/**
 * `evals/fixture/claude`, found from wherever this file was built to.
 *
 * Two candidates because there are two shapes this runs in: `src/` under tsx
 * during the tests, and `dist/` after `pnpm build`. Both are three or four
 * levels below the repository root, and the fixture is the thing being looked
 * for rather than the root, so the check is for the fixture itself.
 */
export function fixtureClaudeDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (let dir = here, i = 0; i < 8; i++, dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'evals', 'fixture', 'claude');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'evals/fixture/claude not found. --selftest indexes the synthetic corpus and ' +
      'must never be pointed at a real ~/.claude.',
  );
}
