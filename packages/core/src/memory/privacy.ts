import {redact} from '../redact.js';
import {createHash} from 'node:crypto';
export const NORMALIZATION_VERSION='redacted-evidence-v3';
export class MemoryPrivacyError extends Error{constructor(){super('privacy_refresh_required');}}
const checks=new Map<string,{unsafe:boolean;ranges:{start:number;end:number}[]}>();
/** Old immutable content is never rewritten under its old identity. */
function inspect(text:string,normalizationVersion?:string):{unsafe:boolean;ranges:{start:number;end:number}[]}{
 if(normalizationVersion===NORMALIZATION_VERSION)return {unsafe:false,ranges:[]};
 const key=createHash('sha256').update(text).digest('hex');const known=checks.get(key);if(known)return known;
 const redacted=redact(text);const result={unsafe:redacted.text!==text,ranges:redacted.hits.map(hit=>({start:hit.start,end:hit.start+hit.length}))};checks.set(key,result);if(checks.size>2048)checks.delete(checks.keys().next().value!);return result;
}
export function requiresPrivacyRefresh(text:string,normalizationVersion?:string):boolean{return inspect(text,normalizationVersion).unsafe;}
export function privacyAffectedRange(text:string,start:number,end:number,normalizationVersion?:string):boolean{return inspect(text,normalizationVersion).ranges.some(range=>range.start<end&&range.end>start);}
