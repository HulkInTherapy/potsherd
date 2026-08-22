import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store, rescue, renderRescueReceipt, Theme, stripAnsi } from '@potsherd/core';
import { copyFixtureClaude, IDS, rmrf, tempDir } from './helpers.js';

const created: string[] = [];

function scratch(): { claude: string; root: string } {
  const claude = copyFixtureClaude();
  const root = tempDir('potsherd-root-');
  created.push(path.dirname(claude), root);
  return { claude, root };
}

afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

function counts(root: string): Record<string, number> {
  const db = store.open({ root, readonly: true });
  try {
    return {
      ghosts: store.count(db, 'ghosts'),
      ghostPrompts: store.count(db, 'ghost_prompts'),
      archiveFiles: store.count(db, 'archive_files'),
      rescueLog: store.count(db, 'rescue_log'),
    };
  } finally {
    db.close();
  }
}

describe('rescue', () => {
  it('archives every transcript, sidechain, index and memory note', async () => {
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });

    // 2 transcripts + 2 sidechains + 1 sessions-index + 1 memory note + history.
    expect(r.filesCopied).toBe(7);
    expect(r.sessionsArchived).toBe(2);
    expect(r.sessionsInArchive).toBe(2);
    // Both sidechain layouts, or half the subagent transcripts are left behind.
    expect(r.sidechainsArchived).toBe(2);
    expect(r.sessionIndexesArchived).toBe(1);
    expect(r.memoryFilesArchived).toBe(1);
    // history.jsonl is archived too: it is the only source the ghosts have.
    expect(r.historyArchived).toBe(true);
    expect(fs.existsSync(path.join(root, 'archive', 'claude', 'history.jsonl'))).toBe(true);

    const archived = path.join(root, 'archive', 'claude', '-tmp-potsherd-alpha');
    expect(fs.existsSync(path.join(archived, `${IDS.alive}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(archived, IDS.alive, 'subagents', 'agent-01.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(archived, 'sessions-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(archived, 'memory', 'decisions.md'))).toBe(true);
    // <project>/subagents/, the layout in plans/phases/phase-0-rescue.md T0.1.
    const beta = path.join(root, 'archive', 'claude', '-tmp-potsherd-beta');
    expect(fs.existsSync(path.join(beta, 'subagents', 'agent-02.jsonl'))).toBe(true);
  });

  it('copies byte-exactly and does not redact the archive', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    const src = path.join(claude, 'projects', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    const dst = path.join(root, 'archive', 'claude', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    expect(fs.readFileSync(dst)).toEqual(fs.readFileSync(src));
  });

  it('archives at 0600 and preserves the source mtime', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    const src = path.join(claude, 'projects', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    const dst = path.join(root, 'archive', 'claude', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600);
    // utimes takes seconds as a float, so the copy can land a millisecond off.
    // Close enough to keep `ls -l` honest; the dedupe check uses the source
    // mtime recorded in archive_files, never the archive file's own.
    const drift = Math.abs(fs.statSync(dst).mtimeMs - fs.statSync(src).mtimeMs);
    expect(drift).toBeLessThanOrEqual(1);
  });

  it('is idempotent: a second run copies nothing', async () => {
    const { claude, root } = scratch();
    const first = await rescue({ claudeDir: claude, root });
    const second = await rescue({ claudeDir: claude, root });

    expect(first.filesCopied).toBeGreaterThan(0);
    expect(second.filesCopied).toBe(0);
    expect(second.bytesCopied).toBe(0);
    expect(second.filesSkipped).toBe(first.filesConsidered);
    expect(second.ghostsBuilt).toBe(0);
    expect(second.ghostsUpdated).toBe(first.ghostsBuilt);
  });

  it('re-copies a transcript that grew since the last run', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    const src = path.join(claude, 'projects', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    fs.appendFileSync(src, JSON.stringify({ type: 'ai-title', aiTitle: 'later' }) + '\n');
    const again = await rescue({ claudeDir: claude, root });
    expect(again.filesCopied).toBe(1);
  });

  it('rebuilds one ghost per deleted session, with its prompts', async () => {
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });

    expect(r.ghostsBuilt).toBe(3);
    expect(r.promptsRecovered).toBe(6);
    expect(counts(root).ghosts).toBe(3);
    expect(counts(root).ghostPrompts).toBe(6);

    const db = store.open({ root, readonly: true });
    try {
      const ghost = db
        .prepare('SELECT * FROM ghosts WHERE session_id = ?')
        .get(IDS.ghostA) as Record<string, unknown>;
      expect(ghost['prompt_count']).toBe(3);
      expect(ghost['project']).toBe('/tmp/potsherd-gamma');
      expect(ghost['first_prompt']).toBe('scaffold the gamma service');
      expect(ghost['source']).toBe('history');

      const prompts = db
        .prepare('SELECT text FROM ghost_prompts WHERE session_id = ? ORDER BY seq')
        .all(IDS.ghostA) as { text: string }[];
      // Verbatim, slash command and all: `ghost_prompts` is the record, and
      // `show` renders it. Phase 8.2 changes what is *derived* from these
      // lines, never the lines themselves.
      expect(prompts.map((p) => p.text)).toEqual([
        '/model',
        'scaffold the gamma service',
        'why is the retry budget 3?',
      ]);
    } finally {
      db.close();
    }
  });

  it('recovers a deleted session title from sessions-index.json', async () => {
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });
    // All three: one from the index summary, two from a substantive prompt.
    // The counter means "a name somebody wrote", so the `<project>-<id8>`
    // fallback is not counted — see the fallback test below.
    expect(r.ghostsWithTitles).toBe(3);

    const db = store.open({ root, readonly: true });
    try {
      const ghost = db
        .prepare('SELECT title, message_count, source FROM ghosts WHERE session_id = ?')
        .get(IDS.ghostC) as { title: string; message_count: number; source: string };
      expect(ghost.title).toBe('Alpha migration runner');
      expect(ghost.message_count).toBe(12);
      expect(ghost.source).toBe('both');
    } finally {
      db.close();
    }
  });

  it('never builds a ghost for a session whose transcript is still there', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    const db = store.open({ root, readonly: true });
    try {
      const row = db.prepare('SELECT 1 FROM ghosts WHERE session_id = ?').get(IDS.alive);
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('writes one rescue_log row per run', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    await rescue({ claudeDir: claude, root });
    expect(counts(root).rescueLog).toBe(2);
  });

  it('--dry-run writes nothing anywhere', async () => {
    const { claude, root } = scratch();
    const before = fs.readdirSync(root);
    const r = await rescue({ claudeDir: claude, root, dryRun: true });

    expect(r.filesCopied).toBe(7);
    expect(r.ghostsBuilt).toBe(3);
    expect(fs.existsSync(path.join(root, 'archive'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'potsherd.db'))).toBe(false);
    // Only the lock directory, which is removed again.
    expect(fs.readdirSync(root)).toEqual(before);
  });

  it('never modifies the claude directory', async () => {
    const { claude, root } = scratch();
    const before = snapshot(claude);
    await rescue({ claudeDir: claude, root });
    expect(snapshot(claude)).toEqual(before);
  });

  it('skips the ghost rebuild when nothing it reads has changed', async () => {
    // The SessionStart hook runs this at every Claude Code startup; re-writing
    // several thousand ghost_prompts rows every time is the work it was
    // spending its budget on. The totals it reports must not change.
    const { claude, root } = scratch();
    const first = await rescue({ claudeDir: claude, root });
    const second = await rescue({ claudeDir: claude, root });

    expect(first.ghostsBuilt).toBe(3);
    expect(second.ghostsBuilt).toBe(0);
    expect(second.ghostsUpdated).toBe(3);
    // Still the same receipt, read out of the database rather than rebuilt.
    expect(second.promptsRecovered).toBe(first.promptsRecovered);
    expect(second.ghostPrompts).toBe(first.ghostPrompts);
    expect(second.ghostsWithTitles).toBe(first.ghostsWithTitles);
    expect(counts(root)).toEqual(expect.objectContaining({ ghosts: 3, ghostPrompts: 6 }));
  });

  it('rebuilds the ghosts as soon as history.jsonl changes', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });

    const history = path.join(claude, 'history.jsonl');
    fs.appendFileSync(
      history,
      JSON.stringify({
        display: 'and one more thing',
        timestamp: Date.parse('2026-05-10T09:30:00.000Z'),
        project: '/tmp/potsherd-gamma',
        sessionId: IDS.ghostA,
      }) + '\n',
    );

    const after = await rescue({ claudeDir: claude, root });
    expect(after.ghostsBuilt).toBe(0);
    expect(after.ghostsUpdated).toBe(3);
    // The new prompt is in: correctness is never traded for the fast path.
    expect(after.promptsRecovered).toBe(7);
    expect(counts(root)['ghostPrompts']).toBe(7);
  });

  it('rebuilds the ghosts when a transcript is deleted under it', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    // The sweep takes the live alpha session: it becomes a fourth ghost even
    // though history.jsonl did not change by a byte.
    fs.rmSync(path.join(claude, 'projects', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`));

    const after = await rescue({ claudeDir: claude, root });
    expect(after.ghostsBuilt).toBe(1);
    expect(counts(root)['ghosts']).toBe(4);
  });

  it('rebuilds the ghosts when a sessions-index.json changes', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    const idx = path.join(claude, 'projects', '-tmp-potsherd-alpha', 'sessions-index.json');
    const json = JSON.parse(fs.readFileSync(idx, 'utf8')) as {
      entries: { sessionId: string; summary?: string }[];
    };
    for (const e of json.entries) if (e.sessionId === IDS.ghostC) e.summary = 'A better title';
    fs.writeFileSync(idx, JSON.stringify(json, null, 2) + '\n');

    const after = await rescue({ claudeDir: claude, root });
    expect(after.ghostsUpdated).toBe(3);
    const db = store.open({ root, readonly: true });
    try {
      const row = db.prepare('SELECT title FROM ghosts WHERE session_id = ?').get(IDS.ghostC) as
        | { title: string }
        | undefined;
      expect(row?.title).toBe('A better title');
    } finally {
      db.close();
    }
  });

  it('reports a missing history.jsonl instead of failing', async () => {
    const { claude, root } = scratch();
    fs.rmSync(path.join(claude, 'history.jsonl'));
    const r = await rescue({ claudeDir: claude, root });
    expect(r.ghostsBuilt).toBe(0);
    expect(r.warnings.some((w) => w.includes('history.jsonl'))).toBe(true);
    // Everything under projects/ is still archived; only history.jsonl is missing.
    expect(r.filesCopied).toBe(6);
    expect(r.historyArchived).toBe(false);
  });

  it('works on a claude directory that does not exist', async () => {
    const root = tempDir('potsherd-root-');
    created.push(root);
    const r = await rescue({ claudeDir: '/tmp/potsherd-nope', root });
    expect(r.filesCopied).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('rescue receipt', () => {
  it('fits 80 columns, names the archive, and ends with the next verb', async () => {
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });
    const out = renderRescueReceipt(r, new Theme({ color: false, width: 80 }), {
      settingsChanged: true,
      settingsFrom: null,
      settingsTo: 3650,
    });
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(stripAnsi(out)).toBe(out);
    expect(out).toContain('prompts recovered');
    // The last line is the next verb, and it is the one this machine still
    // needs: the sweep is already off here, so guard is what is left.
    expect(out.trimEnd().split('\n').pop()).toContain('potsherd guard');
  });

  it('points at rescue --yes while the sweep is still on, and at audit when all is done', async () => {
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });
    const t = new Theme({ color: false, width: 80 });

    const declined = renderRescueReceipt(r, t, { settingsChanged: false, settingsFrom: null });
    expect(declined.trimEnd().split('\n').pop()).toContain('potsherd rescue --yes');

    const done = renderRescueReceipt(r, t, { settingsChanged: true, guardInstalled: true });
    expect(done.trimEnd().split('\n').pop()).toContain('potsherd audit');
  });

  it('says the sweep is still on when the user declined', async () => {
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });
    const out = renderRescueReceipt(r, new Theme({ color: false, width: 80 }), {
      settingsChanged: false,
      settingsFrom: null,
    });
    expect(out).toContain('rescue again before it runs');
  });

  it('keeps the closing command complete at 60 columns', async () => {
    // plans/05: the last line is always the fix, and it degrades to 60 cols.
    // A command truncated to `potsherd guard to take a copy at every startup,
    // aut…` cannot be typed, so the explanation has to give ground first.
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });
    const t = new Theme({ color: false, width: 60 });

    for (const extras of [
      { settingsChanged: false as const, settingsFrom: null },
      { settingsChanged: true as const, settingsFrom: null, settingsTo: 3650 },
      { settingsChanged: true as const, guardInstalled: true },
    ]) {
      const out = renderRescueReceipt(r, t, extras);
      for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
      const last = out.trimEnd().split('\n').pop()!;
      expect(last.endsWith('…')).toBe(false);
      // A whole `potsherd <verb>`, with the word after it intact.
      expect(last).toMatch(/run {2}potsherd (audit|rescue|guard)(?: --[a-z-]+)?(?: {2}\S|$)/);
    }
  });

  it('never squeezes the settings refusal (a path) into the note column', async () => {
    // The reason opens with an absolute path and is printed in full above the
    // card; clipped to the note column it became `the sweep on /private/tmp/…`.
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });
    const reason = `${claude}/settings.json contains comments, so rewriting it as JSON would drop them`;

    for (const width of [80, 60]) {
      const out = renderRescueReceipt(r, new Theme({ color: false, width }), {
        settingsChanged: null,
        settingsRefused: true,
        settingsSkippedReason: reason,
        settingsTo: 3650,
      });
      const sweep = out.split('\n').find((l) => l.includes('the sweep'))!;
      expect(sweep).toContain('settings.json left untouched');
      expect(sweep).not.toContain('/');

      // And the fix cannot be the command that has just been refused.
      const last = out.trimEnd().split('\n').pop()!;
      expect(last).not.toContain('potsherd rescue --yes');
      expect(last).toContain('"cleanupPeriodDays": 3650');
      expect(last).toContain('by hand');
      expect(last.endsWith('…')).toBe(false);
      expect(last.length).toBeLessThanOrEqual(width);
    }
  });

  it('reads as a delta plus a total on the second run, with no caption', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    const second = await rescue({ claudeDir: claude, root });
    const out = renderRescueReceipt(second, new Theme({ color: false, width: 80 }), {
      settingsChanged: false,
      settingsFrom: null,
    });

    // A bare `sessions 0` read as "the archive holds no sessions". Every zero
    // in this card now carries the total that makes it legible.
    expect(second.filesCopied).toBe(0);
    expect(second.sessionsArchived).toBe(0);
    expect(second.sessionsInArchive).toBe(2);
    expect(out).not.toMatch(/^ {2}sessions {2,}0\s*$/m);
    expect(out).toContain('sessions archived');
    expect(out).toContain('2 in the archive');
    expect(out).toContain('3 in the archive, none new');
    // `prompts recovered` is the one total in the column: say whose it is.
    expect(out).toContain('from 3 ghosts');
  });

  it('pluralises everything it counts', async () => {
    const { claude, root } = scratch();
    // The singular of "with a title" needs a corpus where exactly one ghost
    // has a name somebody wrote, and the fixture now has three. Rather than
    // read that state off the fixture, establish it: take the two gamma
    // ghosts' prompts down to slash commands, which leaves only the alpha
    // ghost's sessions-index.json summary standing. Prompt counts are
    // untouched, so every other number on the card is the same.
    silence(claude, [IDS.ghostA, IDS.ghostB]);
    const r = await rescue({ claudeDir: claude, root });
    expect(r.ghostsWithTitles).toBe(1);
    const out = renderRescueReceipt(r, new Theme({ color: false, width: 100 }), {
      settingsChanged: false,
      settingsFrom: null,
    });
    // One session index, one memory note, one recovered title.
    expect(out).toContain('1 index');
    expect(out).not.toContain('1 indexes');
    expect(out).toContain('1 memory note');
    expect(out).not.toContain('1 memory notes');
    expect(out).toContain('1 with a title');
    expect(out).not.toContain('1 with titles');
    expect(out).not.toMatch(/\b1 (ghosts|sidechains|prompts recovered from)\b/);
  });
});

/**
 * phase 8.2 — the `ls` screen, which `05 §3` makes the screenshot the product
 * is shared on.
 *
 * On the reference machine 166 of 299 ghosts (56%) rendered as `/resume`,
 * `/model`, `/mcp` or `clear`, because `rescue` stored the literal first line
 * of history.jsonl and every surface fell back to it. What is pinned here is
 * the derivation, end to end through `rescue()`: which prompt becomes the
 * name, what happens when no prompt can be one, and that re-running cannot
 * undo either answer.
 */
describe('ghost titles', () => {
  /** The acceptance query from plans/phases/phase-8-hardening.md §8.2. */
  function slashTitles(root: string): number {
    const db = store.open({ root, readonly: true });
    try {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM ghosts
              WHERE first_prompt LIKE '/%' OR length(first_prompt) < 8`,
          )
          .get() as { n: number }
      ).n;
    } finally {
      db.close();
    }
  }

  function ghostRow(root: string, id: string): { title: string; first_prompt: string | null } {
    const db = store.open({ root, readonly: true });
    try {
      return db.prepare('SELECT title, first_prompt FROM ghosts WHERE session_id = ?').get(id) as {
        title: string;
        first_prompt: string | null;
      };
    } finally {
      db.close();
    }
  }

  it('skips the opening lines that name nothing, and keeps them in the record', async () => {
    const { claude, root } = scratch();
    // The premise, asserted rather than assumed: each ghost really does open
    // with a line that cannot be a title, one per rule.
    const opening = historyOf(claude);
    expect(opening[IDS.ghostA]![0]).toBe('/model'); // slash command
    expect(opening[IDS.ghostB]![0]).toBe('continue'); // stoplist, 8 characters
    expect(opening[IDS.ghostC]![0]).toBe('clear'); // stoplist, and too short

    await rescue({ claudeDir: claude, root });

    expect(ghostRow(root, IDS.ghostA).title).toBe('scaffold the gamma service');
    expect(ghostRow(root, IDS.ghostB).title).toBe('gamma deploy is failing on the health check');
    // The harness's own summary outranks any prompt, and ghost C has one.
    expect(ghostRow(root, IDS.ghostC).title).toBe('Alpha migration runner');
    // Its only prompt names nothing, so `first_prompt` comes from the last
    // place a deleted session's opening survives: sessions-index.json.
    expect(ghostRow(root, IDS.ghostC).first_prompt).toBe('set up the alpha migration runner');

    // …and none of it was achieved by throwing the lines away.
    const db = store.open({ root, readonly: true });
    try {
      const kept = db
        .prepare('SELECT text FROM ghost_prompts WHERE text = ? OR text = ? OR text = ?')
        .all('/model', 'continue', 'clear') as { text: string }[];
      expect(kept.map((k) => k.text).sort()).toEqual(['/model', 'clear', 'continue']);
    } finally {
      db.close();
    }
  });

  it('leaves no ghost whose stored opening is a slash command or a stub', async () => {
    const { claude, root } = scratch();
    // Establish that there is something to find. The query is narrower than
    // the rule it stands in for: it catches ghost A (`/model`) and ghost C
    // (`clear`), but not ghost B, whose `continue` is exactly eight characters
    // and no slash. A count of zero is therefore necessary and not sufficient
    // — which is why the test above names all three titles.
    const opening = historyOf(claude);
    expect(Object.keys(opening).length).toBe(4); // three ghosts and the live one
    const caught = [IDS.ghostA, IDS.ghostB, IDS.ghostC].filter((id) => {
      const first = opening[id]![0]!;
      return first.startsWith('/') || [...first].length < 8;
    });
    expect(caught).toEqual([IDS.ghostA, IDS.ghostC]);

    await rescue({ claudeDir: claude, root });
    expect(slashTitles(root)).toBe(0);
  });

  it('falls back to <project>-<id8>, never to a slash command', async () => {
    const { claude, root } = scratch();
    // A ghost that typed nothing but commands at the harness. It is not in the
    // committed fixture because adding a fourth ghost would move every count
    // `audit` is pinned on, so the test writes it.
    appendHistory(claude, DELTA, '/tmp/potsherd-delta', [
      ['2026-07-01T08:00:00.000Z', '/resume'],
      ['2026-07-01T08:01:00.000Z', 'ok'],
      ['2026-07-01T08:02:00.000Z', '/mcp'],
    ]);
    await rescue({ claudeDir: claude, root });

    const row = ghostRow(root, DELTA);
    expect(row.title).toBe('potsherd-delta-dddddddd');
    // Null, not `/resume`: nothing this session typed names it, and that is
    // what the fallback title is saying.
    expect(row.first_prompt).toBeNull();
    expect(slashTitles(root)).toBe(0);
  });

  it('cuts a long prompt at 60 code points, never through a character', async () => {
    const { claude, root } = scratch();
    // One ascii character then 80 astral ones, so a UTF-16 cut at 60 lands in
    // the middle of a surrogate pair — established here, not assumed.
    const long = `x${'\u{1F9E9}'.repeat(80)}`;
    expect(/[\uD800-\uDBFF]$/.test(long.slice(0, 60))).toBe(true);

    appendHistory(claude, EPSILON, '/tmp/potsherd-epsilon', [
      ['2026-07-02T08:00:00.000Z', long],
    ]);
    await rescue({ claudeDir: claude, root });

    const row = ghostRow(root, EPSILON);
    expect([...row.title].length).toBe(60);
    expect(row.title).toBe([...long].slice(0, 60).join(''));
    // No half a character survived the cut, in either direction.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(row.title)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(row.title)).toBe(false);
    // The title is cut; the searchable prompt is not.
    expect(row.first_prompt).toBe(long);
  });

  it('re-derives the title on every rebuild rather than preserving it', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    const good = ghostRow(root, IDS.ghostA).title;

    // A row as an older build left it: the literal first line as the opening,
    // and no title at all. Nothing under ~/.claude has changed, so the only
    // thing that can repair it is the rebuild deciding the answer afresh.
    const db = store.open({ root });
    try {
      db.prepare('UPDATE ghosts SET title = ?, first_prompt = ? WHERE session_id = ?').run(
        '/model',
        '/model',
        IDS.ghostA,
      );
      // …and the fingerprint an older build stored, which is a different
      // string because the derivation is part of what is fingerprinted.
      db.prepare("UPDATE sync_state SET value = 'written-by-an-older-build' WHERE key = ?").run(
        'claude:ghosts',
      );
    } finally {
      db.close();
    }
    expect(slashTitles(root)).toBe(1);

    await rescue({ claudeDir: claude, root });
    expect(ghostRow(root, IDS.ghostA).title).toBe(good);
    expect(slashTitles(root)).toBe(0);
  });

  it('gives the same answer twice', async () => {
    const { claude, root } = scratch();
    await rescue({ claudeDir: claude, root });
    const before = allTitles(root);
    await rescue({ claudeDir: claude, root });
    expect(allTitles(root)).toEqual(before);
  });
});

const DELTA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EPSILON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** Every session in a copied fixture's history.jsonl, prompts in order. */
function historyOf(claude: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of fs.readFileSync(path.join(claude, 'history.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: { sessionId?: string; display?: string };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue;
    }
    if (!r.sessionId) continue;
    (out[r.sessionId] ??= []).push(r.display ?? '');
  }
  return out;
}

/** Add a session to a copied fixture's history.jsonl. Never the real one. */
function appendHistory(
  claude: string,
  sessionId: string,
  project: string,
  prompts: [string, string][],
): void {
  fs.appendFileSync(
    path.join(claude, 'history.jsonl'),
    prompts
      .map(([ts, text]) =>
        JSON.stringify({
          display: text,
          pastedContents: {},
          timestamp: Date.parse(ts),
          project,
          sessionId,
        }),
      )
      .join('\n') + '\n',
  );
}

/** Take the named sessions' prompts down to slash commands, in place. */
function silence(claude: string, sessionIds: string[]): void {
  const p = path.join(claude, 'history.jsonl');
  const wanted = new Set(sessionIds);
  const out = fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      let r: { sessionId?: string; display?: string };
      try {
        r = JSON.parse(line) as typeof r;
      } catch {
        return line;
      }
      if (!r.sessionId || !wanted.has(r.sessionId)) return line;
      return JSON.stringify({ ...r, display: '/model' });
    });
  fs.writeFileSync(p, out.join('\n'));
}

function allTitles(root: string): Record<string, string> {
  const db = store.open({ root, readonly: true });
  try {
    const rows = db.prepare('SELECT session_id, title FROM ghosts ORDER BY session_id').all() as {
      session_id: string;
      title: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.session_id, r.title]));
  } finally {
    db.close();
  }
}

/** Path -> (size, mtime, mode), for proving nothing under ~/.claude changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[path.relative(dir, p)] = `${st.size}:${Math.floor(st.mtimeMs)}:${st.mode}`;
      }
    }
  };
  walk(dir);
  return out;
}
