import type { EvidenceRecord } from './contracts.js';
import type { Db } from '../db.js';
import type { ParseResult, SessionRecord, Exchange } from '../adapters/types.js';
import { publishSource, sourceId } from './source.js';
import { hash, identity, currentSpanPolicy, SPAN_MANIFEST_VERSION, type SpanTokenizer } from './spans.js';
/** Restartable explicit upgrade. Stored projections cannot manufacture a raw artifact hash. */
export function backfillLegacy(db: Db, options: {
    limit?: number;
    tokenizer?: SpanTokenizer;
} = {}): {
    completed: number;
    remaining: number;
} {
    const rows = db.prepare(`SELECT s.* FROM sessions s WHERE NOT EXISTS(SELECT 1 FROM memory_sources m WHERE m.harness=s.harness AND m.native_session_id=s.id AND m.active_revision_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM memory_sources m JOIN forget_tombstones t ON t.source_id=m.source_id WHERE m.harness=s.harness AND m.native_session_id=s.id AND t.state<>'reversed') ORDER BY s.id LIMIT ?`).all(options.limit ?? 100) as Record<string, unknown>[];
    let completed = 0;
    for (const s of rows) {
        const sid = sourceId(String(s.harness), String(s.id));
        if (db.prepare("SELECT 1 FROM forget_tombstones WHERE source_id=? AND state<>'reversed'").get(sid))
            continue;
        const session: SessionRecord = { id: String(s.id), harness: s.harness as SessionRecord['harness'], sourcePath: String(s.source_path ?? ''), project: String(s.project ?? ''), projectSlug: String(s.project_slug ?? ''), startedAt: String(s.started_at ?? ''), endedAt: String(s.ended_at ?? ''), isSidechain: !!s.is_sidechain, counts: { userPrompts: Number(s.user_prompts), assistantTurns: Number(s.assistant_turns), toolCalls: Number(s.tool_calls), bytes: Number(s.bytes) }, status: s.status as SessionRecord['status'], ...(s.git_branch ? { gitBranch: String(s.git_branch) } : {}) };
        const exchanges = (db.prepare('SELECT * FROM exchanges WHERE session_id=? ORDER BY seq').all(s.id) as Record<string, unknown>[]).map((e): Exchange => ({ id: String(e.id), sessionId: String(s.id), seq: Number(e.seq), ts: String(e.ts ?? ''), userText: String(e.user_text), assistantText: String(e.assistant_text), toolCalls: (db.prepare('SELECT * FROM tool_calls WHERE exchange_id=? ORDER BY id').all(e.id) as Record<string, unknown>[]).map(t => ({ name: String(t.name ?? ''), input: String(t.input ?? ''), ...(t.result !== null ? { result: String(t.result) } : {}), isError: !!t.is_error })), filesTouched: JSON.parse(String(e.files_touched)), isSidechain: !!e.is_sidechain, redacted: !!e.redacted }));
        const parsed: ParseResult = { session, exchanges, endOffset: 0, malformedLines: 0, unknownTypes: {}, evidenceVersion: 'legacy-stored-projection-v1' };
        const projectionHash = hash(JSON.stringify({ session, exchanges }));
        const inputHash = `legacy-projection:${projectionHash}`;
        const at = new Date().toISOString();
        const job = identity('rebuild', sid, inputHash);
        db.transaction(() => { db.prepare("INSERT OR IGNORE INTO maintenance_jobs VALUES(?,'rebuild',?,NULL,?,'pending',0,?,NULL,NULL,?,?,NULL,NULL)").run(job, sid, inputHash, at, at, at); publishSource(db, { parsed, artifactHash: inputHash, artifactBytes: 0, tokenizer: options.tokenizer, publishAuxiliary: () => { db.prepare("UPDATE maintenance_jobs SET state='done',updated_at=? WHERE job_id=?").run(at, job); } }); })();
        completed++;
    }
    const remainingRows = db.prepare(`SELECT s.id,s.harness FROM sessions s WHERE NOT EXISTS(SELECT 1 FROM memory_sources m WHERE m.harness=s.harness AND m.native_session_id=s.id AND m.active_revision_id IS NOT NULL)`).all() as {
        id: string;
        harness: string;
    }[];
    return { completed, remaining: remainingRows.filter(s => !db.prepare("SELECT 1 FROM forget_tombstones WHERE source_id=? AND state<>'reversed'").get(sourceId(s.harness, s.id))).length };
}
/** Ghost evidence proves retained prompts only; it never manufactures assistant/tool content. */
export function backfillLegacyGhosts(db: Db, limit = 100): number {
    const ghosts = db.prepare('SELECT * FROM ghosts ORDER BY session_id').all() as Record<string, unknown>[];
    let completed = 0;
    for (const g of ghosts) {
        if (completed >= limit)
            break;
        const sid = sourceId(String(g.harness), String(g.session_id));
        if (db.prepare("SELECT 1 FROM forget_tombstones WHERE source_id=? AND state<>'reversed'").get(sid))
            continue;
        const prompts = db.prepare('SELECT * FROM ghost_prompts WHERE session_id=? ORDER BY seq,id').all(g.session_id) as Record<string, unknown>[];
        const records = prompts.map(p => ({ unitKey: `ghost_prompt:${p.id}`, role: 'ghost_prompt' as const, text: String(p.text), eventAt: typeof p.ts === 'string' && Number.isFinite(Date.parse(p.ts)) ? p.ts : null, timeBasis: typeof p.ts === 'string' && Number.isFinite(Date.parse(p.ts)) ? 'record' as const : 'unknown' as const, project: String(g.project ?? ''), locator: { recordKey: String(p.id), mapping: 'unavailable' as const }, locatorFidelity: 'record_id' as const, recordType: 'ghost_history' }));
        const projectionHash = `legacy-projection:${hash(JSON.stringify({ g, prompts }))}`;
        const current = db.prepare('SELECT r.artifact_hash FROM memory_sources s JOIN source_revisions r ON r.revision_id=s.active_revision_id WHERE s.source_id=?').get(sid) as {
            artifact_hash: string;
        } | undefined;
        if (current) {
            if (current.artifact_hash === projectionHash)
                continue;
            if (!current.artifact_hash.startsWith('legacy-projection:'))
                continue;
        }
        const parsed: ParseResult = { session: { id: String(g.session_id), harness: g.harness as SessionRecord['harness'], sourcePath: '', project: String(g.project ?? ''), projectSlug: '', startedAt: String(g.first_ts ?? ''), endedAt: String(g.last_ts ?? ''), isSidechain: false, counts: { userPrompts: prompts.length, assistantTurns: 0, toolCalls: 0, bytes: 0 }, status: 'ghost' }, exchanges: [], records, unknownTypes: { missing_transcript: 1 }, malformedLines: 0, endOffset: 0, evidenceVersion: 'ghost-retained-prompts-v1' };
        publishSource(db, { parsed, artifactHash: projectionHash, artifactBytes: 0 });
        completed++;
    }
    return completed;
}

/** Rebuild search windows from retained units, with no raw-source or authority invention. */
export function rebuildEvidenceSpans(db:Db,options:{tokenizer:SpanTokenizer;beforeCommit?:()=>void;limit?:number}):{rebuilt:number;remaining:number}{
 const policy=currentSpanPolicy(options.tokenizer);
 const pending=()=>db.prepare(`SELECT s.*,r.*,c.acknowledged_fingerprint,c.continuation_json FROM memory_sources s JOIN source_revisions r ON r.revision_id=s.active_revision_id LEFT JOIN capture_checkpoints c ON c.source_id=s.source_id WHERE s.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=s.source_id AND t.state<>'reversed') AND (json_extract(r.coverage_gaps_json,'$.chunkPolicy') IS NOT ? OR json_extract(r.coverage_gaps_json,'$.manifestVersion') IS NOT ? OR EXISTS(SELECT 1 FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id WHERE rs.revision_id=r.revision_id AND p.chunk_policy<>?)) ORDER BY s.source_id`).all(policy,SPAN_MANIFEST_VERSION,policy) as Record<string,unknown>[];
 let rebuilt=0;
 for(const row of pending().slice(0,options.limit??100)){
  if(row.availability==='conflict')continue;
  const units=db.prepare('SELECT u.* FROM revision_units ru JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ru.revision_id=? ORDER BY ru.ordinal').all(row.revision_id) as Record<string,unknown>[];
  const records:EvidenceRecord[]=units.map(u=>({unitKey:String(u.unit_key),role:u.role as EvidenceRecord['role'],text:String(u.text),eventAt:u.event_at as string|null,timeBasis:u.time_basis as EvidenceRecord['timeBasis'],...(u.project!==null?{project:String(u.project)}:{}),...(u.branch!==null?{branch:String(u.branch)}:{}),...(u.tool_name!==null?{toolName:String(u.tool_name)}:{}),...(u.tool_call_id!==null?{toolCallId:String(u.tool_call_id)}:{}),...(u.outcome!==null?{outcome:u.outcome as EvidenceRecord['outcome']}:{}),...(u.legacy_exchange_id!==null?{exchangeId:String(u.legacy_exchange_id)}:{}),...(u.legacy_seq!==null?{seq:Number(u.legacy_seq)}:{}),locator:JSON.parse(String(u.locator_json)),locatorFidelity:u.locator_fidelity as EvidenceRecord['locatorFidelity'],recordType:'retained_unit_rebuild'}));
  const parents=db.prepare("SELECT parent.native_session_id,rel.kind FROM source_relations rel JOIN memory_sources parent ON parent.source_id=rel.from_source_id WHERE rel.to_source_id=? AND rel.evidence_revision_id=? AND rel.kind IN ('spawn','resume')").all(row.source_id,row.revision_id) as {native_session_id:string;kind:string}[];const parentIds=[...new Set(parents.map(p=>p.native_session_id))];
  const gaps=JSON.parse(String(row.coverage_gaps_json)) as {unknownTypes?:Record<string,number>;malformedLines?:number;pendingFinalLineBytes?:number};
  const parsed:ParseResult={session:{id:String(row.native_session_id),harness:row.harness as SessionRecord['harness'],sourcePath:'',project:String(row.project??''),projectSlug:'',startedAt:String(row.event_min??''),endedAt:String(row.event_max??''),isSidechain:parentIds.length===1&&parents.some(p=>p.kind==='spawn'),...(parentIds.length===1?{parentSessionId:parentIds[0]}:{}),...(row.branch!==null?{gitBranch:String(row.branch)}:{}),counts:{userPrompts:0,assistantTurns:0,toolCalls:0,bytes:Number(row.artifact_bytes)+(gaps.pendingFinalLineBytes??0)},status:row.availability==='archived'?'archived':row.availability==='lost'?'ghost':'live'},exchanges:[],records,evidenceVersion:String(row.adapter_version),unknownTypes:gaps.unknownTypes??{},malformedLines:gaps.malformedLines??0,endOffset:Number(row.artifact_bytes),...(row.continuation_json?{continuation:JSON.parse(String(row.continuation_json))}: {})};
  const result=publishSource(db,{parsed,artifactHash:String(row.artifact_hash),artifactBytes:Number(row.artifact_bytes),...(row.archive_relative_path?{archiveRelativePath:String(row.archive_relative_path)}:{}),fingerprint:String(row.acknowledged_fingerprint??row.artifact_hash),tokenizer:options.tokenizer,sourceCompleteness:row.completeness as 'complete'|'partial'|'legacy',retainedRevisionId:String(row.revision_id),expectedActiveRevisionId:String(row.revision_id),beforeCommit:options.beforeCommit});
  if(result.activated)rebuilt++;
 }
 return {rebuilt,remaining:pending().length};
}
