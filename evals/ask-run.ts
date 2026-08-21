#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  Theme,
  cardEmbeddingText,
  db as store,
  embeddings,
  format as fmt,
  indexAll,
  paths,
  rescue,
  table,
  vectorState,
  writeCard,
} from '../packages/core/src/index.js';
import type { Db } from '../packages/core/src/db.js';
// `packages/core/src/ask.ts` is T4.1's file and does not exist on this branch. That is
// deliberate: this harness was written by a worker who never saw the implementation, so the
// questions could not be tuned to it. Until T4.1 lands, `tsc` reports TS2307 on this line and
// `tsx evals/ask-run.ts` fails at the dynamic import in `main` with a message that says so.
// `tsx evals/ask-selftest.ts` still runs today, because everything below that actually decides
// a verdict is a pure function over an `AskResult` and a `Corpus`, and the type import erases.
import type { AskEvidence, AskOptions, AskResult } from '../packages/core/src/ask.js';

/**
 * T4.0 — the ask eval. `tsx evals/ask-run.ts` (integrator: `pnpm evals:ask`).
 *
 * Ten hand-verified questions and three decoys against the committed synthetic fixture, scored
 * against exactly the three gates in `plans/06 §ask evals` and nothing else. It prints a verdict
 * table and exits non-zero when a gate fails, because `phases/phase-3/HANDOFF.md §4` is right
 * that a score nobody checks is not a score.
 *
 * ## The instrument was built before the thing it measures
 *
 * `evals/ask.jsonl` and this file were written on a branch that could not see
 * `packages/core/src/ask.ts`. In phase 1 one worker wrote both the queries and the ranker and
 * produced 10/10, which measured nothing. In phase 3 a separate eval worker built a set that
 * could fail, and it failed the ranker four times until the ranker genuinely improved. This is
 * the same arrangement.
 *
 * ## Every way an eval harness in this repo has been wrong, and what stops each here
 *
 * **It measured string overlap and called it retrieval** (phase 1). Every query was a bag of
 * words lifted near-verbatim from its target, and with eleven candidate sessions recall@5 could
 * not fail. Here: every question is written the way somebody remembers a conversation weeks
 * later, the overlap between each question and its own answer is **re-measured every run and
 * printed**, and — because good intentions are not a control — the number recorded in
 * `ask.jsonl` is compared against the measured one and the run **fails outright** if the file
 * disagrees by more than {@link OVERLAP_TOLERANCE}. A set cannot lie about its own overlap.
 *
 * **The vector runs had no vectors** (`evals/run.ts`, twice). It built its index with
 * `embed: false` and then offered a "vectors on" mode, so "hybrid beats bm25" was bm25 against
 * bm25 and could not lose. Here: the index is built exactly the way `run.ts` builds it, with
 * embeddings whenever the model is on disk, with the fixture cards injected through the real
 * `writeCard`; and when the model is absent the run **says so on the screen** rather than
 * quietly scoring two card-shaped questions against an index that cannot serve them.
 *
 * **The gate was computed by a human comparing two screenshots** (phase 3, three times). Here
 * every gate is arithmetic in this file and the process exit code follows it.
 *
 * ## Four ways *this* harness could have been wrong, and what stops each
 *
 * **Scoring a citation by trusting it.** An evidence line is a claim about the corpus, so it is
 * checked against the corpus: `(sessionId, seq)` must resolve to a real exchange or a real ghost
 * prompt, and the `quote` must **occur verbatim** in that unit's text after whitespace
 * normalisation. A quote the model invented fails. A quote lifted from a *different* seq fails,
 * which is the interesting case — it is what a confident wrong answer looks like.
 *
 * **Scoring the answer by trusting the sentence list.** `plans/phases/phase-4` requires
 * uncited sentences to be dropped **by code, not by prompt**. A filter that only pretends to
 * drop leaves the sentence in `answer` while listing it in `dropped`. So `answer` is
 * reconstructed from `sentences[]`: anything left in `answer` that no kept sentence accounts for
 * is a fault, every kept sentence must appear in `answer`, and no `dropped` sentence may.
 *
 * **Letting a decoy pass because nothing was asked of it.** Gate (c) is not "did it print
 * something cautious". It is `refused === true` from the library **and** exit code 2 from the
 * CLI path, per `plans/phases/phase-4` deliverable 1. There is no flag to skip the CLI half; a
 * build where `potsherd ask` does not exist fails gate (c), which is the honest answer.
 *
 * **Decoys that quietly became answerable.** The fixture is a file in this repo and files
 * change. Every run measures, for each decoy, the best single-session coverage of its content
 * words across all 58 sessions and ghosts; if any session covers {@link DECOY_LEAK} of them the
 * decoy is no longer plausibly unanswerable and the run fails until somebody looks.
 *
 * ## What it does not measure
 *
 * Answer quality. Ten questions cannot say whether the prose is any good, only whether every
 * claim is grounded, whether the right conversation was found, and whether a question with no
 * answer got a refusal. It says nothing about cost, latency or the reader fan-out — `ask`'s own
 * `spend`, `ms` and `readers` are printed for the record and gate nothing.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

// -------------------------------------------------------------------- the gates
//
// Quoted from `plans/06-QUALITY-AND-EVALS.md §ask evals`:
//
//   10 questions with hand-written gold answers and the session/seq that proves each. score:
//   (a) every emitted claim has a citation that exists and says what the claim says — 100% or
//   the build fails; (b) gold coverage >= 7/10; (c) --strict on an unanswerable question
//   returns the refusal, not a guess (3 decoys).

/** (a) 100% or the build fails. Not a fraction anybody is allowed to round. */
export const GATE_CITATIONS = 1.0;
/** (b) gold coverage >= 7/10. */
export const GATE_COVERAGE = 7 / 10;
/** (c) all three decoys refuse under `--strict`. */
export const GATE_DECOYS = 3 / 3;
/** `plans/phases/phase-4` deliverable 1: `--strict` prints the refusal and **exits 2**. */
export const STRICT_EXIT = 2;

/**
 * The overlap a question is allowed to share with its own answer.
 *
 * Same definition and same line as `evals/run.ts`: of the question's content words (stopwords
 * dropped), what fraction appears verbatim in the answer sessions' indexed text. 0.6 is a
 * judgement, not a law — the phase-1 set it exists to catch sat at 0.8–1.0, so the failure is
 * loud rather than marginal. A question above the line is not automatically wrong; it has to be
 * worth defending, so the runner names it and its `note` has to say why.
 *
 * The committed set peaks at 0.50, so nothing is flagged today. The check stays because the set
 * will be edited by people who did not write it.
 */
export const OVERLAP_FLAG = 0.6;

/**
 * How far `ask.jsonl`'s recorded `overlap` may sit from the measured one before the run fails.
 *
 * This is the anti-gaming check, and it is a **hard failure rather than a warning** because the
 * warning version is exactly what phase 1 shipped. The recorded numbers are 2 decimal places, so
 * 0.02 is rounding and anything beyond it is a set that no longer matches its own file.
 */
export const OVERLAP_TOLERANCE = 0.02;

/**
 * The fraction of a decoy's content words a single session may cover before the decoy is
 * suspect. At 0.9 a session says nearly every distinctive word of the question, which is no
 * longer "plausible but unanswerable" — it is a session somebody should read.
 */
export const DECOY_LEAK = 0.9;

// --------------------------------------------------------------------- the set

export interface AskGold {
  id: string;
  question: string;
  /** Full session ids. A sidechain is `<parent>:agent-<hash>` and is listed as itself. */
  expectSessions: string[];
  /** `[sessionId, seq]`. Exchange seq is 1-based; ghost_prompts seq is 0-based. */
  expectSeqs: [string, number][];
  /** Regex alternatives, matched case-insensitively against `result.answer`. */
  expectPhrases: string[];
  gold: string;
  note: string;
  /** `max(text, card)` content-word overlap, as recorded. Re-measured every run. */
  overlap: number;
}

export interface AskDecoy {
  id: string;
  question: string;
  decoy: true;
  note: string;
}

export type AskCase = AskGold | AskDecoy;
export const isDecoy = (c: AskCase): c is AskDecoy => 'decoy' in c && c.decoy === true;

export function readSet(file: string): AskCase[] {
  if (!fs.existsSync(file)) throw new Error(`no ask eval set at ${file}`);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as AskCase);
}

// ------------------------------------------------------- gate (a): the citations
//
// The mechanical, unfakeable half. Everything here is a pure function of an `AskResult` and a
// `Corpus`, which is what lets `evals/ask-selftest.ts` prove the scorer with hand-built results
// and no model, no index and no `ask`.

/** What the harness can look up. The real one reads the index; the selftest hands over a map. */
export interface Corpus {
  /** Full text of one exchange or ghost prompt, or `null` when the pair does not resolve. */
  text(sessionId: string, seq: number): string | null;
}

export type FaultKind =
  | 'seq-missing'
  | 'quote-empty'
  | 'quote-absent'
  | 'quote-case'
  | 'index-shape'
  | 'cite-none'
  | 'cite-dangling'
  | 'answer-extra'
  | 'answer-missing'
  | 'dropped-present';

export interface Fault {
  kind: FaultKind;
  detail: string;
}

/** Whitespace normalisation, and nothing else — `plans/06` says the quote must *occur*. */
export const norm = (s: string): string =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Does `quote` occur in `text`?
 *
 * Verbatim, case-sensitively, after whitespace normalisation. Case matters: a quote is a
 * quotation, and a renderer that lowercases it has changed the record. The one allowance is an
 * elided quote — a `…` or `...` splits it into segments, each of which must occur, **in order**,
 * which cannot be used to smuggle anything in because every segment is still verbatim.
 */
export function quoteOccurs(quote: string, text: string): 'yes' | 'case-only' | 'no' {
  const hay = norm(text);
  const segments = norm(quote)
    .split(/\s*(?:…|\.\.\.)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return 'no';
  const walk = (h: string, s: string[]): boolean => {
    let at = 0;
    for (const seg of s) {
      const i = h.indexOf(seg, at);
      if (i < 0) return false;
      at = i + seg.length;
    }
    return true;
  };
  if (walk(hay, segments)) return 'yes';
  if (walk(hay.toLowerCase(), segments.map((s) => s.toLowerCase()))) return 'case-only';
  return 'no';
}

/**
 * Gate (a) for one result: every emitted claim has a citation that exists and says what the
 * claim says.
 *
 * Four things, all of them arithmetic:
 *  1. every `AskEvidence` resolves to a real exchange or ghost prompt, and its `quote` occurs in
 *     that unit's text;
 *  2. `evidence[].index` is 1-based and unique, because the sentences index into it;
 *  3. every kept sentence cites at least one evidence line, and every `cites` entry resolves;
 *  4. `answer` is exactly the kept sentences — nothing extra, nothing missing, and nothing that
 *     `dropped` claims was removed.
 */
export function checkCitations(result: AskResult, corpus: Corpus): Fault[] {
  const faults: Fault[] = [];
  const evidence: readonly AskEvidence[] = result.evidence ?? [];

  const seen = new Set<number>();
  for (const [i, e] of evidence.entries()) {
    const at = `evidence[${i}]`;
    if (!Number.isInteger(e.index) || e.index < 1) {
      faults.push({ kind: 'index-shape', detail: `${at} index ${String(e.index)} is not 1-based` });
    } else if (seen.has(e.index)) {
      faults.push({ kind: 'index-shape', detail: `${at} index ${e.index} is used twice` });
    }
    seen.add(e.index);

    const text = corpus.text(e.sessionId, e.seq);
    if (text === null) {
      faults.push({
        kind: 'seq-missing',
        detail: `${at} cites ${e.sessionId}@${e.seq}, which is not in the index`,
      });
      continue;
    }
    if (!e.quote || !norm(e.quote)) {
      faults.push({ kind: 'quote-empty', detail: `${at} has no quote` });
      continue;
    }
    const where = quoteOccurs(e.quote, text);
    if (where === 'no') {
      faults.push({
        kind: 'quote-absent',
        detail: `${at} quote is not in ${e.sessionId}@${e.seq}: ${JSON.stringify(fmt.clip(norm(e.quote), 70))}`,
      });
    } else if (where === 'case-only') {
      faults.push({
        kind: 'quote-case',
        detail: `${at} quote matches ${e.sessionId}@${e.seq} only after case folding — a quote is a quotation`,
      });
    }
  }

  const sentences = result.sentences ?? [];
  for (const [i, s] of sentences.entries()) {
    if (!s.cites || s.cites.length === 0) {
      faults.push({
        kind: 'cite-none',
        detail: `sentences[${i}] was kept with no citation: ${JSON.stringify(fmt.clip(norm(s.text), 60))}`,
      });
      continue;
    }
    for (const c of s.cites) {
      if (!seen.has(c)) {
        faults.push({ kind: 'cite-dangling', detail: `sentences[${i}] cites [${c}], which is not an evidence line` });
      }
    }
  }

  // The filter that only pretends to drop. `answer` is walked once, consuming each kept sentence
  // in order; whatever is left over must be punctuation and spacing.
  const answer = norm(result.answer ?? '');
  let cursor = 0;
  const residue: string[] = [];
  for (const [i, s] of sentences.entries()) {
    const t = norm(s.text ?? '');
    if (!t) continue;
    const at = answer.indexOf(t, cursor);
    if (at < 0) {
      faults.push({
        kind: 'answer-missing',
        detail: `sentences[${i}] is kept but does not appear in answer (in order): ${JSON.stringify(fmt.clip(t, 60))}`,
      });
      continue;
    }
    residue.push(answer.slice(cursor, at));
    cursor = at + t.length;
  }
  residue.push(answer.slice(cursor));
  const extra = residue.join(' ').replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (extra) {
    faults.push({
      kind: 'answer-extra',
      detail: `answer holds text no kept sentence accounts for: ${JSON.stringify(fmt.clip(extra, 70))}`,
    });
  }
  for (const [i, d] of (result.dropped ?? []).entries()) {
    const t = norm(d ?? '');
    if (t && /[A-Za-z0-9]/.test(t) && answer.includes(t)) {
      faults.push({
        kind: 'dropped-present',
        detail: `dropped[${i}] is still in answer: ${JSON.stringify(fmt.clip(t, 60))}`,
      });
    }
  }
  return faults;
}

// -------------------------------------------------------- gate (b): gold coverage

export interface Coverage {
  /** At least one `expectSessions` id appears in the evidence. */
  sessions: boolean;
  /** At least one `expectPhrases` regex matches `result.answer`. */
  phrase: boolean;
  /** `plans/06`'s rule: both. */
  covered: boolean;
  /** Non-gating: every expected session cited, which is what a multi-session row really wants. */
  allSessions: boolean;
  /** Non-gating: how many `[session, seq]` pairs the evidence actually landed on. */
  seqsHit: number;
  seqsWanted: number;
  /** Which phrase matched, for the reader. */
  matched: string | null;
}

export function checkCoverage(result: AskResult, gold: AskGold): Coverage {
  const cited = new Set((result.evidence ?? []).map((e: AskEvidence) => e.sessionId));
  const hit = gold.expectSessions.filter((id) => cited.has(id));
  const answer = result.answer ?? '';
  let matched: string | null = null;
  for (const p of gold.expectPhrases) {
    if (new RegExp(p, 'i').test(answer)) {
      matched = p;
      break;
    }
  }
  const pairs = new Set((result.evidence ?? []).map((e: AskEvidence) => `${e.sessionId}@${e.seq}`));
  const seqsHit = gold.expectSeqs.filter(([id, seq]) => pairs.has(`${id}@${seq}`)).length;
  return {
    sessions: hit.length > 0,
    phrase: matched !== null,
    covered: hit.length > 0 && matched !== null,
    allSessions: hit.length === gold.expectSessions.length,
    seqsHit,
    seqsWanted: gold.expectSeqs.length,
    matched,
  };
}

// -------------------------------------------------------- gate (c): the refusals

export interface DecoyOutcome {
  /** The library said so. */
  refused: boolean;
  /** `potsherd ask … --strict` exited with this. */
  cliExit: number;
  /** How the CLI was invoked, or why it was not. */
  cliHow: string;
  /** Both halves. */
  pass: boolean;
  /** How much it emitted anyway — 0 is the only comfortable number here. */
  evidence: number;
}

export function checkDecoy(result: AskResult, cliExit: number, cliHow: string): DecoyOutcome {
  const refused = result.refused === true;
  return {
    refused,
    cliExit,
    cliHow,
    pass: refused && cliExit === STRICT_EXIT,
    evidence: (result.evidence ?? []).length,
  };
}

// ------------------------------------------------------------ the overlap check
//
// Lifted from `evals/run.ts` so the two sets are measured by one definition. The stopword list
// is the same list; changing it here and not there would make the two numbers incomparable.

const STOPWORDS = new Set(
  ('a an the and or but if then than that this those these it its it is was were be been being do does did done ' +
    'of to in on at by for from with without into over under about after before again as so such not no nor ' +
    'we us our you your they them their he she his her i me my one two some any all most more much many ' +
    'what which who whom when where why how did do had has have can could would should will shall may might ' +
    'there here up down out off just only same other another still even ever never always got get gets ' +
    'was were are am been being what was there')
    .split(/\s+/)
    .filter(Boolean),
);

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const contentWords = (s: string): string[] => [...new Set(words(s).filter((w) => !STOPWORDS.has(w)))];

export interface OverlapRow {
  id: string;
  question: string;
  /** Against the answer sessions' exchange bodies, titles and ghost prompts. */
  text: number;
  /** Against their cards, when they have one. */
  card: number;
  /** What `ask.jsonl` records. */
  recorded: number;
  measured: number;
  shared: string[];
  flagged: boolean;
  /** The file's number disagrees with the measured one. A hard failure. */
  dishonest: boolean;
}

/** Everything the index physically holds for one session id — exact, not by prefix. */
function sessionText(db: Db, id: string): { body: string; card: string } {
  const parts: string[] = [];
  for (const r of db
    .prepare('SELECT user_text, assistant_text FROM exchanges WHERE session_id = ?')
    .all(id) as { user_text: string | null; assistant_text: string | null }[]) {
    parts.push(r.user_text ?? '', r.assistant_text ?? '');
  }
  for (const r of db.prepare('SELECT title FROM sessions WHERE id = ?').all(id) as { title: string | null }[]) {
    if (r.title) parts.push(r.title);
  }
  for (const r of db.prepare('SELECT text FROM ghost_prompts WHERE session_id = ?').all(id) as { text: string }[]) {
    parts.push(r.text);
  }
  for (const r of db
    .prepare('SELECT first_prompt, title FROM ghosts WHERE session_id = ?')
    .all(id) as { first_prompt: string | null; title: string | null }[]) {
    if (r.first_prompt) parts.push(r.first_prompt);
    if (r.title) parts.push(r.title);
  }
  const cards = db
    .prepare('SELECT title, summary, topics, decisions, open_threads, suggested_tags FROM cards WHERE session_id = ?')
    .all(id) as Record<string, string>[];
  return {
    body: parts.join(' '),
    card: cards
      .map((c) => [c['title'], c['summary'], c['topics'], c['decisions'], c['open_threads'], c['suggested_tags']].join(' '))
      .join(' '),
  };
}

export function overlaps(db: Db, gold: AskGold[], threshold: number): OverlapRow[] {
  return gold.map((g) => {
    const bodies: string[] = [];
    const cards: string[] = [];
    for (const id of g.expectSessions) {
      const { body, card } = sessionText(db, id);
      bodies.push(body);
      cards.push(card);
    }
    const qw = contentWords(g.question);
    const bw = new Set(words(bodies.join(' ')));
    const cw = new Set(words(cards.join(' ')));
    const st = qw.filter((w) => bw.has(w));
    const sc = qw.filter((w) => cw.has(w));
    const text = qw.length ? st.length / qw.length : 0;
    const card = qw.length ? sc.length / qw.length : 0;
    const measured = Math.max(text, card);
    return {
      id: g.id,
      question: g.question,
      text,
      card,
      recorded: g.overlap,
      measured,
      shared: [...new Set([...st, ...sc])],
      flagged: measured > threshold,
      dishonest: Math.abs(measured - g.overlap) > OVERLAP_TOLERANCE,
    };
  });
}

export interface DecoyLeak {
  id: string;
  best: number;
  where: string;
  shared: string[];
  leaked: boolean;
}

/** Is any single session close enough to a decoy that the decoy is no longer unanswerable? */
export function decoyLeaks(db: Db, decoys: AskDecoy[]): DecoyLeak[] {
  const ids = [
    ...(db.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((r) => r.id),
    ...(db.prepare('SELECT session_id FROM ghosts').all() as { session_id: string }[]).map((r) => r.session_id),
  ];
  const bags = new Map<string, Set<string>>();
  for (const id of ids) {
    const { body, card } = sessionText(db, id);
    bags.set(id, new Set(words(`${body} ${card}`)));
  }
  return decoys.map((d) => {
    const qw = contentWords(d.question);
    let best = 0;
    let where = '';
    let shared: string[] = [];
    for (const [id, bag] of bags) {
      const sh = qw.filter((w) => bag.has(w));
      const cov = qw.length ? sh.length / qw.length : 0;
      if (cov > best) {
        best = cov;
        where = id;
        shared = sh;
      }
    }
    return { id: d.id, best, where, shared, leaked: best >= DECOY_LEAK };
  });
}

// ------------------------------------------------------------------- the verdict

export interface GoldRow {
  gold: AskGold;
  result: AskResult;
  faults: Fault[];
  coverage: Coverage;
  ms: number;
}

export interface DecoyRow {
  decoy: AskDecoy;
  result: AskResult;
  faults: Fault[];
  outcome: DecoyOutcome;
  ms: number;
}

export interface Verdict {
  /** (a) faults across every result, gold and decoy alike. 100% or the build fails. */
  citations: { lines: number; faults: number; rate: number; pass: boolean };
  /** (b) */
  coverage: { covered: number; total: number; rate: number; pass: boolean };
  /** (c) */
  decoys: { refused: number; total: number; rate: number; pass: boolean };
  /** The set's own integrity: recorded overlap matches measured, decoys still unanswerable. */
  set: { overlapHonest: boolean; decoysSound: boolean; pass: boolean };
  pass: boolean;
}

export function verdictFor(
  golds: GoldRow[],
  decoys: DecoyRow[],
  overlap: OverlapRow[],
  leaks: DecoyLeak[],
): Verdict {
  const all = [...golds, ...decoys];
  const lines = all.reduce((n, r) => n + (r.result.evidence?.length ?? 0), 0);
  const faults = all.reduce((n, r) => n + r.faults.length, 0);
  // `lines > 0` is the whole of B4, and it is not a formality.
  //
  // Gate (a) is the one `plans/06` says must be 100% or the build fails, and
  // with no floor on evidence it read
  //
  //     gate (a) citations: {"lines":0,"faults":0,"rate":1,"pass":true}
  //     gate (b) coverage : {"covered":0,"total":10,"rate":0,"pass":false}
  //
  // — a perfect score on nothing. A run that emitted no evidence at all cannot
  // have a citation fault, so "no faults" and "no citations" produced the same
  // number, and the strongest gate in the suite was the one most easily
  // satisfied. Gate (b) happened to catch that case, which made this
  // unexploitable rather than harmless: a gate that reports 100% on zero
  // evidence is a number that means nothing, and `plans/08` rule 1 is about
  // exactly that. A gate can only pass on evidence it actually checked.
  const citations = {
    lines,
    faults,
    rate: lines > 0 && faults === 0 ? 1 : 0,
    pass: lines > 0 && faults === 0,
  };
  const covered = golds.filter((g) => g.coverage.covered).length;
  const cov = {
    covered,
    total: golds.length,
    rate: golds.length ? covered / golds.length : 0,
    pass: golds.length > 0 && covered / golds.length >= GATE_COVERAGE,
  };
  const refused = decoys.filter((d) => d.outcome.pass).length;
  const dec = {
    refused,
    total: decoys.length,
    rate: decoys.length ? refused / decoys.length : 0,
    pass: decoys.length > 0 && refused / decoys.length >= GATE_DECOYS,
  };
  const overlapHonest = overlap.every((r) => !r.dishonest);
  const decoysSound = leaks.every((l) => !l.leaked);
  const set = { overlapHonest, decoysSound, pass: overlapHonest && decoysSound };
  return { citations, coverage: cov, decoys: dec, set, pass: citations.pass && cov.pass && dec.pass && set.pass };
}

// ------------------------------------------------------------------ the fixture
//
// Built exactly the way `evals/run.ts` builds it, for the same reason: the eval must measure
// today's indexer, not a committed `.db` from whenever somebody last remembered to refresh it.

interface Built {
  root: string;
  vectors: number;
  embedded: number;
  embedMs: number;
  cards: number;
  reason?: string;
  cleanup: () => void;
}

interface FixtureCard {
  session_id: string;
  harness: string;
  project: string;
  project_slug: string;
  source: string;
  title: string;
  summary: string;
  topics: string[];
  decisions: { what: string; why: string | null; evidence_seq: number[] }[];
  files: string[];
  outcome: string;
  open_threads: { what: string; evidence_seq: number[] }[];
  tags: string[];
}

function findModelCache(): { dir: string; found: boolean } {
  const override = process.env['POTSHERD_MODELS_DIR'];
  const candidates = override
    ? [override]
    : [paths.modelsDir(), path.join(os.tmpdir(), 'potsherd-test-models')];
  for (const dir of candidates) {
    if (embeddings.isModelCached(dir)) return { dir, found: true };
  }
  return { dir: override ?? paths.modelsDir(), found: false };
}

/**
 * The cards are not optional here.
 *
 * Two of the ten questions (g06, g07) are `card` shaped: the exchange text does not contain the
 * words a user would ask with, and only the card does. An index without cards scores those two
 * against something that cannot answer them, so a missing `cards.jsonl` is an error rather than
 * a zero.
 */
async function injectCards(db: Db, root: string, modelDir: string | null): Promise<number> {
  const file = path.join(here, 'fixture', 'cards.jsonl');
  if (!fs.existsSync(file)) {
    throw new Error(`no fixture cards at ${file} — g06 and g07 are card-shaped and cannot be scored without them`);
  }
  const cards = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as FixtureCard);
  for (const c of cards) {
    const card = {
      title: c.title,
      summary: c.summary,
      topics: c.topics,
      decisions: c.decisions,
      files: c.files,
      outcome: c.outcome as never,
      open_threads: c.open_threads,
      tags: c.tags,
    };
    const embedding = modelDir
      ? await embeddings.generateEmbedding(cardEmbeddingText(card), { cacheDir: modelDir })
      : undefined;
    writeCard(
      db,
      root,
      {
        sessionId: c.session_id,
        harness: c.harness as never,
        projectSlug: c.project_slug,
        project: c.project,
        card,
        verified: { kept: c.decisions.length + c.open_threads.length, dropped: 0 },
        model: 'fixture',
        costUsd: 0,
        createdAt: '2026-08-05T00:00:00.000Z',
        source: c.source,
      },
      embedding,
    );
  }
  return cards.length;
}

async function buildFixtureIndex(keep: boolean, embed: boolean): Promise<Built> {
  const claudeDir = path.join(here, 'fixture', 'claude');
  if (!fs.existsSync(claudeDir)) throw new Error(`no fixture corpus at ${claudeDir}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-ask-evals-'));
  const cleanup = (): void => {
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  };

  let reason: string | undefined;
  let modelDir: string | null = null;
  if (embed) {
    const cache = findModelCache();
    if (cache.found) {
      fs.symlinkSync(cache.dir, path.join(root, 'models'));
      modelDir = path.join(root, 'models');
    } else if (process.env['POTSHERD_EVALS_EMBED'] === '1') {
      fs.mkdirSync(cache.dir, { recursive: true });
      fs.symlinkSync(cache.dir, path.join(root, 'models'));
      modelDir = path.join(root, 'models');
    } else {
      embed = false;
      reason =
        'no embedding model on disk — set POTSHERD_EVALS_EMBED=1 to fetch 34 MB, or POTSHERD_MODELS_DIR to point at one';
    }
  }

  await rescue({ claudeDir, root, ghostsOnly: true, quiet: true });
  const report = await indexAll({ root, claudeDir, harnesses: ['claude'], embed, full: true });

  const db = store.open({ root });
  const state = vectorState(db, root);
  const vectors = state.vectors ?? 0;
  const cards = await injectCards(db, root, embed && vectors > 0 ? modelDir : null);
  db.close();

  if (embed && vectors === 0 && !reason) {
    reason = report.embeddings.reason ?? state.reason ?? 'the index came back with no vectors';
  }
  return {
    root,
    vectors,
    embedded: report.embeddings.embedded,
    embedMs: report.embeddings.ms,
    cards,
    ...(reason ? { reason } : {}),
    cleanup,
  };
}

/** The index's answer to "does this citation exist, and what does it say". */
function dbCorpus(db: Db): Corpus {
  const ex = db.prepare('SELECT user_text, assistant_text FROM exchanges WHERE session_id = ? AND seq = ?');
  const gp = db.prepare('SELECT text FROM ghost_prompts WHERE session_id = ? AND seq = ?');
  const cache = new Map<string, string | null>();
  return {
    text(sessionId: string, seq: number): string | null {
      const key = `${sessionId}@${seq}`;
      if (cache.has(key)) return cache.get(key) ?? null;
      let out: string | null = null;
      const e = ex.get(sessionId, seq) as { user_text: string | null; assistant_text: string | null } | undefined;
      if (e) out = `${e.user_text ?? ''}\n${e.assistant_text ?? ''}`;
      else {
        const g = gp.get(sessionId, seq) as { text: string } | undefined;
        if (g) out = g.text;
      }
      cache.set(key, out);
      return out;
    },
  };
}

// ------------------------------------------------------------------- the cli path
//
// Gate (c) has two halves and this is the one that cannot be satisfied by a library flag. There
// is no switch to turn it off: a build where `potsherd ask --strict` does not exit 2 has not met
// `plans/phases/phase-4` deliverable 1, and saying so is the point of the harness.

function runCliStrict(question: string, root: string, k: number): { exit: number; how: string } {
  const src = path.join(here, '..', 'packages', 'cli', 'src', 'index.ts');
  const tsx = path.join(here, '..', 'node_modules', '.bin', 'tsx');
  const dist = path.join(here, '..', 'packages', 'cli', 'bin', 'potsherd.js');
  const args = ['ask', question, '--strict', '--json', '--k', String(k), '--potsherd-dir', root];

  const attempts: { cmd: string; argv: string[]; how: string }[] = [];
  if (fs.existsSync(tsx) && fs.existsSync(src)) {
    attempts.push({ cmd: tsx, argv: [src, ...args], how: 'tsx packages/cli/src/index.ts' });
  }
  if (fs.existsSync(dist)) {
    attempts.push({ cmd: process.execPath, argv: [dist, ...args], how: 'node packages/cli/bin/potsherd.js' });
  }
  if (attempts.length === 0) return { exit: -1, how: 'no cli entry point found' };

  const a = attempts[0]!;
  const r = spawnSync(a.cmd, a.argv, { encoding: 'utf8', timeout: 300_000 });
  if (r.error) return { exit: -1, how: `${a.how} — ${r.error.message}` };
  return { exit: r.status ?? -1, how: a.how };
}

// ------------------------------------------------------------------------ main

interface Options {
  set: string;
  potsherdDir: string | null;
  k: number;
  overlap: number;
  only: string | null;
  json: boolean;
  keep: boolean;
}

const HELP = `
potsherd ask evals — citations, gold coverage and refusals, per plans/06

  tsx evals/ask-run.ts                             the committed set on the fixture corpus
  tsx evals/ask-run.ts --keep                      keep the index and print its path
  tsx evals/ask-run.ts --only g03                  one case, for debugging
  tsx evals/ask-run.ts --json

  --set <file>          ask.jsonl (default: evals/ask.jsonl)
  --potsherd-dir <dir>  score against this index instead of building one from the fixture
  --k <n>               sessions ask may read (default 6, per plans/phases/phase-4)
  --overlap <0..1>      flag a question sharing more than this fraction of its content words
                        with its own answer (default ${OVERLAP_FLAG})
  --only <id>           run one case
  --keep                do not delete the temporary fixture index, and print it
  --json                machine-readable

The gates, verbatim from plans/06:
  (a) every emitted claim has a citation that exists and says what the claim says — 100%
  (b) gold coverage >= 7/10
  (c) --strict on an unanswerable question returns the refusal, not a guess (3 decoys)

(c) is checked twice: refused === true from the library, and exit code ${STRICT_EXIT} from
\`potsherd ask --strict\`. There is no flag to skip the second half.
`;

function parseArgs(argv: string[]): Options {
  const o: Options = {
    set: path.join(here, 'ask.jsonl'),
    potsherdDir: null,
    k: 6,
    overlap: OVERLAP_FLAG,
    only: null,
    json: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') o.set = String(argv[++i]);
    else if (a === '--potsherd-dir') o.potsherdDir = String(argv[++i]);
    else if (a === '--k') o.k = Number(argv[++i]);
    else if (a === '--overlap') o.overlap = Number(argv[++i]);
    else if (a === '--only') o.only = String(argv[++i]);
    else if (a === '--json') o.json = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    }
  }
  return o;
}

const INDENT = '  ';
const pct2 = (n: number): string => `${Math.round(n * 100)}%`;
const mark = (t: Theme, ok: boolean, label: string): string => (ok ? t.ok(`✓ ${label}`) : t.warn(`✗ ${label}`));

/**
 * The anti-gaming half of the instrument, rendered.
 *
 * It answers one question about the *set*, every run, and it answers it whether or not `ask`
 * exists: could these questions have been answered by quoting, and are the decoys still
 * unanswerable? Nothing else here can see that — a question that is a substring of its answer
 * scores 10/10 and looks like a triumph.
 */
function setReport(
  overlap: OverlapRow[],
  leaks: DecoyLeak[],
  threshold: number,
  root: string,
  built: Built | null,
): string {
  const t = new Theme({ width: 100 });
  const out: string[] = [];
  const rows = [
    ['', 'text', 'card', 'max', 'in file', ''],
    ...overlap.map((r) => [
      r.id,
      pct2(r.text),
      pct2(r.card),
      r.flagged ? t.warn(pct2(r.measured)) : pct2(r.measured),
      r.dishonest ? t.warn(r.recorded.toFixed(2)) : t.dim(r.recorded.toFixed(2)),
      t.dim(r.shared.join(' ')),
    ]),
  ];
  out.push(...table(t, rows, { gap: 2, grow: rows[0]!.length - 1, align: ['left', 'right', 'right', 'right', 'right', 'left'] }));
  out.push('');

  const sorted = overlap.map((r) => r.measured).sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
    : 0;
  out.push(
    INDENT +
      t.dim(
        `word overlap with the answer ${t.sep} min ${pct2(sorted[0] ?? 0)} ${t.sep} median ${pct2(median)} ` +
          `${t.sep} max ${pct2(sorted[sorted.length - 1] ?? 0)} ${t.sep} flag above ${pct2(threshold)}`,
      ),
  );
  const flagged = overlap.filter((r) => r.flagged);
  if (flagged.length === 0) {
    out.push(INDENT + t.ok('none flagged') + t.dim(' — no question is a quotation of its own answer'));
  } else {
    for (const r of flagged) {
      out.push(
        INDENT + t.warn(`${pct2(r.measured)} ${r.id}`) + t.dim(`  shares: ${r.shared.join(' ')} — its note must defend this`),
      );
    }
  }
  for (const r of overlap.filter((r) => r.dishonest)) {
    out.push(
      INDENT +
        t.warn(`${r.id} records overlap ${r.recorded.toFixed(2)} and measures ${r.measured.toFixed(2)}`) +
        t.dim(' — fix ask.jsonl, not this check'),
    );
  }
  out.push('');

  out.push(
    INDENT +
      t.dim(`decoys ${t.sep} the closest single session to each, over ${leaks.length ? 'the whole corpus' : 'nothing'}`),
  );
  for (const l of leaks) {
    out.push(
      INDENT +
        (l.leaked ? t.warn(`${l.id} is no longer unanswerable`) : `${l.id}  ${pct2(l.best)}`) +
        t.dim(`  nearest ${l.where || '—'}${l.shared.length ? `  shares: ${l.shared.join(' ')}` : ''}`),
    );
  }
  out.push('');

  if (built?.reason) {
    out.push(INDENT + t.warn('no vectors in the index') + t.dim(` ${t.sep} ${fmt.clip(built.reason, 70)}`));
    out.push(
      INDENT + t.dim('  g03, g04 and g09 share almost no content words with their answers and need the vector half'),
    );
    out.push('');
  } else if (built) {
    out.push(
      INDENT +
        t.dim(
          `index ${t.sep} ${fmt.num(built.embedded)} exchanges embedded in ${fmt.duration(built.embedMs)} ` +
            `${t.sep} ${fmt.num(built.vectors)} vectors ${t.sep} ${fmt.num(built.cards)} cards`,
        ),
    );
    out.push('');
  }
  if (!built) out.push(INDENT + t.dim(`index ${t.sep} ${root}`) + '\n');
  return out.join('\n') + '\n';
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const cases = readSet(o.set).filter((c) => (o.only ? c.id === o.only : true));
  const golds = cases.filter((c): c is AskGold => !isDecoy(c));
  const decoyCases = cases.filter(isDecoy);

  const built = o.potsherdDir ? null : await buildFixtureIndex(o.keep, true);
  const root = o.potsherdDir ?? built!.root;

  const goldRows: GoldRow[] = [];
  const decoyRows: DecoyRow[] = [];
  let overlap: OverlapRow[] = [];
  let leaks: DecoyLeak[] = [];

  const db = store.open({ root });
  try {
    // The set's own integrity is measured first, against the index, and does not depend on
    // `ask` existing. On the branch this file was written on it is the only half that can run,
    // and it is the half that catches a set gamed into passing — so it runs before anything
    // that needs T4.1's module, and its numbers are printed either way.
    overlap = overlaps(db, golds, o.overlap);
    leaks = decoyLeaks(db, decoyCases);

    // The one dynamic import in the file. It is dynamic so that `evals/ask-selftest.ts` — which
    // proves this scorer with hand-built results — can import everything above without needing
    // T4.1's module to exist yet.
    let ask: (db: Db, question: string, opts?: AskOptions) => Promise<AskResult>;
    try {
      ({ ask } = await import('../packages/core/src/ask.js'));
    } catch (err) {
      process.stdout.write(setReport(overlap, leaks, o.overlap, root, built));
      if (o.keep) process.stdout.write(`${INDENT}index kept at ${root}\n`);
      process.stderr.write(
        `ask evals: cannot load packages/core/src/ask.ts — ${(err as Error).message}\n` +
          `  T4.1 owns that file; until it lands there is nothing to score and no gate can pass.\n` +
          `  The scorer itself is provable without it: tsx evals/ask-selftest.ts\n`,
      );
      process.exitCode = 1;
      return;
    }

    const corpus = dbCorpus(db);
    for (const g of golds) {
      const t0 = Date.now();
      const result = await ask(db, g.question, { k: o.k, root, strict: false });
      const ms = Date.now() - t0;
      goldRows.push({ gold: g, result, faults: checkCitations(result, corpus), coverage: checkCoverage(result, g), ms });
    }
    for (const d of decoyCases) {
      const t0 = Date.now();
      const result = await ask(db, d.question, { k: o.k, root, strict: true });
      const ms = Date.now() - t0;
      const cli = runCliStrict(d.question, root, o.k);
      decoyRows.push({
        decoy: d,
        result,
        faults: checkCitations(result, corpus),
        outcome: checkDecoy(result, cli.exit, cli.how),
        ms,
      });
    }
  } finally {
    db.close();
    built?.cleanup();
  }

  const v = verdictFor(goldRows, decoyRows, overlap, leaks);

  if (o.json) {
    process.stdout.write(
      JSON.stringify(
        {
          set: o.set,
          root: o.keep || o.potsherdDir ? root : null,
          k: o.k,
          gates: {
            citationBar: GATE_CITATIONS,
            coverageBar: GATE_COVERAGE,
            decoyBar: GATE_DECOYS,
            strictExit: STRICT_EXIT,
          },
          verdict: v,
          pass: v.pass,
          index: built
            ? { vectors: built.vectors, embedded: built.embedded, embedMs: built.embedMs, cards: built.cards, skipped: built.reason ?? null }
            : null,
          gold: goldRows.map((r) => ({
            id: r.gold.id,
            question: r.gold.question,
            covered: r.coverage.covered,
            sessions: r.coverage.sessions,
            phrase: r.coverage.phrase,
            matched: r.coverage.matched,
            allSessions: r.coverage.allSessions,
            seqs: `${r.coverage.seqsHit}/${r.coverage.seqsWanted}`,
            faults: r.faults,
            evidence: (r.result.evidence ?? []).map((e: AskEvidence) => ({ index: e.index, sessionId: e.sessionId, seq: e.seq, quote: e.quote })),
            answer: r.result.answer,
            dropped: r.result.dropped,
            refused: r.result.refused,
            searched: r.result.searched,
            matching: r.result.matching,
            spend: r.result.spend,
            estimated: r.result.estimated,
            ms: r.ms,
          })),
          decoys: decoyRows.map((r) => ({
            id: r.decoy.id,
            question: r.decoy.question,
            refused: r.outcome.refused,
            cliExit: r.outcome.cliExit,
            cliHow: r.outcome.cliHow,
            pass: r.outcome.pass,
            evidence: r.outcome.evidence,
            faults: r.faults,
            answer: r.result.answer,
            ms: r.ms,
          })),
          overlap: {
            threshold: o.overlap,
            tolerance: OVERLAP_TOLERANCE,
            rows: overlap.map((r) => ({
              id: r.id,
              text: Number(r.text.toFixed(3)),
              card: Number(r.card.toFixed(3)),
              measured: Number(r.measured.toFixed(3)),
              recorded: r.recorded,
              shared: r.shared,
              flagged: r.flagged,
              dishonest: r.dishonest,
            })),
          },
          decoyLeaks: leaks.map((l) => ({ id: l.id, best: Number(l.best.toFixed(3)), where: l.where, shared: l.shared, leaked: l.leaked })),
        },
        null,
        2,
      ) + '\n',
    );
    process.exitCode = v.pass ? 0 : 1;
    return;
  }

  const t = new Theme({ width: 100 });
  const out: string[] = [];
  out.push(
    t.dim(
      `potsherd ask evals ${t.sep} ${path.basename(o.set)} ${t.sep} ${goldRows.length} gold ${t.sep} ` +
        `${decoyRows.length} decoys ${t.sep} k=${o.k} ${t.sep} ` +
        (built ? `${fmt.num(built.cards)} cards, ${fmt.num(built.vectors)} vectors` : 'existing index'),
    ),
  );
  out.push('');

  // One row per gold question. `cites` is gate (a) for that row, `sess`/`phrase` are the two
  // halves of gate (b), and `all`/`seqs` are the non-gating numbers that say whether the reader
  // landed on the right exchange or only in the right neighbourhood.
  const header = ['', 'cites', 'sess', 'phrase', 'all', 'seqs', 'ev', 'ms', ''];
  const rows = goldRows.map((r) => [
    r.gold.id,
    r.faults.length === 0 ? t.ok('ok') : t.warn(`${r.faults.length}`),
    mark(t, r.coverage.sessions, ''),
    mark(t, r.coverage.phrase, ''),
    r.coverage.allSessions ? t.ok('✓') : t.dim('·'),
    `${r.coverage.seqsHit}/${r.coverage.seqsWanted}`,
    String(r.result.evidence?.length ?? 0),
    String(r.ms),
    fmt.elide(r.gold.question, 44),
  ]);
  out.push(
    ...table(t, [header, ...rows], {
      gap: 2,
      grow: header.length - 1,
      align: ['left', 'right', 'left', 'left', 'left', 'right', 'right', 'right', 'left'],
    }),
  );
  out.push('');

  for (const r of goldRows) {
    for (const f of r.faults) out.push(INDENT + t.warn(`${r.gold.id} ${f.kind}`) + t.dim(` ${f.detail}`));
  }

  // ------------------------------------------------------------------ the decoys
  out.push(INDENT + t.dim(`--strict on a question the corpus cannot answer ${t.sep} refusal, not a guess`));
  for (const r of decoyRows) {
    out.push(
      INDENT +
        `${r.decoy.id}  ` +
        mark(t, r.outcome.refused, 'refused') +
        '  ' +
        mark(t, r.outcome.cliExit === STRICT_EXIT, `cli exit ${r.outcome.cliExit === -1 ? '—' : r.outcome.cliExit}`) +
        t.dim(`  ${r.outcome.evidence} evidence  ${t.sep} ${fmt.elide(r.decoy.question, 40)}`),
    );
    if (r.outcome.cliExit !== STRICT_EXIT) out.push(INDENT + '    ' + t.dim(`via ${r.outcome.cliHow}`));
    for (const f of r.faults) out.push(INDENT + '    ' + t.warn(f.kind) + t.dim(` ${f.detail}`));
  }
  out.push('');

  // ----------------------------------------------------------------- the overlap
  out.push(setReport(overlap, leaks, o.overlap, root, built).trimEnd());
  out.push('');

  // ------------------------------------------------------------------ the gates
  out.push(INDENT + t.dim(`plans/06 §ask evals ${t.sep} the three gates`));
  // Not `lines - faults`: a fault is not always one line's fault (an `answer-extra` belongs to
  // the answer, not to any citation), and one line can carry two. The honest pair of numbers is
  // how many evidence lines were emitted and how many faults were found across all of it.
  out.push(
    INDENT +
      `(a) citations   ${String(v.citations.lines).padStart(3)} lines ` +
      mark(t, v.citations.pass, `${v.citations.faults} faults, 100% clean required`),
  );
  out.push(
    INDENT +
      `(b) coverage    ${String(v.coverage.covered).padStart(3)}/${String(v.coverage.total).padEnd(3)} ` +
      mark(t, v.coverage.pass, `>= ${Math.ceil(GATE_COVERAGE * v.coverage.total)}/${v.coverage.total}`),
  );
  out.push(
    INDENT +
      `(c) refusals    ${String(v.decoys.refused).padStart(3)}/${String(v.decoys.total).padEnd(3)} ` +
      mark(t, v.decoys.pass, `refused === true and cli exit ${STRICT_EXIT}`),
  );
  out.push(
    INDENT +
      `    the set                 ` +
      mark(t, v.set.overlapHonest, 'overlap as recorded') +
      '  ' +
      mark(t, v.set.decoysSound, 'decoys still unanswerable'),
  );
  out.push(
    INDENT +
      (v.pass
        ? t.ok('PASS') + t.dim(' — plans/06 phase 4 would accept this ask')
        : t.warn('FAIL') + t.dim(' — plans/06 phase 4 would not accept this ask')),
  );
  if (o.keep && built) out.push(INDENT + t.dim(`index kept at ${built.root}`));
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = v.pass ? 0 : 1;
}

// `import.meta.url` guard: the selftest imports this module for its scorer and must not run the
// eval as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`ask evals: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
