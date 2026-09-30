import type { Db } from '../db.js';
import { schemaVersion } from '../db.js';
import type { MemoryResponse, Scope } from './contracts.js';
export const MEMORY_SCHEMA_VERSION=18;
export class MemorySchemaError extends Error {
 constructor(readonly declaredVersion:number,readonly contiguousVersion=declaredVersion){super(declaredVersion>MEMORY_SCHEMA_VERSION?'unsupported_future_schema':'upgrade_required');}
}
export function assertMemorySchema(db:Db):void {const contiguous=schemaVersion(db);let declared=0;try{declared=(db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as {v:number|null}).v??0;}catch{}if(declared!==MEMORY_SCHEMA_VERSION||contiguous!==MEMORY_SCHEMA_VERSION)throw new MemorySchemaError(declared,contiguous);}
export function schemaResponse(error:MemorySchemaError,scope:Scope={}):MemoryResponse {
 return {contractVersion:2,requestId:'schema-readiness',coverage:{state:'upgrade_required',snapshotEpochs:{evidence:0,notes:0,lineage:0,deletion:0,vector:0},scope,capturedThrough:null,pendingSources:0,failedSources:0,omittedKinds:['unsupported_schema'],semantic:'disabled'},support:{state:'insufficient',method:'none',requirements:[],unresolved:[error.declaredVersion>MEMORY_SCHEMA_VERSION?'This store requires a newer client; do not downgrade it.':'Explicit maintenance must finish this store upgrade before recall.']},evidence:[],assertions:[],candidates:[],budget:{tokenizerId:'',usedTokens:0,remainingTokens:0,truncated:false,omittedItems:0},warnings:[error.message,`declared_schema:${error.declaredVersion}`,`supported_schema:${MEMORY_SCHEMA_VERSION}`,`contiguous_schema:${error.contiguousVersion}`]};
}
