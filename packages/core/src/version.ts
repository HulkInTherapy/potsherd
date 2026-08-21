/**
 * One version string for the whole product.
 *
 * It used to live in four places — the CLI entry, the core barrel, `doctor`,
 * and `packages/cli/package.json` — and at tag v0.2.0 three of them still said
 * 0.1.0. A version a user reads must never disagree with the tag they installed,
 * so there is exactly one literal now and a test that pins it to the manifest
 * npm actually publishes.
 */
export const VERSION = '0.2.0';
