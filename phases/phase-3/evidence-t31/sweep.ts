/**
 * A sweep harness over the *same* fixture index `pnpm evals` builds, reading
 * `evals/queries.jsonl` read-only. It scores exactly what evals/run.ts scores
 * (same rank rule, same modes) so a number here can be trusted to reappear
 * there — but it does not rebuild the index, so a weight sweep costs seconds
 * rather than minutes. It writes nothing under evals/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, db as store, recall, type ListName } from '../../../packages/core/src/index.js';

const root = process.env['R']!;
const here = path.resolve(process.cwd(), 'evals');
const queries = fs
  .readFileSync(path.join(here, 'queries.jsonl'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//'))
  .map((l) => JSON.parse(l) as {
    query: string;
    expected_session_prefix: string;
    expected_sidechain?: boolean;
    kind?: string;
    class?: string;
  });

const MODES: Record<string, { lists: readonly ListName[]; vectors: boolean | 'auto' }> = {
  bm25: { lists: LISTS, vectors: false },
  vec: { lists: ['vec_exchanges', 'vec_cards', 'vec_ghost_prompts'] as ListName[], vectors: true },
  hyb: { lists: LISTS, vectors: 'auto' },
  alw: { lists: LISTS, vectors: true },
};

const overrides: Partial<Record<ListName, number>> = JSON.parse(process.env['W'] ?? '{}');
const corroboration = process.env['C'] ? Number(process.env['C']) : undefined;

const db = store.open({ root });
const ranks: Record<string, number[]> = {};
for (const [name, mode] of Object.entries(MODES)) {
  ranks[name] = [];
  for (const q of queries) {
    const r = await recall(
      db,
      q.query,
      {},
      {
        limit: 20,
        root,
        lists: mode.lists.filter((l) => LISTS.includes(l)),
        vectors: mode.vectors,
        weights: overrides,
        ...(corroboration !== undefined ? { corroboration } : {}),
      },
    );
    const at = r.sessions.findIndex(
      (s) =>
        s.id.startsWith(q.expected_session_prefix) &&
        (q.expected_sidechain ? s.isSidechain || s.hits.some((h) => h.isSidechain) : true),
    );
    ranks[name]!.push(at + 1);
  }
}
db.close();

const at = (rs: number[], k: number): number => rs.filter((r) => r > 0 && r <= k).length;
const pad = (s: string, n: number): string => s.padEnd(n);
console.log(`W=${JSON.stringify(overrides)} C=${corroboration ?? 'default'}`);
console.log('  mode   recall@5  recall@1');
for (const name of Object.keys(MODES)) {
  console.log(`  ${pad(name, 6)}   ${String(at(ranks[name]!, 5)).padStart(2)}/25     ${String(at(ranks[name]!, 1)).padStart(2)}/25`);
}
if (process.env['DETAIL']) {
  queries.forEach((q, i) => {
    const cells = Object.keys(MODES)
      .map((m) => (ranks[m]![i]! > 0 ? `#${ranks[m]![i]}` : '—').padStart(4))
      .join(' ');
    console.log(`  ${pad(q.kind ?? '', 10)}${cells}  ${q.query.slice(0, 48)}`);
  });
}
