/**
 * `slopie audit` session.
 *
 *   discover files -> load opt-outs once -> reuse cached facts for unchanged
 *   files -> read the rest on a worker pool -> aggregate once -> snapshot.
 *
 * Original history is only ever read. The only thing written is the derived
 * cache under ~/.potsherd/audit-derived (or `derivedCacheDir`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as paths from '../paths.js';
import {readIgnoreConfig, isIgnoredProject} from '../ignore.js';
import {openDatabase} from '../sqlite-driver.js';
import {sourceId} from '../memory/source-identity.js';
import {NORMALIZATION_VERSION} from '../memory/privacy.js';
import {clock, digest} from './source.js';
import {extractFile, finishExternalFacts, parseHistory, readHistory, stripText, type HistoryData, type HistoryEntry, type NativeHarness, type SourceFacts} from './extract.js';
import {buildStoryTable} from './story-table.js';
import {buildStory} from './story.js';
import {DictionaryLookup} from './story-dictionary.js';
import {enrichStory} from './story-enrich.js';
import type {AuditProgressDetail, AuditStory} from './story-contracts.js';
import {aggregate, projectName, type Aggregate} from './aggregate.js';
import {PriceBook} from './pricing.js';
import {bundledModelCatalog} from './model-catalog.js';
import {cachedPublicCatalog, refreshPublicCatalog} from './catalog-service.js';
import {FactsCache} from './facts-cache.js';
import {inlineScanExecutor, type ScanExecutor, type ScanJob} from './scan-pool.js';
import {nativeAuditRoots} from './native-census.js';
import {extractOpenCodeDatabase, extractOpenCodeJson} from './opencode-facts.js';
import {DerivedCache} from './derived-cache.js';
import {requestedProjectFocus} from './project-focus.js';
import {summarizeDirectedLanguage} from './language-feedback.js';
import {attributeDirectLanguage, attributeLanguageTerms} from './language-models.js';
import {auditProfanity} from './profanity.js';
import {deterministicFindings} from './findings.js';
import {segmentContext, CONTEXT_SEGMENTATION_VERSION} from './contextual-native.js';
import {FreeJevProvider, FREE_JEV_MODEL, type FreeJevResponse} from './free-jev.js';
import {runLaunchSemantics, REQUESTED_USER_QUESTION_VERSION, selectedSegments, buildLaunchRequest} from './launch-semantics.js';
import {JevSessionRunner, type SemanticConversationInput} from './jev-session.js';
import type {ContextRecord, ContextSegment, LaunchAudit, LaunchFacts, LaunchSemantics, SemanticPeriod} from './launch-contracts.js';
import type {
  AuditCoverage, AuditEvent, AuditEvidence, AuditEvidenceRoute, AuditHarness, AuditMetric, AuditOverviewOptions, AuditProject,
  AuditPrompt, AuditPromptJudgment, AuditSemanticPreview, AuditSemanticSelection, AuditSemantics, AuditSession, AuditSnapshot,
  AuditSourceCapability,
} from './contracts.js';
export * from './contracts.js';
export {composeJevJudgments} from './jev-session.js';

const HARNESSES: AuditHarness[] = ['claude', 'codex', 'pi', 'opencode'];
const LAUNCH_ORDER: AuditHarness[] = ['codex', 'claude', 'opencode', 'pi'];
/** Appended tails up to this size are parsed on the main thread; bigger ones go to the pool. */
const RESUME_MAX_BYTES = 64 * 1024 * 1024;
const offline = () => process.env['POTSHERD_OFFLINE'] === '1';

const metric = (value: number | null, unit: string, basis: string, definition: string): AuditMetric =>
  ({value, numerator: value, denominator: null, unit, measurementBasis: basis, state: value === null ? 'unavailable' : 'observed', definition});
const routeKey = (route: AuditEvidenceRoute) => JSON.stringify(route);

/** Aggregate-only public representation: titles, identifiers, paths and excerpts are private detail. */
export function publicAuditSnapshot(snapshot: AuditSnapshot): AuditSnapshot {
  const launch = snapshot.launch;
  return structuredClone({
    ...snapshot,
    ...(launch ? {launch: {
      ...launch, languageLines: [],
      modelFeedback: launch.modelFeedback?.map(row => ({...row, promptIds: []})),
      languageByModel: launch.languageByModel?.map(row => ({...row, promptIds: []})),
      facts: launch.facts ? {...launch.facts, records: [], recordsIncluded: false} : null,
      ...(launch.story ? {story: publicStory(launch.story)} : {}),
      semantics: launch.semantics ? {...launch.semantics, stories: [], hallOfFame: [], judgments: []} : null,
    }} : {}),
    ...(snapshot.profanity ? {profanity: {...snapshot.profanity, matches: [], terms: []}} : {}),
    scope: {...snapshot.scope, project: snapshot.scope.project ? 'selected_project' : null},
    conversations: snapshot.conversations.map((c, i) => ({...c, nativeSessionId: `Conversation ${i + 1}`, title: null})),
    projects: snapshot.projects.map(p => ({...p, focus: p.focus?.map(f => ({...f, promptIds: [], evidenceRoutes: []})), path: null, displayName: p.alias})),
    phrases: [], judgments: [],
    insights: snapshot.insights.map(i => ({...i, caption: i.publicCaption})),
    warnings: snapshot.warnings.map(w => w.split(':')[0]!.slice(0, 96)),
  });
}

/** Cards whose chart labels are project names or typed words. */
const PRIVATE_CHARTS = new Set(['priciest_project', 'project_graveyard', 'continue_count', 'typo_fingerprint', 'day_night_topics']);

/** Story without quotes, project names or typed lines: cards use their number-only public wording. */
export function publicStory(story: AuditStory): AuditStory {
  const h = story.highlights;
  return {
    ...story,
    cards: story.cards.filter(c => c.public).map((c, i) => ({...c, headline: c.public!.headline, support: c.public!.support, quote: null, rank: i + 1,
      numbers: Object.fromEntries(Object.entries(c.numbers).filter(([k]) => !/project|cheapest|^top$|night_words|day_words|^typo$|correction|^pet$/.test(k) && !(c.id === 'typo_fingerprint' && k === 'word'))),
      chart: PRIVATE_CHARTS.has(c.id) ? {...c.chart, series: [], highlight: null} : c.chart})),
    projects: story.projects.map(p => ({...p, id: p.alias, name: null})),
    highlights: {
      ...h, mostTypedLine: null,
      mostExpensivePrompt: h.mostExpensivePrompt ? {...h.mostExpensivePrompt, quote: null, project: null} : null,
      firstPrompt: h.firstPrompt ? {...h.firstPrompt, quote: null} : null,
      latestPrompt: h.latestPrompt ? {...h.latestPrompt, quote: null} : null,
      gotAway: h.gotAway ? {...h.gotAway, project: null, lastWords: null} : null,
    },
    awards: story.awards.map(a => ({...a, receipt: a.publicReceipt})),
    coldOpen: null,
  };
}

export function createAuditSession(options: AuditOverviewOptions = {}): AuditSession {
  return new LocalAuditSession(options);
}

/* ------------------------------------------------------------ discovery --- */

interface Discovered {
  jobs: ScanJob[];
  opencodeDatabases: string[];
  opencodeJson: string[];
  historyFile: string | null;
  census: Map<AuditHarness, {files: number; bytes: number; roots: number}>;
}

function listFiles(root: string, accept: (file: string) => boolean): string[] {
  let names: string[];
  try { names = fs.readdirSync(root, {recursive: true}) as string[]; } catch { return []; }
  const out: string[] = [];
  for (const name of names) { const file = path.join(root, name); if (accept(file)) out.push(file); }
  return out;
}

function discover(harnesses: readonly AuditHarness[], options: AuditOverviewOptions, onHarness?: (harness: AuditHarness, row: {files: number; bytes: number}) => void): Discovered {
  const result: Discovered = {jobs: [], opencodeDatabases: [], opencodeJson: [], historyFile: null, census: new Map()};
  const seen = new Set<string>();
  for (const harness of harnesses) {
    const roots = nativeAuditRoots(harness, options);
    const row = {files: 0, bytes: 0, roots: roots.length};
    result.census.set(harness, row);
    const relSeen = new Set<string>();
    for (const root of roots) {
      if (harness === 'opencode') {
        for (const file of listFiles(root, f => /\.(?:db|sqlite|sqlite3)$/i.test(f) || (f.endsWith('.json') && /[\\/]storage[\\/](?:session|message|part)[\\/]/.test(f)))) {
          let size = 0;
          try { size = fs.statSync(file).size; } catch { continue; }
          row.files++; row.bytes += size;
          (file.endsWith('.json') ? result.opencodeJson : result.opencodeDatabases).push(file);
        }
        continue;
      }
      if (harness === 'claude' && !result.historyFile) {
        const history = path.join(path.dirname(root), 'history.jsonl');
        if (fs.existsSync(history)) result.historyFile = history;
      }
      for (const file of listFiles(root, f => f.endsWith('.jsonl') && (harness !== 'codex' || path.basename(f).startsWith('rollout-')))) {
        if (seen.has(file)) continue;
        seen.add(file);
        // Codex: the same rollout in sessions/ and archived_sessions/ is one session.
        if (harness === 'codex') { const rel = path.relative(root, file); if (relSeen.has(rel)) continue; relSeen.add(rel); }
        let stat: fs.Stats;
        try { stat = fs.statSync(file); } catch { continue; }
        if (!stat.isFile()) continue;
        row.files++; row.bytes += stat.size;
        result.jobs.push({file, harness: harness as NativeHarness, size: stat.size, mtimeMs: stat.mtimeMs} as ScanJob & {mtimeMs: number});
      }
    }
    onHarness?.(harness, row);
  }
  return result;
}

/* --------------------------------------------------------------- policy --- */

interface Policy {
  ignoredList: string[];
  forgotten: Set<string>;
  ignored(project: string | null): boolean;
  error: string | null;
}

/** Opt-outs, read once: the `slopie ignore` list and the sources the user asked potsherd to forget. */
function loadPolicy(root: string): Policy {
  const policy: Policy = {ignoredList: [], forgotten: new Set(), ignored: () => false, error: null};
  const config = readIgnoreConfig(root);
  if (config.error) policy.error = 'ignore_policy_unreadable';
  policy.ignoredList = config.list;
  if (config.list.length) policy.ignored = project => !!project && isIgnoredProject(project, config.list);
  const dbFile = paths.dbPath(root);
  if (fs.existsSync(dbFile)) {
    try {
      const db = openDatabase(dbFile, {readonly: true, fileMustExist: true});
      try {
        const rows = db.prepare(`SELECT source_id FROM memory_sources WHERE availability='forgotten'
          UNION SELECT source_id FROM forget_tombstones WHERE state<>'reversed' AND source_id IS NOT NULL`).all() as {source_id: string}[];
        for (const row of rows) policy.forgotten.add(row.source_id);
      } finally {
        db.close();
      }
    } catch {
      policy.error ??= 'forget_list_unreadable';
    }
  }
  return policy;
}

/** Parses only what was appended to a file since its facts were cached; null means "read it in full". */
function resumeFacts(previous: SourceFacts, job: ScanJob, timezone: string): SourceFacts | null {
  try { return stripText(extractFile(job.file, job.harness, {timezone}, previous)); } catch { return null; }
}

function codexFastDefault(options: AuditOverviewOptions): boolean {
  const home = options.codexDir ?? process.env['POTSHERD_CODEX_DIR'] ?? process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
  try {
    for (const line of fs.readFileSync(path.join(home.split(',')[0]!.trim(), 'config.toml'), 'utf8').split('\n')) {
      const m = /^\s*service_tier\s*=\s*["']?([\w-]+)/.exec(line.split('#')[0]!);
      if (m) return m[1] === 'priority' || m[1] === 'fast';
    }
  } catch { /* no config */ }
  return false;
}

/* -------------------------------------------------------------- session --- */

class LocalAuditSession implements AuditSession {
  private readonly controller = new AbortController();
  private readonly id: string;
  private current: AuditSnapshot;
  private sequence = 0;
  private started = false;
  private disposed = false;
  private callback: ((event: AuditEvent) => void) | undefined;
  private readonly root: string;
  private readonly derived: DerivedCache | null;
  private readonly book: PriceBook;
  private readonly catalog: typeof bundledModelCatalog;
  private policy: Policy | null = null;
  private result: Aggregate | null = null;
  private readonly routes = new Map<string, AuditPrompt>();
  private launchSegments: ContextSegment[] = [];
  private launchRunning = false;
  private semanticReservedTokens = 0;
  private readonly semanticRunner = new JevSessionRunner();
  private readonly timings: Record<string, number> = {};

  constructor(private readonly options: AuditOverviewOptions) {
    this.id = options.sessionIdentity ?? randomUUID();
    const harnesses = options.harnesses ? [...new Set(options.harnesses)] : options.launch ? LAUNCH_ORDER : HARNESSES;
    if (!harnesses.every(h => HARNESSES.includes(h))) throw new Error('unsupported audit harness');
    const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat('en-US', {timeZone: timezone}).format();
    const from = options.since ? clock(options.since) : null, to = options.until ? clock(options.until) : null;
    if ((options.since && !from) || (options.until && !to) || (from && to && from > to)) throw new Error('invalid audit event range');
    this.root = paths.potsherdDir(options.potsherdDir);
    const derivedDir = options.derivedCacheDir ?? path.join(this.root, 'audit-derived');
    this.derived = options.launch ? new DerivedCache(derivedDir) : null;
    this.catalog = this.derived ? cachedPublicCatalog(this.derived) : bundledModelCatalog;
    this.book = new PriceBook(this.catalog);
    options.signal?.addEventListener('abort', () => this.cancel(), {once: true});
    this.current = {
      schemaVersion: 'audit-v1', snapshotId: this.id, sequence: 0, measuredAt: new Date().toISOString(),
      scope: {harnesses, project: options.project ? path.resolve(options.project) : null, eventFrom: from, asOf: to, timezone},
      status: 'discovering',
      coverage: {state: 'complete_snapshot', knownSources: 0, parsedSources: 0, unknownOriginEvents: 0, excludedEvents: 0, omittedSources: 0, gapCodes: []},
      progress: {stage: 'discovering', completed: 0, total: null, unit: 'candidate_source', provisional: true, cancellable: true, label: 'Finding history'},
      metrics: {
        conversations: metric(null, 'top_level_conversation', 'native_session_id', 'Distinct top-level conversations'),
        humanPrompts: metric(null, 'human_prompt', 'typed_user_message', 'Messages a person typed'),
        projects: metric(null, 'project', 'working_directory', 'Projects with at least one human prompt'),
        linkedChildren: metric(null, 'subagent_conversation', 'declared_parent', 'Subagent and helper conversations'),
      },
      sources: harnesses.map(harness => ({
        harness, state: 'checking', candidateFiles: 0, conversations: 0, humanPrompts: null, humanOrigin: 'native_marker',
        evidence: 'unavailable', usage: 'unavailable', firstUnsupportedStep: null, gapCodes: [],
      })),
      projects: [], activity: [], conversations: [], insights: [],
      usage: {state: 'unavailable', inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null, costUsd: null, measurementBasis: null, inclusion: null, priceVersion: null},
      ...(options.launch ? {launch: {facts: null, semantics: null, stage: 'discovering' as const,
        notice: offline() ? 'Offline audit. Conversation text stays on this machine; no analysis requests will be made. Esc cancels.'
          : 'Conversation text is redacted locally. OpenCode Zen and TypeSafe/Jev receive selected conversations for free analysis. Esc cancels.'}} : {}),
      semantics: {state: 'not_run', qualified: false, model: null, classifiedPrompts: 0, eligiblePrompts: 0, uncertainPrompts: 0, work: [], requestCount: 0, cacheHits: 0, estimatedCostUsd: null, reportedCostUsd: null, unresolvedCostUsd: null, errorCode: null},
      warnings: [], sourceEpochs: null,
    };
    if (options.signal?.aborted) this.cancel();
  }

  snapshot(): AuditSnapshot { return this.current; }

  cancel(): void {
    this.controller.abort();
    this.semanticRunner.invalidate();
    void this.options.nativeScanExecutor?.close();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.routes.clear();
    this.result = null;
    this.launchSegments = [];
    this.semanticRunner.dispose();
  }

  private assertOpen(): void { if (this.disposed) throw new Error('audit_session_disposed'); }

  private publish(patch: Partial<AuditSnapshot>, progressOnly = false): void {
    this.current = {...this.current, ...patch, sequence: ++this.sequence};
    this.callback?.({type: 'progress', snapshotId: this.id, sequence: this.sequence, progress: this.current.progress, sources: this.current.sources});
    if (!progressOnly) this.callback?.({type: 'snapshot', snapshot: this.current});
  }

  private progress(stage: AuditSnapshot['status'], label: string, completed: number, total: number | null): void {
    const detail = this.detail ? {...this.detail, harnesses: this.detail.harnesses.map(h => ({...h})), counts: {...this.detail.counts}, elapsedMs: Math.round(performance.now() - this.t0)} : undefined;
    this.publish({status: stage, progress: {stage, label, completed, total, unit: 'candidate_source', provisional: true, cancellable: true, ...(detail ? {detail} : {})}}, true);
  }

  async run(onEvent?: (event: AuditEvent) => void): Promise<AuditSnapshot> {
    this.assertOpen();
    if (this.started) throw new Error('audit_session_already_run');
    this.started = true;
    this.callback = onEvent;
    const t0 = performance.now();
    this.t0 = t0;
    const lap = (name: string, since: number) => { this.timings[name] = Math.round(performance.now() - since); return performance.now(); };
    try {
      this.publish({});
      let t = performance.now();
      const harnesses = this.current.scope.harnesses;
      const tz = this.current.scope.timezone;
      this.detail = {
        stage: 'discovering',
        harnesses: harnesses.map(h => ({harness: h, files: 0, bytes: 0, filesDone: 0, firstAt: null, lastAt: null, discovered: false, absent: false, chats: 0, prompts: 0})),
        counts: {files: 0, filesDone: 0, bytes: 0, bytesDone: 0, messages: 0, chats: 0, prompts: 0}, elapsedMs: 0,
      };
      // One progress event per harness as soon as its roots are listed, so the loading story lights rows up one by one.
      const found = discover(harnesses, this.options, (harness, row) => {
        if (!this.detail) return;
        this.detail = {...this.detail, harnesses: this.detail.harnesses.map(h => h.harness === harness ? {...h, files: row.files, bytes: row.bytes, discovered: true, absent: row.files === 0} : h),
          counts: {...this.detail.counts, files: this.detail.counts.files + row.files, bytes: this.detail.counts.bytes + row.bytes}};
        this.progress('discovering', 'Finding your agents', 0, null);
      });
      t = lap('discoverMs', t);
      this.policy = loadPolicy(this.root);
      t = lap('policyMs', t);
      const cache = new FactsCache(this.derived ? this.derived.directory : null);
      cache.load();
      this.cache = cache;
      t = lap('cacheLoadMs', t);
      this.detail = {...this.detail, stage: 'reading'};
      this.publish({sources: this.current.sources.map(s => {
        const c = found.census.get(s.harness)!;
        return {...s, state: c.files ? 'available' : 'absent', candidateFiles: c.files,
          census: {checked: true, files: c.files, bytes: c.bytes, roots: c.roots, unit: s.harness === 'opencode' && found.opencodeDatabases.length ? 'database' : 'file'}};
      })}, true);

      // ---- cached facts first; appended files resume from their old end; read the rest
      const facts: SourceFacts[] = [];
      const toRead: ScanJob[] = [];
      const resumable: {job: ScanJob & {mtimeMs: number}; previous: SourceFacts}[] = [];
      for (const job of found.jobs as (ScanJob & {mtimeMs: number})[]) {
        const hit = cache.get(job.file, job.size, job.mtimeMs, tz);
        if (hit) { facts.push(hit); this.count(hit, job.size); continue; }
        const previous = cache.previous(job.file);
        if (previous?.resume && previous.tz === tz && previous.size < job.size && job.size - previous.size <= RESUME_MAX_BYTES) resumable.push({job, previous});
        else toRead.push({file: job.file, harness: job.harness, size: job.size, timezone: tz});
      }
      const cacheHits = facts.length, total = found.jobs.length;
      const failures: string[] = [];
      this.progress('parsing', 'Reading history', cacheHits, total);
      let scanning: Promise<void> = Promise.resolve();
      const readOne = (job: ScanJob) => { toRead.push(job); };
      // Appended JSONL: parse only the new tail on this thread (falls back to a full read on any mismatch).
      let resumed = 0;
      for (const {job, previous} of resumable) {
        const merged = resumeFacts(previous, job, tz);
        if (merged) { facts.push(merged); cache.set(merged); this.count(merged, job.size); resumed++; } else readOne({file: job.file, harness: job.harness, size: job.size, timezone: tz});
      }
      this.timings['filesResumed'] = resumed;
      if (toRead.length && !this.controller.signal.aborted) {
        const executor = this.options.nativeScanExecutor ?? inlineScanExecutor;
        scanning = executor.scan(toRead, result => {
          if ('facts' in result) { facts.push(result.facts); cache.set(result.facts); this.count(result.facts, result.job.size); } else { failures.push(result.error); this.count(null, result.job.size); }
          this.tick(facts.length + failures.length, total);
        }, this.controller.signal);
      }
      // While worker threads read, this thread handles OpenCode (read in place,
      // read-only) and Claude's typed-prompt log.
      const extra: SourceFacts[] = [];
      for (const file of found.opencodeDatabases) {
        try { extra.push(...extractOpenCodeDatabase(file).map(f => stripText(finishExternalFacts(f, {timezone: tz})))); } catch { failures.push('opencode_database_unreadable'); }
      }
      if (found.opencodeJson.length) {
        try { extra.push(...extractOpenCodeJson(found.opencodeJson).map(f => stripText(finishExternalFacts(f, {timezone: tz})))); } catch { failures.push('opencode_storage_unreadable'); }
      }
      for (const f of extra) this.count(f, 0);
      const historyData: HistoryData = found.historyFile && harnesses.includes('claude')
        ? cache.history(found.historyFile, tz, (file, previous) => readHistory(file, {timezone: tz}, previous)) : {entries: [], counters: new Map()};
      this.historyData = historyData;
      if (this.detail && historyData.entries.length) {
        // Claude's typed-prompt log reaches back further than surviving transcripts.
        let first: number | null = null, last: number | null = null;
        for (const e of historyData.entries) if (e.at !== null) { if (first === null || e.at < first) first = e.at; if (last === null || e.at > last) last = e.at; }
        this.detail = {...this.detail, harnesses: this.detail.harnesses.map(h => h.harness !== 'claude' || first === null ? h : {...h,
          firstAt: !h.firstAt || new Date(first).toISOString() < h.firstAt ? new Date(first).toISOString() : h.firstAt,
          lastAt: !h.lastAt || new Date(last!).toISOString() > h.lastAt ? new Date(last!).toISOString() : h.lastAt})};
      }
      const history: HistoryEntry[] = historyData.entries;
      // A cold cache has no dictionary memo: load the word lists while the workers are still reading.
      this.dictionary = new DictionaryLookup(cache.dictionary);
      if (this.options.launch && toRead.length > 8 && cache.dictionary.size === 0) this.dictionary.preload();
      t = lap('extrasMs', t);
      await scanning;
      facts.push(...extra);
      t = lap('scanMs', t);
      this.timings['filesRead'] = toRead.length;
      this.timings['filesCached'] = cacheHits;

      if (this.controller.signal.aborted) return this.finishCancelled();

      // ---- aggregate once
      this.setStage('aggregating');
      const scope = this.current.scope;
      const policy = this.policy;
      this.historyFile = found.historyFile;
      this.result = aggregate({
        sources: facts, history, historyFile: found.historyFile,
        scope: {harnesses, project: scope.project, eventFrom: scope.eventFrom ? Date.parse(scope.eventFrom) : null, asOf: scope.asOf ? Date.parse(scope.asOf) : null, timezone: scope.timezone},
        policy: {ignored: policy.ignored, forgotten: policy.forgotten},
        book: this.book, codexFastDefault: codexFastDefault(this.options), snapshotId: this.id,
      });
      t = lap('aggregateMs', t);
      this.buildSnapshot(this.result, {cacheHits, total, failures, policyError: policy.error});
      t = lap('languageMs', t);

      // Never keep opted-out sources in the cache.
      cache.save(f => fs.existsSync(f.file) && !policy.forgotten.has(sourceId(f.harness, f.sessionId)) && !(f.parentId && policy.forgotten.has(sourceId(f.harness, f.parentId))) && !policy.ignored(f.project),
        h => !policy.ignored(h.project) && !(h.sessionId && policy.forgotten.has(sourceId('claude', h.sessionId))));
      lap('cacheWriteMs', t);
      this.timings['totalMs'] = Math.round(performance.now() - t0);
      const memory = process.memoryUsage();
      this.timings['heapMB'] = Math.round(memory.heapUsed / 1048576);
      this.timings['rssMB'] = Math.round(memory.rss / 1048576);
      this.publish({timings: {...this.timings}});

      if (this.options.launch && !this.controller.signal.aborted) {
        if (!offline() && !this.options.launchPrepareOnly) void refreshPublicCatalog(this.derived, this.catalog, this.controller.signal);
        this.launchRunning = true;
        try { await Promise.all([this.runSemantics(), this.runEnrichment()]); } finally { this.launchRunning = false; }
      }
      return this.current;
    } finally {
      await this.options.nativeScanExecutor?.close();
      this.callback = undefined;
    }
  }

  /* ------------------------------------------------- progress detail --- */

  private t0 = 0;
  private detail: AuditProgressDetail | null = null;
  private lastTick = 0;
  private cache: FactsCache | null = null;
  private historyData: HistoryData | null = null;
  private historyFile: string | null = null;
  private dictionary: DictionaryLookup | null = null;

  /** Running counts for the loading story (cheap: a few additions per file). */
  private count(f: SourceFacts | null, bytes: number): void {
    const d = this.detail;
    if (!d) return;
    const c = d.counts as {-readonly [K in keyof AuditProgressDetail['counts']]: number};
    c.filesDone++; c.bytesDone += bytes;
    if (!f) return;
    const row = d.harnesses.find(h => h.harness === f.harness) as {-readonly [K in keyof AuditProgressDetail['harnesses'][number]]: AuditProgressDetail['harnesses'][number][K]} | undefined;
    if (row) {
      row.filesDone++;
      if (f.firstAt !== null) { const iso = new Date(f.firstAt).toISOString(); if (!row.firstAt || iso < row.firstAt) row.firstAt = iso; }
      if (f.lastAt !== null) { const iso = new Date(f.lastAt).toISOString(); if (!row.lastAt || iso > row.lastAt) row.lastAt = iso; }
    }
    c.messages += f.usage.length + f.prompts.length;
    const chat = f.child ? 0 : f.harness === 'claude' ? (f.sessionIds?.length ? 1 : 0) : 1;
    let human = 0;
    for (const p of f.prompts) if (p.kind === 'human') human++;
    c.chats += chat; c.prompts += human;
    if (row) { row.chats += chat; row.prompts += human; }
  }

  /** Throttled progress event (≤20/s). */
  private tick(completed: number, total: number, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastTick < 50) return;
    this.lastTick = now;
    this.progress('parsing', 'Reading history', completed, total);
  }

  private setStage(stage: AuditProgressDetail['stage']): void {
    if (!this.detail) return;
    this.detail = {...this.detail, stage};
    this.progress(this.current.status === 'discovering' ? 'parsing' : this.current.status, stage === 'aggregating' ? 'Counting' : stage === 'detecting' ? 'Noticing patterns' : this.current.progress.label ?? 'Reading history', this.current.progress.completed, this.current.progress.total);
  }

  private finishCancelled(): AuditSnapshot {
    this.publish({status: 'cancelled', progress: {...this.current.progress, stage: 'cancelled', provisional: false, cancellable: false},
      ...(this.current.launch ? {launch: {...this.current.launch, stage: 'ready' as const}} : {})});
    return this.current;
  }

  /** Builds the full snapshot from one aggregate. */
  private buildSnapshot(a: Aggregate, run: {cacheHits: number; total: number; failures: string[]; policyError: string | null}): void {
    const scope = this.current.scope;
    this.routes.clear();
    for (const p of a.prompts) this.routes.set(routeKey(p.route), p);
    const prompts = a.prompts;

    // ---- language and lexical findings on human prompts only
    let t = performance.now();
    const lap = (name: string) => { this.timings[name] = Math.round(performance.now() - t); t = performance.now(); };
    const records = this.contextRecords(a, false);
    const profanity = auditProfanity(prompts, false);
    lap('profanityMs');
    const language = summarizeDirectedLanguage(prompts, records);
    lap('languageLinesMs');
    const findings = deterministicFindings(a.conversations.map(c => c.conversation), prompts, scope.timezone, false, digest(JSON.stringify(scope)));
    lap('findingsMs');

    const promptsByProject = new Map<string, AuditPrompt[]>();
    for (const p of prompts) { const key = p.project ?? '(unknown)'; const list = promptsByProject.get(key) ?? []; list.push(p); promptsByProject.set(key, list); }
    const human = prompts.length;
    const projects: AuditProject[] = a.projects.map((p, i) => ({
      id: p.id, alias: `Project ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`,
      displayName: p.path === '(unknown)' ? 'Unknown project' : projectName(p.path), path: p.path === '(unknown)' ? null : p.path,
      humanPrompts: p.humanPrompts, nativeUserInputs: p.humanPrompts, conversations: p.conversations, share: human ? p.humanPrompts / human : null,
      ...(this.options.launch ? {focus: requestedProjectFocus(promptsByProject.get(p.path) ?? [])} : {}),
    }));
    lap('focusMs');

    const sources: AuditSourceCapability[] = this.current.sources.map(s => {
      const h = a.harness[s.harness];
      const hasData = h.files > 0 || h.conversations > 0;
      return {
        ...s, state: hasData ? 'available' : s.candidateFiles ? 'available' : 'absent',
        conversations: h.conversations, humanPrompts: h.humanPrompts, humanOrigin: 'native_marker',
        evidence: hasData ? 'transient' : 'unavailable', usage: h.responses ? 'reported' : 'unavailable',
        firstUnsupportedStep: null, gapCodes: [],
        childConversations: h.childConversations, slashCommands: h.slashCommands, userMessages: h.userMessages,
        responses: h.responses, costUsd: h.costUsd, excluded: h.excluded,
      } as AuditSourceCapability;
    });

    const failures = [...new Set(run.failures)];
    const warnings = [...failures.map(code => `unreadable_source:${code}`), ...(run.policyError ? [run.policyError] : []),
      ...(a.estimatedCostUsd > 0 ? ['estimated_prices'] : [])];
    const coverage: AuditCoverage = {
      state: failures.length ? 'partial' : 'complete_snapshot', knownSources: run.total, parsedSources: run.total - run.failures.length,
      unknownOriginEvents: 0, excludedEvents: Object.values(a.harness).reduce((n, h) => n + Object.values(h.excluded).reduce((x, y) => x + y, 0), 0),
      omittedSources: run.failures.length, gapCodes: failures,
    };
    const userMessages = Object.values(a.harness).reduce((n, h) => n + h.userMessages, 0);
    const facts = this.launchFacts(a);
    let story: AuditStory | undefined;
    if (this.current.launch) {
      if (this.detail) this.detail = {...this.detail, stage: 'detecting', counts: {...this.detail.counts, messages: a.responses + userMessages, chats: a.topLevelConversations, prompts: human},
        harnesses: this.detail.harnesses.map(h => ({...h, chats: a.harness[h.harness].conversations, prompts: a.harness[h.harness].humanPrompts}))};
      const aliases = new Map(projects.map(p => [p.path ?? '(unknown)', p.alias]));
      const policy = this.policy;
      const ts = performance.now();
      const table = buildStoryTable({
        aggregate: a, history: this.historyData?.entries ?? [], historyCounters: this.historyData?.counters ?? new Map(), historyFile: this.historyFile, timezone: scope.timezone,
        allowed: (project, session) => !policy?.ignored(project) && !(session && policy?.forgotten.has(sourceId('claude', session))) && (scope.project === null || project === scope.project),
      });
      this.timings['storyTableMs'] = Math.round(performance.now() - ts);
      const dictionary = this.dictionary ?? new DictionaryLookup(this.cache?.dictionary);
      const built = buildStory({table, timezone: scope.timezone, alias: p => aliases.get(p ?? '(unknown)') ?? 'a project', dictionary, tokens: a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheWrite, offline: offline()});
      story = built.story;
      story.timings.featuresMs = this.timings['storyTableMs'];
      this.timings['detectorsMs'] = Math.round(built.detectorsMs);
      this.timings['dictionaryLoaded'] = dictionary.loaded ? 1 : 0;
      this.storyRows = table.rows;
      lap('storyMs');
    }
    const launch: LaunchAudit | undefined = this.current.launch ? {
      ...this.current.launch, stage: 'preparing', facts, ...(story ? {story} : {}),
      factProgress: {state: 'complete', completedSources: run.total - run.failures.length, totalSources: run.total, representedSources: run.total - run.failures.length,
        cacheHits: run.cacheHits, coverage: 'completed_sources', origin: run.cacheHits === 0 ? 'fresh' : run.cacheHits === run.total ? 'cache' : 'mixed'},
      ...language,
      languageByModel: attributeDirectLanguage(profanity, records, prompts),
    } : undefined;
    const terms = attributeLanguageTerms(profanity, records, prompts);
    lap('attributionMs');
    const status = failures.length ? 'partial' : 'ready';
    this.publish({
      status, measuredAt: new Date().toISOString(), coverage,
      progress: {stage: status, label: 'Local facts ready', completed: run.total, total: run.total, unit: 'candidate_source', provisional: false, cancellable: false,
        ...(this.detail ? {detail: {...this.detail, stage: 'ready' as const, elapsedMs: Math.round(performance.now() - this.t0)}} : {})},
      sources, projects, activity: a.activity, conversations: a.conversations.map(c => c.conversation),
      metrics: {
        conversations: metric(a.topLevelConversations, 'top_level_conversation', 'native_session_id',
          'Distinct top-level conversations, including Claude sessions known only from ~/.claude/history.jsonl'),
        humanPrompts: metric(human, 'human_prompt', 'typed_user_message',
          'Messages a person typed. Excludes tool results, injected context, task notifications, slash commands, compaction summaries, subagent and headless (-p/exec) prompts.'),
        projects: metric(projects.length, 'project', 'working_directory', 'Projects with at least one human prompt'),
        linkedChildren: metric(a.childConversations, 'subagent_conversation', 'declared_parent', 'Subagent and helper conversations'),
        nativeUserInputs: metric(userMessages, 'user_role_message', 'user_role', 'Every user-role message that is not a tool result, including injected and automated ones'),
      },
      usage: {
        state: a.responses ? 'observed' : 'unavailable', inputTokens: a.tokens.input, outputTokens: a.tokens.output,
        cacheTokens: a.tokens.cacheRead + a.tokens.cacheWrite, reasoningTokens: a.tokens.reasoning, costUsd: a.costUsd,
        cacheReadTokens: a.tokens.cacheRead, cacheWriteTokens: a.tokens.cacheWrite,
        measurementBasis: 'deduplicated_response_usage', inclusion: 'inputTokens are uncached; cacheTokens = cache read + cache write; output includes reasoning',
        priceVersion: this.catalog.basis.sha256,
      } as AuditSnapshot['usage'],
      insights: findings.insights, phrases: findings.phrases,
      profanity: terms,
      semantics: {...this.current.semantics, eligiblePrompts: human},
      commitment: digest(JSON.stringify(a.conversations.map(c => [c.conversation.id, c.prompts.length]))),
      warnings, ...(launch ? {launch} : {}),
      funnel: {
        nativeFilesDiscovered: run.total, nativeFilesParsed: run.total - run.failures.length, retainedSources: 0,
        selectedSources: a.conversations.length, responsesObserved: a.responses, responsesDeduplicated: 0, responsesExcluded: 0,
        responsesPriced: a.responses, excludedReasons: {forgotten_or_ignored_source: a.excludedSources}, gaps: failures,
      },
    });
  }

  private storyRows: import('./story-table.js').StoryRow[] = [];

  private launchFacts(a: Aggregate): LaunchFacts {
    const favourite = a.models.filter(m => m.favouriteScore !== null).sort((x, y) => (y.favouriteScore ?? 0) - (x.favouriteScore ?? 0))[0] ?? null;
    const models = a.models;
    const costByHarness = Object.fromEntries(Object.entries(a.harness).filter(([, h]) => h.responses).map(([k, h]) => [k, h.costUsd]));
    return {
      records: [], recordsIncluded: false, models, favourite: favourite ? models.find(m => m.id === favourite.id)! : null,
      valueUsd: a.costUsd, referenceValueUsd: null, pricing: this.catalog.basis,
      recordedResponses: a.responses, knownTokenResponses: a.responses, pricedResponses: a.responses,
      referencePricedResponses: 0, equivalentPricedResponses: a.responses, referenceProviders: [],
      unknownModelResponses: a.inferredModelResponses,
      gaps: a.estimatedCostUsd > 0 ? ['price_estimated_from_model_family'] : [],
      costByHarness, estimatedValueUsd: a.estimatedCostUsd, compactionResponses: a.compactionResponses,
      cacheReadTokens: a.tokens.cacheRead, cacheWriteTokens: a.tokens.cacheWrite,
    } as LaunchFacts;
  }

  /** Per-conversation sequence of (model before, prompt, model after) used for attribution and segmentation. */
  private contextRecords(a: Aggregate, withText: boolean): ContextRecord[] {
    const out: ContextRecord[] = [];
    for (const c of a.conversations) {
      const conv = c.conversation;
      const ordered = [...c.prompts].sort((x, y) => (x.eventAt ?? '').localeCompare(y.eventAt ?? ''));
      for (const p of ordered) {
        const around = a.around.get(p.id);
        const base = {conversationId: conv.id, parentId: conv.parentId, harness: conv.harness, eventAt: p.eventAt, project: p.project ?? null, route: null, directUser: false};
        if (around?.before) out.push({...base, id: `${p.id}:before`, role: 'assistant', text: '', model: around.before, provider: around.beforeProvider});
        out.push({...base, id: p.id, role: 'user', text: withText ? p.text : '', model: null, provider: null, directUser: !conv.child, route: withText ? p.route : null});
        if (around?.after) out.push({...base, id: `${p.id}:after`, role: 'assistant', text: '', model: around.after, provider: around.afterProvider});
      }
    }
    return out;
  }

  /* ------------------------------------------------- story enrichment --- */

  /** Online only: lets the free Jev model choose persona/peak-time wording. Never blocks the board. */
  private async runEnrichment(): Promise<void> {
    const launch = this.current.launch;
    if (!launch?.story || offline() || this.options.launchPrepareOnly) return;
    const recipients = ['OpenCode Zen', 'TypeSafe/Jev'];
    const provider = new FreeJevProvider({
      route: {kind: 'zen-public'}, timeoutMs: 8000,
      beforeDispatch: async ({model, attempt}) => {
        const notice = 'Persona wording: aggregated numbers and up to 8 short, filtered quotes go to OpenCode Zen and TypeSafe/Jev. No prompts are sent.';
        const event: Extract<AuditEvent, {type: 'transfer'}> = {type: 'transfer', snapshotId: this.id, sequence: ++this.sequence, model, recipients, attempt, selectedSegments: 0, notice};
        if (this.options.onTransfer) await this.options.onTransfer(event); else this.callback?.(event);
        if (this.controller.signal.aborted) throw new Error('cancelled');
      },
    });
    const pending = {...launch.story, enrichment: {...launch.story.enrichment, state: 'pending' as const}};
    this.current = {...this.current, launch: {...this.current.launch!, story: pending}};
    const result = await enrichStory(pending, this.storyRows, provider, {signal: this.controller.signal, isCurrent: () => !this.controller.signal.aborted});
    if (this.controller.signal.aborted || !this.current.launch) return;
    this.publish({launch: {...this.current.launch, story: {...result.story, enrichment: result.state}}});
  }

  /* ----------------------------------------------------- text on demand --- */

  /**
   * The cache keeps no prompt text. Detail views and online analysis read it
   * back from the original files (read-only) for just the prompts they need.
   */
  private rehydrate(prompts: readonly AuditPrompt[]): void {
    const byFile = new Map<string, AuditPrompt[]>();
    for (const p of prompts) {
      if (p.text || p.route.basis !== 'transient_snapshot') continue;
      const list = byFile.get(p.route.sourcePath) ?? [];
      list.push(p);
      byFile.set(p.route.sourcePath, list);
    }
    const tz = this.current.scope.timezone;
    for (const [file, list] of byFile) {
      try {
        const texts = new Map<string, string>();
        if (file === this.historyFile) {
          parseHistory(fs.readFileSync(file, 'utf8'), {timezone: tz}).entries.forEach((e, i) => { if (e.kind === 'human') texts.set(`history:${i}`, e.text); });
        } else {
          const conv = this.result?.conversations.find(c => c.file === file);
          const harness = (conv?.conversation.harness ?? (file.includes(`${path.sep}.codex${path.sep}`) || path.basename(file).startsWith('rollout-') ? 'codex' : 'claude')) as NativeHarness;
          if (harness === 'opencode' as AuditHarness) continue;
          for (const p of extractFile(file, harness, {timezone: tz}).prompts) if (p.kind === 'human') texts.set(p.key, p.text);
        }
        for (const p of list) {
          const key = p.route.basis === 'transient_snapshot' ? p.route.recordKey : null;
          const text = key ? texts.get(key) : undefined;
          if (text !== undefined) (p as {text: string}).text = text;
        }
      } catch { /* the source moved or changed: detail stays unavailable */ }
    }
  }

  /** Text for the newest conversations, enough for the online analysis window. */
  private rehydrateRecent(maxPrompts = 1500): void {
    const a = this.result;
    if (!a) return;
    const recent = [...a.conversations].filter(c => c.prompts.length).sort((x, y) => (y.conversation.eventTo ?? '').localeCompare(x.conversation.eventTo ?? ''));
    const chosen: AuditPrompt[] = [];
    for (const c of recent) { if (chosen.length >= maxPrompts) break; chosen.push(...c.prompts); }
    this.rehydrate(chosen);
  }

  /* ------------------------------------------------------- semantics --- */

  private launchPublish(patch: Partial<LaunchAudit>): void {
    if (!this.current.launch) return;
    this.publish({launch: {...this.current.launch, ...patch}});
  }

  private async runSemantics(period?: SemanticPeriod): Promise<void> {
    const a = this.result;
    if (!a || !this.current.launch) return;
    if (offline() && !this.options.launchPrepareOnly) {
      this.launchPublish({stage: 'ready', semantics: unavailableSemantics(this.current.launch.notice, this.options.tone, 'Offline audit; requested-work analysis was not run.', ['offline_requested'])});
      return;
    }
    this.rehydrateRecent();
    const segmented = segmentContext(this.contextRecords(a, true).filter(r => r.role !== 'user' || r.text), {gaps: ['requested_user_context_only']});
    this.launchSegments = segmented.segments;
    const sourceVersion = this.current.commitment ?? this.id;
    const privacyVersion = digest(JSON.stringify([this.policy?.ignoredList ?? [], [...this.policy?.forgotten ?? []].sort(), this.current.scope.project, NORMALIZATION_VERSION]));
    const cacheBase = {sourceId: 'semantic-job', sourceIdentity: 'selected-context', contentHash: sourceVersion, currentness: 'v2', privacyPolicy: privacyVersion,
      forgetEpoch: 'audit-v2', normalizationVersion: `${NORMALIZATION_VERSION}/audit-v2`};
    const derived = this.derived;
    const cacheKey = (key: string) => ({...cacheBase, sourceId: key, questionVersion: REQUESTED_USER_QUESTION_VERSION, model: FREE_JEV_MODEL, segmentationVersion: CONTEXT_SEGMENTATION_VERSION});
    type Saved = {model: string; answers: {id: string; answer: unknown}[]; usage: FreeJevResponse['usage']};
    const provider = this.options.launchPrepareOnly ? undefined : new FreeJevProvider({
      route: {kind: 'zen-public'},
      beforeDispatch: async ({model, attempt, notice}) => {
        const event: Extract<AuditEvent, {type: 'transfer'}> = {type: 'transfer', snapshotId: this.id, sequence: ++this.sequence, model, recipients: ['OpenCode Zen', 'TypeSafe/Jev'], attempt, selectedSegments: 1, notice};
        if (this.options.onTransfer) await this.options.onTransfer(event); else this.callback?.(event);
        if (this.controller.signal.aborted) throw new Error('cancelled');
      },
      cache: {
        get: key => {
          const saved = derived?.read('semantic-answer', cacheKey(key), (v): v is Saved => !!v && typeof v === 'object' && Array.isArray((v as Saved).answers));
          return saved ? {...saved, answers: Object.fromEntries(saved.answers.map(x => [x.id, x.answer]))} : null;
        },
        set: (key, value) => {
          derived?.write('semantic-answer', cacheKey(key), {...value, answers: Object.entries(value.answers).map(([id, answer]) => ({id, answer}))},
            (v): v is {answers: unknown[]} => !!v && typeof v === 'object' && Array.isArray((v as {answers: unknown[]}).answers));
        },
      },
    });
    this.launchPublish({stage: 'analyzing'});
    const semantics = await runLaunchSemantics({
      contextMode: 'requested_user', segments: segmented.segments, period, tokenLimit: Math.max(0, 100000 - this.semanticReservedTokens),
      gaps: segmented.gaps, preparationMs: 0, tone: this.options.tone, until: this.current.scope.asOf ?? new Date().toISOString(), provider,
      isCurrent: () => !this.controller.signal.aborted, privacyVersion, sourceVersion, signal: this.controller.signal,
    });
    if (this.options.launchPrepareOnly) semantics.gaps = [...semantics.gaps.filter(g => g !== 'free_access_unverified'), 'developer_prepare_only'];
    this.semanticReservedTokens += semantics.reservedTokens ?? 0;
    if (this.options.tone) semantics.tone = this.options.tone;
    this.launchPublish({semantics, stage: 'ready'});
  }

  async previewLaunch() {
    this.assertOpen();
    if (!this.options.launchPrepareOnly) throw new Error('launch_preview_unavailable');
    const semantic = this.current.launch?.semantics, selected = semantic?.window.selected;
    const segments = selected ? selectedSegments(semantic!.window, this.launchSegments) : [];
    const requests = segments.map(segment => {
      const request = buildLaunchRequest(segment, 'requested_user'), serialized = JSON.stringify(request);
      return {segmentId: segment.id, hash: digest(serialized), bytes: Buffer.byteLength(serialized), request};
    });
    return {scope: this.current.scope, sourceVersion: this.current.commitment ?? this.id,
      privacyVersion: digest(JSON.stringify([this.policy?.ignoredList ?? [], this.current.scope.project])), model: FREE_JEV_MODEL, window: semantic?.window ?? null, requests};
  }

  async analyzePeriod(period: SemanticPeriod, onEvent?: (event: AuditEvent) => void): Promise<AuditSnapshot> {
    this.assertOpen();
    if (!this.options.launch || !this.started || this.launchRunning || !['all', 45, 30, 7, 3].includes(period)) throw new Error('semantic_period_unavailable');
    this.launchRunning = true;
    this.callback = onEvent;
    try { await this.runSemantics(period); return this.current; } finally { this.launchRunning = false; this.callback = undefined; }
  }

  /* ---------------------------------------------------- detail views --- */

  async prompts(conversationId: string, offset = 0, limit = 20) {
    this.assertOpen();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid audit pagination');
    const entry = this.result?.conversations.find(c => c.conversation.id === conversationId);
    if (!entry) throw new Error('audit_conversation_unavailable');
    const all = entry.prompts;
    this.rehydrate(all.slice(offset, offset + limit));
    return {snapshotId: this.id, conversationId, prompts: all.slice(offset, offset + limit), offset, total: all.length,
      nextOffset: offset + limit < all.length ? offset + limit : null, coverage: entry.conversation.coverage};
  }

  async evidence(route: AuditEvidenceRoute): Promise<AuditEvidence> {
    this.assertOpen();
    const prompt = this.routes.get(routeKey(route));
    if (!prompt || (route.basis !== 'canonical' && route.snapshotId !== this.id)) {
      return {state: 'unavailable', text: null, role: null, eventAt: null, route, gapCodes: ['unknown_evidence_route']};
    }
    if (this.policy?.ignored(prompt.project ?? null)) return {state: 'stale', text: null, role: null, eventAt: null, route, gapCodes: ['source_or_policy_changed']};
    this.rehydrate([prompt]);
    if (!prompt.text) return {state: 'stale', text: null, role: null, eventAt: null, route, gapCodes: ['source_or_policy_changed']};
    return {state: 'available', text: prompt.text, role: prompt.role, eventAt: prompt.eventAt, route, gapCodes: []};
  }

  private semanticInputs(ids: readonly string[]): SemanticConversationInput[] {
    return ids.map(id => {
      const entry = this.result?.conversations.find(c => c.conversation.id === id);
      if (!entry) throw new Error('audit_conversation_unavailable');
      this.rehydrate(entry.prompts);
      return {id, sourceVersion: digest(JSON.stringify(entry.prompts.map(p => p.id))), prompts: entry.prompts};
    });
  }

  async preview(selection: Omit<AuditSemanticSelection, 'consent'>): Promise<AuditSemanticPreview> {
    this.assertOpen();
    return deepFreeze(structuredClone(this.semanticRunner.preview(this.current, selection, this.semanticInputs(selection.conversationIds))));
  }

  async classify(selection: AuditSemanticSelection, onEvent?: (event: AuditEvent) => void): Promise<AuditSnapshot> {
    this.assertOpen();
    if (selection.consent !== true) throw new Error('semantic_consent_required');
    const signal = selection.signal ? AbortSignal.any([this.controller.signal, selection.signal]) : this.controller.signal;
    const update = (semantics: AuditSemantics, judgments: readonly AuditPromptJudgment[], gaps: readonly string[]) => {
      this.current = {...this.current, sequence: ++this.sequence, semantics, judgments, warnings: [...new Set([...this.current.warnings, ...gaps])]};
      onEvent?.({type: 'snapshot', snapshot: this.current});
    };
    const result = await this.semanticRunner.classify(this.current, {...selection, signal}, this.semanticInputs(selection.conversationIds), () => !signal.aborted, update);
    update(result.semantics, result.judgments, result.gaps);
    return this.current;
  }
}

function unavailableSemantics(notice: string, tone: LaunchSemantics['tone'] | undefined, reason: string, gaps: string[]): LaunchSemantics {
  return {state: 'unavailable', recipientNotice: notice, model: null, window: {selected: null, choices: [], tokenLimit: 100000, reason},
    stories: [], hallOfFame: [], work: [], tone: tone ?? 'elegant', judgments: [], attempts: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, gaps};
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

