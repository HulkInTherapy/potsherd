import {enqueueEmbeddingJob} from './jobs.js';
import {DEFAULT_SPACE_ID} from './assets.js';
import {AMBIGUOUS_LEGACY_NATIVE_IDS_SQL} from './legacy-ownership.js';
import {producerView} from './producer.js';
import {storedCaptureLimitations} from './capabilities.js';
import type { Db } from '../db.js';
import type { ParseResult } from '../adapters/types.js';
import type { EvidenceRecord, EvidenceItem, SpanRef, Epochs, Coverage, Scope } from './contracts.js';
/** Stored v3 dispatch positives need an unambiguous prior nonnative call to retain authority. */
export const OUTCOME_REFRESH_SQL=`s.harness='codex' AND u.role='tool_result' AND CASE WHEN r.adapter_version IN ('codex-records-v1','codex-records-v2') THEN 1 WHEN r.adapter_version='codex-records-v5' AND u.outcome IN ('success','error') AND (u.tool_name IS NULL OR u.tool_name IN ('exec_command','write_stdin')) THEN 1 WHEN r.adapter_version IN ('codex-records-v3','codex-records-v4') AND u.outcome IN ('success','error') THEN CASE WHEN u.tool_name IS NULL OR u.tool_name IN ('exec_command','write_stdin') OR u.tool_call_id IS NULL THEN 1 WHEN (SELECT COUNT(*) FROM revision_units cr JOIN evidence_units cu ON cu.unit_revision_id=cr.unit_revision_id WHERE cr.revision_id=r.revision_id AND cu.role='tool_input' AND cu.tool_call_id=u.tool_call_id)<>1 THEN 1 WHEN NOT EXISTS(SELECT 1 FROM revision_units cr JOIN evidence_units cu ON cu.unit_revision_id=cr.unit_revision_id JOIN revision_units result ON result.revision_id=cr.revision_id AND result.unit_revision_id=u.unit_revision_id WHERE cr.revision_id=r.revision_id AND cu.role='tool_input' AND cu.tool_call_id=u.tool_call_id AND cu.tool_name=u.tool_name AND cr.ordinal<result.ordinal) THEN 1 ELSE 0 END ELSE 0 END`;

const historyVersion=(version:string)=>/^(claude|codex)-history-records-v1$/.test(version);
import {countUnknownNoteEvents,countPrivacyBlockedNotes,countOutcomeBlockedNotes} from './notes-store.js';
import {scopeSql} from './scope.js';
import { redact } from '../redact.js';
import { elideBinary } from '../redact-elide.js';
import { hash, identity, buildSpanManifest, spanManifestHash, currentSpanPolicy, SPAN_MANIFEST_VERSION, type SpanTokenizer } from './spans.js';
import {NORMALIZATION_VERSION,requiresPrivacyRefresh,privacyAffectedRange} from './privacy.js';
export {NORMALIZATION_VERSION} from './privacy.js';
export function sourceId(harness: string, nativeSessionId: string): string { return hash(`source/v1\0${harness}\0${nativeSessionId}`); }
export function readEpochs(db: Db): Epochs { const r = db.prepare('SELECT * FROM memory_epochs WHERE singleton=1').get() as Record<string, number>; return { evidence: r.evidence_epoch!, notes: r.notes_epoch!, lineage: r.lineage_epoch!, deletion: r.deletion_epoch!, vector: r.vector_epoch! }; }
export function compatibilityRecords(parsed: ParseResult): EvidenceRecord[] {
    const records: EvidenceRecord[] = [];
    for (const e of parsed.exchanges) {
        const base = { exchangeId: e.id, seq: e.seq, eventAt: e.ts || null, timeBasis: 'exchange' as const, locatorFidelity: 'exchange_ordinal' as const, project: parsed.session.project, branch: parsed.session.gitBranch, recordType: 'legacy_exchange' };
        const add = (role: EvidenceRecord['role'], text: string, key: string, extra: Partial<EvidenceRecord> = {}) => { if (text)
            records.push({ ...base, unitKey: `${role}:${key}`, role, text, locator: { recordKey: key, mapping: 'unavailable' }, ...extra }); };
        add('user', e.userText, `${e.seq}:user`);
        add('assistant', e.assistantText, `${e.seq}:assistant`);
        e.toolCalls.forEach((t, i) => { add('tool_input', t.input, `${e.seq}:tool:${i}:input`, { toolName: t.name }); if (t.result !== undefined)
            add('tool_result', t.result, `${e.seq}:tool:${i}:result`, { toolName: t.name, outcome: t.isError ? 'error' : 'unknown' }); });
    }
    return records;
}
export type PublicationInput = {
    parsed: ParseResult;
    artifactHash: string;
    artifactBytes: number;
    archiveRelativePath?: string;
    fingerprint?: string;
    observedAt?: string;
    tokenizer?: SpanTokenizer;
    publishCompatibility?: () => void;
    publishAuxiliary?: () => void;
    expectedActiveRevisionId?: string | null;
    beforeCommit?: () => void;
    /** Capture verified every referenced immutable raw artifact against consumed bytes. */
    prefixCompatibleArtifactHashes?:string[];
    olderArchivedPrefix?:boolean;
    retainedArchivePath?:string;
    sourceCompleteness?:'complete'|'partial'|'legacy';
    /** Internal span-only rebuild: bind exact units/provenance to this immutable revision. */
    retainedRevisionId?:string;
};
/** Caller prepares all async/file work first; the entire required publication commits together. */
export function publishSource(db: Db, input: PublicationInput): {
    sourceId: string;
    revisionId: string;
    spans: number;
    conflict:boolean;
    activated:boolean;
} {
    const { parsed } = input;
    const s = parsed.session;
    const sid = sourceId(s.harness, s.id);
    const retained=input.retainedRevisionId?db.prepare('SELECT * FROM source_revisions WHERE revision_id=? AND source_id=?').get(input.retainedRevisionId,sid) as Record<string,unknown>|undefined:undefined;
    if(input.retainedRevisionId&&(!retained||retained.artifact_hash!==input.artifactHash||retained.artifact_bytes!==input.artifactBytes||retained.adapter_version!==parsed.evidenceVersion||s.sourcePath!==''||input.expectedActiveRevisionId!==input.retainedRevisionId||(s.project||null)!==retained.project||(s.gitBranch??null)!==retained.branch||(retained.archive_relative_path??undefined)!==input.archiveRelativePath))throw new Error('retained revision provenance mismatch');
    const normalizationVersion=retained?String(retained.normalization_version):NORMALIZATION_VERSION;
    const at = retained?new Date().toISOString():input.observedAt ?? new Date().toISOString();
    const records = parsed.records ?? compatibilityRecords(parsed);
    const normalized = retained?records:records.map(record => ({ ...record, eventAt: record.eventAt && Number.isFinite(Date.parse(record.eventAt)) ? new Date(record.eventAt).toISOString() : null, timeBasis: record.eventAt && Number.isFinite(Date.parse(record.eventAt)) ? record.timeBasis : 'unknown' as const, text: redact(elideBinary(record.text)).text }));
    const snapshots = normalized.map(r => { const project = (r.project ?? (parsed.records ? null : s.project)) || null; const branch = r.branch ?? null; const locator = JSON.stringify(r.locator); const id = identity(sid, r.unitKey, hash(r.text), normalizationVersion, r.role, locator, r.eventAt ?? '', r.timeBasis, project ?? '', branch ?? '', r.toolName ?? '', r.toolCallId ?? '', r.outcome ?? '', r.locatorFidelity); const context=redact(`[project:${project??'unknown'}]\n[role:${r.role}]\n[tool:${r.toolName??'none'}]\n[outcome:${r.outcome??'unknown'}]`).text;const manifest=buildSpanManifest(r.text,input.tokenizer,context);return {r,project,branch,locator,id,windows:manifest.windows,manifest}; });
    if(retained){const original=db.prepare('SELECT u.* FROM revision_units ru JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ru.revision_id=? ORDER BY ru.ordinal').all(input.retainedRevisionId) as Record<string,unknown>[];if(original.length!==snapshots.length||original.some((unit,i)=>unit.unit_revision_id!==snapshots[i]!.id||unit.text!==snapshots[i]!.r.text||unit.text_hash!==hash(snapshots[i]!.r.text)||unit.normalization_version!==normalizationVersion||(unit.legacy_exchange_id??undefined)!==snapshots[i]!.r.exchangeId||(unit.legacy_seq??undefined)!==snapshots[i]!.r.seq))throw new Error('retained ordered units mismatch');}
    const policy=currentSpanPolicy(input.tokenizer);
    const manifestHash=spanManifestHash(policy,snapshots);
    const version = parsed.evidenceVersion ?? 'legacy-exchanges-v1';
    const rid = identity(sid, input.artifactHash, version, normalizationVersion, manifestHash);
    let total = 0;
    let conflict=false;
    let activated=true;
    db.transaction(() => {
        if (db.prepare("SELECT 1 FROM forget_tombstones WHERE source_id=? AND state<>'reversed'").get(sid))
            throw new Error('source forgotten');
        const active = db.prepare('SELECT s.active_revision_id,s.availability,r.artifact_hash,r.adapter_version FROM memory_sources s LEFT JOIN source_revisions r ON r.revision_id=s.active_revision_id WHERE s.source_id=?').get(sid) as {
            active_revision_id: string | null;availability:string;artifact_hash:string|null;adapter_version:string|null;
        } | undefined;
        if (input.expectedActiveRevisionId !== undefined && (active?.active_revision_id ?? null) !== input.expectedActiveRevisionId)
            throw new Error('stale capture revision');
        db.prepare('INSERT OR IGNORE INTO memory_sources VALUES(?,?,?,NULL,?,?,?)').run(sid, s.harness, s.id, s.project || null, s.status === 'archived' ? 'archived' : s.status === 'ghost' ? 'lost' : 'live', at);
        const retainedGaps=retained?JSON.parse(String(retained.coverage_gaps_json)):null;
        if(retained&&(retainedGaps===null||typeof retainedGaps!=='object'||Array.isArray(retainedGaps)||Object.getPrototypeOf(retainedGaps)!==Object.prototype))throw new Error('retained coverage shape');
        const gaps: Record<string, unknown> = retained?{...retainedGaps}:{ unknownTypes: parsed.unknownTypes, malformedLines: parsed.malformedLines };
        if(!retained&&historyVersion(version))gaps.originalTranscript='unavailable';
        if(!retained&&active?.active_revision_id&&historyVersion(active.adapter_version??'')&&!historyVersion(version))gaps.richerSourceTransition={fromRevisionId:active.active_revision_id,basis:'history_to_transcript'};
        if (!retained&&!parsed.records)
            gaps.recordFidelity = 'exchange_ordinal';
        if(!retained&&s.counts.bytes>input.artifactBytes&&!input.artifactHash.startsWith('legacy-projection:'))gaps.pendingFinalLineBytes=s.counts.bytes-input.artifactBytes;
        gaps.chunkPolicy=policy;gaps.manifestVersion=SPAN_MANIFEST_VERSION;
        if (!retained&&input.artifactHash.startsWith('legacy-projection:'))
            gaps.rawArtifact = 'unavailable';
        const dates = normalized.map(r => r.eventAt).filter((x): x is string => !!x).sort();
        db.prepare('INSERT OR IGNORE INTO source_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid, sid, input.artifactHash, input.artifactBytes, input.archiveRelativePath ?? null, version, normalizationVersion, manifestHash, dates[0] ?? null, dates.at(-1) ?? null, at, s.project || null, s.gitBranch ?? null, (retained?retained.completeness:input.sourceCompleteness)??(parsed.records ? (parsed.malformedLines || Object.keys(parsed.unknownTypes).length || gaps.pendingFinalLineBytes ? 'partial' : 'complete') : 'legacy'), JSON.stringify(gaps));
        let ordinal = 0;
        snapshots.forEach((x, i) => {
            const r = x.r;
            db.prepare('INSERT OR IGNORE INTO evidence_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(x.id, sid, r.unitKey, r.role, r.text, hash(r.text), normalizationVersion, r.toolName ?? null, r.toolCallId ?? null, r.outcome ?? null, r.eventAt, r.timeBasis, x.project, x.branch, x.locator, r.locatorFidelity, r.exchangeId ?? null, r.seq ?? null);
            if(r.seq!==undefined&&r.exchangeId)db.prepare('UPDATE evidence_units SET legacy_exchange_id=?,legacy_seq=? WHERE unit_revision_id=? AND legacy_exchange_id IS NULL AND legacy_seq IS NULL').run(r.exchangeId,r.seq,x.id);
            db.prepare('INSERT OR IGNORE INTO revision_units VALUES(?,?,?)').run(rid, x.id, i);
            for (const w of x.windows) {
                const spanId = identity(sid, x.id, String(w.startUtf16), String(w.endUtf16), w.chunkPolicy);
                const ins = db.prepare('INSERT OR IGNORE INTO evidence_spans(span_id,unit_revision_id,start_utf16,end_utf16,text,text_hash,chunk_policy,embedding_input_hash,embedding_context_json) VALUES(?,?,?,?,?,?,?,?,?)').run(spanId, x.id, w.startUtf16, w.endUtf16, w.text, hash(w.text), w.chunkPolicy, w.embeddingInputHash, w.embeddingContextJson);
                if (ins.changes)
                    db.prepare('INSERT INTO spans_fts(rowid,text) SELECT span_rowid,text FROM evidence_spans WHERE span_id=?').run(spanId);
                db.prepare('INSERT OR IGNORE INTO revision_spans VALUES(?,?,?)').run(rid, spanId, ordinal++);
                total++;
            }
        });
        if(retained){
            const prior=db.prepare('SELECT * FROM source_relations WHERE evidence_revision_id=?').all(input.retainedRevisionId) as {from_source_id:string;to_source_id:string;kind:string;basis_json:string;observed_at:string;lineage_version:string}[];
            for(const relation of prior)db.prepare('INSERT OR IGNORE INTO source_relations VALUES(?,?,?,?,?,?,?,?)').run(identity(relation.from_source_id,sid,relation.kind,rid),relation.from_source_id,sid,relation.kind,rid,relation.basis_json,relation.observed_at,relation.lineage_version);
        }else{
        const parents = new Map<string, 'spawn' | 'resume' | 'record_overlap'>();
        if (s.parentSessionId && s.parentSessionId !== s.id)
            parents.set(s.parentSessionId, s.isSidechain ? 'spawn' : 'resume');
        for (const r of records) {
            const parent = r.locator.parentNativeSessionId;
            if (typeof parent === 'string' && parent && parent !== s.id && !parents.has(parent))
                parents.set(parent, 'record_overlap');
        }
        for (const [native, kind] of parents) {
            const parentId = sourceId(s.harness, native);
            db.prepare("INSERT OR IGNORE INTO memory_sources VALUES(?,?,?,NULL,NULL,'lost',?)").run(parentId, s.harness, native, at);
            db.prepare('INSERT OR IGNORE INTO source_relations VALUES(?,?,?,?,?,?,?,?)').run(identity(parentId, sid, kind, rid), parentId, sid, kind, rid, JSON.stringify({ declaredNativeSessionId: native }), at, 'lineage-v1');
        }
        }
        enqueueEmbeddingJob(db,sid,rid,DEFAULT_SPACE_ID,Date.parse(at));
        const sameAlias=s.sourcePath?db.prepare('SELECT 1 FROM source_aliases WHERE source_id=? AND path=?').get(sid,s.sourcePath):undefined;
        const otherAliases=s.sourcePath?db.prepare(`SELECT a.kind,a.artifact_hash FROM source_aliases a WHERE a.source_id=? AND a.path<>? AND a.missing_at IS NULL AND EXISTS(SELECT 1 FROM source_revisions ar WHERE ar.source_id=a.source_id AND ar.artifact_hash=a.artifact_hash AND (ar.adapter_version LIKE '%-history-records-v1')=?)`).all(sid,s.sourcePath,historyVersion(version)?1:0) as {kind:string;artifact_hash:string|null}[]:[];
        conflict=!!active?.active_revision_id&&!!s.sourcePath&&otherAliases.some(alias=>alias.artifact_hash!==input.artifactHash&&!input.prefixCompatibleArtifactHashes?.includes(alias.artifact_hash??'')&&(!sameAlias||alias.kind==='live'||active.availability==='conflict'));
        if(conflict){
         activated=false;
         input.beforeCommit?.();
         db.prepare("UPDATE memory_sources SET availability='conflict' WHERE source_id=?").run(sid);
         db.prepare('INSERT INTO source_aliases VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(source_id,path) DO UPDATE SET artifact_hash=excluded.artifact_hash,last_seen_at=excluded.last_seen_at,missing_at=NULL').run(sid,s.sourcePath,s.status==='archived'?'archive':'live',at,JSON.stringify({bytes:input.artifactBytes}),input.artifactHash);
         db.prepare("INSERT INTO capture_checkpoints(source_id,discovered_fingerprint,last_error_at,error_code) VALUES(?,?,?,'alias_conflict') ON CONFLICT(source_id) DO UPDATE SET discovered_fingerprint=excluded.discovered_fingerprint,last_error_at=excluded.last_error_at,error_code='alias_conflict'").run(sid,input.fingerprint??input.artifactHash,at);
         db.prepare('UPDATE memory_epochs SET evidence_epoch=evidence_epoch+1,lineage_epoch=lineage_epoch+1 WHERE singleton=1').run();
         return;
        }
        if(input.olderArchivedPrefix&&active?.active_revision_id&&input.prefixCompatibleArtifactHashes?.includes(active.artifact_hash??'')){
         activated=false;input.beforeCommit?.();
         if(input.retainedArchivePath){db.prepare("UPDATE memory_sources SET availability='archived' WHERE source_id=?").run(sid);db.prepare("UPDATE sessions SET status='archived',archived_path=? WHERE id=? AND harness=?").run(input.retainedArchivePath,s.id,s.harness);}
         if(s.sourcePath)db.prepare('INSERT INTO source_aliases VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(source_id,path) DO UPDATE SET artifact_hash=excluded.artifact_hash,last_seen_at=excluded.last_seen_at,missing_at=NULL').run(sid,s.sourcePath,'archive',at,JSON.stringify({bytes:input.artifactBytes}),input.artifactHash);
         db.prepare('UPDATE capture_checkpoints SET discovered_fingerprint=?,last_error_at=NULL,error_code=NULL WHERE source_id=?').run(input.fingerprint??input.artifactHash,sid);
         db.prepare('UPDATE memory_epochs SET evidence_epoch=evidence_epoch+1,lineage_epoch=lineage_epoch+1 WHERE singleton=1').run();return;
        }
        input.publishCompatibility?.();
        input.publishAuxiliary?.();
        input.beforeCommit?.();
        db.prepare('UPDATE memory_sources SET active_revision_id=?,project=?,availability=? WHERE source_id=?').run(rid, s.project || null, retained?active!.availability:s.status === 'archived' ? 'archived' : s.status === 'ghost' ? 'lost' : 'live', sid);
        if (s.sourcePath)
            db.prepare('INSERT INTO source_aliases VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(source_id,path) DO UPDATE SET artifact_hash=excluded.artifact_hash,last_seen_at=excluded.last_seen_at,missing_at=NULL').run(sid, s.sourcePath, s.status === 'archived' ? 'archive' : 'live', at, JSON.stringify({ bytes: input.artifactBytes }), input.artifactHash);
        const c = parsed.continuation;
        db.prepare('INSERT INTO capture_checkpoints VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(source_id) DO UPDATE SET discovered_fingerprint=excluded.discovered_fingerprint,acknowledged_fingerprint=excluded.acknowledged_fingerprint,acknowledged_revision_id=excluded.acknowledged_revision_id,consumed_offset=excluded.consumed_offset,reopen_offset=excluded.reopen_offset,prefix_hash=excluded.prefix_hash,continuation_json=excluded.continuation_json,last_success_at=excluded.last_success_at,last_error_at=NULL,error_code=NULL').run(sid, input.fingerprint ?? input.artifactHash, input.fingerprint ?? input.artifactHash, rid, parsed.endOffset, c?.reopenOffset ?? 0, c?.prefixHash ?? input.artifactHash, c ? JSON.stringify(c) : null, at);
        db.prepare('UPDATE memory_epochs SET evidence_epoch=evidence_epoch+1,lineage_epoch=lineage_epoch+1 WHERE singleton=1').run();
        if(active?.active_revision_id===rid){activated=false;return;}
        const activatedAt=new Date().toISOString();
        db.prepare('INSERT OR IGNORE INTO source_activation_baselines VALUES(?,?,1)').run(sid,activatedAt);
        db.prepare("INSERT INTO source_activations(source_id,revision_id,activated_at,evidence_epoch,basis) SELECT ?,?,?,evidence_epoch,'published' FROM memory_epochs WHERE singleton=1").run(sid,rid,activatedAt);
    }).immediate();
    return { sourceId: sid, revisionId: rid, spans: total,conflict,activated };
}
export function readSpan(db: Db, ref: SpanRef): EvidenceItem | null {
    const r = db.prepare(`SELECT p.*,(${OUTCOME_REFRESH_SQL}) outcome_refresh_required,u.role,u.event_at,u.project,u.branch,u.outcome,u.tool_name,u.tool_call_id,u.locator_json,u.locator_fidelity,u.time_basis,u.unit_key,u.text unit_text,u.normalization_version unit_normalization_version,u.text_hash unit_text_hash,s.active_revision_id,s.harness,s.native_session_id,s.availability,r.observed_at,r.artifact_hash,r.artifact_bytes,r.adapter_version,r.normalization_version,r.manifest_hash,(SELECT parent.native_session_id FROM source_relations rel JOIN memory_sources parent ON parent.source_id=rel.from_source_id WHERE rel.to_source_id=s.source_id AND rel.evidence_revision_id=r.revision_id AND rel.kind IN ('spawn','resume') LIMIT 1) parent_native_session_id FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id JOIN source_revisions r ON r.revision_id=rs.revision_id JOIN memory_sources s ON s.source_id=r.source_id WHERE rs.revision_id=? AND rs.span_id=? AND s.source_id=? AND s.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones f WHERE f.source_id=s.source_id AND f.state<>'reversed')`).get(ref.revisionId, ref.spanId, ref.sourceId) as Record<string, unknown> | undefined;
    if (!r)
        return null;
    if(privacyAffectedRange(String(r.unit_text),Number(r.start_utf16),Number(r.end_utf16),String(r.unit_normalization_version)))return null;
    const producer=producerView(db,ref,String(r.unit_revision_id),String(r.harness),String(r.adapter_version),String(r.role),r.tool_name as string|null,r.tool_call_id as string|null,JSON.parse(String(r.locator_json)));
    return { ref, role: String(r.role), text: String(r.text), startUtf16: Number(r.start_utf16), endUtf16: Number(r.end_utf16), sourceEventAt: r.event_at as string | null, observedAt: String(r.observed_at), project: r.project as string | null, branch: r.branch as string | null, ...(r.outcome ? { toolOutcome: Boolean(r.outcome_refresh_required) ? 'unknown' as const : r.outcome as EvidenceItem['toolOutcome'] } : {}), authority: 'source_evidence', citation: `span:${ref.sourceId}:${ref.revisionId}:${ref.spanId}`, historical: r.active_revision_id !== ref.revisionId, quoteBasis: 'redacted_unit', provenance: { harness: String(r.harness), nativeSessionId: String(r.native_session_id), artifactHash: String(r.artifact_hash), artifactBytes: Number(r.artifact_bytes), artifactBasis: String(r.artifact_hash).startsWith('legacy-projection:') ? 'legacy_projection' : historyVersion(String(r.adapter_version))?'history_records':'raw_prefix', ...(historyVersion(String(r.adapter_version))||r.role==='ghost_prompt'?{transcriptAvailability:'unavailable' as const}:{}), adapterVersion: String(r.adapter_version), normalizationVersion: String(r.normalization_version), locator: JSON.parse(String(r.locator_json)), locatorFidelity: String(r.locator_fidelity), timeBasis: String(r.time_basis), availability: String(r.availability), manifestHash: String(r.manifest_hash), unitRevisionId: String(r.unit_revision_id), unitKey: String(r.unit_key), unitTextHash: String(r.unit_text_hash), spanTextHash: String(r.text_hash), chunkPolicy: String(r.chunk_policy),spanStartUtf16:Number(r.start_utf16),spanEndUtf16:Number(r.end_utf16),unitToolName:producer.name,producerNameBasis:producer.basis,unitToolCallId:r.tool_call_id as string|null,parentNativeSessionId:(JSON.parse(String(r.locator_json)).parentNativeSessionId??r.parent_native_session_id??null) as string|null } };
}
export function spanPrivacyRefreshRequired(db:Db,ref:SpanRef):boolean{
 const row=db.prepare('SELECT u.text,u.normalization_version,p.start_utf16,p.end_utf16 FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id JOIN source_revisions r ON r.revision_id=rs.revision_id WHERE rs.revision_id=? AND rs.span_id=? AND r.source_id=?').get(ref.revisionId,ref.spanId,ref.sourceId) as {text:string;normalization_version:string;start_utf16:number;end_utf16:number}|undefined;
 return Boolean(row&&privacyAffectedRange(row.text,row.start_utf16,row.end_utf16,row.normalization_version));
}
/** Only a current normalization of the same retained raw artifact can be hinted. */
export function privacySafeReplacement(db:Db,ref:SpanRef):SpanRef|undefined{
 const old=db.prepare('SELECT u.unit_key,r.artifact_hash FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id JOIN source_revisions r ON r.revision_id=rs.revision_id WHERE rs.revision_id=? AND rs.span_id=? AND r.source_id=?').get(ref.revisionId,ref.spanId,ref.sourceId) as {unit_key:string;artifact_hash:string}|undefined;if(!old)return undefined;
 const row=db.prepare("SELECT r.revision_id,p.span_id FROM memory_sources s JOIN source_revisions r ON r.revision_id=s.active_revision_id JOIN revision_units ru ON ru.revision_id=r.revision_id JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id JOIN evidence_spans p ON p.unit_revision_id=u.unit_revision_id WHERE s.source_id=? AND s.availability<>'forgotten' AND r.artifact_hash=? AND u.unit_key=? AND u.normalization_version=? AND r.revision_id<>? ORDER BY p.start_utf16 LIMIT 1").get(ref.sourceId,old.artifact_hash,old.unit_key,NORMALIZATION_VERSION,ref.revisionId) as {revision_id:string;span_id:string}|undefined;
 return row?{sourceId:ref.sourceId,revisionId:row.revision_id,spanId:row.span_id}:undefined;
}
export function spanOutcomeRefreshRequired(db:Db,ref:SpanRef):boolean{
 return Boolean(db.prepare(`SELECT 1 FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id JOIN source_revisions r ON r.revision_id=rs.revision_id JOIN memory_sources s ON s.source_id=r.source_id WHERE s.source_id=? AND r.revision_id=? AND rs.span_id=? AND ${OUTCOME_REFRESH_SQL}`).get(ref.sourceId,ref.revisionId,ref.spanId));
}
/** A refresh hint must retain raw artifact identity and exact native unit identity. */
export function outcomeSafeReplacement(db:Db,ref:SpanRef):SpanRef|undefined{
 const old=db.prepare('SELECT u.unit_key,r.artifact_hash FROM revision_spans rs JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id JOIN source_revisions r ON r.revision_id=rs.revision_id WHERE rs.revision_id=? AND rs.span_id=? AND r.source_id=?').get(ref.revisionId,ref.spanId,ref.sourceId) as {unit_key:string;artifact_hash:string}|undefined;if(!old)return undefined;
 const row=db.prepare("SELECT r.revision_id,p.span_id FROM memory_sources s JOIN source_revisions r ON r.revision_id=s.active_revision_id JOIN revision_units ru ON ru.revision_id=r.revision_id JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id JOIN evidence_spans p ON p.unit_revision_id=u.unit_revision_id WHERE s.source_id=? AND s.harness='codex' AND r.adapter_version IN ('codex-records-v3','codex-records-v4','codex-records-v5','codex-records-v6') AND r.artifact_hash=? AND u.unit_key=? AND u.role='tool_result' AND r.revision_id<>? ORDER BY p.start_utf16 LIMIT 1").get(ref.sourceId,old.artifact_hash,old.unit_key,ref.revisionId) as {revision_id:string;span_id:string}|undefined;
 return row?{sourceId:ref.sourceId,revisionId:row.revision_id,spanId:row.span_id}:undefined;
}
export function inspectCoverage(db: Db, scope: Scope = {}, semantic: Coverage['semantic'] = 'disabled', capabilityScope?:{sourceIds?:string[];harnesses?:string[]}): Coverage {
    const work = db.prepare("SELECT SUM(CASE WHEN state IN ('pending','running','retry','blocked') THEN 1 ELSE 0 END) pending,SUM(CASE WHEN state IN ('retry','blocked') THEN 1 ELSE 0 END) failed FROM maintenance_jobs WHERE kind IN ('capture','parse','lineage','rebuild')").get() as {
        pending: number | null;
        failed: number | null;
    };
    const failures = db.prepare('SELECT COUNT(*) n FROM capture_checkpoints WHERE error_code IS NOT NULL').get() as {
        n: number;
    };
    const historyFailures=(db.prepare("SELECT COUNT(*) n FROM sync_state WHERE key LIKE 'memory:history-input:%' AND (json_extract(value,'$.malformed')>0 OR json_extract(value,'$.pendingBytes')>0)").get() as {n:number}).n;
    const filter=scopeSql(scope);
    const join=`FROM memory_sources s JOIN source_revisions r ON r.source_id=s.source_id JOIN revision_units ru ON ru.revision_id=r.revision_id JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id`;
    // Zero-unit revisions still carry authoritative capture gaps. Unknown event
    // clocks in those revisions cannot establish absence inside a time window.
    const coverageFilter={sql:filter.sql.replaceAll('u.project','COALESCE(u.project,r.project)').replaceAll('u.branch','COALESCE(u.branch,r.branch)').replaceAll('COALESCE(u.project,r.project)=?',"(COALESCE(u.project,r.project)=? OR (u.unit_revision_id IS NULL AND r.project IS NULL AND r.completeness<>'complete'))").replaceAll('COALESCE(u.branch,r.branch)=?',"(COALESCE(u.branch,r.branch)=? OR (u.unit_revision_id IS NULL AND r.branch IS NULL AND r.completeness<>'complete'))").replaceAll('u.event_at IS NOT NULL AND u.event_at>=?', '(u.unit_revision_id IS NULL OR (u.event_at IS NOT NULL AND u.event_at>=?))').replaceAll('u.event_at IS NOT NULL AND u.event_at<=?', '(u.unit_revision_id IS NULL OR (u.event_at IS NOT NULL AND u.event_at<=?))'),params:filter.params};
    const coverageJoin=join.replace('JOIN revision_units','LEFT JOIN revision_units').replace('JOIN evidence_units','LEFT JOIN evidence_units');
    const selected=`SELECT DISTINCT r.revision_id,r.source_id,r.completeness,r.observed_at ${coverageJoin} WHERE ${coverageFilter.sql}`;
    const r=db.prepare(`SELECT MAX(observed_at) at,SUM(CASE WHEN completeness<>'complete' THEN 1 ELSE 0 END) partial FROM (${selected})`).get(...filter.params) as {at:string|null;partial:number|null};
    const legacy = db.prepare('SELECT COUNT(*) n FROM sessions s WHERE NOT EXISTS(SELECT 1 FROM memory_sources m WHERE m.harness=s.harness AND m.native_session_id=s.id AND m.active_revision_id IS NOT NULL)').get() as {n:number};
    let unknownHistory=0;
    if(scope.learnedBy){const historical=scopeSql({...scope,learnedBy:undefined,includeHistory:true});unknownHistory=(db.prepare(`SELECT COUNT(DISTINCT s.source_id) n ${join} LEFT JOIN source_activation_baselines b ON b.source_id=s.source_id WHERE ${historical.sql} AND (b.source_id IS NULL OR (b.history_complete=0 AND b.known_from>?))`).get(...historical.params,new Date(scope.learnedBy).toISOString()) as {n:number}).n;}
    const fallback=Boolean(db.prepare(`SELECT 1 FROM evidence_spans p WHERE p.chunk_policy='span-conservative-utf8-v1' AND EXISTS(SELECT 1 FROM revision_spans rs JOIN source_revisions r ON r.revision_id=rs.revision_id JOIN memory_sources s ON s.source_id=r.source_id JOIN revision_units ru ON ru.revision_id=r.revision_id AND ru.unit_revision_id=p.unit_revision_id JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE rs.span_id=p.span_id AND ${filter.sql}) LIMIT 1`).get(...filter.params));
    let unknownEventTimes=0;
    if(scope.eventFrom||scope.asOf){const unbounded=scopeSql({...scope,eventFrom:undefined,asOf:undefined});unknownEventTimes=(db.prepare(`SELECT COUNT(DISTINCT u.unit_revision_id) n ${join} WHERE ${unbounded.sql} AND u.event_at IS NULL`).get(...unbounded.params) as {n:number}).n+countUnknownNoteEvents(db,scope);}
    const olderUnits=db.prepare(`SELECT DISTINCT u.unit_revision_id,u.text,u.normalization_version ${join} WHERE ${filter.sql} AND u.normalization_version<>?`).all(...filter.params,NORMALIZATION_VERSION) as {text:string;normalization_version:string}[];
    const privacyBlocked=olderUnits.some(unit=>requiresPrivacyRefresh(unit.text,unit.normalization_version))||countPrivacyBlockedNotes(db,scope)>0;
    const unavailableTranscript=Boolean(db.prepare(`SELECT 1 ${join} WHERE ${filter.sql} AND (r.adapter_version LIKE '%-history-records-v1' OR u.role='ghost_prompt') LIMIT 1`).get(...filter.params));
    const producerBlocked=Boolean(db.prepare(`SELECT 1 ${join} WHERE ${filter.sql} AND u.role='tool_result' AND u.tool_name IS NOT NULL AND ((s.harness='claude' AND r.adapter_version GLOB 'claude-records-v[0-9]*') OR (s.harness='codex' AND r.adapter_version GLOB 'codex-records-v[0-9]*')) AND json_extract(u.locator_json,'$.nativeKind') IS NULL LIMIT 1`).get(...filter.params));
    const ambiguousLegacyNotes=Boolean(db.prepare(`SELECT 1 ${coverageJoin} WHERE ${coverageFilter.sql} AND s.native_session_id IN (${AMBIGUOUS_LEGACY_NATIVE_IDS_SQL}) AND EXISTS(SELECT 1 FROM notes n WHERE n.session_id=s.native_session_id AND (TRIM(n.decided)<>'' OR TRIM(n.open)<>'' OR TRIM(n.next_step)<>'') AND NOT EXISTS(SELECT 1 FROM memory_note_events mapped WHERE mapped.legacy_note_id=n.id)) LIMIT 1`).get(...coverageFilter.params));
    const capability=storedCaptureLimitations(db,capabilityScope?capabilityScope.sourceIds:scope.sourceIds,capabilityScope?.harnesses);
    const outcomeBlocked=Boolean(db.prepare(`SELECT 1 ${join} WHERE ${filter.sql} AND ${OUTCOME_REFRESH_SQL} LIMIT 1`).get(...filter.params))||countOutcomeBlockedNotes(db,scope)>0;
    const capturedThrough=!scope.includeHistory?(db.prepare(`SELECT MAX(a.activated_at) at FROM source_activations a JOIN (${selected}) selected ON selected.source_id=a.source_id AND selected.revision_id=a.revision_id ${scope.learnedBy?'WHERE a.activated_at<=?':''}`).get(...filter.params,...(scope.learnedBy?[new Date(scope.learnedBy).toISOString()]:[])) as {at:string|null}).at:r.at;
    return {state:work.pending||r.partial||failures.n||historyFailures||legacy.n||unknownHistory||unknownEventTimes||privacyBlocked||outcomeBlocked||producerBlocked||ambiguousLegacyNotes||capability.incomplete?'partial':'complete_snapshot',snapshotEpochs:readEpochs(db),scope,capturedThrough,pendingSources:(work.pending??0)+legacy.n,failedSources:(work.failed??0)+failures.n+historyFailures,omittedKinds:[...(historyFailures?['history_input_capture']:[]),...(r.partial?['source_coverage']:[]),...(legacy.n?['legacy_backfill']:[]),...(unknownHistory?['activation_history_unknown']:[]),...(fallback?['chunking_tokenizer_unavailable']:[]),...(unknownEventTimes?['event_time_unknown']:[]),...(privacyBlocked?['privacy_refresh_required']:[]),...(outcomeBlocked?['outcome_refresh_required']:[]),...(producerBlocked?['producer_refresh_required']:[]),...(ambiguousLegacyNotes?['legacy_note_ownership_ambiguous']:[]),...capability.codes],...(unavailableTranscript?{unavailableKinds:['original_transcript']}:{}),semantic};

}
export type SourceRevisionView = {
    sourceId: string;
    nativeSessionId: string;
    harness: string;
    revisionId: string;
    artifactHash: string;
    artifactBytes: number;
    artifactBasis: 'raw_prefix' | 'legacy_projection' | 'history_records';
    transcriptAvailability?:'unavailable';
    archiveRelativePath: string | null;
    adapterVersion: string;
    normalizationVersion: string;
    observedAt: string;
    availability: string;
    completeness: string;
    manifestHash: string;
    coverageGaps: Record<string, unknown>;
    spanCount: number;
};
export function getSourceRevision(db: Db, sid: string, rid?: string): SourceRevisionView | null {
    const r = db.prepare(`SELECT s.*,r.*,(SELECT COUNT(*) FROM revision_spans WHERE revision_id=r.revision_id) span_count FROM memory_sources s JOIN source_revisions r ON r.source_id=s.source_id WHERE s.source_id=? AND r.revision_id=COALESCE(?,s.active_revision_id) AND s.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=s.source_id AND t.state<>'reversed')`).get(sid, rid ?? null) as Record<string, unknown> | undefined;
    if (!r)
        return null;
    return { sourceId: sid, nativeSessionId: String(r.native_session_id), harness: String(r.harness), revisionId: String(r.revision_id), artifactHash: String(r.artifact_hash), artifactBytes: Number(r.artifact_bytes), artifactBasis: String(r.artifact_hash).startsWith('legacy-projection:') ? 'legacy_projection' : historyVersion(String(r.adapter_version))?'history_records':'raw_prefix', archiveRelativePath: r.archive_relative_path as string | null, ...(historyVersion(String(r.adapter_version))||r.adapter_version==='ghost-retained-prompts-v1'?{transcriptAvailability:'unavailable' as const}:{}), adapterVersion: String(r.adapter_version), normalizationVersion: String(r.normalization_version), observedAt: String(r.observed_at), availability: String(r.availability), completeness: String(r.completeness), manifestHash: String(r.manifest_hash), coverageGaps: JSON.parse(String(r.coverage_gaps_json)), spanCount: Number(r.span_count) };
}
export function listSourceSpans(db: Db, sid: string, rid?: string, offset = 0, limit = 20): {
    source: SourceRevisionView | null;
    evidence: EvidenceItem[];
    nextOffset: number | null;
} {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('invalid source pagination');
    const source = getSourceRevision(db, sid, rid);
    if (!source)
        return { source: null, evidence: [], nextOffset: null };
    const refs = db.prepare('SELECT span_id FROM revision_spans WHERE revision_id=? ORDER BY ordinal LIMIT ? OFFSET ?').all(source.revisionId, limit, offset) as {
        span_id: string;
    }[];
    return { source, evidence: refs.map(r => readSpan(db, { sourceId: sid, revisionId: source.revisionId, spanId: r.span_id })!).filter(Boolean), nextOffset: offset + refs.length < source.spanCount ? offset + refs.length : null };
}
