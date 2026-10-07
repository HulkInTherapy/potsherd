import {createHash} from 'node:crypto';
/** Stable native source identity, shared with memory without loading its database graph. */
export function sourceId(harness:string,nativeSessionId:string):string{return createHash('sha256').update(`source/v1\0${harness}\0${nativeSessionId}`).digest('hex');}
