import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db as dbNs, idTag, indexAll, paths, resolveSession, resolveThread } from '@potsherd/core';

import { makeContext } from '../packages/mcp/src/context.js';
import { runRead } from '../packages/mcp/src/tools/read.js';
import { citationFacts, mintCitation, verifySources } from '../packages/mcp/src/tools/sources.js';
import { FIXTURE_CLAUDE, IDS, rmrf, tempDir } from './helpers.js';

/**
 * VERIFICATION-8 C8-1 — **a citation resolves to the thread it was minted from.**
 *
 * The release's thesis is one sentence: *"potsherd's output can be checked."*
 * Everything a reader or an agent is handed to check it with — the `citation`
 * string, the `id8` inside it, `potsherd_read`'s own `citationRule`, `potsherd
 * show <prefix>` — carries eight characters. On the reference archive those
 * eight characters named **331 of 369 sessions ambiguously**: 369 sessions
 * collapsed to 58 `slice(0, 8)` prefixes, 20 of them shared, the largest group
 * holding 41. `potsherd_recall` labelled a subagent thread with its *parent's*
 * eight characters and minted a citation for it; `potsherd_read` handed that
 * same id8 returned the parent, thirty-five exchanges away, and minted a second
 * citation wearing the same id. A token that resolves to something else is
 * worse than no token.
 *
 * The cause is structural and was never a rounding: a claude subagent
 * transcript's id is `<parent-uuid>:agent-<tag>`, so `slice(0, 8)` is the
 * parent's uuid for every subagent in the index. {@link idTag} — which already
 * existed, and which `find`, `ls` and `show` have always printed — takes the
 * *right* half instead. What was missing was that the mint sites did not use
 * it, and that the resolver could not look an agent tag up as an id in its own
 * right.
 *
 * **The property this file asserts is universal**, not example-based: for every
 * session in the index, the citation potsherd mints for it resolves to that
 * session and to no other. Eight rounds of verification passed over this defect
 * because the fixture's subagents were called `agent-01` and `agent-02` — a
 * two-character tag cannot collide with an eight-character prefix, so the
 * fixture could not express the shape. The tags are now seventeen hex
 * characters, which is what the harness actually writes.
 */

let scratch = '';
let root = '';
let db: dbNs.Db;
const dirs: string[] = [];

const PARENT = IDS.alive;
/** The subagent of {@link PARENT}. Its id8 is its own; its prefix is its parent's. */
const SUBAGENT = `${IDS.alive}:agent-01f3a5c7e9b2d4608`;

beforeAll(async () => {
  scratch = tempDir('potsherd-identity-');
  root = path.join(scratch, 'potsherd');
  await indexAll({
    root,
    potsherdDir: root,
    claudeDir: FIXTURE_CLAUDE,
    harnesses: ['claude'],
    full: true,
    embed: false,
  });
  db = dbNs.open({ file: paths.dbPath(root), readonly: true });
});

afterAll(() => {
  db?.close();
  while (dirs.length) rmrf(dirs.pop()!);
  if (scratch) rmrf(scratch);
});

describe('C8-1 — the id a citation carries is the id that resolves', () => {
  it('the fixture can express the defect: a subagent whose prefix is its parent uuid', () => {
    // If this fails, every assertion below is vacuous. The subagent's first
    // eight characters ARE the parent's, and its own tag is eight hex
    // characters — the two things that have to be true for `slice(0, 8)` and
    // `idTag` to be able to disagree.
    expect(SUBAGENT.slice(0, 8)).toBe(PARENT.slice(0, 8));
    expect(idTag(SUBAGENT)).not.toBe(idTag(PARENT));
    expect(idTag(SUBAGENT)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('every session in the index: the citation minted for it resolves to it', () => {
    // The universal property, and the one the release's sentence needs. Not a
    // sample: every row, both kinds.
    const ids = [
      ...(db.prepare('SELECT id FROM sessions').all() as { id: string }[]),
      ...(db.prepare('SELECT session_id AS id FROM ghosts').all() as { id: string }[]),
    ].map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (const id of ids) {
      const facts = citationFacts(db, id);
      expect(facts).not.toBeNull();
      const cited = mintCitation(facts!).split(' · ')[0]!;
      const back = resolveSession(db, cited);
      if (!back || back.ambiguous || back.id !== id) wrong.push(`${cited} -> ${back?.id ?? 'null'}`);
    }
    expect(wrong).toEqual([]);
  });

  it('so the subagent is cited by its own id8, never by its parent uuid', () => {
    const sub = mintCitation(citationFacts(db, SUBAGENT)!);
    const parent = mintCitation(citationFacts(db, PARENT)!);
    expect(sub.startsWith(`${idTag(SUBAGENT)} · `)).toBe(true);
    expect(sub.startsWith(`${PARENT.slice(0, 8)} · `)).toBe(false);
    // Two threads, two ids. This is the equality that used to hold.
    expect(sub.split(' · ')[0]).not.toBe(parent.split(' · ')[0]);
  });

  it('and its own minted citation survives verifySources, which is what a citation is for', () => {
    const block = ['SOURCES', mintCitation(citationFacts(db, SUBAGENT)!), '  "a quote"'].join('\n');
    const verdict = verifySources(db, block);
    expect(verdict.refused).toEqual([]);
    expect(verdict.kept.map((r) => r.sessionId)).toEqual([SUBAGENT]);
  });

  it('the two doors agree: full id and minted id8 return the same thread', () => {
    const ctx = makeContext({ potsherdDir: root, env: {} });
    const id8 = mintCitation(citationFacts(db, SUBAGENT)!).split(' · ')[0]!;
    const byId = runRead(ctx, { thread: SUBAGENT, to: 1 }) as Record<string, unknown>;
    const byTag = runRead(ctx, { thread: id8, to: 1 }) as Record<string, unknown>;
    const thread = (r: Record<string, unknown>) => r['thread'] as Record<string, unknown>;
    expect(thread(byTag)['id']).toBe(SUBAGENT);
    expect(thread(byTag)['id']).toBe(thread(byId)['id']);
    expect(byTag['total']).toBe(byId['total']);
    expect(byTag['citations']).toEqual(byId['citations']);
    // And it is not the parent's thread, which is what it used to be.
    const parent = runRead(ctx, { thread: PARENT, to: 1 }) as Record<string, unknown>;
    expect(thread(parent)['id']).not.toBe(SUBAGENT);
    expect(parent['total']).not.toBe(byId['total']);
  });
});

describe('C8-1 — where a reference names more than one thing, it is said, not guessed', () => {
  it("a parent uuid still means the conversation — and now says what else it opens", () => {
    const found = resolveSession(db, PARENT.slice(0, 8));
    // Taking the parent is right: calling this ambiguous would make every
    // session that ever spawned a subagent unshowable.
    expect(found?.id).toBe(PARENT);
    expect(found?.ambiguous).toBeUndefined();
    // Taking it in silence is what `show --help`'s "any unambiguous prefix"
    // could not survive. `show` was never silent — `renderShow` has always
    // printed a `N subagent transcripts:` block naming each one by an id that
    // reaches it — but the model door was, so the fact is carried to the
    // caller that can say it.
    expect(found?.collapsed?.map((c) => c.id)).toEqual([SUBAGENT]);
    expect(resolveThread(db, PARENT.slice(0, 8))?.collapsed?.length).toBe(1);
  });

  it('and a reference that names one session plus a stranger is refused, not answered', () => {
    // The shape the old rule could not see, built where it can be built: one
    // top-level session whose id opens with those eight characters, and one subagent of a
    // *different* parent whose agent tag is the same eight characters. The old
    // rule was "exactly one candidate is top-level, take it" — which answered
    // this, in silence, with a session the caller had not named. The rule is
    // now "its own subagents, and nothing else"; anything else is ambiguous.
    const scratch2 = tempDir('potsherd-identity-amb-');
    dirs.push(scratch2);
    const root2 = path.join(scratch2, 'potsherd');
    const w = dbNs.open({ file: paths.dbPath(root2) });
    try {
      const add = (id: string, sidechain: number): void => {
        w.prepare(
          `INSERT INTO sessions (id, harness, project, is_sidechain, status)
             VALUES (?, 'claude', '/tmp/p', ?, 'live')`,
        ).run(id, sidechain);
      };
      const shared = 'dddddddd';
      const lone = `${shared}-0000-4000-8000-000000000001`;
      const stranger = `ffffffff-0000-4000-8000-000000000002:agent-${shared}eeeeeeeee`;
      add(lone, 0);
      add('ffffffff-0000-4000-8000-000000000002', 0);
      add(stranger, 1);

      const found = resolveSession(w, shared);
      // Refused: both candidates named, neither picked.
      expect(found?.ambiguous?.map((c) => c.id).sort()).toEqual([lone, stranger].sort());
      // And the thread door refuses the same reference rather than paging one
      // of the two, which is what `potsherd_read`'s citationRule depends on.
      expect(resolveThread(w, shared)?.ambiguous?.length).toBe(2);
      // Both of them *print* this id8 — `idTag` is a pure function of the id
      // and cannot know what else is in the index — and that is precisely the
      // case the product must refuse rather than resolve. It does, at both
      // doors, and each is still reachable by the id it is refused for.
      expect(idTag(stranger)).toBe(shared);
      expect(idTag(lone)).toBe(shared);
      expect(resolveSession(w, stranger)?.id).toBe(stranger);
      expect(resolveSession(w, stranger)?.ambiguous).toBeUndefined();
      expect(resolveSession(w, lone)?.id).toBe(lone);
    } finally {
      w.close();
    }
  });

  it('an id8 is unique across the whole index, which is the property the citation needs', () => {
    const ids = (db.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((r) => r.id);
    const tags = new Set(ids.map((id) => idTag(id)));
    expect(tags.size).toBe(ids.length);
    // The number the old identity produced on the same rows, kept as the
    // contrast: `slice(0, 8)` collapses the subagents onto their parents.
    const raw = new Set(ids.map((id) => id.slice(0, 8)));
    expect(raw.size).toBeLessThan(ids.length);
  });
});
