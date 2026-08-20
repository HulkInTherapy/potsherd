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
      expect(prompts.map((p) => p.text)).toEqual([
        'scaffold the gamma service',
        'add the retry policy',
        'why is the retry budget 3?',
      ]);
    } finally {
      db.close();
    }
  });

  it('recovers a deleted session title from sessions-index.json', async () => {
    const { claude, root } = scratch();
    const r = await rescue({ claudeDir: claude, root });
    expect(r.ghostsWithTitles).toBe(1);

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
    const r = await rescue({ claudeDir: claude, root });
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
