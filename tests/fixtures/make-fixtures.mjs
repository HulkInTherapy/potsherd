#!/usr/bin/env node
/**
 * Regenerates tests/fixtures/claude/. The output is committed; this script
 * exists so the fixture is reproducible and reviewable rather than a blob
 * somebody pasted once.
 *
 * The fixture is deliberately tiny and entirely synthetic: CI must be able to
 * prove the parser works without anyone's private transcripts. It covers, per
 * plans/06-QUALITY-AND-EVALS.md:
 *
 *   - one titled session whose ai-title was rewritten 5 times
 *   - one SDK session (entrypoint sdk-ts) with no title at all
 *   - two sidechains, one under <session>/subagents/ and one under
 *     <project>/subagents/, because both layouts exist and neither is a session
 *   - one sessions-index.json and one memory/ note
 *   - a history.jsonl holding 3 sessions with no transcript left (the ghosts),
 *     each opening with a prompt that names nothing — a slash command, a
 *     stoplist word, a short word — which is what phase 8.2 is about
 *   - every record type observed in the real corpus, including the ones that
 *     carry no timestamp
 *
 *   node tests/fixtures/make-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'claude');

// `sessions-index.json` records an absolute path. Writing the real one would
// bake this checkout's location into a committed file, so the fixture would
// differ on every machine and CI's reproducibility check could never pass.
// Nothing reads this field; a stable fake keeps the fixture byte-identical
// everywhere.
const NOTIONAL_HOME = '/home/dev/.claude';

const ALIVE = '11111111-1111-4111-8111-111111111111';
const SDK = '22222222-2222-4222-8222-222222222222';
const GHOST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GHOST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GHOST_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ALPHA = '/tmp/potsherd-alpha';
const BETA = '/tmp/potsherd-beta';
const GAMMA = '/tmp/potsherd-gamma';

const slug = (p) => p.replace(/\//g, '-');
const ms = (iso) => Date.parse(iso);

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'projects', slug(ALPHA)), { recursive: true });
fs.mkdirSync(path.join(root, 'projects', slug(BETA)), { recursive: true });
fs.mkdirSync(path.join(root, 'projects', slug(ALPHA), 'memory'), { recursive: true });
fs.mkdirSync(path.join(root, 'projects', slug(ALPHA), ALIVE, 'subagents'), { recursive: true });
// The second sidechain layout, described by plans/phases/phase-0-rescue.md T0.1:
// subagents/ directly under the project dir rather than under a session dir.
fs.mkdirSync(path.join(root, 'projects', slug(BETA), 'subagents'), { recursive: true });

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

// ---------------------------------------------------------------- alive session
const base = {
  sessionId: ALIVE,
  cwd: ALPHA,
  version: '2.1.237',
  gitBranch: 'main',
  userType: 'external',
  entrypoint: 'cli',
  isSidechain: false,
};

const aliveRecords = [
  // Records with no timestamp and no cwd come first in a real transcript.
  { type: 'last-prompt', leafUuid: 'u0', sessionId: ALIVE },
  { type: 'mode', mode: 'normal', sessionId: ALIVE },
  { type: 'permission-mode', permissionMode: 'default', sessionId: ALIVE },
  {
    ...base,
    type: 'attachment',
    uuid: 'u1',
    parentUuid: null,
    timestamp: '2026-08-01T09:00:00.000Z',
    attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: 'OK' },
  },
  {
    ...base,
    type: 'user',
    uuid: 'u2',
    parentUuid: 'u1',
    promptId: 'p1',
    timestamp: '2026-08-01T09:00:05.000Z',
    message: { role: 'user', content: 'how do we pin the pgbouncer prepared-statement setting?' },
  },
  {
    ...base,
    type: 'assistant',
    uuid: 'u3',
    parentUuid: 'u2',
    requestId: 'r1',
    timestamp: '2026-08-01T09:00:12.000Z',
    message: {
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [
        { type: 'text', text: 'Set statement_cache_size to 0 and use transaction pooling.' },
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${ALPHA}/db/pool.ts` } },
      ],
    },
  },
  {
    // A tool result is also type:"user" — this is the record that made an
    // earlier count of "prompts typed" 3x too high. It has no promptId.
    ...base,
    type: 'user',
    uuid: 'u4',
    parentUuid: 'u3',
    timestamp: '2026-08-01T09:00:13.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    toolUseResult: { filePath: `${ALPHA}/db/pool.ts` },
  },
  { type: 'file-history-snapshot', messageId: 'u3', snapshot: { trackedFileBackups: {} } },
  {
    ...base,
    type: 'user',
    uuid: 'u5',
    parentUuid: 'u4',
    promptId: 'p2',
    timestamp: '2026-08-01T09:05:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] },
  },
  {
    ...base,
    type: 'assistant',
    uuid: 'u6',
    parentUuid: 'u5',
    requestId: 'r2',
    timestamp: '2026-08-01T09:05:20.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done, pushed to main.' }] },
  },
  { type: 'queue-operation', operation: 'drain', sessionId: ALIVE },
  { type: 'atis-latch', sessionId: ALIVE },
  { type: 'system', subtype: 'compact_boundary', sessionId: ALIVE },
  { type: 'summary', summary: 'pgbouncer pooling', leafUuid: 'u6' },
];

// The title is rewritten as the session runs; only the last one counts.
for (const [i, title] of [
  'pgbouncer',
  'pgbouncer settings',
  'fix pgbouncer prepared statements',
  'pgbouncer prepared statements and pooling',
  'Pin pgbouncer prepared-statement handling',
].entries()) {
  aliveRecords.push({
    type: 'ai-title',
    sessionId: ALIVE,
    aiTitle: title,
    timestamp: `2026-08-01T09:0${i}:30.000Z`,
  });
}

fs.writeFileSync(
  path.join(root, 'projects', slug(ALPHA), `${ALIVE}.jsonl`),
  jsonl(aliveRecords),
);

// ------------------------------------------------------------------- sidechain
fs.writeFileSync(
  path.join(root, 'projects', slug(ALPHA), ALIVE, 'subagents', 'agent-01f3a5c7e9b2d4608.jsonl'),
  jsonl([
    { type: 'agent-name', sessionId: ALIVE, agentName: 'db-reviewer', isSidechain: true },
    {
      ...base,
      isSidechain: true,
      type: 'user',
      uuid: 's1',
      promptId: 'sp1',
      timestamp: '2026-08-01T09:01:00.000Z',
      message: { role: 'user', content: 'review the pool config for correctness' },
    },
    {
      ...base,
      isSidechain: true,
      type: 'assistant',
      uuid: 's2',
      parentUuid: 's1',
      timestamp: '2026-08-01T09:01:40.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Config is correct.' }] },
    },
  ]),
);

// The same file under the flatter layout. Neither potsherd nor
// scripts/verify-audit.py may ever count one of these as a session: a
// subagent transcript is part of its parent session, not a session of its own,
// and counting it would inflate "still on disk" and deflate "deleted".
fs.writeFileSync(
  path.join(root, 'projects', slug(BETA), 'subagents', 'agent-02e4b6d8fa1c3e579.jsonl'),
  jsonl([
    { type: 'agent-name', sessionId: SDK, agentName: 'changelog-reader', isSidechain: true },
    {
      sessionId: SDK,
      cwd: BETA,
      entrypoint: 'sdk-ts',
      isSidechain: true,
      type: 'user',
      uuid: 'q1',
      promptId: 'qp1',
      timestamp: '2026-08-02T11:00:02.000Z',
      message: { role: 'user', content: 'list the entries under 2.1.x' },
    },
    {
      sessionId: SDK,
      cwd: BETA,
      entrypoint: 'sdk-ts',
      isSidechain: true,
      type: 'assistant',
      uuid: 'q2',
      parentUuid: 'q1',
      timestamp: '2026-08-02T11:00:07.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Eleven entries.' }] },
    },
  ]),
);

// ----------------------------------------------------------------- sdk session
// entrypoint sdk-ts: never appears in history.jsonl and never gets an ai-title.
fs.writeFileSync(
  path.join(root, 'projects', slug(BETA), `${SDK}.jsonl`),
  jsonl([
    {
      sessionId: SDK,
      cwd: BETA,
      version: '2.1.237',
      entrypoint: 'sdk-ts',
      isSidechain: false,
      type: 'user',
      uuid: 'k1',
      promptId: 'kp1',
      timestamp: '2026-08-02T11:00:00.000Z',
      message: { role: 'user', content: 'summarise the changelog' },
    },
    {
      sessionId: SDK,
      cwd: BETA,
      entrypoint: 'sdk-ts',
      type: 'assistant',
      uuid: 'k2',
      parentUuid: 'k1',
      timestamp: '2026-08-02T11:00:09.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Three fixes, one feature.' }] },
    },
  ]),
);

// ------------------------------------------------------------ sessions-index
// Carries a title for GHOST_C, whose transcript is gone. This is the only place
// a deleted session's summary survives.
fs.writeFileSync(
  path.join(root, 'projects', slug(ALPHA), 'sessions-index.json'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        {
          sessionId: ALIVE,
          fullPath: `${NOTIONAL_HOME}/projects/${slug(ALPHA)}/${ALIVE}.jsonl`,
          fileMtime: ms('2026-08-01T09:05:20.000Z'),
          firstPrompt: 'how do we pin the pgbouncer prepared-statement setting?',
          summary: 'Pin pgbouncer prepared-statement handling',
          messageCount: 6,
          created: '2026-08-01T09:00:00.000Z',
          modified: '2026-08-01T09:05:20.000Z',
          gitBranch: 'main',
          projectPath: ALPHA,
          isSidechain: false,
        },
        {
          sessionId: GHOST_C,
          fullPath: `${NOTIONAL_HOME}/projects/${slug(ALPHA)}/${GHOST_C}.jsonl`,
          fileMtime: ms('2026-06-02T10:00:00.000Z'),
          firstPrompt: 'set up the alpha migration runner',
          summary: 'Alpha migration runner',
          messageCount: 12,
          created: '2026-06-02T09:00:00.000Z',
          modified: '2026-06-02T10:00:00.000Z',
          gitBranch: 'main',
          projectPath: ALPHA,
          isSidechain: false,
        },
      ],
    },
    null,
    2,
  ) + '\n',
);

fs.writeFileSync(
  path.join(root, 'projects', slug(ALPHA), 'memory', 'decisions.md'),
  '# decisions\n\n- transaction pooling, statement cache off\n',
);

// ----------------------------------------------------------------- history
// Four session ids: the live one, and three whose transcripts are gone.
//
// Each of the three ghosts *opens with a line that names nothing*, because on
// the reference machine 56% of them did and a fixture without that case cannot
// see phase 8.2's defect at all (`plans/phases/phase-8-hardening.md §8.2`).
// One per rule, so no rule can be deleted without a test going red:
//   GHOST_A  `/model`    the slash-command rule
//   GHOST_B  `continue`  the stoplist, at exactly 8 characters so the
//                        minimum-length rule cannot be what caught it
//   GHOST_C  `clear`     short *and* on the stoplist — and its only prompt, so
//                        its title has to come from sessions-index.json
// The line *count* is unchanged from the pre-8.2 fixture on purpose: `audit`'s
// arithmetic (prompts lost, prompts surviving, per-project totals) is pinned by
// tests elsewhere and this is a change to what the lines say, not how many.
const history = [
  { session: ALIVE, project: ALPHA, ts: '2026-08-01T09:00:05.000Z', text: 'how do we pin the pgbouncer prepared-statement setting?' },
  { session: ALIVE, project: ALPHA, ts: '2026-08-01T09:05:00.000Z', text: 'ship it' },
  { session: GHOST_A, project: GAMMA, ts: '2026-05-10T08:00:00.000Z', text: '/model' },
  { session: GHOST_A, project: GAMMA, ts: '2026-05-10T08:30:00.000Z', text: 'scaffold the gamma service' },
  { session: GHOST_A, project: GAMMA, ts: '2026-05-10T09:00:00.000Z', text: 'why is the retry budget 3?' },
  { session: GHOST_B, project: GAMMA, ts: '2026-05-11T08:00:00.000Z', text: 'continue' },
  { session: GHOST_B, project: GAMMA, ts: '2026-05-11T08:20:00.000Z', text: 'gamma deploy is failing on the health check' },
  { session: GHOST_C, project: ALPHA, ts: '2026-06-02T09:00:00.000Z', text: 'clear' },
];

fs.writeFileSync(
  path.join(root, 'history.jsonl'),
  history
    .map((h) =>
      JSON.stringify({
        display: h.text,
        pastedContents: {},
        timestamp: ms(h.ts),
        project: h.project,
        sessionId: h.session,
      }),
    )
    .join('\n') + '\n' +
    // A malformed line and a line with no sessionId: both occur in the wild and
    // neither may ever be fatal.
    '{"display":"orphan prompt with no session","timestamp":1747000000000,"project":"/tmp/potsherd-gamma"}\n' +
    'not json at all\n',
);

// ---------------------------------------------------------------- settings
fs.writeFileSync(
  path.join(root, 'settings.json'),
  JSON.stringify(
    {
      permissions: { allow: ['Read', 'Grep'] },
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo existing-hook-must-survive' }] },
        ],
      },
    },
    null,
    2,
  ) + '\n',
);

// mtimes decide who the sweep takes next; the test needs them to be stable.
const touch = (rel, iso) => {
  const p = path.join(root, rel);
  fs.utimesSync(p, new Date(iso), new Date(iso));
};
touch(`projects/${slug(ALPHA)}/${ALIVE}.jsonl`, '2026-08-01T09:05:20.000Z');
touch(`projects/${slug(BETA)}/${SDK}.jsonl`, '2026-08-02T11:00:09.000Z');

console.log(`fixture written to ${root}`);
