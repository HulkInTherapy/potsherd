import { describe, expect, it } from 'vitest';
import { renderAuditShareSvg, renderLaunchPlain } from '../../packages/cli/src/audit-ui/index.js';
import { readySnapshot } from './fixture.js';
import { storySnapshot } from './story-fixture.js';

describe('plain and share outputs', () => {
  it('prints the whole board and the details without ANSI or viewport clipping', () => {
    const text = renderLaunchPlain(readySnapshot(), { width: 100 });
    expect(text).not.toContain('\x1b');
    for (const expected of ['MODELS', 'PROJECTS', 'WHEN YOU CODE', 'ON REPEAT', 'REACTIONS', 'SWEAR JAR', 'WHAT THE NUMBERS MEAN', 'Rotor-Notes', '975 prompts']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('q quit');
  });

  it('stays pure ASCII with --ascii', () => {
    const text = renderLaunchPlain(readySnapshot(), { width: 80, ascii: true });
    expect([...text].every(char => char.charCodeAt(0) < 128)).toBe(true);
  });

  it('share SVG leaves out project names and your own words', () => {
    const svg = renderAuditShareSvg(readySnapshot());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('MODELS');
    expect(svg).not.toContain('Rotor-Notes');
    expect(svg).not.toContain('continue please');
    expect(svg).not.toContain('What the hell');
    expect(svg).not.toMatch(/#(?!F2A45E|EEEAE4|A6A29B|68665F|10100F)[0-9A-Fa-f]{6}/);
  });

  it('prints every story card as a text section before the board', () => {
    const text = renderLaunchPlain(storySnapshot(), { width: 100 });
    expect(text).not.toContain('\x1b');
    for (const expected of ['BEFORE WE START', 'THE BILL', 'YOUR CLOCK', 'QUICK QUIZ', 'answer: Claude Opus 5', 'HOW YOU TALK', 'THE NIGHT SHIFT ARCHITECT'.toLowerCase(), 'THE BOARD', 'WHAT THE NUMBERS MEAN']) {
      expect(text.toLowerCase()).toContain(expected.toLowerCase());
    }
    expect(text).toContain('f-bombs');
    expect(text).not.toMatch(/\bfuck/i);
  });

  it('story share SVG is anonymised and stays in the palette family', () => {
    const svg = renderAuditShareSvg(storySnapshot());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Night Shift Architect');
    expect(svg).toContain('AT API PRICES');
    for (const secret of ['lantern-api', 'tidepool', 'paper-boats', 'real quick', 'sync layer', 'buddy']) expect(svg).not.toContain(secret);
  });
});
