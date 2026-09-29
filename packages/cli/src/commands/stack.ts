import { format as fmt, stack, Theme } from '@potsherd/core';
// `packages/core/src/index.ts` is reserved for the integrator this phase, so
// the barrel line — `export * as stack from './stack.js';` — is written out in
// `phases/phase-6/registration-T6.4.txt` rather than added here. Until it
// lands this import reaches the module directly, so the branch builds,
// typechecks and tests green; swap it for `stack` in the line above once the
// barrel carries it.


import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';

export interface StackOptions extends GlobalOptions {
  /** Print every path that was looked at, including the ones that missed. */
  paths?: boolean;
  /** Print the source URL and fetch date behind every row. */
  sources?: boolean;
}

/**
 * `potsherd stack` — who does what, and what potsherd does not do.
 *
 * The most honest surface in the product and the easiest to get wrong by
 * flattering ourselves, so three things are load-bearing in the layout below
 * and none of them is behind a flag:
 *
 *   1. **potsherd's row is first and it loses two of the four.** A table where
 *      one tool wins every row is an advert. `01 §1` scopes this product to
 *      failures 3 and 4; the `does not` block spells out that failure 2 is
 *      refused rather than unfinished, and names the tools that own it.
 *   2. **Every row says how well its claim was checked.** Five of the eight are
 *      `docs only`: read from that project's current documentation on a date
 *      that is printed, never exercised. Phase 5 shipped this for `setup`'s
 *      seven MCP clients and the verifier confirmed the label reached the
 *      user; this is the same contract on a wider set of claims.
 *
 *      The number in that sentence said *six* until T6.6 (D14), against a
 *      table, a footer and a `--json` payload that all said five. A prose
 *      count beside a computed one is a count that will drift, so
 *      `tests/stack.test.ts` now reads it out of this comment and checks it
 *      against `stackReport()`.
 *   3. **The asymmetry is stated above the table, not only in the column.**
 *      potsherd's row was measured by running potsherd; every other row was
 *      read from that project's documentation on a printed date. T8.8 moved
 *      that sentence from the `claim` column and the footer — both skippable —
 *      to the line directly above the first row. `stack.claimLegend()` owns
 *      the wording and `tests/stack.test.ts` asserts both halves of it survive.
 *   4. **Absence is a line, never an error.** A machine with none of these
 *      installed is the common case and gets a sentence saying so.
 */
export async function runStack(o: StackOptions): Promise<number> {
  const t = themeFrom(o);
  const r = stack.stackReport();

  if (o.json) {
    printJson({
      verifiedOn: r.verifiedOn,
      claimLegend: r.claimLegend,
      claimSource: r.claimSource,
      installed: r.installed,
      unverified: r.unverified,
      failures: r.failures,
      tools: r.detections.map((d) => ({
        id: d.spec.id,
        label: d.spec.label,
        repo: d.spec.repo,
        licence: d.spec.licence,
        licenceNote: d.spec.licenceNote ?? null,
        verified: d.spec.verified,
        evidenceNote: d.spec.evidenceNote,
        source: d.spec.source,
        present: d.present,
        found: d.found,
        looked: d.looked,
        coverage: coverageObject(d.spec.coverage),
        note: d.spec.note,
        capturesLive: d.spec.capturesLive,
        injectsAtStart: d.spec.injectsAtStart,
      })),
      overlaps: r.overlaps,
      recommendation: {
        rows: r.recommendation.rows.map((row) => ({
          failure: row.failure.n,
          use: row.use,
          why: row.why,
        })),
        actions: r.recommendation.actions,
      },
    });
    return 0;
  }

  for (const line of render(r, t, o)) print(line);
  return 0;
}

// --------------------------------------------------------------------- render

/**
 * The whole page, as lines.
 *
 * Built as an array rather than printed as it goes so that
 * `tests/stack.test.ts` can assert the thing the user sees — every line under
 * 80 columns, and under 60 with `--width 60` — instead of asserting the pieces
 * and hoping. `05`'s width rule is the one design constraint in this file that
 * a test can actually hold.
 */
export function render(r: stack.StackReport, t: Theme, o: StackOptions = {}): string[] {
  const L: string[] = [];
  const wide = t.width >= 72;

  L.push('');
  // T6.6 D14 — the heading counted `detections.length - 1` and called the
  // answer "tools known", so it said `7 tools known` over a table of eight
  // rows, one screen above a footer that said `8 rows`. The minus one is not
  // wrong, it is about a different set: `r.installed` excludes potsherd by
  // definition, so the number it is paired with has to exclude potsherd too.
  // The fix is to say which set each number is about, not to pick one of them.
  L.push(
    wide
      ? `potsherd stack ${t.sep} ${r.detections.length} tools known ${t.sep} ` +
        `${r.installed} of ${r.detections.length - 1} others here ` +
        `${t.sep} ${r.verifiedOn}`
      : `potsherd stack ${t.sep} ${r.installed} of ${r.detections.length - 1} here ` +
        `${t.sep} ${r.verifiedOn}`,
  );
  L.push('');

  // ---- the axis. Printed every time: the table's column heads are bare
  // digits, and a legend behind a flag is a legend nobody reads.
  L.push(`  the four failures people call ${t.dim('"losing context"')}`);
  L.push('');
  for (const f of r.failures) {
    // The `when` column is the legend's whole job and never drops; the
    // solved/unsolved verdict is what goes at 60 columns, because the table
    // two lines below says the same thing per tool.
    const state = f.solved ? t.dim('solved elsewhere') : t.accent('unsolved');
    L.push(`    ${f.n}  ${pad(f.label, 16)}${wide ? pad(f.when, 26) + state : f.when}`);
  }
  L.push('');

  // ---- the claim legend, and it goes ABOVE the table.
  //
  // T8.8. The `claim` column at the right of every row already says `docs
  // only` / `read here` / `this program`, and the footer already counts them.
  // Both are true and both are skippable: a reader scans the header and the
  // rows, and a screenshot crops the footer. The asymmetry that flatters us —
  // potsherd graded by running it, everyone else by reading their docs — is
  // therefore stated once, in a full sentence, before the first tool is named.
  // It wraps rather than eliding: at 60 columns it becomes four lines, which
  // is the correct trade, because a shortened version of this sentence is a
  // less true one.
  for (const line of fmt.wrap(r.claimLegend, t.width - 4)) L.push(t.dim(`  ${line}`));
  L.push('');

  // ---- the table.
  const labelW = 15;
  const licW = wide ? 13 : 0;
  L.push(
    t.dim(
      `  ${pad('tool', labelW)}${pad('here', 6)}${pad('licence', licW)}` +
        `1  2  3  4  ${wide ? 'claim' : ''}`.trimEnd(),
    ),
  );
  for (const d of r.detections) {
    const cells = d.spec.coverage.map((c) => stack.coverageGlyph(c, t.ascii)).join('  ');
    const here = d.present ? t.ok(pad('yes', 6)) : t.dim(pad('no', 6));
    const claim = wide ? '  ' + claimLabel(d, t) : '';
    L.push(
      `  ${pad(d.spec.label, labelW)}${here}${pad(d.spec.licence, licW)}${cells}${claim}`,
    );
  }
  L.push('');
  L.push(
    t.dim(
      `  ${stack.coverageGlyph('yes', t.ascii)} covers it   ` +
        `${stack.coverageGlyph('partial', t.ascii)} partly, with a caveat   ` +
        `${stack.coverageGlyph('no', t.ascii)} does not`,
    ),
  );
  L.push('');

  // ---- what potsherd does not do. This block is the point of the verb, so it
  // comes before the notes on anyone else's tool.
  L.push(`  ${t.bold('what potsherd does not do')}`);
  L.push('');
  const notDone: [string, string][] = [
    ['1 context rot', 'not its reach. it is not in your session at all.'],
    [
      '2 cold start',
      "refused on purpose. no injection at SessionStart; that is claude-mem's " +
        'lane, and CLAUDE.md is free and already on.',
    ],
    ['also', 'no knowledge graph. hindsight and greplica do that.'],
    ['', 'no server, no account, no telemetry. sqlite in ~/.potsherd.'],
  ];
  for (const [label, text] of notDone) L.push(...hang(label, 16, text, 4, t.width));
  L.push('');

  // ---- the installed tools, one line of substance each.
  const here = r.detections.filter((d) => d.present && d.spec.id !== 'potsherd');
  if (here.length) {
    L.push(`  ${t.bold('installed here')}`);
    L.push('');
    for (const d of here) {
      L.push(`    ${t.ok(d.spec.label)}  ${t.dim(fmt.elide(d.found[0] ?? '', Math.max(20, t.width - 8 - d.spec.label.length), t))}`);
      for (const line of fmt.wrap(d.spec.note, t.width - 6)) L.push(`      ${line}`);
    }
    L.push('');
  } else {
    L.push(`  ${t.dim('none of the other seven is installed here.')}`);
    L.push('');
  }

  const absent = r.detections.filter((d) => !d.present && d.spec.id !== 'potsherd');
  if (absent.length) {
    L.push(`  ${t.dim('not installed here')}`);
    for (const line of fmt.wrap(absent.map((d) => d.spec.label).join(', '), t.width - 6)) {
      L.push(t.dim(`    ${line}`));
    }
    const why =
      'potsherd looked for a directory each one creates and found none.' +
      (o.paths ? '' : ' potsherd stack --paths shows where it looked.');
    for (const line of fmt.wrap(why, t.width - 4)) L.push(t.dim(`  ${line}`));
    if (o.paths) {
      for (const d of absent) {
        L.push(t.dim(`    ${pad(d.spec.label, 15)}${fmt.elideMiddle(d.looked.join('  '), t.width - 22, t)}`));
      }
    }
    L.push('');
  }

  // ---- overlaps.
  for (const ov of r.overlaps) {
    L.push(`  ${t.warn(ov.kind)}  ${t.dim(ov.tools.join(', '))}`);
    for (const line of fmt.wrap(ov.cost, t.width - 6)) L.push(`    ${line}`);
    for (const line of fmt.wrap(ov.fix, t.width - 6)) L.push(`    ${t.dim(line)}`);
    L.push('');
  }

  // ---- the recommendation.
  L.push(`  ${t.bold('recommended')}`);
  L.push('');
  for (const row of r.recommendation.rows) {
    L.push(`    ${row.failure.n}  ${pad(row.failure.label, 16)}${t.arrow}  ${row.use}`);
    for (const line of fmt.wrap(row.why, t.width - 12)) L.push(t.dim(`       ${line}`));
  }
  L.push('');
  for (const a of r.recommendation.actions) {
    for (const line of fmt.wrap(a, t.width - 6)) L.push(`    ${line}`);
  }
  if (r.recommendation.actions.length) L.push('');

  // ---- the honesty line, and it is not optional.
  const honesty =
    `${r.unverified} of these ${r.detections.length} rows are from the project's own ` +
    `docs, read ${r.verifiedOn}, and were never exercised here. ` +
    'the rest were read off this machine.';
  for (const line of fmt.wrap(honesty, t.width - 4)) L.push(t.dim(`  ${line}`));
  if (o.sources) {
    // T6.6 D9 — the label and the source used to share a line, and the source
    // was elided to fit. This is the flag whose entire job is to show the url
    // a claim was read from: a url with `…` in it is not one, cannot be
    // pasted, and cannot be checked. So the name goes on its own line and the
    // source goes under it, indented, unclipped. It is the one place in this
    // command where a long line is the correct answer — everything above is a
    // table, and a table that wraps stops being one.
    L.push('');
    for (const d of r.detections) {
      L.push(t.dim(`    ${d.spec.label}`));
      L.push(t.dim(`      ${d.spec.source}`));
    }
  } else {
    L.push(t.dim('  potsherd stack --sources  prints the url behind every row.'));
  }
  L.push('');
  L.push(`  ${t.dim('run')}  ${t.bold('potsherd audit')}   ${t.dim('what the 30-day sweep already took')}`);
  L.push('');

  return L;
}

/** `docs only` / `read here` / `this program`, coloured by how strong it is. */
function claimLabel(d: stack.Detection, t: Theme): string {
  if (d.spec.id === 'potsherd') return t.dim('this program');
  switch (d.spec.verified) {
    case 'tool':
      return t.ok('read here');
    case 'config':
      return t.ok('files read');
    default:
      return t.warn('docs only');
  }
}

function coverageObject(c: readonly stack.Coverage[]): Record<string, stack.Coverage> {
  return { '1': c[0]!, '2': c[1]!, '3': c[2]!, '4': c[3]! };
}

/**
 * A label in a fixed column with its text wrapped and hanging beneath it.
 *
 * The `what potsherd does not do` block was three hand-typed string literals
 * until a 60-column run showed all five of them over the line. Anything with a
 * label and a sentence goes through here now, so the width rule holds by
 * construction rather than by whoever last counted characters.
 */
function hang(label: string, labelW: number, text: string, indent: number, width: number): string[] {
  const lead = ' '.repeat(indent);
  const body = Math.max(20, width - indent - labelW);
  const lines = fmt.wrap(text, body);
  return lines.map((line, i) => `${lead}${i === 0 ? pad(label, labelW) : ' '.repeat(labelW)}${line}`);
}

/** Left-align in a fixed column. A width of 0 means "this column is dropped". */
function pad(s: string, w: number): string {
  if (w === 0) return '';
  return s.length >= w ? s.slice(0, w - 1) + ' ' : s + ' '.repeat(w - s.length);
}

/** Re-exported so the integrator's commander block needs one import. */
export const STACK_VERIFIED_ON = stack.VERIFIED_ON;
