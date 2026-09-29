import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {beforeAll,describe,expect,it,vi} from 'vitest';
import {buildSpanManifest,deriveCoveragePartitions,spanEmbeddingText,spanManifestHash,spanWindows,hash} from '../packages/core/src/memory/spans.js';
import {loadSpanTokenizer,type EvidenceTokenizer} from '../packages/core/src/memory/tokenization.js';

// Explicit copied public assets only; no user store/configuration/transcript access.
const cache=process.env.POTSHERD_TEST_TOKENIZER_DIR;
const scalarEnds=(text:string)=>[0,...Array.from(text).reduce<number[]>((ends,c)=>{ends.push((ends.at(-1)??0)+c.length);return ends;},[])];
let tokenizer:EvidenceTokenizer={id:'synthetic-scalar-fixture',assetHash:'synthetic-test-only',count:text=>Array.from(text).length,boundaries:scalarEnds,sourceBoundaries:text=>scalarEnds(text).map((offsetUtf16,tokenEndOrdinal)=>({offsetUtf16,tokenEndOrdinal}))};
let direct:{encode(text:string,options:Record<string,boolean>):{ids:number[]};tokenize(text:string,options:Record<string,boolean>):string[]};
beforeAll(async()=>{
 if(!cache)return;
 const loaded=await loadSpanTokenizer(cache);if(!loaded)throw new Error('verified copied tokenizer assets required');tokenizer=loaded;
 const {Tokenizer}=await import(pathToFileURL(path.join(cache,'runtime/onnxruntime-web-1.27.0/tokenizers.mjs')).href);
 direct=new Tokenizer(JSON.parse(fs.readFileSync(path.join(cache,'Xenova/bge-small-en-v1.5/tokenizer.json'),'utf8')),JSON.parse(fs.readFileSync(path.join(cache,'Xenova/bge-small-en-v1.5/tokenizer_config.json'),'utf8')));
});
describe.skipIf(!cache)('span-v2 source coordinates and encoding',()=>{
 it.each([{text:'😀!a',ids:[100,999,1037],ends:[0,2,3,4]},{text:'A😀!B',ids:[100,999,1038],ends:[0,3,4,5]}])('maps [UNK] only through its pinned pretoken for $text',({text,ids,ends})=>{
  const before=direct.encode(text,{add_special_tokens:false});expect(before.ids).toEqual(ids);
  const input='[project:/synthetic]\n[role:tool_result]\n[tool:Bash]\n[outcome:unknown]\n\n'+text;const fullBefore=direct.encode(input,{add_special_tokens:true,return_token_type_ids:true});
  expect(fullBefore.ids).toEqual([101,1031,2622,1024,1013,12553,1033,1031,2535,1024,6994,1035,2765,1033,1031,6994,1024,24234,1033,1031,9560,1024,4242,1033,...ids,102]);
  expect(tokenizer.sourceBoundaries(text).map(b=>b.offsetUtf16)).toEqual(ends);
  expect(direct.encode(text,{add_special_tokens:false})).toEqual(before);expect(direct.encode(input,{add_special_tokens:true,return_token_type_ids:true})).toEqual(fullBefore);
  // Old v1 offset helper deliberately keeps its historical behavior.
  expect(()=>tokenizer.boundaries(text)).toThrow('offset mapping');
 });
 it.each(['각한글','Café café','İstanbul','[CLS]a[SEP]','[UNK]!a','a\u0000b','中文😀!a','👩‍💻!word','  \n\t'])('preserves the direct whole-unit encoding for %s',(text)=>{
  const before=direct.encode(text,{add_special_tokens:false});const bounds=tokenizer.sourceBoundaries(text);
  expect(bounds.at(-1)!.tokenEndOrdinal).toBe(before.ids.length);expect(bounds.at(-1)!.offsetUtf16).toBe(text.length);
  expect(tokenizer.count(text)).toBe(before.ids.length);expect(direct.encode(text,{add_special_tokens:false})).toEqual(before);
 });
 it('retains every Hangul piece ordinal behind each safe scalar end',()=>expect(tokenizer.sourceBoundaries('각한글')).toEqual([{offsetUtf16:0,tokenEndOrdinal:0},{offsetUtf16:1,tokenEndOrdinal:3},{offsetUtf16:2,tokenEndOrdinal:6},{offsetUtf16:3,tokenEndOrdinal:9}]));
});
describe('span-v2 one-family manifest',()=>{
 it.each(['',' \n\t','각 '.repeat(900),'identifier_really_long_multipart_symbol_123 '.repeat(500),'Café café İstanbul 😀!a 中文\n'.repeat(400),'last_tail '.repeat(400)+'FINAL_TAIL_42'])('bounds and reconstructs exact Unicode source text',(text)=>{
  const manifest=buildSpanManifest(text,tokenizer,'[project:😀!a /synthetic]\n[role:tool_result]\n[tool:각한글]\n[outcome:unknown] '+ 'context '.repeat(100));
  expect(manifest.policy).toContain('span-v2:');expect(deriveCoveragePartitions(manifest.windows,text)).toEqual(manifest.coveragePartitions);
  expect(manifest.coveragePartitions.map(p=>manifest.windows[p.windowOrdinal]!.text.slice(p.relativeStartUtf16,p.relativeEndUtf16)).join('')).toBe(text);
  for(const [i,w] of manifest.windows.entries()) {
   const metadata=JSON.parse(w.embeddingContextJson);const input=spanEmbeddingText(w.text,w.embeddingContextJson);
   expect(tokenizer.count(input)+2).toBeLessThanOrEqual(384);if(cache)expect(direct.encode(input,{add_special_tokens:true}).ids.length).toBeLessThanOrEqual(384);
   expect(tokenizer.count(metadata.context)).toBeLessThanOrEqual(64);expect(w.embeddingInputHash).toBe(hash(input));expect(w.text).toBe(text.slice(w.startUtf16,w.endUtf16));
   if(i){expect(w.endUtf16).toBeGreaterThan(manifest.windows[i-1]!.endUtf16);expect(w.startUtf16).toBeGreaterThan(manifest.windows[i-1]!.startUtf16);expect(metadata.actualSourceOverlap).toBeGreaterThanOrEqual(32);expect(metadata.actualSourceOverlap).toBe(JSON.parse(manifest.windows[i-1]!.embeddingContextJson).sourceTokenEnd-metadata.sourceTokenStart);}
  }
 });
 it.skipIf(!cache)('prefers a safe latter-half newline while retaining complete source ordinals',()=>{const text='token sentence\n'.repeat(400),m=buildSpanManifest(text,tokenizer);expect(m.windows.length).toBeGreaterThan(1);expect(m.windows.slice(0,-1).every(w=>w.text.endsWith('\n'))).toBe(true);expect(m.windows.slice(1).every(w=>JSON.parse(w.embeddingContextJson).actualSourceOverlap>=32)).toBe(true);});
 it.skipIf(!cache)('rounds the 32-source-piece target outward to33 for Hangul',()=>{
  const m=buildSpanManifest('각 '.repeat(600),tokenizer);expect(m.windows.length).toBeGreaterThan(1);
  for(const w of m.windows.slice(1)){expect(JSON.parse(w.embeddingContextJson)).toMatchObject({targetSourceOverlap:32,actualSourceOverlap:33,sourceOverlapRounding:1});}
 });
 it.skipIf(!cache)('does not demand32 pieces from a detached identifier substring',()=>{
  const m=buildSpanManifest('identifier_really_long_multipart_symbol_123 '.repeat(300),tokenizer,'word');
  const standalone=m.windows.slice(1).map((w,i)=>tokenizer.count(w.text.slice(0,m.windows[i]!.endUtf16-w.startUtf16)));
  expect(standalone.some(n=>n!==32)).toBe(true);expect(m.windows.slice(1).every(w=>JSON.parse(w.embeddingContextJson).actualSourceOverlap===32)).toBe(true);
 });
 it('commits current policy for empty sources and retains v1 geometry helper',()=>{
  const empty=buildSpanManifest('',tokenizer);expect(empty.windows).toEqual([]);expect(empty.coveragePartitions).toEqual([]);
  expect(spanManifestHash(empty.policy,[])).not.toBe(spanManifestHash('different-policy',[]));
  const text='word '.repeat(700),v1=spanWindows(text,tokenizer),v2=buildSpanManifest(text,tokenizer);
  expect(v1.some(w=>w.isPartition===false)).toBe(true);expect(v1.every(w=>w.chunkPolicy.startsWith('span-v1:'))).toBe(true);
  expect(v2.windows.length).toBeLessThan(v1.length);expect(v2.windows.every(w=>w.isPartition===false)).toBe(true);
 });
 it('rejects corrupted exact coverage',()=>{
  const text='word '.repeat(700),m=buildSpanManifest(text,tokenizer);const broken=m.windows.map(w=>({...w}));broken[1]!.text='x'+broken[1]!.text.slice(1);expect(()=>deriveCoveragePartitions(broken,text)).toThrow('coverage');
 });
});

// These synthetic ledgers exercise an additive policy transition. They are
// constructed as genuine v1 artifacts rather than mutating a published v2 row.
import {open,type Db} from '../packages/core/src/db.js';
import type {ParseResult} from '../packages/core/src/adapters/types.js';
import {sourceId,publishSource,listSourceSpans,readSpan,NORMALIZATION_VERSION,readEpochs} from '../packages/core/src/memory/source.js';
import {identity,currentSpanPolicy} from '../packages/core/src/memory/spans.js';
import {rebuildEvidenceSpans} from '../packages/core/src/memory/backfill.js';
function parsedFixture(id:string,text:string):ParseResult {return {session:{id,harness:'claude',sourcePath:'',project:'/synthetic',projectSlug:'synthetic',startedAt:'',endedAt:'',isSidechain:false,counts:{userPrompts:0,assistantTurns:1,toolCalls:0,bytes:17},status:'archived'},records:text?[{unitKey:'assistant:one',role:'assistant',text,eventAt:null,timeBasis:'unknown',project:'/synthetic',locator:{recordKey:'one',mapping:'unavailable'},locatorFidelity:'record_id',recordType:'assistant'}]:[],exchanges:[],endOffset:17,malformedLines:0,unknownTypes:{},evidenceVersion:'synthetic-records-v1'};}
function insertV1(db:Db,id:string,text:string,norm=NORMALIZATION_VERSION,parsedOverride?:ParseResult,artifactOverride?:string) {
 const parsed=parsedOverride??parsedFixture(id,text),sid=sourceId('claude',id),artifactHash=artifactOverride??hash('synthetic raw '+id),at='2026-01-01T00:00:00.000Z';
 const snapshots=parsed.records!.map(r=>{const locator=JSON.stringify(r.locator),uid=identity(sid,r.unitKey,hash(r.text),norm,r.role,locator,r.eventAt??'',r.timeBasis,r.project??'',r.branch??'',r.toolName??'',r.toolCallId??'',r.outcome??'',r.locatorFidelity),windows=spanWindows(r.text,tokenizer,`[project:${r.project??'unknown'}]\n[role:${r.role}]\n[tool:${r.toolName??'none'}]\n[outcome:${r.outcome??'unknown'}]`);return {r,locator,id:uid,windows};});
 const manifestHash=hash(JSON.stringify(snapshots.map(x=>({id:x.id,partitions:x.windows.map(w=>[w.startUtf16,w.endUtf16,w.chunkPolicy])}))));const rid=identity(sid,artifactHash,parsed.evidenceVersion!,norm,manifestHash);
 const gaps={unknownTypes:{},malformedLines:0,originalAvailability:'archived',richerSourceTransition:{fromRevisionId:'retained-original-history',basis:'history_to_transcript'},unknownRetainedCoverage:{fact:'original'},chunkPolicy:'old-marker'};
 db.prepare("INSERT INTO memory_sources VALUES(?,?,?,NULL,?,'archived',?)").run(sid,'claude',id,'/synthetic',at);
 db.prepare('INSERT INTO source_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,sid,artifactHash,parsed.endOffset,null,parsed.evidenceVersion,norm,manifestHash,null,null,at,'/synthetic',null,'complete',JSON.stringify(gaps));
 let ordinal=0;for(const [i,x] of snapshots.entries()){const r=x.r;db.prepare('INSERT INTO evidence_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(x.id,sid,r.unitKey,r.role,r.text,hash(r.text),norm,r.toolName??null,r.toolCallId??null,r.outcome??null,r.eventAt,r.timeBasis,r.project??null,r.branch??null,x.locator,r.locatorFidelity,r.exchangeId??null,r.seq??null);db.prepare('INSERT INTO revision_units VALUES(?,?,?)').run(rid,x.id,i);for(const w of x.windows){const spanId=identity(sid,x.id,String(w.startUtf16),String(w.endUtf16),w.chunkPolicy),insert=db.prepare('INSERT INTO evidence_spans(span_id,unit_revision_id,start_utf16,end_utf16,text,text_hash,chunk_policy,embedding_input_hash,embedding_context_json) VALUES(?,?,?,?,?,?,?,?,?)').run(spanId,x.id,w.startUtf16,w.endUtf16,w.text,hash(w.text),w.chunkPolicy,w.embeddingInputHash,w.embeddingContextJson);db.prepare('INSERT INTO spans_fts(rowid,text) VALUES(?,?)').run(insert.lastInsertRowid,w.text);db.prepare('INSERT INTO revision_spans VALUES(?,?,?)').run(rid,spanId,ordinal++);}}
 db.prepare('UPDATE memory_sources SET active_revision_id=? WHERE source_id=?').run(rid,sid);db.prepare('INSERT INTO source_activation_baselines VALUES(?,?,1)').run(sid,at);db.prepare("INSERT INTO source_activations(source_id,revision_id,activated_at,evidence_epoch,basis) VALUES(?,?,?,0,'published')").run(sid,rid,at);
 return {parsed,sourceId:sid,revisionId:rid,manifestHash,gaps};
}
describe('immutable span-v2 publication and retained-unit rebuild',()=>{
 it('keeps v1 revisions/refs/unitIDs/notes and original times, adds real activation and preserves retained gaps',async()=>{
  const db=open({file:':memory:'});try{const old=insertV1(db,'retained','BOUNDARY_FACT42 '.repeat(800));const oldRef=listSourceSpans(db,old.sourceId,old.revisionId).evidence[0]!.ref;const oldRows=db.prepare('SELECT * FROM source_revisions').all();const oldUnits=db.prepare('SELECT * FROM evidence_units ORDER BY unit_revision_id').all();const oldSpans=db.prepare('SELECT * FROM evidence_spans ORDER BY span_id').all();
   const {writeMemoryNotes,queryCurrentNotes}=await import('../packages/core/src/memory/notes-store.js');const note=writeMemoryNotes(db,{requestKey:'retained-support',scope:{project:'/synthetic'},originSourceId:old.sourceId,origin:'api',entries:[{kind:'observation',text:'retained supported note',supports:[oldRef]}]});
   expect(rebuildEvidenceSpans(db,{tokenizer})).toEqual({rebuilt:1,remaining:0});const current=listSourceSpans(db,old.sourceId);
   expect(current.source!.revisionId).not.toBe(old.revisionId);expect(current.source!.observedAt).not.toBe('2026-01-01T00:00:00.000Z');expect(current.source!.normalizationVersion).toBe(NORMALIZATION_VERSION);expect(current.source!.coverageGaps).toMatchObject({...old.gaps,chunkPolicy:currentSpanPolicy(tokenizer),manifestVersion:'span-manifest-v2'});
   expect(db.prepare('SELECT * FROM source_revisions WHERE revision_id=?').all(old.revisionId)).toEqual(oldRows);expect(db.prepare('SELECT * FROM evidence_units ORDER BY unit_revision_id').all()).toEqual(oldUnits);expect(db.prepare('SELECT * FROM evidence_spans WHERE chunk_policy LIKE ? ORDER BY span_id').all('span-v1:%')).toEqual(oldSpans);
   expect(readSpan(db,oldRef)?.ref).toEqual(oldRef);expect(queryCurrentNotes(db,{project:'/synthetic'})).toMatchObject([{noteId:note.noteIds[0],supportRefs:[oldRef]}]);
   expect(rebuildEvidenceSpans(db,{tokenizer})).toEqual({rebuilt:0,remaining:0});expect(db.prepare('SELECT COUNT(*) n FROM source_activations').get()).toEqual({n:2});
   const repeated=publishSource(db,{parsed:old.parsed,artifactHash:hash('synthetic raw retained'),artifactBytes:17,tokenizer});expect(repeated.revisionId).toBe(current.source!.revisionId);expect(db.prepare('SELECT COUNT(*) n FROM source_activations').get()).toEqual({n:2});
  }finally{db.close();}
 });
 it('invalidates empty sources exactly once and rolls back fenced publication',()=>{
  const db=open({file:':memory:'});try{const old=insertV1(db,'empty','');expect(()=>rebuildEvidenceSpans(db,{tokenizer,beforeCommit:()=>{throw new Error('fence fixture');}})).toThrow('fence fixture');expect(listSourceSpans(db,old.sourceId).source!.revisionId).toBe(old.revisionId);expect(db.prepare('SELECT COUNT(*) n FROM source_revisions').get()).toEqual({n:1});expect(rebuildEvidenceSpans(db,{tokenizer})).toEqual({rebuilt:1,remaining:0});expect(listSourceSpans(db,old.sourceId).evidence).toEqual([]);expect(rebuildEvidenceSpans(db,{tokenizer})).toEqual({rebuilt:0,remaining:0});
  }finally{db.close();}
 });
 it('preserves older normalization and its privacy guard during a span-only rebuild',()=>{
  const db=open({file:':memory:'});try{const unsafe='COMMAND_MARKER --socket-auth fixture-sensitive-socket-credential';const old=insertV1(db,'old-private',unsafe,'redacted-evidence-v2');const refs=db.prepare('SELECT span_id FROM revision_spans WHERE revision_id=?').all(old.revisionId) as {span_id:string}[];expect(readSpan(db,{sourceId:old.sourceId,revisionId:old.revisionId,spanId:refs[0]!.span_id})).toBeNull();const units=db.prepare('SELECT * FROM evidence_units').all();expect(rebuildEvidenceSpans(db,{tokenizer})).toEqual({rebuilt:1,remaining:0});expect(listSourceSpans(db,old.sourceId).source!.normalizationVersion).toBe('redacted-evidence-v2');expect(listSourceSpans(db,old.sourceId).evidence).toEqual([]);expect(db.prepare('SELECT * FROM evidence_units').all()).toEqual(units);expect(rebuildEvidenceSpans(db,{tokenizer})).toEqual({rebuilt:0,remaining:0});
  }finally{db.close();}
 });
});

import os from 'node:os';
import * as assets from '../packages/core/src/memory/assets.js';
import {embeddingToBlob} from '../packages/core/src/embeddings.js';
import {MaintenanceWorker,ensureSpanSpace} from '../packages/core/src/memory/maintenance.js';
import {SpanDenseLane} from '../packages/core/src/memory/dense.js';
import {indexAll} from '../packages/core/src/ingest.js';
import {captureHistoryEvidence} from '../packages/core/src/memory/history.js';
import {LEGACY_EXCHANGE_MAPPING_VERSION} from '../packages/core/src/parser/evidence.js';
import {parseClaudeTranscript} from '../packages/core/src/parser/claude.js';
function vector(){const value=Array<number>(384).fill(0);value[0]=1;return value;}
function fakeEncoder(){return {encodeBatch:vi.fn(async(texts:string[])=>texts.map(()=>vector())),encode:vi.fn(async()=>vector()),close:vi.fn(async()=>{})} as unknown as assets.LocalEncoder;}
describe.skipIf(!cache)('span-v2 mocked semantic policy compatibility',()=>{
 it('reuses exact verified-space v1 payloads for independently committed v2 targets and retains historical dense access',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'span-v2-reuse-')),db=open({root}),encoder=fakeEncoder(),worker=new MaintenanceWorker(root,{db,encoder});const ready=vi.spyOn(assets,'inspectAssets').mockReturnValue({state:'ready'} as ReturnType<typeof assets.inspectAssets>);
  try{const old=insertV1(db,'reuse','exact stable payload');ensureSpanSpace(db);const prior=db.prepare('SELECT span_id,embedding_input_hash FROM evidence_spans').get() as {span_id:string;embedding_input_hash:string};db.prepare('INSERT INTO span_embeddings VALUES(?,?,?,?,?,NULL)').run(prior.span_id,assets.DEFAULT_SPACE_ID,prior.embedding_input_hash,embeddingToBlob(vector()),'2026-01-01T00:00:00.000Z');expect(rebuildEvidenceSpans(db,{tokenizer})).toEqual({rebuilt:1,remaining:0});await worker.drainOnce();expect(encoder.encodeBatch).not.toHaveBeenCalled();expect(db.prepare('SELECT COUNT(*) n FROM span_embeddings').get()).toEqual({n:2});
   const lane=new SpanDenseLane(db,{root,cacheDir:root,encoder});const historical=await lane.search({query:'payload',scope:{project:'/synthetic',learnedBy:'2026-01-01T00:00:00.000Z'},snapshotEpochs:readEpochs(db),limit:5});expect(historical.state).toBe('ready');expect(historical.candidates.map(c=>c.ref.revisionId)).toEqual([old.revisionId]);const current=await lane.search({query:'payload',scope:{project:'/synthetic'},snapshotEpochs:readEpochs(db),limit:5});expect(current.state).toBe('ready');expect(current.candidates[0]!.ref.revisionId).not.toBe(old.revisionId);
   // Missing vectors for a requested historical membership stay in the denominator.
   const unsupported=publishSource(db,{parsed:parsedFixture('unsupported','retained unsupported'),artifactHash:'unsupported',artifactBytes:17});const all=await lane.search({query:'payload',scope:{project:'/synthetic',includeHistory:true},snapshotEpochs:readEpochs(db),limit:5});expect(all.state).toBe('building');expect(all.candidates.some(c=>c.ref.revisionId===unsupported.revisionId)).toBe(false);
  }finally{await worker.close();ready.mockRestore();db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
 it.each(['changed_context','wrong_space','wrong_policy','invalid_prior_recipe','nonfinite'])('rejects invalid prior payload reuse: %s',async(kind)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'span-v2-no-reuse-')),db=open({root}),encoder=fakeEncoder(),worker=new MaintenanceWorker(root,{db,encoder});const ready=vi.spyOn(assets,'inspectAssets').mockReturnValue({state:'ready'} as ReturnType<typeof assets.inspectAssets>);
  try{const old=insertV1(db,'reuse-invalid','exact stable payload');ensureSpanSpace(db);const prior=db.prepare('SELECT * FROM evidence_spans').get() as {span_id:string;embedding_input_hash:string;embedding_context_json:string};let space=assets.DEFAULT_SPACE_ID;
   if(kind==='wrong_space'){space='synthetic-wrong-space';db.prepare("INSERT INTO embedding_spaces SELECT ?,model_id,model_revision,model_asset_hash,tokenizer_hash,runtime_version,dtype,'cls',query_prefix,normalization,dimensions,chunk_policy,created_at,'retired' FROM embedding_spaces WHERE space_id=?").run(space,assets.DEFAULT_SPACE_ID);}
   if(kind==='wrong_policy')db.prepare("UPDATE evidence_spans SET chunk_policy='span-v1:wrong-tokenizer:record-context-v1' WHERE span_id=?").run(prior.span_id);
   if(kind==='invalid_prior_recipe'){const metadata=JSON.parse(prior.embedding_context_json);metadata.context+=' altered';db.prepare('UPDATE evidence_spans SET embedding_context_json=? WHERE span_id=?').run(JSON.stringify(metadata),prior.span_id);}
   const payload=vector();if(kind==='nonfinite')payload[0]=NaN;db.prepare('INSERT INTO span_embeddings VALUES(?,?,?,?,?,NULL)').run(prior.span_id,space,prior.embedding_input_hash,embeddingToBlob(payload),'2026-01-01T00:00:00.000Z');
   if(kind==='changed_context'){const p=parsedFixture('reuse-invalid','exact stable payload');p.records![0]!.project='/different';p.session.project='/different';publishSource(db,{parsed:p,artifactHash:hash('synthetic raw reuse-invalid'),artifactBytes:17,tokenizer});}else rebuildEvidenceSpans(db,{tokenizer});await worker.drainOnce();expect(encoder.encodeBatch).toHaveBeenCalled();expect((encoder.encodeBatch as ReturnType<typeof vi.fn>).mock.calls.every(call=>(call[0] as string[]).length<=2)).toBe(true);
  }finally{await worker.close();ready.mockRestore();db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
 it('blocks unsafe retained-normalization embedding/reuse without losing its historical debt',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'span-v2-private-')),db=open({root}),encoder=fakeEncoder(),worker=new MaintenanceWorker(root,{db,encoder});const ready=vi.spyOn(assets,'inspectAssets').mockReturnValue({state:'ready'} as ReturnType<typeof assets.inspectAssets>);
  try{insertV1(db,'private','--socket-auth fixture-sensitive-socket-credential','redacted-evidence-v2');rebuildEvidenceSpans(db,{tokenizer});
   const revisions=(db.prepare('SELECT revision_id FROM source_revisions ORDER BY revision_id').all() as {revision_id:string}[]).map(r=>r.revision_id);expect(revisions).toHaveLength(2);
   const debt=()=>db.prepare("SELECT target_revision_id,state,error_code FROM maintenance_jobs WHERE kind='embed' ORDER BY target_revision_id").all();
   await worker.drainOnce();expect(debt()).toEqual(revisions.map(target_revision_id=>({target_revision_id,state:'blocked',error_code:'privacy_refresh_required'})));
   expect(encoder.encodeBatch).not.toHaveBeenCalled();expect(encoder.encode).not.toHaveBeenCalled();expect(db.prepare('SELECT COUNT(*) n FROM span_embeddings').get()).toEqual({n:0});
   const prior=debt();await worker.drainOnce();expect(debt()).toEqual(prior);expect(encoder.encodeBatch).not.toHaveBeenCalled();expect(encoder.encode).not.toHaveBeenCalled();expect(db.prepare('SELECT COUNT(*) n FROM span_embeddings').get()).toEqual({n:0});
  }finally{await worker.close();ready.mockRestore();db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
});
describe.skipIf(!cache)('span-v2 unchanged-input capture pipeline',()=>{
 it('refreshes unchanged transcript bytes from genuine v1 and then skips through the public index path',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'span-v2-capture-')),claude=path.join(root,'claude'),dir=path.join(claude,'projects','synthetic'),id='11111111-1111-4111-8111-111111111111';fs.mkdirSync(dir,{recursive:true});fs.symlinkSync(cache!,path.join(root,'models'),'dir');const file=path.join(dir,id+'.jsonl'),raw=JSON.stringify({type:'user',uuid:'u',sessionId:id,cwd:'/synthetic',message:{role:'user',content:'UNCHANGED_CAPTURE_FACT42'}})+'\n';fs.writeFileSync(file,raw);const db=open({root});
  try{const parsed=await parseClaudeTranscript(file),old=insertV1(db,id,'',NORMALIZATION_VERSION,parsed,hash(raw));db.prepare('INSERT INTO capture_checkpoints VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL)').run(old.sourceId,hash(raw),hash(raw),old.revisionId,parsed.endOffset,parsed.continuation?.reopenOffset??0,hash(raw),JSON.stringify({...parsed.continuation,legacyMappingVersion:LEGACY_EXCHANGE_MAPPING_VERSION}),'2026-01-01T00:00:00.000Z');const first=await indexAll({db,root,claudeDir:claude,harnesses:['claude'],embed:false});expect(first.totals.failed).toBe(0);expect(first.totals.parsed).toBe(1);expect(listSourceSpans(db,old.sourceId).source!.revisionId).not.toBe(old.revisionId);const second=await indexAll({db,root,claudeDir:claude,harnesses:['claude'],embed:false});expect(second.totals.failed).toBe(0);expect(second.totals.parsed).toBe(0);expect(second.totals.skipped).toBe(1);expect(db.prepare('SELECT COUNT(*) n FROM source_activations').get()).toEqual({n:2});
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
 it('refreshes unchanged retained history bytes from v1 exactly once',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'span-v2-history-')),history=path.join(root,'history.jsonl'),raw=JSON.stringify({sessionId:'history-v1',display:'UNCHANGED_HISTORY_FACT42',project:'/synthetic'})+'\n';fs.writeFileSync(history,raw);const db=open({root});
  try{const key=hash(raw),p=parsedFixture('history-v1','UNCHANGED_HISTORY_FACT42');p.session.sourcePath=history;p.session.status='ghost';p.session.counts.bytes=Buffer.byteLength(raw);p.evidenceVersion='claude-history-records-v1';p.endOffset=Buffer.byteLength(raw);p.records![0]={unitKey:`ghost_prompt:${key}:0`,role:'ghost_prompt',text:'UNCHANGED_HISTORY_FACT42',eventAt:null,timeBasis:'unknown',project:'/synthetic',recordType:'history_prompt',locatorFidelity:'record_ordinal',locator:{recordKey:key,rawRecordHash:key,rawStart:0,rawEnd:Buffer.byteLength(raw),originalHistoryStart:0,originalHistoryEnd:Buffer.byteLength(raw),historyFormat:'claude',mapping:'record_container'}};const old=insertV1(db,'history-v1','',NORMALIZATION_VERSION,p,key);expect(captureHistoryEvidence(db,{root,harness:'claude',historyPath:history,tokenizer}).captured).toBe(1);expect(listSourceSpans(db,old.sourceId).source!.revisionId).not.toBe(old.revisionId);expect(captureHistoryEvidence(db,{root,harness:'claude',historyPath:history,tokenizer}).captured).toBe(0);expect(db.prepare('SELECT COUNT(*) n FROM source_activations').get()).toEqual({n:2});
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
});
describe('span-v2 retained authority checks',()=>{
 it('rejects invented retained units/provenance before publication',()=>{
  const db=open({file:':memory:'});try{const old=insertV1(db,'bound-retained','unchanged retained bytes'),base={artifactHash:hash('synthetic raw bound-retained'),artifactBytes:17,tokenizer,retainedRevisionId:old.revisionId,expectedActiveRevisionId:old.revisionId};const changed=parsedFixture('bound-retained','invented retained text');expect(()=>publishSource(db,{...base,parsed:changed})).toThrow('retained ordered units mismatch');expect(()=>publishSource(db,{...base,parsed:old.parsed,artifactHash:'invented'})).toThrow('retained revision provenance mismatch');expect(()=>publishSource(db,{...base,parsed:old.parsed,expectedActiveRevisionId:'stale'})).toThrow('retained revision provenance mismatch');expect(db.prepare('SELECT COUNT(*) n FROM source_revisions').get()).toEqual({n:1});expect(listSourceSpans(db,old.sourceId).source!.revisionId).toBe(old.revisionId);
  }finally{db.close();}
 });
 it('excludes tombstones and leaves alias conflicts unresolved',()=>{
  const db=open({file:':memory:'});try{const forgotten=insertV1(db,'forgotten-v1','must not resurrect'),conflict=insertV1(db,'conflicting-v1','ambiguous authority');db.prepare("INSERT INTO forget_tombstones VALUES(?,?,NULL,?,?,'complete','{}')").run('synthetic-tombstone',forgotten.sourceId,'synthetic-scope','2026-01-01T00:00:00.000Z');db.prepare("UPDATE memory_sources SET availability='conflict' WHERE source_id=?").run(conflict.sourceId);expect(rebuildEvidenceSpans(db,{tokenizer})).toEqual({rebuilt:0,remaining:1});expect(listSourceSpans(db,forgotten.sourceId).source).toBeNull();expect(listSourceSpans(db,conflict.sourceId).source!.revisionId).toBe(conflict.revisionId);expect(db.prepare('SELECT COUNT(*) n FROM source_revisions').get()).toEqual({n:2});
  }finally{db.close();}
 });
});
describe.skipIf(!cache)('span-v2 active enrolled discovery',()=>{
 it('refreshes unchanged v1 capture checkpoint through the worker and remains idempotent after restart',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'span-v2-discovery-')),claude=path.join(root,'claude'),dir=path.join(claude,'projects','synthetic'),id='22222222-2222-4222-8222-222222222222';fs.mkdirSync(dir,{recursive:true});fs.symlinkSync(cache!,path.join(root,'models'),'dir');const file=path.join(dir,id+'.jsonl'),raw=JSON.stringify({type:'user',uuid:'u',sessionId:id,cwd:'/synthetic',message:{role:'user',content:'DISCOVERY_POLICY_FACT42'}})+'\n';fs.writeFileSync(file,raw);const db=open({root}),encoder=fakeEncoder();let worker=new MaintenanceWorker(root,{db,encoder});const ready=vi.spyOn(assets,'inspectAssets').mockReturnValue({state:'ready'} as ReturnType<typeof assets.inspectAssets>);
  try{const parsed=await parseClaudeTranscript(file),old=insertV1(db,id,'',NORMALIZATION_VERSION,parsed,hash(raw));db.prepare('INSERT INTO capture_checkpoints VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL)').run(old.sourceId,hash(raw),hash(raw),old.revisionId,parsed.endOffset,parsed.continuation?.reopenOffset??0,hash(raw),JSON.stringify({...parsed.continuation,legacyMappingVersion:LEGACY_EXCHANGE_MAPPING_VERSION}),'2026-01-01T00:00:00.000Z');db.prepare('INSERT INTO sync_state VALUES(?,?,?)').run('memory:source-enrollment',JSON.stringify({version:1,harnesses:['claude'],options:{claudeDir:claude}}),'2026-01-01T00:00:00.000Z');await worker.drainOnce();expect(listSourceSpans(db,old.sourceId).source!.revisionId).not.toBe(old.revisionId);expect(db.prepare('SELECT COUNT(*) n FROM source_activations').get()).toEqual({n:2});const jobs=db.prepare('SELECT COUNT(*) n FROM maintenance_jobs').get();await worker.close();worker=new MaintenanceWorker(root,{db,encoder:fakeEncoder()});await worker.drainOnce();expect(db.prepare('SELECT COUNT(*) n FROM maintenance_jobs').get()).toEqual(jobs);expect(db.prepare('SELECT COUNT(*) n FROM source_activations').get()).toEqual({n:2});
  }finally{await worker.close();ready.mockRestore();db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
});
describe.skipIf(!cache)('span-v2 bounded independent target commits',()=>{
 it('commits9 distinct target memberships from one exact payload with batches bounded to2 spans',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'span-v2-batches-')),db=open({root}),encoder=fakeEncoder(),worker=new MaintenanceWorker(root,{db,encoder});const ready=vi.spyOn(assets,'inspectAssets').mockReturnValue({state:'ready'} as ReturnType<typeof assets.inspectAssets>);
  try{const p=parsedFixture('many-targets','identical exact payload');p.records=Array.from({length:9},(_,i)=>({...p.records![0]!,unitKey:'distinct-'+i,locator:{recordKey:'distinct-'+i,mapping:'unavailable' as const}}));publishSource(db,{parsed:p,artifactHash:'synthetic-nine',artifactBytes:17,tokenizer});await worker.drainOnce();expect(db.prepare('SELECT COUNT(*) spans,COUNT(DISTINCT embedding_input_hash) inputs FROM evidence_spans').get()).toMatchObject({spans:9,inputs:1});expect(db.prepare('SELECT COUNT(*) n FROM span_embeddings').get()).toEqual({n:9});expect(encoder.encodeBatch).toHaveBeenCalledTimes(1);expect((encoder.encodeBatch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toHaveLength(1);expect(db.prepare("SELECT COUNT(*) n FROM maintenance_jobs WHERE state<>'done'").get()).toEqual({n:0});
  }finally{await worker.close();ready.mockRestore();db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
});
