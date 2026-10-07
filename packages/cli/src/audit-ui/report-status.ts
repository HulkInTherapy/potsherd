import type {AuditSnapshot,AuditMetric} from '../../../core/src/analytics/contracts.js';
const metricCount=(metric:AuditMetric)=>metric.state==='unavailable'||metric.state==='not_run'?null:metric.value;
export interface LaunchAnalysisStatus {kind:'local'|'loading'|'empty'|'offline'|'allowance'|'provider'|'cancelled'|'not_run'|'ready';summary:string|null;action:string|null;code:string|null;}
export function launchIsLoading(snapshot:AuditSnapshot):boolean{return Boolean(snapshot.launch&&snapshot.launch.stage!=='ready'&&!['cancelled','error'].includes(snapshot.status));}
export function launchGaps(snapshot:AuditSnapshot):Set<string>{return new Set([...snapshot.coverage.gapCodes,...snapshot.sources.flatMap(source=>source.gapCodes),...(snapshot.launch?.semantics?.gaps??[]),...(snapshot.semantics.errorCode?[snapshot.semantics.errorCode]:[])]);}
function localReadFailure(gaps:Set<string>):{summary:string;action:string;code:string}|null {
 const causes:readonly [string,string,string][]=[
  ['audit_snapshot_stale','Local history changed during this audit','Run slopie audit again to read current sources.'],
  ['audit_sqlite_snapshot_stale','Local SQLite snapshot changed','Let local writes settle, then run slopie audit again.'],
  ['source_or_policy_changed','Local source or privacy settings changed','Run slopie audit again with the current settings.'],
  ['source_or_privacy_changed','Local source or privacy settings changed','Run slopie audit again with the current settings.'],
  ['audit_sqlite_rollback_journal_unavailable','Local SQLite rollback journal is active','Let the database writer finish, then retry.'],
  ['audit_sqlite_live_journal_unavailable','Local SQLite journal blocks safe reading','Let the database writer finish, then retry.'],
  ['audit_sqlite_snapshot_byte_limit','Archive exceeds snapshot limit','Check archive size and supported snapshot limits before retrying.'],
  ['audit_sqlite_snapshot_disk_limit','Not enough free space for a safe snapshot','Free local disk space, then retry.'],
  ['audit_sqlite_wal_index_unavailable','Local WAL commit boundary is unavailable','Let the writer finish; check an owned backup if this persists.'],
  ['audit_sqlite_wal_integrity_unavailable','Local WAL committed data failed integrity checks','Check the source database or an owned backup before retrying.'],
  ['audit_sqlite_snapshot_time_limit','Local SQLite snapshot timed out','Retry after local database activity settles.'],
  ['audit_sqlite_format_unavailable','Local store is not readable SQLite','Check the selected store path, then retry.'],
  ['audit_sqlite_wal_header_unavailable','Local WAL snapshot failed integrity checks','Retry after local writes settle; check the source if it persists.'],
  ['audit_sqlite_wal_incomplete_tail','Local WAL snapshot is incomplete','Let the database writer finish, then retry.'],
  ['audit_sqlite_snapshot_corrupt','Local SQLite snapshot failed integrity checks','Check the source database or an owned backup before retrying.'],
  ['ignore_policy_unavailable','Local ignore settings could not be read','Check access to your ignore settings, then retry.'],
  ['privacy_refresh_required','Local history needs a privacy refresh','Refresh the local privacy normalization before retrying.'],
  ['store_policy_unavailable','Local history policy could not be read','Check local store access and privacy settings, then retry.'],
  ['raw_lane_policy_hold','Local history is held by its privacy policy','Check local store access and privacy settings, then retry.'],
 ];
 for(const [code,summary,action] of causes)if(gaps.has(code))return {summary,action,code};
 const sqlite=[...gaps].find(code=>code.startsWith('audit_sqlite_'));if(sqlite)return {summary:'Local SQLite history could not be read',action:'Check store access and retry after local writes settle.',code:sqlite};
 return null;
}
export function launchAnalysisStatus(snapshot:AuditSnapshot):LaunchAnalysisStatus {
 const sem=snapshot.launch?.semantics,gaps=launchGaps(snapshot),attempts=sem?.attempts??0,local=attempts===0?localReadFailure(gaps):null;
 if(local)return {kind:'local',...local};
 if(launchIsLoading(snapshot))return {kind:'loading',summary:sem?.state==='pending'?'Analysis pending. Results appear when judgments finish.':null,action:null,code:null};
 if(snapshot.status==='cancelled'||sem?.state==='cancelled')return {kind:'cancelled',summary:'Analysis cancelled',action:null,code:null};
 if(snapshot.status==='error')return {kind:'not_run',summary:'Audit did not finish',action:'Run slopie audit again to retry.',code:null};
 if(sem?.state==='pending')return {kind:'not_run',summary:'Analysis did not finish',action:'Run slopie audit again to retry.',code:null};
 if(attempts>0){
  if(gaps.has('free_quota_unavailable'))return {kind:'provider',summary:'Jev quota exhausted',action:'Retry when free capacity returns.',code:'free_quota_unavailable'};
  if(gaps.has('free_retry_delay_exceeded'))return {kind:'provider',summary:'Free analysis cooldown is active',action:'Retry when free capacity returns.',code:'free_retry_delay_exceeded'};
  if(gaps.has('free_access_denied'))return {kind:'provider',summary:'Free analysis access was denied',action:'Local results remain available.',code:'free_access_denied'};
  if(sem?.state==='unavailable')return {kind:'provider',summary:'Analysis unavailable after attempted requests',action:'Local results remain available.',code:null};
 }
 if(sem?.state==='complete'||sem?.state==='partial')return {kind:'ready',summary:null,action:null,code:null};
 if(metricCount(snapshot.metrics.nativeUserInputs??snapshot.metrics.humanPrompts)===0)return {kind:'empty',summary:'No eligible user input in this scope',action:null,code:null};
 if(gaps.has('offline_requested')||gaps.has('developer_prepare_only'))return {kind:'offline',summary:gaps.has('offline_requested')?'Offline mode · analysis not requested':'Preparation only · analysis not requested',action:null,code:null};
 if(gaps.has('semantic_window_unavailable')||gaps.has('free_allowance_exhausted'))return {kind:'allowance',summary:'No work window fits this run’s allowance',action:'Inspect period estimates or choose a smaller scope.',code:null};
 if(gaps.has('free_access_unverified'))return {kind:'not_run',summary:'Free analysis access is unverified',action:null,code:'free_access_unverified'};
 return {kind:'not_run',summary:'Analysis not run',action:null,code:null};
}
