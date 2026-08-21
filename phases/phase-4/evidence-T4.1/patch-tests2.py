"""Adds the refusal-reason block to tests/ask.test.ts.

The block it inserts locks the fix for the one dishonest line this verb has
printed: a run that stopped at `--max-usd` was told "fewer than 2 quotes
survived the citation check", which is a false statement about the user's
archive made by the verb whose whole purpose is not making those.
Run from the repo root:  python3 <this file>
"""
import io

P = 'tests/ask.test.ts'
s = io.open(P, encoding='utf-8').read()

if 'a refusal says why' in s:
    print('already applied')
    raise SystemExit(0)

s = s.replace(
    """    readers: [],
    refused: false,
    strict: false,""",
    """    readers: [],
    refused: false,
    refusal: null,
    strict: false,""",
)

MARKER = '// ------------------------------------------------------- mask-safe clipping'
BLOCK = r"""describe('a refusal says why', () => {
  const base = {
    question: 'q',
    answer: '',
    sentences: [],
    dropped: [],
    evidence: [],
    openThreads: [],
    searched: 6,
    matching: 41,
    readers: [
      { sessionId: POOLER, id8: 'sess-poo', found: true, quotes: 2, ms: 30_000 },
      { sessionId: NOTES, id8: 'sess-not', found: true, quotes: 1, ms: 28_000 },
    ],
    refused: true,
    strict: false,
    spend: { calls: 6, inputTokens: 900, outputTokens: 400, usd: 0.123, ms: 90_000, estimatedInputCalls: 6 },
    estimated: true,
    ms: 92_000,
  };
  const view = (refusal: string, strict = false) =>
    stripAnsi(
      renderAsk(
        { ...base, refusal, strict } as unknown as Parameters<typeof renderAsk>[0],
        new Theme({ color: false, width: 80 }),
      ),
    );

  it('a cost abort says it stopped on cost, and does not blame the citations', () => {
    const t = view('budget');
    expect(t).toContain('stopped at the cost ceiling');
    expect(t).toContain('$0.123 est.');
    expect(t).toContain('raise --max-usd');
    // The sentence the first version printed here, which was not true.
    expect(t).not.toContain('survived the citation check');
  });

  it('a strict refusal blames the citations, because that is what happened', () => {
    const t = view('strict', true);
    expect(t).toContain('fewer than 2 quotes survived the citation check');
    expect(t).not.toContain('cost ceiling');
  });

  it('a shortlist nothing answered says so', () => {
    expect(view('no-answer', true)).toContain('no session read addressed the question');
  });

  it("every refusal path still prints the plan's sentence", () => {
    for (const r of ['budget', 'strict', 'no-answer', 'no-match']) {
      expect(view(r)).toContain('no grounded answer in 6 sessions searched');
    }
  });
});

"""

assert MARKER in s
s = s.replace(MARKER, BLOCK + MARKER, 1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
