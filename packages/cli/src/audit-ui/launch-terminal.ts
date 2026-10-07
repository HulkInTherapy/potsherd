/** Notice-driven consumer terminal. Source bodies are read only through AuditSession. */
import type {AuditEvidence,AuditEvent,AuditPromptPage,AuditSession,AuditSnapshot} from '../../../core/src/analytics/contracts.js';
import type {LaunchStory,ModelAggregate} from '../../../core/src/analytics/launch-contracts.js';
import {auditCellWidth,auditClip,applyAuditEvent} from './index.js';
import type {AuditLine,AuditTerminalOptions,AuditTerminalResult,AuditTone} from './index.js';

export const LAUNCH_SECTIONS=['overview','models','projects','work','hall','language','timeline'] as const;
export type LaunchSection=typeof LAUNCH_SECTIONS[number];
export interface LaunchFrame {section:LaunchSection;view:'section'|'detail'|'prompts'|'evidence'|'periods';selectedId:string|null;selectedIndex:number;scroll:number;detailId:string|null;conversationId:string|null;}
export interface LaunchNavigation extends LaunchFrame {stack:readonly LaunchFrame[];frozen:boolean;}
export interface LaunchGeometry extends AuditTerminalOptions {columns?:number;rows?:number;widthOf?:(text:string)=>number;frame?:number;promptPage?:AuditPromptPage|null;evidence?:AuditEvidence|null;busy?:boolean;notice?:string;}
export interface LaunchRow {id:string;label:string;value:string;kind:'model'|'project'|'story'|'language'|'date'|'period'|'conversation'|'prompt';conversationId?:string;promptIds?:readonly string[];}
const NAMES:Record<LaunchSection,string>={overview:'Overview',models:'Models',projects:'Projects',work:'Work',hall:'Hall of Fame',language:'Language',timeline:'Timeline'};
const SOURCE:Record<string,string>={claude:'Claude Code',codex:'Codex',pi:'pi',opencode:'OpenCode'};
const SOURCE_TONE:Record<string,AuditTone>={claude:'amber',codex:'cyan',pi:'green',opencode:'violet'};
const COLORS:Record<AuditTone,string>={normal:'#e9e8e0',dim:'#819097',amberDim:'#be7337',amber:'#f9ae56',amberLight:'#ffd89b',cyan:'#47d7e2',green:'#79c9a3',violet:'#b29ddb',blue:'#80ade0'};
const format=new Intl.NumberFormat('en-US',{maximumFractionDigits:1});
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
const words=(value:string)=>value.replaceAll('_',' ');
const num=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?'unknown':format.format(value);
const equivalent=(value:{valueUsd:number|null;referenceValueUsd:number|null})=>value.valueUsd===null&&value.referenceValueUsd===null?null:(value.valueUsd??0)+(value.referenceValueUsd??0);
const usd=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?'unknown':money.format(value);
const pct=(value:number|null|undefined)=>value==null?'unknown':`${format.format(value*100)}%`;
const day=(value:string|null|undefined)=>value?.slice(0,10)??'unknown';
function safe(value:string):string{return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'').replace(/[\r\n\t]/g,' ');}
const line=(text:string,tone:AuditTone='normal'):AuditLine=>[{text:safe(text),tone}];
function semanticScope(snapshot:AuditSnapshot):string {const window=snapshot.launch?.semantics?.window.selected;return window?window.selection?`Newest ${window.selection.selected} of ${window.selection.available} episodes · ${window.selection.eventFrom??'unknown'} to ${window.selection.eventTo??'unknown'} UTC · partial calendar coverage`:`${window.period==='all'?'All available history':`${window.period} days`} · ${window.from??'unknown start'} to ${window.until} UTC`:'Recent work · window pending';}
function shortWorkScope(snapshot:AuditSnapshot):string {const window=snapshot.launch?.semantics?.window.selected;if(!window)return 'Work · window pending';if(window.selection){const selected=window.selection,date=selected.eventFrom?new Date(selected.eventFrom):null,label=date&&!Number.isNaN(date.valueOf())?date.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}):'undated';return `Work: ${selected.selected}/${selected.available} episodes · ${label} · partial`;}return `Work: ${window.period==='all'?'all available':`${window.period} days`} · ${snapshot.launch?.semantics?.state??'pending'}`;}
function modelTokens(model:ModelAggregate):string {return model.totalTokens!==null?`${num(model.totalTokens)} tokens`:model.knownTokens!==undefined&&model.knownTokens>0?`${num(model.knownTokens)} known tokens · total unknown`:'tokens unknown';}
function knownTokens(snapshot:AuditSnapshot):number|null {const facts=snapshot.launch?.facts;if(!facts||!facts.knownTokenResponses)return null;const values=facts.models.map(model=>model.knownTokens??model.totalTokens).filter((value):value is number=>value!==null&&value!==undefined);return values.length?values.reduce((sum,value)=>sum+value,0):null;}
function metricCount(metric:AuditSnapshot['metrics']['conversations']):number|null{return metric.state==='not_run'||metric.state==='unavailable'?null:metric.value;}
function pricingLines(snapshot:AuditSnapshot):readonly string[]{const facts=snapshot.launch?.facts;if(!facts)return [];return [`Current catalog ${facts.pricing.retrievedAt} UTC`, `SHA-256 ${facts.pricing.sha256}`,`Source: ${facts.pricing.source} · current rates, not a historical invoice`,`${num(facts.equivalentPricedResponses??facts.pricedResponses)}/${num(facts.recordedResponses)} responses valued · ${num(facts.knownTokenResponses)} with known normalized tokens`];}
function factScope(snapshot:AuditSnapshot):string{return snapshot.scope.eventFrom?`Recorded history · ${day(snapshot.scope.eventFrom)} to ${day(snapshot.scope.asOf??snapshot.measuredAt)}`:'All-time recorded history';}
function outcome(story:LaunchStory):string{return {attempted:'attempted',assistant_reported:'assistant reports success',supported:'supported by results',uncertain:'outcome uncertain'}[story.outcome];}
function modelName(model:ModelAggregate):string{return model.canonicalModel??model.model??'Unknown model';}
function bar(value:number|null,width:number,ascii:boolean):string{if(value===null)return 'unknown';const filled=Math.max(0,Math.min(width,Math.round(value*width)));return (ascii?'#':'━').repeat(filled)+(ascii?'.':'─').repeat(width-filled);}
function spark(values:readonly number[],width:number,ascii:boolean):string{if(!values.length)return 'No recorded dates';const buckets=Array.from({length:Math.min(width,values.length)},(_,i)=>{const start=Math.floor(i*values.length/Math.min(width,values.length)),end=Math.floor((i+1)*values.length/Math.min(width,values.length));return values.slice(start,end).reduce((sum,v)=>sum+v,0);});const max=Math.max(...buckets,1),glyphs=ascii?' .:-=+*#':' ▁▂▃▄▅▆▇█';return buckets.map(v=>glyphs[Math.round(v/max*(glyphs.length-1))]).join('');}

export function createLaunchNavigation(section:LaunchSection='overview'):LaunchNavigation{return {section,view:'section',selectedId:null,selectedIndex:0,scroll:0,detailId:null,conversationId:null,stack:[],frozen:false};}
export function launchPush(nav:LaunchNavigation,next:Partial<LaunchFrame>):LaunchNavigation {const {stack:_stack,frozen:_frozen,...frame}=nav;return {...nav,...next,stack:[...nav.stack,frame],selectedId:null,selectedIndex:0,scroll:0};}
export function launchBack(nav:LaunchNavigation):LaunchNavigation {const frame=nav.stack.at(-1);return frame?{...nav,...frame,stack:nav.stack.slice(0,-1)}:nav;}
export function launchSelectSection(nav:LaunchNavigation,delta:number):LaunchNavigation {const section=LAUNCH_SECTIONS[(LAUNCH_SECTIONS.indexOf(nav.section)+delta+LAUNCH_SECTIONS.length)%LAUNCH_SECTIONS.length]!;return {...createLaunchNavigation(section),frozen:nav.frozen};}
export function launchMove(nav:LaunchNavigation,rows:readonly LaunchRow[],delta:number,visible:number):LaunchNavigation {if(!rows.length)return {...nav,selectedId:null,selectedIndex:0,scroll:0};const found=rows.findIndex(row=>row.id===nav.selectedId),index=Math.max(0,Math.min(rows.length-1,(found>=0?found:nav.selectedIndex)+delta));let scroll=Math.min(nav.scroll,Math.max(0,rows.length-visible));if(index<scroll)scroll=index;else if(index>=scroll+visible)scroll=Math.max(0,index-visible+1);return {...nav,selectedId:rows[index]!.id,selectedIndex:index,scroll};}
export function launchFreeze(nav:LaunchNavigation):LaunchNavigation{return {...nav,frozen:!nav.frozen};}

export function launchRows(snapshot:AuditSnapshot,nav:LaunchNavigation,page:AuditPromptPage|null=null):LaunchRow[]{
 if(nav.view==='periods')return (snapshot.launch?.semantics?.window.choices??[]).map(window=>({id:`period:${window.period}`,label:window.period==='all'?'All available history':`${window.period} days`,value:`${num(window.estimatedInputTokens)} input tokens · ${(window.estimatedLatencyMs/1000).toFixed(1)}s estimate · ${window.fits?'fits':'does not fit'}`,kind:'period'}));
 if(nav.view==='prompts')return page?.snapshotId===snapshot.snapshotId&&page.conversationId===nav.conversationId?page.prompts.map(prompt=>({id:prompt.id,label:prompt.text,value:`${day(prompt.eventAt)} · ${prompt.eligibleHuman?'direct user':'origin unverified'}`,kind:'prompt',conversationId:prompt.conversationId})):[];
 if(nav.view==='detail'&&(nav.section==='projects'||nav.section==='models'||nav.section==='timeline')){const records=snapshot.launch?.facts?.records??[];const model=snapshot.launch?.facts?.models.find(item=>item.id===nav.detailId);return snapshot.conversations.filter(conversation=>nav.section==='projects'?conversation.projectId===nav.detailId:nav.section==='timeline'?snapshot.activity.some(bucket=>bucket.date===nav.detailId)&&((conversation.eventFrom?.slice(0,10)??'')<=nav.detailId!&&(conversation.eventTo?.slice(0,10)??'')>=nav.detailId!):records.some(record=>record.conversationId===conversation.id&&(record.canonicalModel??record.model)===(model?.canonicalModel??model?.model)&&record.provider===model?.provider)).map(conversation=>({id:conversation.id,label:conversation.title??conversation.alias,value:`${num(conversation.promptCount)} prompts${conversation.child?' · subagent':''}`,kind:'conversation',conversationId:conversation.id}));}
 if(nav.section==='overview')return LAUNCH_SECTIONS.slice(1).map(section=>({id:section,label:NAMES[section],value:'Explore',kind:'project'}));
 if(nav.section==='models')return (snapshot.launch?.facts?.models??[]).map(model=>({id:model.id,label:modelName(model),value:`${modelTokens(model)} · ${pct(model.tokenShare)} known-token share · ${pct(model.conversationShare)} conversation share`,kind:'model'}));
 if(nav.section==='projects')return snapshot.projects.map(project=>({id:project.id,label:project.displayName,value:`${num(project.humanPrompts)} human prompts · ${num(project.conversations)} conversations`,kind:'project'}));
 if(nav.section==='work'||nav.section==='hall')return (nav.section==='hall'?snapshot.launch?.semantics?.hallOfFame:snapshot.launch?.semantics?.stories??[])?.map(story=>({id:story.id,label:nav.section==='hall'?story.quote??story.caption:story.caption,value:`${story.project??'Unattributed'} · ${outcome(story)}`,kind:'story',conversationId:story.conversationId,promptIds:story.promptIds}))??[];
 if(nav.section==='language')return (snapshot.profanity?.matches??[]).map((match,index)=>({id:`language:${index}`,label:match.term,value:words(match.kind),kind:'language',conversationId:match.conversationId,promptIds:[match.promptId]}));
 return snapshot.activity.map(bucket=>({id:bucket.date,label:bucket.date,value:`${num(bucket.count)} human prompts`,kind:'date'}));
}

/** Pure, responsive cell renderer. Every graph uses observed values. */
export function buildLaunchScreen(snapshot:AuditSnapshot,nav:LaunchNavigation,geometry:LaunchGeometry={}):readonly AuditLine[]{
 const width=Math.max(12,Math.min(geometry.columns??80,geometry.width??Infinity)),height=Math.max(8,geometry.rows??24),widthOf=geometry.widthOf??auditCellWidth,ascii=Boolean(geometry.ascii),compact=width<60,wide=width>=100;
 const body:AuditLine[]=[];
 const add=(text:string,tone:AuditTone='normal')=>body.push(line(text,tone));
 const wrap=(text:string,tone:AuditTone='normal')=>{const tokens=safe(text).split(/\s+/);let current='';for(const token of tokens){if(widthOf((current?`${current} `:'')+token)<=width){current+=(current?' ':'')+token;continue;}if(current)body.push(line(current,tone));current='';let rest=token;while(widthOf(rest)>width){const clipped=auditClip(rest,width,widthOf);if(!clipped)break;body.push(line(clipped,tone));rest=rest.slice(clipped.length);}current=rest;}if(current)body.push(line(current,tone));};
 const facts=snapshot.launch?.facts,sem=snapshot.launch?.semantics,stage=snapshot.launch?.stage??'discovering',active=stage!=='ready'&&!['cancelled','error'].includes(snapshot.status);
 if(nav.view==='evidence'){
  add('SOURCE EVIDENCE','cyan');
  if(geometry.busy)add('Reading scoped source…','dim');else if(geometry.evidence?.state==='available'&&geometry.evidence.text!==null){add(`${geometry.evidence.role??'unknown role'} · ${day(geometry.evidence.eventAt)}`,'dim');for(const paragraph of geometry.evidence.text.split('\n'))wrap(paragraph);}else wrap(geometry.evidence?.state==='stale'?'Source changed. Re-run audit to read current evidence.':'Source evidence unavailable.');
 }else if(nav.view==='periods'){
  wrap(`Analyzed scope: ${semanticScope(snapshot)}`,'cyan');wrap(`Allowance: ${num(sem?.window.tokenLimit)} total input tokens`,'dim');
  for(const [index,row] of launchRows(snapshot,nav).entries()){const choice=sem?.window.choices.find(item=>row.id===`period:${item.period}`);add(`${row.id===nav.selectedId||!nav.selectedId&&index===nav.selectedIndex?'›':' '} ${row.label}${choice?.period===sem?.window.selected?.period&&!sem?.window.selected?.selection?' · selected':''}`,'amber');wrap(row.value,'dim');if(choice?.reason)wrap(words(choice.reason),'dim');}
  wrap('Remaining-analysis estimates include questions and retry allowance. Local inventory has already run; these are not total cold-audit times. Enter uses this run’s remaining allowance.','dim');if(sem?.window.reason)wrap(words(sem.window.reason),'dim');
 }else if(nav.view==='prompts'){
  add('DIRECT USER INPUTS','cyan');if(geometry.busy)add('Reading scoped conversation…','dim');
  for(const row of launchRows(snapshot,nav,geometry.promptPage)){add(`${row.id===nav.selectedId?'›':' '} ${row.label}`);add(`  ${row.value}`,'dim');}if(!geometry.busy&&!geometry.promptPage?.prompts.length)add('No accessible inputs in this bounded read.','dim');
  if(geometry.promptPage?.nextOffset!==null&&geometry.promptPage?.nextOffset!==undefined)add('N: next page · P: previous page','dim');
 }else if(nav.view==='detail'){
  const selected=launchRows(snapshot,{...nav,view:'section'}).find(row=>row.id===nav.detailId);
  wrap(selected?.label??'Recorded detail','amber');
  if(nav.section==='models'){const model=facts?.models.find(item=>item.id===nav.detailId);if(model){wrap(`Native endpoint: ${model.provider??'unknown'} / ${model.model??'unknown'}`,'dim');wrap(`${modelTokens(model)} · ${num(model.conversations)} chats with recorded usage (includes agents)`);wrap(`Conversation share ${pct(model.conversationShare)} uses chats with recorded usage, including agents`,'dim');wrap(`Favourite score ${pct(model.favouriteScore)} · 50/50 token / conversation weights`,'cyan');wrap(`Recorded API-equivalent ${usd(equivalent(model))} · endpoint ${usd(model.valueUsd)} · first-party reference ${usd(model.referenceValueUsd)}`);wrap(`Native input ${num(model.inputTokens)} / output ${num(model.outputTokens)}`);const refs=(facts?.referenceProviders??[]).filter(r=>r.model===model.model);if(refs.length)wrap(`Reference basis: ${refs.map(r=>r.provider+'/'+r.model).join(', ')}; actual endpoint remains unknown`,'dim');if(model.gaps.length)wrap(`Coverage: ${model.gaps.map(words).join(', ')}`,'dim');}for(const pricing of pricingLines(snapshot))wrap(pricing,'dim');}
  else if(nav.section==='projects'){const project=snapshot.projects.find(item=>item.id===nav.detailId);if(project)wrap(`${num(project.humanPrompts)} human prompts · ${num(project.conversations)} conversations · ${pct(project.share)} prompt share`,'cyan');}
  else if(nav.section==='work'||nav.section==='hall'){const story=[...(sem?.stories??[]),...(sem?.hallOfFame??[])].find(item=>item.id===nav.detailId);if(story){wrap(`${story.project??'Unattributed'} · ${outcome(story)}`,'cyan');wrap(`${semanticScope(snapshot)} · Jev ${sem?.model??'unavailable'}`,'dim');if(story.quote)wrap(`“${story.quote}”`);wrap(`${num(story.promptIds.length)} source input references · confidence ${pct(story.confidence)}`,'dim');add('Enter: read referenced user input','amber');}}
  else if(nav.section==='language'){const match=snapshot.profanity?.matches?.[Number(nav.detailId?.split(':')[1])];if(match){wrap(`${words(match.kind)} · ${snapshot.profanity?.measurementBasis??'basis unavailable'}`,'dim');add('Enter: containing input and source evidence','amber');}}
  const rows=launchRows(snapshot,nav);for(const [index,row] of rows.entries()){add(`${row.id===nav.selectedId||!nav.selectedId&&index===nav.selectedIndex?'›':' '} ${row.label}`);add(`  ${row.value}`,'dim');}
 }else if(nav.section==='overview'){
  if(active){
   wrap(snapshot.launch?.notice??'Local source discovery is starting.','dim');add('');
   const sources=snapshot.sources.length?snapshot.sources:snapshot.scope.harnesses.map(harness=>({harness,state:'pending',candidateFiles:null}));
   const arrow=ascii?['-->','->-','>--'][(geometry.frame??0)%3]:['──▶','─▶─','▶──'][(geometry.frame??0)%3],pieces=ascii?[' /#\\',' |##',' \#/','  v ']:[' ▟█▙',' ███',' ▜█▛','  ▀ '],nameWidth=Math.max(...sources.map(source=>widthOf(SOURCE[source.harness]??source.harness)));
   for(const [index,source] of sources.entries()){const name=SOURCE[source.harness]??source.harness;body.push([{text:name+' '.repeat(Math.max(0,nameWidth-widthOf(name)))+' ',tone:SOURCE_TONE[source.harness]??'normal'},{text:`${arrow} `,tone:'dim'},{text:pieces[index%pieces.length]!,tone:'amber'},{text:` ${source.state}${source.candidateFiles===null?'':` · ${num(source.candidateFiles)} files`}`,tone:'dim'}]);}
   add('');const stages=['discovering','sizing','preparing','analyzing','assembling'] as const;
   add(`${ascii?'>':'◆'} ${words(stage)}${stage==='analyzing'?' · Jev':''}`,'amber');
   if(!compact)add(stages.map(step=>`${step===stage?'[':''}${step}${step===stage?']':''}`).join(' → '),'dim');
   if(snapshot.progress.total!==null)add(`${num(snapshot.progress.completed)} / ${num(snapshot.progress.total)} ${words(snapshot.progress.unit)}`,'dim');
   if(sem?.state==='unavailable')wrap('Jev unavailable · local facts continue.','dim');
  }
  if(facts){
   add(`${usd(equivalent(facts))}  recorded API-equivalent value`,'amberLight');
   if(facts.referenceValueUsd!==null){const providers=[...new Set((facts.referenceProviders??[]).map(reference=>reference.provider))].join(', ')||'named provider';add(`${usd(facts.referenceValueUsd)} ${providers} first-party reference`,'dim');add('Actual provider unknown for reference','dim');}
   const scope=snapshot.scope.eventFrom?'Recorded scope':'All-time',tokens=knownTokens(snapshot),chats=metricCount(snapshot.metrics.conversations);
   if(compact){add(`${scope} · ${num(tokens)} known tokens`,'dim');add(`${num(chats)} main chats`,'dim');}else add(`${scope} · ${num(tokens)} known tokens · ${num(chats)} main chats`,'dim');
   if(facts.favourite){add(`Favourite: ${compact?facts.favourite.model??modelName(facts.favourite):modelName(facts.favourite)}`,'cyan');add(`${pct(facts.favourite.tokenShare)} known tokens · ${num(facts.favourite.conversations)} usage chats`,'dim');}else add('Favourite model unknown · usage incomplete','dim');
  }else if(!active)add('Recorded API-equivalent value unknown · usage unavailable','dim');
  if(snapshot.projects.length){add('PROJECTS','violet');for(const project of snapshot.projects.slice(0,compact?2:3))body.push([{text:`${project.displayName} `,tone:'normal'},{text:bar(project.share,compact?5:wide?20:10,ascii),tone:'violet'},{text:` ${num(project.humanPrompts)} prompts`,tone:'dim'}]);}
  add(shortWorkScope(snapshot),'cyan');
  if(sem?.work.length){const total=sem.work.reduce((sum,row)=>sum+row.count,0);add(sem.work.slice(0,compact?2:3).map(row=>`${words(row.label)} ${num(row.count)}`).join(' · '),'violet');if(wide)add(spark(sem.work.map(row=>row.count),30,ascii)+`  ${num(total)} judged segments`,'dim');}
  else if(sem?.state==='unavailable')wrap('Jev route unavailable · see Work for coverage.','dim');
  const direct=snapshot.profanity?.buckets.find(bucket=>bucket.kind==='direct_prose'),highlight=snapshot.profanity?.matches?.find(match=>match.kind==='direct_prose');
  if(direct){const attributed=snapshot.launch?.languageByModel?.find(row=>highlight&&row.promptIds.includes(highlight.promptId));add(compact?`LANGUAGE ${highlight?`“${highlight.term}” ×${num(direct.occurrences)}`:num(direct.occurrences)+' matches'}${attributed?.model?` · ${attributed.model}`:''}`:`YOUR LANGUAGE  ${highlight?`“${highlight.term}” · `:''}${num(direct.occurrences)} direct-use matches${attributed?.model?` · ${attributed.model}`:''}`,'amber');}else if(!active)add('Your language · direct-use coverage unavailable','dim');
  for(const story of (sem?.hallOfFame??[]).filter(story=>story.quote&&story.promptIds.length).slice(0,2)){const status=compact?{attempted:'attempted',assistant_reported:'reported',supported:'supported',uncertain:'uncertain'}[story.outcome]:outcome(story);const quote=auditClip(story.quote??story.caption,Math.max(4,width-widthOf(status)-10),widthOf);add(`HALL  ${quote} · ${status}`,'green');}

 }else{
  const rows=launchRows(snapshot,nav);const selectedIndex=Math.max(0,rows.findIndex(row=>row.id===nav.selectedId));
  if(nav.section==='models'){wrap(`${factScope(snapshot)} · native recorded usage`,'dim');for(const pricing of pricingLines(snapshot))wrap(pricing,'dim');if(facts?.favourite)wrap(`Favourite combines known-token share and conversation share equally (50/50)`,'dim');if(facts?.referenceValueUsd!==null&&facts?.referenceValueUsd!==undefined)wrap(`${usd(facts.referenceValueUsd)} first-party reference · ${(facts.referenceProviders??[]).map(reference=>reference.provider+'/'+reference.model).join(', ')} · actual provider unknown`,'dim');}
  if(nav.section==='projects')wrap(`${factScope(snapshot)} · direct human prompts`,'dim');
  if(nav.section==='work'||nav.section==='hall'){
   wrap(`${semanticScope(snapshot)} · Jev ${sem?.state??'pending'} · tone ${sem?.tone??'elegant'}`,'cyan');
   if(sem?.state==='pending')wrap('Analysis pending. Semantic stories appear when judgments finish.','dim');
   if(sem?.state==='unavailable')wrap('Jev unavailable. The free route has not supplied this analysis.','dim');
   if(sem?.gaps.length)wrap(`Coverage: ${sem.gaps.map(words).join(', ')}`,'dim');
   if(nav.section==='work'&&sem?.work.length){const total=sem.work.reduce((sum,item)=>sum+item.count,0);for(const item of sem.work)body.push([{text:words(item.label)+' ',tone:'normal'},{text:bar(total?item.count/total:0,compact?6:18,ascii),tone:'violet'},{text:` ${num(item.count)} segments`,tone:'dim'}]);}
  }
  if(nav.section==='language'){wrap('Direct user language · English explicit lexicon','cyan');if(snapshot.profanity){for(const bucket of snapshot.profanity.buckets)add(`${words(bucket.kind)}: ${num(bucket.occurrences)} matches / ${num(bucket.containingPrompts)} inputs`,bucket.kind==='direct_prose'?'amber':'dim');for(const owner of snapshot.launch?.languageByModel??[])add(`${owner.model??'Unknown model'} · ${num(owner.occurrences)} direct matches`,'violet');wrap(`Coverage: ${num(snapshot.profanity.eligiblePrompts)} eligible inputs · ${snapshot.profanity.coverageGaps.map(words).join(', ')||'no listed gaps'}`,'dim');}else add('Language coverage unavailable','dim');}
  if(nav.section==='timeline'){add(`Human prompts · ${snapshot.scope.timezone}`,'cyan');add(spark(snapshot.activity.map(bucket=>bucket.count),width-2,ascii),'violet');}
  for(const [index,row] of rows.entries()){body.push([{text:`${index===selectedIndex?ascii?'> ':'› ':'  '}${row.label}`,tone:index===selectedIndex?'amber':'normal'}]);add(`  ${row.value}`,'dim');}
  if(!rows.length&&!['pending','unavailable'].includes(sem?.state??''))add('No recorded rows for this scope.','dim');
 }
 if(geometry.notice)wrap(geometry.notice,'amber');
 // Navigation chrome stays in view; the content scrolls independently.
 const header:AuditLine[]=[[{text:ascii?'SLOPIE  ':'▟  SLOPIE  ',tone:'amber'},{text:nav.frozen?'FROZEN · current view':nav.view==='section'?({elegant:'your recorded work',witty:'the receipts',chaotic:'the session pile',roast:'receipts, served cold'}[sem?.tone??'elegant']):NAMES[nav.section],tone:'dim'}]];
 if(compact)header.push(line(`${NAMES[nav.section]}  ${LAUNCH_SECTIONS.indexOf(nav.section)+1}/7${nav.view!=='section'?` · ${nav.view}`:''}`,'cyan'));
 else header.push(LAUNCH_SECTIONS.flatMap((section,index)=>[{text:`${index?'  ':''}${section===nav.section?'[':''}${NAMES[section]}${section===nav.section?']':''}`,tone:section===nav.section?'cyan':'dim' as AuditTone}]));
 header.push(line(`Coverage: ${snapshot.coverage.state==='complete_snapshot'?'retained snapshot':snapshot.coverage.state}${active?` · ${words(stage)}`:''}`,'dim'));
 const footer:AuditLine[]=[line(compact?'←/→ Tab sections · ↑/↓ move':'←/→ or Tab: sections   ↑/↓: select / scroll   Enter: details / evidence','dim'),line(compact?'Enter · Esc · W period · S freeze · q':'Esc: back / cancel   S: freeze current view   W: period estimates   q: quit','dim')];
 const visible=Math.max(1,height-header.length-footer.length-1);let scroll=Math.max(0,Math.min(nav.scroll,Math.max(0,body.length-visible)));if(nav.selectedId&&nav.view!=='evidence'&&nav.section!=='overview'){const selectedLine=body.findIndex(segments=>segments[0]?.text.startsWith('›'));if(selectedLine>=0){if(selectedLine<scroll)scroll=selectedLine;else if(selectedLine+1>=scroll+visible)scroll=Math.max(0,selectedLine-visible+2);}}const rendered=[...header,line((ascii?'-':'─').repeat(width),'dim'),...body.slice(scroll,scroll+visible)];
 while(rendered.length<height-footer.length)rendered.push(line(''));
 if(body.length>visible)footer[0]=line(`${scroll+1}–${Math.min(scroll+visible,body.length)} / ${body.length} lines · ↑/↓ scroll · ←/→ sections`,'dim');
 return [...rendered,...footer].slice(0,height).map(segments=>{let remaining=width;return segments.map(segment=>{const normalized=ascii?segment.text.replaceAll('›','>').replaceAll('→','>').replaceAll('←','<').replaceAll('↑','^').replaceAll('↓','v').replaceAll('·','|').replaceAll('“','\"').replaceAll('”','\"').replaceAll('…','...').replaceAll('–','-'):segment.text;const text=auditClip(normalized,remaining,widthOf);remaining-=widthOf(text);return {...segment,text};});});
}
export function renderLaunchPlain(snapshot:AuditSnapshot,options:AuditTerminalOptions={}):string {return buildLaunchScreen(snapshot,createLaunchNavigation(),{...options,columns:options.width??80,rows:40}).map(segments=>segments.map(segment=>segment.text).join('').trimEnd()).join('\n').trimEnd()+'\n';}

/** Ink owns input, alternate-screen lifecycle and restoration. No simulated progress. */
export async function runLaunchTerminal(session:AuditSession,options:AuditTerminalOptions={}):Promise<AuditTerminalResult>{
 if(!process.stdin.isTTY||!process.stdout.isTTY)return {snapshot:await session.run(),reason:'complete'};
 const [{default:React,useState,useRef,useEffect},{render,Box,Text,useInput,useApp,useWindowSize,useAnimation},{default:stringWidth}]=await Promise.all([import('react'),import('ink'),import('string-width')]);
 let finalSnapshot=session.snapshot(),reason:AuditTerminalResult['reason']='quit',settled=false,scan:Promise<AuditSnapshot>|null=null,periodJob:Promise<AuditSnapshot>|null=null;
 function App(){
  const [live,setLive]=useState(finalSnapshot),[nav,setNav]=useState(createLaunchNavigation()),[frozen,setFrozen]=useState<AuditSnapshot|null>(null),[page,setPage]=useState<AuditPromptPage|null>(null),[evidence,setEvidence]=useState<AuditEvidence|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const {columns,rows}=useWindowSize(),{exit}=useApp(),mounted=useRef(true),generation=useRef(0),pending=useRef<ReturnType<typeof setTimeout>|null>(null),readBusy=useRef(false);
  const snapshot=nav.frozen&&frozen?frozen:live,active=live.launch?.stage!=='ready'&&!['error','cancelled'].includes(live.status),visible=Math.max(1,rows-6),items=launchRows(snapshot,nav,page);
  const {frame}=useAnimation({interval:120,isActive:active&&!nav.frozen&&nav.section==='overview'&&nav.view==='section'&&options.motion!==false});
  useEffect(()=>{mounted.current=true;const publish=(event:AuditEvent)=>{finalSnapshot=applyAuditEvent(finalSnapshot,event);if(pending.current===null)pending.current=setTimeout(()=>{pending.current=null;if(mounted.current)setLive(finalSnapshot);},80);};scan=Promise.resolve().then(()=>session.run(publish)).then(value=>{settled=true;finalSnapshot=value;if(pending.current!==null){clearTimeout(pending.current);pending.current=null;}if(mounted.current)setLive(value);return value;},()=>{settled=true;finalSnapshot={...finalSnapshot,status:'error',launch:finalSnapshot.launch?{...finalSnapshot.launch,stage:'ready'}:undefined};if(mounted.current){setLive(finalSnapshot);setNotice('Audit interrupted · available results retained');}return finalSnapshot;});return()=>{mounted.current=false;generation.current++;if(pending.current!==null)clearTimeout(pending.current);};},[]);
  const stop=(cancel=false)=>{reason=!settled||periodJob||cancel?'cancelled':'quit';generation.current++;if(!settled||periodJob||cancel)session.cancel();exit();};
  const refreshCurrent=()=>{if(!mounted.current)return;const current=session.snapshot();if(current.snapshotId===finalSnapshot.snapshotId&&current.sequence>=finalSnapshot.sequence){finalSnapshot=current;setLive(current);}};
  const readPage=async(next:LaunchNavigation,offset=0,targetIds?:readonly string[])=>{
   if(readBusy.current)return;readBusy.current=true;const token=++generation.current;setNav(next);setPage(null);setEvidence(null);setBusy(true);setNotice('');
   try{let result=await session.prompts(next.conversationId!,offset,20);if(targetIds?.length){let searched=0;while(!result.prompts.some(prompt=>targetIds.includes(prompt.id))&&result.nextOffset!==null&&searched++<50&&token===generation.current)result=await session.prompts(next.conversationId!,result.nextOffset,20);result={...result,prompts:result.prompts.filter(prompt=>targetIds.includes(prompt.id)),nextOffset:null};}if(mounted.current&&token===generation.current&&result.snapshotId===finalSnapshot.snapshotId){setPage(result);setNav(current=>({...current,selectedId:result.prompts[0]?.id??null,selectedIndex:0,scroll:0}));}}
   catch{refreshCurrent();if(mounted.current&&token===generation.current)setNotice('Source unavailable or changed · Esc returns');}finally{readBusy.current=false;if(mounted.current&&token===generation.current)setBusy(false);}
  };
  const readEvidence=async(route:AuditEvidence['route'])=>{if(readBusy.current)return;readBusy.current=true;const token=++generation.current;setNav(launchPush(nav,{view:'evidence'}));setBusy(true);setEvidence(null);setNotice('');try{const value=await session.evidence(route);refreshCurrent();if(mounted.current&&token===generation.current)setEvidence(value);}catch{refreshCurrent();if(mounted.current&&token===generation.current)setNotice('Exact source unavailable · Esc returns');}finally{readBusy.current=false;if(mounted.current&&token===generation.current)setBusy(false);}};
  const open=async()=>{
   if(nav.frozen){setNotice('Frozen current view · S resumes navigation');return;}
   if(nav.section==='overview'&&nav.view==='section'){setNav({...createLaunchNavigation('models')});return;}
   const selected=items.find(item=>item.id===nav.selectedId)??items[nav.selectedIndex];
   if(nav.view==='prompts'){const prompt=page?.prompts.find(item=>item.id===selected?.id);if(prompt)await readEvidence(prompt.route);return;}
   if(nav.view==='detail'&&(nav.section==='hall'||nav.section==='work')){const story=[...(snapshot.launch?.semantics?.stories??[]),...(snapshot.launch?.semantics?.hallOfFame??[])].find(item=>item.id===nav.detailId);if(story)await readPage(launchPush(nav,{view:'prompts',conversationId:story.conversationId}),0,story.promptIds);return;}
   if(nav.view==='detail'&&nav.section==='language'){const match=snapshot.profanity?.matches?.[Number(nav.detailId?.split(':')[1])];if(match)await readEvidence(match.route);return;}
   if(!selected)return;
   if(selected.kind==='conversation'){await readPage(launchPush(nav,{view:'prompts',conversationId:selected.id}));return;}
   if(selected.kind==='period'){
    const choice=snapshot.launch?.semantics?.window.choices.find(window=>selected.id===`period:${window.period}`);
    if(!choice||!choice.fits){setNotice('This period exceeds the available allowance · choose a smaller scope');return;}
    if(!settled||periodJob){setNotice('Current analysis is still running');return;}
    if(!session.analyzePeriod){setNotice('Period analysis is unavailable in this session');return;}
    const token=++generation.current;setBusy(true);setNotice('Preparing selected period · retained sources and cached judgments');
    const publish=(event:AuditEvent)=>{finalSnapshot=applyAuditEvent(finalSnapshot,event);if(mounted.current)setLive(finalSnapshot);};
    periodJob=session.analyzePeriod(choice.period,publish);
    try{const value=await periodJob;finalSnapshot=value;if(mounted.current){setLive(value);if(token===generation.current){setNav({...createLaunchNavigation('work')});setNotice('');}}}
    catch{if(mounted.current&&token===generation.current)setNotice('Period analysis stopped or unavailable · retained results remain');}
    finally{periodJob=null;if(mounted.current&&token===generation.current)setBusy(false);}
    return;
   }
   setNav(launchPush(nav,{view:'detail',detailId:selected.id,conversationId:selected.conversationId??null}));
  };
  useInput((input,key)=>{
   if((key.ctrl&&input==='c')||input==='q'){stop();return;}
   if(input==='S'||input==='s'){generation.current++;setBusy(false);setFrozen(nav.frozen?null:snapshot);setNav(launchFreeze(nav));setNotice('');return;}
   if(nav.frozen)return;
   if(key.escape){if(periodJob){stop(true);return;}generation.current++;setBusy(false);setNotice('');if(nav.stack.length)setNav(launchBack(nav));else if(!settled)stop(true);return;}
   if(key.leftArrow||key.rightArrow||key.tab){generation.current++;setBusy(false);setNotice('');setNav(launchSelectSection(nav,key.leftArrow||key.shift?-1:1));return;}
   if(input==='w'||input==='W'||input==='f'){const choices=snapshot.launch?.semantics?.window.choices??[],selected=choices.findIndex(window=>window.period===snapshot.launch?.semantics?.window.selected?.period);setNav({...launchPush(nav,{view:'periods'}),selectedId:choices[Math.max(0,selected)]?`period:${choices[Math.max(0,selected)]!.period}`:null,selectedIndex:Math.max(0,selected)});return;}
   if(nav.view==='prompts'&&(input==='n'||input==='p')){const offset=input==='n'?page?.nextOffset:Math.max(0,(page?.offset??0)-20);if(offset!=null)void readPage({...nav,scroll:0,selectedIndex:0},offset);return;}
   if(key.return){void open();return;}
   if(key.upArrow||key.downArrow||input==='j'||input==='k'){const delta=key.upArrow||input==='k'?-1:1;if(nav.section==='overview'||nav.view==='evidence'||nav.view==='detail'&&!items.length)setNav(current=>({...current,scroll:Math.max(0,current.scroll+delta)}));else setNav(current=>launchMove(current,items,delta,Math.max(1,Math.floor(visible/2))));}
  });
  const screen=buildLaunchScreen(snapshot,nav,{...options,color:options.color!==false&&!('NO_COLOR' in process.env),columns,rows,widthOf:stringWidth,frame,promptPage:page,evidence,busy,notice});
  return React.createElement(Box,{flexDirection:'column',width:Math.min(columns,options.width??columns),height:rows},...screen.map((segments,index)=>React.createElement(Box,{key:index,height:1,flexShrink:0,width:'100%'},React.createElement(Text,{wrap:'truncate'},...segments.map((segment,i)=>React.createElement(Text,{key:i,color:options.color===false||'NO_COLOR' in process.env?undefined:COLORS[segment.tone]},segment.text))))));
 }
 const originalWrite=process.stdout.write;
 process.stdout.write=(function(...args:Parameters<typeof originalWrite>):boolean{if(typeof args[0]==='string'&&args[0].includes('\x1b[?1049h'))args[0]=args[0].replace('\x1b[?1049h','\x1b[?1049h\x1b[H');return originalWrite.apply(process.stdout,args);}) as typeof originalWrite;
 let app:ReturnType<typeof render>;try{app=render(React.createElement(App),{alternateScreen:true,incrementalRendering:true,maxFps:12,exitOnCtrlC:false,patchConsole:false});}catch(error){session.cancel();throw error;}finally{process.stdout.write=originalWrite;}
 try{await app.waitUntilExit();if(!settled||periodJob)session.cancel();if(scan)await scan;if(periodJob)await (periodJob as Promise<AuditSnapshot>).catch(()=>{});return {snapshot:finalSnapshot,reason};}finally{if(!settled||periodJob)session.cancel();app.unmount();await app.waitUntilRenderFlush();}
}
