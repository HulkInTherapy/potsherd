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
 *
 * That was still not wide enough. At tag v0.7.0 the binary printed 0.4.0: all
 * four surfaces agreed with one another and all four were three releases
 * stale, because nothing tied them to the tag. And two manifests were never in
 * the check at all -- `plugins/claude-code/.claude-plugin/plugin.json` and the
 * marketplace entry beside it, both of which still read 0.5.0 at v0.7.0, which
 * is the version a marketplace listing would have shown a stranger.
 *
 * The test now enumerates every manifest in the repository that carries a
 * potsherd version -- four packages, two plugin manifests, one marketplace
 * entry -- and, when it is running inside a git checkout with tags, refuses a
 * VERSION that is *behind* the newest `v*` tag. It cannot know the tag that
 * has not been made yet, so it checks the one direction that has actually gone
 * wrong twice.
 */
export const VERSION = '1.2.0';
