/** The report renderer owns input; the supplied session owns background work. */
import type {AuditEvidence,AuditEvent,AuditSession,AuditSnapshot} from '../../../core/src/analytics/contracts.js';
import type {AuditLine,AuditTerminalOptions,AuditTerminalResult,AuditTone} from './index.js';
import {applyAuditEvent,auditCellWidth,auditClip} from './index.js';
import {buildReportDocument,buildReportHelp,buildEvidenceDocument,buildReportLoader,cleanReportText} from './report-document.js';
import type {ReportOptions,ReportDocument,ReportAnchor} from './report-document.js';
import {createReportNavigation,moveReport,reportEdge,reportMode,freezeReport,clampReportNavigation} from './report-navigation.js';
import type {ReportNavigation} from './report-navigation.js';
import {launchIsLoading} from './report-status.js';
export type LaunchNavigation=ReportNavigation;
export type LaunchGeometry=ReportOptions&{transfers?:readonly Extract<AuditEvent,{type:'transfer'}>[];};
export const createLaunchNavigation=createReportNavigation;
export {createReportNavigation,moveReport,reportEdge,reportMode,freezeReport,clampReportNavigation,buildReportDocument,buildReportHelp};
export type {ReportDocument,ReportAnchor,ReportNavigation};
const COLORS:Record<AuditTone,string>={normal:'#e9e8e0',dim:'#819097',amberDim:'#be7337',amber:'#f9ae56',amberLight:'#ffd89b',cyan:'#47d7e2',green:'#79c9a3',violet:'#b29ddb',blue:'#80ade0'};
const footer=(ascii:boolean):AuditLine=>[{text:ascii?'^v scroll | ? help | q quit':'↑↓ scroll · ? help · q quit',tone:'dim'}];
function hasReport(snapshot:AuditSnapshot):boolean{return Boolean(snapshot.launch?.facts)||!launchIsLoading(snapshot);}
export function launchDocument(snapshot:AuditSnapshot,nav:ReportNavigation,options:LaunchGeometry={}):ReportDocument {return nav.mode==='help'?buildReportHelp(snapshot,options,options.transfers):nav.mode==='detail'?buildEvidenceDocument(options.evidence,options):buildReportDocument(snapshot,options);}
/** One viewport over a complete wrapped document, plus one fixed footer. */
export function buildLaunchScreen(snapshot:AuditSnapshot,nav:ReportNavigation,options:LaunchGeometry={}):readonly AuditLine[]{
 const columns=Math.max(12,Math.min(options.columns??80,options.width??Infinity)),rows=Math.max(4,options.rows??24),visible=rows-1,widthOf=options.widthOf??auditCellWidth;
 let body:AuditLine[];
 if(nav.mode==='report'&&!hasReport(snapshot))body=buildReportLoader(snapshot,{...options,transfer:null,columns,rows});
 else{const doc=launchDocument(snapshot,nav,{...options,columns,rows}),scroll=clampReportNavigation(nav,doc.lines.length,visible).scroll;body=doc.lines.slice(scroll,scroll+visible);}
 if(options.transfer){const notice=cleanReportText(options.transfer.notice),lines=buildReportHelpNotice(notice,columns,widthOf);body=[...lines,...body].slice(0,visible);}
 while(body.length<visible)body.push([{text:'',tone:'normal'}]);
 return [...body,footer(Boolean(options.ascii))].map(line=>{let left=columns;return line.map(segment=>{const text=auditClip(segment.text,left,widthOf);left-=widthOf(text);return {...segment,text};});});
}
function buildReportHelpNotice(text:string,columns:number,widthOf:(text:string)=>number):AuditLine[]{const rows:AuditLine[]=[];let rest=text.replaceAll('\n',' ');while(rest){const part=auditClip(rest,Math.max(10,columns-4),widthOf);if(!part)break;rows.push([{text:'  '+part,tone:'amberLight'}]);rest=rest.slice(part.length);}return rows;}
export function transferFrameVisible(screen:readonly AuditLine[],event:Extract<AuditEvent,{type:'transfer'}>):boolean{const text=screen.flat().map(segment=>segment.text).join('').replace(/\s/g,'');return text.includes(cleanReportText(event.notice).replace(/\s/g,''))&&event.recipients.every(recipient=>text.includes(recipient.replace(/\s/g,'')));}
/** Plain output never depends on a terminal viewport or clips after40 lines. */
export function renderLaunchPlain(snapshot:AuditSnapshot,options:AuditTerminalOptions={}):string{return buildReportDocument(snapshot,{...options,columns:options.width??80}).lines.map(line=>line.map(segment=>segment.text).join('').trimEnd()).join('\n').trimEnd()+'\n';}

export async function runLaunchTerminal(session:AuditSession,options:AuditTerminalOptions={}):Promise<AuditTerminalResult>{
 if(!process.stdin.isTTY||!process.stdout.isTTY)return {snapshot:await session.run(),reason:'complete'};
 const [{default:React,useState,useRef,useEffect},{render,Box,Text,useInput,useApp,useWindowSize,useAnimation},{default:stringWidth}]=await Promise.all([import('react'),import('ink'),import('string-width')]);
 let finalSnapshot=session.snapshot(),reason:AuditTerminalResult['reason']='quit',settled=false,scan:Promise<AuditSnapshot>|null=null,app:ReturnType<typeof render>|null=null;
 function App(){
  const [live,setLive]=useState(finalSnapshot),[nav,setNav]=useState(createReportNavigation()),[frozen,setFrozen]=useState<AuditSnapshot|null>(null),[evidence,setEvidence]=useState<AuditEvidence|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[transfer,setTransfer]=useState<Extract<AuditEvent,{type:'transfer'}>|null>(null),[transfers,setTransfers]=useState<Extract<AuditEvent,{type:'transfer'}>[]>([]);
  const {columns:rawColumns,rows}=useWindowSize(),columns=Math.min(rawColumns,options.width??rawColumns),{exit}=useApp(),mounted=useRef(true),generation=useRef(0),pending=useRef<ReturnType<typeof setTimeout>|null>(null),transferTimer=useRef<ReturnType<typeof setTimeout>|null>(null),cueTimer=useRef<ReturnType<typeof setTimeout>|null>(null),frozenFrame=useRef(0),transferSequence=useRef(-1),acknowledged=useRef(new Set<string>());
  const snapshot=nav.frozen&&frozen?frozen:live,visible=Math.max(1,rows-1),loading=!hasReport(snapshot),{frame}=useAnimation({interval:100,isActive:loading&&nav.mode==='report'&&!nav.frozen&&options.motion!==false});
  const geometry:LaunchGeometry={...options,columns,rows,widthOf:stringWidth,frame:nav.frozen?frozenFrame.current:frame,evidence,busy,notice,transfer,transfers},doc=launchDocument(snapshot,nav,geometry);
  useEffect(()=>{setNav(current=>clampReportNavigation(current,doc.lines.length,visible));},[columns,rows,doc.lines.length,nav.mode]);
  useEffect(()=>{
   mounted.current=true;
   const publish=(event:AuditEvent)=>{
    if(event.type==='transfer'){if(event.snapshotId!==finalSnapshot.snapshotId||event.sequence<finalSnapshot.sequence||event.sequence<=transferSequence.current)return;transferSequence.current=event.sequence;setTransfers(history=>[...history,event].slice(-100));setTransfer(event);if(transferTimer.current){clearTimeout(transferTimer.current);transferTimer.current=null;}return;}
    finalSnapshot=applyAuditEvent(finalSnapshot,event);
    if(pending.current===null)pending.current=setTimeout(()=>{pending.current=null;if(mounted.current)setLive(finalSnapshot);},80);
   };
   scan=Promise.resolve().then(()=>session.run(publish)).then(value=>{settled=true;finalSnapshot=value;if(pending.current){clearTimeout(pending.current);pending.current=null;}if(mounted.current)setLive(value);return value;},()=>{settled=true;finalSnapshot={...finalSnapshot,status:reason==='cancelled'?'cancelled':'error',launch:finalSnapshot.launch?{...finalSnapshot.launch,stage:'ready'}:undefined};if(pending.current){clearTimeout(pending.current);pending.current=null;}if(mounted.current)setLive(finalSnapshot);return finalSnapshot;});
   return()=>{mounted.current=false;generation.current++;for(const timer of [pending.current,transferTimer.current,cueTimer.current])if(timer)clearTimeout(timer);};
  },[]);
  useEffect(()=>{
   if(!transfer||!transferFrameVisible(buildLaunchScreen(snapshot,nav,geometry),transfer))return;
   let cancelled=false;
   void Promise.resolve().then(async()=>{const terminal=app;if(!terminal)return;await terminal.waitUntilRenderFlush();if(cancelled||!mounted.current)return;if(transfer.ackId&&!acknowledged.current.has(transfer.ackId)){acknowledged.current.add(transfer.ackId);session.acknowledgeTransfer?.(transfer.ackId);}transferTimer.current=setTimeout(()=>{transferTimer.current=null;if(mounted.current)setTransfer(null);},1800);}).catch(()=>{if(mounted.current)setNotice('Transfer notice could not be painted · request remains held');});
   return()=>{cancelled=true;};
  },[transfer?.ackId,transfer?.sequence,columns,rows,nav.mode]);
  const stop=()=>{reason=settled?'quit':'cancelled';generation.current++;if(!settled)session.cancel();exit();};
  const cue=(text:string)=>{setNotice(text);if(cueTimer.current)clearTimeout(cueTimer.current);cueTimer.current=setTimeout(()=>{cueTimer.current=null;if(mounted.current)setNotice('');},1100);};
  const readAnchor=async()=>{
   if(busy)return;const report=buildReportDocument(snapshot,geometry),anchor=report.anchors.find(a=>a.row>=nav.scroll&&a.row<nav.scroll+visible);if(!anchor){cue('No source reference in this visible part of the report');return;}
   const token=++generation.current;setNav(current=>reportMode({...current,detailScroll:0},'detail'));setEvidence(null);setBusy(true);setNotice('');
   try{let route=anchor.route;if(!route&&anchor.conversationId){let page=await session.prompts(anchor.conversationId,0,20),searched=0,prompt=page.prompts.find(p=>anchor.promptIds?.includes(p.id));while(!prompt&&page.nextOffset!==null&&searched++<50&&token===generation.current){page=await session.prompts(anchor.conversationId,page.nextOffset,20);prompt=page.prompts.find(p=>anchor.promptIds?.includes(p.id));}route=prompt?.route;}const result=route?await session.evidence(route):null;if(mounted.current&&token===generation.current)setEvidence(result);}
   catch{if(mounted.current&&token===generation.current)setNotice('Captured source cannot be read under the current privacy policy');}
   finally{if(mounted.current&&token===generation.current)setBusy(false);}
  };
  useInput((input,key)=>{
   if(input==='q'||key.ctrl&&input==='c'){stop();return;}
   if(input==='S'||input==='s'){frozenFrame.current=frame;setFrozen(nav.frozen?null:snapshot);setNav(current=>freezeReport(current));cue(nav.frozen?'Live view resumed':'Frozen · scroll and help remain available');return;}
   if(input==='?'){generation.current++;setBusy(false);setNotice('');setNav(current=>reportMode(current,current.mode==='help'?'report':'help'));return;}
   if(key.escape){generation.current++;setBusy(false);setNotice('');if(nav.mode!=='report')setNav(current=>reportMode(current,'report'));else if(!settled)stop();return;}
   if(key.return){if(nav.mode==='help')setNav(current=>reportMode(current,'report'));else if(nav.mode==='report')void readAnchor();return;}
   if(key.home||input==='g'){setNav(current=>reportEdge(current,false,doc.lines.length,visible));return;}
   if(key.end||input==='G'){setNav(current=>reportEdge(current,true,doc.lines.length,visible));return;}
   const delta=key.pageDown?visible:key.pageUp?-visible:key.downArrow||input==='j'?1:key.upArrow||input==='k'?-1:0;if(delta)setNav(current=>moveReport(current,delta,doc.lines.length,visible));
  });
  const screen=buildLaunchScreen(snapshot,nav,geometry);
  return React.createElement(Box,{flexDirection:'column',width:columns,height:rows},...screen.map((segments,index)=>React.createElement(Box,{key:index,height:1,flexShrink:0,width:'100%'},React.createElement(Text,{wrap:'truncate'},...segments.map((segment,i)=>React.createElement(Text,{key:i,color:options.color===false||'NO_COLOR' in process.env?undefined:COLORS[segment.tone]},segment.text))))));
 }
 const originalWrite=process.stdout.write;
 process.stdout.write=(function(...args:Parameters<typeof originalWrite>):boolean{if(typeof args[0]==='string'&&args[0].includes('\x1b[?1049h'))args[0]=args[0].replace('\x1b[?1049h','\x1b[?1049h\x1b[H');return originalWrite.apply(process.stdout,args);}) as typeof originalWrite;
 try{app=render(React.createElement(App),{alternateScreen:true,incrementalRendering:true,maxFps:12,exitOnCtrlC:false,patchConsole:false});}catch(error){session.cancel();throw error;}finally{process.stdout.write=originalWrite;}
 try{await app!.waitUntilExit();if(!settled)session.cancel();if(scan)await scan;return {snapshot:finalSnapshot,reason};}finally{if(!settled)session.cancel();app?.unmount();await app?.waitUntilRenderFlush();}
}
