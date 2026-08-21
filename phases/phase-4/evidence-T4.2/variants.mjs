/**
 * T4.2 variant sweep — what each rule in `open-threads.ts` actually costs.
 *
 * Every guard in the rule pass is a choice, and the brief's standard is that a
 * choice is defended by a measurement rather than by taste. This script
 * re-implements the rule pass with each guard on a knob and reports how many
 * candidates the reference corpus yields under each setting, so the
 * defensible statement is "excluding ghosts as source A removes N candidates,
 * of which M were checked and found wrong" rather than "ghosts felt weak".
 *
 * It deliberately duplicates the module's arithmetic instead of importing it:
 * the module hard-codes the shipped constants, which is exactly what a sweep
 * has to vary.
 *
 *   node variants.mjs <potsherd-dir>
 */
import Database from '../../../packages/core/node_modules/better-sqlite3/lib/index.js';
import {
  contentTokens,
  tokenCosine,
  normalisePath,
  sameProject,
  genericTokens,
  MENTION_COSINE,
  MIN_ANCHOR_TOKENS,
  MIN_PROJECT_OVERLAP,
} from '../../../packages/core/dist/open-threads.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node variants.mjs <potsherd-dir>');
  process.exit(2);
}
const db = new Database(`${dir}/potsherd.db`, { readonly: true });

const rows = db
  .prepare(
    `SELECT c.session_id, c.topics, c.decisions, c.files, c.open_threads, c.source,
            COALESCE(s.project, g.project) AS project,
            COALESCE(s.started_at, g.first_ts) AS ts
       FROM cards c
       LEFT JOIN sessions s ON s.id = c.session_id
       LEFT JOIN ghosts   g ON g.session_id = c.session_id`,
  )
  .all();

const J = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const generic = genericTokens(rows);
const seqStmt = db.prepare('SELECT ts FROM exchanges WHERE session_id = ? AND seq = ? LIMIT 1');

const cards = rows
  .filter((r) => (r.project ?? '').trim())
  .map((r) => {
    const topics = J(r.topics).filter((x) => typeof x === 'string');
    const files = J(r.files).filter((x) => typeof x === 'string');
    const decisions = J(r.decisions).filter((d) => d && typeof d.what === 'string');
    const threads = J(r.open_threads).filter((d) => d && typeof d.what === 'string');
    const tokens = new Set();
    for (const t of topics) for (const k of contentTokens(t, generic)) tokens.add(k);
    for (const f of files)
      for (const k of contentTokens(f.replace(/[\\/._-]+/g, ' '), generic)) tokens.add(k);
    return {
      sessionId: r.session_id,
      project: r.project.trim(),
      ghost: r.source !== 'transcript',
      topics,
      files,
      decisions,
      mentions: [...decisions.map((d) => d.what), ...threads.map((t) => t.what)].map(
        (m) => new Set(contentTokens(m)),
      ),
      tokens,
      paths: new Set(files.map(normalisePath).filter(Boolean)),
    };
  });

/** Projects that are a strict ancestor of two or more other indexed projects. */
function containers() {
  const all = [...new Set(cards.map((c) => c.project))];
  const out = new Set();
  for (const p of all) {
    const kids = all.filter((q) => q !== p && q.startsWith(`${p.replace(/\/+$/, '')}/`));
    if (kids.length >= 2) out.add(p);
  }
  return out;
}
const CONTAINERS = containers();

function run(opt) {
  const o = {
    ghostAsSource: false,
    ghostAsCounterEvidence: true,
    requireCitation: true,
    mention: MENTION_COSINE,
    anchor: MIN_ANCHOR_TOKENS,
    overlap: MIN_PROJECT_OVERLAP,
    splitContainers: false,
    ...opt,
  };

  const projects = new Map();
  for (const c of cards) {
    let pool = projects.get(c.project);
    if (!pool) {
      pool = { cards: [], tokens: new Set(), paths: new Set() };
      projects.set(c.project, pool);
    }
    pool.cards.push(c);
    for (const t of c.tokens) pool.tokens.add(t);
    for (const p of c.paths) pool.paths.add(p);
  }

  const raised = [];
  for (const a of cards) {
    if (a.ghost && !o.ghostAsSource) continue;
    for (const [project, pool] of projects) {
      if (sameProject(project, a.project)) {
        if (!o.splitContainers) continue;
        if (!CONTAINERS.has(project) && !CONTAINERS.has(a.project)) continue;
      }
      const shared = [...a.tokens].filter((t) => pool.tokens.has(t));
      const sharedPaths = [...a.paths].filter((p) => pool.paths.has(p));
      if (sharedPaths.length === 0 && shared.length < o.overlap) continue;

      const bCards = o.ghostAsCounterEvidence ? pool.cards : pool.cards.filter((b) => !b.ghost);

      for (const d of a.decisions) {
        const seqs = Array.isArray(d.evidence_seq) ? d.evidence_seq : [];
        const seq = a.ghost ? seqs[0] : seqs.find((s) => seqStmt.get(a.sessionId, s));
        if (o.requireCitation && seq === undefined) continue;

        const dTokens = new Set(contentTokens(`${d.what} ${d.why ?? ''}`));
        const anchor = [...dTokens].filter((t) => a.tokens.has(t) && pool.tokens.has(t));
        if (anchor.length < o.anchor) continue;

        let best = 0;
        for (const b of bCards)
          for (const m of b.mentions) {
            const c = tokenCosine(dTokens, m);
            if (c > best) best = c;
          }
        if (best >= o.mention) continue;

        raised.push({
          key: `${a.sessionId.slice(0, 8)}|${project}|${d.what.slice(0, 60)}`,
          what: d.what,
          project: a.project,
          otherProject: project,
          ghostSource: a.ghost,
          cited: seq !== undefined,
        });
      }
    }
  }
  const distinct = new Set(raised.map((r) => r.what.toLowerCase()));
  return { raised: raised.length, distinctDecisions: distinct.size, rows: raised };
}

const base = run({});
const variants = {
  shipped: base,
  ghostsAllowedAsSourceA: run({ ghostAsSource: true }),
  ghostsIgnoredAsCounterEvidenceInB: run({ ghostAsCounterEvidence: false }),
  uncitedDecisionsKept: run({ requireCitation: false }),
  anchor1: run({ anchor: 1 }),
  anchor3: run({ anchor: 3 }),
  projectOverlap1: run({ overlap: 1 }),
  projectOverlap5: run({ overlap: 5 }),
  mentionBarOff: run({ mention: 1.01 }),
  mentionBar05: run({ mention: 0.5 }),
  mentionBar02: run({ mention: 0.2 }),
  containersSplit: run({ splitContainers: true }),
};

const summary = {};
for (const [name, v] of Object.entries(variants)) {
  summary[name] = {
    raised: v.raised,
    distinctDecisions: v.distinctDecisions,
    deltaVsShipped: v.raised - base.raised,
  };
}
console.log(
  JSON.stringify(
    {
      cards: rows.length,
      realCards: rows.filter((r) => r.source === 'transcript').length,
      ghostCards: rows.filter((r) => r.source !== 'transcript').length,
      projects: new Set(cards.map((c) => c.project)).size,
      containerProjects: [...CONTAINERS],
      shippedConstants: { MENTION_COSINE, MIN_ANCHOR_TOKENS, MIN_PROJECT_OVERLAP },
      summary,
      // The rows only the ghost-as-source variant adds, so the choice can be
      // checked rather than asserted.
      ghostOnlyRows: variants.ghostsAllowedAsSourceA.rows.filter((r) => r.ghostSource),
      // The rows the ghost counter-evidence is what suppresses.
      suppressedByGhosts: variants.ghostsIgnoredAsCounterEvidenceInB.rows.filter(
        (r) => !base.rows.some((b) => b.key === r.key),
      ),
      uncitedOnlyRows: variants.uncitedDecisionsKept.rows.filter((r) => !r.cited),
    },
    null,
    2,
  ),
);
