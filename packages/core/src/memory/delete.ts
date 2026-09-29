import {legacyNativeOwners} from './legacy-ownership.js';
import { cardPath } from '../cards/write.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.js';
import { hash, identity } from './spans.js';
import { readEpochs } from './source.js';
import type { ForgetInput, ForgetTarget, ForgetPreview, ForgetReceipt } from './contracts.js';
function targetClass(target: ForgetTarget): {
    column: 'source_id' | 'note_id';
    id: string;
} { if (typeof target.sourceId === 'string' && target.sourceId && target.noteId === undefined)
    return { column: 'source_id', id: target.sourceId }; if (typeof target.noteId === 'string' && target.noteId && target.sourceId === undefined)
    return { column: 'note_id', id: target.noteId }; throw new Error('forget requires exactly one target'); }
/** Ref existence is not entailment or proof that another source independently supports this prose. */
function derivedNotes(db:Db,sid:string):string[]{return (db.prepare(`SELECT note_id FROM memory_note_events n WHERE origin_source_id=? OR EXISTS(SELECT 1 FROM note_supports ns JOIN source_revisions r ON r.revision_id=ns.revision_id WHERE ns.note_id=n.note_id AND r.source_id=?)`).all(sid,sid) as {note_id:string}[]).map(r=>r.note_id);}
export function previewForget(db: Db, target: ForgetTarget, options: {
    removeSourceDerivedNotes?: boolean;
} = {}): ForgetPreview {
    const t = targetClass(target);
    const noteIds = t.column === 'note_id' ? [t.id] : options.removeSourceDerivedNotes === false ? [] : derivedNotes(db, t.id);
    const spans = t.column === 'source_id' ? db.prepare('SELECT COUNT(*) n FROM evidence_spans p JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id WHERE u.source_id=?').get(t.id) as {
        n: number;
    } : { n: 0 };
    const artifacts = t.column === 'source_id' ? db.prepare('SELECT COUNT(DISTINCT archive_relative_path) n FROM source_revisions WHERE source_id=? AND archive_relative_path IS NOT NULL').get(t.id) as {
        n: number;
    } : { n: 0 };
    const jobs = db.prepare("SELECT COUNT(*) n FROM maintenance_jobs WHERE target_id=? AND state NOT IN ('done','cancelled')").get(t.id) as {
        n: number;
    };
    const body = { target, noteIds: noteIds.sort(), spanCount: spans.n, artifactCount: artifacts.n, jobCount: jobs.n };
    return { contractVersion: 2, ...body, previewHash: hash(JSON.stringify(body)) };
}
function removeNote(db: Db, noteId: string): void {
    const note = db.prepare('SELECT rowid,text,legacy_note_id FROM memory_note_events WHERE note_id=?').get(noteId) as {
        rowid: number;
        text: string;
        legacy_note_id: number | null;
    } | undefined;
    if (!note)
        return;
    db.prepare("INSERT INTO memory_notes_fts(memory_notes_fts,rowid,text) VALUES('delete',?,?)").run(note.rowid, note.text);
    db.prepare('DELETE FROM note_supports WHERE note_id=?').run(noteId);
    db.prepare('DELETE FROM note_supersessions WHERE new_note_id=? OR old_note_id=?').run(noteId, noteId);
    db.prepare('DELETE FROM memory_note_events WHERE note_id=?').run(noteId);
    // applyForget rebuilds notes_fts before this transaction publishes. Clearing
    // prose is repeat-safe even when several source events map one legacy row.
    if (note.legacy_note_id !== null)
        db.prepare('UPDATE notes SET decided=?,open=?,next_step=? WHERE id=?').run('', '', '', note.legacy_note_id);

}
type Journal = {
    inputHash: string;
    receipt: ForgetReceipt;
    artifacts: string[];
    absoluteArtifacts?:string[];
};
/** Tombstone, every logical projection and work cancellation publish atomically. */
export function applyForget(db: Db, input: ForgetInput, options: {
    root?: string;
    expectedPreviewHash?: string;
} = {}): ForgetReceipt {
    if (!input.requestKey || input.requestKey.length > 256)
        throw new Error('invalid forget request key');
    const t = targetClass(input.target);
    const inputHash = hash(JSON.stringify({ target: input.target, removeSourceDerivedNotes: input.removeSourceDerivedNotes !== false }));
    const id = identity('forget/v1', input.requestKey);
    const prior = db.prepare('SELECT receipt_json FROM forget_tombstones WHERE tombstone_id=?').get(id) as {
        receipt_json: string;
    } | undefined;
    if (prior) {
        const journal = JSON.parse(prior.receipt_json) as Journal;
        if (journal.inputHash !== inputHash)
            throw new Error('forget idempotency key changed');
        return finishArchive(db, id, journal, options.root);
    }
    let preview = previewForget(db, input.target, input);
    if (options.expectedPreviewHash && options.expectedPreviewHash !== preview.previewHash)
        throw new Error('forget preview stale');
    const at = new Date().toISOString();
    let journal: Journal | undefined;
    db.transaction(() => {
        preview=previewForget(db,input.target,input);
        if(options.expectedPreviewHash&&options.expectedPreviewHash!==preview.previewHash)throw new Error('forget preview stale');
        db.prepare('INSERT INTO forget_tombstones VALUES(?,?,?,?,?,?,?)').run(id, t.column === 'source_id' ? t.id : null, t.column === 'note_id' ? t.id : null, inputHash, at, 'pending', '{}');
        const artifacts = t.column === 'source_id' ? (db.prepare('SELECT DISTINCT archive_relative_path FROM source_revisions r WHERE source_id=? AND archive_relative_path IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_revisions other WHERE other.archive_relative_path=r.archive_relative_path AND other.source_id<>?)').all(t.id, t.id) as {
            archive_relative_path: string;
        }[]).map(r => r.archive_relative_path) : [];
        const absoluteArtifacts:string[]=[];
        const retainedLegacyAnnotations:NonNullable<ForgetReceipt['retainedLegacyAnnotations']>=[];
        for (const noteId of preview.noteIds)
            removeNote(db, noteId);
        db.prepare("UPDATE maintenance_jobs SET state='cancelled',owner_token=NULL,lease_generation=NULL,target_revision_id=NULL,updated_at=? WHERE target_id=?").run(at, t.id);
        if (t.column === 'source_id') {
            for(const alias of db.prepare("SELECT path FROM source_aliases WHERE source_id=? AND kind='archive'").all(t.id) as {path:string}[])absoluteArtifacts.push(alias.path);
            const native = db.prepare('SELECT harness,native_session_id FROM memory_sources WHERE source_id=?').get(t.id) as {
                harness: string;
                native_session_id: string;
            } | undefined;
            // FTS delete commands receive the old text before removing content rows.
            const spans = db.prepare('SELECT p.* FROM evidence_spans p JOIN evidence_units u ON u.unit_revision_id=p.unit_revision_id WHERE u.source_id=?').all(t.id) as {
                span_id: string;
                span_rowid: number;
                text: string;
            }[];
            for (const p of spans) {
                db.prepare("INSERT INTO spans_fts(spans_fts,rowid,text) VALUES('delete',?,?)").run(p.span_rowid, p.text);
                db.prepare('DELETE FROM span_embeddings WHERE span_id=?').run(p.span_id);
            }
            db.prepare('DELETE FROM note_supports WHERE revision_id IN (SELECT revision_id FROM source_revisions WHERE source_id=?)').run(t.id);
            db.prepare("UPDATE memory_note_events SET support_status='orphaned' WHERE (support_status='linked' OR origin_source_id=?) AND NOT EXISTS(SELECT 1 FROM note_supports ns WHERE ns.note_id=memory_note_events.note_id AND ns.relation='supports')").run(t.id);
            db.prepare('DELETE FROM source_relations WHERE from_source_id=? OR to_source_id=? OR evidence_revision_id IN (SELECT revision_id FROM source_revisions WHERE source_id=?)').run(t.id, t.id, t.id);
            db.prepare('UPDATE memory_sources SET active_revision_id=NULL,availability=? WHERE source_id=?').run('forgotten', t.id);
            db.prepare('DELETE FROM capture_checkpoints WHERE source_id=?').run(t.id);
            db.prepare('UPDATE maintenance_jobs SET target_revision_id=NULL WHERE target_revision_id IN (SELECT revision_id FROM source_revisions WHERE source_id=?)').run(t.id);
            db.prepare('DELETE FROM revision_spans WHERE revision_id IN (SELECT revision_id FROM source_revisions WHERE source_id=?)').run(t.id);
            db.prepare('DELETE FROM revision_units WHERE revision_id IN (SELECT revision_id FROM source_revisions WHERE source_id=?)').run(t.id);
            db.prepare('DELETE FROM evidence_spans WHERE unit_revision_id IN (SELECT unit_revision_id FROM evidence_units WHERE source_id=?)').run(t.id);
            db.prepare('DELETE FROM evidence_units WHERE source_id=?').run(t.id);
            db.prepare('DELETE FROM source_revisions WHERE source_id=?').run(t.id);
            db.prepare('DELETE FROM source_aliases WHERE source_id=?').run(t.id);
            if (native) {
                {
                    const session = db.prepare('SELECT project_slug,archived_path,source_path FROM sessions WHERE id=? AND harness=?').get(native.native_session_id, native.harness) as {
                        project_slug: string | null;
                        archived_path: string | null;
                        source_path: string | null;
                    } | undefined;
                    const cardRelative=session?cardPath('',native.harness,session.project_slug,native.native_session_id):null;
                    if(cardRelative&&!artifacts.includes(cardRelative))artifacts.push(cardRelative);
                    const ownedPaths = [ ...(session?.archived_path ? [session.archived_path] : []), ...(db.prepare('SELECT archive_path FROM archive_files WHERE harness=? AND source_path=?').all(native.harness, session?.source_path ?? '') as {
                            archive_path: string;
                        }[]).map(x => x.archive_path)];
                    for (const owned of ownedPaths) {
                        if(!absoluteArtifacts.includes(owned))absoluteArtifacts.push(owned);
                    }
                    db.prepare('DELETE FROM archive_files WHERE harness=? AND source_path=?').run(native.harness, session?.source_path ?? '');
                }
                const retained=clearLegacySource(db, native.native_session_id, native.harness,t.id);
                if(retained)retainedLegacyAnnotations.push(retained);
            }
        }
        for (const fts of ['spans_fts', 'memory_notes_fts', 'exchanges_fts', 'cards_fts', 'ghosts_fts', 'ghost_prompts_fts', 'notes_fts'])
            db.prepare(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`).run();
        db.prepare('UPDATE memory_epochs SET evidence_epoch=evidence_epoch+1,notes_epoch=notes_epoch+1,lineage_epoch=lineage_epoch+1,deletion_epoch=deletion_epoch+1,vector_epoch=vector_epoch+1 WHERE singleton=1').run();
        const sharedHistory=options.root&&fs.existsSync(path.join(options.root,'archive','history.jsonl'))?['archive/history.jsonl']:[];
        journal = { inputHash, artifacts,absoluteArtifacts, receipt: { contractVersion: 2, requestKey: input.requestKey, tombstoneId: id, target: input.target, logicalForgetComplete: artifacts.length+absoluteArtifacts.length === 0&&!retainedLegacyAnnotations.length, archivePending: artifacts.length+absoluteArtifacts.length,...(sharedHistory.length?{retainedSharedArchives:sharedHistory}:{}),...(retainedLegacyAnnotations.length?{retainedLegacyAnnotations}:{}), removedNotes: preview.noteIds.length, removedSpans: preview.spanCount, epochs: readEpochs(db), committedAt: at } };
        db.prepare('UPDATE forget_tombstones SET state=?,receipt_json=? WHERE tombstone_id=?').run(artifacts.length+absoluteArtifacts.length ? 'pending' : 'complete', JSON.stringify(journal), id);
    })();
    return finishArchive(db, id, journal!, options.root);
}
function clearLegacySource(db: Db, nativeId: string, harness: string, sourceId:string): NonNullable<ForgetReceipt['retainedLegacyAnnotations']>[number]|undefined {
    const session = db.prepare('SELECT id FROM sessions WHERE id=? AND harness=?').get(nativeId, harness);
    if (session) {
        const exchanges = db.prepare('SELECT rowid,id,user_text,assistant_text FROM exchanges WHERE session_id=?').all(nativeId) as {
            rowid: number;
            id: string;
            user_text: string;
            assistant_text: string;
        }[];
        for (const e of exchanges) {
            db.prepare("INSERT INTO exchanges_fts(exchanges_fts,rowid,user_text,assistant_text) VALUES('delete',?,?,?)").run(e.rowid, e.user_text, e.assistant_text);
            try {
                db.prepare('DELETE FROM vec_exchanges WHERE id=?').run(e.id);
            }
            catch { /* unavailable legacy derivative */ }
        }
        db.prepare('DELETE FROM cards WHERE session_id=?').run(nativeId);
        try {
            db.prepare('DELETE FROM vec_cards WHERE session_id=?').run(nativeId);
        }
        catch { }
        db.prepare('DELETE FROM sessions WHERE id=?').run(nativeId);
    }
    const ghost = db.prepare('SELECT rowid,first_prompt,title FROM ghosts WHERE session_id=? AND harness=?').get(nativeId, harness) as {
        rowid: number;
        first_prompt: string | null;
        title: string | null;
    } | undefined;
    if (ghost) {
        const prompts = db.prepare('SELECT rowid,id,text FROM ghost_prompts WHERE session_id=?').all(nativeId) as {
            rowid: number;
            id: string;
            text: string;
        }[];
        for (const p of prompts) {
            db.prepare("INSERT INTO ghost_prompts_fts(ghost_prompts_fts,rowid,text) VALUES('delete',?,?)").run(p.rowid, p.text);
            try {
                db.prepare('DELETE FROM vec_ghost_prompts WHERE id=?').run(p.id);
            }
            catch { }
        }
        db.prepare("INSERT INTO ghosts_fts(ghosts_fts,rowid,first_prompt,title) VALUES('delete',?,?,?)").run(ghost.rowid, ghost.first_prompt, ghost.title);
        db.prepare('DELETE FROM ghosts WHERE session_id=?').run(nativeId);
    }
    // Native-only annotation keys cannot distinguish a foreign owner or a
    // historical cross-harness collision. Keep them untrusted rather than
    // deleting another source's annotations or guessing ownership.
    const owners=legacyNativeOwners(db,nativeId);
    if (owners.some(owner => owner !== harness)) {
        const count=(sql:string,...params:string[])=>Number((db.prepare(sql).get(...params) as {n:number}).n);
        // Only an exact, explicitly source-mapped field proves a surviving
        // legacy note belongs elsewhere. A current catalog row is not proof.
        const ambiguousFields=[['decision','decided'],['open','open'],['next','next_step']].map(([kind,field])=>`(n.${field}<>'' AND NOT EXISTS(SELECT 1 FROM memory_note_events mapped WHERE mapped.legacy_note_id=n.id AND mapped.origin_source_id IS NOT NULL AND mapped.origin_source_id<>? AND mapped.kind='${kind}' AND mapped.text=n.${field}))`).join(' OR ');
        const notes=count(`SELECT COUNT(*) n FROM notes n WHERE n.session_id=? AND (${ambiguousFields})`,nativeId,sourceId,sourceId,sourceId);
        const tags=count('SELECT COUNT(*) n FROM tags WHERE session_id=?',nativeId),pins=count('SELECT COUNT(*) n FROM pins WHERE session_id=?',nativeId),links=count('SELECT COUNT(*) n FROM links WHERE a_session_id=? OR b_session_id=?',nativeId,nativeId);
        return notes+tags+pins+links?{nativeSessionId:nativeId,ownership:'ambiguous',notes,tags,pins,links}:undefined;
    }
    db.prepare('DELETE FROM tags WHERE session_id=?').run(nativeId);
    db.prepare('DELETE FROM pins WHERE session_id=?').run(nativeId);
    db.prepare('DELETE FROM links WHERE a_session_id=? OR b_session_id=?').run(nativeId, nativeId);
    db.prepare('UPDATE notes SET decided=?,open=?,next_step=? WHERE session_id=?').run('', '', '', nativeId);
}
function finishArchive(db:Db,id:string,journal:Journal,root?:string):ForgetReceipt {
 const remaining:string[]=[];const absoluteRemaining:string[]=[];
 for(const owned of journal.absoluteArtifacts??[]){
  if(!root){absoluteRemaining.push(owned);continue;}
  const relative=path.relative(root,owned);
  if(relative.startsWith('..')||path.isAbsolute(relative)){absoluteRemaining.push(owned);continue;}
  if(!journal.artifacts.includes(relative))journal.artifacts.push(relative);
 }
 for(const relative of journal.artifacts){
  if(!root){remaining.push(relative);continue;}
  const file=path.resolve(root,relative);
  if(!file.startsWith(path.resolve(root)+path.sep)||!(relative.startsWith('archive/')||relative.startsWith('cards/'))){remaining.push(relative);continue;}
  try{
   const actualRoot=fs.realpathSync(root),actualParent=fs.realpathSync(path.dirname(file));
   if(actualParent!==actualRoot&&!actualParent.startsWith(actualRoot+path.sep)){remaining.push(relative);continue;}
   fs.unlinkSync(file);
  }catch(err){if((err as NodeJS.ErrnoException).code!=='ENOENT')remaining.push(relative);}
 }
 journal.artifacts=remaining;journal.absoluteArtifacts=absoluteRemaining;
 journal.receipt.archivePending=remaining.length+absoluteRemaining.length;journal.receipt.logicalForgetComplete=journal.receipt.archivePending===0&&!journal.receipt.retainedLegacyAnnotations?.length;
 db.prepare('UPDATE forget_tombstones SET state=?,receipt_json=? WHERE tombstone_id=?').run(journal.receipt.archivePending?'pending':'complete',JSON.stringify(journal),id);return journal.receipt;
}
export function recoverForget(db: Db, options: {
    root: string;
}): ForgetReceipt[] { return (db.prepare("SELECT tombstone_id,receipt_json FROM forget_tombstones WHERE state='pending'").all() as {
    tombstone_id: string;
    receipt_json: string;
}[]).map(r => finishArchive(db, r.tombstone_id, JSON.parse(r.receipt_json) as Journal, options.root)); }
