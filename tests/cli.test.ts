import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { format } from '@potsherd/core';
import { copyFixtureClaude, FIXTURE_CLAUDE, rmrf, tempDir } from './helpers.js';

const bytes = format.bytes;

/**
 * Exercises the shipped binary rather than the library: these are the exact
 * argument strings the readme, the hooks and the plugin use, so a change that
 * only breaks the CLI wiring must fail here.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');
const created: string[] = [];

beforeAll(() => {
  // The bundle is what `npx potsherd` runs; build it if it is stale or missing.
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
});

afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

afterAll(() => {
  while (created.length) rmrf(created.pop()!);
});

interface RunResult { code: number; stdout: string; stderr: string }

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    // process.execPath, not 'node': the card tests run with a PATH that has
    // nothing on it, which is the whole point of them.
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      // POTSHERD_DIR and CLAUDE_CONFIG_DIR come from tests/setup.ts and point
      // at a throwaway sandbox, so a missing --potsherd-dir can never reach the
      // machine's real archive.
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function scratchRoot(): string {
  const root = tempDir('potsherd-cli-');
  created.push(root);
  return root;
}

describe('potsherd cli', () => {
  it('with no arguments prints a tour that names the first verb', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('potsherd audit');
    expect(r.stdout).toContain('start here');
  });

  it('audit works read-only against a fixture directory', () => {
    const r = run(['audit', '--claude-dir', FIXTURE_CLAUDE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sessions ever started');
    expect(r.stdout).toContain('potsherd rescue');
  });

  it('accepts --json after the verb, which is what people type', () => {
    const r = run(['audit', '--json', '--claude-dir', FIXTURE_CLAUDE]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as Record<string, number>;
    expect(j['deleted']).toBe(3);
    expect(j['promptsLost']).toBe(6);
  });

  it('accepts --json before the verb too', () => {
    const r = run(['--json', 'audit', '--claude-dir', FIXTURE_CLAUDE]);
    expect(JSON.parse(r.stdout)['deleted']).toBe(3);
  });

  it('audit never creates the potsherd directory', () => {
    const root = path.join(scratchRoot(), 'nested');
    run(['audit', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('rescue --dry-run writes nothing and says so', () => {
    const root = scratchRoot();
    const r = run(['rescue', '--dry-run', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing was written');
    expect(fs.existsSync(path.join(root, 'potsherd.db'))).toBe(false);
  });

  it('rescue --yes --no-settings --quiet is silent and leaves settings alone', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();
    const before = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');

    const r = run(['rescue', '--yes', '--no-settings', '--quiet', '--claude-dir', claude, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, 'potsherd.db'))).toBe(true);
  });

  it('the hook command finishes fast on the second, unchanged run', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();
    const args = ['rescue', '--yes', '--no-settings', '--quiet', '--claude-dir', claude, '--potsherd-dir', root];
    run(args);

    // Best of three, not one. The budget is a claim about what the hook COSTS
    // — it must not block a Claude Code startup — and a single sample on a
    // loaded CI box measures the load, not the cost. The real figure on an
    // idle machine is ~0.11 s; the ceiling here is one second including node's
    // own startup.
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const r = run(args);
      best = Math.min(best, Date.now() - t0);
      expect(r.code).toBe(0);
    }
    expect(best).toBeLessThan(1000);
  });

  it('rescue --yes sets cleanupPeriodDays and keeps a backup', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();

    const r = run(['rescue', '--yes', '--claude-dir', claude, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    const after = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(after['cleanupPeriodDays']).toBe(3650);
    expect(after['permissions']).toBeDefined();
    const backups = fs.readdirSync(claude).filter((f) => f.includes('potsherd-bak'));
    expect(backups).toHaveLength(1);
  });

  it('refuses to change settings with no terminal and no --yes, and says how to fix it', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();
    const r = run(['rescue', '--claude-dir', claude, '--potsherd-dir', root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('try:');
    expect(r.stderr).toContain('--yes');
    // The archive still happened; only the settings prompt failed.
    expect(fs.existsSync(path.join(root, 'potsherd.db'))).toBe(true);
  });

  it('guard --status reports honestly and changes nothing', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const before = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');
    const r = run(['guard', '--status', '--claude-dir', claude]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('not installed');
    expect(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')).toBe(before);
  });

  it('guard installs and removes its hook', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));

    expect(run(['guard', '--yes', '--claude-dir', claude]).code).toBe(0);
    expect(run(['guard', '--status', '--json', '--claude-dir', claude]).stdout).toContain('"installed": true');

    expect(run(['guard', '--remove', '--yes', '--claude-dir', claude]).code).toBe(0);
    expect(run(['guard', '--status', '--json', '--claude-dir', claude]).stdout).toContain('"installed": false');
  });

  it('guard --status says whether the installed hook can actually run', () => {
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));

    run(['guard', '--yes', '--claude-dir', claude]);
    const ok = JSON.parse(run(['guard', '--status', '--json', '--claude-dir', claude]).stdout) as {
      installed: boolean; runnable: boolean; command: string;
    };
    expect(ok.installed).toBe(true);
    expect(ok.runnable).toBe(true);

    // Break it the way a moved checkout or a global uninstall would.
    const settings = path.join(claude, 'settings.json');
    const j = JSON.parse(fs.readFileSync(settings, 'utf8')) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    for (const entry of j.hooks.SessionStart) {
      for (const h of entry.hooks) {
        if (h.command.includes('rescue')) {
          h.command = 'node "/nowhere/potsherd.js" rescue --yes --quiet --no-settings';
        }
      }
    }
    fs.writeFileSync(settings, JSON.stringify(j, null, 2));

    const broken = run(['guard', '--status', '--claude-dir', claude]);
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain('broken');
    expect(broken.stdout).toContain('potsherd guard --remove');
  });

  it('doctor reports zero fatal parse errors on the fixture', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--json', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { fatalErrors: number; recordTypes: Record<string, number> };
    expect(j.fatalErrors).toBe(0);
    expect(Object.keys(j.recordTypes).length).toBeGreaterThan(5);
  });

  it('doctor sizes the archive by the archive, not by the live corpus', () => {
    // `files archived 2 · 88 B of source` printed right after rescue reported
    // 277 B copied: the count was of archived files, the size of ~/.claude.
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const root = scratchRoot();

    const dry = run(['doctor', '--claude-dir', claude, '--potsherd-dir', root, '--width', '100']);
    expect(dry.stdout).toContain('nothing archived yet');

    const rescued = run(['rescue', '--yes', '--no-settings', '--json', '--claude-dir', claude, '--potsherd-dir', root]);
    const bytesArchived = (JSON.parse(rescued.stdout) as { bytesArchived: number }).bytesArchived;

    const doc = run(['doctor', '--json', '--claude-dir', claude, '--potsherd-dir', root]);
    const j = JSON.parse(doc.stdout) as { corpus: { bytes: number } };
    // The two figures really are different; the row must use the archive's.
    expect(bytesArchived).not.toBe(j.corpus.bytes);

    const human = run(['doctor', '--claude-dir', claude, '--potsherd-dir', root, '--width', '100']);
    const row = human.stdout.split('\n').find((l) => l.includes('files archived'))!;
    expect(row).toContain(bytes(bytesArchived));
    expect(row).not.toContain(bytes(j.corpus.bytes));
  });

  it('audit --verify prints runnable python, writes nothing and exits 0', () => {
    const root = path.join(scratchRoot(), 'nested');
    const r = run(['audit', '--verify', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("python3 - <<'PY'");
    expect(r.stdout).toContain('sessions ever started');
    expect(r.stdout).toContain('scripts/verify-audit.py');
    // --verify is still `audit`: it must not create ~/.potsherd either.
    expect(fs.existsSync(root)).toBe(false);

    const j = JSON.parse(
      run(['audit', '--verify', '--json', '--claude-dir', FIXTURE_CLAUDE]).stdout,
    ) as { snippet: string; scriptPath: string };
    expect(j.scriptPath).toBe('scripts/verify-audit.py');
    expect(j.snippet).toContain('history.jsonl');
  });

  it('the audit card keeps its closing command whole at 60 columns', () => {
    const r = run(['audit', '--claude-dir', FIXTURE_CLAUDE, '--width', '60']);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    const last = lines[lines.length - 1]!;
    expect(last.endsWith('…')).toBe(false);
    expect(last).toMatch(/run {2}potsherd (audit|rescue|guard)(?: --[a-z-]+)?(?: {2}\S|$)/);
  });

  it('does not write "all 1" or "1 prompts" anywhere', () => {
    // One deleted session, one stored prompt: every count is pluralised.
    const claude = copyFixtureClaude();
    created.push(path.dirname(claude));
    const projects = path.join(claude, 'projects');
    // Give the two gamma ghosts their transcripts back, so exactly one session
    // is deleted and that session typed exactly one prompt.
    for (const [slug, id] of [
      ['-tmp-potsherd-gamma', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['-tmp-potsherd-gamma', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ] as const) {
      fs.mkdirSync(path.join(projects, slug), { recursive: true });
      fs.writeFileSync(
        path.join(projects, slug, `${id}.jsonl`),
        JSON.stringify({ type: 'user', sessionId: id, timestamp: '2026-08-01T00:00:00.000Z' }) + '\n',
      );
    }
    const card = run(['audit', '--claude-dir', claude, '--width', '100']).stdout;
    expect(card).toContain('deleted by 30-day sweep');
    expect(card).not.toContain('all 1 are');
    expect(card).toMatch(/that one session/);

    const root = scratchRoot();
    run(['rescue', '--yes', '--no-settings', '--quiet', '--claude-dir', claude, '--potsherd-dir', root]);
    const doc = run(['doctor', '--claude-dir', claude, '--potsherd-dir', root, '--width', '100']).stdout;
    const ghosts = doc.split('\n').find((l) => l.includes('ghosts stored'))!;
    expect(ghosts).toMatch(/1 {2,}1 prompt$/);
    expect(ghosts).not.toContain('1 prompts');
  });

  it('doctor --privacy names every path read and written', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--privacy', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.stdout).toContain('reads');
    expect(r.stdout).toContain('writes');
  });

  /**
   * The privacy receipt has to disclose the largest privacy-relevant thing the
   * product does, and from phase 2 on that is model calls.
   *
   * It said "no network, except the one-off embedding-model download" for the
   * whole of a phase that sends redacted transcript text to Claude on every
   * `card` (verification D2). That is the worst class of bug this project can
   * ship — not a wrong number, a wrong promise — so the four things a reader
   * needs are asserted one by one: what leaves, that redaction runs first,
   * which verbs send it, and which verbs never do.
   */
  it('doctor --privacy discloses the model calls, not just the paths', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--privacy', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root, '--width', '100']);
    const out = r.stdout;

    // what leaves the machine, and that it is redacted first
    expect(out).toContain('leaves this machine');
    expect(out).toMatch(/redacted slices of your transcripts/);
    expect(out).toMatch(/redaction runs first/);
    expect(out).toContain('no --no-redact');

    // when, and to whom
    expect(out).toMatch(/only these verbs call a model/);
    expect(out).toMatch(/potsherd card/);
    expect(out).toMatch(/who receives them/);
    expect(out).toMatch(/subscription|ANTHROPIC_API_KEY|no model backend/);

    // and the verbs that never do — the question the receipt is read to answer
    expect(out).toMatch(/never do, and open no socket/);
    for (const verb of ['audit', 'rescue', 'index', 'find']) {
      expect(out.slice(out.indexOf('never do'))).toContain(verb);
    }

    // the sentence that used to be false must not have survived anywhere
    expect(out).not.toMatch(/^\s*no network[,.]/m);
  });

  /**
   * D6. Every consented write copies the file it is about to change to
   * `<file>.potsherd-bak-<UTC>` first — seven `setup` configs plus
   * `settings.json`, eight files potsherd creates in other tools' directories.
   * The receipt named the eight configs, said "every other server in those
   * files is preserved", and never mentioned the eight copies. `03` §11 says
   * it lists every path written.
   */
  it('doctor --privacy discloses the backup it leaves beside every config', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--privacy', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root, '--width', '100']);
    // The suffix as `backupPath()` actually spells it, so a rename breaks this.
    expect(r.stdout).toContain('.potsherd-bak-');
    // …and it is disclosed under consent, with the other consented writes.
    const consentBlock = r.stdout.slice(r.stdout.indexOf('explicit y at a diff'));
    expect(consentBlock).toContain('.potsherd-bak-');
    expect(consentBlock).toMatch(/beside each of those \d+/);
  });

  it('doctor --privacy --json lists the backups among the consented writes', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--privacy', '--json', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    const j = JSON.parse(r.stdout) as { writesWithConsent: string[] };
    const configs = j.writesWithConsent.filter((p) => !p.includes('.potsherd-bak-'));
    const backups = j.writesWithConsent.filter((p) => p.includes('.potsherd-bak-'));
    // One backup per consented file, and each names the file it sits beside.
    expect(backups).toHaveLength(configs.length);
    for (const c of configs) expect(backups).toContain(`${c}.potsherd-bak-<UTC>`);
  });

  it('doctor --privacy --json carries the same disclosure', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--privacy', '--json', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    const j = JSON.parse(r.stdout) as { network?: { to?: string; detail?: string[] } };
    expect(j.network).toBeTruthy();
    expect(typeof j.network!.to).toBe('string');
    expect(j.network!.to!.length).toBeGreaterThan(0);
  });

  it('every verb has --help with at least one example', () => {
    for (const verb of ['audit', 'rescue', 'guard', 'index', 'doctor']) {
      const r = run([verb, '--help']);
      expect(r.code, verb).toBe(0);
      expect(r.stdout, verb).toContain('example:');
      expect(r.stdout, verb).toContain(`potsherd ${verb}`);
      expect(r.stdout, verb).toContain('--json');
    }
  });

  /**
   * T6.6 D0(a) — `--suggest` shipped declared on the wrong command. The 45
   * library tests for `suggestLinks` all passed while the flag was unreachable,
   * so the only test that can catch this is one that runs the built binary.
   */
  it('link --suggest is reachable from the command line', () => {
    const root = scratchRoot();
    run(['index', '--harness', 'claude', '--no-embed', '--full', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    const r = run(['link', '--suggest', '--potsherd-dir', root]);
    expect(r.stderr).not.toContain("unknown option '--suggest'");
    expect(r.code).toBe(0);
  });

  it('link --suggest --json is reachable and emits json', () => {
    const root = scratchRoot();
    run(['index', '--harness', 'claude', '--no-embed', '--full', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    const r = run(['link', '--suggest', '--json', '--potsherd-dir', root]);
    expect(r.stderr).not.toContain("unknown option '--suggest'");
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('guard carries no --suggest flag: it belongs to link', () => {
    const r = run(['guard', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('--suggest');
  });

  it('link --help documents --suggest', () => {
    const r = run(['link', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--suggest');
  });

  /**
   * T6.6 D3 — phase 6's WAVE.md: *"Verify a flag exists before documenting it."*
   *
   * `docs/memory-stack.md` documented `--brief` in the present tense. It was
   * the fifth phantom flag this project has published, and the whole repo held
   * exactly one occurrence of it — copied out of `plans/02`, where it is a
   * *plan*. A plan is not a flag.
   *
   * So: every long flag the docs page mentions must be declared in the CLI.
   * The check runs against `packages/cli/src/index.ts` — where every option is
   * registered — rather than against `--help`, so it needs no subprocess and
   * cannot be fooled by a verb whose help text mentions a flag it does not
   * have.
   */
  it('every flag docs/memory-stack.md mentions is one the cli declares', () => {
    const docs = fs.readFileSync(path.join(repo, 'docs', 'memory-stack.md'), 'utf-8');
    const cli = fs.readFileSync(
      path.join(repo, 'packages', 'cli', 'src', 'index.ts'),
      'utf-8',
    );
    const mentioned = [...new Set([...docs.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))];
    // Non-vacuous: the page does talk about flags.
    expect(mentioned.length).toBeGreaterThanOrEqual(3);
    const phantom = mentioned.filter((flag) => !cli.includes(`${flag} `) && !cli.includes(`${flag}'`) && !cli.includes(`${flag} <`));
    expect(phantom).toEqual([]);
  });

  it('an unknown verb points at --help instead of a stack trace', () => {
    const r = run(['excavate']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain('at Object.');
    expect(r.stderr).toContain('--help');
  });

  it('honours NO_COLOR and emits no escape codes', () => {
    const r = run(['audit', '--claude-dir', FIXTURE_CLAUDE], { NO_COLOR: '1' });
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(r.stdout)).toBe(false);
  });

  it('honours CLAUDE_CONFIG_DIR when no --claude-dir is given', () => {
    const r = run(['audit', '--json'], { CLAUDE_CONFIG_DIR: FIXTURE_CLAUDE });
    expect(JSON.parse(r.stdout)['deleted']).toBe(3);
  });

  /**
   * `index` reads every harness by default, and on this machine three of the
   * four are the developer's real directories. `--harness claude` keeps the
   * numbers below a function of the committed fixture and nothing else.
   */
  it('index builds a searchable index from the fixture and is incremental after', () => {
    const root = scratchRoot();
    const args = ['index', '--harness', 'claude', '--no-embed', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root];

    const first = run([...args, '--full', '--json']);
    expect(first.code).toBe(0);
    const a = JSON.parse(first.stdout) as {
      totals: { parsed: number; sessions: number; exchanges: number; failed: number };
      embeddings: { enabled: boolean };
    };
    // Two sessions and two sidechains: a subagent transcript is a session in
    // its own right and never a session of its parent.
    expect(a.totals.sessions).toBe(4);
    expect(a.totals.parsed).toBe(4);
    expect(a.totals.failed).toBe(0);
    expect(a.totals.exchanges).toBeGreaterThan(0);
    expect(a.embeddings.enabled).toBe(false);

    const second = run([...args, '--json']);
    const b = JSON.parse(second.stdout) as { totals: { parsed: number; skipped: number; sessions: number } };
    expect(b.totals.parsed).toBe(0);
    expect(b.totals.skipped).toBe(4);
    expect(b.totals.sessions).toBe(4);
  });

  it('index refuses two flags that ask for opposite things', () => {
    const root = scratchRoot();
    const r = run(['index', '--full', '--incremental', '--potsherd-dir', root]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('opposite');
    expect(r.stderr).not.toContain('at Object.');
  });

  it('index names an unknown harness instead of silently indexing nothing', () => {
    const root = scratchRoot();
    const r = run(['index', '--harness', 'emacs', '--potsherd-dir', root]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('emacs');
  });

  it('doctor reports redaction counts and the vector index after an index run', () => {
    const root = scratchRoot();
    run(['index', '--harness', 'claude', '--no-embed', '--full', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    const r = run(['doctor', '--json', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.stdout) as {
      redaction: Record<string, number>;
      index: { sessions: number; exchanges: number; vec: { available: boolean; reason?: string } };
      indexedRecordTypes: { harness: string; type: string; novel: boolean }[];
      adapters: { harness: string; supported: boolean }[];
    };
    expect(d.redaction).toHaveProperty('total');
    expect(d.index.sessions).toBe(4);
    expect(d.index.exchanges).toBeGreaterThan(0);
    // Either it loaded or it said why. Never neither.
    expect(d.index.vec.available || Boolean(d.index.vec.reason)).toBe(true);
    // Every claude record type the parser did not consume, with its version.
    expect(d.indexedRecordTypes.some((r) => r.harness === 'claude')).toBe(true);
    // T1.3a/T1.3c: the four adapters are supported now, not "phase 1".
    for (const harness of ['claude', 'codex', 'cursor', 'pi']) {
      expect(d.adapters.find((a) => a.harness === harness)?.supported, harness).toBe(true);
    }
  });

  /**
   * T6.6 D6 — the unverified label has to reach `--json`, because `--json` is
   * the documented API.
   *
   * The three phase-6 adapters were written from documentation and never run
   * against a real store. That is stated in the rendered `line` — and the
   * rendered line is width-dependent and, when the tool is **absent**, does
   * not carry the word at all. Absent is its state on every machine that does
   * not have the tool, which is most of them. So a caller reading `--json` got
   * `supported: true` and no way to learn that the parser has never seen real
   * input.
   *
   * A boolean, beside `supported`, on every entry.
   */
  it('doctor --json flags the adapters whose format is unverified', () => {
    const root = scratchRoot();
    const r = run(['doctor', '--json', '--claude-dir', FIXTURE_CLAUDE, '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.stdout) as {
      adapters: { harness: string; supported: boolean; unverified: boolean; line: string }[];
    };
    // Present on every entry, not only the ones where it is true.
    for (const a of d.adapters) {
      expect(typeof a.unverified, a.harness).toBe('boolean');
    }
    const flagged = d.adapters.filter((a) => a.unverified).map((a) => a.harness).sort();
    expect(flagged).toEqual(['copilot', 'gemini', 'opencode']);
    for (const harness of ['claude', 'codex', 'cursor', 'pi']) {
      expect(d.adapters.find((a) => a.harness === harness)?.unverified, harness).toBe(false);
    }
    // And the reason it matters. The word used to live only inside the
    // adapter's own sentence, and that sentence is *clipped to the terminal
    // width* before anyone sees it. At 40 columns the gemini row is
    // `gemini      empty     ~/.gemini/tmp…` and the label is gone — while
    // the field is not.
    const narrow = run([
      'doctor', '--width', '40', '--no-color', '--claude-dir', FIXTURE_CLAUDE,
      '--potsherd-dir', root,
    ]);
    const row = narrow.stdout
      .split('\n')
      .find((l) => l.trimStart().startsWith('gemini ') && l.includes('~/.gemini'))!;
    expect(row).toBeDefined();
    expect(row).not.toContain('unverified');
    expect(d.adapters.find((a) => a.harness === 'gemini')?.unverified).toBe(true);
  });
});

/**
 * `potsherd card` — the T2.1 half: the estimate, the backend, the caps.
 *
 * Every test here runs the shipped bundle, because the acceptance criterion is
 * a command line (`potsherd card --dry-run --all` exits 0 having called
 * nothing) rather than a function. The no-backend cases run with a PATH that
 * contains nothing at all and no key, which is the machine potsherd has to
 * behave well on: no `claude`, no `codex`, no credentials, no network.
 */
describe('potsherd card', () => {
  /**
   * A claude directory with sessions long enough to be worth a card.
   *
   * The committed fixture's sessions are two exchanges each — deliberately, it
   * exists to test parsing — and `03` §6 does not card a session under three.
   * So these tests write their own, rather than lowering the floor to make a
   * test pass.
   */
  function cardableClaudeDir(sessions = 2, exchanges = 5): string {
    const dir = path.join(scratchRoot(), 'claude');
    const project = path.join(dir, 'projects', '-tmp-potsherd-cards');
    fs.mkdirSync(project, { recursive: true });
    for (let s = 0; s < sessions; s++) {
      const id = `${String(s + 1).repeat(8)}-1111-4111-8111-111111111111`;
      const lines: string[] = [];
      const base = {
        sessionId: id,
        cwd: '/tmp/potsherd-cards',
        version: '2.1.237',
        gitBranch: 'main',
        userType: 'external',
        entrypoint: 'cli',
        isSidechain: false,
      };
      let uuid = 0;
      for (let e = 0; e < exchanges; e++) {
        const u = `u${uuid++}`;
        const a = `u${uuid++}`;
        lines.push(JSON.stringify({
          ...base, type: 'user', uuid: u, parentUuid: null, promptId: `p${e}`,
          timestamp: `2026-08-0${s + 1}T09:0${e}:00.000Z`,
          message: { role: 'user', content: `question ${e} about the pooler ${'x'.repeat(200)}` },
        }));
        lines.push(JSON.stringify({
          ...base, type: 'assistant', uuid: a, parentUuid: u, requestId: `r${e}`,
          timestamp: `2026-08-0${s + 1}T09:0${e}:30.000Z`,
          message: {
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            content: [{ type: 'text', text: `answer ${e} ${'y'.repeat(400)}` }],
          },
        }));
      }
      fs.writeFileSync(path.join(project, `${id}.jsonl`), lines.join('\n') + '\n');
    }
    return dir;
  }

  /** That directory, indexed and ready to card. */
  function indexed(): string {
    const root = scratchRoot();
    const r = run([
      'index', '--harness', 'claude', '--no-embed', '--full',
      '--claude-dir', cardableClaudeDir(), '--potsherd-dir', root,
    ]);
    expect(r.code).toBe(0);
    return root;
  }

  /** A machine with no claude, no codex and no api key. */
  function bare(): Record<string, string> {
    const empty = scratchRoot();
    return { PATH: empty, ANTHROPIC_API_KEY: '', POTSHERD_LLM_BACKEND: '' };
  }

  it('--dry-run --all prints sessions, tokens, cost and minutes, and exits 0', () => {
    const root = indexed();
    const r = run(['card', '--dry-run', '--all', '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sessions to card');
    expect(r.stdout).toContain('input tokens');
    expect(r.stdout).toContain('output tokens');
    expect(r.stdout).toMatch(/\$\d/);
    // `~55m`, not `7m 26s`: the tilde and the range are the honesty contract
    // (T2.6). A point estimate rendered to the second claims a precision the
    // one measured run showed it does not have.
    expect(r.stdout).toMatch(/estimated time\s+~\d/);
    expect(r.stdout).toContain('est. ');
    expect(r.stdout).toContain('time and cost are estimates');
    expect(r.stdout).toContain('nothing was called');
  });

  it('--dry-run --all --json carries the same four numbers', () => {
    const root = indexed();
    const r = run(['card', '--dry-run', '--all', '--json', '--potsherd-dir', root]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.stdout) as {
      dryRun: boolean;
      estimate: { sessions: number; inputTokens: number; outputTokens: number; usd: number; minutes: number };
    };
    expect(d.dryRun).toBe(true);
    expect(d.estimate.sessions).toBeGreaterThan(0);
    expect(d.estimate.inputTokens).toBeGreaterThan(0);
    expect(d.estimate.outputTokens).toBeGreaterThan(0);
    expect(d.estimate.usd).toBeGreaterThan(0);
    expect(d.estimate.minutes).toBeGreaterThan(0);
  });

  it('--dry-run still works on a machine with no claude, no codex and no key', () => {
    const root = indexed();
    const r = run(['card', '--dry-run', '--all', '--potsherd-dir', root], bare());
    // Asking what it would cost must never require a credential.
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no backend');
    expect(r.stdout).toMatch(/\$\d/);
  });

  it('a real run with no backend names both options and exits non-zero', () => {
    const root = indexed();
    const r = run(['card', '--all', '--yes', '--potsherd-dir', root], bare());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('claude');
    expect(r.stderr).toContain('ANTHROPIC_API_KEY');
    // No stack trace, ever.
    expect(r.stderr).not.toContain('    at ');
  });

  it('picks the api path when there is no claude binary but a key is set', () => {
    const root = indexed();
    const r = run(
      ['card', '--dry-run', '--all', '--json', '--potsherd-dir', root],
      { ...bare(), ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' },
    );
    expect(r.code).toBe(0);
    const d = JSON.parse(r.stdout) as { backend: { name: string; chargeable: boolean } | null };
    expect(d.backend?.name).toBe('api');
    expect(d.backend?.chargeable).toBe(true);
  });

  it('says which sessions it needs rather than carding everything by accident', () => {
    const root = indexed();
    const r = run(['card', '--dry-run', '--potsherd-dir', root]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('which sessions');
    expect(r.stderr).toContain('--all');
  });

  it('names a session reference it cannot resolve', () => {
    const root = indexed();
    const r = run(['card', 'deadbeef', '--dry-run', '--potsherd-dir', root]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('deadbeef');
  });

  it('--help shows the dry run first', () => {
    const r = run(['card', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('--max-usd');
    expect(r.stdout).toContain('potsherd card --dry-run --all');
  });

  it('is on the tour', () => {
    expect(run([]).stdout).toContain('card');
  });
});

/**
 * The no-args screen, which `plans/05` calls the first of the "every verb ends
 * with the next verb" lines and phase 7 rewrote from a twenty-row dump into a
 * six-verb path.
 *
 * The load-bearing test is the last one. `stack` shipped in phase 6 as a
 * 589-line module and 45 tests that the command line could not reach, and the
 * suite stayed green partly because *"every verb has --help"* passed precisely
 * because `stack` was not a verb. A tour derived by hand from a list somebody
 * remembered can drift the same way, so it is checked against commander's own
 * registry rather than against a second hand-written list.
 */
describe('the tour', () => {
  const verbs = (): string[] => {
    const help = run(['--help']).stdout;
    const body = help.slice(help.indexOf('Commands:'));
    return [...body.matchAll(/^ {2}(\w[\w-]*)/gm)]
      .map((m) => m[1] as string)
      .filter((v) => v !== 'help');
  };

  it('leads with the six of plans/05, numbered and in order', () => {
    const out = run([]).stdout;
    const order = ['audit', 'rescue', 'ls', 'find', 'ask', 'graft'];
    const at = order.map((v) => out.indexOf(`potsherd ${v} `));
    expect(at.every((i) => i > 0), `missing one of ${order.join(', ')}`).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const [i, v] of order.entries()) {
      expect(out).toMatch(new RegExp(`${i + 1}\\s+potsherd ${v}\\b`));
    }
  });

  it('names every verb the binary actually registers', () => {
    const out = run([]).stdout;
    const missing = verbs().filter((v) => !new RegExp(`\\b${v}\\b`).test(out));
    expect(missing, `verbs the tour does not name: ${missing.join(', ')}`).toEqual([]);
  });

  it('names nothing the binary does not register', () => {
    const registered = new Set(verbs());
    const out = run([]).stdout;
    // Only the two verb blocks, so prose like "sessions" is not mistaken for one.
    const named = [...out.matchAll(/^\s+(?:\d\s+potsherd )?([a-z][a-z-]{1,9})\b/gm)]
      .map((m) => m[1] as string)
      .filter((w) => !['potsherd', 'also', 'the', 'start', 'card'].includes(w) || registered.has(w));
    for (const n of named) {
      if (['the', 'start', 'also'].includes(n)) continue;
      expect(registered.has(n) || n === 'potsherd', `${n} is on the tour but is not a verb`).toBe(
        true,
      );
    }
  });

  it('fits the width it is given, at 80 and at 60', () => {
    for (const w of [80, 60]) {
      for (const line of run(['--width', String(w)]).stdout.split('\n')) {
        expect([...line].length, `${w}: ${line}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it('is the tour for a global flag with no verb, not an empty screen', () => {
    // `potsherd --ascii` and `potsherd --width 60` are what anyone taking a
    // screenshot types. Both used to parse to nothing and print nothing at all.
    expect(run(['--ascii']).stdout).toContain('start here');
    expect(run(['--width', '60']).stdout).toContain('start here');
    expect(run(['--ascii']).stdout).not.toMatch(/[^\x00-\x7F]/);
  });

  it('carries the same data under --json', () => {
    const j = JSON.parse(run(['--json']).stdout) as {
      path: { verb: string }[];
      also: { verb: string }[];
    };
    expect(j.path.map((p) => p.verb)).toEqual(['audit', 'rescue', 'ls', 'find', 'ask', 'graft']);
    const all = [...j.path, ...j.also].map((p) => p.verb).sort();
    expect(all).toEqual(verbs().sort());
  });
});

describe('version', () => {
  it('matches the manifest npm publishes', () => {
    // The version used to be four separate literals, and at tag v0.2.0 three of
    // them still said 0.1.0. A version a user reads must never disagree with the
    // tag they installed.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repo, 'packages', 'cli', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(run(['--version']).stdout.trim()).toBe(manifest.version);
  });

  it('reports the same version everywhere it is shown', () => {
    const v = run(['--version']).stdout.trim();
    expect(run([]).stdout).toContain(v);
    expect(run(['doctor', '--json', '--claude-dir', FIXTURE_CLAUDE]).stdout).toContain(`"${v}"`);
  });
});
