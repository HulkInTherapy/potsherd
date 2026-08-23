import type { Db } from './db.js';

/**
 * F8 — keyphrase extraction, in code, as bm25's first responder.
 *
 * ## The defect
 *
 * `session-archaeologist.md` tells the agent to *"pass the user's own words as
 * `query`"*. The audit measured what that costs on a bm25 index, and the
 * measurement reproduces on the committed eval fixture at `--no-vec`:
 *
 * ```
 * find "where did we leave off on the pgbouncer work and what is left to build"
 *   -> 1 row: a ghost about a build agent running out of inodes. The pgbouncer
 *      session is absent.
 * find "pgbouncer"
 *   -> 1 row: the pgbouncer session, rank 1, strong.
 * ```
 *
 * The one-word query beat the sentence decisively. The reason is visible in
 * the raw bm25 of the OR pass `recall()` relaxes to. Over the full token list
 * the correct exchange is **rank 3**, behind `why did it work last quarter`
 * and `does a restore still work off an incremental chain` — two rows that
 * share nothing with the question but `did`, `work` and `off`. Over the two
 * most selective words of the same question it is **rank 1**, and the five
 * noise rows are not candidates at all.
 *
 * RRF reads rank and nothing else, so a rank-3 candidate in the one list that
 * knows the answer is how the answer leaves the page.
 *
 * ## The rule, and why it is shaped this way
 *
 * Rank the words the user typed by how many documents in *this* archive
 * contain them, and keep the more selective half — capped at
 * {@link KEYPHRASE_RULE}.maxTerms, which is the audit's own *"2–4 distinctive
 * nouns"*.
 *
 * Three properties, each of which is the answer to a way this could have gone
 * wrong:
 *
 * 1. **Relative, never absolute.** Nothing here compares a document frequency
 *    to a constant. A term is kept because it is rarer *than the other words
 *    in the same query*, on the same index, which is a statement that means
 *    the same thing on a 500 KB archive and a 500 MB one. There is no corpus
 *    size in this file.
 *
 * 2. **A term no document contains is the least selective word in the query,
 *    not the most.** This is the whole of T10.1 §d1's objection to IDF, and it
 *    is answered rather than dodged. T10.1 measured `kept`, `even` and `fine`
 *    at df 0 on this fixture and observed that `log(N/df)` hands the least
 *    informative words the highest weight. It does — because IDF is a *scoring*
 *    weight and asks "how surprising is this word". Extraction asks a different
 *    question: "which of these words will find the conversation". A word that
 *    occurs in no document cannot find anything; conjoined it returns nothing,
 *    disjoined it contributes nothing. So {@link selectTerms} drops df-0 terms
 *    from the keyphrase entirely, and if *every* content word is absent the
 *    keyphrase is empty and this module declines to have an opinion — which is
 *    the honest state for a query whose words are simply not in the archive.
 *
 * 3. **Nothing is thrown away.** The keyphrase is a *first responder*, not a
 *    replacement. `recall()` still runs the full-query AND pass first and the
 *    full-query OR pass last, so a rare word that only appears in the long
 *    phrasing is still matched, still ranked and still counted by
 *    `coveredTerms`. See `recall.ts`'s `textList` for the three-rung ladder.
 *
 * ## What this costs
 *
 * One `count(*)` per content term per text table. Measured on the eval fixture
 * (58 sessions, 120 exchanges): 1 ms for a 15-token query across four tables.
 * fts5 counts walk a postings list, so the cost grows with how common the word
 * is rather than with the archive; {@link MAX_SCORED_TERMS} caps the term
 * count so a pasted paragraph cannot turn one search into eighty.
 */

/**
 * The extraction rule, as a value.
 *
 * A `Record`, not four loose constants and not a comparison spelled out inside
 * `selectTerms`, so that `tests/keyphrase.test.ts` can pin the rule itself
 * (`plans/08` rule 3) — it asserts each field *and* the selection each field
 * produces, so moving any of them in either direction fails a test.
 *
 * - `keepRatio` — **half**, rounded **up**. Half is the only ratio in the
 *   range with no free parameter attached: *the more selective half of what
 *   you typed*. Rounding up rather than down is the same principle applied to
 *   the remainder — discarding a word the user typed is the destructive
 *   operation here, so the rounding is the conservative one. Both roundings
 *   were measured on the 60-query set and both are in `T10.9-REPORT.md` §f;
 *   rounding down extracts harder and scores better on bm25 alone, rounding up
 *   costs one query of that and keeps the fusion where it was. The report says
 *   so rather than this comment quoting only the number that was kept.
 * - `minTerms` — 1. A one-word query has a one-word keyphrase; the rule must
 *   not have a floor that invents terms a short query does not have. With
 *   `keepRatio` at a half rounded up it never binds above zero content words,
 *   and it is stated anyway because a rule with an implicit floor is a rule
 *   whose floor moves when the ratio does.
 * - `maxTerms` — 4, the top of the audit's *"2–4 distinctive nouns"*. It binds
 *   from seven content words up, which is where a query has stopped being a
 *   question and started being a paragraph.
 *
 * All three are about the length of the **query**. None of them is about the
 * size of the corpus, which is the property `plans/08` asks for.
 */
export const KEYPHRASE_RULE: Readonly<{
  keepRatio: number;
  minTerms: number;
  maxTerms: number;
}> = Object.freeze({ keepRatio: 0.5, minTerms: 1, maxTerms: 4 });

/**
 * The fts5 tables a document frequency is counted over.
 *
 * The four text surfaces a `find` can match: live exchanges, a ghost's whole
 * recovered prompt list, its individual prompts, and cards. A table that is
 * missing or empty contributes 0 and is not an error — an index that has never
 * run `potsherd card` still gets a keyphrase.
 */
export const DF_TABLES: readonly string[] = [
  'exchanges_fts',
  'ghosts_fts',
  'ghost_prompts_fts',
  'cards_fts',
];

/**
 * How many content terms are scored at all.
 *
 * `ftsQuery` already caps a query at 24 tokens. Sixteen is the most content
 * words that survives that cap in practice, and it bounds the number of count
 * queries one search can issue.
 */
export const MAX_SCORED_TERMS = 16;

export interface Keyphrase {
  /** The distinctive terms, most selective first. Empty when there is no opinion to have. */
  terms: string[];
  /** Every content word of the query, in the order it was typed. */
  content: string[];
  /** Document frequency per content term, as counted. For `--explain` and for a test. */
  df: ReadonlyMap<string, number>;
}

/** The empty opinion: no content words, or none of them in the index. */
export const NO_KEYPHRASE: Keyphrase = { terms: [], content: [], df: new Map() };

/**
 * The words of a query that carry the question.
 *
 * Deduplicated and order-preserving. The caller supplies the closed-class set,
 * because `recall.ts` owns which list is which: the long `QUOTE_STOPWORDS` is
 * the right one here for the same reason it is the right one for a snippet —
 * `where`, `did` and `off` are not what the user is looking for, and on the
 * audit's own query they are three of the five words that decided the ranking.
 */
export function contentTerms(
  tokens: readonly string[],
  stop: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (stop.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_SCORED_TERMS) break;
  }
  return out;
}

/**
 * How many documents in this archive contain each term.
 *
 * Counted, not estimated, and never thrown: a corrupt or absent fts index
 * contributes 0 for that table, which degrades the keyphrase to the other
 * three tables rather than taking the search down.
 */
export function documentFrequency(db: Db, terms: readonly string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const term of terms) {
    const match = `"${term.replace(/"/g, '""')}"`;
    let n = 0;
    for (const table of DF_TABLES) {
      try {
        const row = db
          .prepare(`SELECT count(*) AS c FROM ${table} WHERE ${table} MATCH ?`)
          .get(match) as { c?: number } | undefined;
        n += Number(row?.c ?? 0);
      } catch {
        // Missing table, or an index this build cannot read. Not an error:
        // a `find` on an index with no cards must still get a keyphrase.
      }
    }
    df.set(term, n);
  }
  return df;
}

/**
 * The rule itself, pure, so it can be tested with numbers a test writes.
 *
 * Ascending document frequency, ties broken by the order the words were typed
 * — stable, so the same query always produces the same keyphrase. Terms at df 0
 * are excluded before the count is taken, not sorted to the end and then
 * counted, because a keyphrase of *"the two rarest words, one of which is in no
 * document"* is a keyphrase of one word wearing a second one.
 *
 * The returned order is **most selective first**, and the order is load-bearing
 * rather than cosmetic: `recall()` searches the whole list and calibrates
 * against its head. See `calibration.ts`'s `KEY_TERMS_REQUIRED`.
 */
export function selectTerms(
  content: readonly string[],
  df: ReadonlyMap<string, number>,
): string[] {
  const present = content.filter((t) => (df.get(t) ?? 0) > 0);
  if (present.length === 0) return [];
  const order = new Map(content.map((t, i) => [t, i] as const));
  const ranked = [...present].sort(
    (a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  const keep = Math.min(
    KEYPHRASE_RULE.maxTerms,
    Math.max(KEYPHRASE_RULE.minTerms, Math.ceil(present.length * KEYPHRASE_RULE.keepRatio)),
  );
  return ranked.slice(0, Math.min(keep, ranked.length));
}

/** Content words, their document frequencies, and the distinctive subset. */
export function keyphrase(
  db: Db,
  tokens: readonly string[],
  stop: ReadonlySet<string>,
): Keyphrase {
  const content = contentTerms(tokens, stop);
  if (content.length === 0) return NO_KEYPHRASE;
  const df = documentFrequency(db, content);
  return { terms: selectTerms(content, df), content, df };
}
