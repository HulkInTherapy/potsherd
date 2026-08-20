/**
 * Opt-out markers: text that means "do not index this conversation".
 *
 * Ported from obra/episodic-memory@1075769 `src/constants.ts` (the summarizer
 * content marker, verbatim) and `src/sync.ts:7-11` (the exclusion list)
 * (MIT, (c) 2025 Jesse Vincent).
 *
 * Two of the three markers are upstream's own product strings and are kept
 * **verbatim on purpose**: a user who has been running episodic-memory has
 * these markers sitting in real transcripts already, and potsherd must honour
 * the opt-out they represent rather than re-indexing what they excluded.
 * potsherd's own marker is added alongside.
 */

/** Upstream's summarizer prompt contains this, so its own runs never index. */
export const SUMMARIZER_CONTEXT_MARKER =
  'Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant';

/** potsherd's equivalent, for the card writer in phase 2. */
export const POTSHERD_CARD_MARKER =
  '<INSTRUCTIONS-TO-POTSHERD>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-POTSHERD>';

export const EXCLUSION_MARKERS: readonly string[] = [
  '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
  'Only use NO_INSIGHTS_FOUND',
  SUMMARIZER_CONTEXT_MARKER,
  POTSHERD_CARD_MARKER,
];

/** True when a transcript's text opts out of indexing. */
export function hasExclusionMarker(text: string): boolean {
  return EXCLUSION_MARKERS.some((marker) => text.includes(marker));
}
