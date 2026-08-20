import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { db as store, Theme, type Exchange } from '@potsherd/core';
import {
  MASK_RE,
  maskFor,
  redact,
  redactExchange,
  redactText,
  redactionRow,
  redactionLine,
  secretDigest,
  shannonEntropy,
  tally,
  emptyCounts,
  addCounts,
  countsJson,
  RULES,
  SECRET_TYPES,
  type SecretType,
} from '../packages/core/src/redact.js';

// redact.ts is deliberately not re-exported from `packages/core/src/index.ts`
// yet: T1.4 ships the module, T1.5 wires it into the parser, the store and the
// cli. Importing the source directly keeps those two changes separable.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'secrets');
const PLANTED = fs.readFileSync(path.join(FIXTURES, 'planted.jsonl'), 'utf8');
const CLEAN = fs.readFileSync(path.join(FIXTURES, 'clean.txt'), 'utf8');

/** Every string in a parsed record, the way the store will hand them over. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

function records(): Array<Record<string, unknown>> {
  return PLANTED.split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('planted fixture', () => {
  it('masks all six planted secrets, each with the right type', () => {
    const { hits } = redact(PLANTED);
    expect(hits.map((h) => h.type)).toEqual([
      'aws',
      'github',
      'jwt',
      'private-key',
      'generic',
      'entropy',
    ]);
    expect(hits).toHaveLength(6);
  });

  it('reports the type the fixture says to expect, record by record', () => {
    const seen: Array<string | undefined> = [];
    for (const rec of records()) {
      const hits = strings(rec).flatMap((s) => redact(s).hits);
      // The manifest and the two unplanted records must produce nothing at all.
      const expected = rec['_expect'] as string | undefined;
      if (expected === undefined) {
        expect(hits, `unplanted record ${JSON.stringify(rec['seq'] ?? 'manifest')}`).toEqual([]);
        continue;
      }
      expect(hits.map((h) => h.type)).toEqual([expected]);
      seen.push(expected);
    }
    expect(seen).toEqual(['aws', 'github', 'jwt', 'private-key', 'generic', 'entropy']);
  });

  it('leaves no fragment of any planted secret in the output', () => {
    const out = redact(PLANTED).text;
    for (const needle of [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_FAKE',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'BEGIN RSA PRIVATE KEY',
      'Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC',
      '9pV2kR8mZ4tL6wY0bN3cX5hJ1qA7sD-fG_eK2uT',
    ]) {
      expect(out).not.toContain(needle);
    }
    // …and the context around them survives, because a redacted transcript
    // that reads as nonsense is not worth indexing.
    expect(out).toContain('the deploy is failing on the upload step');
    expect(out).toContain('TOKEN=‹redacted:generic:');
  });
});

describe('clean fixture', () => {
  it('is 200 lines', () => {
    expect(CLEAN.replace(/\n$/, '').split('\n')).toHaveLength(200);
  });

  it('produces zero false positives', () => {
    const { hits, text } = redact(CLEAN);
    // Print what tripped, not just the count: a bare `expected 3 to be 0` on a
    // 200-line fixture is a bad half hour for whoever tuned the rule.
    const detail = hits.map((h) => `${h.type}/${h.rule}: ${CLEAN.slice(h.start, h.start + h.length)}`);
    expect(detail).toEqual([]);
    expect(text).toBe(CLEAN);
  });

  it('leaves the shapes that usually trip scanners byte-for-byte', () => {
    const out = redactText(CLEAN);
    for (const shape of [
      '9fceb02d0ae598e95dc970b74767f19372d61af8', // git sha1
      '550e8400-e29b-41d4-a716-446655440000', // uuid
      'data:image/png;base64,iVBORw0KGgo', // inlined png
      'sha512-Rt2wIrKPHKgf', // lockfile integrity
      'focus-visible:outline-offset-2', // tailwind
      '/var/folders/9k/j7q0x2rn1qv5w8t3b6c4d1m00000gn/T', // long path
      'consectetur adipiscing elit', // lorem ipsum
      'Xenova/bge-small-en-v1.5', // a model id next to `tokenizer:`
    ]) {
      expect(out).toContain(shape);
    }
  });
});

describe('the mask', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('is ‹redacted:<type>:<sha8>› with sha8 = the sha256 prefix', () => {
    const { text, hits } = redact(`aws_access_key_id ${SECRET}`);
    const sha8 = createHash('sha256').update(SECRET).digest('hex').slice(0, 8);
    expect(text).toBe(`aws_access_key_id ‹redacted:aws:${sha8}›`);
    expect(hits[0]?.sha8).toBe(sha8);
    expect(secretDigest(SECRET)).toBe(sha8);
    expect(maskFor('aws', SECRET)).toBe(`‹redacted:aws:${sha8}›`);
    expect(text.match(MASK_RE)).toHaveLength(1);
  });

  it('maps the same secret to the same mask wherever it appears', () => {
    const a = redact(`first sighting: ${SECRET}`);
    const b = redact(`months later, in another project, ${SECRET} again`);
    const mask = maskFor('aws', SECRET);
    expect(a.text).toContain(mask);
    expect(b.text).toContain(mask);
    expect(a.hits[0]?.sha8).toBe(b.hits[0]?.sha8);
  });

  it('never maps two different secrets to the same mask', () => {
    const masks = new Set<string>();
    const digests = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const secret = `AKIA${String(i).padStart(4, '0')}FAKEFAKEFAKE`;
      const { text, hits } = redact(secret);
      masks.add(text);
      digests.add(hits[0]?.sha8 ?? '');
    }
    expect(masks.size).toBe(500);
    expect(digests.size).toBe(500);
  });

  it('uses guillemets, which cannot occur in a shell token or a base64 blob', () => {
    const mask = maskFor('jwt', 'anything');
    expect(mask.startsWith('‹')).toBe(true);
    expect(mask.endsWith('›')).toBe(true);
    expect(/[‹›]/.test(CLEAN)).toBe(false);
  });

  it('survives fts5 tokenisation as three searchable tokens', () => {
    // The claim in redact.ts's header, checked against the sqlite this repo
    // actually ships rather than against the documentation.
    const db = store.open({ file: ':memory:' });
    try {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(body)');
      const mask = maskFor('aws', SECRET);
      const sha8 = secretDigest(SECRET);
      db.prepare('INSERT INTO t(body) VALUES (?)').run(`the deploy used ${mask} again`);
      db.prepare('INSERT INTO t(body) VALUES (?)').run(`unrelated ${maskFor('jwt', 'other')} row`);

      db.exec("CREATE VIRTUAL TABLE vocab USING fts5vocab(t, 'row')");
      const terms = db.prepare('SELECT term FROM vocab ORDER BY term').all() as Array<{ term: string }>;
      expect(terms.map((r) => r.term)).toContain(sha8);
      expect(terms.map((r) => r.term)).toContain('redacted');
      expect(terms.map((r) => r.term)).toContain('aws');

      const hit = (q: string) => (db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(q) as Array<{ rowid: number }>).map((r) => r.rowid);
      // searchable by shape…
      expect(hit(sha8)).toEqual([1]);
      expect(hit('redacted AND aws')).toEqual([1]);
      expect(hit(`"redacted:aws:${sha8}"`)).toEqual([1]);
      expect(hit('redacted')).toEqual([1, 2]);
      // …and never by value.
      expect(hit(SECRET.toLowerCase())).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('idempotence', () => {
  const inputs: Array<[string, string]> = [
    ['planted fixture', PLANTED],
    ['clean fixture', CLEAN],
    ['one secret', 'export GITHUB_TOKEN=ghp_' + 'FAKE'.repeat(9)],
    ['two of the same', `${'AKIAIOSFODNN7EXAMPLE'} and again ${'AKIAIOSFODNN7EXAMPLE'}`],
  ];

  for (const [name, input] of inputs) {
    it(`redact(redact(x)) === redact(x) — ${name}`, () => {
      const once = redact(input);
      const twice = redact(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.hits).toEqual([]);
      // Three passes, because the second pass is where a mask that re-matched
      // itself would first show up.
      expect(redact(twice.text).text).toBe(once.text);
    });
  }
});

describe('rules', () => {
  const positives: Array<[SecretType, string, string]> = [
    ['aws', 'AKIAIOSFODNN7EXAMPLE', 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE'],
    ['aws', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['gcp', `AIza${'FAKE'.repeat(8)}FAK`, `firebase key AIza${'FAKE'.repeat(8)}FAK in the config`],
    ['gcp', `GOCSPX-${'A'.repeat(28)}`, `client_secret is GOCSPX-${'A'.repeat(28)}`],
    ['github', `ghp_${'FAKE'.repeat(9)}`, `gh auth login --with-token <<< ghp_${'FAKE'.repeat(9)}`],
    ['github', `github_pat_${'A'.repeat(82)}`, `header: github_pat_${'A'.repeat(82)}`],
    ['slack', 'xoxb-0123456789-0123456789-FAKEFAKEFAKE', 'SLACK_BOT=xoxb-0123456789-0123456789-FAKEFAKEFAKE'],
    ['slack', 'https://hooks.slack.com/services/T00000000/B00000000/FAKEFAKEFAKEFAKE', 'posting to https://hooks.slack.com/services/T00000000/B00000000/FAKEFAKEFAKEFAKE'],
    ['stripe', `sk_test_${'FAKE'.repeat(6)}`, `stripe.setKey("sk_test_${'FAKE'.repeat(6)}")`],
    ['openai', `sk-proj-${'A'.repeat(20)}T3BlbkFJ${'B'.repeat(20)}`, `OPENAI_API_KEY=sk-proj-${'A'.repeat(20)}T3BlbkFJ${'B'.repeat(20)}`],
    ['openai', `sk-${'A'.repeat(48)}`, `legacy key sk-${'A'.repeat(48)} still in the file`],
    ['anthropic', `sk-ant-api03-${'F'.repeat(95)}`, `ANTHROPIC_API_KEY=sk-ant-api03-${'F'.repeat(95)}`],
    ['npm', `npm_${'FAKE'.repeat(9)}`, `//registry.npmjs.org/:_authToken=npm_${'FAKE'.repeat(9)}`],
    ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMCIsImlhdCI6MX0.QNOTAREALSIGNATURE_0123456789', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMCIsImlhdCI6MX0.QNOTAREALSIGNATURE_0123456789'],
    ['basic-auth', '9pV2kR8mZ4tL6wY0', 'psql postgresql://svc:9pV2kR8mZ4tL6wY0@db.internal:5432/app'],
    ['generic', 'Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC', 'API_KEY="Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC"'],
    ['generic', 'Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC', '{"clientSecret": "Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC"}'],
    ['entropy', '9pV2kR8mZ4tL6wY0bN3cX5hJ1qA7sD-fG_eK2uT', 'X-Session-Id: 9pV2kR8mZ4tL6wY0bN3cX5hJ1qA7sD-fG_eK2uT'],
  ];

  for (const [type, secret, line] of positives) {
    it(`masks ${type}: ${secret.slice(0, 18)}…`, () => {
      const { text, hits } = redact(line);
      expect(hits.map((h) => h.type)).toEqual([type]);
      expect(text).not.toContain(secret);
      expect(text).toContain(maskFor(type, secret));
    });
  }

  it('masks a private key block whole, header to footer', () => {
    const block = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'RkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtF',
      'WUZBS0VLRVlGQUtFS0VZRkFLRUtFWUZBS0VLRVlUSElTSVNOT1RBS0VZAAAAAAAA',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const { text, hits } = redact(`the file holds:\n${block}\nand nothing else`);
    expect(hits.map((h) => h.type)).toEqual(['private-key']);
    expect(text).toBe(`the file holds:\n${maskFor('private-key', block)}\nand nothing else`);
  });

  it('masks an unterminated key block without eating the sentence after it', () => {
    const body = 'RkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtF';
    const { text, hits } = redact(
      `-----BEGIN RSA PRIVATE KEY-----\n${body}\n(elided)\nand then I rotated it and moved on`,
    );
    expect(hits.map((h) => h.type)).toEqual(['private-key']);
    expect(text).not.toContain(body);
    expect(text).toContain('and then I rotated it and moved on');
  });

  it('still fires on a plural name — apiKeys is not a stopword', () => {
    const { hits } = redact('apiKeys = "Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC"');
    expect(hits.map((h) => h.type)).toEqual(['generic']);
  });

  const negatives: string[] = [
    'const tokenizer = new Tokenizer({ model: "Xenova/bge-small-en-v1.5" });',
    'password: formData.password,',
    'const hashedPassword = await bcrypt.hash(plaintext, 12);',
    'export GITHUB_TOKEN=$GITHUB_TOKEN',
    'NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
    'API_KEY=your-api-key-here',
    'apiKey: process.env.API_KEY',
    'Authorization: Bearer ${token}',
    'the monkey: donkey-whiskey-turkey-jockey',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'session 550e8400-e29b-41d4-a716-446655440000 resumed',
    'psql "postgresql://app:${DB_PASSWORD}@db.internal:5432/app"',
    'curl -u user:pass https://proxy.internal:3128/status',
    '"integrity": "sha512-Rt2wIrKPHKgfQOWTKBrAQCP0oGnMhOOKOZBnKpGkbn/GRnEXAqTIrCXtIWKKe0Ai"',
    'pk_live_51H8xKzFAKEFAKEFAKEFAKEFAKE is publishable by design',
    'apiKey: string;',
    'let apiKey: Promise<string> = resolveKey();',
  ];

  for (const line of negatives) {
    it(`leaves alone: ${line.slice(0, 44)}`, () => {
      expect(redact(line).hits).toEqual([]);
    });
  }

  it('every rule names the upstream pack it was ported from', () => {
    for (const rule of RULES) {
      expect(rule.source, rule.id).toMatch(/gitleaks|secretlint|03 §5/);
      expect(rule.source, rule.id).toMatch(/MIT|03 §5/);
      expect(SECRET_TYPES).toContain(rule.type);
    }
    // Every family in `03` §5 has at least one rule.
    const covered = new Set(RULES.map((r) => r.type));
    for (const t of SECRET_TYPES) expect(covered, `no rule for ${t}`).toContain(t);
  });
});

describe('entropy', () => {
  it('is bits per character, capped by the sample length', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 6);
    // 20 chars can hold at most log2(20) = 4.32 bits, which is why the 4.5
    // threshold in `03` §5 cannot fire below 23 characters.
    expect(shannonEntropy('abcdefghijklmnopqrst')).toBeLessThan(4.5);
  });

  it('is under threshold for hex digests and uuids at any length', () => {
    expect(shannonEntropy('9fceb02d0ae598e95dc970b74767f19372d61af8')).toBeLessThan(4.5);
    expect(shannonEntropy('550e8400-e29b-41d4-a716-446655440000')).toBeLessThan(4.5);
  });
});

describe('exchanges', () => {
  const base = (): Exchange => ({
    id: 'x1',
    sessionId: 's1',
    seq: 1,
    ts: '2026-08-19T09:00:00.000Z',
    userText: 'why is the deploy failing',
    assistantText: `the workflow has a literal: ghp_${'FAKE'.repeat(9)}`,
    toolCalls: [
      { name: 'Bash', input: '{"command":"cat runner.env"}', result: 'TOKEN=Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC' },
      { name: 'Read', input: '{"file_path":"/tmp/app/deploy.sh"}' },
    ],
    filesTouched: ['/tmp/app/deploy.sh'],
    isSidechain: false,
    redacted: false,
  });

  it('masks every field 03 §5 names and sets exchanges.redacted', () => {
    const input = base();
    const { exchange, hits } = redactExchange(input);
    expect(hits.map((h) => h.type)).toEqual(['github', 'generic']);
    expect(exchange.redacted).toBe(true);
    expect(exchange.assistantText).not.toContain('ghp_');
    expect(exchange.toolCalls[0]?.result).not.toContain('Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC');
    expect(exchange.toolCalls[0]?.result).toContain('TOKEN=‹redacted:generic:');
    // The tool call with nothing to hide keeps its shape, `result` included.
    expect(exchange.toolCalls[1]).toEqual(input.toolCalls[1]);
  });

  it('never mutates the input — the archive copy is written from it', () => {
    const input = base();
    const before = JSON.stringify(input);
    redactExchange(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('leaves a clean exchange unflagged', () => {
    const clean: Exchange = { ...base(), assistantText: 'nothing secret here', toolCalls: [] };
    const { exchange, hits } = redactExchange(clean);
    expect(hits).toEqual([]);
    expect(exchange.redacted).toBe(false);
  });
});

describe('doctor', () => {
  const t = new Theme({ color: false, ascii: false, width: 80 });

  it('counts by type', () => {
    const counts = tally(redact(PLANTED).hits);
    expect(counts.total).toBe(6);
    expect(counts.byType.aws).toBe(1);
    expect(counts.byType.jwt).toBe(1);
    expect(counts.byType.slack).toBe(0);
    expect(countsJson(counts)).toEqual({
      total: 6,
      aws: 1,
      github: 1,
      jwt: 1,
      'private-key': 1,
      generic: 1,
      entropy: 1,
    });
  });

  it('adds two tallies without double counting', () => {
    const a = tally(redact(PLANTED).hits);
    const sum = addCounts(a, a);
    expect(sum.total).toBe(12);
    expect(sum.byType.aws).toBe(2);
    expect(addCounts(a, emptyCounts())).toEqual(a);
  });

  it('renders one row in the house style, biggest type first', () => {
    const counts = emptyCounts();
    counts.byType.jwt = 512;
    counts.byType.entropy = 402;
    counts.byType.aws = 12;
    counts.total = 926;
    const row = redactionRow(counts, t);
    expect(row.label).toBe('secrets masked');
    expect(row.value).toBe('926');
    expect(row.note).toBe('jwt 512 · entropy 402 · aws 12');
    expect(redactionLine(counts, t)).toContain('secrets masked');
  });

  it('says so plainly when nothing matched', () => {
    const row = redactionRow(emptyCounts(), t);
    expect(row.value).toBe('0');
    expect(row.note).toContain('nothing matched');
  });
});

describe('performance', () => {
  it('redacts 10 MB in the time an index pass can afford', () => {
    // The redactor runs over the whole corpus at index time, so a pathological
    // regex shows up as a minutes-long `potsherd index`. `03` §12 budgets 3
    // minutes for a full index of 350 MB *including embeddings*; redaction has
    // to be a rounding error against that.
    const chunk = `${CLEAN}\n${CLEAN}\n${PLANTED}`;
    let big = '';
    while (big.length < 10 * 1024 * 1024) big += chunk;
    big = big.slice(0, 10 * 1024 * 1024);

    const t0 = performance.now();
    const { hits } = redact(big);
    const ms = performance.now() - t0;
    const mbps = 10 / (ms / 1000);
    // eslint-disable-next-line no-console
    console.log(`  redact: 10 MB in ${ms.toFixed(0)} ms (${mbps.toFixed(1)} MB/s), ${hits.length} hits`);
    expect(hits.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(10_000);
  });

  it('does not backtrack on the shapes that hang naive scanners', () => {
    const evil = [
      `-----BEGIN RSA PRIVATE KEY-----${'A'.repeat(200_000)}`,
      `ey${'A'.repeat(50_000)}.ey${'B'.repeat(50_000)}`,
      `TOKEN=${'x'.repeat(100_000)}`,
      `https://${'a'.repeat(50_000)}:${'b'.repeat(50_000)}`,
      'a'.repeat(500_000),
      `${'aXbYcZ9'.repeat(3)} `.repeat(20_000),
    ];
    const t0 = performance.now();
    for (const s of evil) redact(s);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
