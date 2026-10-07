import {createHash} from 'node:crypto';
import {DerivedCache,type DerivedCacheBinding} from './derived-cache.js';
import {bundledModelCatalog,validateModelCatalog,type ModelCatalog,type CatalogEntry} from './model-catalog.js';
const SOURCE='https://models.dev/api.json?type=all';
const binding:DerivedCacheBinding={sourceId:'models-dev-public-catalog',sourceIdentity:SOURCE,contentHash:'validated-public-catalog-v1',currentness:'public-last-valid-v1',privacyPolicy:'public-no-userdata',forgetEpoch:'not-applicable',normalizationVersion:'models-dev-reduced-v1'};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function rates(value:unknown):Record<string,number>{if(!object(value))return {};const result:Record<string,number>={};for(const key of ['input','output','cache_read','cache_write','reasoning']){const n=value[key];if(n===undefined)continue;if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw new Error('catalog_rates_invalid');result[key]=n;}return result;}
/** Validate the published provider/model shape and retain only pricing metadata. */
export function reducePublicCatalog(raw:unknown,retrievedAt=new Date().toISOString()):ModelCatalog{
 if(!object(raw)||Object.keys(raw).length>1000)throw new Error('catalog_shape_invalid');const models:CatalogEntry[]=[];
 for(const [provider,value] of Object.entries(raw)){if(!object(value)||!object(value.models))throw new Error('catalog_provider_invalid');for(const [id,v] of Object.entries(value.models)){if(!object(v)||v.id!==id)throw new Error('catalog_model_invalid');const cost=v.cost,entry:CatalogEntry={provider,id,canonical:typeof v.canonical_model_id==='string'?v.canonical_model_id:null,rates:rates(cost)};
   if(object(cost)&&cost.tiers!==undefined){if(!Array.isArray(cost.tiers))throw new Error('catalog_tiers_invalid');const tiers=cost.tiers.map(t=>{if(!object(t)||!object(t.tier)||t.tier.type!=='context'||!Number.isSafeInteger(t.tier.size)||Number(t.tier.size)<0)throw new Error('catalog_tier_unsupported');return {threshold:Number(t.tier.size),rates:rates(t)};});if(tiers.length)entry.tiers=tiers;}
   models.push(entry);if(models.length>20000)throw new Error('catalog_entries_limit');}}
 const result:ModelCatalog={basis:{source:SOURCE,retrievedAt,sha256:createHash('sha256').update(JSON.stringify(models)).digest('hex')},models};if(!models.length||!validateModelCatalog(result))throw new Error('catalog_validation_failed');return result;
}
export function cachedPublicCatalog(cache:DerivedCache|null):ModelCatalog{return cache?.read('public-catalog',binding,validateModelCatalog)??bundledModelCatalog;}
/** Saves only for future reports; an active report retains its chosen price basis. */
export async function refreshPublicCatalog(cache:DerivedCache|null,current:ModelCatalog,signal:AbortSignal,transport=globalThis.fetch):Promise<boolean>{
 if(!cache||Date.now()-Date.parse(current.basis.retrievedAt)<86400000||signal.aborted)return false;
 const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,3000);
 try{const response=await transport(SOURCE,{signal:controller.signal,redirect:'error'});if(!response.ok)return false;const reader=response.body?.getReader();if(!reader)return false;const chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>6*1024*1024)throw new Error('catalog_bytes_limit');chunks.push(item.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  const next=reducePublicCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));if(signal.aborted)return false;cache.write('public-catalog',binding,next,validateModelCatalog);return true;
 }catch{return false;}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
