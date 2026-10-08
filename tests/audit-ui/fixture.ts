/** Synthetic, public audit snapshots for UI tests. No real history. */
import type { AuditMetric, AuditSnapshot, AuditEvidenceRoute } from '../../packages/core/src/analytics/contracts.js';
import type { ModelAggregate, RecordedInference } from '../../packages/core/src/analytics/launch-contracts.js';

const metric = (value: number | null, unit: string, state: AuditMetric['state'] = 'observed'): AuditMetric => ({
  value, numerator: value, denominator: null, unit, measurementBasis: 'synthetic_fixture', state, definition: 'fixture',
});

const route: AuditEvidenceRoute = { basis: 'canonical', refs: [], scope: {} as never };

function model(id: string, provider: string | null, tokens: number, value: number | null, reference: number | null = null, conversations = 10): ModelAggregate {
  return {
    id, provider, model: id.split('/').at(-1)!, canonicalModel: id, inputTokens: tokens, outputTokens: 0, totalTokens: tokens, knownTokens: tokens,
    conversations, tokenShare: null, conversationShare: 0.1, favouriteScore: null, valueUsd: value, referenceValueUsd: reference, gaps: [],
  };
}

function records(count: number, hourUtc: number): RecordedInference[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r${i}`, conversationId: 'c0', harness: 'claude' as const, eventAt: `2026-06-${String(10 + (i % 5)).padStart(2, '0')}T${String(hourUtc).padStart(2, '0')}:10:00Z`,
    project: null, provider: 'anthropic', model: 'claude-opus-5', canonicalModel: 'anthropic/claude-opus-5', inputTokens: 1, outputTokens: 1,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, inputIncludesCache: false, outputIncludesReasoning: false, reportedCostUsd: null, basis: 'fixture', gaps: [],
  }));
}

export function readySnapshot(): AuditSnapshot {
  const models = [
    model('anthropic/claude-opus-5', null, 4_257_614_761, null, 3076.39, 202),
    model('anthropic/claude-fable-5', null, 605_486_567, null, 1832.58, 86),
    model('openai/gpt-6-astra', 'openai', 906_868_878, 1730.13, null, 17),
    model('anthropic/claude-opus-4-8', null, 674_273_507, null, 1001.04, 109),
    { ...model('openai/gpt-6-sol', 'openai', 1_626_448_960, 662.3, null, 52), estimated: true } as ModelAggregate,
    model('openai/gpt-6.1-sol', 'openai', 2_011_765_224, 541.28, null, 54),
    model('anthropic/claude-haiku-4-5-20251001', null, 3_016_697, null, 1.1, 3),
    { ...model('unknown', 'openai', 7_810_247, null, null, 83), model: null, canonicalModel: null },
  ];
  models[0]!.tokenShare = 0.4;
  const activity = [
    { date: '2025-11-04', count: 5 }, { date: '2025-11-05', count: 7 }, { date: '2025-11-06', count: 15 },
    { date: '2026-02-01', count: 30 }, { date: '2026-06-10', count: 119 }, { date: '2026-06-11', count: 40 },
    { date: '2026-10-01', count: 42 }, { date: '2026-10-09', count: 7 },
  ];
  return {
    schemaVersion: 'audit-v1', snapshotId: 'fixture', sequence: 10, measuredAt: '2026-10-09T00:00:00Z',
    scope: { harnesses: ['claude', 'codex', 'pi', 'opencode'], project: null, eventFrom: null, asOf: null, timezone: 'Asia/Kolkata' },
    status: 'partial',
    coverage: { state: 'partial', knownSources: 10, parsedSources: 9, unknownOriginEvents: 0, excludedEvents: 0, omittedSources: 0, gapCodes: ['human_origin_unavailable'] },
    progress: { stage: 'partial', completed: 10, total: 10, unit: 'conversation', provisional: false, cancellable: false },
    metrics: {
      conversations: metric(490, 'conversation'), humanPrompts: metric(975, 'prompt'), projects: metric(121, 'project'),
      linkedChildren: metric(0, 'child'), nativeUserInputs: metric(4362, 'input'),
    },
    sources: [
      { harness: 'claude', state: 'available', candidateFiles: 432, conversations: 729, humanPrompts: 975, humanOrigin: 'native_marker', evidence: 'canonical', usage: 'reported', firstUnsupportedStep: null, gapCodes: [], census: { checked: true, files: 432, bytes: 1, roots: 1, unit: 'file' } },
      { harness: 'codex', state: 'available', candidateFiles: 234, conversations: 234, humanPrompts: null, humanOrigin: 'native_marker', evidence: 'canonical', usage: 'reported', firstUnsupportedStep: null, gapCodes: [], census: { checked: true, files: 234, bytes: 1, roots: 1, unit: 'file' } },
      { harness: 'opencode', state: 'absent', candidateFiles: 0, conversations: 0, humanPrompts: null, humanOrigin: 'projection', evidence: 'unavailable', usage: 'unavailable', firstUnsupportedStep: null, gapCodes: [], census: { checked: true, files: 0, bytes: 0, roots: 0, unit: 'database' } },
    ],
    projects: [
      { id: 'p1', alias: 'Project A', displayName: 'Rotor-Notes', path: '/x/Rotor-Notes', humanPrompts: 400, nativeUserInputs: 979, conversations: 62, share: null, focus: [{ label: 'Development', inputs: 4, promptIds: ['a'], evidenceRoutes: [], basis: 'lexical_requested_work_v1' }] },
      { id: 'p2', alias: 'Project B', displayName: 'tide_tracker', path: null, humanPrompts: 0, nativeUserInputs: 432, conversations: 22, share: null },
      { id: 'p3', alias: 'Project C', displayName: 'orchard', path: null, humanPrompts: 0, nativeUserInputs: 349, conversations: 44, share: null },
      { id: 'p4', alias: 'Project D', displayName: 'lexicon', path: null, humanPrompts: 0, nativeUserInputs: 283, conversations: 14, share: null },
      { id: 'p5', alias: 'Project E', displayName: 'demo-driver', path: null, humanPrompts: 0, nativeUserInputs: 280, conversations: 7, share: null },
      { id: 'p6', alias: 'Project F', displayName: 'sample-cli', path: null, humanPrompts: 0, nativeUserInputs: 273, conversations: 14, share: null },
      { id: 'p7', alias: 'Project G', displayName: 'empty', path: null, humanPrompts: 0, nativeUserInputs: 0, conversations: 1, share: null },
    ],
    activity,
    conversations: [],
    insights: [],
    usage: { state: 'partial', inputTokens: 1, outputTokens: 1, cacheTokens: 1, reasoningTokens: 1, costUsd: 1, measurementBasis: 'fixture', inclusion: 'fixture', priceVersion: 'fixture' },
    semantics: { state: 'not_run', qualified: false, model: null, classifiedPrompts: 0, eligiblePrompts: 0, uncertainPrompts: 0, work: [], requestCount: 0, cacheHits: 0, estimatedCostUsd: null, reportedCostUsd: null, unresolvedCostUsd: null, errorCode: null },
    phrases: [
      { id: 'ph1', text: 'continue', prompts: 4, occurrences: 4, denominator: 975, measurementBasis: 'fixture', conversationIds: [] },
      { id: 'ph2', text: 'continue please', prompts: 3, occurrences: 3, denominator: 975, measurementBasis: 'fixture', conversationIds: [] },
      { id: 'ph3', text: '<command-message>loop</command-message>', prompts: 19, occurrences: 19, denominator: 975, measurementBasis: 'fixture', conversationIds: [] },
      { id: 'ph4', text: '[Image #11] , [Image #12]', prompts: 2, occurrences: 2, denominator: 975, measurementBasis: 'fixture', conversationIds: [] },
      { id: 'ph5', text: 'one-off', prompts: 1, occurrences: 1, denominator: 975, measurementBasis: 'fixture', conversationIds: [] },
    ],
    profanity: {
      lexiconVersion: 'fixture', language: 'en-explicit-lexicon', measurementBasis: 'fixture', eligiblePrompts: 4111,
      occurrences: metric(508, 'match'), containingPrompts: metric(149, 'prompt'),
      buckets: [{ kind: 'direct_prose', occurrences: 418, containingPrompts: 147 }, { kind: 'quoted', occurrences: 14, containingPrompts: 6 }],
      coverageGaps: [],
      terms: [
        { term: 'damn', kind: 'direct_prose', occurrences: 147, containingPrompts: 37, samples: [] },
        { term: 'hell', kind: 'direct_prose', occurrences: 121, containingPrompts: 81, samples: [] },
        { term: 'crap', kind: 'quoted', occurrences: 99, containingPrompts: 3, samples: [] },
      ],
    },
    launch: {
      stage: 'ready', notice: 'Offline audit.',
      facts: {
        recordsIncluded: true, records: [...records(60, 19), ...records(10, 3)], models, favourite: models[0]!,
        valueUsd: 2933.71, referenceValueUsd: 5911.11, pricing: { retrievedAt: '2026-10-07T00:00:00Z', sha256: 'x', source: 'https://models.dev/api.json' },
        recordedResponses: 47939, knownTokenResponses: 47939, pricedResponses: 20818, referencePricedResponses: 26719, equivalentPricedResponses: 47537,
        referenceProviders: [], unknownModelResponses: 230, gaps: ['pricing_coverage_partial'],
      },
      semantics: null,
      languageLines: [
        { id: 'l1', text: 'What the hell are you doing?', occurrences: 4, containingInputs: 4, models: [], samples: [{ promptId: 'a', conversationId: 'c', startUtf16: 0, endUtf16: 1, route }] },
        { id: 'l2', text: '[Pasted text #17 +4 lines]this damn page again', occurrences: 2, containingInputs: 2, models: [], samples: [] },
      ],
      modelFeedback: [
        { provider: null, model: 'claude-fable-5', associatedInputs: 305, directedNegativeInputs: 15, praiseInputs: 1, promptIds: [] },
        { provider: null, model: 'claude-fable-5-1', associatedInputs: 31, directedNegativeInputs: 3, praiseInputs: 0, promptIds: [] },
        { provider: null, model: 'claude-opus-5-5', associatedInputs: 1, directedNegativeInputs: 1, praiseInputs: 0, promptIds: [] },
        { provider: null, model: 'claude-opus-4-8', associatedInputs: 424, directedNegativeInputs: 5, praiseInputs: 2, promptIds: [] },
        { provider: null, model: null, associatedInputs: 900, directedNegativeInputs: 90, praiseInputs: 90, promptIds: [] },
      ],
    },
    warnings: [],
  };
}

/** The very first snapshot a session publishes: nothing known yet. */
export function startingSnapshot(): AuditSnapshot {
  const ready = readySnapshot();
  return {
    ...ready,
    sequence: 0,
    status: 'discovering',
    coverage: { state: 'unavailable', knownSources: 0, parsedSources: 0, unknownOriginEvents: 0, excludedEvents: 0, omittedSources: 0, gapCodes: [] },
    progress: { stage: 'discovering', completed: 0, total: null, unit: 'candidate_source', provisional: true, cancellable: true, label: 'Discovering native sources' },
    metrics: {
      conversations: metric(null, 'conversation', 'not_run'), humanPrompts: metric(null, 'prompt', 'not_run'),
      projects: metric(null, 'project', 'not_run'), linkedChildren: metric(null, 'child', 'not_run'),
    },
    sources: ready.sources.map(source => ({ ...source, state: 'checking' as const, candidateFiles: 0, conversations: 0, census: undefined })),
    projects: [], activity: [], phrases: [], profanity: undefined,
    launch: { stage: 'discovering', notice: 'Offline audit.', facts: null, semantics: null },
  };
}

/** Mid-scan: files being read, a partial subtotal published. */
export function readingSnapshot(): AuditSnapshot {
  const ready = readySnapshot();
  const start = startingSnapshot();
  return {
    ...start,
    sequence: 5,
    status: 'parsing',
    progress: { stage: 'parsing', completed: 300, total: null, unit: 'candidate_source', provisional: true, cancellable: true, label: 'Reading native history' },
    sources: ready.sources,
    launch: {
      stage: 'sizing', notice: 'Offline audit.',
      facts: { ...ready.launch!.facts!, recordsIncluded: false, records: [], models: ready.launch!.facts!.models.slice(0, 2), valueUsd: 12.5, referenceValueUsd: null },
      semantics: null,
      factProgress: { state: 'collecting', completedSources: 405, totalSources: 670, cacheHits: 0, coverage: 'completed_sources', origin: 'fresh' },
    },
  };
}
