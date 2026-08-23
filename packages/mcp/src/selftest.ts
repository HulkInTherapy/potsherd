import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { VERSION, allTags, db as dbNs, format as fmt, indexAll, paths } from '@potsherd/core';

import { makeContext } from './context.js';
import { TOOLS, WRITE_TOOLS } from './server.js';
import { verifySources } from './tools/sources.js';
import {
  call as callBare,
  callRaw as callRawBare,
  connectInMemory,
  textOf,
  type CallToolResult,
  type Client,
} from './testing.js';

/**
 * `node packages/mcp/dist/index.js --selftest` — three tools, proved, offline.
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
 * **It hides the model backend on purpose.** `potsherd_graft` is run against
 * an environment with no `claude`, no `codex` and no key, because the
 * acceptance criterion is that it *works, or fails cleanly, with no backend
 * available* — and because a selftest that spent two minutes and twelve cents
 * of somebody's budget every time it ran would be a selftest nobody runs.
 * `graft` must come back with a real brief on the card-only path.
 *
 * **It checks answers, not exit codes.** `recall` has to return the session the
 * eval set says is the answer, `read` has to page a thread, `graft` has to
 * produce a cited brief. "It did not throw" is not evidence that a tool
 * answers.
 *
 * **It proves the citation refusal (T10.6 · F3).** The audit's failing case —
 * a `SOURCES` line whose id8 is a repository filename, and one whose id8 is a
 * dash — is run through `verifySources` against the live index, because a
 * refusal that only holds in a unit test is a refusal a shipped server does
 * not have.
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
     * Two surfaces, because potsherd used to write to two: the user's project
     * (where `potsherd_graft` puts its brief) and the index (where the retired
     * `potsherd_tag` put labels). Both are still watched — a tool that starts
     * writing labels again is a tool this has to catch, not a tool nobody is
     * looking at.
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
        names.length === TOOLS.length && TOOLS.every((t, i) => names[i] === t),
        `${String(TOOLS.length)} tools, in order: ${names.join(', ')}`,
      );
      check(
        listed.tools.every((t) => (t.description ?? '').length > 200),
        'every tool description is an instruction, not a label',
      );
      say('');

      // -------------------------------------------------------- recall
      const found = await call(client, 'potsherd_recall', {
        query: 'combining keyword and vector search into one ranked list',
        scope: { limit: 3 },
      });
      const threads = (found['threads'] as { thread: string; citation: string }[]) ?? [];
      check(
        threads[0]?.thread.startsWith('cbcfda7e') === true,
        `potsherd_recall ranked ${threads[0]?.thread.slice(0, 8) ?? '(nothing)'} first of ${threads.length}` +
          ` · rrf k=${String(found['k'])} · ${String(found['ms'])}ms`,
      );
      check(
        typeof found['confidence'] !== 'undefined' && typeof found['noMatch'] === 'boolean',
        `potsherd_recall carries the cliff: confidence=${String(found['confidence'])}` +
          ` calibrated=${String(found['calibrated'])} noMatch=${String(found['noMatch'])}`,
      );
      check(
        typeof threads[0]?.citation === 'string' && threads[0].citation.includes(' \u00b7 '),
        `potsherd_recall minted a citation rather than leaving one to be composed: ` +
          `${threads[0]?.citation ?? '(none)'}`,
      );
      check(
        typeof found['capability'] === 'string' && String(found['capability']).length > 0,
        `potsherd_recall says what it could do: ${String(found['capability'])}`,
      );

      // ------------------------------------------- recall · want: context
      const context = await call(client, 'potsherd_recall', {
        query: 'combining keyword and vector search into one ranked list',
        want: 'context',
        budget: 1_500,
      });
      const windows = (context['windows'] as { seq: number | null; ts: string | null; text: string }[]) ?? [];
      check(
        windows.length > 0 && windows.every((w) => typeof w.text === 'string' && w.text.length > 0),
        `potsherd_recall want:context returned ${windows.length} windows, ` +
          `${String(context['windowTokens'])} est. tokens of ${String(context['windowBudget'])}`,
      );

      const target = threads[0]?.thread ?? '';

      // ---------------------------------------------------------- read
      const page1 = await call(client, 'potsherd_read', {
        thread: target.slice(0, 8),
        from: 1,
        to: 2,
      });
      const ex1 = (page1['exchanges'] as { seq: number; ts: string | null; position: number }[]) ?? [];
      check(
        ex1.length === 2 && page1['total'] !== undefined && ex1.every((e) => typeof e.seq === 'number'),
        `potsherd_read  page 1 gave exchanges ${ex1.map((e) => e.seq).join(', ')} of ${String(page1['total'])}` +
          ` · thread via ${String((page1['thread'] as { via: string }).via)}`,
      );
      const page2 = await call(client, 'potsherd_read', {
        thread: target.slice(0, 8),
        from: Number(page1['nextFrom'] ?? 3),
        to: Number(page1['nextFrom'] ?? 3) + 1,
      });
      const ex2 = (page2['exchanges'] as { seq: number }[]) ?? [];
      check(
        ex2.length > 0 && ex2[0]!.seq > ex1[ex1.length - 1]!.seq,
        `potsherd_read  page 2 continued at seq ${ex2[0]?.seq}, no overlap`,
      );
      const cites = (page1['citations'] as { citation: string }[]) ?? [];
      check(
        cites.length > 0 && ex1.every((e) => typeof e.position === 'number'),
        `potsherd_read  every row carries seq + ts + a minted citation: ${cites[0]?.citation ?? '(none)'}`,
      );

      // ---------------------------------------------------------- graft
      const grafted = await call(client, 'potsherd_graft', {
        thread: target.slice(0, 8),
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
      check(
        grafted['sourcesChecked'] === true &&
          ((grafted['refusedSources'] as unknown[]) ?? []).length === 0 &&
          brief.includes('source:'),
        `potsherd_graft ran the source check in code: ` +
          `${((grafted['refusedSources'] as unknown[]) ?? []).length} refused, ` +
          `${String((grafted['brief'] as string).split('\n').length)} brief lines kept`,
      );

      // ------------------------------------ F3 · the refusal, on this index
      //
      // The audit's own failing case, rebuilt: two rows wearing the citation
      // format whose id8 fields are a repository filename and a dash. Neither
      // resolves; both are refused, and the quote hanging under each goes with
      // it. The real row beside them survives, which is the half that proves
      // the check is a check and not a switch.
      say('');
      {
        const db = dbNs.open({ file: paths.dbPath(root), readonly: true });
        try {
          const block = [
            'SOURCES',
            `${target.slice(0, 8)} \u00b7 fixture \u00b7 claude \u00b7 12 exchanges \u00b7 2026-01-01`,
            '  "a quote that is carried by a citation that resolves"',
            'HANDOFF.md \u00a73 \u00b7 potsherd \u00b7 claude \u00b7 \u2014 exchanges \u00b7 \u2014',
            '  "a claim the repository could support and the archive cannot"',
            '\u2014 \u00b7 potsherd \u00b7 claude \u00b7 \u2014 exchanges \u00b7 2026-06-03',
            '  "the project started on 3 June"',
          ].join('\n');
          const verdict = verifySources(db, block);
          check(
            verdict.refused.length === 2 && verdict.kept.length === 1,
            `verifySources  refused ${verdict.refused.length} fabricated source lines, kept ${verdict.kept.length} real one`,
          );
          check(
            !verdict.text.includes('HANDOFF.md') && !verdict.text.includes('3 June'),
            'verifySources  the refused rows and the quotes under them are gone from the text',
          );
        } finally {
          db.close();
        }
      }

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
        ['a malformed argument', 'potsherd_recall', { query: 42 }],
        ['a missing thread', 'potsherd_read', { thread: 'ffffffff' }],
        ['an unreadable index', 'potsherd_recall', { query: 'anything at all' }],
      ] as const;
      for (const [what, tool, args] of bad) {
        const ctxBefore = what === 'an unreadable index' ? breakIndex(root) : null;
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
      const after = await callBare(client, 'potsherd_recall', { query: 'ranked list', scope: { limit: 1 } });
      check(
        Array.isArray(after['threads']),
        'the server answered again after three failures',
      );
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
