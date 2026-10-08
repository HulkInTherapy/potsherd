/** The report renderer owns input; the supplied session owns background work. */
import type {AuditEvidence,AuditEvent,AuditSession,AuditSnapshot} from '../../../core/src/analytics/contracts.js';
import type {AuditLine,AuditTerminalOptions,AuditTerminalResult,AuditTone} from './index.js';
import {applyAuditEvent,auditCellWidth,auditClip} from './index.js';
import {buildReportDocument,buildReportHelp,buildEvidenceDocument,buildReportLoader,cleanReportText,reportWrap} from './report-document.js';
import type {ReportOptions,ReportDocument,ReportAnchor} from './report-document.js';
import {createReportNavigation,moveReport,reportEdge,reportMode,freezeReport,clampReportNavigation} from './report-navigation.js';
import {buildWallboard,wallProgressMark} from './wallboard.js';
import type {WallLayout} from './wallboard.js';
import {createWallNavigation,turnWall,wallMode,freezeWall,resizeWall,clampWall} from './wallboard-navigation.js';
import type {WallNavigation} from './wallboard-navigation.js';
import type {ReportNavigation} from './report-navigation.js';
import {launchIsLoading} from './report-status.js';
export type LaunchNavigation=WallNavigation;
export type LaunchGeometry=ReportOptions&{transfers?:readonly Extract<AuditEvent,{type:'transfer'}>[];};
export const createLaunchNavigation=createWallNavigation;
export {createWallNavigation,turnWall,wallMode,freezeWall,resizeWall,clampWall,buildWallboard};
export type {WallNavigation,WallLayout};
export {createReportNavigation,moveReport,reportEdge,reportMode,freezeReport,clampReportNavigation,buildReportDocument,buildReportHelp};
export type {ReportDocument,ReportAnchor,ReportNavigation};
export interface LaunchPrivacyView {snapshot:AuditSnapshot;nav:WallNavigation;frozen:AuditSnapshot|null;evidence:AuditEvidence|null;busy:boolean;generation:number;revoked:AuditSnapshot|null;}
const privacyCode=(code:string)=>/privacy|policy|forgot|tombstone/.test(code);
const revokedPrivacyGap=(code:string)=>privacyCode(code)&&(!/excluded|ignored|partial/.test(code)||/changed|revok|unavailable|required|hold|invalid|stale|mismatch/.test(code));
/** A revoked capture cannot be revived by a held view or a late worker result. */
export function applyLaunchPrivacyEvent(view:LaunchPrivacyView,event:AuditEvent):LaunchPrivacyView|null {
 if(view.revoked)return {...view,snapshot:view.revoked,nav:{...view.nav,frozen:false},frozen:null,evidence:null,busy:false};
 let source:AuditSnapshot,code:string;
 if(event.type==='error'&&event.snapshotId===view.snapshot.snapshotId&&privacyCode(event.code)){source=view.snapshot;code=event.code;}
 else if(event.type==='snapshot'&&event.snapshot.snapshotId===view.snapshot.snapshotId&&event.snapshot.sequence>=view.snapshot.sequence&&event.snapshot.launch?.facts===null){const gap=event.snapshot.coverage.gapCodes.find(revokedPrivacyGap)??event.snapshot.sources.flatMap(item=>item.gapCodes).find(revokedPrivacyGap);if(!gap)return null;source=event.snapshot;code=gap;}
 else return null;
 const metrics={...source.metrics};for(const key of Object.keys(metrics) as (keyof typeof metrics)[]){const metric=metrics[key];if(metric)metrics[key]={...metric,value:null,numerator:null,denominator:null,state:'unavailable'};}
 const snapshot:AuditSnapshot={...source,status:'error',coverage:{...source.coverage,state:'unavailable',gapCodes:[...new Set([...source.coverage.gapCodes,code])]},progress:{...source.progress,stage:'error',provisional:false,cancellable:false},metrics,projects:[],activity:[],conversations:[],insights:[],phrases:[],judgments:[],profanity:undefined,funnel:undefined,usage:{...source.usage,state:'unavailable',inputTokens:null,outputTokens:null,cacheTokens:null,reasoningTokens:null,costUsd:null},semantics:{...source.semantics,state:'cancelled',qualified:false,work:[],estimatedCostUsd:null,reportedCostUsd:null,unresolvedCostUsd:null},launch:source.launch?{...source.launch,stage:'ready',facts:null,semantics:source.launch.semantics?{...source.launch.semantics,state:'cancelled',stories:[],hallOfFame:[],work:[],judgments:[],window:{...source.launch.semantics.window,selected:null,choices:[],reason:'privacy_view_revoked'}}:null,languageLines:[],modelFeedback:[],languageByModel:undefined,languageGaps:[code],factProgress:undefined}:undefined};
 return {...view,snapshot,revoked:snapshot,nav:{...view.nav,frozen:false},frozen:null,evidence:null,busy:false,generation:view.generation+1};
}
export const launchEvidenceCanPublish=(token:number,generation:number,revoked:boolean)=>token===generation&&!revoked;
export const launchResultAfterPrivacy=(snapshot:AuditSnapshot,revoked:AuditSnapshot|null)=>revoked??snapshot;
export interface LaunchPreviewFloor {snapshotId:string;sequence:number;}
/** A withdrawn subtotal clears its held presentation without revoking allowed final data. */
export function applyLaunchPreviewInvalidation(view:LaunchPrivacyView,event:AuditEvent):LaunchPrivacyView|null {
 if(view.revoked||event.type!=='snapshot'||event.snapshot.snapshotId!==view.snapshot.snapshotId||event.snapshot.sequence<view.snapshot.sequence)return null;
 const next=event.snapshot,progress=next.launch?.factProgress,held=view.frozen??view.snapshot,previous=held.launch?.factProgress;
 if(!next.coverage.gapCodes.includes('native_price_preview_revoked')||next.launch?.facts!==null||progress?.state!=='collecting'||progress.representedSources!==0||!held.launch?.facts||(previous?.representedSources??previous?.completedSources??0)<=0)return null;
 return {...view,snapshot:next,nav:{...view.nav,frozen:false},frozen:null,evidence:null,busy:false,generation:view.generation+1};
}
export const launchResultAfterPreview=(snapshot:AuditSnapshot,current:AuditSnapshot,floor:LaunchPreviewFloor|null)=>floor&&snapshot.snapshotId===floor.snapshotId&&snapshot.sequence<=floor.sequence?current:snapshot;
const COLORS:Record<AuditTone,string>={normal:'#EEEAE4',dim:'#A6A29B',amberDim:'#68665F',amber:'#F2A45E',amberLight:'#F2A45E',cyan:'#EEEAE4',green:'#EEEAE4',violet:'#A6A29B',blue:'#A6A29B'};
const footer=(ascii:boolean,page:number,count:number,frozen=false):AuditLine=>[{text:(count>1?(ascii?'< ':'← ')+(page+1)+'/'+count+(ascii?' > | ':' → · '):'')+(ascii?'? help | q quit':'? help · q quit')+(frozen?(ascii?' | frozen':' · frozen'):''),tone:'dim'}];
function hasReport(snapshot:AuditSnapshot):boolean{return Boolean(snapshot.launch?.facts)||!launchIsLoading(snapshot);}
export function launchDocument(snapshot:AuditSnapshot,nav:WallNavigation,options:LaunchGeometry={}):ReportDocument {return nav.mode==='help'?buildReportHelp(snapshot,options,options.transfers):nav.mode==='detail'?buildEvidenceDocument(options.evidence,options):buildReportDocument(snapshot,options);}
/** Fullscreen, paginated mixed-card wallboard. No scrolling. */
export function buildLaunchScreen(snapshot:AuditSnapshot,nav:WallNavigation,options:LaunchGeometry={},measuredLayout?:WallLayout):readonly AuditLine[]{
 const columns=Math.max(12,Math.min(options.columns??80,options.width??Infinity)),rows=Math.max(4,options.rows??24),visible=rows-1,widthOf=options.widthOf??auditCellWidth;
 let body:AuditLine[],count=1,page=0;
 if(nav.mode==='board'&&!hasReport(snapshot))body=buildReportLoader(snapshot,{...options,transfer:null,columns,rows});
 else if(nav.mode==='board'){const layout=measuredLayout??buildWallboard(snapshot,{...options,columns,rows});count=layout.pages.length;page=clampWall(nav,count).page;body=[...(layout.pages[page]?.lines??[])];if(launchIsLoading(snapshot)&&body[2]?.[1]?.tone==='amber'&&/^\[(?:o\.o|-\.-)\] $/.test(body[2][1].text)){body[2]=body[2].map((segment,index)=>index===1?{...segment,text:wallProgressMark(options)}:segment);}}
 else{const doc=launchDocument(snapshot,nav,{...options,columns,rows});count=Math.max(1,Math.ceil(doc.lines.length/visible));page=clampWall(nav,count).page;body=doc.lines.slice(page*visible,(page+1)*visible);}
 if(options.notice&&body.length<visible)body.push([{text:'  '+options.notice,tone:'dim'}]);
 if(options.transfer){const notice=cleanReportText(options.transfer.notice),lines=buildReportHelpNotice(notice,columns,widthOf);body=[...lines,...body].slice(0,visible);}
 while(body.length<visible)body.push([{text:'',tone:'normal'}]);
 return [...body.slice(0,visible),footer(Boolean(options.ascii),page,count,nav.frozen)].map(line=>{let left=columns;return line.map(segment=>{const text=auditClip(segment.text,left,widthOf);left-=widthOf(text);return {...segment,text};});});
}
function buildReportHelpNotice(text:string,columns:number,widthOf:(text:string)=>number):AuditLine[]{return reportWrap(text.replaceAll('\n',' '),Math.max(10,columns-4),widthOf).map(row=>[{text:'  '+row,tone:'amberLight'}]);}
export function transferFrameVisible(screen:readonly AuditLine[],event:Extract<AuditEvent,{type:'transfer'}>):boolean{const text=screen.flat().map(segment=>segment.text).join('').replace(/\s/g,'');return text.includes(cleanReportText(event.notice).replace(/\s/g,''))&&event.recipients.every(recipient=>text.includes(recipient.replace(/\s/g,'')));}
/** Plain output never depends on a terminal viewport or clips after40 lines. */
export function renderLaunchPlain(snapshot:AuditSnapshot,options:AuditTerminalOptions={}):string{return buildReportDocument(snapshot,{...options,columns:options.width??80}).lines.map(line=>line.map(segment=>segment.text).join('').trimEnd()).join('\n').trimEnd()+'\n';}

export async function runLaunchTerminal(session:AuditSession,options:AuditTerminalOptions={}):Promise<AuditTerminalResult>{
 if(!process.stdin.isTTY||!process.stdout.isTTY)return {snapshot:await session.run(),reason:'complete'};
 const [{default:React,useState,useRef,useEffect,useMemo},{render,Box,Text,useInput,usePaste,useApp,useWindowSize,useAnimation},{default:stringWidth}]=await Promise.all([import('react'),import('ink'),import('string-width')]);
 let finalSnapshot=session.snapshot(),reason:AuditTerminalResult['reason']='quit',settled=false,scan:Promise<AuditSnapshot>|null=null,app:ReturnType<typeof render>|null=null;
 function App(){
  const [live,setLive]=useState(finalSnapshot),[nav,setNav]=useState(createWallNavigation()),[frozen,setFrozen]=useState<AuditSnapshot|null>(null),[evidence,setEvidence]=useState<AuditEvidence|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[transfer,setTransfer]=useState<Extract<AuditEvent,{type:'transfer'}>|null>(null),[transfers,setTransfers]=useState<Extract<AuditEvent,{type:'transfer'}>[]>([]);
  const {columns:rawColumns,rows}=useWindowSize(),columns=Math.min(rawColumns,options.width??rawColumns),{exit}=useApp(),mounted=useRef(true),generation=useRef(0),pending=useRef<ReturnType<typeof setTimeout>|null>(null),transferTimer=useRef<ReturnType<typeof setTimeout>|null>(null),cueTimer=useRef<ReturnType<typeof setTimeout>|null>(null),frozenFrame=useRef(0),transferSequence=useRef(-1),acknowledged=useRef(new Set<string>()),transferQueue=useRef<Extract<AuditEvent,{type:'transfer'}>[]>([]),activeTransfer=useRef<Extract<AuditEvent,{type:'transfer'}>|null>(null),terminating=useRef(false);
  const renderedRows=useRef<{signature:string;node:ReturnType<typeof React.createElement>}[]>([]),rowGeneration=useRef('');
  const revoked=useRef<AuditSnapshot|null>(null),previewFloor=useRef<LaunchPreviewFloor|null>(null),privacyView=useRef<LaunchPrivacyView>({snapshot:live,nav,frozen,evidence,busy,generation:generation.current,revoked:null});privacyView.current={snapshot:live,nav,frozen,evidence,busy,generation:generation.current,revoked:revoked.current};
  const snapshot=nav.frozen&&frozen?frozen:live,visible=Math.max(1,rows-1),loading=launchIsLoading(snapshot),{frame}=useAnimation({interval:100,isActive:loading&&nav.mode==='board'&&!nav.frozen&&options.motion!==false});
  const geometry:LaunchGeometry={...options,columns,rows,widthOf:stringWidth,frame:nav.frozen?frozenFrame.current:frame,evidence,busy,notice,transfer,transfers},doc=nav.mode==='board'?{lines:[],anchors:[]}:launchDocument(snapshot,nav,geometry),layout=useMemo(()=>buildWallboard(snapshot,{...options,columns,rows,widthOf:stringWidth}),[snapshot,columns,rows,options]),pageCount=nav.mode==='board'?layout.pages.length:Math.max(1,Math.ceil(doc.lines.length/visible));
  useEffect(()=>{setNav(current=>current.mode==='board'?resizeWall(current,layout):clampWall(current,pageCount));},[columns,rows,pageCount,nav.mode]);
  useEffect(()=>{
   mounted.current=true;
   const publish=(event:AuditEvent)=>{
    if(terminating.current||!mounted.current||revoked.current)return;
    const cleared=applyLaunchPrivacyEvent({...privacyView.current,snapshot:finalSnapshot,generation:generation.current},event);
    if(cleared){revoked.current=cleared.snapshot;finalSnapshot=cleared.snapshot;generation.current=cleared.generation;renderedRows.current=[];rowGeneration.current='';transferQueue.current=[];activeTransfer.current=null;for(const timer of [pending.current,transferTimer.current,cueTimer.current])if(timer)clearTimeout(timer);pending.current=null;transferTimer.current=null;cueTimer.current=null;setFrozen(null);setEvidence(null);setBusy(false);setTransfer(null);setNotice('Captured view cleared by privacy policy');setNav(current=>({...current,frozen:false}));setLive(cleared.snapshot);session.cancel();return;}
    const withdrawn=event.type==='snapshot'&&event.snapshot.sequence>=finalSnapshot.sequence?applyLaunchPreviewInvalidation({...privacyView.current,generation:generation.current},event):null;
    if(withdrawn){finalSnapshot=withdrawn.snapshot;previewFloor.current={snapshotId:finalSnapshot.snapshotId,sequence:finalSnapshot.sequence};generation.current=withdrawn.generation;renderedRows.current=[];rowGeneration.current='';transferQueue.current=[];activeTransfer.current=null;for(const timer of [pending.current,transferTimer.current,cueTimer.current])if(timer)clearTimeout(timer);pending.current=null;transferTimer.current=null;cueTimer.current=null;setFrozen(null);setEvidence(null);setBusy(false);setTransfer(null);setNotice('Subtotal withdrawn · checking allowed sources');setNav(current=>({...current,frozen:false}));setLive(withdrawn.snapshot);return;}
    if(event.type==='transfer'){if(event.snapshotId!==finalSnapshot.snapshotId||event.sequence<finalSnapshot.sequence||event.sequence<=transferSequence.current)return;if(event.ackId&&(acknowledged.current.has(event.ackId)||transferQueue.current.some(queued=>queued.ackId===event.ackId)))return;transferSequence.current=event.sequence;if(transferQueue.current.length>=128){terminating.current=true;reason='cancelled';session.cancel();exit();return;}setTransfers(history=>[...history,event].slice(-100));transferQueue.current.push(event);if(transferTimer.current){clearTimeout(transferTimer.current);transferTimer.current=null;}if(!activeTransfer.current){activeTransfer.current=event;setTransfer(event);}return;}
    finalSnapshot=applyAuditEvent(finalSnapshot,event);
    if(previewFloor.current&&event.type==='snapshot'&&event.snapshot.snapshotId===previewFloor.current.snapshotId&&event.snapshot.sequence>previewFloor.current.sequence&&event.snapshot.launch?.facts)setNotice('');
    if(event.type==='error'||event.type==='snapshot'&&event.snapshot.launch?.stage==='ready'){if(pending.current){clearTimeout(pending.current);pending.current=null;}if(mounted.current)setLive(finalSnapshot);return;}
    if(pending.current===null)pending.current=setTimeout(()=>{pending.current=null;if(mounted.current)setLive(finalSnapshot);},80);
   };
   scan=Promise.resolve().then(()=>session.run(publish)).then(value=>{settled=true;finalSnapshot=launchResultAfterPrivacy(launchResultAfterPreview(value,finalSnapshot,previewFloor.current),revoked.current);if(pending.current){clearTimeout(pending.current);pending.current=null;}if(mounted.current)setLive(finalSnapshot);return finalSnapshot;},()=>{settled=true;finalSnapshot=launchResultAfterPrivacy({...finalSnapshot,status:reason==='cancelled'?'cancelled':'error',launch:finalSnapshot.launch?{...finalSnapshot.launch,stage:'ready'}:undefined},revoked.current);if(pending.current){clearTimeout(pending.current);pending.current=null;}if(mounted.current)setLive(finalSnapshot);return finalSnapshot;});
   return()=>{mounted.current=false;generation.current++;renderedRows.current=[];rowGeneration.current='';for(const timer of [pending.current,transferTimer.current,cueTimer.current])if(timer)clearTimeout(timer);};
  },[]);
  useEffect(()=>{
   if(!transfer||!transferFrameVisible(buildLaunchScreen(snapshot,nav,geometry),transfer))return;
   let cancelled=false;
   void Promise.resolve().then(async()=>{const terminal=app;if(!terminal)return;await terminal.waitUntilRenderFlush();if(cancelled||!mounted.current||terminating.current||activeTransfer.current!==transfer)return;if(transfer.ackId&&!acknowledged.current.has(transfer.ackId)){acknowledged.current.add(transfer.ackId);session.acknowledgeTransfer?.(transfer.ackId);}if(transferQueue.current[0]===transfer)transferQueue.current.shift();const next=transferQueue.current[0]??null;activeTransfer.current=next;if(next){setTransfer(next);return;}if(transferTimer.current)clearTimeout(transferTimer.current);transferTimer.current=setTimeout(()=>{transferTimer.current=null;if(mounted.current)setTransfer(null);},1800);}).catch(()=>{if(mounted.current)setNotice('Transfer notice could not be painted · request remains held');});
   return()=>{cancelled=true;};
  },[transfer?.ackId,transfer?.sequence,columns,rows,nav.mode]);
  const stop=()=>{if(terminating.current)return;terminating.current=true;reason=settled&&!transferQueue.current.length?'quit':'cancelled';generation.current++;renderedRows.current=[];rowGeneration.current='';if(!settled||transferQueue.current.length)session.cancel();transferQueue.current=[];activeTransfer.current=null;exit();};
  useEffect(()=>{const stopSignal=()=>stop();process.on('SIGTERM',stopSignal);process.on('SIGHUP',stopSignal);return()=>{process.off('SIGTERM',stopSignal);process.off('SIGHUP',stopSignal);};},[]);
  const cue=(text:string)=>{setNotice(text);if(cueTimer.current)clearTimeout(cueTimer.current);cueTimer.current=setTimeout(()=>{cueTimer.current=null;if(mounted.current)setNotice('');},1100);};
  const readAnchor=async()=>{
   if(busy||revoked.current)return;const anchor=layout.pages[clampWall(nav,layout.pages.length).page]?.anchors[0];if(!anchor){cue('No captured source reference on this page');return;}
   const token=++generation.current;setNav(current=>wallMode(current,'detail'));setEvidence(null);setBusy(true);setNotice('');
   try{let route=anchor.route;if(!route&&anchor.conversationId){let page=await session.prompts(anchor.conversationId,0,20),searched=0,prompt=page.prompts.find(p=>anchor.promptIds?.includes(p.id));while(!prompt&&page.nextOffset!==null&&searched++<50&&launchEvidenceCanPublish(token,generation.current,Boolean(revoked.current))){page=await session.prompts(anchor.conversationId,page.nextOffset,20);prompt=page.prompts.find(p=>anchor.promptIds?.includes(p.id));}route=prompt?.route;}const result=route&&launchEvidenceCanPublish(token,generation.current,Boolean(revoked.current))?await session.evidence(route):null;if(mounted.current&&launchEvidenceCanPublish(token,generation.current,Boolean(revoked.current)))setEvidence(result);}
   catch{if(mounted.current&&launchEvidenceCanPublish(token,generation.current,Boolean(revoked.current)))setNotice('Captured source cannot be read under the current privacy policy');}
   finally{if(mounted.current&&launchEvidenceCanPublish(token,generation.current,Boolean(revoked.current)))setBusy(false);}
  };
  usePaste(()=>{});
  useInput((input,key)=>{
   if([...input].length>1)return;
   if(input==='q'||key.ctrl&&input==='c'){stop();return;}
   if(input==='S'||input==='s'){frozenFrame.current=frame;setFrozen(nav.frozen?null:snapshot);setNav(current=>freezeWall(current));cue(nav.frozen?'Live view resumed':'Frozen · pages/help work');return;}
   if(input==='?'){generation.current++;setBusy(false);setNotice('');setNav(current=>wallMode(current,current.mode==='help'?'board':'help'));return;}
   if(key.escape){generation.current++;setBusy(false);setNotice('');if(nav.mode!=='board')setNav(current=>wallMode(current,'board'));else if(!settled)stop();return;}
   if(key.return){if(nav.mode==='help')setNav(current=>wallMode(current,'board'));else if(nav.mode==='board')void readAnchor();return;}
   const delta=key.rightArrow?1:key.leftArrow?-1:0;if(delta)setNav(current=>turnWall(current,delta,pageCount,nav.mode==='board'?layout:undefined));
  });
  const screen=buildLaunchScreen(snapshot,nav,geometry,layout),color=options.color!==false&&!('NO_COLOR' in process.env);
  // Immutable unchanged rows can be reused during real progress and tiny mascot updates.
  const sourceGeneration=JSON.stringify([live.snapshotId,live.sourceEpochs,live.coverage.gapCodes.filter(code=>/privacy|policy|forgot|tombstone/.test(code))]);if(rowGeneration.current!==sourceGeneration){renderedRows.current=[];rowGeneration.current=sourceGeneration;}
  const nodes=screen.map((segments,index)=>{const signature=JSON.stringify([columns,color,segments]),previous=renderedRows.current[index];if(previous?.signature===signature)return previous.node;const node=React.createElement(Box,{key:index,height:1,flexShrink:0,width:'100%'},React.createElement(Text,{wrap:'truncate'},...segments.map((segment,i)=>React.createElement(Text,{key:i,bold:segment.tone==='amberLight'||segment.tone==='amber',color:color?COLORS[segment.tone]:undefined},segment.text))));renderedRows.current[index]={signature,node};return node;});renderedRows.current.length=screen.length;
  return React.createElement(Box,{flexDirection:'column',width:columns,height:rows},...nodes);
 }
 const originalWrite=process.stdout.write;
 process.stdout.write=(function(...args:Parameters<typeof originalWrite>):boolean{if(typeof args[0]==='string'&&args[0].includes('\x1b[?1049h'))args[0]=args[0].replace('\x1b[?1049h','\x1b[?1049h\x1b[H');return originalWrite.apply(process.stdout,args);}) as typeof originalWrite;
 try{app=render(React.createElement(App),{alternateScreen:true,incrementalRendering:true,maxFps:12,exitOnCtrlC:false,patchConsole:false});}catch(error){session.cancel();throw error;}finally{process.stdout.write=originalWrite;}
 try{await app!.waitUntilExit();if(!settled)session.cancel();if(scan)await scan;return {snapshot:finalSnapshot,reason};}finally{if(!settled)session.cancel();app?.unmount();await app?.waitUntilRenderFlush();}
}
