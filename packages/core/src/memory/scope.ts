import type { Scope } from './contracts.js';
export function validateScope(scope: Scope): void {
    for (const key of ['eventFrom','asOf', 'learnedBy'] as const)
        if (scope[key] && !Number.isFinite(Date.parse(scope[key]!)))
            throw new Error(`invalid ${key}`);
    if(scope.eventFrom&&scope.asOf&&Date.parse(scope.eventFrom)>Date.parse(scope.asOf))throw new Error('invalid event range');
    if (scope.sourceIds?.some(x => !x))
        throw new Error('empty source identity');
    if (scope.lineage && scope.lineage !== 'self' && !scope.sourceIds?.length)
        throw new Error('lineage scope requires canonical sourceIds');
}
/** Knowledge state is the last recorded activation, never observation/job arrival order. */
export function revisionStateSql(scope:Scope,source='s',revision='r'):{sql:string;params:unknown[]} {
 validateScope(scope);const clauses=[`${source}.availability<>'forgotten'`,`NOT EXISTS(SELECT 1 FROM forget_tombstones ft WHERE ft.source_id=${source}.source_id AND ft.state<>'reversed')`];const params:unknown[]=[];
 if(!scope.includeHistory){
  if(scope.learnedBy){clauses.push(`${revision}.revision_id=(SELECT a.revision_id FROM source_activations a WHERE a.source_id=${source}.source_id AND a.activated_at<=? ORDER BY a.activation_id DESC LIMIT 1)`);params.push(new Date(scope.learnedBy).toISOString());}
  else clauses.push(`${source}.active_revision_id=${revision}.revision_id`);
 }
 if(scope.learnedBy){clauses.push(`${revision}.observed_at<=?`);params.push(new Date(scope.learnedBy).toISOString());}
 return {sql:clauses.join(' AND '),params};
}
/** Scoped candidate eligibility must execute before ranking in every lane. */
export function scopeSql(scope: Scope, aliases = { source: 's', revision: 'r', unit: 'u' }): {
    sql: string;
    params: unknown[];
} {
    validateScope(scope);
    const { source: s, revision: r, unit: u } = aliases;
    const state=revisionStateSql(scope,s,r);
    const clauses=[state.sql];
    const params:unknown[]=[...state.params];
    if (scope.project !== undefined) {
        clauses.push(`${u}.project=?`);
        params.push(scope.project);
    }
    if (scope.branch !== undefined) {
        clauses.push(`${u}.branch=?`);
        params.push(scope.branch);
    }
    if (scope.sourceIds) {
        if (!scope.sourceIds.length)
            clauses.push('0');
        else if (!scope.lineage || scope.lineage === 'self') {
            clauses.push(`${s}.source_id IN (${scope.sourceIds.map(() => '?').join(',')})`);
            params.push(...scope.sourceIds);
        }
        else {
            const family = lineageFamilySql(scope);
            clauses.push(`${s}.source_id IN (${family.sql})`);
            params.push(...family.params);
        }
    }
    if(scope.eventFrom){clauses.push(`${u}.event_at IS NOT NULL AND ${u}.event_at>=?`);params.push(new Date(scope.eventFrom).toISOString());}
    if (scope.asOf) {
        clauses.push(`${u}.event_at IS NOT NULL AND ${u}.event_at<=?`);
        params.push(new Date(scope.asOf).toISOString());
    }
    return { sql: clauses.join(' AND '), params };
}

/** Traverse only relationship facts belonging to the governing eligible child revision. */
export function lineageFamilySql(scope: Scope): { sql: string; params: unknown[] } {
    validateScope(scope);
    const ids = scope.sourceIds ?? [];
    if (!ids.length) return { sql: 'SELECT NULL WHERE 0', params: [] };
    const state = revisionStateSql(scope, 'child', 'er');
    const relation = `EXISTS(SELECT 1 FROM source_revisions er JOIN memory_sources child ON child.source_id=er.source_id WHERE er.revision_id=rel.evidence_revision_id AND ${state.sql})${scope.learnedBy ? ' AND rel.observed_at<=?' : ''}`;
    const relationParams = [...state.params, ...(scope.learnedBy ? [new Date(scope.learnedBy).toISOString()] : [])];
    const ancestors = scope.lineage === 'ancestors';
    const walk = `SELECT ${ancestors ? 'rel.from_source_id' : 'rel.to_source_id'} FROM source_relations rel JOIN family f ON ${ancestors ? 'rel.to_source_id' : 'rel.from_source_id'}=f.id WHERE ${relation}`;
    const reverse = scope.lineage === 'conversation' ? ` UNION SELECT rel.from_source_id FROM source_relations rel JOIN family f ON rel.to_source_id=f.id WHERE ${relation}` : '';
    return { sql: `WITH RECURSIVE family(id) AS (VALUES ${ids.map(() => '(?)').join(',')} UNION ${walk}${reverse}) SELECT id FROM family`, params: [...ids, ...relationParams, ...(reverse ? relationParams : [])] };
}
