import {createHash} from 'node:crypto';
import {pricingSnapshot} from './model-pricing-snapshot.js';
import type {CatalogRate,LaunchFacts,ModelAggregate,PricingBasis,RecordedInference,ValuedInference} from './launch-contracts.js';
export interface CatalogEntry {provider:string;id:string;canonical:string|null;rates:Readonly<Record<string,number>>;tiers?:readonly {threshold:number;rates:Readonly<Record<string,number>>}[];}
export interface ModelCatalog {basis:PricingBasis;models:readonly CatalogEntry[];}
export const bundledModelCatalog:ModelCatalog=pricingSnapshot;
const valid=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
/** External refreshed snapshots must pass validation before replacing the offline basis. */
export function validateModelCatalog(value:unknown):value is ModelCatalog {
 if(!value||typeof value!=='object')return false;const c=value as ModelCatalog;
 if(!c.basis||!Number.isFinite(Date.parse(c.basis.retrievedAt))||!/^https:\/\//.test(c.basis.source)||!/^[a-f0-9]{64}$/.test(c.basis.sha256)||!Array.isArray(c.models))return false;
 const ids=new Set<string>();for(const m of c.models){if(!m||typeof m.provider!=='string'||!m.provider||typeof m.id!=='string'||!m.id||(m.canonical!==null&&typeof m.canonical!=='string')||!m.rates||typeof m.rates!=='object')return false;const id=JSON.stringify([m.provider,m.id]);if(ids.has(id))return false;ids.add(id);
  if(Object.entries(m.rates).some(([k,v])=>!['input','output','cache_read','cache_write','reasoning'].includes(k)||!valid(v)))return false;
  if(m.tiers!==undefined&&(!Array.isArray(m.tiers)||m.tiers.some((t:{threshold:number;rates:Readonly<Record<string,number>>})=>!Number.isSafeInteger(t.threshold)||t.threshold<0||!t.rates||Object.values(t.rates).some(v=>!valid(v)))))return false;
 }
 return createHash('sha256').update(JSON.stringify(c.models)).digest('hex')===c.basis.sha256;
}
/** Exact aliases only. No cross-provider fallback, revision stripping or fuzzy lookup. */
const providerAliases:Readonly<Record<string,string>>={'google-vertex-ai':'google-vertex','openai-codex':'openai','opencode-zen':'opencode'};
export function resolveCatalogModel(provider:string|null,model:string|null,catalog:ModelCatalog=bundledModelCatalog):CatalogEntry|null {
 if(!provider||!model)return null;const exact=providerAliases[provider]??provider;return catalog.models.find(m=>m.provider===exact&&m.id===model)??null;
}
/** Metadata may be unambiguous without establishing a serving endpoint or its price. */
export function resolveCanonicalModel(provider:string|null,model:string|null,catalog:ModelCatalog=bundledModelCatalog):string|null {
 const entry=resolveCatalogModel(provider,model,catalog);if(entry)return entry.canonical??`${entry.provider}/${entry.id}`;if(provider!==null||model===null)return null;
 const matches=catalog.models.filter(m=>m.id===model);if(!matches.length||matches.some(m=>m.canonical===null))return null;const identities=new Set(matches.map(m=>m.canonical));return identities.size===1?matches[0]!.canonical:null;
}
function normalizedRates(r:Readonly<Record<string,number>>):CatalogRate{return {input:r.input??null,output:r.output??null,cacheRead:r.cache_read??null,cacheWrite:r.cache_write??null,reasoning:r.reasoning??null};}
/** Integer atto-USD arithmetic retains tiny published rates; round only at display. */
function amount(tokens:number,rate:number):bigint {
 const [mantissa,exponent='0']=String(rate).toLowerCase().split('e'),parts=mantissa!.split('.');const digits=BigInt(parts.join('')),shift=12+Number(exponent)-(parts[1]?.length??0);const units=shift>=0?digits*10n**BigInt(shift):digits/10n**BigInt(-shift);return BigInt(tokens)*units;
}
export const approvedFirstPartyReferences:Readonly<Record<string,{provider:string;model:string}>>=Object.freeze(Object.fromEntries([
 'claude-opus-4-8','claude-fable-5','claude-opus-5','claude-haiku-4-5-20251001','claude-sonnet-5',
].map(model=>[model,Object.freeze({provider:'anthropic',model})])));
export interface ValuationOptions {localReferences?:Readonly<Record<string,{provider:string;model:string}>>;approvedFirstPartyReferences?:Readonly<Record<string,{provider:string;model:string}>>;}

export function valueInference(record:RecordedInference,catalog:ModelCatalog=bundledModelCatalog,options:ValuationOptions={}):ValuedInference {
 const gaps=[...record.gaps];const local=record.provider==='local'||record.provider==='ollama'||record.provider==='llama.cpp';
 const firstPartyCandidate=record.provider===null&&record.model!==null?(options.approvedFirstPartyReferences??approvedFirstPartyReferences)[record.model]:undefined;
 // Only the five approved exact identities can use this default reference. An observed endpoint never receives a fallback.
 const firstParty=firstPartyCandidate&&record.model!==null&&approvedFirstPartyReferences[record.model]&&firstPartyCandidate.provider==='anthropic'&&firstPartyCandidate.model===record.model?firstPartyCandidate:undefined;
 const reference=local?options.localReferences?.[`${record.provider}/${record.model}`]:firstParty;
 const referenceBasis=local&&reference?'explicit_local_hosted_reference':firstParty?'approved_anthropic_first_party':null;

 const entry=reference?resolveCatalogModel(reference.provider,reference.model,catalog):resolveCatalogModel(record.provider,record.model,catalog);
 const unknown=()=>({record,valueUsd:null,referenceValueUsd:null,referenceProvider:null,referenceModel:null,referenceBasis:null,provider:record.provider,canonicalModel:record.canonicalModel??resolveCanonicalModel(record.provider,record.model,catalog),rates:null,gaps:[...gaps,local?'local_reference_unavailable':'catalog_model_unmatched']});
 if(!entry||(local&&!reference))return unknown();
 let canonicalModel=entry.canonical??`${entry.provider}/${entry.id}`;
 if(firstParty){
  const knownCanonical=new Set(catalog.models.filter(m=>m.id===record.model&&m.canonical!==null).map(m=>m.canonical));
  const agreed=knownCanonical.size===1?[...knownCanonical][0]!:null;
  if(knownCanonical.size>1||(entry.canonical!==null&&agreed!==null&&entry.canonical!==agreed))return {...unknown(),gaps:[...gaps,'first_party_reference_canonical_conflict']};
  canonicalModel=entry.canonical??agreed??`anthropic/${entry.id}`;
  if(record.canonicalModel!==null&&record.canonicalModel!==canonicalModel)return {...unknown(),gaps:[...gaps,'first_party_reference_canonical_conflict']};
 }
 if(local&&reference&&((record.canonicalModel!==null&&record.canonicalModel!==entry.canonical)||(record.canonicalModel===null&&record.model!==entry.id)))return {...unknown(),gaps:[...gaps,'local_reference_model_mismatch']};let raw=entry.rates;
 const input=record.inputTokens,output=record.outputTokens,read=record.cacheReadTokens,write=record.cacheWriteTokens,reasoning=record.reasoningTokens;
 const context=input===null?null:record.inputIncludesCache?input:read===null||write===null?null:input+read+write;
 if(entry.tiers?.length){if(context===null)gaps.push('context_tier_evidence_missing');else for(const tier of [...entry.tiers].sort((a,b)=>a.threshold-b.threshold))if(context>tier.threshold)raw={...raw,...tier.rates};}
 const rates=normalizedRates(raw);let complete=input!==null&&output!==null&&!gaps.includes('context_tier_evidence_missing')&&!gaps.includes('response_identity_model_conflict')&&!gaps.includes('cache_write_duration_unknown')&&!gaps.includes('cache_exceeds_input')&&!gaps.includes('reasoning_exceeds_output');let nano=0n;
 const add=(n:number|null,r:number|null,field:string)=>{if(n===0)return;if(n===null){complete=false;gaps.push(`${field}_tokens_unknown`);return;}if(r===null){complete=false;gaps.push(`${field}_rate_unknown`);return;}nano+=amount(n,r);};
 let plainInput=input,plainOutput=output;
 if(record.inputIncludesCache){if(input===null||read===null||write===null){complete=false;gaps.push('cache_inclusion_unknown');}else{plainInput=input-read-write;if(plainInput<0){complete=false;gaps.push('cache_exceeds_input');}}}
 if(record.outputIncludesReasoning){if(rates.reasoning!==null&&rates.reasoning!==rates.output){if(output===null||reasoning===null){complete=false;gaps.push('reasoning_inclusion_unknown');}else{plainOutput=output-reasoning;if(plainOutput<0){complete=false;gaps.push('reasoning_exceeds_output');}add(reasoning,rates.reasoning,'reasoning');}}}
 else add(reasoning,rates.reasoning??rates.output,'reasoning');
 add(plainInput,rates.input,'input');add(plainOutput,rates.output,'output');add(read,rates.cacheRead,'cache_read');add(write,rates.cacheWrite,'cache_write');
 const value=complete?Number(nano)/1e18:null;
 return {record,valueUsd:reference?null:value,referenceValueUsd:reference?value:null,referenceProvider:reference?.provider??null,referenceModel:reference?.model??null,referenceBasis,provider:record.provider,canonicalModel,rates,gaps:[...new Set([...gaps,...(local?['local_hosted_reference_value']:[]),...(firstParty?['approved_anthropic_first_party_reference_value','recorded_endpoint_unknown']:[])])]};
}
export function aggregateLaunchFacts(input:readonly RecordedInference[],catalog:ModelCatalog=bundledModelCatalog,options:ValuationOptions={}):LaunchFacts {
 const seen=new Set<string>(),records=input.filter(r=>{if(seen.has(r.id))return false;seen.add(r.id);return true;});const valued=records.map(r=>valueInference(r,catalog,options));
 const groups=new Map<string,ValuedInference[]>();for(const v of valued){const id=v.canonicalModel?`canonical:${v.canonicalModel}`:JSON.stringify([v.provider,v.record.model]);const group=groups.get(id)??[];group.push(v);groups.set(id,group);}
 const sum=(vs:readonly ValuedInference[],field:'inputTokens'|'outputTokens')=>{const values=vs.map(v=>v.record[field]);return values.every(n=>n!==null)?values.reduce<number>((a,b)=>a+(b??0),0):null;};
 const total=(v:ValuedInference):number|null=>{const r=v.record;if(r.inputTokens===null||r.outputTokens===null)return null;if(!r.inputIncludesCache&&(r.cacheReadTokens===null||r.cacheWriteTokens===null))return null;if(!r.outputIncludesReasoning&&r.reasoningTokens===null)return null;return r.inputTokens+r.outputTokens+(r.inputIncludesCache?0:(r.cacheReadTokens??0)+(r.cacheWriteTokens??0))+(r.outputIncludesReasoning?0:r.reasoningTokens??0);};
 const overall=valued.map(total),totalKnown=overall.filter((n):n is number=>n!==null).reduce((a,b)=>a+b,0),conversations=new Set(records.map(r=>r.conversationId)).size;
 const money=(vs:readonly ValuedInference[],key:'valueUsd'|'referenceValueUsd')=>{const known=vs.map(v=>v[key]).filter((n):n is number=>n!==null);return known.length?known.reduce((a,b)=>a+b,0):null;};
 const models:ModelAggregate[]=[...groups].map(([id,vs])=>{const totals=vs.map(total),tokens=totals.every(n=>n!==null)?totals.reduce<number>((a,b)=>a+(b??0),0):null,participation=new Set(vs.map(v=>v.record.conversationId)).size;const knownTokens=totals.filter((n):n is number=>n!==null).reduce((a,b)=>a+b,0);const tokenShare=totalKnown>0&&totals.some(n=>n!==null)?knownTokens/totalKnown:null;const conversationShare=conversations?participation/conversations:0;const endpoints=new Set(vs.map(v=>v.provider)),names=new Set(vs.map(v=>v.record.model));return {id,provider:endpoints.size===1?vs[0]!.provider:null,model:names.size===1?vs[0]!.record.model:vs[0]!.canonicalModel,canonicalModel:vs[0]!.canonicalModel,inputTokens:sum(vs,'inputTokens'),outputTokens:sum(vs,'outputTokens'),totalTokens:tokens,knownTokens,conversations:participation,tokenShare,conversationShare,favouriteScore:tokenShare===null?null:(tokenShare+conversationShare)/2,valueUsd:money(vs,'valueUsd'),referenceValueUsd:money(vs,'referenceValueUsd'),gaps:[...new Set([...vs.flatMap(v=>v.gaps),...(endpoints.size>1?['multiple_serving_endpoints']:[]),...(overall.some(n=>n===null)?['token_share_known_portion_only']:[])])]};});
 models.sort((a,b)=>(b.favouriteScore??-1)-(a.favouriteScore??-1)||b.conversations-a.conversations||a.id.localeCompare(b.id));
 const priced=valued.filter(v=>v.valueUsd!==null).length,referencePricedResponses=valued.filter(v=>v.referenceValueUsd!==null).length,equivalentPricedResponses=valued.filter(v=>v.valueUsd!==null||v.referenceValueUsd!==null).length;
 const referenceGroups=new Map<string,{provider:string;model:string;basis:string;pricedResponses:number;valueUsd:number}>();for(const v of valued){if(v.referenceValueUsd===null||!v.referenceProvider||!v.referenceModel||!v.referenceBasis)continue;const key=JSON.stringify([v.referenceProvider,v.referenceModel,v.referenceBasis]);const group=referenceGroups.get(key)??{provider:v.referenceProvider,model:v.referenceModel,basis:v.referenceBasis,pricedResponses:0,valueUsd:0};group.pricedResponses++;group.valueUsd+=v.referenceValueUsd;referenceGroups.set(key,group);}
 return {records,models,referencePricedResponses,equivalentPricedResponses,referenceProviders:[...referenceGroups.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model)),favourite:models.find(m=>m.favouriteScore!==null&&m.model!==null)??null,valueUsd:money(valued,'valueUsd'),referenceValueUsd:money(valued,'referenceValueUsd'),pricing:catalog.basis,recordedResponses:records.length,knownTokenResponses:valued.filter(v=>total(v)!==null).length,pricedResponses:priced,unknownModelResponses:records.filter(r=>r.model===null).length,gaps:[...new Set([...valued.flatMap(v=>v.gaps),...(priced<records.length?['pricing_coverage_partial']:[]),...(equivalentPricedResponses<records.length?['equivalent_pricing_coverage_partial']:[])])]};
}
