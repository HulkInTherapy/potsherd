#!/usr/bin/env node
/**
 * Rewrite `evals/per-query-baseline.json` from a real eval run.
 *
 * The baseline pins which QUERIES pass, not just how many. A count tells you
 * retrieval got worse; the baseline tells you it stopped finding the ghost
 * session about the disk filling up, which is the sentence somebody can act on.
 *
 * It is deliberately a separate script rather than a flag on `pnpm evals`,
 * because regenerating it is how a regression gets erased. It should be run
 * when a change is understood and accepted, never to make a red run green.
 *
 *   pnpm evals -- --json | node scripts/write-eval-baseline.mjs
 *
 * The gate reads it and reports flips in both directions: a query that stopped
 * passing is a regression, and one that started is a note worth having, because
 * an unexplained improvement is as much a signal as an unexplained loss.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const raw = fs.readFileSync(0, 'utf8');
const start = raw.indexOf('{');
if (start < 0) {
  console.error('no JSON on stdin — did you pass --json?');
  process.exit(1);
}

const run = JSON.parse(raw.slice(start));
if (!Array.isArray(run.modes) || run.modes.length === 0) {
  console.error('this run has no modes; refusing to write an empty baseline');
  process.exit(1);
}

const modes = {};
for (const m of run.modes) {
  modes[m.mode] = {};
  for (const r of m.results) modes[m.mode][r.query] = { hit: r.hit, hit1: r.hit1 };
}

const out = {
  note:
    'Per-query pass/fail, pinned so a regression names WHICH query fell rather ' +
    'than only how many. Regenerate deliberately with: pnpm evals -- --json | ' +
    'node scripts/write-eval-baseline.mjs',
  k: run.k,
  total: run.queries,
  modes,
};

const file = path.join(process.cwd(), 'evals', 'per-query-baseline.json');
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `wrote ${path.relative(process.cwd(), file)} — ` +
    `${String(Object.keys(modes).length)} modes x ${String(run.queries)} queries`,
);
