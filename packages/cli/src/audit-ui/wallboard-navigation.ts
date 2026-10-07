import type {WallLayout,WallCardId} from './wallboard.js';
export interface WallNavigation {mode:'board'|'help'|'detail';page:number;anchor:WallCardId;boardPage:number;boardAnchor:WallCardId;frozen:boolean;}
export function createWallNavigation():WallNavigation{return {mode:'board',page:0,anchor:'models',boardPage:0,boardAnchor:'models',frozen:false};}
export function clampWall(nav:WallNavigation,count:number):WallNavigation{return {...nav,page:Math.min(Math.max(0,nav.page),Math.max(0,count-1))};}
export function turnWall(nav:WallNavigation,delta:number,count:number,layout?:WallLayout):WallNavigation {const next=clampWall({...nav,page:nav.page+delta},count);return {...next,anchor:nav.mode==='board'?layout?.pages[next.page]?.anchor??nav.anchor:nav.anchor};}
export function resizeWall(nav:WallNavigation,layout:WallLayout):WallNavigation {if(nav.mode!=='board')return nav;const found=layout.pages.findIndex(page=>page.cards.includes(nav.anchor));return clampWall({...nav,page:found>=0?found:nav.page},layout.pages.length);}
export function wallMode(nav:WallNavigation,mode:WallNavigation['mode']):WallNavigation {if(mode===nav.mode)return nav;if(mode==='board')return {...nav,mode,page:nav.boardPage,anchor:nav.boardAnchor};return {...nav,mode,boardPage:nav.mode==='board'?nav.page:nav.boardPage,boardAnchor:nav.mode==='board'?nav.anchor:nav.boardAnchor,page:0};}
export function freezeWall(nav:WallNavigation):WallNavigation{return {...nav,frozen:!nav.frozen};}
