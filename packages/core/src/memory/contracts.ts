/** Phase 12 versioned shared transport and evidence contracts. */
export type SourceId = string;
export type RevisionId = string;
export type SpanId = string;
/** Optional wire projection; semantic evidence contracts stay at version 2. */
export type MemoryResponseFormat = 'expanded-v2' | 'compact-v1';
export type NavigationMode = 'inspect-v1';
export type SpanRef = {
    sourceId: SourceId;
    revisionId: RevisionId;
    spanId: SpanId;
};
export type EvidenceRole = 'user' | 'assistant' | 'tool_input' | 'tool_result' | 'ghost_prompt';
export type ToolOutcome = 'success' | 'error' | 'unknown';
export type Epochs = {
    evidence: number;
    notes: number;
    lineage: number;
    deletion: number;
    vector: number;
};
export type Scope = {
    project?: string;
    branch?: string;
    sourceIds?: string[];
    lineage?: 'self' | 'ancestors' | 'descendants' | 'conversation';
    /** Inclusive lower event-time bound, distinct from ingestion time. */
    eventFrom?: string;
    asOf?: string;
    learnedBy?: string;
    includeHistory?: boolean;
};
export type ResponseBudget = {
    maxTokens: number;
    tokenizerId: string;
    remainingJourneyTokens?: number;
    maxBytes?: number;
};
export type Coverage = {
    state: 'complete_snapshot' | 'partial' | 'unavailable' | 'upgrade_required';
    snapshotEpochs: Epochs;
    scope: Scope;
    capturedThrough: string | null;
    pendingSources: number;
    failedSources: number;
    omittedKinds: string[];
    unavailableKinds?: string[];
    semantic: 'ready' | 'building' | 'missing_assets' | 'disabled' | 'failed';
};
export type EvidenceItem = {
    ref: SpanRef;
    role: string;
    text: string;
    startUtf16: number;
    endUtf16: number;
    sourceEventAt: string | null;
    observedAt: string;
    project: string | null;
    branch: string | null;
    toolOutcome?: ToolOutcome;
    authority: string;
    citation: string;
    historical: boolean;
    quoteBasis: 'redacted_unit';
    provenance?: {
        harness: string;
        nativeSessionId: string;
        artifactHash: string;
        artifactBytes: number;
        artifactBasis: 'raw_prefix' | 'legacy_projection' | 'history_records';
        transcriptAvailability?: 'unavailable';
        adapterVersion: string;
        normalizationVersion: string;
        locator: SourceLocator;
        locatorFidelity: string;
        timeBasis: string;
        availability: string;
        manifestHash: string;
        unitRevisionId: string;
        unitKey: string;
        unitTextHash: string;
        spanTextHash: string;
        chunkPolicy: string;
        spanStartUtf16:number;spanEndUtf16:number;producerNameBasis?:'recorded'|'verified_prior_unit'|'unavailable'|'unverified'|'projection';
        unitToolName:string|null;unitToolCallId:string|null;parentNativeSessionId:string|null;
    };
};
export type SupportAssessment = {
    state: 'sufficient' | 'insufficient' | 'conflict' | 'unassessed';
    method: 'literal' | 'structured_note' | 'host_reader' | 'none';
    requirements: {
        id: string;
        text: string;
        state: 'supported' | 'missing' | 'conflict' | 'unassessed';
        refs: SpanRef[];
        noteIds?: string[];
    }[];
    unresolved: string[];
    assessor?: {
        kind: string;
        version: string;
    };
};
export type NoteKind = 'decision' | 'open' | 'next' | 'observation' | 'retraction';
export type NoteAuthority = 'user_attested' | 'agent_assertion' | 'unknown';
export type NoteSupportStatus = 'linked' | 'unverified' | 'orphaned';
export type NoteView = {
    availability?:'privacy_refresh_required';
    noteId: string;
    batchId: string;
    kind: NoteKind;
    text: string;
    project: string;
    branch: string | null;
    eventAt: string | null;
    observedAt: string;
    validFrom: string | null;
    validUntil: string | null;
    authority: NoteAuthority;
    supportStatus: NoteSupportStatus;
    supportRefs: SpanRef[];
    supersedes: string[];
    current: boolean;
    originSourceId: string | null;
    lineageAnchorSourceId: string | null;
    authorClaim: string;
    origin: 'cli' | 'mcp' | 'api' | 'migration';
};
export type Candidate = {
    ref: SpanRef;
    score: number;
    lanes: ('lexical' | 'dense' | 'literal')[];
    /** Exact navigation excerpt, never top-level evidence or automatic claim support. */
    evidence?: EvidenceItem;
};
export type MemoryResponse = {
    navigation?: NavigationMode;
    contractVersion: 2;
    requestId: string;
    coverage: Coverage;
    support: SupportAssessment;
    evidence: EvidenceItem[];
    assertions: NoteView[];
    candidates: Candidate[];
    budget: {
        tokenizerId: string;
        usedTokens: number;
        remainingTokens: number;
        truncated: boolean;
        omittedItems: number;
    };
    continuation?: string;
    warnings: string[];
};
export type Requirement = {
    id: string;
    text: string;
    literal?: string;
    note?: {
        kind?: NoteKind;
        scope?: Scope;
        status?: 'current' | 'history';
        eventFrom?: string;
        eventUntil?: string;
    };
};
export type RecallInput = {
    navigation?: NavigationMode;
    responseFormat?: MemoryResponseFormat;
    query: string;
    mode?: 'hybrid' | 'literal';
    scope: Scope;
    budget: ResponseBudget;
    requirements?: Requirement[];
};
export type ReadInput = {
    responseFormat?: MemoryResponseFormat;
    refs?: SpanRef[];
    noteIds?:string[];
    legacyRef?: {
        sessionId: string;
        seq?: number;
        /** Inclusive legacy exchange range; conflicts with an exact seq. */
        fromSeq?: number;
        toSeq?: number;
    };
    cursor?: string;
    scope: Scope;
    budget: ResponseBudget;
};
export type GraftInput = {
    responseFormat?: MemoryResponseFormat;
    scope: Scope;
    query?: string;
    refs?: SpanRef[];
    budget: ResponseBudget;
    mode?: 'evidence' | 'assisted';
    requirements?: Requirement[];
};
export type NoteEntry = {
    kind: NoteKind;
    text: string;
    eventAt?: string;
    validFrom?: string;
    validUntil?: string;
    supports?: SpanRef[];
    contradicts?: SpanRef[];
    context?: SpanRef[];
    supersedes?: string[];
};
export type WriteInput = {
    requestKey: string;
    scope: Scope;
    originSourceId?: string;
    lineageAnchorSourceId?: string;
    entries: NoteEntry[];
    authorClaim?: string;
    origin: 'cli' | 'mcp' | 'api' | 'migration';
    authority?: 'agent_assertion' | 'unknown';
    validFrom?: string;
    validUntil?: string;
};
export type WriteReceipt = {
    contractVersion: 2;
    requestKey: string;
    batchId: string;
    noteIds: string[];
    epochs: Epochs;
    redacted: boolean;
    authority: NoteAuthority;
    supportStatus: NoteSupportStatus;
    committedAt: string;
};
export interface MemoryStore {
    inspect(): Coverage;
    recall(input: RecallInput, signal?: AbortSignal): Promise<MemoryResponse>;
    read(input: ReadInput, signal?: AbortSignal): Promise<MemoryResponse>;
    graft(input: GraftInput, signal?: AbortSignal): Promise<MemoryResponse>;
    write(input: WriteInput, signal?: AbortSignal): Promise<WriteReceipt>;
    close(): Promise<void>;
}
/** Source locators never imply exact raw substring mapping after normalization. */
export type SourceLocator = {
    recordKey: string;
    rawStart?: number;
    rawEnd?: number;
    mapping: 'exact' | 'record_container' | 'unavailable';
    [key: string]: unknown;
};
export type EvidenceRecord = {
    unitKey: string;
    exchangeId?: string;
    seq?: number;
    role: EvidenceRole;
    text: string;
    eventAt: string | null;
    timeBasis: 'record' | 'exchange' | 'unknown';
    toolName?: string;
    toolCallId?: string;
    outcome?: ToolOutcome;
    locator: SourceLocator;
    locatorFidelity: 'record_id' | 'record_ordinal' | 'exchange_ordinal';
    project?: string;
    branch?: string;
    recordType: string;
};
export type Continuation = {
    consumedOffset: number;
    lastCompleteRecordKey: string | null;
    reopenOffset: number;
    parserStateVersion: string;
    /** Versioned derived legacy lookup, separate from immutable record identity. */
    legacyMappingVersion?: string;
    prefixHash: string;
};
export type MaintenanceJobKind = 'discover' | 'capture' | 'parse' | 'lineage' | 'embed' | 'rebuild' | 'forget';
export type MaintenanceJobState = 'pending' | 'running' | 'retry' | 'done' | 'blocked' | 'cancelled';
export type ForgetTarget = {
    sourceId: string;
    noteId?: never;
} | {
    noteId: string;
    sourceId?: never;
};
export type ForgetInput = {
    requestKey: string;
    target: ForgetTarget;
    removeSourceDerivedNotes?: boolean;
};
export type ForgetPreview = {
    contractVersion: 2;
    target: ForgetTarget;
    previewHash: string;
    noteIds: string[];
    spanCount: number;
    artifactCount: number;
    jobCount: number;
};
export type ForgetReceipt = {
    contractVersion: 2;
    requestKey: string;
    tombstoneId: string;
    target: ForgetTarget;
    logicalForgetComplete: boolean;
    archivePending: number;
    /** Known source-independent copies are retained, never claimed physically erased. */
    retainedSharedArchives?:string[];
    /** Native-only keys cannot certify ownership after a cross-harness collision. */
    retainedLegacyAnnotations?:{nativeSessionId:string;ownership:'ambiguous';notes:number;tags:number;pins:number;links:number}[];
    removedNotes: number;
    removedSpans: number;
    epochs: Epochs;
    committedAt: string;
};
