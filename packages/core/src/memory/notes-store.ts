import {AMBIGUOUS_LEGACY_NATIVE_IDS_SQL} from './legacy-ownership.js';
import {requiresPrivacyRefresh,MemoryPrivacyError} from './privacy.js';
import type { Db } from '../db.js';
import { redact } from '../redact.js';
import { elideBinary } from '../redact-elide.js';
import { hash, identity } from './spans.js';
import { readEpochs, sourceId, NORMALIZATION_VERSION, OUTCOME_REFRESH_SQL } from './source.js';
import { validateScope, lineageFamilySql } from './scope.js';
import type { WriteInput, WriteReceipt, NoteKind, NoteView, Scope, SpanRef } from './contracts.js';
export type NoteQueryOptions = {
    kinds?: NoteKind[];
    includeHistory?: boolean;
};
function canonical(value: unknown): string { if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`; if (value !== null && typeof value === 'object')
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`; return JSON.stringify(value); }
function validDate(value: string | undefined, name: string): void { if (value !== undefined && !Number.isFinite(Date.parse(value)))
    throw new Error(`invalid ${name}`); }
function utc(value: string | undefined): string | null { return value === undefined ? null : new Date(value).toISOString(); }
/** Claimed authors never create attestation. Commit and idempotent receipt share one transaction. */
export function writeMemoryNotes(db: Db, input: WriteInput, origin: WriteInput['origin'] = input.origin): WriteReceipt {
    validateScope(input.scope);
    if(['eventFrom','asOf','learnedBy','includeHistory'].some(key=>input.scope[key as keyof Scope]!==undefined))throw new Error('write scope contains read-only boundaries; use entry eventAt/validity dates');
    if(input.scope.sourceIds){
        const anchors=[input.originSourceId,input.lineageAnchorSourceId].filter((value):value is string=>value!==undefined);
        if(!input.scope.sourceIds.length)throw new Error('empty write source scope');
        if(!anchors.length)throw new Error('source-scoped write requires explicit origin or lineage anchor');
        if(anchors.some(value=>!input.scope.sourceIds!.includes(value)))throw new Error('write anchor outside source scope');
    }
    if (!input.requestKey || input.requestKey.length > 256)
        throw new Error('requestKey must be 1–256 characters');
    if (!input.scope.project)
        throw new Error('notes require explicit project scope');
    if (input.scope.lineage && input.scope.lineage !== 'self')
        throw new Error('write scope must be explicit self scope');
    if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 8)
        throw new Error('write requires 1–8 entries');
    if (input.entries.some(e => typeof e.text !== 'string' || !e.text.trim() || e.text.length > 2000) || input.entries.reduce((n, e) => n + e.text.length, 0) > 8000)
        throw new Error('note text exceeds write limits');
    if (input.authority !== undefined && !['agent_assertion', 'unknown'].includes(input.authority))
        throw new Error('user attestation unavailable');
    if (!['cli', 'mcp', 'api', 'migration'].includes(origin))
        throw new Error('invalid write origin');
    for (const e of input.entries) {
        if (!['decision', 'open', 'next', 'observation', 'retraction'].includes(e.kind))
            throw new Error('invalid note kind');
        for (const [name, value] of Object.entries({ eventAt: e.eventAt, validFrom: e.validFrom ?? input.validFrom, validUntil: e.validUntil ?? input.validUntil }))
            validDate(value, name);
        if ((e.validFrom ?? input.validFrom) && (e.validUntil ?? input.validUntil) && Date.parse((e.validFrom ?? input.validFrom)!) > Date.parse((e.validUntil ?? input.validUntil)!))
            throw new Error('invalid validity interval');
    }
    const inputHash = hash(canonical({ ...input, origin }));
    const batchId = identity('notes/v1', input.requestKey, inputHash);
    const at = new Date().toISOString();
    let receipt: WriteReceipt | undefined;
    db.transaction(() => {
        const prior = db.prepare('SELECT input_hash,receipt_json FROM memory_write_receipts WHERE request_key=?').get(input.requestKey) as {
            input_hash: string;
            receipt_json: string;
        } | undefined;
        if (prior) {
            if (prior.input_hash !== inputHash)
                throw new Error('idempotency key reused with different input');
            receipt = JSON.parse(prior.receipt_json);
            return;
        }
        for (const sid of [input.originSourceId, input.lineageAnchorSourceId].filter((x): x is string => !!x))
            if (!db.prepare("SELECT 1 FROM memory_sources WHERE source_id=? AND availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=? AND t.state<>'reversed')").get(sid, sid))
                throw new Error('origin source unavailable');
        const noteIds: string[] = [];
        let redacted = false;
        let allLinked = true;
        const authority = input.authority ?? (origin === 'migration' ? 'unknown' : 'agent_assertion');
        input.entries.forEach((e, i) => {
            const lean = elideBinary(e.text);
            const clean = redact(lean).text;
            redacted ||= clean !== e.text;
            const noteId = identity('note/v1', batchId, String(i));
            noteIds.push(noteId);
            const supports = e.supports ?? [];
            allLinked &&= supports.length > 0;
            const supportStatus = supports.length ? 'linked' : 'unverified';
            for (const ref of [...supports, ...(e.contradicts ?? []), ...(e.context ?? [])])
                validateSupport(db, ref, input.scope);
            db.prepare('INSERT INTO memory_note_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(noteId, batchId, input.originSourceId ?? null, null, e.kind, clean, hash(clean), input.scope.project, input.scope.branch ?? null, input.lineageAnchorSourceId ?? null, utc(e.eventAt), utc(e.validFrom ?? input.validFrom), utc(e.validUntil ?? input.validUntil), at, redact(input.authorClaim ?? 'unknown').text, origin, authority, supportStatus, NORMALIZATION_VERSION);
            const row = db.prepare('SELECT rowid FROM memory_note_events WHERE note_id=?').get(noteId) as {
                rowid: number;
            };
            db.prepare('INSERT INTO memory_notes_fts(rowid,text) VALUES(?,?)').run(row.rowid, clean);
            for (const [relation, refs] of [['supports', supports], ['contradicts', e.contradicts ?? []], ['context', e.context ?? []]] as const)
                for (const ref of refs)
                    db.prepare('INSERT OR IGNORE INTO note_supports VALUES(?,?,?,?)').run(noteId, ref.revisionId, ref.spanId, relation);
            for (const oldId of e.supersedes ?? []) {
                const old = db.prepare('SELECT project,branch,origin_source_id,lineage_anchor_source_id FROM memory_note_events WHERE note_id=?').get(oldId) as {
                    project: string;
                    branch: string | null;origin_source_id:string|null;lineage_anchor_source_id:string|null;
                } | undefined;
                if (!old)
                    throw new Error('superseded note unavailable');
                if (old.project !== input.scope.project || old.branch !== (input.scope.branch ?? null))
                    throw new Error('supersession scope mismatch');
                if(input.scope.sourceIds&&!input.scope.sourceIds.some(id=>id===old.origin_source_id||id===old.lineage_anchor_source_id))throw new Error('supersession source outside scope');
                db.prepare('INSERT INTO note_supersessions VALUES(?,?,?,?)').run(noteId, oldId, canonical({ project: input.scope.project, branch: input.scope.branch ?? null }), 'explicit author supersession');
            }
        });
        db.prepare('UPDATE memory_epochs SET notes_epoch=notes_epoch+1 WHERE singleton=1').run();
        receipt = { contractVersion: 2, requestKey: input.requestKey, batchId, noteIds, epochs: readEpochs(db), redacted, authority, supportStatus: allLinked ? 'linked' : 'unverified', committedAt: at };
        db.prepare('INSERT INTO memory_write_receipts VALUES(?,?,?,?,?)').run(input.requestKey, inputHash, batchId, JSON.stringify(receipt), at);
    }).immediate();
    return receipt!;
}
function validateSupport(db: Db, ref: SpanRef, scope: Scope): void {
    if(scope.sourceIds&&!scope.sourceIds.includes(ref.sourceId))throw new Error('support source outside scope');
    const row = db.prepare(`SELECT u.text,u.normalization_version,r.source_id,u.project,u.branch,u.event_at,r.observed_at,s.availability FROM revision_spans rs JOIN source_revisions r ON r.revision_id=rs.revision_id JOIN memory_sources s ON s.source_id=r.source_id JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id WHERE rs.revision_id=? AND rs.span_id=? AND r.source_id=? AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=r.source_id AND t.state<>'reversed')`).get(ref.revisionId, ref.spanId, ref.sourceId) as {
        project: string | null;
        branch: string | null;
        availability: string;
        text:string;normalization_version:string;
        event_at: string | null;
        observed_at: string;
    } | undefined;
    if(row&&requiresPrivacyRefresh(row.text,row.normalization_version))throw new MemoryPrivacyError();
    if (!row || row.availability === 'forgotten')
        throw new Error('support reference unavailable');
    if (scope.project !== row.project || (scope.branch !== undefined && scope.branch !== row.branch))
        throw new Error('support scope mismatch');
    if(scope.eventFrom&&(!row.event_at||row.event_at<utc(scope.eventFrom)!))throw new Error('support event time outside scope');
    if (scope.asOf && (!row.event_at || row.event_at > utc(scope.asOf)!))
        throw new Error('support event time outside scope');
    if (scope.learnedBy && row.observed_at > utc(scope.learnedBy)!)
        throw new Error('support learned outside scope');
}
/** Temporal applicability does not infer newest-mention truth or semantic entailment. */
function noteSelection(db:Db,scope:Scope,options:NoteQueryOptions):{scope:Scope;where:string[];params:unknown[]}{
    validateScope(scope);
    if (scope.sourceIds && scope.lineage && scope.lineage !== 'self') {
        const family = lineageFamilySql(scope);
        const result = db.prepare(family.sql).all(...family.params) as { id: string }[];
        scope = { ...scope, sourceIds: result.map(r => r.id), lineage: 'self' };
    }
    const params: unknown[] = [];
    const where = ["NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.note_id=n.note_id AND t.state<>'reversed')"];
    if (scope.project !== undefined) {
        where.push('n.project=?');
        params.push(scope.project);
    }
    if (scope.branch !== undefined) {
        where.push('n.branch=?');
        params.push(scope.branch);
    }
    if (scope.sourceIds) {
        if (!scope.sourceIds.length)
            where.push('0');
        else {
            where.push(`(n.origin_source_id IN (${scope.sourceIds.map(() => '?').join(',')}) OR n.lineage_anchor_source_id IN (${scope.sourceIds.map(() => '?').join(',')}))`);
            params.push(...scope.sourceIds, ...scope.sourceIds);
        }
    }
    if(scope.eventFrom){where.push('n.event_at IS NOT NULL AND n.event_at>=?');params.push(utc(scope.eventFrom));}
    if(scope.asOf){where.push('n.event_at IS NOT NULL AND n.event_at<=?');params.push(utc(scope.asOf));}
    if (scope.learnedBy) {
        where.push('n.observed_at<=?');
        params.push(utc(scope.learnedBy));
    }
    if (options.kinds?.length) {
        where.push(`n.kind IN (${options.kinds.map(() => '?').join(',')})`);
        params.push(...options.kinds);
    }
    return {scope,where,params};
}

/** Unknown clocks cannot certify absence inside a requested event window. */
export function countUnknownNoteEvents(db:Db,scope:Scope):number{
 const {where,params}=noteSelection(db,{...scope,eventFrom:undefined,asOf:undefined},{});
 return (db.prepare(`SELECT COUNT(*) n FROM memory_note_events n WHERE ${where.join(' AND ')} AND n.event_at IS NULL`).get(...params) as {n:number}).n;
}

export function countPrivacyBlockedNotes(db:Db,scope:Scope):number{
 const {where,params}=noteSelection(db,scope,{});const rows=db.prepare(`SELECT n.text,n.normalization_version FROM memory_note_events n WHERE ${where.join(' AND ')} AND n.normalization_version<>?`).all(...params,NORMALIZATION_VERSION) as {text:string;normalization_version:string}[];return rows.filter(row=>requiresPrivacyRefresh(row.text,row.normalization_version)).length;
}

/** Linked assertions cannot silently reuse outcome authority from an affected old parser. */
export function countOutcomeBlockedNotes(db:Db,scope:Scope):number{
 const {where,params}=noteSelection(db,scope,{});
 return (db.prepare(`SELECT COUNT(DISTINCT n.note_id) n FROM memory_note_events n JOIN note_supports ns ON ns.note_id=n.note_id AND ns.relation='supports' JOIN source_revisions r ON r.revision_id=ns.revision_id JOIN memory_sources s ON s.source_id=r.source_id JOIN revision_spans rs ON rs.revision_id=r.revision_id AND rs.span_id=ns.span_id JOIN evidence_spans p ON p.span_id=rs.span_id JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id WHERE ${where.join(' AND ')} AND ${OUTCOME_REFRESH_SQL} AND s.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=s.source_id AND t.state<>'reversed')`).get(...params) as {n:number}).n;
}

export function inspectNotes(db: Db, scope: Scope = {}, options: NoteQueryOptions = {}): NoteView[] {
    const selected=noteSelection(db,scope,options);scope=selected.scope;const {where,params}=selected;
    const rows = db.prepare(`SELECT n.* FROM memory_note_events n WHERE ${where.join(' AND ')} ORDER BY observed_at,note_id`).all(...params) as Record<string, unknown>[];
    const asOf = utc(scope.asOf) ?? new Date().toISOString();
    const eligible = new Set(rows.filter(r => (!r.valid_from || String(r.valid_from) <= asOf) && (!r.valid_until || String(r.valid_until) > asOf) && (!scope.eventFrom || (r.event_at!==null&&String(r.event_at)>=utc(scope.eventFrom)!)) && (!scope.asOf || (r.event_at !== null && String(r.event_at) <= asOf))).map(r => String(r.note_id)));
    return rows.map((r): NoteView => {
        const noteId = String(r.note_id);
        const supports = db.prepare(`SELECT ns.revision_id,ns.span_id,sr.source_id FROM note_supports ns JOIN source_revisions sr ON sr.revision_id=ns.revision_id JOIN memory_sources s ON s.source_id=sr.source_id WHERE ns.note_id=? AND ns.relation='supports' AND s.availability<>'forgotten' AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=sr.source_id AND t.state<>'reversed')`).all(noteId) as {
            source_id: string;
            revision_id: string;
            span_id: string;
        }[];
        const supersedes = (db.prepare('SELECT old_note_id FROM note_supersessions WHERE new_note_id=?').all(noteId) as {
            old_note_id: string;
        }[]).map(x => x.old_note_id);
        const superseded = (db.prepare('SELECT new_note_id FROM note_supersessions WHERE old_note_id=?').all(noteId) as {
            new_note_id: string;
        }[]).some(x => eligible.has(x.new_note_id));
        const orphaned = r.support_status === 'orphaned' || (r.support_status === 'linked' && !supports.length);
        const privacyBlocked=requiresPrivacyRefresh(String(r.text),String(r.normalization_version));
        return { ...(privacyBlocked?{availability:'privacy_refresh_required' as const}:{}),noteId, batchId: String(r.batch_id), kind: r.kind as NoteKind, text: privacyBlocked?'':String(r.text), project: String(r.project), branch: r.branch as string | null, eventAt: r.event_at as string | null, observedAt: String(r.observed_at), validFrom: r.valid_from as string | null, validUntil: r.valid_until as string | null, authority: r.authority as NoteView['authority'], supportStatus: orphaned ? 'orphaned' : r.support_status as NoteView['supportStatus'], supportRefs: supports.map(s => ({ sourceId: s.source_id, revisionId: s.revision_id, spanId: s.span_id })), supersedes, current: eligible.has(noteId) && !superseded && !orphaned && r.kind !== 'retraction', originSourceId: r.origin_source_id as string | null, lineageAnchorSourceId: r.lineage_anchor_source_id as string | null, authorClaim: String(r.author_claim), origin: r.origin as NoteView['origin'] };
    }).filter(n => options.includeHistory || scope.includeHistory || n.current);
}
export function queryCurrentNotes(db: Db, scope: Scope = {}, options: NoteQueryOptions = {}): NoteView[] { return inspectNotes(db, scope, { ...options, includeHistory: true }).filter(n => n.current); }
/** Explicit migration preserves old rows and author ambiguity; old latest-row convention is not authority. */
export function backfillLegacyNotes(db: Db, limit = 100): number {
    const rows = db.prepare(`SELECT n.*,s.harness,s.project FROM notes n LEFT JOIN sessions s ON s.id=n.session_id WHERE (TRIM(n.decided)<>'' OR TRIM(n.open)<>'' OR TRIM(n.next_step)<>'') AND NOT EXISTS(SELECT 1 FROM memory_note_events m WHERE m.legacy_note_id=n.id) AND n.session_id NOT IN (${AMBIGUOUS_LEGACY_NATIVE_IDS_SQL}) ORDER BY n.id LIMIT ?`).all(limit) as Record<string, unknown>[];
    let count = 0;
    for (const row of rows) {
        const entries: WriteInput['entries'] = [];
        for (const [kind, key] of [['decision', 'decided'], ['open', 'open'], ['next', 'next_step']] as const)
            if (String(row[key] ?? '').trim())
                entries.push({ kind, text: String(row[key]) });
        if (!entries.length)
            continue;
        const sid = row.harness ? sourceId(String(row.harness), String(row.session_id)) : undefined;
        const originSourceId = sid && db.prepare('SELECT 1 FROM memory_sources WHERE source_id=?').get(sid) ? sid : undefined;
        db.transaction(() => { const receipt = writeMemoryNotes(db, { requestKey: `legacy-note:${row.id}`, scope: { project: String(row.project ?? 'unknown') }, ...(originSourceId ? { originSourceId } : {}), entries, origin: 'migration', authority: 'unknown', authorClaim: String(row.author ?? 'unknown') }); for (const id of receipt.noteIds)
            db.prepare('UPDATE memory_note_events SET legacy_note_id=? WHERE note_id=?').run(row.id, id); })();
        count++;
    }
    return count;
}
