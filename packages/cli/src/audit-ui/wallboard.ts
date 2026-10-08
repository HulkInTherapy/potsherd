import type {AuditSnapshot} from '../../../core/src/analytics/contracts.js';
import type {ModelAggregate,AuditLanguageLine,AuditModelFeedback} from '../../../core/src/analytics/launch-contracts.js';
import type {AuditLine,AuditTone} from './index.js';
import {auditCellWidth,auditClip} from './index.js';
import {reportWrap,reportNumber,cleanReportText} from './report-document.js';
import type {ReportOptions,ReportAnchor} from './report-document.js';
import {launchAnalysisStatus,launchIsLoading} from './report-status.js';
export type WallCardId='value'|'models'|'projects'|'phrases'|'reactions'|'moment';
export interface WallCard {id:WallCardId;lines:AuditLine[];anchors:ReportAnchor[];}
export interface WallPage {lines:AuditLine[];cards:WallCardId[];anchor:WallCardId;anchors:ReportAnchor[];}
export interface WallLayout {pages:WallPage[];columns:number;rows:number;}
const cf=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}),compactNf=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const dollars=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?'—':cf.format(value);
export const wallEquivalent=(value:{valueUsd:number|null;referenceValueUsd:number|null})=>value.valueUsd===null&&value.referenceValueUsd===null?null:(value.valueUsd??0)+(value.referenceValueUsd??0);
/** Display-only spelling. Recorded identities remain unchanged in help and exports. */
export function readableModelName(value:string|null):string {
 if(!value)return 'Unidentified model';
 const raw=value.replace(/^(?:anthropic|openai|google|google-vertex|deepseek|qwen|mistral|x-ai|groq|opencode)\//i,'');
 if(/^claude-(?:opus|sonnet|haiku|fable)-/i.test(raw))return raw.split('-').map(part=>part==='claude'?'Claude':/^(opus|sonnet|haiku|fable)$/.test(part)?part[0]!.toUpperCase()+part.slice(1):part).join(' ');
 if(/^gpt-\d/i.test(raw))return raw.replace(/^gpt-/i,'GPT-').replace(/-(sol|astra|luna|terra)(?=-|$)/g,(_,part:string)=>' '+part[0]!.toUpperCase()+part.slice(1));
 return raw;
}
export const modelDisplayName=(model:ModelAggregate)=>readableModelName(model.canonicalModel??model.model);
export function wallNumber(value:number|null|undefined):string {if(value==null||!Number.isFinite(value))return '—';for(const [scale,suffix] of [[1e9,'B'],[1e6,'M'],[1e3,'K']] as const)if(Math.abs(value)>=scale)return compactNf.format(value/scale)+suffix;return reportNumber(value);}
const asciiText=(text:string,ascii:boolean)=>ascii?text.replaceAll('━','#').replaceAll('─','-').replaceAll('▰','#').replaceAll('▱','.').replaceAll('●','*').replaceAll('×','x').replaceAll('“','"').replaceAll('”','"').replaceAll('…','...').replaceAll('—','-').replaceAll('·','|'):text;
function textLine(text:string,tone:AuditTone='normal'):AuditLine{return [{text,tone}];}
function clipped(text:string,width:number,options:ReportOptions):string {text=asciiText(cleanReportText(text).replaceAll('\n',' '),Boolean(options.ascii));const widthOf=options.widthOf??auditCellWidth;if(widthOf(text)<=width)return text;const end=options.ascii?'...':'…';return auditClip(text,Math.max(0,width-widthOf(end)),widthOf)+end;}
function bar(value:number|null,width:number,ascii:boolean,project=false):string {if(value===null||!Number.isFinite(value))return ' '.repeat(width);const fill=Math.min(width,Math.max(0,Math.round(value*width)));return (ascii?'#':project?'▰':'█').repeat(fill)+(ascii?'.':project?'▱':'·').repeat(width-fill);}
function aligned(left:string,right:string,width:number,options:ReportOptions):string {const widthOf=options.widthOf??auditCellWidth,rightText=asciiText(right,Boolean(options.ascii)),label=clipped(left,Math.max(0,width-widthOf(rightText)-1),options);return label+' '.repeat(Math.max(1,width-widthOf(label)-widthOf(rightText)))+rightText;}
function displayNames<T extends {provider:string|null;model:string|null;canonicalModel?:string|null}>(models:readonly T[]):Map<T,string>{const base=new Map(models.map(model=>[model,readableModelName(model.canonicalModel??model.model)])),labels=new Map(base);for(const model of models){const label=base.get(model)!;if(models.some(other=>other!==model&&base.get(other)===label&&((other.canonicalModel??other.model)!==(model.canonicalModel??model.model)||other.provider!==model.provider))){const provider=model.provider??model.model?.match(/^([^/]+)\//)?.[1];if(provider)labels.set(model,label+' ('+provider+')');}}return labels;}
function knownTokens(snapshot:AuditSnapshot):number|null {const facts=snapshot.launch?.facts;if(!facts||facts.knownTokenResponses===0)return null;const values=facts.models.map(model=>model.knownTokens??model.totalTokens).filter((value):value is number=>value!=null);return values.length?values.reduce((sum,value)=>sum+value,0):null;}
function observed(metric:AuditSnapshot['metrics']['conversations']|undefined):number|null{return !metric||metric.state==='unavailable'||metric.state==='not_run'?null:metric.value;}
export const wallProgressMark=(options:ReportOptions={}):string=>(options.frame??0)%14===0?'[-.-] ':'[o.o] ';
export function buildWallHero(snapshot:AuditSnapshot,width:number,options:ReportOptions={}):AuditLine[]{
 const facts=snapshot.launch?.facts,value=facts?wallEquivalent(facts):null,rows:AuditLine[]=[textLine(value===null?'Value unavailable':`${dollars(value)}  API-equivalent`,'amberLight')];
 const tokens=knownTokens(snapshot),chats=observed(snapshot.metrics.conversations),projects=observed(snapshot.metrics.projects),stats=[tokens===null?'Tokens unavailable':wallNumber(tokens)+(width<45?' tokens':' known tokens'),...(chats===null?[]:[wallNumber(chats)+' chats']),...(projects===null?[]:[wallNumber(projects)+(width<45?' proj':' projects')])];
 rows.push(textLine(clipped(stats.join(' · '),width,options)));
 const partial=snapshot.coverage.state!=='complete_snapshot'||Boolean(facts?.gaps.length),progress=snapshot.launch?.factProgress;
 const cached=progress&&(progress.origin==='cache'||progress.origin==='mixed'),collecting=launchIsLoading(snapshot),completed=progress?`${wallNumber(progress.completedSources)}${progress.totalSources===null?'':'/'+wallNumber(progress.totalSources)} sources`:'';
 const cacheLabel=progress?.origin==='mixed'?'Cached + fresh':cached?'Cached':'';
 const count=progress?`${wallNumber(progress.completedSources)}${progress.totalSources===null?'':'/'+wallNumber(progress.totalSources)}`:'';
 const represented=progress?.representedSources??progress?.completedSources,subset=progress&&represented!==undefined&&represented<progress.completedSources;
 const mark=collecting?wallProgressMark(options):'',markWidth=(options.widthOf??auditCellWidth)(mark);
 if(subset){
  const priced=`Subtotal · prices from ${wallNumber(represented)} sources`,checked=`checked ${count}`;
  if(width<45){rows.push([{text:mark,tone:'amber'},{text:clipped(`Checked ${count}${cached?' · '+(progress.origin==='mixed'?'cache+fresh':'cached'):''}`,width-markWidth,options),tone:'dim'}]);rows.push(textLine(clipped(priced,width,options),'dim'));}
  else rows.push([{text:mark,tone:'amber'},{text:clipped(`${priced} · ${checked}${cacheLabel?' · '+cacheLabel:''}`,width-markWidth,options),tone:'dim'}]);
  return rows;
 }
 const cue=collecting&&width<45&&progress?`${progress.state==='complete'?'Work':'Collect'} ${count} src${cached?' · '+(progress.origin==='mixed'?'cache+fresh':'cached'):''}`:collecting?`${cacheLabel?cacheLabel+' · ':''}${progress?.state==='complete'?'Working':'Collecting'}${completed?' · '+completed:''} · ${snapshot.progress.label??'Reading local history'}`:cached?`${cacheLabel} · ${partial?'partial sources':'completed sources'}`:partial?'Partial · known usage only':'Current-rate estimate';
 rows.push([{text:mark,tone:'amber'},{text:clipped(cue,width-markWidth,options),tone:'dim'}]);
 return rows;
}
function modelCard(snapshot:AuditSnapshot,width:number,options:ReportOptions):WallCard|null {
 const facts=snapshot.launch?.facts;if(!facts?.models.length)return null;const sorted=[...facts.models].filter(model=>model.model!==null||model.canonicalModel!==null).sort((a,b)=>(b.knownTokens??b.totalTokens??-1)-(a.knownTokens??a.totalTokens??-1)||a.id.localeCompare(b.id)),models=sorted.slice(0,5);if(facts.favourite&&(facts.favourite.model!==null||facts.favourite.canonicalModel!==null)&&!models.some(model=>model.id===facts.favourite!.id))models[models.length-1]=facts.favourite;if(!models.length)return null;
 const widthOf=options.widthOf??auditCellWidth,max=Math.max(...models.map(model=>wallEquivalent(model)??0),0)||1,names=displayNames(models),priceWidth=Math.max(...models.map(model=>widthOf(asciiText(dollars(wallEquivalent(model)),Boolean(options.ascii))))),lines:AuditLine[]=[textLine(clipped('MODELS · price',width,options))];
 for(const model of models){const value=wallEquivalent(model),price=dollars(value),label=names.get(model)!,favourite=model.id===facts.favourite?.id,marker=asciiText(favourite?'● ':'  ',Boolean(options.ascii)),barWidth=width>=45?12:5,visual=bar(value===null?null:value/max,barWidth,Boolean(options.ascii));
  if(options.columns!==undefined&&options.columns<75){lines.push([{text:marker,tone:favourite?'amber':'normal'},{text:clipped(label,width-2,options),tone:'normal'}]);lines.push([{text:aligned('  '+visual,price,width,options),tone:'dim'}]);}
  else{const priceText=asciiText(price,Boolean(options.ascii)),priceField=' '.repeat(Math.max(0,priceWidth-widthOf(priceText)))+priceText,tail=' '+visual+' '+priceField,nameWidth=Math.max(4,width-2-widthOf(tail)),name=clipped(label,nameWidth,options);lines.push([{text:marker,tone:favourite?'amber':'normal'},{text:name+' '.repeat(Math.max(0,nameWidth-widthOf(name))),tone:'normal'},{text:' '+visual,tone:'dim'},{text:' '+priceField,tone:'normal'}]);}
 }
 return {id:'models',lines,anchors:[]};
}
function projectCard(snapshot:AuditSnapshot,width:number,options:ReportOptions):WallCard|null {
 if(!snapshot.projects.length)return null;const projects=[...snapshot.projects].sort((a,b)=>(b.nativeUserInputs??b.humanPrompts)-(a.nativeUserInputs??a.humanPrompts)||a.id.localeCompare(b.id)).slice(0,3),max=Math.max(...projects.map(project=>project.nativeUserInputs??project.humanPrompts),1),widthOf=options.widthOf??auditCellWidth,countWidth=Math.max(...projects.map(project=>widthOf(asciiText(wallNumber(project.nativeUserInputs??project.humanPrompts),Boolean(options.ascii))))),lines:AuditLine[]=[textLine(clipped('PROJECTS · inputs',width,options))],anchors:ReportAnchor[]=[];
 for(const project of projects){const count=project.nativeUserInputs??project.humanPrompts,visual=bar(count/max,width>=45?10:5,Boolean(options.ascii),true),countText=asciiText(wallNumber(count),Boolean(options.ascii)),tail=` ${visual} ${' '.repeat(Math.max(0,countWidth-widthOf(countText)))}${countText}`;lines.push(textLine(aligned(project.displayName,tail,width,options)));
  const focus=(project.focus??[]).filter(item=>item.inputs>0&&(item.promptIds.length>0||item.evidenceRoutes.length>0)).sort((a,b)=>b.inputs-a.inputs).slice(0,2);if(focus.length){lines.push(textLine(clipped('  '+focus.map(item=>item.label).join(' · '),width,options),'dim'));const first=focus.find(item=>item.evidenceRoutes.length);if(first)anchors.push({row:lines.length-1,label:project.displayName+' requested work',route:first.evidenceRoutes[0]});}
 }
 return {id:'projects',lines,anchors};
}
export function repeatedLines(snapshot:AuditSnapshot):AuditLanguageLine[]{return [...(snapshot.launch?.languageLines??[])].filter(line=>line.text.trim().split(/\s+/).length>1&&line.occurrences>0&&line.samples.length>0&&!/^\[Pasted text #\d+ \+\d+ lines\]$/.test(line.text.trim())).sort((a,b)=>b.occurrences-a.occurrences||a.id.localeCompare(b.id)).slice(0,6);}
/** Crop only a known terminal wrapper; the displayed suffix is still exact source text. */
export function wallPhraseText(text:string):string {const suffix=/^\[Pasted text #\d+ \+\d+ lines\]([\s\S]+)$/.exec(text)?.[1];return suffix?.trim()?suffix.trimStart():text;}
function phraseCard(snapshot:AuditSnapshot,width:number,options:ReportOptions):WallCard|null {const phrases=repeatedLines(snapshot);if(!phrases.length)return null;const lines:AuditLine[]=[textLine(phrases.every(line=>line.occurrences>1)?'REPEATED PHRASES':'YOUR PHRASES')],anchors:ReportAnchor[]=[],widthOf=options.widthOf??auditCellWidth;for(const phrase of phrases){const tail=`×${wallNumber(phrase.occurrences)}`,quoteWidth=Math.min(36,Math.max(4,width-widthOf(asciiText(tail,Boolean(options.ascii)))-3)),quote=asciiText('“'+clipped(wallPhraseText(phrase.text),quoteWidth,options)+'”',Boolean(options.ascii));lines.push([{text:aligned(quote,tail,width,options).slice(0,-asciiText(tail,Boolean(options.ascii)).length),tone:'normal'},{text:asciiText(tail,Boolean(options.ascii)),tone:'dim'}]);const sample=phrase.samples[0]!;anchors.push({row:lines.length-1,label:phrase.text,route:sample.route});}return {id:'phrases',lines,anchors};}
export function rankedFeedback(snapshot:AuditSnapshot,kind:'negative'|'praise'):AuditModelFeedback[]{const key=kind==='negative'?'directedNegativeInputs':'praiseInputs';return [...(snapshot.launch?.modelFeedback??[])].filter(model=>model.model!==null&&Number.isFinite(model.associatedInputs)&&model.associatedInputs>0&&model[key]>0&&model[key]<=model.associatedInputs).sort((a,b)=>b[key]/b.associatedInputs-a[key]/a.associatedInputs||b[key]-a[key]||a.model!.localeCompare(b.model!)).slice(0,3);}
function feedbackCard(snapshot:AuditSnapshot,width:number,options:ReportOptions):WallCard|null {const negative=rankedFeedback(snapshot,'negative'),praise=rankedFeedback(snapshot,'praise');if(!negative.length&&!praise.length)return null;const narrow=width<45,lines:AuditLine[]=[textLine(narrow?'REACTIONS · R roasted / P praised':'RECORDED REACTIONS · count / inputs')],names=displayNames([...new Set([...negative,...praise])]);for(const [title,models,key] of [['Roasted',negative,'directedNegativeInputs'],['Praised',praise,'praiseInputs']] as const){for(const [index,model] of models.entries()){const tail=`${((model[key]/model.associatedInputs)*100).toFixed(1)}% ${wallNumber(model[key])}/${wallNumber(model.associatedInputs)}`,prefix=narrow?title[0]+' ':index===0?title.padEnd(8):' '.repeat(8);lines.push(textLine(aligned(prefix+names.get(model),tail,width,options)));}}return {id:'reactions',lines,anchors:[]};}
function momentCard(snapshot:AuditSnapshot,width:number,options:ReportOptions):WallCard|null {const moment=snapshot.launch?.semantics?.hallOfFame.find(story=>story.quote&&story.promptIds.length>0&&story.outcome!=='uncertain');if(!moment)return null;const text='“'+moment.quote+'”'+(moment.project?' · '+moment.project:''),lines=[textLine(clipped(text,width,options))];return {id:'moment',lines,anchors:[{row:0,label:moment.quote!,conversationId:moment.conversationId,promptIds:moment.promptIds}]};}
function appendCard(page:WallPage,card:WallCard,gap=true):void{if(gap&&page.lines.length)page.lines.push(textLine(''));const offset=page.lines.length;page.lines.push(...card.lines);page.cards.push(card.id);page.anchors.push(...card.anchors.map(anchor=>({...anchor,row:anchor.row+offset})));if(page.anchor==='value')page.anchor=card.id;}
function addPair(page:WallPage,left:WallCard|null,right:WallCard|null,width:number,options:ReportOptions):void{if(!left&&!right)return;if(!left||!right){appendCard(page,(left??right)!);return;}if(page.lines.length)page.lines.push(textLine(''));const column=Math.floor((width-3)/2),offset=page.lines.length,widthOf=options.widthOf??auditCellWidth;for(let i=0;i<Math.max(left.lines.length,right.lines.length);i++){const l=left.lines[i]??[],r=right.lines[i]??[],used=l.reduce((sum,segment)=>sum+widthOf(segment.text),0);page.lines.push([...l,{text:' '.repeat(Math.max(0,column-used)+3),tone:'normal'},...r]);}page.cards.push(left.id,right.id);page.anchors.push(...left.anchors.map(anchor=>({...anchor,row:anchor.row+offset})),...right.anchors.map(anchor=>({...anchor,row:anchor.row+offset})));if(page.anchor==='value')page.anchor=left.id;}
function splitCard(card:WallCard,capacity:number):WallCard[]{if(card.lines.length<=capacity)return [card];const header=card.lines[0]!,size=Math.max(1,capacity-1),chunks:WallCard[]=[];for(let start=1;start<card.lines.length;start+=size){const slice=card.lines.slice(start,start+size);chunks.push({...card,lines:[header,...slice],anchors:card.anchors.filter(anchor=>anchor.row>=start&&anchor.row<start+size).map(anchor=>({...anchor,row:anchor.row-start+1}))});}return chunks;}
/** Measured mixed-card pages; every selected card remains reachable. */
export function buildWallboard(snapshot:AuditSnapshot,options:ReportOptions={}):WallLayout {
 const columns=Math.max(12,Math.min(options.columns??80,options.width??Infinity)),rows=Math.max(4,options.rows??24),width=Math.max(8,Math.min(columns-4,156)),visible=rows-1;
 options={...options,columns,rows};
 const hero=buildWallHero(snapshot,width,options),pages:WallPage[]=[],make=():WallPage=>({lines:[...hero],cards:['value'],anchor:'value',anchors:[]}),paired=columns>=75,column=Math.floor((width-3)/2);
 if(columns<40||rows<18)return {columns,rows,pages:[{lines:[textLine(clipped('Resize to 40 × 20 or larger',Math.max(8,columns-4),options),'dim')],cards:['value'],anchor:'value',anchors:[]}]};
 const models=modelCard(snapshot,paired?column:width,options),projects=projectCard(snapshot,paired?column:width,options),phrases=phraseCard(snapshot,paired?column:width,options),feedback=feedbackCard(snapshot,paired?column:width,options),moment=momentCard(snapshot,width,options);
 if(paired){
  const full=make();addPair(full,models,projects,width,options);
  if((phrases||feedback)&&(models||projects))full.lines.push(textLine((options.ascii?'-':'─').repeat(width),'amberDim'));
  addPair(full,phrases,feedback,width,options);if(moment)appendCard(full,moment);
  if(full.lines.length<=visible)pages.push(full);
  else {const first=make();addPair(first,models,projects,width,options);pages.push(first);if(phrases||feedback||moment){const second=make();addPair(second,phrases,feedback,width,options);if(moment)appendCard(second,moment);pages.push(second);}}
 }else{
  const first=make();if(models)appendCard(first,models);if(first.cards.length>1)pages.push(first);
  const second=make();if(projects)appendCard(second,projects);if(moment)appendCard(second,moment);if(second.cards.length>1)pages.push(second);
  const third=make();if(phrases)appendCard(third,phrases);if(feedback)appendCard(third,feedback);if(third.cards.length>1)pages.push(third);
  if(!pages.length)pages.push(make());
 }
 // Exceptional row counts or short terminals get complete chunks, never discarded tails.
 if(pages.some(page=>page.lines.length>visible)){
  const stacked:WallPage[]=[],capacity=Math.max(2,visible-hero.length-1);let current=make();
  for(const card of [modelCard(snapshot,width,options),projectCard(snapshot,width,options),moment,phraseCard(snapshot,width,options),feedbackCard(snapshot,width,options)].filter((card):card is WallCard=>Boolean(card))){for(const chunk of splitCard(card,capacity)){if(current.lines.length+chunk.lines.length+1>visible&&current.cards.length>1){stacked.push(current);current=make();}appendCard(current,chunk);}}
  stacked.push(current);pages.splice(0,pages.length,...stacked);
 }
 const status=launchAnalysisStatus(snapshot);
 if(status.kind==='local'||(!snapshot.launch?.facts&&status.summary)){
  let page=pages[0]!;
  const statusLines=reportWrap(status.summary??'Local history unavailable',width,options.widthOf).map(line=>textLine(line,'dim'));
  if(status.kind==='local'&&(snapshot.launch?.semantics?.attempts??0)===0)statusLines.push(textLine('No analysis requests made','dim'));
  if(page.lines.length+statusLines.length>visible){page=make();pages.push(page);}page.lines.push(...statusLines);
 }else if(status.kind==='provider'&&status.summary){let page=pages.at(-1)!;if(page.lines.length>=visible){page=make();pages.push(page);}page.lines.push(textLine(clipped(status.summary,width,options),'dim'));}
 const padding=' '.repeat(Math.max(2,Math.floor((columns-width)/2)));
 return {columns,rows,pages:pages.map(page=>({...page,lines:page.lines.map(line=>[{text:padding,tone:'normal'},...line])}))};
}
