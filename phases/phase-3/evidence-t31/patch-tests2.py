p = 'tests/recall.test.ts'
s = open(p).read()

block = '''
/**
 * The vector half, on the same corpus. Skipped unless the 34 MB bge-small model
 * is already on disk — CI must never silently fetch it — and given its own
 * index because embedding is the only thing here that costs anything.
 */
const MODEL_CACHE = path.join(os.tmpdir(), 'potsherd-test-models');
const hasModel =
  process.env['POTSHERD_TEST_EMBED'] === '1' || embeddings.isModelCached(MODEL_CACHE);

describe.skipIf(!hasModel)('recall: the vector half — T3.1', () => {
  let vroot: string;
  let vdb: Db;

  beforeAll(async () => {
    vroot = tempDir('potsherd-recall-vec-');
    dirs.push(vroot);
    fs.symlinkSync(MODEL_CACHE, path.join(vroot, 'models'));
    await rescue({ claudeDir: FIXTURE, root: vroot, ghostsOnly: true, quiet: true });
    await indexAll({ root: vroot, claudeDir: FIXTURE, harnesses: ['claude'], embed: true, full: true });
    vdb = store.open({ root: vroot });
  }, 600_000);

  afterAll(() => {
    vdb?.close();
  });

  /**
   * **The regression.** Every subagent exchange was embedded, and the vector
   * list ranked the right one first — and a search with only the vector lists
   * on still never returned a single hit flagged `isSidechain`, because the
   * one-exchange subagent lost its own parent's block every time. It was not a
   * missing join and not a dropped flag; it was the ranker treating one
   * conversation as two rivals.
   */
  it('returns the subagent the vectors ranked first, flagged as a subagent', async () => {
    const r = await recall(
      vdb,
      'the thing quietly eating most of the cloud bill',
      {},
      { vectors: true, lists: ['vec_exchanges'], root: vroot, limit: 20 },
    );
    expect(r.vectors.used).toBe(true);
    expect(r.hits.some((h) => h.isSidechain)).toBe(true);
    const at = r.sessions.findIndex(
      (x) => x.id.startsWith('d4b1f0a7') && (x.isSidechain || x.hits.some((h) => h.isSidechain)),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(5);
  }, 120_000);

  it('embeds every subagent exchange, not only the parents', () => {
    const row = vdb
      .prepare(
        `SELECT COUNT(*) AS n FROM exchanges e
           JOIN vec_exchanges_rowids v ON v.id = e.id
          WHERE e.is_sidechain = 1`,
      )
      .get() as { n: number };
    expect(row.n).toBe(6);
  });

  /**
   * Ghosts join the semantic half (schema 7/8). Before this they carried no
   * embeddings at all, so RRF could only ever collect two contributions for a
   * ghost against five for a live session — and turning the vector weight up to
   * fix the *other* half of the corpus pushed every ghost off the first page.
   */
  it('embeds recovered prompts into vec_ghost_prompts', () => {
    const embedded = vdb
      .prepare('SELECT COUNT(*) AS n FROM ghost_prompts WHERE embedding_version IS NOT NULL')
      .get() as { n: number };
    const total = vdb
      .prepare("SELECT COUNT(*) AS n FROM ghost_prompts WHERE length(trim(text)) > 3")
      .get() as { n: number };
    expect(total.n).toBeGreaterThan(0);
    expect(embedded.n).toBe(total.n);
  });

  it('finds a ghost through the vector list alone, with none of its words', async () => {
    const r = await recall(
      vdb,
      'printing from this machine stopped working',
      {},
      { vectors: true, lists: ['vec_ghost_prompts'], root: vroot, limit: 10 },
    );
    expect(r.vectors.used).toBe(true);
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.sessions.every((x) => x.status === 'ghost')).toBe(true);
  }, 120_000);

  it('drops the ghost vector list when the ghosts are filtered out', async () => {
    const r = await recall(
      vdb,
      'printing from this machine stopped working',
      { ghosts: 'exclude' },
      { vectors: true, root: vroot, limit: 10 },
    );
    expect(r.lists.some((l) => l.list === 'vec_ghost_prompts')).toBe(false);
    expect(r.sessions.every((x) => x.status !== 'ghost')).toBe(true);
  }, 120_000);
});
'''

s = s.rstrip() + '\n' + block
s = s.replace(
    """import path from 'node:path';
import { fileURLToPath } from 'node:url';""",
    """import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';""",
    1,
)
s = s.replace(
    """  CORROBORATION,
  WEIGHTS,
  db as store,""",
    """  CORROBORATION,
  WEIGHTS,
  db as store,
  embeddings,""",
    1,
)
open(p, 'w').write(s)
print('ok')
