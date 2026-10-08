/** Dispatch: draw one deck card (chrome + its own visual). Returns true while still animating. */
import type { DeckCard } from '../story/deck.js';
import { drawChrome, type ChromeOptions } from './chrome.js';
import { faceoffBody, guessBody } from './models.js';
import { archetypeBody, boardBody, insightBody } from './finale.js';
import { billBody, scaleBody } from './numbers.js';
import { awardsBody, delegationBody, projectsBody } from './places.js';
import type { Scene } from './scene.js';
import { clockBody, fuseBody, moodBody } from './time.js';
import { coldOpenBody, mannersBody, talkBody, thenNowBody } from './words.js';

export function renderCard(s: Scene, card: DeckCard): boolean {
  const options: ChromeOptions = {};
  if (card.kind === 'cold_open' || card.kind === 'archetype' || card.kind === 'board') options.headline = false;
  if (card.kind === 'faceoff') options.mascot = false;
  if (card.kind === 'board') options.bodyUnderKicker = true;
  if (card.kind === 'guess') {
    options.hint = s.state.guess === undefined ? `1–${card.data.options.length} guess` : undefined;
    if (s.state.guess !== undefined) options.expression = s.state.guess === card.data.answer ? 'proud' : 'shocked';
  }
  const shown = card.kind === 'guess' && s.state.guess !== undefined ? { ...card, support: `Ranked by ${card.data.basis}.` } : card;
  const { body, busy, mascot } = drawChrome(s, shown, options);
  if (body.h <= 0 || body.w <= 0) return busy;
  let bodyBusy = false;
  switch (card.kind) {
    case 'cold_open': bodyBusy = coldOpenBody(s, card.data, body); break;
    case 'scale': bodyBusy = scaleBody(s, card.data, body); break;
    case 'bill': bodyBusy = billBody(s, card.data, body); break;
    case 'clock': bodyBusy = clockBody(s, card.data, body); break;
    case 'guess': bodyBusy = guessBody(s, card.data, body); break;
    case 'faceoff': bodyBusy = faceoffBody(s, card.data, body); break;
    case 'mood': bodyBusy = moodBody(s, card.data, body); break;
    case 'fuse': bodyBusy = fuseBody(s, card.data, body); break;
    case 'talk': bodyBusy = talkBody(s, card.data, body); break;
    case 'manners': bodyBusy = mannersBody(s, card.data, body); break;
    case 'projects': bodyBusy = projectsBody(s, card.data, body); break;
    case 'delegation': bodyBusy = delegationBody(s, card.data, body); break;
    case 'then_now': bodyBusy = thenNowBody(s, card.data, body); break;
    case 'archetype': bodyBusy = archetypeBody(s, card.data, body); break;
    case 'awards': bodyBusy = awardsBody(s, card.data, body); break;
    case 'insight': bodyBusy = insightBody(s, card.data, body); break;
    case 'board': bodyBusy = boardBody(s, card.data, body, mascot); break;
  }
  return busy || bodyBusy;
}
