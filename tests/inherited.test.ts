import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markers, codexVersion } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';
import { formatErrorSentinel, hasRealCard, isErroredSentinel, shouldQueueForCard } from '../packages/core/src/cards/sentinel.js';

/** Small self-contained modules taken from upstream near-verbatim. */
describe('opt-out markers', () => {
  it('honours episodic-memory\'s own opt-out markers, not just potsherd\'s', () => {
    // A user migrating from episodic-memory already has these strings in real
    // transcripts; re-indexing what they excluded would be a privacy failure.
    expect(markers.hasExclusionMarker('...<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>...')).toBe(true);
    expect(markers.hasExclusionMarker(markers.SUMMARIZER_CONTEXT_MARKER)).toBe(true);
    expect(markers.hasExclusionMarker(markers.POTSHERD_CARD_MARKER)).toBe(true);
    expect(markers.hasExclusionMarker('an ordinary conversation about pgbouncer')).toBe(false);
  });
});

describe('codex version gate', () => {
  it('compares semver without a dependency', () => {
    expect(codexVersion.compareSemver('0.130.0', '0.130.0')).toBe(0);
    expect(codexVersion.compareSemver('0.145.0', '0.130.0')).toBeGreaterThan(0);
    expect(codexVersion.compareSemver('0.9.0', '0.130.0')).toBeLessThan(0);
    expect(codexVersion.compareSemver('1', '0.130.0')).toBeGreaterThan(0);
  });

  it('reads the version out of `codex --version` output', () => {
    expect(codexVersion.parseCodexCliVersion('codex-cli 0.145.0-alpha.27')).toBe('0.145.0');
    expect(codexVersion.parseCodexCliVersion('')).toBeUndefined();
    expect(codexVersion.versionMeetsMinimum('0.145.0')).toBe(true);
    expect(codexVersion.versionMeetsMinimum('0.129.9')).toBe(false);
  });

  it('says what to do rather than just failing', () => {
    expect(codexVersion.codexVersionRequirementMessage('codex-cli 0.100.0')).toContain('codex update');
    expect(codexVersion.codexVersionRequirementMessage('')).toContain('(empty output)');
  });
});

describe('card sentinel (unused until phase 2)', () => {
  it('distinguishes missing, empty, errored and real', () => {
    const dir = tempDir();
    const missing = path.join(dir, 'missing.md');
    const empty = path.join(dir, 'empty.md');
    const errored = path.join(dir, 'errored.md');
    const real = path.join(dir, 'real.md');
    fs.writeFileSync(empty, '');
    fs.writeFileSync(errored, formatErrorSentinel(new Error('rate limited')));
    fs.writeFileSync(real, '# a card\n');

    expect(hasRealCard(missing)).toBe(false);
    expect(hasRealCard(empty)).toBe(false);
    expect(hasRealCard(errored)).toBe(false);
    expect(hasRealCard(real)).toBe(true);

    // Missing re-queues; empty is a permanent skip; a fresh error waits.
    expect(shouldQueueForCard(missing)).toBe(true);
    expect(shouldQueueForCard(empty)).toBe(false);
    expect(shouldQueueForCard(errored)).toBe(false);
    expect(shouldQueueForCard(real)).toBe(false);

    // …and re-queues once it is stale, which is the fix for the queue-head pin.
    const old = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(errored, old, old);
    expect(shouldQueueForCard(errored)).toBe(true);
    expect(isErroredSentinel(fs.readFileSync(errored, 'utf8'))).toBe(true);
    rmrf(dir);
  });
});
