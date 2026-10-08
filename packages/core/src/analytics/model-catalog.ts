import {createHash} from 'node:crypto';
import {pricingSnapshot} from './model-pricing-snapshot.js';
import type {PricingBasis} from './launch-contracts.js';
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
