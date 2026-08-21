/**
 * One version string for the whole product.
 *
 * It used to live in four places — the CLI entry, the core barrel, `doctor`,
 * and `packages/cli/package.json` — and at tag v0.2.0 three of them still said
 * 0.1.0. A version a user reads must never disagree with the tag they installed,
 * so there is exactly one literal now.
 *
 * "Exactly one literal" was not enough on its own. The comment above promised
 * a test that pinned this to the manifest npm publishes and no such test was
 * ever written, so at tag v0.4.0 `potsherd --version` was still printing
 * 0.2.0 — a single source of truth that had quietly stopped being true. The
 * test exists now (`tests/terminal.test.ts`, "the version a user reads"): it
 * fails when this literal, `packages/cli/package.json`, `packages/core/
 * package.json` or the string the built binary prints disagree with each
 * other. Bumping a release means editing this line and the two manifests
 * together, and the suite says so if you miss one.
 */
export const VERSION = '0.4.0';
