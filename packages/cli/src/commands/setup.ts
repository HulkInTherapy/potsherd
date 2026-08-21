import process from 'node:process';
import { format as fmt, paths, setup } from '@potsherd/core';
// `packages/core/src/index.ts` is reserved for the integrator this phase, so
// the barrel line — `export * as setup from './setup.js';` — is written out in
// `phases/phase-5/registration-T5.5.txt` rather than added here. Until it
// lands, this one import reaches the module directly, so the branch builds,
// typechecks and tests green; swap it for `setup` in the line above once the
// barrel carries it.

import { confirm, print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';

/**
 * The flags the commander block registers, in help order.
 *
 * Re-exported here so registering the verb needs one import from one module,
 * and so the flag list can never drift from the client list it is built from.
 */
export const SETUP_CLIENTS: readonly setup.ClientId[] = setup.CLIENT_IDS;

export interface SetupOptions extends GlobalOptions {
  /** The clients named on the command line, in `CLIENTS` order. */
  clients?: setup.ClientId[];
  all?: boolean;
  dryRun?: boolean;
  status?: boolean;
  remove?: boolean;
}

/**
 * `potsherd setup` — register the potsherd MCP server with the agent the user
 * names, so the six tools are reachable from Cursor, Gemini CLI, opencode,
 * Copilot, pi, Codex and Claude Code without anyone hand-editing JSON.
 *
 * This is the one verb that writes into *another tool's* directory, which
 * `00-README.md` otherwise forbids outright, so it carries phase 0's whole
 * consent apparatus: it shows the diff, it asks, it never writes without a `y`,
 * it backs the file up first, and it merges rather than replaces — a user with
 * three other MCP servers keeps all three, and the prompt says their names
 * before the question.
 *
 * Three refusals are deliberate:
 *   - a config potsherd cannot rewrite losslessly (comments, bad JSON, an
 *     inline TOML table) is never touched; the snippet is printed instead.
 *   - a client with no evidence of being installed is reported, not failed, and
 *     its snippet is printed to paste later.
 *   - a stanza pointing at an MCP server that is not built is refused. Phase 0
 *     settled this for the guard hook — *a hook that looks installed and
 *     silently does nothing is worse than no hook* — and an MCP entry that
 *     fails to spawn is the same failure with a longer feedback loop.
 */
export async function runSetup(o: SetupOptions): Promise<number> {
  const t = themeFrom(o);
  const wanted = chosen(o);
  const resolution = setup.resolveMcpServer(process.argv[1]);

  if (o.status) return status(o, wanted);

  const plans = setup.planClients(wanted, {
    remove: o.remove ?? false,
    ...(o.claudeDir ? { claudeDir: o.claudeDir } : {}),
    resolution,
  });

  // Split before printing anything: what can be written, what is already done,
  // what potsherd refuses to touch, and what is not installed here.
  const absent = plans.filter((p) => !p.detection.present);
  const live = plans.filter((p) => p.detection.present);
  const blocked = live.filter((p) => !p.safe);
  const done = live.filter((p) => p.safe && p.noop);
  const todo = live.filter((p) => p.safe && !p.noop);

  // The binary check comes before the diff, because if it fails there is no
  // honest version of this write to consent to.
  const unbuilt = !o.remove && !resolution.exists;

  if (o.json) {
    printJson({
      dryRun: Boolean(o.dryRun),
      remove: Boolean(o.remove),
      server: serverJson(resolution),
      results: plans.map((p) => planJson(p, o)),
    });
    return unbuilt && todo.length && !o.dryRun ? 1 : blocked.length ? 1 : 0;
  }

  let changed = 0;
  let refused = 0;

  if (unbuilt && todo.length) {
    print('');
    print(`  ${t.warn('the potsherd MCP server is not built on this machine.')}`);
    if (resolution.file) {
      print(`  it would be  ${fmt.elideMiddle(paths.tildify(resolution.file), Math.max(32, t.width - 15), t)}`);
    } else {
      print(`  no ${setup.MCP_BIN} on your PATH, and no checkout to build it from.`);
    }
    print('');
    print(t.dim('  a stanza pointing at a binary that is not there looks installed'));
    print(t.dim('  and silently gives the model nothing, which is worse than no'));
    print(t.dim(`  stanza at all. so potsherd ${o.dryRun ? 'would refuse' : 'refuses'} to write it.`));
    print('');
    print('  build it first:  pnpm install && pnpm build');
  }

  for (const plan of todo) {
    printPlan(plan, o, t, resolution, unbuilt);

    if (o.dryRun) {
      print(`  ${t.dim('dry run: nothing was written.')}`);
      continue;
    }
    if (unbuilt) {
      refused++;
      continue;
    }

    let approved = o.yes ?? false;
    if (!approved) {
      if (!process.stdin.isTTY) {
        throw new UserError(
          `setup needs a terminal to confirm the change to ${paths.tildify(plan.path)}`,
          `potsherd setup --${plan.client} --yes`,
        );
      }
      approved = await confirm(
        o.remove ? `  remove it from ${plan.label}?` : `  add it to ${plan.label}?`,
        { default: false },
      );
    }
    if (!approved) {
      print(`  no change made to ${short(plan.path, t, 22)}`);
      continue;
    }
    const { backup } = setup.applySetupPlan(plan);
    changed++;
    print(
      o.remove
        ? `  ${t.ok('removed')}  ${short(plan.path, t, 11)}`
        : `  ${t.ok('registered')}  ${plan.label} can now reach your sessions`,
    );
    if (backup) print(`  ${t.dim('backup:')} ${short(backup, t, 11)}`);
  }

  for (const plan of done) {
    print('');
    if (o.remove) {
      print(`  ${plan.label}: potsherd was not registered; nothing to remove.`);
    } else {
      print(`  ${plan.label}: already registered, unchanged.`);
      print(`  ${t.dim(short(plan.path, t, 2))}`);
    }
  }

  for (const plan of blocked) {
    refused++;
    print('');
    for (const line of setup.manualSteps(plan)) print('  ' + line);
  }

  for (const plan of absent) {
    print('');
    print(`  ${plan.label} is not installed here — nothing was written.`);
    print(`  ${t.dim(`no ${short(plan.path, t, 6)}`)}`);
    print(`  ${t.dim(`and no ${plan.detection.bins.join(' or ')} on your PATH`)}`);
    if (!o.remove) {
      print(`  ${t.dim('when you install it, this is the stanza:')}`);
      for (const line of plan.snippet.trimEnd().split('\n')) print('    ' + t.dim(line));
    }
  }

  if (!o.quiet) nextStep(o, t, { changed, refused, todo: todo.length, plans });
  return refused ? 1 : 0;
}

/** The block shown per client, above the question. */
function printPlan(
  plan: setup.SetupPlan,
  o: SetupOptions,
  t: ReturnType<typeof themeFrom>,
  resolution: setup.McpResolution,
  unbuilt = false,
): void {
  const verb = plan.action === 'remove' ? 'remove' : plan.action === 'update' ? 're-point' : 'add';
  const prep = plan.action === 'remove' ? 'from' : plan.action === 'update' ? 'in' : 'to';
  print('');
  print(
    unbuilt
      ? `  once it is built, this is what potsherd would ${verb} ${prep} ${plan.label}.`
      : `  potsherd will ${verb} one MCP server ${prep} ${plan.label}.`,
  );
  print('');
  const pathW = Math.max(24, t.width - 11);
  print(`  file   ${fmt.elideMiddle(paths.tildify(plan.path), pathW, t)}`);
  if (plan.action !== 'remove') {
    print(`  runs   ${fmt.elideMiddle(commandLine(resolution), Math.max(32, t.width - 11), t)}`);
    const tools = fmt.wrap(TOOLS.join(', '), Math.max(24, t.width - 9));
    print(`  tools  ${tools[0] ?? ''}`);
    for (const l of tools.slice(1)) print(`         ${l}`);
  }
  if (plan.keeps.length) {
    // The single most important thing this screen can say: your other servers
    // survive. Named, not counted, because a count is not evidence.
    print(
      `  keeps  ${t.accent(String(plan.keeps.length))} other MCP ${fmt.plural(plan.keeps.length, 'server')} here: ${fmt.joinFit(plan.keeps, Math.max(24, t.width - 40))}`,
    );
  }
  if (plan.detection.verified === 'docs') {
    // D11: this printed on one line and ran to 179 characters at --width 80,
    // unwrapped and unelided, on the same screen where `runs` elides to
    // exactly 80 and `tools` wraps. It is a sentence, so it wraps: eliding a
    // reason to fit leaves half a reason, and `05` gives every line 80 columns.
    const note = `${plan.label}'s schema is unverified: ${plan.detection.evidenceNote}`;
    const lines = fmt.wrap(note, Math.max(24, t.width - 9));
    print(`  ${t.warn('note')}   ${lines[0] ?? ''}`);
    for (const l of lines.slice(1)) print(`         ${l}`);
  }
  print('');
  for (const raw of plan.diff.split('\n')) {
    // The two file headers carry a path and nothing else, and a path is the one
    // thing here that can outrun any terminal. They elide in the middle like
    // every other path potsherd prints; `--json` still carries the whole diff.
    const line =
      raw.startsWith('--- ') || raw.startsWith('+++ ')
        ? raw.slice(0, 4) + fmt.elideMiddle(raw.slice(4), Math.max(24, t.width - 6), t)
        : raw;
    const tone =
      line.startsWith('+') && !line.startsWith('+++')
        ? t.ok(line)
        : line.startsWith('-') && !line.startsWith('---')
          ? t.warn(line)
          : t.dim(line);
    print('  ' + tone);
  }
  print('');
}

/** `--status`: what is registered where, and whether it would still run. */
function status(o: SetupOptions, wanted: setup.ClientId[]): number {
  const t = themeFrom(o);
  const rows = setup
    .detectAll(o.claudeDir ? { claudeDir: o.claudeDir } : {})
    .filter((d) => wanted.includes(d.client));

  if (o.json) {
    printJson({
      server: serverJson(setup.resolveMcpServer(process.argv[1])),
      clients: rows.map((d) => ({
        client: d.client,
        label: d.label,
        path: d.path,
        installed: d.bin !== null,
        present: d.present,
        evidence: d.evidence,
        registered: d.registered,
        command: d.registeredCommand,
        runnable: setup.commandRunnable(d.registeredCommand),
        otherServers: d.others,
        verified: d.verified,
        evidenceNote: d.evidenceNote,
      })),
    });
    return rows.some((d) => d.registered && setup.commandRunnable(d.registeredCommand) === false) ? 1 : 0;
  }

  let broken = 0;
  let docsOnly = 0;
  print('');
  for (const d of rows) {
    const runnable = setup.commandRunnable(d.registeredCommand);
    const state = !d.present
      ? t.dim('not installed')
      : !d.registered
        ? t.dim('not registered')
        : runnable === false
          ? t.warn('registered but broken')
          : t.ok('registered');
    if (d.registered && runnable === false) broken++;
    // D8. The write path, `--dry-run` and `--json` all carry the unverified
    // label; `--status` printed a bare `registered` for all seven and so was
    // the one surface where four schemas potsherd has never seen a real file
    // of looked exactly like three it has. `--status` is the verb somebody
    // runs *later*, to check — it is the surface that most needs to carry it.
    const unverified = d.verified === 'docs';
    if (unverified) docsOnly++;
    print(`  ${d.label.padEnd(20)}${state}${unverified ? t.warn('  · schema unverified') : ''}`);
    print(`  ${' '.repeat(20)}${t.dim(fmt.elideMiddle(paths.tildify(d.path), Math.max(24, t.width - 24), t))}`);
    if (unverified) {
      // The reason, wrapped rather than elided: it is a sentence, not a path,
      // and half a sentence is not evidence.
      for (const l of fmt.wrap(d.evidenceNote, Math.max(24, t.width - 24))) {
        print(`  ${' '.repeat(20)}${t.dim(l)}`);
      }
    }
    if (d.registered && runnable === false) {
      print(`  ${' '.repeat(20)}${t.dim('that command does not run from here; re-run  potsherd setup')}`);
    }
  }
  print('');
  print(`  ${t.dim('registered means the stanza is in that file, not that the client has read it.')}`);
  if (docsOnly) {
    // Wrapped, not clipped: `05` gives every line of this screen 80 columns,
    // and this sentence is longer than one of them.
    const note =
      `schema unverified means potsherd has never read a real config for ` +
      `${docsOnly === 1 ? 'that client' : 'those clients'}; the stanza follows ` +
      `the published documentation and nothing more.`;
    for (const l of fmt.wrap(note, Math.max(24, t.width - 2))) print(`  ${t.dim(l)}`);
  }
  print('');
  return broken ? 1 : 0;
}

/** Every verb ends with the next verb (`05`). */
function nextStep(
  o: SetupOptions,
  t: ReturnType<typeof themeFrom>,
  s: { changed: number; refused: number; todo: number; plans: setup.SetupPlan[] },
): void {
  print('');
  if (o.dryRun) {
    // `--all` is one flag; spelling out all seven would run to 96 columns.
    const flags = o.all ? '--all' : s.plans.map((p) => `--${p.client}`).join(' ');
    const cmd = fmt.clip(`potsherd setup ${flags}`, Math.max(24, t.width - 22), t);
    print(`  run  ${t.accent(cmd)}  to write it.`);
  } else if (s.changed && o.remove) {
    print(`  run  ${t.accent('potsherd setup --status')}  to confirm it is gone.`);
  } else if (s.changed) {
    print(`  restart the client, then ask it:  ${t.accent('"what did we decide about X last month?"')}`);
  } else {
    print(`  run  ${t.accent('potsherd setup --status')}  to see what is registered where.`);
  }
  print('');
}

/**
 * A path, folded to `~` and elided in the middle so it cannot outrun the
 * terminal (`05`: never wrap, elide in the middle, the last segment is what
 * identifies a file). `indent` is the width of whatever precedes it.
 */
function short(p: string, t: ReturnType<typeof themeFrom>, indent: number): string {
  return fmt.elideMiddle(paths.tildify(p), Math.max(24, t.width - indent), t);
}

/** The six tools of the pinned MCP contract (`phases/phase-5/WAVE.md`). */
const TOOLS = ['find', 'read', 'ask', 'graft', 'ls', 'tag'].map((v) => `potsherd_${v}`);

function commandLine(res: setup.McpResolution): string {
  return [res.command, ...res.args].map(paths.tildify).join(' ');
}

function serverJson(res: setup.McpResolution): Record<string, unknown> {
  return {
    name: setup.SERVER_NAME,
    command: res.command,
    args: res.args,
    via: res.via,
    ...(res.file ? { file: res.file } : {}),
    built: res.exists,
    tools: TOOLS,
  };
}

function planJson(plan: setup.SetupPlan, o: SetupOptions): Record<string, unknown> {
  return {
    client: plan.client,
    label: plan.label,
    path: plan.path,
    format: plan.format,
    present: plan.detection.present,
    evidence: plan.detection.evidence,
    verified: plan.detection.verified,
    evidenceNote: plan.detection.evidenceNote,
    action: plan.detection.present ? plan.action : 'none',
    safe: plan.safe,
    ...(plan.reason ? { reason: plan.reason } : {}),
    noop: plan.noop,
    keeps: plan.keeps,
    snippet: plan.snippet,
    ...(plan.diff ? { diff: plan.diff } : {}),
    // `--json` carries the same data as the human view, and the human view
    // never writes on a dry run either.
    written: false,
    wouldWrite: Boolean(plan.detection.present && plan.safe && !plan.noop && !o.dryRun),
  };
}

function chosen(o: SetupOptions): setup.ClientId[] {
  if (o.all) return [...setup.CLIENT_IDS];
  const picked = o.clients ?? [];
  if (picked.length) return setup.CLIENT_IDS.filter((id) => picked.includes(id));
  throw new UserError(
    'setup needs to know which agent to configure',
    `potsherd setup --cursor      (or ${setup.CLIENT_IDS.map((c) => '--' + c).join(' ')} / --all)`,
  );
}
