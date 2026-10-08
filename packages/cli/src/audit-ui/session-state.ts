/**
 * Snapshot bookkeeping shared by the terminal and tests: applying events in order, and the
 * privacy rules that may clear a captured view. Ported from the previous launch terminal
 * without behavioural change.
 */
import type { AuditEvent, AuditSnapshot } from '../../../core/src/analytics/contracts.js';

export type TransferEvent = Extract<AuditEvent, { type: 'transfer' }>;

/** Apply one event; stale or foreign events leave the snapshot untouched. */
export function applyAuditEvent(snapshot: AuditSnapshot, event: AuditEvent): AuditSnapshot {
  if (event.type === 'transfer') return snapshot;
  if (event.type === 'snapshot') {
    return event.snapshot.snapshotId === snapshot.snapshotId && event.snapshot.sequence >= snapshot.sequence ? event.snapshot : snapshot;
  }
  if (event.snapshotId !== snapshot.snapshotId) return snapshot;
  if (event.type === 'progress') {
    return event.sequence >= snapshot.sequence
      ? { ...snapshot, sequence: event.sequence, status: event.progress.stage, progress: event.progress, sources: event.sources }
      : snapshot;
  }
  return snapshot;
}

export interface PrivacyView {
  snapshot: AuditSnapshot;
  generation: number;
  revoked: AuditSnapshot | null;
}

const privacyCode = (code: string) => /privacy|policy|forgot|tombstone/.test(code);
const revokedPrivacyGap = (code: string) =>
  privacyCode(code) && (!/excluded|ignored|partial/.test(code) || /changed|revok|unavailable|required|hold|invalid|stale|mismatch/.test(code));

/**
 * A privacy error (or a snapshot whose facts were withdrawn for a privacy reason) clears the
 * captured view. Once revoked, nothing — not a held view nor a late worker result — revives it.
 */
export function applyPrivacyEvent<T extends PrivacyView>(view: T, event: AuditEvent): T | null {
  if (view.revoked) return { ...view, snapshot: view.revoked };
  let source: AuditSnapshot;
  let code: string;
  if (event.type === 'error' && event.snapshotId === view.snapshot.snapshotId && privacyCode(event.code)) {
    source = view.snapshot;
    code = event.code;
  } else if (
    event.type === 'snapshot'
    && event.snapshot.snapshotId === view.snapshot.snapshotId
    && event.snapshot.sequence >= view.snapshot.sequence
    && event.snapshot.launch?.facts === null
  ) {
    const gap = event.snapshot.coverage.gapCodes.find(revokedPrivacyGap) ?? event.snapshot.sources.flatMap(item => item.gapCodes).find(revokedPrivacyGap);
    if (!gap) return null;
    source = event.snapshot;
    code = gap;
  } else {
    return null;
  }
  const cleared = clearedSnapshot(source, code);
  return { ...view, snapshot: cleared, revoked: cleared, generation: view.generation + 1 };
}

function clearedSnapshot(source: AuditSnapshot, code: string): AuditSnapshot {
  const metrics = { ...source.metrics };
  for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) {
    const metric = metrics[key];
    if (metric) metrics[key] = { ...metric, value: null, numerator: null, denominator: null, state: 'unavailable' };
  }
  const launch = source.launch;
  return {
    ...source,
    status: 'error',
    coverage: { ...source.coverage, state: 'unavailable', gapCodes: [...new Set([...source.coverage.gapCodes, code])] },
    progress: { ...source.progress, stage: 'error', provisional: false, cancellable: false },
    metrics,
    projects: [],
    activity: [],
    conversations: [],
    insights: [],
    phrases: [],
    judgments: [],
    profanity: undefined,
    funnel: undefined,
    usage: { ...source.usage, state: 'unavailable', inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null, costUsd: null },
    semantics: { ...source.semantics, state: 'cancelled', qualified: false, work: [], estimatedCostUsd: null, reportedCostUsd: null, unresolvedCostUsd: null },
    launch: launch
      ? {
        ...launch,
        stage: 'ready',
        facts: null,
        semantics: launch.semantics
          ? { ...launch.semantics, state: 'cancelled', stories: [], hallOfFame: [], work: [], judgments: [], window: { ...launch.semantics.window, selected: null, choices: [], reason: 'privacy_view_revoked' } }
          : null,
        languageLines: [],
        modelFeedback: [],
        languageByModel: undefined,
        languageGaps: [code],
        factProgress: undefined,
      }
      : undefined,
  };
}

/**
 * A withdrawn running subtotal (price preview revoked) clears the shown subtotal without
 * revoking allowed final data.
 */
export function applyPreviewInvalidation<T extends PrivacyView>(view: T, event: AuditEvent): T | null {
  if (view.revoked || event.type !== 'snapshot' || event.snapshot.snapshotId !== view.snapshot.snapshotId || event.snapshot.sequence < view.snapshot.sequence) return null;
  const next = event.snapshot;
  const progress = next.launch?.factProgress;
  const previous = view.snapshot.launch?.factProgress;
  if (
    !next.coverage.gapCodes.includes('native_price_preview_revoked')
    || next.launch?.facts !== null
    || progress?.state !== 'collecting'
    || progress.representedSources !== 0
    || !view.snapshot.launch?.facts
    || (previous?.representedSources ?? previous?.completedSources ?? 0) <= 0
  ) return null;
  return { ...view, snapshot: next, generation: view.generation + 1 };
}
