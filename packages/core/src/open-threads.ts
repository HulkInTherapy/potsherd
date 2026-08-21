/**
 * T4.2 — open threads: "decided in A, never seen in B".
 *
 * This file's **types are pinned by the orchestrator before the phase-4 wave**
 * so that `ask.ts` (T4.1) and this module (T4.2) can be written in parallel
 * worktrees against one contract. T4.2 owns every implementation in here; T4.1
 * imports the types and calls `openThreadCandidates` / `confirmOpenThreads`
 * and owns none of it.
 *
 * The output is **advisory and labelled**, never stated as fact
 * (`plans/phases/phase-4-ask-and-graft.md` T4.2).
 *
 * ## Why this file is written defensively
 *
 * `05-SHAREABLE-EXPERIENCE.md` §4 calls the open-thread line *"the moment
 * people quote"*. It is also the easiest place in the whole product to print
 * something confidently wrong, because the claim is about an **absence** and
 * an absence cannot be cited. Every other synthesized claim potsherd makes
 * points at an exchange a reader can open; this one points at a hole.
 *
 * Three consequences run through everything below:
 *
 *   1. **The positive half is cited even though the negative half cannot be.**
 *      A candidate is only ever raised from a decision whose `evidence_seq`
 *      resolves to an exchange that exists in session A. The reader can always
 *      check *"was this decided"*; they are told *"we did not find it in B"*
 *      and nothing stronger.
 *   2. **Ghost cards can only ever withdraw a candidate, never raise one.**
 *      See {@link openThreadCandidates}.
 *   3. **The model never contributes a fact.** It returns `confirmed` and one
 *      sentence; every other field on an {@link OpenThread} is the rule pass's
 *      own, verbatim. A model that confirms something the card cannot support
 *      is overruled in code, not in the prompt.
 */
import { idTag } from './recall.js';
import type { Db } from './db.js';
import { ASK_MODEL, Llm, detectBackend, type Budget, type Llm as LlmType } from './llm.js';

/** `05`: the phrase the renderer must use. Never "open thread" as a bare fact. */
export const OPEN_THREAD_LABEL = 'possible open thread';

/** A decision in session A whose topics/files overlap a *different* project's sessions,
 *  where no matching decision appears. Produced by the rule pass, with no model call. */
export interface OpenThreadCandidate {
  /** the decision's `what`, verbatim from the card */
  what: string;
  /** the decision's `why`, verbatim from the card, or '' */
  why: string;
  /** where it was decided */
  sessionId: string;
  id8: string;
  project: string;
  ts: string;
  /** the card seq the decision cited, so the claim stays checkable */
  evidenceSeq: number | null;
  /** the project it was never seen in */
  otherProject: string;
  /** that project's sessions that share the files/topics */
  otherSessionIds: readonly string[];
  overlap: { files: readonly string[]; topics: readonly string[] };
  /** higher = more overlap and less counter-evidence; the rule pass's own ordering */
  score: number;
}

/** A candidate after the model pass. `confirmed:false` candidates are dropped by the caller. */
export interface OpenThread extends OpenThreadCandidate {
  confirmed: boolean;
  /** one sentence from the model saying why it confirmed or rejected */
  note: string;
}

export interface CandidateOptions {
  /** how many candidates to return, best-scoring first. Default 8. */
  limit?: number;
}

export interface ConfirmOptions {
  llm?: LlmType;
  model?: string;
  budget?: Budget;
  signal?: AbortSignal;
}

// ------------------------------------------------------------------ constants

/**
 * The bar for *"project B already mentions this decision"*, as a cosine over
 * content-token sets.
 *
 * **This constant decides whether a candidate is raised at all**, so it was
 * picked the way `cards/verify.ts`'s `EVIDENCE_COSINE` was picked — by
 * measuring a control — and not by taste. The measurement is
 * `evidence-T4.2/RESULTS.md`, and it did not come out the way the first draft
 * of this comment assumed.
 *
 * **194 (decision in A, project B) pairs** were generated from the reference
 * corpus with the bar switched off, and the top of the distribution was read
 * by hand against project B's cards *and* B's raw exchanges. **Not one pair
 * was a genuine restatement.** Every high-scoring pair was two different
 * decisions sharing process vocabulary — "launch four-agent wall audit"
 * against "design 8-phase implementation plan with audit as phase 0", which
 * scores 0.3223 and is the corpus maximum. So the measured distribution is
 * *entirely* negative:
 *
 * ```
 *   n = 194 pairs, every one a non-match
 *   median 0.089   p90 0.178   p95 0.202   p99 0.298   max 0.3223
 * ```
 *
 * The bar is therefore set **above the strongest coincidence the corpus
 * produced**, at 0.35. At the previous 0.30 it suppressed exactly one
 * candidate in 194, and that suppression was read and found wrong: a real
 * catch lost to two decisions that happened to share the word "audit".
 *
 * **This bar is a weak guard and the code must not pretend otherwise.** The
 * honest limit of the measurement is that the positive side is *n = 0* — the
 * corpus contains no case of project B genuinely restating A's decision — so
 * nothing here shows the bar catches one when it appears. Worse, synthetic
 * paraphrase pairs (`tests/open-threads.test.ts`) score from 0.20 to 0.57,
 * which **overlaps the measured negative distribution outright**. There is no
 * threshold on this statistic that separates "B said this" from "B used these
 * words", and choosing one differently would not fix that.
 *
 * What follows for the design: the mention check is not what makes this
 * feature safe. {@link MIN_ANCHOR_TOKENS} and the model pass are, and the
 * measured effect of each is in `RESULTS.md`. The bar's job is only to
 * withdraw a candidate when B's own card says something *unmistakably* the
 * same, and 0.35 is where the corpus says "unmistakable" starts.
 *
 * `tests/open-threads.test.ts` asserts this value directly and fails when it
 * moves, because a constant that sat at the wrong value for a day while every
 * test passed at either value is a documented failure of this project
 * (`docs/08-STATE-OF-PLAY.md`).
 *
 * It is a **token** cosine, not an embedding cosine, and that is forced rather
 * than chosen: {@link openThreadCandidates} is pinned synchronous and
 * `cards/vectors.ts`'s `Embedder` is async. An embedding cosine might well
 * separate these distributions where tokens cannot; that is the first thing to
 * try if this ever needs to be better, and it needs the signature to change.
 */
export const MENTION_COSINE = 0.35;

/**
 * The largest token cosine any of the 194 measured pairs reached — and it was
 * a non-match. {@link MENTION_COSINE} sits above it by construction; the test
 * asserts the relationship rather than just the number, so that moving one
 * without the other fails.
 */
export const MEASURED_NONMATCH_MAX = 0.3223;

/**
 * How many distinct content tokens of the decision must appear in project B's
 * cards before B can be said to be *about* this decision at all.
 *
 * Two, and this is the guard the brief names: *"A and B are unrelated projects
 * that happen to share the word `auth`"*. One shared token is a coincidence of
 * vocabulary; the corpus measurement (`token-df.md`) shows the most common
 * card token appears in 34% of all cards, so single-token agreement between
 * two arbitrary cards is the null hypothesis, not evidence.
 */
export const MIN_ANCHOR_TOKENS = 2;

/**
 * How many distinct content tokens two *projects* must share before either can
 * be an open thread about the other — or one exact shared file path, which is
 * worth more than any number of words.
 *
 * This is the project-level version of {@link MIN_ANCHOR_TOKENS}: the decision
 * may be well anchored in B's vocabulary while the two projects have nothing
 * else whatever to do with each other, and "you decided this in your tax
 * spreadsheet and never applied it to your compiler" is noise however well the
 * words line up.
 */
export const MIN_PROJECT_OVERLAP = 3;

/**
 * Above this document frequency across the indexed cards, a token carries no
 * project-distinguishing information and is struck from every comparison.
 *
 * This is plain IDF with a threshold rather than a hand-written list, so it
 * adapts to whatever the user's archive is actually about: on a machine full
 * of TypeScript, `typescript` is a stopword; on a mixed one it is a signal. On
 * the reference corpus it strikes 11 tokens (`token-df.md`).
 */
export const GENERIC_DF = 0.3;

/**
 * Below this many cards, the document-frequency filter is not applied.
 *
 * With four cards in the index, "appears in 30% of cards" means "appears
 * twice", and the filter would delete the corpus's entire vocabulary. Small
 * indexes get {@link STOPWORDS} and the anchor minimums and nothing else.
 */
export const GENERIC_DF_MIN_CARDS = 20;

/** Tokens shorter than this are never content. */
const MIN_TOKEN_CHARS = 3;

/**
 * English function words, plus the handful of dev nouns that are furniture in
 * every card ever written.
 *
 * Deliberately short. The corpus-derived {@link GENERIC_DF} filter is the real
 * instrument; this list exists so that a *small* index — a new user with four
 * carded sessions, and every fixture in `tests/` — is not left comparing
 * "the", "and" and "file".
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'not', 'but', 'was', 'were',
  'are', 'has', 'have', 'had', 'its', 'our', 'their', 'them', 'then', 'than', 'when', 'where',
  'which', 'while', 'you', 'your', 'all', 'any', 'can', 'will', 'would', 'should', 'must',
  'use', 'used', 'using', 'via', 'per', 'out', 'off', 'over', 'under', 'each', 'more', 'most',
  'one', 'two', 'new', 'old', 'same', 'other', 'only', 'also', 'because', 'instead', 'rather',
  // furniture in every card
  'add', 'added', 'fix', 'fixed', 'run', 'ran', 'set', 'get', 'make', 'made', 'keep', 'kept',
  'code', 'file', 'files', 'test', 'tests', 'data', 'value', 'values', 'name', 'names',
  'type', 'types', 'src', 'lib', 'index', 'main', 'util', 'utils', 'config', 'default',
  'error', 'errors', 'line', 'lines', 'text', 'json', 'null', 'true', 'false',
  'session', 'sessions', 'project', 'projects', 'decision', 'decisions', 'thread', 'threads',
]);

/**
 * How many candidates one model call confirms.
 *
 * Twelve. The batch is the point: a real haiku-class call through the agent
 * SDK takes 60–160 s (`llm.ts` `CALL_PROFILES`), so N calls for N candidates
 * would put the open-thread section of `ask` at twenty minutes on a bad day.
 * One call for the whole set puts it at one call.
 *
 * Twelve rather than "all of them" because the batch has to fit and has to be
 * answerable: at ~600 chars a candidate a full batch is ~7 kB of prompt, an
 * order of magnitude under `cards/slice.ts`'s 60 kB chunking threshold, and
 * twelve one-sentence verdicts sit inside the 4,096-token output default.
 * {@link CandidateOptions.limit} defaults to 8, so a default `ask` is always
 * exactly one call; more than twelve chunks into further calls rather than
 * being silently truncated.
 */
export const CONFIRM_BATCH = 12;

/** What a candidate's note says when there was no model to ask. */
export const NO_MODEL_NOTE =
  'no model was available to confirm this, so it is unconfirmed and not shown.';

// ------------------------------------------------------------------ tokens

/** Lowercase content tokens: alphanumeric runs, minus stopwords and short ones. */
export function contentTokens(text: string, generic: ReadonlySet<string> = STOPWORDS): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_CHARS) continue;
    if (STOPWORDS.has(raw) || generic.has(raw)) continue;
    // A bare number is a version, a line count or a port. Never a topic.
    if (!/[a-z]/.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** `src/db/pool.ts` -> `src`, `pool` (`db` and `ts` are below the length floor). */
function pathTokens(p: string, generic: ReadonlySet<string>): string[] {
  return contentTokens(p.replace(/[\\/._-]+/g, ' '), generic);
}

/** A file path as compared across projects: repo-relative, forward slashes, lowercase. */
export function normalisePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

/**
 * `|A ∩ B| / sqrt(|A| · |B|)` over content-token sets — a cosine over binary
 * term vectors, which is what a cosine is when the vectors are memberships.
 */
export function tokenCosine(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) shared += 1;
  return shared / Math.sqrt(a.size * b.size);
}

// ------------------------------------------------------------------ loading

interface Claim {
  what: string;
  why: string;
  seqs: number[];
}

interface LoadedCard {
  sessionId: string;
  project: string;
  ts: string;
  /** True when the card was built from prompts only — no assistant side at all. */
  ghost: boolean;
  topics: string[];
  files: string[];
  decisions: Claim[];
  /**
   * Everything in this card that could count as B having mentioned something,
   * tokenised **once at load**.
   *
   * The inner loop of the rule pass is (sessions × projects × decisions ×
   * every mention in the project), which on the reference corpus is ~10^6
   * comparisons. Re-tokenising the same fifty strings inside it is the
   * difference between `ask` printing open threads in milliseconds and
   * printing them noticeably late.
   */
  mentions: Set<string>[];
  /** topics ∪ file path segments, as a token set. */
  tokens: Set<string>;
  paths: Set<string>;
  /** `contentTokens` of each topic label, for the overlap report. */
  topicTokens: string[][];
}

/** Every card of one project, plus the union of what they are about. */
interface ProjectPool {
  cards: LoadedCard[];
  tokens: Set<string>;
  paths: Set<string>;
}

function parseClaims(raw: string): Claim[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: Claim[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const what = typeof rec['what'] === 'string' ? rec['what'].trim() : '';
    if (!what) continue;
    const why = typeof rec['why'] === 'string' ? rec['why'].trim() : '';
    const seqs = Array.isArray(rec['evidence_seq'])
      ? rec['evidence_seq'].filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
      : [];
    out.push({ what, why, seqs: [...seqs].sort((x, y) => x - y) });
  }
  return out;
}

function parseStrings(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
}

interface CardRow {
  session_id: string;
  topics: string;
  decisions: string;
  files: string;
  open_threads: string;
  summary: string | null;
  source: string;
  project: string | null;
  ts: string | null;
}

const CARDS_SQL = `
  SELECT c.session_id, c.topics, c.decisions, c.files, c.open_threads, c.summary, c.source,
         COALESCE(s.project, g.project)     AS project,
         COALESCE(s.started_at, g.first_ts) AS ts
    FROM cards c
    LEFT JOIN sessions s ON s.id = c.session_id
    LEFT JOIN ghosts   g ON g.session_id = c.session_id
`;

/**
 * Document frequency over the indexed cards, then everything above
 * {@link GENERIC_DF}.
 *
 * Computed from the corpus rather than written down, so the filter is about
 * *this* archive. See {@link GENERIC_DF_MIN_CARDS} for why a small one is left
 * alone.
 */
export function genericTokens(rows: readonly { topics: string; files: string }[]): Set<string> {
  const generic = new Set<string>();
  if (rows.length < GENERIC_DF_MIN_CARDS) return generic;
  const df = new Map<string, number>();
  for (const row of rows) {
    const here = new Set<string>();
    for (const t of parseStrings(row.topics)) for (const tok of contentTokens(t)) here.add(tok);
    for (const f of parseStrings(row.files)) for (const tok of pathTokens(f, new Set())) here.add(tok);
    for (const tok of here) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  for (const [tok, n] of df) if (n / rows.length > GENERIC_DF) generic.add(tok);
  return generic;
}

function loadCards(db: Db): LoadedCard[] {
  const rows = db.prepare(CARDS_SQL).all() as CardRow[];
  const generic = genericTokens(rows);
  const out: LoadedCard[] = [];
  for (const row of rows) {
    const project = (row.project ?? '').trim();
    if (!project) continue;
    const topics = parseStrings(row.topics);
    const files = parseStrings(row.files);
    const decisions = parseClaims(row.decisions);
    const threads = parseClaims(row.open_threads);
    const tokens = new Set<string>();
    for (const t of topics) for (const tok of contentTokens(t, generic)) tokens.add(tok);
    for (const f of files) for (const tok of pathTokens(f, generic)) tokens.add(tok);
    out.push({
      sessionId: row.session_id,
      project,
      ts: row.ts ?? '',
      // `cards/write.ts` stamps `prompts-only` for a ghost; anything else had
      // an assistant side.
      ghost: row.source !== 'transcript',
      topics,
      files,
      decisions,
      // What counts as B having seen it: a decision, or an open thread. An
      // open thread in B saying the same words is B *knowing about* the
      // question, and "never seen in B" is then false.
      mentions: [...decisions.map((d) => d.what), ...threads.map((t) => t.what)].map(
        (m) => new Set(contentTokens(m)),
      ),
      tokens,
      paths: new Set(files.map(normalisePath).filter(Boolean)),
      topicTokens: topics.map((t) => contentTokens(t)),
    });
  }
  return out;
}

/**
 * Are these two project paths the same project?
 *
 * `/Users/zebra/meghbrain` and `/Users/zebra/meghbrain/docs` are one codebase
 * that the harness recorded from two working directories, and reporting a
 * decision as "never applied" to a subdirectory of where it was made is the
 * purest possible false positive. Path containment, not string equality.
 */
export function sameProject(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.replace(/\/+$/, '');
  const y = b.replace(/\/+$/, '');
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// ------------------------------------------------------------------ rule pass

/**
 * Rule pass. No model, no network.
 *
 * `plans/phases/phase-4-ask-and-graft.md` T4.2, read literally: *for the top
 * sessions' cards, compute `(topics ∪ files)` overlap with other projects'
 * cards; candidates where a decision's topic appears in project B's cards
 * without a decision mentioning it*. Six conditions, in the order they are
 * cheapest to fail:
 *
 *   1. **A is a real session card.** A ghost is built from prompts only
 *      (`cards/ghost.ts`), so a "decision" attributed to one is a decision the
 *      user *typed about*, with nothing on the other side saying it happened.
 *      That is too weak to accuse another project of ignoring. Ghosts are
 *      still loaded and still count as counter-evidence in B — see 6 — which
 *      is the asymmetry the whole file turns on: **weak evidence may withdraw
 *      a candidate but may never raise one.** The measurement behind the
 *      choice is in `evidence-T4.2/ghost-rule.md`.
 *   2. **The decision is cited, and the citation resolves.** `evidence_seq`
 *      must contain a seq that exists as an exchange of session A. `00-README`'s
 *      *cited or dropped*: an uncited decision is dropped here rather than
 *      marked, because the negative half of an open thread can never be
 *      cited and a reader who cannot check the positive half is being asked to
 *      take the whole thing on faith. On the reference corpus this costs
 *      nothing — `cards/verify.ts` already drops `no-citation` claims — so the
 *      rule is a guard against a card written by some future degraded path,
 *      not a filter that does work today.
 *   3. **The decision is anchored in A's own card.** The tokens compared are
 *      the decision's words *intersected with* A's `topics ∪ files`, which is
 *      what "a decision's topic" means. A decision whose words appear nowhere
 *      in its own card's topics is not about any topic we can follow.
 *   4. **That anchor appears in project B's cards**, at
 *      {@link MIN_ANCHOR_TOKENS} distinct tokens or more.
 *   5. **A and B are related projects**, at {@link MIN_PROJECT_OVERLAP}
 *      distinct shared tokens, or one shared file path.
 *   6. **No card in B mentions it**, at {@link MENTION_COSINE} or above,
 *      counting every project-B decision and open thread — ghosts included.
 *
 * `sessionIds` selects which sessions may *raise* a candidate (`ask` passes
 * its shortlist). Every card in the index is eligible to be project B, because
 * the question B answers is "did this ever come up over there", and restricting
 * that to the shortlist would mean finding a decision absent from B by not
 * having looked.
 */
export function openThreadCandidates(
  db: Db,
  sessionIds: readonly string[],
  o: CandidateOptions = {},
): OpenThreadCandidate[] {
  const limit = Math.max(0, o.limit ?? 8);
  if (limit === 0 || sessionIds.length === 0) return [];

  const cards = loadCards(db);
  if (cards.length === 0) return [];
  const byId = new Map(cards.map((c) => [c.sessionId, c]));

  // Project B, as one pooled view per project. Pooling is right: "never seen
  // in meghbrain" is a claim about the project, and checking each of its
  // sessions separately would raise the same candidate once per session.
  //
  // Pooled once, before the session loop, and not once per session: the pools
  // do not depend on A, and rebuilding them inside would make the rule pass
  // quadratic in the size of the archive for no reason.
  const projects = new Map<string, ProjectPool>();
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

  const seqExists = db.prepare(
    'SELECT ts FROM exchanges WHERE session_id = ? AND seq = ? LIMIT 1',
  );

  const raised: OpenThreadCandidate[] = [];

  for (const sessionId of sessionIds) {
    const a = byId.get(sessionId);
    if (!a) continue;
    if (a.ghost) continue; // 1
    if (a.decisions.length === 0) continue;

    for (const [project, pool] of projects) {
      if (sameProject(project, a.project)) continue;
      const { cards: bCards, tokens: bTokens, paths: bPaths } = pool;

      // 5 — are these two projects related at all?
      const sharedTokens = [...a.tokens].filter((t) => bTokens.has(t));
      const sharedPaths = [...a.paths].filter((p) => bPaths.has(p));
      if (sharedPaths.length === 0 && sharedTokens.length < MIN_PROJECT_OVERLAP) continue;

      const sharedSet = new Set(sharedTokens);
      const overlapTopics = a.topics.filter((_t, i) =>
        (a.topicTokens[i] ?? []).some((tok) => sharedSet.has(tok)),
      );
      const overlapFiles = a.files.filter((f) => bPaths.has(normalisePath(f)));
      // Which of B's sessions actually carry the overlap, so the reader is
      // pointed at the sessions that were checked rather than at a project.
      const otherSessionIds = bCards
        .filter(
          (b) =>
            [...b.tokens].some((t) => sharedSet.has(t)) ||
            [...b.paths].some((p) => a.paths.has(p)),
        )
        .map((b) => b.sessionId);
      if (otherSessionIds.length === 0) continue;

      for (const d of a.decisions) {
        // 2 — cited, and the citation resolves to a real exchange.
        let seq: number | null = null;
        let ts = a.ts;
        for (const s of d.seqs) {
          const row = seqExists.get(sessionId, s) as { ts: string | null } | undefined;
          if (!row) continue;
          seq = s;
          // The ts a reader lands on when they follow `id8@seq`, which is the
          // thing being cited. Session start is the fallback.
          if (row.ts) ts = row.ts;
          break;
        }
        if (seq === null) continue;

        // 3 and 4 — the decision's topic, and its presence in B.
        const dTokens = new Set(contentTokens(`${d.what} ${d.why}`));
        const anchor = [...dTokens].filter((t) => a.tokens.has(t) && bTokens.has(t));
        if (anchor.length < MIN_ANCHOR_TOKENS) continue;

        // 6 — does anything in B already say this?
        let best = 0;
        for (const b of bCards) {
          for (const m of b.mentions) {
            const c = tokenCosine(dTokens, m);
            if (c > best) best = c;
            if (best >= MENTION_COSINE) break;
          }
          if (best >= MENTION_COSINE) break;
        }
        if (best >= MENTION_COSINE) continue;

        raised.push({
          what: d.what,
          why: d.why,
          sessionId,
          id8: idTag(sessionId),
          project: a.project,
          ts,
          evidenceSeq: seq,
          otherProject: project,
          otherSessionIds,
          overlap: { files: overlapFiles, topics: overlapTopics },
          // Anchored breadth, discounted by how close B already came. A
          // decision B nearly says scores near zero even when the projects
          // are twins; a well-anchored decision B is silent about scores
          // its whole overlap.
          score:
            (anchor.length + 2 * overlapFiles.length) *
            (1 - Math.min(1, best / MENTION_COSINE)),
        });
      }
    }
  }

  // One line per decision, not one per sibling project.
  //
  // A decision absent from three related projects is still *one* claim, and
  // {@link OpenThreadCandidate} can name only one `otherProject`, so raising it
  // three times would print the same sentence three times with the tail
  // changed. `05`'s rule is that the whole of `ask` has to be screenshot-able,
  // and the best-scoring pairing is the one worth the line. The same decision
  // text reached from two different sessions of A collapses the same way.
  const best = new Map<string, OpenThreadCandidate>();
  for (const c of raised) {
    const key = c.what.toLowerCase();
    const prior = best.get(key);
    if (!prior || c.score > prior.score) best.set(key, c);
  }

  return [...best.values()]
    .sort((x, y) => y.score - x.score || x.what.localeCompare(y.what))
    .slice(0, limit);
}

// ------------------------------------------------------------------ model pass

const CONFIRM_SYSTEM =
  'You are auditing candidate "open threads" found by a rule that compares session summaries ' +
  'across a developer\'s projects. Each candidate says: this was decided in project A, and ' +
  'project A and project B share the listed topics and files, and no summary in project B ' +
  'mentions it.\n' +
  'The absence has already been checked arithmetically and is not your job. Your job is ' +
  'whether the candidate is WORTH RAISING: are these two projects genuinely related, and is ' +
  'this decision the kind of thing that should carry from one to the other?\n' +
  'Reject when the overlap is a coincidence of vocabulary, when the decision is local to ' +
  'project A (a one-off fix, a rename, something about A\'s own files), or when it is too ' +
  'vague to act on. Confirm only when a reasonable person would want to be reminded of it ' +
  'while working in project B.\n' +
  'Answer in one short sentence per candidate. Never invent detail that is not in the input.';

const CONFIRM_SCHEMA = `{"results": [{"i": 0, "confirmed": true, "note": "one sentence"}]}`;

interface RawVerdict {
  i: number;
  confirmed: boolean;
  note: string;
}

function promptFor(batch: readonly OpenThreadCandidate[]): string {
  const lines: string[] = [
    `${batch.length} candidate open thread${batch.length === 1 ? '' : 's'}. ` +
      'Return one verdict for each, keyed by "i".',
    '',
  ];
  batch.forEach((c, i) => {
    lines.push(`[${i}] decided in: ${c.project}`);
    lines.push(`    decision: ${c.what}`);
    if (c.why) lines.push(`    reason: ${c.why}`);
    lines.push(`    not seen in: ${c.otherProject} (${c.otherSessionIds.length} session(s) checked)`);
    if (c.overlap.topics.length) lines.push(`    shared topics: ${c.overlap.topics.join(', ')}`);
    if (c.overlap.files.length) lines.push(`    shared files: ${c.overlap.files.join(', ')}`);
    lines.push('');
  });
  return lines.join('\n');
}

/** One sentence, and not a paragraph wearing one sentence's clothes. */
function oneSentence(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const stop = /[.!?](\s|$)/.exec(s);
  const first = stop ? s.slice(0, stop.index + 1) : s;
  return first.length <= 220 ? first : `${first.slice(0, 219).trimEnd()}…`;
}

function validateVerdicts(value: unknown): { results: RawVerdict[] } | null {
  const rec = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const list = Array.isArray(rec?.['results'])
    ? (rec['results'] as unknown[])
    : Array.isArray(value)
      ? (value as unknown[])
      : null;
  if (!list) return null;
  const results: RawVerdict[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const i = typeof r['i'] === 'number' ? r['i'] : Number(r['i'] ?? r['index']);
    if (!Number.isInteger(i)) continue;
    results.push({
      i,
      confirmed: r['confirmed'] === true || r['confirmed'] === 'true',
      note: oneSentence(r['note'] ?? r['reason'] ?? r['why']),
    });
  }
  return { results };
}

function unconfirmed(cands: readonly OpenThreadCandidate[], note: string): OpenThread[] {
  return cands.map((c) => ({ ...c, confirmed: false, note }));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Model pass — confirms or rejects each candidate in one sentence.
 *
 * **One call for the whole batch**, not one per candidate: see
 * {@link CONFIRM_BATCH}.
 *
 * The model is advisory and is treated as such in code:
 *
 *   - it contributes exactly two fields, `confirmed` and `note`. Every other
 *     field on the returned {@link OpenThread} is the rule pass's own value,
 *     copied across. A model that renames the project or rewrites the decision
 *     cannot change what is printed.
 *   - a verdict for an index that was never sent is discarded.
 *   - a confirmation of a candidate whose decision **is not supported by the
 *     card's own `evidence_seq`** is overruled here regardless of what the
 *     model said. `plans` T4.2's ruling: *the prompt is not the guard; the code
 *     is*. (The rule pass never emits such a candidate — it checks the seq
 *     against the transcript, which it can do because it has the `Db`. This
 *     second check exists because `confirmOpenThreads` is a public export and
 *     the pinned signature gives it no `Db` of its own; what it can still
 *     verify without one is that the citation exists at all, and it does.)
 *   - a confirmation with no sentence is not a confirmation.
 *
 * **This function never throws.** `ask` must not fail because open threads
 * could not be confirmed: with no backend, a dead backend, a budget abort or a
 * timeout, every candidate comes back `confirmed:false` with a note saying so,
 * and the caller shows nothing.
 */
export async function confirmOpenThreads(
  cands: readonly OpenThreadCandidate[],
  o: ConfirmOptions = {},
): Promise<OpenThread[]> {
  if (cands.length === 0) return [];

  let llm = o.llm ?? null;
  let owned = false;
  if (!llm) {
    try {
      detectBackend({ ...(o.model ? { model: o.model } : {}) });
      llm = Llm.open({
        model: o.model ?? ASK_MODEL,
        ...(o.budget ? { budget: o.budget } : {}),
      });
      owned = true;
    } catch {
      // NoBackendError, ReentrancyError, or a transport that would not build.
      return unconfirmed(cands, NO_MODEL_NOTE);
    }
  }

  const verdicts = new Map<number, RawVerdict>();
  try {
    for (let start = 0; start < cands.length; start += CONFIRM_BATCH) {
      const batch = cands.slice(start, start + CONFIRM_BATCH);
      const r = await llm.json<{ results: RawVerdict[] }>({
        prompt: promptFor(batch),
        system: CONFIRM_SYSTEM,
        schema: CONFIRM_SCHEMA,
        fallback: { results: [] },
        validate: validateVerdicts,
        label: `open threads ${start + 1}–${start + batch.length}`,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      for (const v of r.value.results) {
        // A verdict for a candidate we did not send is not a verdict.
        if (v.i < 0 || v.i >= batch.length) continue;
        verdicts.set(start + v.i, v);
      }
    }
  } catch (err) {
    return unconfirmed(cands, `the model pass did not run (${errText(err)}); unconfirmed.`);
  } finally {
    if (owned) {
      try {
        await llm.close();
      } catch {
        /* closing a transport is not a reason to lose the verdicts */
      }
    }
  }

  return cands.map((c, i) => {
    const v = verdicts.get(i);
    if (!v) return { ...c, confirmed: false, note: 'the model returned no verdict for this one.' };
    // The guard, in code. A decision the card cannot cite is not confirmable
    // however confidently the model confirmed it.
    if (v.confirmed && c.evidenceSeq === null) {
      return {
        ...c,
        confirmed: false,
        note: 'dropped: the decision carries no evidence_seq, so the claim cannot be checked.',
      };
    }
    if (v.confirmed && !v.note) {
      return { ...c, confirmed: false, note: 'the model confirmed without giving a reason.' };
    }
    return { ...c, confirmed: v.confirmed, note: v.note };
  });
}
