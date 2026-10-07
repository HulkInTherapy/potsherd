/** Offsets are wrapped terminal lines, never source-row indexes. */
export type ReportMode='report'|'help'|'detail';
export interface ReportNavigation {mode:ReportMode;scroll:number;reportScroll:number;helpScroll:number;detailScroll:number;frozen:boolean;}
export function createReportNavigation():ReportNavigation{return {mode:'report',scroll:0,reportScroll:0,helpScroll:0,detailScroll:0,frozen:false};}
export const reportMaximum=(lines:number,visible:number)=>Math.max(0,lines-Math.max(1,visible));
export function clampReportNavigation(nav:ReportNavigation,lines:number,visible:number):ReportNavigation{const scroll=Math.max(0,Math.min(nav.scroll,reportMaximum(lines,visible)));return {...nav,scroll,[`${nav.mode}Scroll`]:scroll};}
export function moveReport(nav:ReportNavigation,delta:number,lines:number,visible:number):ReportNavigation{return clampReportNavigation({...nav,scroll:nav.scroll+delta},lines,visible);}
export function reportEdge(nav:ReportNavigation,end:boolean,lines:number,visible:number):ReportNavigation{return clampReportNavigation({...nav,scroll:end?reportMaximum(lines,visible):0},lines,visible);}
export function reportMode(nav:ReportNavigation,mode:ReportMode):ReportNavigation {return {...nav,[`${nav.mode}Scroll`]:nav.scroll,mode,scroll:mode===nav.mode?nav.scroll:nav[`${mode}Scroll`]};}
export function freezeReport(nav:ReportNavigation):ReportNavigation{return {...nav,frozen:!nav.frozen};}
