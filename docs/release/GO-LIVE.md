# GO-LIVE — potsherd v1.1.0

**Written before it was run.** Every step is a command with an expected output.
Each step's *actual* output is pasted underneath it as it happens, so this file
becomes the record of what was done rather than a plan of what was intended.

**Order matters and the order is not negotiable.** The verifier and the tag come
first; publishing is last. If any step's output does not match what is written
here, **stop and report — do not improvise a fix against a live registry.**

The only step that needs a person is **2**, and only if `npm whoami` fails.

**It does not currently fail.** So an agent running this file top to bottom
publishes to a public registry with no human in the loop. That is the intended
shape after meghavi re-scoped rule 7 on 22 August 2026, and it is written here
plainly rather than left implicit, because it is the most consequential sentence
in the document.

---

## before you start

- [ ] `phases/phase-9/VERIFICATION.md` exists and its blocking findings are fixed
- [ ] `v1.1.0` is tagged and CI is green **on the tag**, not merely on `main`

```bash
git status --short                       # expect: empty
git rev-parse HEAD origin/main v1.1.0^{commit}   # expect: three identical shas
gh run list --limit 1                    # expect: completed  success
```

_actual:_

```
(paste)
```

---

## 1. the registry has not been claimed by somebody else

```bash
npm view potsherd
```

**Expected: `E404 Not Found`.** If it returns a package, **stop.** The name is
taken, and the README's `npx potsherd audit` line has become a claim about
somebody else's code.

_actual:_

```
(paste)
```

---

## 2. publish to npm

```bash
npm whoami
```

**Expected: a username.** If this errors, **STOP AND ASK MEGHAVI TO RUN
`npm login`.** This is the one act in this runbook that is not the
orchestrator's, and it is not to be worked around with a token created for the
purpose.

```bash
cd packages/cli
npm publish --access public
cd ../..
```

**Expected tail:** `+ potsherd@1.1.0`. No warnings — the dry run had one, about
`bin[potsherd]`, and it was fixed rather than accepted.

_actual:_

```
(paste)
```

---

## 3. the registry agrees

```bash
npm view potsherd version          # expect: 1.1.0
npm view potsherd dist.tarball
npm view potsherd dist.unpackedSize
```

_actual:_

```
(paste)
```

---

## 4. `npx` on a machine that has never seen the repository

The line at the top of the README, run the way it is written.

```bash
docker run --rm -i node:24-bookworm-slim bash -lc '
  mkdir -p /root/.claude && time npx --yes potsherd@1.1.0 audit'
```

**Expected:** the audit card, and — on a container with no `~/.claude` — the
"no Claude Code data" screen rather than a stack trace. Either is a pass; a
crash is not. Record the wall time.

_actual:_

```
(paste)
```

---

## 5. the GitHub release

**`npm publish` does not leave a tarball on disk, and no earlier step makes
one** — so build it here, before the release that attaches it. Verified: after
`npm publish --dry-run`, `ls *.tgz` finds nothing.

```bash
( cd packages/cli && npm pack )          # -> packages/cli/potsherd-1.1.0.tgz
ls -l packages/cli/potsherd-1.1.0.tgz    # expect ~957 kB

gh release create v1.1.0 \
  --title "potsherd v1.1.0" \
  --notes-file docs/release/RELEASE-NOTES-v1.1.0.md \
  packages/cli/potsherd-1.1.0.tgz
```

`npm pack` runs `prepack`, which copies the root README over
`packages/cli/README.md` — the file npm renders. That is deliberate: the copy is
gitignored and was hand-made once, went a whole release stale, and announced
`Status: v1.0.0` on the page for `1.1.0`.

**Expected:** a release URL. Then:

```bash
gh release view v1.1.0 --json assets --jq '.assets[].name'   # expect the .tgz
```

_actual:_

```
(paste)
```

---

## 6. the marketplace listing — **NOT DONE, and not an oversight**

Struck on 22 August 2026 after checking the process rather than assuming it.

The **official** marketplace is curated by Anthropic at its discretion; its own
documentation says *"there is no application process, and the submission form
does not add plugins to the official marketplace."* Third-party submissions go
to `claude-plugins-community` through an **authenticated in-app form** —
`claude.ai/admin-settings/directory/submissions/plugins/new` (which needs a Team
or Enterprise organization with directory-management access) or
`platform.claude.com/plugins/submit` for individual authors.

**That form sits on a person's account.** Rule 7's re-scope authorises
publishing potsherd's own artefacts; it does not make a form on somebody's
account an agent's job.

What was done instead, and passes:

```bash
claude plugin validate ./plugins/claude-code --strict   # ✔ Validation passed
claude plugin validate .                                # ✔ Validation passed
```

**Nothing is blocked.** The plugin installs today from the public repository:

```
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd@potsherd
```

Everything the form asks for is prepared in `docs/release/marketplace.md`.

---

## 7. one comment on `obra/episodic-memory#128`

**One. Not a pull request, not an issue, not a second comment.** `#128` already
fixes the line our prepared patch addressed, and does it better. The comment
adds a measurement it does not have and says where the fork is. It asks for
nothing.

Re-read the thread first — if it has been merged or closed since, the text needs
a different opening and this step stops until it has one.

```bash
gh pr view 128 --repo obra/episodic-memory --json state,merged,comments
```

Then extract the body **from `upstream.md` itself** rather than retyping it —
nothing else writes `/tmp/128-comment.md`, and a comment going into somebody
else's repository is not a thing to improvise:

```bash
python3 - <<'PY' > /tmp/128-comment.md
import io, re
doc = io.open('docs/release/upstream.md', encoding='utf-8').read()
body = re.search(r'```markdown\n(.*?)\n```', doc, re.S).group(1)
print(body)
PY
cat /tmp/128-comment.md          # READ IT. This is the last chance.
gh pr comment 128 --repo obra/episodic-memory --body-file /tmp/128-comment.md
```

_actual:_

```
(paste)
```

---

## 8. post-publish checks, run immediately

```bash
# the published package, from a directory that is not this repository
cd "$(mktemp -d)" && npx --yes potsherd@1.1.0 audit --json | jq '{sessionsEver,onDisk,deleted}'

# what the registry says it shipped
npm view potsherd dist.tarball dist.unpackedSize

# the readme renders on npmjs.com
open https://www.npmjs.com/package/potsherd

# and a plugin install from a clean $HOME
```

Results go in `phases/phase-9/POST-PUBLISH.md`.

_actual:_

```
(paste)
```

---

## 9. rollback, if any of it is wrong

`npm unpublish` is only available within 72 hours and taking a version back
breaks anybody who already installed it. Prefer deprecation.

```bash
npm deprecate potsherd@1.1.0 "withdrawn — use <version> instead; see <url>"
gh release delete v1.1.0 --yes          # the release, not the tag
git push --delete origin v1.1.0         # only if the tag itself is wrong
```

**Do not force-push `main` to undo a publish.** The registry does not care what
the repository says, and a rewritten history makes the published tarball
unauditable.
