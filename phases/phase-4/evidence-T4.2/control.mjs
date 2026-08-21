/**
 * T4.2 control instrument.
 *
 * The rule pass raises a claim about an **absence**, and an absence cannot be
 * cited. The only honest way to know whether it is right is to go and look, so
 * this script does two things and neither of them is the rule pass:
 *
 *   `pairs`     — runs the rule's arithmetic with the mention bar switched OFF,
 *                 and for every (decision in A, project B) pair that clears the
 *                 structural guards, dumps the decision next to the best-matching
 *                 text anywhere in project B: its cards' decisions and open
 *                 threads, AND its raw exchanges. The exchanges are the point.
 *                 A card is a lossy summary; "B never decided this" has to be
 *                 checked against what B actually said, not against what the
 *                 card extractor happened to keep.
 *
 *   `df`        — token document frequency across every card in the index, which
 *                 is what GENERIC_DF thresholds.
 *
 * Labels are then applied by hand to the `pairs` output (see labels.json) and
 * `score` reads them back to produce the bar and the precision number.
 *
 * Usage:
 *   node control.mjs pairs <potsherd-dir> > pairs.json
 *   node control.mjs df    <potsherd-dir> > token-df.json
 *   node control.mjs score <potsherd-dir> <labels.json>
 */
import Database from '../../../packages/core/node_modules/better-sqlite3/lib/index.js';
import fs from 'node:fs';
import {
  contentTokens,
  tokenCosine,
  normalisePath,
  sameProject,
  genericTokens,
  MIN_ANCHOR_TOKENS,
  MIN_PROJECT_OVERLAP,
  MENTION_COSINE,
  GENERIC_DF,
  openThreadCandidates,
} from '../../../packages/core/dist/open-threads.js';

const [, , mode, dir, labelsFile] = process.argv;
if (!mode || !dir) {
  console.error('usage: node control.mjs <pairs|df|score> <potsherd-dir> [labels.json]');
  process.exit(2);
}
const db = new Database(`${dir}/potsherd.db`, { readonly: true });

const CARDS_SQL = `
  SELECT c.session_id, c.topics, c.decisions, c.files, c.open_threads, c.summary, c.source,
         COALESCE(s.project, g.project)     AS project,
         COALESCE(s.started_at, g.first_ts) AS ts
    FROM cards c
    LEFT JOIN sessions s ON s.id = c.session_id
    LEFT JOIN ghosts   g ON g.session_id = c.session_id`;

const J = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const rows = db.prepare(CARDS_SQL).all();
const generic = genericTokens(rows);

function load() {
  return rows
    .filter((r) => (r.project ?? '').trim())
    .map((r) => {
      const topics = J(r.topics).filter((x) => typeof x === 'string');
      const files = J(r.files).filter((x) => typeof x === 'string');
      const decisions = J(r.decisions).filter((d) => d && typeof d.what === 'string');
      const threads = J(r.open_threads).filter((d) => d && typeof d.what === 'string');
      const tokens = new Set();
      for (const t of topics) for (const tok of contentTokens(t, generic)) tokens.add(tok);
      for (const f of files)
        for (const tok of contentTokens(f.replace(/[\\/._-]+/g, ' '), generic)) tokens.add(tok);
      return {
        sessionId: r.session_id,
        project: r.project.trim(),
        ghost: r.source !== 'transcript',
        topics,
        files,
        decisions,
        mentions: [...decisions.map((d) => d.what), ...threads.map((t) => t.what)],
        tokens,
        paths: new Set(files.map(normalisePath).filter(Boolean)),
      };
    });
}

if (mode === 'df') {
  const df = new Map();
  for (const row of rows) {
    const here = new Set();
    for (const t of J(row.topics)) if (typeof t === 'string') for (const k of contentTokens(t)) here.add(k);
    for (const f of J(row.files))
      if (typeof f === 'string')
        for (const k of contentTokens(f.replace(/[\\/._-]+/g, ' '))) here.add(k);
    for (const k of here) df.set(k, (df.get(k) ?? 0) + 1);
  }
  const out = [...df.entries()]
    .map(([token, n]) => ({ token, cards: n, df: n / rows.length }))
    .sort((a, b) => b.cards - a.cards);
  console.log(
    JSON.stringify(
      {
        cards: rows.length,
        genericDf: GENERIC_DF,
        struck: out.filter((t) => t.df > GENERIC_DF).map((t) => t.token),
        top: out.slice(0, 40),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (mode === 'pairs') {
  const cards = load();
  const projects = new Map();
  for (const c of cards) {
    const l = projects.get(c.project);
    if (l) l.push(c);
    else projects.set(c.project, [c]);
  }
  const seqStmt = db.prepare('SELECT ts FROM exchanges WHERE session_id = ? AND seq = ? LIMIT 1');
  // Every exchange of project B, as token sets, so the label can be checked
  // against the transcript rather than against the card's summary of it.
  const exchStmt = db.prepare(
    `SELECT e.session_id, e.seq, e.user_text, e.assistant_text
       FROM exchanges e JOIN sessions s ON s.id = e.session_id
      WHERE s.project = ?`,
  );
  const exchCache = new Map();
  const exchangesFor = (project) => {
    if (!exchCache.has(project)) {
      exchCache.set(
        project,
        exchStmt.all(project).map((e) => ({
          sessionId: e.session_id,
          seq: e.seq,
          text: `${e.user_text}\n${e.assistant_text}`,
          tokens: new Set(contentTokens(`${e.user_text} ${e.assistant_text}`)),
        })),
      );
    }
    return exchCache.get(project);
  };

  const pairs = [];
  for (const a of cards) {
    if (a.ghost) continue;
    for (const [project, bCards] of projects) {
      if (sameProject(project, a.project)) continue;
      const bTokens = new Set();
      const bPaths = new Set();
      for (const b of bCards) {
        for (const t of b.tokens) bTokens.add(t);
        for (const p of b.paths) bPaths.add(p);
      }
      const sharedTokens = [...a.tokens].filter((t) => bTokens.has(t));
      const sharedPaths = [...a.paths].filter((p) => bPaths.has(p));
      if (sharedPaths.length === 0 && sharedTokens.length < MIN_PROJECT_OVERLAP) continue;

      for (const d of a.decisions) {
        const seqs = Array.isArray(d.evidence_seq) ? d.evidence_seq : [];
        const seq = seqs.find((s) => seqStmt.get(a.sessionId, s));
        if (seq === undefined) continue;
        const dTokens = new Set(contentTokens(`${d.what} ${d.why ?? ''}`));
        const anchor = [...dTokens].filter((t) => a.tokens.has(t) && bTokens.has(t));
        if (anchor.length < MIN_ANCHOR_TOKENS) continue;

        // The mention bar, switched off: record the score instead of testing it.
        let bestCard = 0;
        let bestCardText = '';
        for (const b of bCards)
          for (const m of b.mentions) {
            const c = tokenCosine(dTokens, new Set(contentTokens(m)));
            if (c > bestCard) {
              bestCard = c;
              bestCardText = m;
            }
          }
        // And the same question asked of B's raw transcript.
        let bestExch = 0;
        let bestExchWhere = '';
        let bestExchText = '';
        for (const e of exchangesFor(project)) {
          const c = tokenCosine(dTokens, e.tokens);
          if (c > bestExch) {
            bestExch = c;
            bestExchWhere = `${e.sessionId.slice(0, 8)}@${e.seq}`;
            bestExchText = e.text.replace(/\s+/g, ' ').slice(0, 400);
          }
        }
        pairs.push({
          key: `${a.sessionId.slice(0, 8)}|${project}|${d.what.slice(0, 60)}`,
          project: a.project,
          sessionId: a.sessionId,
          seq,
          what: d.what,
          why: d.why ?? '',
          otherProject: project,
          anchor,
          sharedTokens: sharedTokens.length,
          sharedPaths,
          bestCard,
          bestCardText,
          bestExch,
          bestExchWhere,
          bestExchText,
        });
      }
    }
  }
  pairs.sort((x, y) => y.bestCard - x.bestCard);
  console.log(JSON.stringify({ pairs, count: pairs.length }, null, 2));
  process.exit(0);
}

if (mode === 'score') {
  const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
  const byKey = new Map(Object.entries(labels.labels));
  const { pairs } = JSON.parse(
    fs.readFileSync(labelsFile.replace(/labels\.json$/, 'pairs.json'), 'utf8'),
  );

  const pos = [];
  const neg = [];
  for (const p of pairs) {
    const label = byKey.get(p.key);
    if (label === 'present') pos.push(p.bestCard);
    else if (label === 'absent') neg.push(p.bestCard);
  }
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  // The bar the measurement chooses: the largest value that still withdraws
  // every present pair, i.e. the bottom of the positive distribution.
  const bar = pos.length ? Math.min(...pos) : NaN;

  // Precision of the rule pass, at the shipped constant, on this corpus.
  const cands = openThreadCandidates(
    db,
    [...new Set(pairs.map((p) => p.sessionId))],
    { limit: 1000 },
  );
  let tp = 0;
  let fp = 0;
  const unlabelled = [];
  for (const c of cands) {
    const key = `${c.sessionId.slice(0, 8)}|${c.otherProject}|${c.what.slice(0, 60)}`;
    const label = byKey.get(key);
    if (label === 'absent') tp += 1;
    else if (label === 'present') fp += 1;
    else unlabelled.push(key);
  }
  console.log(
    JSON.stringify(
      {
        pairsExamined: pairs.length,
        labelled: { present: pos.length, absent: neg.length },
        presentMedian: med(pos),
        presentMin: pos.length ? Math.min(...pos) : null,
        absentMedian: med(neg),
        absentMax: neg.length ? Math.max(...neg) : null,
        absentOver05: neg.filter((n) => n >= 0.5).length,
        barChosenByMeasurement: bar,
        shipped: MENTION_COSINE,
        candidatesAtShippedBar: cands.length,
        truePositives: tp,
        falsePositives: fp,
        precision: tp + fp ? tp / (tp + fp) : null,
        unlabelled,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
