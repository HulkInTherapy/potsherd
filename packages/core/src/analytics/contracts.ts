/** Audit v1 shared contracts. Canonical identity and scope remain memory-owned. */
import type { Harness } from '../adapters/types.js';
import type { Scope, SpanRef, Epochs } from '../memory/contracts.js';

export type AuditHarness = Extract<Harness, 'claude'|'codex'|'pi'|'opencode'>;
export const AUDIT_INTENTS = ['feature_build','bug_fix','ui_design','tests','refactor','code_review','pr_management','research','explanation_learning','planning_architecture','deploy_operations','documentation_writing','agent_coordination','other','mixed','insufficient_context'] as const;
export type AuditIntent = typeof AUDIT_INTENTS[number];
export type AuditState = 'discovering'|'parsing'|'normalizing'|'ready'|'partial'|'cancelled'|'error';
export type Availability = 'observed'|'partial'|'unavailable'|'not_run';
export interface AuditScope { harnesses: readonly AuditHarness[]; project: string|null; eventFrom: string|null; asOf: string|null; timezone: string; }
export interface AuditCoverage { state: 'complete_snapshot'|'partial'|'unavailable'; knownSources: number; parsedSources: number; unknownOriginEvents: number; excludedEvents: number; omittedSources: number; gapCodes: readonly string[]; }
export interface AuditMetric { value: number|null; numerator: number|null; denominator: number|null; unit: string; measurementBasis: string; state: Availability; definition: string; }
export interface AuditProgress { stage: AuditState; completed: number; total: number|null; unit: 'candidate_source'|'conversation'|'prompt'; provisional: boolean; cancellable: boolean; }
export interface AuditSourceCapability { harness: AuditHarness; state: 'absent'|'available'|'partial'|'unsupported'|'unavailable'; candidateFiles: number; conversations: number; humanPrompts: number|null; humanOrigin: 'native_marker'|'projection'|'unverified'; evidence: 'canonical'|'transient'|'projection'|'unavailable'; usage: 'unavailable'|'partial'|'reported'; firstUnsupportedStep: string|null; gapCodes: readonly string[]; }
export interface AuditProject { id: string; alias: string; displayName: string; path: string|null; humanPrompts: number; conversations: number; share: number|null; }
export interface AuditActivityBucket { date: string; count: number; }
export interface AuditConversation { id: string; sourceId: string; harness: AuditHarness; nativeSessionId: string; projectId: string|null; title: string|null; alias: string; promptCount: number|null; unknownOriginEvents: number; eventFrom: string|null; eventTo: string|null; child: boolean; parentId: string|null; coverage: AuditCoverage; }
export type AuditEvidenceRoute =
  | { basis: 'canonical'; refs: readonly SpanRef[]; scope: Scope }
  | { basis: 'transient_snapshot'; sourceId: string; artifactHash: string; sourcePath: string; recordKey: string|null; rawStart: number|null; rawEnd: number|null; startUtf16: number; endUtf16: number; snapshotId: string; }
  | { basis: 'projection_snapshot'; sourceId: string; artifactHash: string; sourcePath: string; nativeSessionId: string; seq: number; snapshotId: string; fidelity: 'exchange_projection'; };
export interface AuditPrompt { id: string; conversationId: string; role: 'user'; originBasis: 'claude_prompt_id'|'codex_human_marker'|'pi_user_projection'|'opencode_user_projection'|'unknown'; identityBasis: string; eligibleHuman: boolean; excludedReason: string|null; eventAt: string|null; text: string; route: AuditEvidenceRoute; }
export interface AuditPromptPage { snapshotId: string; conversationId: string; prompts: readonly AuditPrompt[]; offset: number; total: number|null; nextOffset: number|null; coverage: AuditCoverage; }
export interface AuditEvidence { state: 'available'|'stale'|'unavailable'; text: string|null; role: string|null; eventAt: string|null; route: AuditEvidenceRoute; gapCodes: readonly string[]; }
export interface AuditInsight { id: string; basis: 'deterministic'|'semantic'; caption: string; publicCaption: string; value: AuditMetric; conversationIds: readonly string[]; promptIds: readonly string[]; definition: string; }
export interface AuditPhrase { id: string; text: string; prompts: number; occurrences: number; denominator: number; measurementBasis: string; conversationIds: readonly string[]; promptIds?: readonly string[]; evidenceRoutes?: readonly AuditEvidenceRoute[]; }
export type AuditProseKind='direct_prose'|'quoted'|'code'|'unknown';
export interface AuditProfanity { lexiconVersion:string; language:'en-explicit-lexicon'; measurementBasis:string; eligiblePrompts:number; occurrences:AuditMetric; containingPrompts:AuditMetric; buckets:readonly {kind:AuditProseKind;occurrences:number;containingPrompts:number}[]; coverageGaps:readonly string[]; matches?:readonly {term:string;kind:AuditProseKind;promptId:string;conversationId:string;startUtf16:number;endUtf16:number;route:AuditEvidenceRoute}[]; }
export type AuditRawAnswer = { type:'choice'; choice: string; probabilities: Readonly<Record<string,number>>; confidence:number }|{ type:'noul'; noul:number }|{ type:'score'; score:number; legend: Readonly<Record<string,string>>; probabilities:Readonly<Record<string,number>>; confidence:number };
export interface AuditPromptJudgment { promptId: string; conversationId: string; sourceRoute: AuditEvidenceRoute; contentHash:string; scopeHash:string; normalizationVersion:string; questionVersion:string; questionDefinitions?:Readonly<Record<string,unknown>>; model:string; answers:Readonly<Record<string,AuditRawAnswer>>; windowCoverage:'complete'|'truncated'|'partial'; primaryIntent:AuditIntent|null; abstained:boolean; }
export interface AuditUsage { state: Availability; inputTokens: number|null; outputTokens: number|null; cacheTokens: number|null; reasoningTokens: number|null; costUsd: number|null; measurementBasis: string|null; inclusion: string|null; priceVersion: string|null; }
export interface AuditWorkBar { label: string; count: number; denominator: number; state: Availability; }
export interface AuditSemantics { state: 'not_run'|'no_key'|'running'|'partial'|'complete'|'cancelled'|'error'; qualified: boolean; model: string|null; classifiedPrompts: number; eligiblePrompts: number; uncertainPrompts: number; unclassifiedPrompts?:number; work: readonly AuditWorkBar[]; requestCount: number; cacheHits: number; estimatedCostUsd: number|null; reportedCostUsd: number|null; unresolvedCostUsd: number|null; errorCode: string|null; }
export interface AuditSnapshot {
  schemaVersion: 'audit-v1'; snapshotId: string; sequence: number; measuredAt: string; commitment?:string;
  scope: AuditScope; status: AuditState; coverage: AuditCoverage; progress: AuditProgress;
  sourceEpochs?: Epochs|null;
  metrics: { conversations: AuditMetric; humanPrompts: AuditMetric; projects: AuditMetric; linkedChildren: AuditMetric; };
  sources: readonly AuditSourceCapability[]; projects: readonly AuditProject[];
  activity: readonly AuditActivityBucket[]; conversations: readonly AuditConversation[];
  insights: readonly AuditInsight[]; usage: AuditUsage; semantics: AuditSemantics;
  phrases?: readonly AuditPhrase[]; judgments?: readonly AuditPromptJudgment[];
  profanity?:AuditProfanity;
  warnings: readonly string[];
}
export type AuditEvent = { type: 'snapshot'; snapshot: AuditSnapshot }|{ type:'progress'; snapshotId: string; sequence: number; progress: AuditProgress; sources: readonly AuditSourceCapability[] }|{ type:'error'; snapshotId:string; code: string; message: string };
export interface AuditOverviewOptions {
  claudeDir?: string; codexDir?: string; piDir?: string; opencodeDir?: string; potsherdDir?: string;
  harnesses?: readonly AuditHarness[]; project?: string; since?: string; until?: string; timezone?: string;
  signal?: AbortSignal; maxSourceBytes?: number; maxCandidates?: number; maxTotalBytes?:number; maxPrompts?:number; maxRecordsPerSource?:number;
  /** Frozen checkpoint allocation bound for this session only; default64MiB,100bytes..256MiB. */
  maxStoreBytes?: number;
}
export interface AuditSemanticSelection { conversationIds: readonly string[]; maxPrompts: number; maxRequests: number; budgetUsd: number; consent: true; confidenceThreshold?:number; signal?: AbortSignal; }
export interface AuditSemanticPreview { snapshotId:string; model:string; selectedConversations:number; eligiblePrompts:number; selectedPrompts:number; maxRequests:number; budgetUsd:number; estimatedReservationUsd:number; keyAvailable:boolean; outgoingFields:readonly string[]; windowCoverage:'partial'|'truncated'; samples:readonly {promptId:string;excerpt:string}[]; gapCodes:readonly string[]; }
export interface AuditSession {
  run(onEvent?: (event: AuditEvent)=>void): Promise<AuditSnapshot>;
  snapshot(): AuditSnapshot;
  cancel(): void;
  prompts(conversationId: string, offset?: number, limit?: number): Promise<AuditPromptPage>;
  evidence(route: AuditEvidenceRoute): Promise<AuditEvidence>;
  preview?(selection: Omit<AuditSemanticSelection,'consent'>):Promise<AuditSemanticPreview>;
  classify(selection: AuditSemanticSelection, onEvent?: (event: AuditEvent)=>void): Promise<AuditSnapshot>;
  dispose(): void;
}
