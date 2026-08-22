"""Adds the byte-exact-quote block to tests/ask.test.ts.

SUBSTITUTED 2026-08-22: the two `project:` fields in the block below named one
of the user's own project directories when this script was run in phase 4 --
the private fact that family (3) of `scripts/check-privacy.py` is about, so the
name is not repeated here. They read `Ledger` now, which is what phase 7
substituted into `tests/ask.test.ts` itself, so this script's replace-and-insert
still matches the file it patches. Nothing else changed: the field is a label on
a fixture and no assertion reads it.

Kept as evidence rather than as a throwaway: the block it inserts is the one
that locks the contract the ask evals score against — a quote that matches
"only after case folding" is a fault there, so the emitted quote has to be the
transcript's own bytes. Run from the repo root:  python3 <this file>
"""
import io

P = 'tests/ask.test.ts'
s = io.open(P, encoding='utf-8').read()

if 'quotablеText' in s or 'the transcript\'s bytes' in s:
    print('already applied')
    raise SystemExit(0)

s = s.replace(
    "import { QUOTE_CHARS, clipQuote, maskSafeCut, renderAsk } from '../packages/core/src/render/ask.js';",
    "import { matchSpan, quotableText } from '../packages/core/src/ask.js';\n"
    "import { QUOTE_CHARS, clipQuote, maskSafeCut, renderAsk } from '../packages/core/src/render/ask.js';",
)

MARKER = '// ============================================================== the filter'
BLOCK = r'''describe("the emitted quote is the transcript's bytes, not the model's", () => {
  // The ask evals check every evidence line against the index and count a
  // quote that matches "only after case folding" as a **fault**: a quote is a
  // quotation, and a tool that lowercases somebody's words has changed the
  // record even though it changed none of them. So the folding in
  // `normaliseQuote` is used to *find* the passage and never to render it.
  it('repairs a re-cased quote to the source casing', () => {
    const out = filterAnswer(
      [{ text: 'The cache was set to zero.', cites: [1] }],
      // The model shouted it. The transcript did not.
      [{ index: 1, sessionId: POOLER, seq: 12, quote: 'WE SET STATEMENT_CACHE_SIZE=0 ON THE CLIENT' }],
      sources(),
    );
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]!.quote).toBe('we set statement_cache_size=0 on the client');
  });

  it('repairs a curly apostrophe back to the straight one the transcript has', () => {
    const src: EvidenceSource[] = [
      {
        sessionId: POOLER,
        id8: 'sess-poo',
        project: 'Ledger',
        harness: 'claude',
        isSidechain: false,
        isGhost: false,
        units: [unit(12, "user: x\n\nassistant: we don't carry prepared statements at the pooler")],
      },
    ];
    const out = filterAnswer(
      [{ text: 'Not at the pooler.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: 'we don’t carry prepared statements' }],
      src,
    );
    expect(out.evidence[0]!.quote).toBe("we don't carry prepared statements");
  });

  it('the emitted quote is a literal substring of the exchange as the index stores it', () => {
    // The index holds `user_text` and `assistant_text` as two columns, and
    // anything checking a citation later reads them joined with a newline and
    // no labels. `unitText` adds `user:` / `assistant:` for the model's
    // benefit; those labels must never end up inside a quote.
    const stored =
      'the pooler is 500ing on deploy\npgbouncer in transaction mode cannot carry prepared ' +
      'statements, so we set statement_cache_size=0 on the client rather than moving the ' +
      'pooler to session mode.';
    expect(quotableText(POOLER_TEXT)).toBe(stored);
    const out = filterAnswer(
      [{ text: 'Set to zero.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE }],
      sources(),
    );
    expect(stored.replace(/\s+/g, ' ')).toContain(out.evidence[0]!.quote);
  });

  it('refuses a quote that would span the user/assistant join', () => {
    const out = filterAnswer(
      [{ text: 'Both sides at once.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: 'on deploy assistant: pgbouncer in transaction mode' }],
      sources(),
    );
    expect(out.evidence).toHaveLength(0);
    expect(reasons(out.drops)).toContain('not-a-quote');
  });

  it('refuses a quote that swallowed an elided middle', () => {
    const long =
      'user: q\n\nassistant: ' +
      'head '.repeat(10) +
      '\n… [4,000 characters elided] …\n' +
      'tail '.repeat(10);
    const src: EvidenceSource[] = [
      {
        sessionId: POOLER,
        id8: 'sess-poo',
        project: 'Ledger',
        harness: 'claude',
        isSidechain: false,
        isGhost: false,
        units: [unit(12, long)],
      },
    ];
    const out = filterAnswer(
      [{ text: 'One continuous passage.', cites: [1] }],
      [
        {
          index: 1,
          sessionId: POOLER,
          seq: 12,
          quote: 'head head … [4,000 characters elided] … tail tail',
        },
      ],
      src,
    );
    expect(out.evidence).toHaveLength(0);
  });

  it('matchSpan reports source coordinates, not folded ones', () => {
    const text = 'AAA   We  Set   The  Cache   To  Zero.';
    // Long enough to clear MIN_QUOTE_CHARS — the floor applies here too, since
    // this is the function the floor is enforced in.
    const span = matchSpan('we set the cache to zero.', text);
    expect(span).not.toBeNull();
    expect(text.slice(span!.start, span!.end)).toBe('We  Set   The  Cache   To  Zero.');
  });
});

'''

assert MARKER in s
s = s.replace(MARKER, BLOCK + MARKER, 1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
