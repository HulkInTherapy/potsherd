# prepared upstream PR — make the sidechain filter an option

**Status: PREPARED, NOT SUBMITTED.** This file is a document in potsherd's
repository. No agent opens, pushes or comments on anything upstream;
distribution is a human decision. The diff below applies cleanly to
`obra/episodic-memory` at `10757690210574421f1df5f35835af8d0c74d984` (`v1.4.2`).

- repository: `https://github.com/obra/episodic-memory`
- base: `main` @ `10757690210574421f1df5f35835af8d0c74d984`
- branch to open it from: `search-include-sidechains`
- files touched: `src/search.ts` (+13 −2), `test/search-sidechains.test.ts` (new)

---

## title

```
search: make the sidechain filter an option instead of hard-coding it
```

## body

```markdown
### What

`searchConversations` hard-codes `AND e.is_sidechain = 0` in both of its query
paths — the vector path at `src/search.ts:165` and the text path at
`src/search.ts:188`. This PR removes those two lines and moves the condition
into `buildSearchFilters`, gated on a new `SearchOptions.includeSidechains`
that defaults to `false`.

**Default behaviour does not change.** With the option unset the same
`e.is_sidechain = 0` clause is emitted, now from one place instead of two.

### Why

Sidechain exchanges are already indexed. Nothing in `indexer.ts` or `sync.ts`
filters them: `parser.ts` propagates `isSidechain` through to the exchange,
`db.ts` stores it and indexes it (`idx_sidechain`), and `show.ts` renders
sidechain blocks in both the markdown and the HTML output. Search is the only
place they disappear, so a subagent's work is written to the database, given a
384-dimension embedding, and then never returned to anyone.

That matters more than it used to. On the machine this was noticed on there are
30 top-level Claude Code sessions and 197 subagent transcripts. Whole
investigations — the ones delegated to a subagent — are unreachable through
search even though every byte of them is indexed and paid for.

An option is the right shape rather than a flipped default: for a lot of
queries the parent session is what you want, and subagent transcripts can
crowd the top-k with near-duplicate context. Callers that want the subagent
work can now ask for it.

`searchMultipleConcepts` delegates to `searchConversations`, so it picks up the
option and the default without a change of its own.

### How

- `SearchOptions` gains `includeSidechains?: boolean`.
- `buildSearchFilters` pushes `e.is_sidechain = 0` unless the option is set.
  It is a constant clause with no bound parameter, so the existing
  bound-parameter contract and its injection test are unaffected.
- The two hard-coded lines are deleted; both queries already interpolate
  `${filterClause}` in the right place.

### Tests

`test/search-sidechains.test.ts` (new) indexes one ordinary session and one
sidechain session with the same topic, then asserts:

- default search returns no sidechain exchanges, in `vector` and `text` mode;
- `includeSidechains: true` returns both, in `vector` and `text` mode;
- the option composes with `session_id`;
- `searchMultipleConcepts` inherits the default.

It follows the existing `test/search-metadata-filters.test.ts` setup
(`TEST_PROJECTS_DIR` / `TEST_ARCHIVE_DIR` / `EPISODIC_MEMORY_CONFIG_DIR` /
`TEST_DB_PATH`, `suppressConsole`, `indexUnprocessed`).

Note that this test, like the other indexing tests, runs the embedder in
`beforeEach` and needs more than the default 10 s `hookTimeout` on a cold
machine.

### Noticed but deliberately not fixed here

`hasMetadataFilters()` decides whether the vec0 KNN should over-fetch
candidates, because `vec0` applies `k` before `WHERE`. The sidechain condition
has always been a post-KNN `WHERE` too, so a query whose top-k happens to be
sidechain-heavy can already return fewer than `limit` results. Folding
`!includeSidechains` into `hasMetadataFilters` would fix that, but it would
change the default query plan for every existing caller, which does not belong
in a PR whose promise is "no behaviour change by default". Happy to send it
separately if you want it.
```

---

## diff

```diff
diff --git a/src/search.ts b/src/search.ts
index f519b33..f796365 100644
--- a/src/search.ts
+++ b/src/search.ts
@@ -14,6 +14,16 @@ export interface SearchOptions {
   project?: string;     // exact match against e.project
   session_id?: string;  // exact match against e.session_id
   git_branch?: string;  // exact match against e.git_branch
+  /**
+   * Include subagent (sidechain) exchanges in the results.
+   *
+   * Sidechain exchanges are indexed like every other exchange — nothing in
+   * indexer.ts or sync.ts filters them — but search has always dropped them,
+   * so a subagent's work is stored and then never returned. Defaults to
+   * false, which is the historical behaviour; set true to search subagent
+   * transcripts as well.
+   */
+  includeSidechains?: boolean;
 }
 
 /**
@@ -24,6 +34,9 @@ export interface SearchOptions {
 function buildSearchFilters(options: SearchOptions): { sql: string; params: unknown[] } {
   const parts: string[] = [];
   const params: unknown[] = [];
+  if (!options.includeSidechains) {
+    parts.push('e.is_sidechain = 0');
+  }
   if (options.after) {
     parts.push('e.timestamp >= ?');
     params.push(options.after);
@@ -162,7 +175,6 @@ export async function searchConversations(
       JOIN exchanges AS e ON vec.id = e.id
       WHERE vec.embedding MATCH ?
         AND k = ?
-        AND e.is_sidechain = 0
         ${filterClause}
       ORDER BY vec.distance ASC
     `);
@@ -185,7 +197,6 @@ export async function searchConversations(
         0 as distance
       FROM exchanges AS e
       WHERE (e.user_message LIKE ? OR e.assistant_message LIKE ?)
-        AND e.is_sidechain = 0
         ${filterClause}
       ORDER BY e.timestamp DESC
       LIMIT ?
diff --git a/test/search-sidechains.test.ts b/test/search-sidechains.test.ts
new file mode 100644
index 0000000..d7dd901
--- /dev/null
+++ b/test/search-sidechains.test.ts
@@ -0,0 +1,137 @@
+import { describe, it, expect, beforeEach, afterEach } from 'vitest';
+import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
+import { join } from 'path';
+import { tmpdir } from 'os';
+import { indexUnprocessed } from '../src/indexer.js';
+import { searchConversations, searchMultipleConcepts } from '../src/search.js';
+import { suppressConsole } from './test-utils.js';
+
+/**
+ * One user/assistant exchange, optionally on a sidechain, whose text embeds
+ * `topic` so both the vector and the text path can find it.
+ */
+function makeExchangeLines(opts: {
+  seq: number;
+  sessionId: string;
+  topic: string;
+  isSidechain: boolean;
+}): string {
+  const { seq, sessionId, topic, isSidechain } = opts;
+  const userUuid = `u-${seq}-${sessionId}`;
+  const assistantUuid = `a-${seq}-${sessionId}`;
+  const ts = new Date(2026, 0, 1 + seq).toISOString();
+  const common = {
+    isSidechain,
+    userType: 'external',
+    cwd: '/test/project',
+    sessionId,
+    version: '2.0.9',
+    gitBranch: 'main',
+  };
+  const userLine = JSON.stringify({
+    ...common,
+    parentUuid: null,
+    type: 'user',
+    message: { role: 'user', content: `Question about ${topic}` },
+    uuid: userUuid,
+    timestamp: ts,
+  });
+  const assistantLine = JSON.stringify({
+    ...common,
+    parentUuid: userUuid,
+    type: 'assistant',
+    message: {
+      model: 'claude-sonnet-4-5',
+      role: 'assistant',
+      content: [{ type: 'text', text: `Answer about ${topic}` }],
+    },
+    uuid: assistantUuid,
+    timestamp: ts,
+  });
+  return userLine + '\n' + assistantLine + '\n';
+}
+
+describe('search sidechain filtering', () => {
+  let testDir: string;
+  let restoreConsole: () => void;
+
+  beforeEach(async () => {
+    testDir = mkdtempSync(join(tmpdir(), 'em-sidechain-test-'));
+    const projectsDir = join(testDir, 'projects');
+    const configDir = join(testDir, 'config');
+    mkdirSync(projectsDir, { recursive: true });
+    mkdirSync(configDir, { recursive: true });
+
+    process.env.TEST_PROJECTS_DIR = projectsDir;
+    process.env.TEST_ARCHIVE_DIR = join(testDir, 'archive');
+    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
+    process.env.TEST_DB_PATH = join(testDir, 'test.db');
+    restoreConsole = suppressConsole();
+
+    const project = join(projectsDir, 'project-a');
+    mkdirSync(project, { recursive: true });
+    writeFileSync(
+      join(project, 'session-main.jsonl'),
+      makeExchangeLines({ seq: 1, sessionId: 'session-main', topic: 'authentication', isSidechain: false }),
+      'utf-8'
+    );
+    writeFileSync(
+      join(project, 'session-sub.jsonl'),
+      makeExchangeLines({ seq: 2, sessionId: 'session-sub', topic: 'authentication', isSidechain: true }),
+      'utf-8'
+    );
+
+    await indexUnprocessed(1, true);
+  });
+
+  afterEach(() => {
+    restoreConsole();
+    delete process.env.TEST_PROJECTS_DIR;
+    delete process.env.TEST_ARCHIVE_DIR;
+    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
+    delete process.env.TEST_DB_PATH;
+    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
+  });
+
+  it('excludes sidechains by default, in both search modes', async () => {
+    for (const mode of ['vector', 'text'] as const) {
+      const results = await searchConversations('authentication', { mode, limit: 10 });
+      expect(results.length).toBeGreaterThan(0);
+      for (const r of results) {
+        expect(r.exchange.isSidechain).toBe(false);
+      }
+    }
+  });
+
+  it('returns sidechain exchanges when includeSidechains is set', async () => {
+    for (const mode of ['vector', 'text'] as const) {
+      const results = await searchConversations('authentication', {
+        mode,
+        limit: 10,
+        includeSidechains: true,
+      });
+      expect(results.some(r => r.exchange.isSidechain === true)).toBe(true);
+      expect(results.some(r => r.exchange.isSidechain === false)).toBe(true);
+    }
+  });
+
+  it('honours includeSidechains alongside another filter', async () => {
+    const results = await searchConversations('authentication', {
+      mode: 'text',
+      limit: 10,
+      session_id: 'session-sub',
+      includeSidechains: true,
+    });
+    expect(results.length).toBeGreaterThan(0);
+    for (const r of results) {
+      expect(r.exchange.sessionId).toBe('session-sub');
+    }
+  });
+
+  it('multi-concept search inherits the same default', async () => {
+    const results = await searchMultipleConcepts(['authentication'], { limit: 10 });
+    for (const r of results) {
+      expect(r.exchange.isSidechain).toBe(false);
+    }
+  });
+});
```

---

## how this was produced, and how to reproduce it

```bash
git remote add upstream-episodic https://github.com/obra/episodic-memory.git
git fetch upstream-episodic --no-tags \
  'refs/heads/main:refs/remotes/upstream-episodic/main'
git rev-parse upstream-episodic/main
#=> 10757690210574421f1df5f35835af8d0c74d984

# in a scratch checkout of that revision:
git apply docs/upstream/PR-sidechain-flag.md   # after stripping the prose
npm install && npx vitest run test/search-sidechains.test.ts \
  --testTimeout=120000 --hookTimeout=120000
```

## how potsherd solved the same problem

potsherd does not carry this patch — the search it was written against is not
ported (`docs/upstream/PORT-LOG.md`: upstream's text path is `LIKE '%q%'` and
the repository has no fts5 anywhere). The equivalent lives in
`packages/core/src/search/filters.ts`, where `SearchFilters.sidechains` is a
tri-state — `include` (the default), `only`, `exclude` — matching the
`--sidechains` flag in `plans/03-ARCHITECTURE.md` §7. potsherd flips the
default because rescuing subagent work is a stated goal of the product; the
patch offered upstream keeps upstream's default, because changing someone
else's default is not a drive-by PR's business.

## a second, unrelated PR candidate

`src/show.ts` formats timestamps with `toLocaleString()`, so on any machine
whose default locale is not `en-US` it renders `19/9/2025` and
`test/show.test.ts` fails its `/9\/19\/2025|2025-09-19/` assertion. Verified:
`LC_ALL=en_US.UTF-8 npx vitest run test/show.test.ts` → 17 passed. The fix is
an explicit `Intl.DateTimeFormat` rather than the ambient locale. Not prepared
here; recorded so it is not lost.
