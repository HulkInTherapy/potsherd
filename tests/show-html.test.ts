import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexAll, rescue, escapeHtml } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * `potsherd show --html` — open item 7, closed in phase 7.
 *
 * The input to this renderer is somebody's transcript: arbitrary text a human
 * and a model wrote at each other, which is mostly code, and code is mostly
 * angle brackets. A session that contains `</script>` is not an attack, it is
 * Tuesday — and the file potsherd writes is one the user has been told is
 * theirs to open and to send to a colleague. So the escaping is not a
 * hardening exercise here; it is the correctness of the feature.
 *
 * Which is why the corpus below is written to break out rather than checked
 * against a synthetic string: a closing script tag, an `onerror` handler, a
 * `javascript:` URL, an HTML comment terminator, an unquoted attribute and a
 * CSS `</style>`, driven through the real parser, the real index and the
 * shipped binary.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');

let root = '';
let claudeDir = '';
const dirs: string[] = [];

const SESSION = '77777777-7777-4777-8777-777777777777';

/** Every one of these is a real thing somebody pastes into a coding agent. */
const HOSTILE = [
  '</script><script>alert(1)</script>',
  '<img src=x onerror="alert(document.domain)">',
  '<a href="javascript:alert(2)">click</a>',
  '--> <!-- comment breakout -->',
  '</style><style>body{display:none}</style>',
  `<div class=unquoted onclick=alert(3)>x</div>`,
  '<iframe src="https://example.invalid/beacon"></iframe>',
  '& &amp; &lt; " \'',
];

function writeHostileTranscript(dir: string): void {
  const project = path.join(dir, 'projects', '-tmp-potsherd-html');
  fs.mkdirSync(project, { recursive: true });
  const common = {
    sessionId: SESSION,
    cwd: '/tmp/potsherd-html',
    version: '2.1.240',
    gitBranch: 'main',
    userType: 'external',
    entrypoint: 'cli',
    isSidechain: false,
  };
  const lines = [
    JSON.stringify({
      ...common,
      type: 'ai-title',
      uuid: 't0',
      timestamp: '2026-08-06T09:00:00.000Z',
      aiTitle: '</title><script>alert("title")</script>',
    }),
    JSON.stringify({
      ...common,
      type: 'user',
      uuid: 'h1',
      parentUuid: null,
      promptId: 'hp1',
      timestamp: '2026-08-06T09:00:05.000Z',
      message: { role: 'user', content: HOSTILE.join('\n') },
    }),
    JSON.stringify({
      ...common,
      type: 'assistant',
      uuid: 'h2',
      parentUuid: 'h1',
      requestId: 'hr1',
      timestamp: '2026-08-06T09:00:12.000Z',
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [
          { type: 'text', text: 'Escaped: ' + HOSTILE.join(' ') },
          {
            type: 'tool_use',
            id: 'tu1',
            name: '<script>Read</script>',
            input: { file_path: '/tmp/potsherd-html/<img onerror=1>.ts' },
          },
        ],
      },
    }),
  ];
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), lines.join('\n') + '\n');
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [bin, ...args, '--potsherd-dir', root], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let html = '';

beforeAll(async () => {
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
  root = tempDir('potsherd-html-');
  claudeDir = tempDir('potsherd-html-claude-');
  dirs.push(root, claudeDir);
  writeHostileTranscript(claudeDir);
  await rescue({ claudeDir, root, quiet: true });
  await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
  html = run(['show', SESSION, '--html', '--claude-dir', claudeDir]).stdout;
  expect(html, 'show --html produced nothing').not.toBe('');
}, 180_000);

afterAll(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

describe('show --html', () => {
  it('is one self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  /**
   * The tags and attributes the document actually has.
   *
   * Asserted against the *markup*, not against the text, because the transcript
   * legitimately contains the characters `javascript:` and `https://…` — as
   * inert text inside a `<pre>`, which is exactly right. A test that grepped
   * the whole file for those strings would be testing that potsherd deletes
   * the user's transcript, which is a worse failure than the one it is looking
   * for. Every value in the document is escaped, so anything still matching
   * `<tag attr=` is markup this renderer emitted.
   */
  const markup = (): { tags: Set<string>; attrs: [string, string][] } => {
    const tags = new Set<string>();
    const attrs: [string, string][] = [];
    for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g)) {
      tags.add((m[1] as string).toLowerCase());
      for (const a of (m[2] as string).matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
        attrs.push([(a[1] as string).toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '']);
      }
    }
    return { tags, attrs };
  };

  it('reaches the network for nothing at all', () => {
    // Not "no external stylesheet" — nothing. A page displaying a private
    // transcript that fetched anything would contradict `doctor --privacy`,
    // in a file the user has already been told is theirs to share.
    const { tags, attrs } = markup();
    for (const t of ['link', 'img', 'iframe', 'script', 'object', 'embed', 'form', 'video']) {
      expect(tags.has(t), `document contains a <${t}> element`).toBe(false);
    }
    for (const [name, value] of attrs) {
      if (['src', 'href', 'action', 'data', 'srcset'].includes(name)) {
        expect(value, `${name} points somewhere`).toBe('');
      }
    }
    // The stylesheet is inline and fetches nothing either.
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    expect(css).not.toMatch(/@import|url\(/i);
    // And it says so in the document, so the guarantee travels with the file.
    expect(html).toContain("default-src 'none'");
  });

  it('contains no script and no event handler, from us or from the transcript', () => {
    const { tags, attrs } = markup();
    expect(tags.has('script')).toBe(false);
    for (const [name, value] of attrs) {
      expect(name.startsWith('on'), `event handler attribute ${name}`).toBe(false);
      expect(/^\s*javascript:/i.test(value), `${name} carries a javascript: URL`).toBe(false);
    }
    // Belt and braces: the transcript's four `<script` strings must all have
    // arrived escaped, so no unescaped one exists anywhere in the file.
    expect(html).not.toMatch(/<\/?script/i);
  });

  it('carries every hostile string through as visible text', () => {
    // Escaped, not dropped. A renderer that "sanitised" by deleting would pass
    // the test above and lose the user's transcript, which is worse.
    for (const s of HOSTILE) {
      expect(html, `missing: ${s}`).toContain(escapeHtml(s));
    }
  });

  it('escapes the title, which is written by a model and lands inside <title>', () => {
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;');
    // Exactly one real <title> element.
    expect([...html.matchAll(/<title>/g)]).toHaveLength(1);
  });

  it('escapes tool names and file paths, not only prose', () => {
    expect(html).toContain('&lt;script&gt;Read&lt;/script&gt;');
    expect(html).toContain('&lt;img onerror=1&gt;.ts');
  });

  it('refuses --md and --html together rather than silently preferring one', () => {
    const r = run(['show', SESSION, '--md', '--html', '--claude-dir', claudeDir]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--md or --html');
    expect(r.stderr).toContain('try:');
  });

  it('escapes the five characters and nothing else', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    expect(escapeHtml('plain text — with unicode ★')).toBe('plain text — with unicode ★');
    // & first, or `&lt;` becomes `&amp;lt;`.
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });
});
