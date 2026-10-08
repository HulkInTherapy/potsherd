import {createHash} from 'node:crypto';
import {auditProfanity,proseLabels,LEXICON_HINT} from './profanity.js';
const POSITIVE_HINT=/good (?:work|job)|well done|you understood|you (?:got|nailed)|you(?:['’]re| are)/i;
const POSITIVE=/\b(?:good (?:work|job)|well done|you understood (?:me|it)|you (?:got|nailed) (?:it|this)|you(?:['’]re| are) (?:fucking )?(?:great|awesome))\b/iu;
const NEGATED=/\b(?:not|never|don['’]?t|didn['’]?t|no)\b.{0,35}\b(?:good|well done|understood|nailed|great|awesome)\b/iu;
const NEGATIVE=/\b(?:wrong|broken|stupid|missed|failed|why|mess|didn['’]?t|not|bullshit|fuck(?:ed|ing)? (?:up|off))\b/iu;
const YOU=/\b(?:you|your|you['’]re)\b/iu;
import type {AuditLangLine,AuditPrompt,AuditPromptLex} from './contracts.js';
import type {ContextRecord,AuditLanguageLine,AuditModelFeedback} from './launch-contracts.js';
export type ProfaneLine=AuditLanguageLine;
export type ModelFeedback=AuditModelFeedback;
const words=(s:string)=>s.match(/[\p{L}\p{N}]+/gu)?.length??0;

/** Models (of the prompt's conversation) named in its prose: whole first occurrence, prose label, not part of a longer identifier. */
export function namedModels(text:string,models:Iterable<string>):string[]{
 const out:string[]=[];let labels:Uint8Array|null=null;
 for(const model of models){const at=text.indexOf(model);if(at<0)continue;labels??=proseLabels(text);if(labels[at]!==0||/[\p{L}\p{N}_/-]/u.test(text[at-1]??'')||/[\p{L}\p{N}_/-]/u.test(text[at+model.length]??''))continue;out.push(model);}
 return out;
}

/**
 * Per-line lexical facts for the directed-language summary. Only lines with a
 * lexicon word or praise wording are kept; the rest cannot change any result.
 */
export function languageLines(text:string):AuditLangLine[]{
 const out:AuditLangLine[]=[];let labelCache:Uint8Array|null=null;const L=(i:number)=>(labelCache??=proseLabels(text))[i];let offset=0;
 for(const line of text.split('\n')){const start=offset;offset+=line.length+1;const trimmed=line.trim();if(!trimmed)continue;const at=start+line.indexOf(trimmed),end=at+trimmed.length;
  if(!LEXICON_HINT.test(trimmed)&&!POSITIVE_HINT.test(trimmed))continue;
  // Classify this exact line independently so quotes/code never become feedback.
  const probe={id:'line',conversationId:'',role:'user' as const,originBasis:'claude_prompt_id' as const,identityBasis:'',eligibleHuman:true,excludedReason:null,eventAt:null,route:{basis:'canonical' as const,refs:[],scope:{} as never}};
  const local=auditProfanity([{...probe,text:line}]);const direct=local.terms?.some(t=>t.kind==='direct_prose'&&t.samples.some(sample=>L(start+sample.startUtf16)===0))??false;const nonprose=local.terms?.some(t=>t.kind!=='direct_prose')??false;
  const positiveMatch=trimmed.match(POSITIVE),positive=!!positiveMatch&&L(at+(positiveMatch.index??0))===0,negated=NEGATED.test(trimmed);
  const quoted=L(at)!==0||/^\s*(?:>|[`~]{3}|["“'])/u.test(line)||/^ {4}|^\t/u.test(line);
  const row:AuditLangLine={};if(direct)row.d=1;if(nonprose)row.np=1;if(YOU.test(trimmed))row.y=1;if(positive)row.p=1;if(negated)row.ng=1;if(quoted)row.q=1;if(NEGATIVE.test(trimmed))row.n=1;
  if(direct&&!quoted&&words(trimmed)>=2){
   const spans=trimmed.length<=160?[{text:trimmed,start:at,end}]:[...trimmed.matchAll(/[^.!?;\n]+[.!?;]?/gu)].map(match=>{const value=match[0].trim(),begin=at+match.index!+match[0].indexOf(value);return {text:value,start:begin,end:begin+value.length};}).filter(span=>span.text.length<=160&&words(span.text)>=2&&auditProfanity([{...probe,text:span.text}]).terms?.some(t=>t.kind==='direct_prose'&&L(span.start+t.samples[0]!.startUtf16)===0));
   if(spans.length)row.sp=spans.map(s=>[s.text,s.start,s.end] as const);else row.ns=1;
  }
  out.push(row);
 }
 return out;
}

/** Explicit lexical feedback, not inferred sentiment, authorship or coding quality. */
export function summarizeDirectedLanguage(prompts:readonly AuditPrompt[],records:readonly ContextRecord[]):{languageLines:ProfaneLine[];modelFeedback:ModelFeedback[];languageGaps:string[]}{
 const conversationModels=new Map<string,Map<string,Set<string|null>>>(),seenRecords=new Set<string>();const preceding=new Map<string,{model:string|null;provider:string|null}>(),groups=new Map<string,ContextRecord[]>();
 for(const r of records){const unique=`${r.conversationId}\0${r.project}\0${r.role}\0${r.id}`;if(seenRecords.has(unique))continue;seenRecords.add(unique);if(r.role==='assistant'&&r.model){const names=conversationModels.get(r.conversationId)??new Map<string,Set<string|null>>(),providers=names.get(r.model)??new Set<string|null>();providers.add(r.provider);names.set(r.model,providers);conversationModels.set(r.conversationId,names);}const key=`${r.conversationId}\0${r.project}`;const rows=groups.get(key)??[];rows.push(r);groups.set(key,rows);}
 for(const rows of groups.values()){let models=new Map<string,{model:string|null;provider:string|null}>();for(const r of rows){if(r.role==='user'){preceding.set(r.id,models.size===1?[...models.values()][0]!:{model:null,provider:null});models=new Map();}else if(r.role==='assistant')models.set(JSON.stringify([r.model,r.provider]),{model:r.model,provider:r.provider});}}
 const lines=new Map<string,{text:string;count:number;ids:Set<string>;models:Map<string,{provider:string|null;model:string|null;occurrences:number}>;samples:ProfaneLine['samples'][number][]}>(),feedback=new Map<string,{model:string|null;provider:string|null;negative:Set<string>;praise:Set<string>;associated:Set<string>;ids:Set<string>}>,gaps=new Set<string>(['lexical_directed_feedback_only','unknown_authorship_not_universally_attested']);
 const rowFor=(owner:{model:string|null;provider:string|null})=>{const key=JSON.stringify(owner);let row=feedback.get(key);if(!row){row={...owner,negative:new Set<string>(),praise:new Set<string>(),associated:new Set<string>(),ids:new Set<string>()};feedback.set(key,row);}return row;};
 for(const prompt of prompts){
  if(prompt.languageEligible===false||!(prompt.eligibleNativeInput??prompt.eligibleHuman))continue;
  const models=conversationModels.get(prompt.conversationId)??new Map<string,Set<string|null>>();
  const lex:AuditPromptLex=prompt.lex??{nm:namedModels(prompt.text,models.keys()),ll:languageLines(prompt.text)};
  const named=(lex.nm??[]).filter(m=>models.has(m));
  let owner=preceding.get(prompt.id)??{model:null,provider:null};
  if(named.length===1){const providers=models.get(named[0]!)!;owner={model:named[0]!,provider:providers.size===1?[...providers][0]!:null};}
  if(!preceding.has(prompt.id))gaps.add('language_context_capture_partial');
  if(owner.model)rowFor(owner).associated.add(prompt.id);
  let negative=false,praise=false;
  for(const line of lex.ll??[]){
   const explicitNegative=(named.length===1||!!line.y)&&!!line.d&&!line.p&&!!line.n;
   if(!line.q&&!line.np){negative||=explicitNegative;praise||=!!line.p&&!line.ng;}
   if(line.ns)gaps.add('long_profane_lines_not_displayed');
   for(const [text,start,end] of line.sp??[]){
    const key=text.toLocaleLowerCase('en').replace(/\s+/gu,' ').replace(/[\p{P}]+$/gu,'').trim(),item=lines.get(key)??{text,count:0,ids:new Set(),models:new Map(),samples:[] as ProfaneLine['samples'][number][]};item.count++;item.ids.add(prompt.id);if(item.samples.length<3)item.samples.push({promptId:prompt.id,conversationId:prompt.conversationId,startUtf16:start,endUtf16:end,route:prompt.route});
    if(explicitNegative&&!line.q&&!line.np&&owner.model){const k=JSON.stringify(owner),row=item.models.get(k)??{...owner,occurrences:0};row.occurrences++;item.models.set(k,row);}lines.set(key,item);
   }
  }
  if((negative||praise)&&owner.model){const row=rowFor(owner);if(negative)row.negative.add(prompt.id);if(praise)row.praise.add(prompt.id);row.ids.add(prompt.id);}else if(negative||praise)gaps.add('feedback_model_unattributed');
 }
 return {languageLines:[...lines.entries()].map(([key,row])=>({id:createHash('sha256').update(key).digest('hex').slice(0,20),text:row.text,occurrences:row.count,containingInputs:row.ids.size,models:[...row.models.values()].sort((a,b)=>b.occurrences-a.occurrences),samples:row.samples})).sort((a,b)=>b.occurrences-a.occurrences||a.text.localeCompare(b.text)).slice(0,6),modelFeedback:[...feedback.values()].map(row=>({provider:row.provider,model:row.model,associatedInputs:row.associated.size,directedNegativeInputs:row.negative.size,praiseInputs:row.praise.size,promptIds:[...row.ids].slice(0,12)})).sort((a,b)=>b.directedNegativeInputs-a.directedNegativeInputs||b.praiseInputs-a.praiseInputs||(a.model??'').localeCompare(b.model??'')),languageGaps:[...gaps]};
}
