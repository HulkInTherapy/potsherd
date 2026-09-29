import { testModelCache } from './model-cache.js';
import { expect, it } from 'vitest';
import fs from 'node:fs';
import { loadSpanTokenizer } from '../packages/core/src/memory/tokenization.js';
const cache=testModelCache('/nonexistent/potsherd-test-models');
it.skipIf(!fs.existsSync(cache+'/Xenova/bge-small-en-v1.5/tokenizer.json'))('uses only verified cached BGE assets and exact Unicode source boundaries', async () => {
 const tokenizer = await loadSpanTokenizer(cache);
 expect(tokenizer).not.toBeNull();
 if (!tokenizer) throw new Error('Cached tokenizer assets failed verification');
 for (const text of ['A cache_retry job recovered.','Café déjà vu, 日本語 中文。', 'The 😀 emoji is preserved.', '  a\n b   ', 'identifier_long_part_123']) {
  const ends=tokenizer.boundaries(text);
  expect(ends[0]).toBe(0); expect(ends.at(-1)).toBe(text.length);
  for (const end of ends) expect(/[\uD800-\uDBFF]/u.test(text[end-1]??'') && /[\uDC00-\uDFFF]/u.test(text[end]??'')).toBe(false);
  expect(ends.slice(1).map((end,i)=>text.slice(ends[i],end)).join('')).toBe(text);
  expect(ends.length-1).toBe(tokenizer.count(text));
 }
});
it('does not acquire assets for a missing cache', async()=>expect(await loadSpanTokenizer('/definitely/missing/tokenizer')).toBeNull());
