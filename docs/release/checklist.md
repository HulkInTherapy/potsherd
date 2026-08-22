# tag day, in order

Every step is a command. Nothing here is a judgement call except the two marked
**HUMAN**.

```bash
# 1. the version, in one place, and the suite that pins the other six to it
$EDITOR packages/core/src/version.ts
$EDITOR packages/{core,cli,mcp,bridges}/package.json
$EDITOR plugins/claude-code/.claude-plugin/plugin.json
$EDITOR plugins/codex/.codex-plugin/plugin.json
$EDITOR .claude-plugin/marketplace.json

# 2. build, vendor, verify
pnpm install
pnpm build
pnpm vendor                       # plugins/claude-code/dist/*.js
pnpm typecheck
pnpm test                         # 1,4xx tests
POTSHERD_SQLITE=node pnpm test    # the same suite on Node's own sqlite
python3 scripts/check-privacy.py --selftest
python3 scripts/check-privacy.py
npx tsx evals/ask-selftest.ts

# 3. the artefacts a reader sees
bash scripts/make-screens.sh      # needs a model backend for 14, 15 and 17
git diff --stat docs/screens/

# 4. the tarball, on a machine that has never seen this repository
cd packages/cli && npm pack && cd ../..
WORK=$(mktemp -d) && cp packages/cli/potsherd-*.tgz "$WORK/"
( cd "$WORK" && npm init -y >/dev/null && npm install ./potsherd-*.tgz \
  && ./node_modules/.bin/potsherd --version \
  && ./node_modules/.bin/potsherd audit )

# 5. push, and WAIT for CI green on the pushed commit — not the local run.
#    Six CI-only failures across phases 4-6, none reproducible locally.
git push origin main
gh run watch

# 6. tag, push the tag, and confirm CI green on the tag too
git tag -a v1.0.0 -m "potsherd v1.0.0"
git push origin v1.0.0
gh run watch
```

**HUMAN — publish to npm.** See [`npm.md`](npm.md). One command, and it cannot
be undone.

**HUMAN — submit the marketplace listing.** See
[`marketplace.md`](marketplace.md).

## the two things that will bite

**`git push origin main` before anything that depends on the pushed state.**
Worktrees, CI and a marketplace install are all cut from `origin/main`, never
from your local `HEAD`.

**Never tag before CI is green on the pushed commit.** Not the tag, the commit.
There have been six CI-only failures in this build and not one of them
reproduced on a developer laptop: a settings path that differs between macOS and
Linux, an environment variable the runner sets and a laptop does not, a detached
hook still writing while a cleanup walked its directory, and a Node version
that had stopped emitting a warning a test asserted.
