import { describe, expect, it } from 'vitest';
import { collectEvidence } from '../packages/core/src/parser/evidence.js';

const snapshot = Buffer.from(JSON.stringify({
  type: 'response_item', timestamp: '2026-10-01T12:00:00Z',
  payload: { type: 'message', role: 'user', content: [{type:'input_text',text:'A synthetic exact source.'}] },
}) + '\n');

describe('audit bounded evidence verification seam', () => {
  it('reads frozen records and verifies through a supplied bounded reader without opening the path', async () => {
    let verifications = 0;
    const result = await collectEvidence('/nonexistent/audit-fixture.jsonl','codex',0,{
      snapshot, readCurrent: () => { verifications++; return snapshot; },
    });
    expect(verifications).toBe(1);
    expect(result.records[0]?.text).toBe('A synthetic exact source.');
    expect(result.continuation.consumedOffset).toBe(snapshot.length);
  });

  it('rejects changed consumed source bytes rather than certifying the old snapshot as current', async () => {
    const changed = Buffer.from(snapshot);
    changed[0] = 0x20;
    await expect(collectEvidence('/nonexistent/audit-fixture.jsonl','codex',0,{
      snapshot, readCurrent: () => changed,
    })).rejects.toThrow('source changed during parse');
  });

  it('preserves a bounded reader failure when a growing input exceeds its cap', async () => {
    await expect(collectEvidence('/nonexistent/audit-fixture.jsonl','codex',0,{
      snapshot, readCurrent: () => { throw new Error('audit_source_byte_limit'); },
    })).rejects.toThrow('audit_source_byte_limit');
  });
});
