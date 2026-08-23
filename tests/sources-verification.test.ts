import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CITATION_RE, db as dbNs, indexAll, paths } from '@potsherd/core';

import { verifySources, mintCitation, sourceFieldOf } from '../packages/mcp/src/tools/sources.js';
import { FIXTURE_CLAUDE, IDS, rmrf, tempDir } from './helpers.js';

/**
 * T10.6 · F3 — fabrication killed in code.
 *
 * The audit is the fixture. Two dispatches of `session-archaeologist` against a
 * real question both came back with `SOURCES` blocks whose rows were repository
 * markdown files — dressed in the citation format, with the session-id and
 * exchange-count fields left as a dash — and one of them carried a fabricated
 * project start date two months wrong. The auditor's sentence is the acceptance
 * criterion:
 *
 * > **A citation format that accepts unverified rows is worse than no format**,
 * > because it converts a guess into something that reads like a receipt.
 *
 * Every id in this file is synthetic (`tests/fixtures/claude`, `IDS`). No real
 * session id from the audit, from a plan file, or from this machine appears
 * here or in the shipped source it exercises.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

let scratch = '';
let root = '';
let db: dbNs.Db;

/** An id8 that is well-formed hex and belongs to no session in the index. */
const ABSENT_ID8 = 'deadbeef';

beforeAll(async () => {
  scratch = tempDir('potsherd-sources-');
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
  if (scratch) rmrf(scratch);
});

/**
 * The audit's failing output, rebuilt.
 *
 * Row 1 is real: a session that is actually in the index, cited correctly.
 * It is here so that a check which simply refused everything could not pass.
 *
 * Row 2 is `HANDOFF.md §3` — a repository file wearing the citation format,
 * with the exchange count left as a dash. This is the row the auditor said
 * "made the fabrication look like evidence".
 *
 * Row 3 is the one that carried the fabricated date. Its id field is a dash,
 * which is exactly what the audit recorded: *"Zero session ids."*
 *
 * Row 4 is well-formed hex that names no session. A model that has learned the
 * shape of an id8 but not where to get one produces this, and it is the row a
 * format check alone would wave through.
 */
const AUDIT_FAILING_SOURCES = [
  'ANSWER',
  'The project began on 3 June and the gate was descoped early.',
  '',
  'SOURCES',
  `${IDS.alive.slice(0, 8)} · potsherd-alpha · claude · 3 exchanges · 2026-08-01`,
  '  "a passage that a citation which resolves is carrying"',
  'HANDOFF.md §3 · potsherd · claude · — exchanges · —',
  '  "the payment gate was cut from scope"',
  '— · potsherd · claude · — exchanges · 2026-06-03',
  '  "the project started on 3 June"',
  `${ABSENT_ID8} · potsherd · claude · 12 exchanges · 2026-06-03`,
  '  "and the first commit was two months before that"',
].join('\n');

describe('the v1.1.0 behaviour this replaces', () => {
  /**
   * There was exactly one citation check in v1.1.0 and it is `CITATION_RE` —
   * the `[id8@seq]` pattern that `graft` resolves against the index and that
   * `filterAnswer` runs the same discipline on for `ask`. It is a good check.
   * It simply cannot see a `SOURCES` block, because a `SOURCES` block does not
   * contain the thing it looks for.
   */
  it('the only citation check that existed finds nothing in the audit block', () => {
    const matches = AUDIT_FAILING_SOURCES.match(new RegExp(CITATION_RE.source, 'gi')) ?? [];
    expect(matches).toEqual([]);
  });

  it('so every fabricated row survives it, character for character', () => {
    // `graft`'s rule is *cited or dropped*: a line holding no citation that
    // resolves is dropped, a line holding NO citation at all is left alone as
    // ordinary prose. A source row holds no `id8@seq`, so it is prose, so it
    // is kept. That is not a bug in `graft`; it is the level the check runs at.
    const uncited = AUDIT_FAILING_SOURCES.split('\n').filter(
      (l) => !new RegExp(CITATION_RE.source, 'i').test(l),
    );
    expect(uncited.join('\n')).toContain('HANDOFF.md §3');
    expect(uncited.join('\n')).toContain('the project started on 3 June');
  });
});

describe('F3 — the refusal, in code', () => {
  it('refuses a source line citing a file that is not a session', () => {
    const verdict = verifySources(db, AUDIT_FAILING_SOURCES);

    const refusedFields = verdict.refused.map((r) => `${r.field}:${String(r.reason)}`).sort();
    expect(refusedFields).toEqual([
      '—:no-id',
      `${ABSENT_ID8}:unresolved`,
      '§3:not-an-id',
    ].sort());

    // And the audit's own two artefacts are gone from the text entirely.
    expect(verdict.text).not.toContain('HANDOFF.md');
    expect(verdict.text).not.toContain('the project started on 3 June');
    expect(verdict.text).not.toContain(ABSENT_ID8);
  });

  it('keeps the row that resolves, so the check is a check and not a switch', () => {
    const verdict = verifySources(db, AUDIT_FAILING_SOURCES);
    expect(verdict.kept).toHaveLength(1);
    expect(verdict.kept[0]!.sessionId).toBe(IDS.alive);
    expect(verdict.text).toContain('a passage that a citation which resolves is carrying');
  });

  it('takes the quote hanging under a refused row down with it', () => {
    // `00-README.md`'s rule, one level up: an uncited claim about the user's
    // own history is worse than a missing one. A quote whose citation was
    // refused is an uncited claim.
    const verdict = verifySources(db, AUDIT_FAILING_SOURCES);
    expect(verdict.text).not.toContain('the payment gate was cut from scope');
    expect(verdict.refused.every((r) => r.carried === 1)).toBe(true);
  });

  it('names its fix in the refusal note, and says how many', () => {
    const verdict = verifySources(db, AUDIT_FAILING_SOURCES);
    expect(verdict.note).toMatch(/3 source lines refused/);
    expect(verdict.note).toMatch(/potsherd_recall or potsherd_read/);
  });

  it('does not eat prose that merely contains a middle dot', () => {
    // The first version of this check refused `graft`'s own
    // `source: <harness> <id> · <n> exchanges · <date>` footer — a true line,
    // deleted. Deleting a true line is a worse failure than the one being
    // fixed, so both shapes are pinned here.
    const prose = [
      'We looked at pgbouncer · pgcat · supavisor and picked the first.',
      'a · b · c',
      `source: claude ${IDS.alive} · 3 exchanges · 2026-08-01`,
    ].join('\n');
    expect(sourceFieldOf(prose.split('\n')[0]!)).toBeNull();
    expect(sourceFieldOf(prose.split('\n')[1]!)).toBeNull();
    const verdict = verifySources(db, prose);
    expect(verdict.refused).toEqual([]);
    expect(verdict.text).toBe(prose);
  });

  it('a minted citation always survives its own check', () => {
    // The two halves have to agree, or the product refuses its own receipts.
    const line = mintCitation({
      sessionId: IDS.alive,
      kind: 'session',
      harness: 'claude',
      project: '/tmp/potsherd-alpha',
      exchanges: 3,
      prompts: 3,
      date: '2026-08-01',
    });
    const verdict = verifySources(db, line);
    expect(verdict.refused).toEqual([]);
    expect(verdict.kept).toHaveLength(1);
  });

  it('refuses a ghost row whose id does not resolve, and keeps one that does', () => {
    // The ghost shape carries `ghost, prompts only` where a session carries
    // `<n> exchanges`, so the grammar has to recognise both or every deleted
    // session becomes uncitable — which would be the one class of source this
    // product exists to make citable.
    const good = mintCitation({
      sessionId: IDS.sdk,
      kind: 'ghost',
      harness: 'claude',
      project: '/tmp/potsherd-beta',
      exchanges: 0,
      prompts: 4,
      date: '2026-07-02',
    });
    expect(good).toContain('ghost, prompts only');
    const bad = good.replace(IDS.sdk.slice(0, 8), ABSENT_ID8);
    const verdict = verifySources(db, [good, bad].join('\n'));
    expect(verdict.kept.map((r) => r.sessionId)).toEqual([IDS.sdk]);
    expect(verdict.refused.map((r) => r.reason)).toEqual(['unresolved']);
  });
});

// -------------------------------------------------------- the other half of F3

const PLUGIN = path.join(repo, 'plugins', 'claude-code');
const AGENT = path.join(PLUGIN, 'agents', 'session-archaeologist.md');
const SKILLS = path.join(PLUGIN, 'skills');

function frontmatter(file: string): Record<string, string> {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error(`no frontmatter in ${file}`);
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    if (line.startsWith('#') || !line.includes(':')) continue;
    const key = line.slice(0, line.indexOf(':')).trim();
    if (!/^[a-z-]+$/.test(key)) continue;
    out[key] = line.slice(line.indexOf(':') + 1).trim();
  }
  return out;
}

describe('the archaeologist cannot read the filesystem', () => {
  it('Read is gone from its tool list, and stays gone', () => {
    const tools = frontmatter(AGENT)['tools'] ?? '';
    const names = tools.split(',').map((t) => t.trim()).filter(Boolean);

    // The assertion the audit asked for, stated as a set rather than a
    // substring so that `Read` cannot come back as `Read, Glob` or as an
    // `allowed-tools` line somewhere else in the file.
    expect(names).not.toContain('Read');
    expect(names.some((n) => /^(Read|Glob|Grep|Bash|Write|Edit)$/.test(n))).toBe(false);
    expect(fs.readFileSync(AGENT, 'utf8')).not.toMatch(/^\s*allowed-tools:/m);
  });

  it('holds exactly the two potsherd tools a windowing subagent needs', () => {
    const names = (frontmatter(AGENT)['tools'] ?? '')
      .split(',')
      .map((t) => t.trim().split('__').pop() ?? '')
      .filter(Boolean)
      .sort();
    expect(names).toEqual(['potsherd_read', 'potsherd_recall']);
  });

  it('is told, in the file, that it does not draw conclusions', () => {
    // A PROMPT constraint, and named as one in T10.6-REPORT.md. F3 is the
    // proof that prompts do not hold; what holds here is the tool list above.
    const text = fs.readFileSync(AGENT, 'utf8');
    expect(text).toContain('**No conclusions.**');
    expect(text).toContain('Delegate\ncontext, never judgement');
  });

  it('is told to copy a citation rather than compose one', () => {
    const text = fs.readFileSync(AGENT, 'utf8');
    expect(text).toMatch(/minted by potsherd from its own index/);
    expect(text).toMatch(/refused by potsherd's code/);
  });
});

describe('one model-invocable skill', () => {
  const skills = fs
    .readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(SKILLS, e.name, 'SKILL.md'))
    .filter((f) => fs.existsSync(f));

  it('is exactly one, and it is remembering-sessions', () => {
    const invocable = skills.filter(
      (f) => (frontmatter(f)['disable-model-invocation'] ?? 'false') !== 'true',
    );
    expect(invocable.map((f) => path.basename(path.dirname(f)))).toEqual(['remembering-sessions']);
  });

  it('the human CLI skill keeps its verbs and its human-only flag', () => {
    const human = path.join(SKILLS, 'potsherd', 'SKILL.md');
    expect(frontmatter(human)['disable-model-invocation']).toBe('true');
    // §B7: "the human CLI keeps its 20 verbs untouched". Untouched is the
    // assertion; the count is reported rather than pinned, because the plan's
    // own number is stale and correcting it in the repo is not this task.
    const routing = fs.readFileSync(human, 'utf8').match(/^\| `[a-z]/gm) ?? [];
    expect(routing.length).toBeGreaterThan(10);
  });

  it('exactly one description is uncommented in the frontmatter', () => {
    const file = path.join(SKILLS, 'remembering-sessions', 'SKILL.md');
    const fm = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(file, 'utf8'))![1]!;
    const live = fm.split('\n').filter((l) => /^description:/.test(l));
    const parked = fm.split('\n').filter((l) => /^#\s*description:/.test(l));
    expect(live).toHaveLength(1);
    expect(parked).toHaveLength(2);
  });

  it('the self-defeating "once is enough" instruction is gone', () => {
    // Audit F7: combined with a retrieval layer that returned noise, the first
    // dispatch was the only dispatch, and the skill forbade the retry that
    // would have worked with better keywords.
    const text = fs.readFileSync(path.join(SKILLS, 'remembering-sessions', 'SKILL.md'), 'utf8');
    // It survives in the file exactly once, inside the sentence that records
    // its deletion. Keeping the history is the point; keeping the instruction
    // is what is forbidden, so the assertion is on the instruction form.
    expect(text.match(/Once is enough/g) ?? []).toHaveLength(1);
    expect(text).toMatch(/This skill used to say \*"You already dispatched the\n   archaeologist/);
    expect(text).not.toMatch(/^- You already dispatched the archaeologist/m);
    expect(text).toMatch(/Search up to three times, with different nouns each time/);
  });

  it('sends the main-loop agent to potsherd_recall directly', () => {
    const text = fs.readFileSync(path.join(SKILLS, 'remembering-sessions', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/\*\*Search it yourself\. `potsherd_recall`\.\*\*/);
    // And the fork-into-the-subagent dispatch is removed, not merely parked.
    expect(text).not.toMatch(/^context: fork/m);
    expect(text).not.toMatch(/^agent: session-archaeologist/m);
  });
});
