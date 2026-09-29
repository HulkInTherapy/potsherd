import { legacyNativeOwners, legacyNativeOwnershipAmbiguous, displayTitleOf, resolveSession, type db as dbNs } from '@potsherd/core';
import { UserError } from './output.js';

type Db = dbNs.Db;
function ownershipError(db:Db,nativeId:string):UserError {
 const reason=legacyNativeOwners(db,nativeId).length>1?'is shared by multiple harnesses':'has unverified harness ownership';
 return new UserError(`native session ${nativeId} ${reason}; organization is ambiguous`,'Use scoped source refs for reads and authored memory instead');
}


export interface ResolvedRef {
  id: string;
  kind: 'session' | 'ghost';
  /** What `ls` would call it — for the receipt the writing verbs print. */
  title: string;
}

/** Organization still keys native IDs; reject a cross-harness collision. */
function activeSourceRows(db:Db,needle:string):{id:string;project:string|null;kind:'session'|'ghost';sourceId:string;harness:string}[]{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_sources'").get())return [];
 const escaped=needle.replace(/[\\%_]/g,c=>`\\${c}`);
 const rows=db.prepare(`SELECT s.source_id sourceId,s.native_session_id id,s.harness,s.project,
 CASE WHEN EXISTS(SELECT 1 FROM revision_units ru JOIN evidence_units u ON u.unit_revision_id=ru.unit_revision_id WHERE ru.revision_id=s.active_revision_id AND u.role='ghost_prompt') THEN 'ghost' ELSE 'session' END kind
 FROM memory_sources s WHERE s.active_revision_id IS NOT NULL AND s.availability<>'forgotten'
 AND NOT EXISTS(SELECT 1 FROM forget_tombstones t WHERE t.source_id=s.source_id AND t.state<>'reversed')
 AND (s.native_session_id=? OR s.source_id=? OR s.native_session_id LIKE ? ESCAPE '\\' OR s.native_session_id LIKE ? ESCAPE '\\')`).all(needle,needle,escaped+'%',`%:agent-${escaped}%`) as {id:string;project:string|null;kind:'session'|'ghost';sourceId:string;harness:string}[];
 const exact=rows.filter(row=>row.id===needle||row.sourceId===needle);return exact.length?exact:rows;
}

/**
 * The one resolver `tag`, `pin`, `unpin` and `link` share with `show`.
 *
 * Every verb that names a session takes the same eight characters `ls` and
 * `find` print, because nobody retypes a uuid. There is exactly one
 * implementation of what those eight characters mean
 * (`browse.ts`'s `resolveSession`), so `potsherd show 9c4d2f18` and
 * `potsherd tag 9c4d2f18` can never disagree about which session that is —
 * which they would within a week if this were written twice.
 *
 * What this adds is the failure side. A reference that resolves to nothing is
 * the commonest mistake at this surface, and it must say so and name the one
 * command that fixes it — never a stack trace, and never a silent write to a
 * session id that does not exist. `tags`, `pins` and `links` carry no foreign
 * key (a pin on a *deleted* session is the pin most worth having, and a ghost
 * has no row in `sessions`), so this check is the only thing standing between
 * a typo and a row nothing will ever read.
 */
export function mustResolve(db: Db, ref: string, verb: string): ResolvedRef {
  const needle = ref?.trim() ?? '';
  if (!needle) {
    throw new UserError(`${verb} needs a session id`, `potsherd ${verb} 9c4d2f18`);
  }

  const sources=activeSourceRows(db,needle);
  for(const row of sources){if(legacyNativeOwnershipAmbiguous(db,row.id))throw ownershipError(db,row.id);}
  for(const source of sources){
    const foreign=db.prepare("SELECT harness FROM sessions WHERE id=? AND harness<>? UNION ALL SELECT harness FROM ghosts WHERE session_id=? AND harness<>? LIMIT 1").get(source.id,source.harness,source.id,source.harness);
    if(foreign)throw new UserError('the legacy organization row belongs to another harness; this source cannot be represented safely','Use scoped source reads and authored memory instead');
  }
  const found = resolveSession(db, needle);
  if(!found&&sources.length===1){const source=sources[0]!;return {id:source.id,kind:source.kind,title:displayTitleOf(null,source.project,source.id)};}
  if(!found&&sources.length>1)throw new UserError(`"${needle}" matches ${sources.length} active sources`,'Use a complete native session id');
  if(found&&!found.ambiguous&&sources.some(source=>source.id!==found.id&&!found.collapsed?.some(other=>other.id===source.id)))throw new UserError(`"${needle}" matches legacy and additional active sources`,'Use a complete native session id');
  if (!found) {
    throw new UserError(
      `no session in the index starts with "${needle}"`,
      'potsherd ls    # the ids are the first eight characters of  potsherd ls --json',
    );
  }
  if (found.ambiguous) {
    // The whole id, not a prefix: the reason these are ambiguous is that their
    // prefixes collide, so printing prefixes back would be useless.
    const shown = found.ambiguous
      .slice(0, 5)
      .map((c) => `${c.id}  ${displayTitleOf(c.title, c.project, c.id)}`)
      .join('\n        ');
    throw new UserError(
      `"${needle}" matches ${found.ambiguous.length} sessions:\n        ${shown}`,
      `potsherd ${verb} ${found.ambiguous[0]!.id}`,
    );
  }

  if(legacyNativeOwnershipAmbiguous(db,found.id))throw ownershipError(db,found.id);
  return { id: found.id, kind: found.kind, title: titleOf(db, found.id, found.kind,sources.find(source=>source.id===found.id)?.harness) };
}

function titleOf(db: Db, id: string, kind: 'session' | 'ghost',harness?:string): string {
  if (kind === 'ghost') {
    const row = db
      .prepare(
        `SELECT g.title AS title, g.project AS project,
                (SELECT p.text FROM ghost_prompts p WHERE p.session_id = g.session_id
                   AND p.text NOT LIKE '/%' AND length(trim(p.text)) > 3
                 ORDER BY p.seq LIMIT 1) AS best_prompt
           FROM ghosts g WHERE g.session_id = ? ${harness?'AND g.harness=?':''}`,
      )
      .get(id,...(harness?[harness]:[])) as { title: string | null; project: string | null; best_prompt: string | null } | undefined;
    const text = row?.title ?? row?.best_prompt ?? null;
    return displayTitleOf(text ? text.replace(/\s+/g, ' ').slice(0, 120) : null, row?.project ?? null, id);
  }
  // A card title beats the harness's, the same way it does in `ls`. `cards` is
  // empty until T2.2, so today this always falls through to `s.title`.
  const row = db
    .prepare(
      `SELECT COALESCE((SELECT c.title FROM cards c WHERE c.session_id = s.id), s.title) AS title,
              s.project AS project, s.harness AS harness
         FROM sessions s WHERE s.id = ? ${harness?'AND s.harness=?':''}`,
    )
    .get(id,...(harness?[harness]:[])) as { title: string | null; project: string | null; harness: string } | undefined;
  return displayTitleOf(row?.title ?? null, row?.project ?? null, id);
}
