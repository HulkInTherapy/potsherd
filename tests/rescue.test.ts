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

    expect(r.filesCopied).toBe(6);
    expect(r.sessionsArchived).toBe(2);
    expect(r.sidechainsArchived).toBe(1);
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

    expect(r.filesCopied).toBe(6);
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

  it('reports a missing history.jsonl instead of failing', async () => {
    const { claude, root } = scratch();
    fs.rmSync(path.join(claude, 'history.jsonl'));
    const r = await rescue({ claudeDir: claude, root });
    expect(r.ghostsBuilt).toBe(0);
    expect(r.warnings.some((w) => w.includes('history.jsonl'))).toBe(true);
    // Everything under projects/ is still archived; only history.jsonl is missing.
    expect(r.filesCopied).toBe(5);
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
