/**
 * OpenCode keeps history in SQLite (current) or JSON files (legacy). Both are
 * read in place, read-only, and turned into the same `SourceFacts` the JSONL
 * harnesses produce. The database is never copied.
 */
import fs from 'node:fs';
import {openDatabase} from '../sqlite-driver.js';
import type {AuditSqliteSnapshot} from '../audit-sqlite.js';
import {FACTS_VERSION, classifyText, type SourceFacts, type UsageFact} from './extract.js';
import {openNativeInputs, openSessions, openUsageMetadata, selectOpenSchema} from './opencode.js';
import {readLegacyOpenCode} from './opencode-json.js';
import {clean} from './source.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const time = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
};

/** Converts OpenCode message metadata (with `message.tokens`) into facts. */
function toFacts(file: string, size: number, mtimeMs: number, session: {id: string; project: string | null; parent: string | null; title: string | null},
  records: readonly Rec[], prompts: readonly {key: string; text: string; time: string | null}[]): SourceFacts {
  const usage: UsageFact[] = [];
  let model: string | null = null, provider: string | null = null, firstAt: number | null = null, lastAt: number | null = null;
  const touch = (at: number | null) => { if (at === null) return; firstAt = firstAt === null ? at : Math.min(firstAt, at); lastAt = lastAt === null ? at : Math.max(lastAt, at); };
  const answers: {at: number | null; model: string | null; provider: string | null}[] = [];
  for (const r of records) {
    const m = isRec(r.message) ? {...r, ...r.message} : r;
    if (m.role !== 'assistant') continue;
    const modelObj = isRec(m.model) ? m.model : {};
    model = str(m.modelID) ?? str(modelObj.modelID) ?? str(modelObj.id) ?? str(m.model) ?? model;
    provider = str(m.providerID) ?? str(modelObj.providerID) ?? provider;
    const at = time(r.timestamp) ?? time(isRec(m.time) ? m.time.created : null);
    touch(at);
    answers.push({at, model, provider});
    const t = isRec(m.tokens) ? m.tokens : null;
    if (!t) continue;
    const cache = isRec(t.cache) ? t.cache : {};
    const fact: UsageFact = {
      key: `opencode:${str(r.id) ?? str(m.id) ?? `${session.id}:${usage.length}`}`, at, model, provider,
      input: int(t.input), output: int(t.output) + int(t.reasoning), cacheRead: int(cache.read), cacheWrite: int(cache.write), cacheWrite1h: 0,
      reasoning: int(t.reasoning),
    };
    if (fact.input + fact.output + fact.cacheRead + fact.cacheWrite > 0) usage.push(fact);
  }
  const facts: SourceFacts = {
    v: FACTS_VERSION, harness: 'opencode', file, size, mtimeMs, sessionId: session.id, parentId: session.parent, child: session.parent !== null,
    project: session.project, title: session.title, automated: false, excluded: false, startedAt: null, firstAt, lastAt, usage, prompts: [], malformed: 0,
  };
  for (const p of prompts) {
    const at = time(p.time);
    touch(at);
    const c = classifyText(p.text);
    const before = [...answers].reverse().find(a => a.at !== null && at !== null && a.at <= at);
    const after = answers.find(a => a.at !== null && at !== null && a.at > at);
    facts.prompts.push({
      key: `opencode:${session.id}:${p.key}`, at, project: session.project,
      kind: session.parent ? 'excluded' : c.kind, reason: session.parent ? 'subagent_parent_written' : c.reason,
      text: !session.parent && c.kind === 'human' ? clean(c.text.slice(0, 4000)) : '',
      before: before?.model ?? null, beforeProvider: before?.provider ?? null, after: after?.model ?? null, afterProvider: after?.provider ?? null,
    });
  }
  facts.firstAt = firstAt; facts.lastAt = lastAt;
  return facts;
}

/** Reads every session of one OpenCode database, read-only. */
export function extractOpenCodeDatabase(file: string): SourceFacts[] {
  const stat = fs.statSync(file);
  const db = openDatabase(file, {readonly: true, fileMustExist: true});
  try {
    const reader: AuditSqliteSnapshot = {db, hash: '', assertCurrent: () => {}, assertIdentityCurrent: () => {}};
    const found = openSessions(file, 100_000, Number.MAX_SAFE_INTEGER, reader);
    if ('gap' in found) return [];
    return found.sessions.map(session => {
      const schema = selectOpenSchema(found.schema, session.id, reader);
      const metadata = openUsageMetadata(schema, session.id, reader);
      const inputs = openNativeInputs(schema, metadata.records, reader);
      return toFacts(file, stat.size, stat.mtimeMs, session, metadata.records, inputs.prompts.map(p => ({key: p.key, text: p.text, time: p.time})));
    });
  } finally {
    db.close();
  }
}

/** Reads the legacy `storage/{session,message,part}/*.json` layout. */
export function extractOpenCodeJson(files: readonly string[]): SourceFacts[] {
  const {groups} = readLegacyOpenCode(files.map(file => ({file, harness: 'opencode' as const, bytes: fs.statSync(file).size, kind: 'opencode-json' as const})));
  return groups.map(group => {
    const prompts = group.facts.events.map(e => ({key: e.key, text: e.text, time: e.eventAt}));
    return toFacts(group.root, 0, 0, {id: group.facts.nativeId, project: group.facts.project, parent: group.facts.parent, title: group.facts.title}, group.records, prompts);
  });
}
