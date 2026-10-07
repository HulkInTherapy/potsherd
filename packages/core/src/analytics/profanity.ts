import type {AuditProfanity,AuditPrompt,AuditProseKind,AuditWordTerm} from './contracts.js';

/** Exact v1 lexicon: fuck,fucked,fucking,shit,shitty,bullshit,asshole,bastard.
 * Literal English matches only; no language detection, mood or intent inference.
 */
export const ENGLISH_EXPLICIT_LEXICON=Object.freeze(['fuck','fucked','fucking','shit','shitty','bullshit','asshole','bastard'] as const);
export const PROFANITY_LEXICON_VERSION='en-explicit-8-v1';
const words=new Set<string>(ENGLISH_EXPLICIT_LEXICON);
const CODE=2,QUOTE=1,UNKNOWN=3;
const kind=(label:number):AuditProseKind=>label===CODE?'code':label===QUOTE?'quoted':label===UNKNOWN?'unknown':'direct_prose';
const escaped=(text:string,index:number)=>{let count=0;for(let i=index-1;i>=0&&text[i]==='\\';i--)count++;return count%2===1;};
const wordChar=(char:string|undefined)=>char!==undefined&&/[\p{L}\p{N}\p{M}_\u200c\u200d]/u.test(char);

/** Conservative textual spans, not a claim to parse every language or Markdown dialect. */
function labels(text:string):{labels:Uint8Array;ambiguous:boolean}{
 const map=new Uint8Array(text.length);let ambiguous=false,offset=0,fence:{char:string;length:number;start:number}|null=null;
 for(const line of text.split(/(?<=\n)/u)){
  const marker=line.match(/^ {0,3}(`{3,}|~{3,})/u);
  if(fence){if(marker&&marker[1]![0]===fence.char&&marker[1]!.length>=fence.length&&line.slice(marker[0].length).trim()===''){map.fill(CODE,fence.start,offset+line.length);fence=null;}}
  else if(marker)fence={char:marker[1]![0]!,length:marker[1]!.length,start:offset};
  else if(/^ {0,3}>/u.test(line))map.fill(QUOTE,offset,offset+line.length);
  else if(/^(?: {4}|\t)\S/u.test(line)){map.fill(UNKNOWN,offset,offset+line.length);ambiguous=true;}
  offset+=line.length;
 }
 if(fence){map.fill(UNKNOWN,fence.start);ambiguous=true;}
 // Explicit imported-source structure is quoted material, not the user's own reaction.
 const sourceRows=text.split(/(?<=\n)/u),timestamp=/^\s*(?:(?:[-*#]+|\*\*)\s*)?\[?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]?/u;
 if(/(?:transcript|captions|youtube|youtu\.be|video transcription)/iu.test(text)&&sourceRows.filter(line=>timestamp.test(line)).length>=3){let at=0;for(const line of sourceRows){if(timestamp.test(line))map.fill(QUOTE,at,at+line.length);at+=line.length;}}

 for(let i=0;i<text.length;i++){
  if(map[i]||escaped(text,i))continue;const char=text[i]!;
  if(char==='`'){
   let count=1;while(text[i+count]==='`')count++;const token='`'.repeat(count);let end=text.indexOf(token,i+count);
   while(end>=0&&(map[end]!==0||text[end-1]==='`'||text[end+count]==='`'))end=text.indexOf(token,end+count);
   if(end<0){map.fill(UNKNOWN,i);ambiguous=true;break;}map.fill(CODE,i,end+count);i=end+count-1;continue;
  }
  if(!['"',"'",'“','‘'].includes(char))continue;
  if((char==="'"||char==='‘')&&wordChar(text[i-1])&&wordChar(text[i+1]))continue;
  const closing=char==='“'?'”':char==='‘'?'’':char;let end=i+1;
  while(end<text.length){if(text[end]===closing&&!escaped(text,end)&&map[end]===0&&!((closing==="'"||closing==='’')&&wordChar(text[end-1])&&wordChar(text[end+1])))break;end++;}
  if(end>=text.length){map.fill(UNKNOWN,i);ambiguous=true;break;}map.fill(QUOTE,i,end+1);i=end;
 }
 return {labels:map,ambiguous};
}
export function proseLabels(text:string):Uint8Array{return labels(text).labels;}
/** Counts already-redacted, immutable eligible inputs; support ranges are redacted-prompt UTF-16. */
export function auditProfanity(prompts:readonly AuditPrompt[],partial=false):AuditProfanity{
 const knownExcluded=new Set(['child_initialization','maintenance_exclusion_marker','tool_result','inherited_native_event','declared_meta_or_synthetic_input','declared_synthetic_input']);
 const eligible=prompts.filter(p=>p.languageEligible!==false).filter(p=>p.eligibleNativeInput===true&&!knownExcluded.has(p.excludedReason??'')||p.eligibleNativeInput===undefined&&p.eligibleHuman&&p.excludedReason===null&&['claude_prompt_id','codex_human_marker'].includes(p.originBasis)),bucketCounts=new Map<AuditProseKind,{occurrences:number;prompts:Set<string>}>((['direct_prose','quoted','code','unknown'] as const).map(k=>[k,{occurrences:0,prompts:new Set<string>()}])),containing=new Set<string>(),matches:NonNullable<AuditProfanity['matches']>[number][]=[];const terms=new Map<string,{term:string;kind:AuditProseKind;occurrences:number;ids:Set<string>;samples:AuditWordTerm['samples'][number][]}>();let occurrences=0,ambiguous=false;
 for(const prompt of eligible){const spans=labels(prompt.text);ambiguous||=spans.ambiguous;const pattern=/[\p{L}\p{N}\p{M}_\u200c\u200d]+(?:['’][\p{L}\p{N}\p{M}_\u200c\u200d]+)*/gu;let token:RegExpExecArray|null;
  while((token=pattern.exec(prompt.text))!==null){if(!words.has(token[0].toLowerCase()))continue;const start=token.index,end=start+token[0].length,bucket=kind(spans.labels[start]??0),counter=bucketCounts.get(bucket)!;occurrences++;containing.add(prompt.id);counter.occurrences++;counter.prompts.add(prompt.id);
   const normalized=token[0].toLowerCase(),key=JSON.stringify([normalized,bucket]);const term=terms.get(key)??{term:normalized,kind:bucket,occurrences:0,ids:new Set<string>(),samples:[]};term.occurrences++;term.ids.add(prompt.id);if(term.samples.length<3)term.samples.push({promptId:prompt.id,conversationId:prompt.conversationId,startUtf16:start,endUtf16:end,route:prompt.route});terms.set(key,term);
   if(matches.length<8)matches.push({term:token[0],kind:bucket,promptId:prompt.id,conversationId:prompt.conversationId,startUtf16:start,endUtf16:end,route:prompt.route});
  }
 }
 const measurementBasis='literal_english_lexicon_observed_native_input_utf16_v2',definition='Literal occurrences of the documented eight-word English lexicon in eligible observed native user-role inputs after existing redaction/elision; this does not attest universal human authorship. Unicode whole-word tokens; containing inputs counted once. No emotion, intent or universal-language inference. Ranges are relative to the immutable redacted containing input; routes identify that input.';
 return {lexiconVersion:PROFANITY_LEXICON_VERSION,language:'en-explicit-lexicon',measurementBasis,eligiblePrompts:eligible.length,occurrences:{value:occurrences,numerator:occurrences,denominator:eligible.length,unit:'english_lexicon_occurrence',measurementBasis,state:partial?'partial':'observed',definition},containingPrompts:{value:containing.size,numerator:containing.size,denominator:eligible.length,unit:'eligible_input_containing_english_lexicon_match',measurementBasis,state:partial?'partial':'observed',definition},buckets:[...bucketCounts].map(([kind,value])=>({kind,occurrences:value.occurrences,containingPrompts:value.prompts.size})),coverageGaps:['outside_english_lexicon_unassessed','hindi_hinglish_and_other_languages_unassessed',...(ambiguous?['ambiguous_quote_or_code_span']:[])],terms:[...terms.values()].map(t=>({term:t.term,kind:t.kind,occurrences:t.occurrences,containingPrompts:t.ids.size,samples:t.samples})).sort((a,b)=>b.occurrences-a.occurrences||a.term.localeCompare(b.term)||a.kind.localeCompare(b.kind)),matches};
}
