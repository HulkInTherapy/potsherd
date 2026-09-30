import type { Db } from '../db.js';

/** Native-only annotation keys retain every known harness, including tombstones. */
export const LEGACY_OWNERS_SQL=`SELECT native_session_id native_id,harness FROM memory_sources
 UNION SELECT id native_id,harness FROM sessions
 UNION SELECT session_id native_id,harness FROM ghosts`;
export const AMBIGUOUS_LEGACY_NATIVE_IDS_SQL=`SELECT native_id FROM (${LEGACY_OWNERS_SQL}) WHERE native_id IS NOT NULL GROUP BY native_id HAVING COUNT(DISTINCT harness)>1 OR SUM(CASE WHEN harness IS NULL OR TRIM(harness)='' OR harness='unknown' THEN 1 ELSE 0 END)>0`;
export function legacyNativeOwners(db:Db,nativeId:string):string[]{
 return (db.prepare(`SELECT DISTINCT harness FROM (${LEGACY_OWNERS_SQL}) WHERE native_id=?`).all(nativeId) as {harness:string}[]).map(row=>row.harness);
}
export function legacyNativeOwnershipAmbiguous(db:Db,nativeId:string):boolean {
 return Boolean(db.prepare(`SELECT 1 FROM (${AMBIGUOUS_LEGACY_NATIVE_IDS_SQL}) WHERE native_id=?`).get(nativeId));
}
