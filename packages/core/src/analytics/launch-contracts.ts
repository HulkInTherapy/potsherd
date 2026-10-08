/** Terminal launch contracts. Facts and judgments carry independent coverage. */
import type {AuditHarness,AuditRawAnswer,AuditIntent,AuditEvidenceRoute} from './contracts.js';

export interface RecordedInference {
 id:string;conversationId:string;harness:AuditHarness;eventAt:string|null;project:string|null;
 provider:string|null;model:string|null;canonicalModel:string|null;
 inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;cacheWrite5mTokens?:number|null;cacheWrite1hTokens?:number|null;reasoningTokens:number|null;
 inputIncludesCache:boolean;outputIncludesReasoning:boolean;reportedCostUsd:number|null;
 basis:string;gaps:readonly string[];
}
export interface CatalogRate {input:number|null;output:number|null;cacheRead:number|null;cacheWrite:number|null;reasoning:number|null;}
export interface PricingBasis {retrievedAt:string;sha256:string;source:string;}
export interface ValuedInference {record:RecordedInference;valueUsd:number|null;referenceValueUsd:number|null;provider:string|null;canonicalModel:string|null;rates:CatalogRate|null;referenceProvider:string|null;referenceModel:string|null;referenceBasis:string|null;gaps:readonly string[];}
export interface ModelAggregate {id:string;provider:string|null;model:string|null;canonicalModel:string|null;inputTokens:number|null;outputTokens:number|null;totalTokens:number|null;knownTokens?:number;conversations:number;tokenShare:number|null;conversationShare:number;favouriteScore:number|null;valueUsd:number|null;referenceValueUsd:number|null;gaps:readonly string[];
 /** De-duplicated responses. */ responses?:number;
 cacheReadTokens?:number;cacheWriteTokens?:number;/** Included in outputTokens. */reasoningTokens?:number;
 harnesses?:readonly AuditHarness[];
 /** Catalog model the price came from; differs from `model` when estimated. */ pricedAs?:string|null;
 /** True when the price is the closest family member's, not the exact model's. */ estimated?:boolean;}
export interface LaunchFacts {/** False for progressive summaries; final snapshots carry the complete captured record set. */recordsIncluded?:boolean;records:readonly RecordedInference[];models:readonly ModelAggregate[];favourite:ModelAggregate|null;valueUsd:number|null;referenceValueUsd:number|null;pricing:PricingBasis;recordedResponses:number;knownTokenResponses:number;pricedResponses:number;referencePricedResponses:number;equivalentPricedResponses:number;referenceProviders:readonly {provider:string;model:string;basis:string;pricedResponses:number;valueUsd:number}[];unknownModelResponses:number;gaps:readonly string[];
 /** API-equivalent cost per harness. */ costByHarness?:Readonly<Partial<Record<AuditHarness,number>>>;
 /** Part of valueUsd priced from a closest-family model. */ estimatedValueUsd?:number;
 /** Codex remote-compaction requests included in recordedResponses. */ compactionResponses?:number;
 cacheReadTokens?:number;cacheWriteTokens?:number;}
export interface ContextRecord {id:string;conversationId:string;parentId:string|null;harness:AuditHarness;eventAt:string|null;project:string|null;role:'user'|'assistant'|'tool';text:string;model:string|null;provider:string|null;directUser:boolean;route:AuditEvidenceRoute|null;}
export interface ContextSegment {id:string;conversationId:string;parentId:string|null;project:string|null;eventFrom:string|null;eventTo:string|null;records:readonly ContextRecord[];promptIds:readonly string[];coverage:'complete'|'partial';gaps:readonly string[];contentHash:string;}
export type SemanticPeriod='all'|45|30|7|3;
export interface WindowEstimate {period:SemanticPeriod;from:string|null;until:string;segments:number;estimatedInputTokens:number;estimatedLatencyMs:number;fits:boolean;reason:string|null;selection?:{kind:'newest_episodes';segmentIds:readonly string[];available:number;selected:number;eventFrom:string|null;eventTo:string|null;gaps:readonly string[]};}
export interface SemanticWindow {selected:WindowEstimate|null;choices:readonly WindowEstimate[];tokenLimit:number;reason:string|null;}
export interface LaunchStory {id:string;conversationId:string;project:string|null;intent:AuditIntent|null;outcome:'attempted'|'assistant_reported'|'supported'|'uncertain';caption:string;quote:string|null;promptIds:readonly string[];confidence:number|null;}
export type AuditTone='elegant'|'witty'|'chaotic'|'roast';
export interface LaunchJudgment {segmentId:string;conversationId:string;model:string;answers:Readonly<Record<string,AuditRawAnswer>>;contentHash:string;questionVersion:string;}
export interface LaunchSemantics {state:'pending'|'complete'|'partial'|'unavailable'|'cancelled';recipientNotice:string;model:string|null;window:SemanticWindow;stories:readonly LaunchStory[];hallOfFame:readonly LaunchStory[];work:readonly {label:string;count:number}[];tone:AuditTone;judgments:readonly LaunchJudgment[];attempts:number;cacheHits:number;inputTokens:number;outputTokens:number;reservedTokens?:number;gaps:readonly string[];}
export interface AuditLanguageLine {id:string;text:string;occurrences:number;containingInputs:number;models:readonly {provider:string|null;model:string|null;occurrences:number}[];samples:readonly {promptId:string;conversationId:string;startUtf16:number;endUtf16:number;route:AuditEvidenceRoute}[];}
/** Lexical observed reactions, not objective model quality or general sentiment. */
export interface AuditModelFeedback {provider:string|null;model:string|null;directedNegativeInputs:number;praiseInputs:number;associatedInputs:number;promptIds:readonly string[];}
/** Facts contain completed eligible sources; collecting values may be repriced as aliases are resolved. */
export interface LaunchFactProgress {
 state:'collecting'|'complete';completedSources:number;totalSources:number|null;cacheHits:number;
 /** Exact completed-source subset represented by the currently published prices; undefined means completedSources. */
 representedSources?:number;
 coverage:'completed_sources';origin:'fresh'|'cache'|'mixed';
}
export interface LaunchAudit {factProgress?:LaunchFactProgress;languageLines?:readonly AuditLanguageLine[];modelFeedback?:readonly AuditModelFeedback[];languageGaps?:readonly string[];languageByModel?:readonly import('./language-models.js').ModelLanguage[];facts:LaunchFacts|null;semantics:LaunchSemantics|null;stage:'discovering'|'sizing'|'preparing'|'analyzing'|'assembling'|'ready';notice:string;}
