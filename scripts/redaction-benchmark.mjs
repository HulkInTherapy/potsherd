#!/usr/bin/env node
/**
 * The **redaction false-positive benchmark**.
 *
 *   node scripts/redaction-benchmark.mjs [corpusDir] [options]
 *
 * Why this file exists. `tests/fixtures/secrets/clean.txt` is 200 lines of
 * ordinary code and prose and it passes with zero false positives — and it
 * still let a rule ship that masked **165,088** things on a real corpus of
 * 1,406 exchanges. Agent transcripts are not ordinary text: they are dense
 * with high-entropy *identifiers* (`toolu_…` tool-use ids, uuids, git shas,
 * SRI hashes) and, far worse, with **base64 image payloads** pasted into tool
 * results. A hand-written fixture cannot represent that distribution. This
 * script measures the real one.
 *
 * It is a measuring instrument, not a test: it prints, it never asserts. The
 * assertions live in `tests/redact.test.ts`, seeded from what this finds.
 *
 * ## What it reports
 *
 *   1. hits by type and by rule
 *   2. hits by **location** — prose (user/assistant text) vs tool_calls —
 *      because those two want different fixes
 *   3. the top-N most frequently masked distinct strings, so a systematic
 *      false positive shows up as one string with a five-figure count
 *   4. hits per exchange, and the worst single tool call
 *   5. redaction throughput in MB/s
 *
 * ## Reading the corpus
 *
 * READ-ONLY, always: the corpus is somebody's real transcripts. Nothing here
 * opens a file for writing, and the default corpus is the frozen reference
 * copy under `~/.potsherd/archive-manual-2026-08-21`. Pass a different
 * directory as the first argument; it is treated as a `~/.claude`-shaped root
 * (it must contain `projects/`).
 *
 * ## Options
 *
 *   --stage raw|elide   `elide` (default) runs the pre-redaction binary
 *                       elision `elideExchange` first, the way `ingest.ts`
 *                       does. `raw` skips it, which is what the redactor saw
 *                       before T1.4b — use it to reproduce the "before".
 *   --top N             how many distinct masked strings to list (default 50)
 *   --limit N           only the first N sessions (a fast smoke run)
 *   --json              machine-readable, for diffing two runs
 *   --samples N         example lines to print per rule (default 0)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const core = await import(path.join(root, 'packages/core/dist/index.js'));
const { redact, claude } = core;
// `elideExchange` lands with T1.4b; tolerate its absence so the script still
// runs against an older build when bisecting.
const elideExchange = core.redaction?.elideExchange;

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const has = (name) => argv.includes(`--${name}`);

const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]?.startsWith('--') && !['json'].includes(argv[i - 1].slice(2))));
const DEFAULT_CORPUS = path.join(os.homedir(), '.potsherd', 'archive-manual-2026-08-21');
const corpus = positional[0] ?? DEFAULT_CORPUS;
const stage = String(flag('stage', 'elide'));
const topN = Number(flag('top', 50));
const limit = Number(flag('limit', 0)) || Infinity;
const samplesPerRule = Number(flag('samples', 0));
const asJson = has('json');

if (!fs.existsSync(path.join(corpus, 'projects'))) {
  console.error(`no corpus at ${corpus} (expected a ~/.claude-shaped dir with projects/)`);
  process.exit(2);
}
if (stage === 'elide' && typeof elideExchange !== 'function') {
  console.error('this build has no elideExchange; re-run `pnpm build`, or pass --stage raw');
  process.exit(2);
}

// ---------------------------------------------------------------- the run

/** Where a hit was found. The two halves want different fixes. */
const LOCATIONS = ['user_text', 'assistant_text', 'tool_input', 'tool_result'];

const byType = new Map();
const byRule = new Map();
const byLocation = new Map();
const byValue = new Map();   // distinct masked string -> { n, type, rule }
const ruleSamples = new Map();

let sessions = 0;
let exchanges = 0;
let flaggedExchanges = 0;
let bytes = 0;
let redactMs = 0;
let worstCall = { hits: 0, where: '', session: '', seq: 0 };

const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

function scan(text, location, ctx) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  bytes += Buffer.byteLength(text);
  const t0 = performance.now();
  const { hits } = redact(text);
  redactMs += performance.now() - t0;
  for (const h of hits) {
    const value = text.slice(h.start, h.start + h.length);
    bump(byType, h.type);
    bump(byRule, `${h.type}/${h.rule}`);
    bump(byLocation, location);
    const seen = byValue.get(value);
    if (seen) seen.n += 1;
    else byValue.set(value, { n: 1, type: h.type, rule: h.rule });
    if (samplesPerRule > 0) {
      const list = ruleSamples.get(h.rule) ?? [];
      if (list.length < samplesPerRule) {
        const from = Math.max(0, h.start - 40);
        list.push(`${ctx}: …${text.slice(from, h.start + h.length + 40).replace(/\s+/g, ' ')}…`);
        ruleSamples.set(h.rule, list);
      }
    }
  }
  return hits.length;
}

const sources = claude.discover({ claudeDir: corpus, archive: false });
if (!asJson) console.log(`corpus ${corpus}\n${sources.length} transcripts · stage=${stage}\n`);

for (const source of sources.slice(0, limit === Infinity ? undefined : limit)) {
  let parsed;
  try {
    parsed = await claude.parse(source);
  } catch (err) {
    if (!asJson) console.error(`  skipped ${source.rel}: ${err.message}`);
    continue;
  }
  sessions += 1;
  for (const raw of parsed.exchanges) {
    const ex = stage === 'elide' ? elideExchange(raw).exchange : raw;
    exchanges += 1;
    let n = 0;
    n += scan(ex.userText, 'user_text', `${source.rel}#${ex.seq}`);
    n += scan(ex.assistantText, 'assistant_text', `${source.rel}#${ex.seq}`);
    for (const call of ex.toolCalls) {
      const a = scan(call.input, 'tool_input', `${source.rel}#${ex.seq}/${call.name}.input`);
      const b = scan(call.result, 'tool_result', `${source.rel}#${ex.seq}/${call.name}.result`);
      if (a + b > worstCall.hits) {
        worstCall = { hits: a + b, where: call.name, session: source.rel, seq: ex.seq };
      }
      n += a + b;
    }
    if (n > 0) flaggedExchanges += 1;
  }
}

// ---------------------------------------------------------------- the report

const total = [...byType.values()].reduce((a, b) => a + b, 0);
const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
const top = [...byValue.entries()]
  .sort((a, b) => b[1].n - a[1].n)
  .slice(0, topN)
  .map(([value, meta]) => ({ value, ...meta }));

const mb = bytes / (1024 * 1024);
const summary = {
  corpus,
  stage,
  sessions,
  exchanges,
  flaggedExchanges,
  totalHits: total,
  hitsPerExchange: exchanges ? Number((total / exchanges).toFixed(2)) : 0,
  byType: Object.fromEntries(sorted(byType)),
  byRule: Object.fromEntries(sorted(byRule)),
  byLocation: Object.fromEntries(LOCATIONS.map((l) => [l, byLocation.get(l) ?? 0])),
  distinctValues: byValue.size,
  worstToolCall: worstCall,
  megabytes: Number(mb.toFixed(1)),
  redactSeconds: Number((redactMs / 1000).toFixed(2)),
  throughputMBs: redactMs > 0 ? Number((mb / (redactMs / 1000)).toFixed(1)) : 0,
  top,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const num = (n) => n.toLocaleString('en-US');
const pad = (s, w) => String(s).padEnd(w);

console.log(`sessions            ${num(sessions)}`);
console.log(`exchanges           ${num(exchanges)}   ${num(flaggedExchanges)} flagged`);
console.log(`secrets masked      ${num(total)}   ${summary.hitsPerExchange} per exchange`);
console.log(`distinct values     ${num(byValue.size)}`);
console.log(`scanned             ${summary.megabytes} MB in ${summary.redactSeconds}s (${summary.throughputMBs} MB/s)`);
console.log();

console.log('by type');
for (const [k, v] of sorted(byType)) console.log(`  ${pad(k, 16)}${String(num(v)).padStart(9)}`);
console.log('\nby rule');
for (const [k, v] of sorted(byRule)) console.log(`  ${pad(k, 40)}${String(num(v)).padStart(9)}`);
console.log('\nby location');
for (const l of LOCATIONS) {
  const v = byLocation.get(l) ?? 0;
  const pct = total ? ((v / total) * 100).toFixed(1) : '0.0';
  console.log(`  ${pad(l, 16)}${String(num(v)).padStart(9)}   ${pct}%`);
}
console.log(`\nworst single tool call  ${num(worstCall.hits)} hits — ${worstCall.where} in ${worstCall.session}#${worstCall.seq}`);

console.log(`\ntop ${Math.min(topN, top.length)} masked strings`);
for (const [i, t] of top.entries()) {
  const shown = t.value.length > 60 ? `${t.value.slice(0, 57)}…` : t.value;
  console.log(`  ${String(i + 1).padStart(3)}. ${String(num(t.n)).padStart(7)}  ${pad(t.type, 12)} ${shown}`);
}

if (samplesPerRule > 0) {
  console.log('\nsamples');
  for (const [rule, list] of ruleSamples) {
    console.log(`  ${rule}`);
    for (const s of list) console.log(`    ${s.slice(0, 200)}`);
  }
}
