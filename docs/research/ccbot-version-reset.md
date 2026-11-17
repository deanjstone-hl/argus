# Research: semantic-release version-reset mechanics for `@argus/ccbot`

Resolves argus#222 (child of map #214, "Rewrite ccbot's Telegram/Slack bridge from the ground up, noise-free").

## Question

`@argus/ccbot` already auto-released `1.0.0` via argus's per-package `semantic-release-monorepo`
dual-track scheme. The rewrite (#214) wants versioning reset to a clean start (framed as "0.1.0").
This researches the supported mechanisms for resetting a package's version stream once real tags
and a real GitHub release already exist, and recommends an approach.

## Correction to the ticket's premise: actual tag format

The ticket assumes tag format `@argus/ccbot@X.Y.Z`. The **actual** tag on origin is
`@argus/ccbot-v1.0.0` (confirmed via `git tag -l '@argus/ccbot@*'` — empty — vs.
`git tag -l '@argus/ccbot*'` → `@argus/ccbot-v1.0.0`, and `gh release view "@argus/ccbot-v1.0.0" -R deanjstone/argus`,
which shows a real, published GitHub Release at that tag, created 2026-08-09T10:37:15Z).

The `@argus/ccbot@${nextRelease.version}` string in `apps/ccbot/.releaserc.json`'s
`@semantic-release/git` `message` template is only the **release commit message** text, not
the tag. The tag itself comes from `semantic-release-monorepo`'s hardcoded template:

```js
// pmowrer/semantic-release-monorepo, src/version-to-git-tag.js
const tagFormat = `${readPkg.sync().name}-v\${version}`;
```
(source: https://github.com/pmowrer/semantic-release-monorepo/blob/master/src/index.js and
`src/version-to-git-tag.js`) — i.e. `<package.json name>-v<version>`, giving
`@argus/ccbot-v1.0.0`. `apps/ccbot/.releaserc.json` does not set its own `tagFormat`, so it
inherits this default via `"extends": "semantic-release-monorepo"`. Every other subtree-merged
package in this repo follows the identical pattern (`@argus/agent-cli-v1.1.5`,
`@argus/wiki-v2.0.0`, etc. — confirmed via `git tag -l`), and root's own `.releaserc.json`
explicitly sets `"tagFormat": "v${version}"` (plain `v2.7.0`-style tags) for the whole-monorepo
track. This whole-repo/per-package split is real and already working correctly — it's not itself
the problem; only ccbot's existing 1.0.0 tag/release/notes are.

## 1. Is there a config-level "initial version override"?

**No.** Checked both semantic-release core and semantic-release-monorepo:

- semantic-release's own FAQ answers this directly under **"Can I set the initial release version
  of my package to `0.0.1`?"**:
  > "This is not supported by semantic-release. Semantic Versioning rules apply differently to
  > major version zero and supporting those differences is out of scope and not one of the goals
  > of the semantic-release project. If your project is under heavy development, with frequent
  > breaking changes, and is not production ready yet we recommend publishing pre-releases."
  (https://semantic-release.gitbook.io/semantic-release/support/faq)
- The first-release version is a hardcoded constant, not a configurable option:
  ```js
  // semantic-release/semantic-release, lib/definitions/constants.js
  export const FIRST_RELEASE = "1.0.0";
  export const FIRSTPRERELEASE = "1";
  export const GIT_NOTE_REF = "semantic-release";
  ```
  (https://github.com/semantic-release/semantic-release/blob/master/lib/definitions/constants.js)
  Whenever semantic-release finds no prior tag matching the active `tagFormat`, it releases
  `1.0.0` — unconditionally, no override hook.
- A feature request for exactly this (`firstVersion` config option) was filed and closed without
  implementation: https://github.com/semantic-release/semantic-release/issues/837 ("Set First
  Version", opened 2018, closed with no `firstVersion` option ever added).
- semantic-release-monorepo (`pmowrer/semantic-release-monorepo`) adds no version-related
  options at all — its `src/index.js` only overrides `tagFormat` and wraps
  `analyzeCommits`/`generateNotes`/`success`/`fail` to filter commits to the package's own path
  (`only-package-commits.js`). No initial-version knob there either.

**Consequence:** whatever mechanism is used, the *first* release on any tag stream — including a
brand new one — will compute to `1.0.0`, not `0.1.0`, unless a tag is manually seeded first (see
§3).

## 2. Is deleting/rewriting the existing `@argus/ccbot-v1.0.0` tag the standard path? Blast radius?

**Deletion is a real, if semi-official, mechanism** — semantic-release's own troubleshooting docs
give the exact commands for removing a bad release:
```
git tag -d <tag name>
git push origin :refs/tags/<tag name>
```
(https://semantic-release.gitbook.io/semantic-release/support/troubleshooting). Community
practice (e.g. https://github.com/semantic-release/semantic-release/discussions/2706, "Restart
to version 1") confirms people do this to reset version numbering, with the caveat that CI git
caching/shallow-clone settings must not resurrect the deleted tag on the next run.

This repo also writes **per-tag git notes**, confirmed empirically:
```
$ git ls-remote origin 'refs/notes/*'
...
b1f9ba53fd1b416c6af6b06355683d9f1b445bc5  refs/notes/semantic-release-@argus/ccbot-v1.0.0
```
Fetching and reading it: `{"channels":[null]}` — this is semantic-release's built-in channel-
tracking mechanism (`GIT_NOTE_REF = "semantic-release"` in constants.js, namespaced per-tag in
this monorepo setup to avoid collisions between packages releasing off shared commits). A true
"as if it never happened" reset would need to remove **both** the tag and this notes ref, locally
and on `origin`:
```
git tag -d @argus/ccbot-v1.0.0
git push origin :refs/tags/@argus/ccbot-v1.0.0
git push origin :refs/notes/semantic-release-@argus/ccbot-v1.0.0
```
Plus deleting the GitHub Release object itself, which is a separate API resource from the tag —
`git push origin -d` does not remove it:
```
gh release delete "@argus/ccbot-v1.0.0" -R deanjstone/argus --cleanup-tag
```
(`--cleanup-tag` handles the tag deletion too, but the notes ref still needs the explicit
`git push` above since it's not a normal tag).

**Blast radius inside this repo's shared CI, concretely:**

`.github/workflows/release.yml` runs **all packages' `semantic-release` in one job, sequentially,
as separate steps, no `continue-on-error`**:
```yaml
- name: Release @argus/agent-cli        # step 1
- name: Release @argus/agent-engine     # step 2
- name: Release @argus/ccbot            # step 3  ← this one
- name: Release @argus/watchtower       # step 4
- name: Release @argus/watchtower-collector
- name: Release @argus/watchtower-usage-shim
- name: Release @argus/vault-core
- name: Release @argus/agent-email
- name: Release @argus/agent-email-mcp
- name: Release @argus/code-relay
- name: Release @argus/mcp-server
- name: Release @argus/wiki
- name: Release argus (monorepo version) # last step, root track
```
Each `pnpm exec semantic-release` step operates on its own package directory and its own
namespaced tag/notes refs, so **a clean tag deletion does not touch any other package's tags,
notes, or version state** — the namespacing (`<name>-v<version>` per package) is exactly what
prevents cross-package interference by design. The real risk is operational, not data corruption:
if the ccbot step **errors** (e.g. semantic-release chokes on an inconsistent tag/notes state, a
half-deleted notes ref, or a shallow-clone/caching mismatch resurrecting the old tag as the
troubleshooting doc warns about), the job stops there and **every package listed after it in the
same job — watchtower, watchtower-collector, watchtower-usage-shim, vault-core, agent-email,
agent-email-mcp, code-relay, mcp-server, wiki, and the root `argus` monorepo release — silently
does not run that day**, even though none of them are otherwise affected. `agent-cli` and
`agent-engine` (steps 1–2, before ccbot) are unaffected either way. This is the same class of
failure argus#182 already hit once (missing semantic-release deps broke mcp-server/wiki's steps).

Tag/notes deletion is destructive and hard to reverse (per this house's git-safety rules) —
**not to be executed by an agent; needs the repo owner running it directly, and ideally a solo
CI run afterward (push a trivial ccbot commit, watch the `Release @argus/ccbot` step in isolation)
before trusting the rest of the chain again.**

## 3. Is a fresh tag prefix a cleaner alternative?

**Mechanically yes, and it's a documented, supported customization point** — `tagFormat` is a
first-class semantic-release option that any `.releaserc` can override, and this is exactly how
monorepo users commonly avoid collisions (e.g. Lerna's documented
`--tag-format='${LERNA_PACKAGE_NAME}-v\${version}'` pattern in the semantic-release-monorepo
README: https://github.com/pmowrer/semantic-release-monorepo). Concretely, `apps/ccbot/.releaserc.json`
could add e.g.:
```json
{
  "extends": "semantic-release-monorepo",
  "tagFormat": "ccbot-rewrite-v${version}",
  ...
}
```
Since no tag matching `ccbot-rewrite-v*` has ever existed, semantic-release finds "no prior
release" on that stream and leaves `@argus/ccbot-v1.0.0`, its notes ref, and its GitHub Release
completely untouched — **zero blast radius**, no destructive git operation, no risk to the shared
CI job. This is the only one of the three options that requires no tag deletion at all.

**But it does not get you to `0.1.0` either** — per §1, `FIRST_RELEASE = "1.0.0"` is unconditional
regardless of tag prefix. A fresh prefix alone still produces `1.0.0` as the rewrite's first
release. To land specifically on `0.1.0`, the *only* mechanism (still unofficial, but exactly how
semantic-release determines "last release" — via highest matching tag) is to manually plant a
seed tag before the next automated run:
```
git tag ccbot-rewrite-v0.1.0 <first-rewrite-commit>
git push origin ccbot-rewrite-v0.1.0
```
semantic-release will then treat `0.1.0` as the last release and compute the *next* commit's bump
from there (e.g. `0.1.1`/`0.2.0`/`1.0.0` depending on conventional-commit type) — it will not stay
pinned at `0.1.0` forever, same limitation as any other seeded-tag approach. This still requires a
manual tag push (a git write, though additive/non-destructive rather than deletion — lower risk
than option 2, but still worth the repo owner doing it explicitly rather than an agent).

## 4. Precedent in this ecosystem

No prior case of an actual version-stream reset was found in `deanjstone/argus` or
`deanjstone/cmdpal-argus` history (`gh issue list`/`gh pr list --search "semantic-release"` and
`"version reset"` across both repos, open and closed — full results in this research; nothing
matches). The closest related work:

- **argus#182** (closed) — fixed *broken wiring* (missing semantic-release deps) for
  mcp-server/wiki, not a version reset.
- **argus#187 / #204** (closed) — the OpenWiki→ArgusWiki rebrand of `apps/wiki`, a directly
  analogous "we want this package's identity to feel fresh" situation. The map/task explicitly
  declared `CHANGELOG.md` rewriting **out of scope**: "CHANGELOG.md rewriting (auto-generated
  history, not worth editing)" (#204). No tag was deleted or reset for the rebrand — semantic-
  release's normal mechanics handled it via an ordinary breaking-change major bump instead
  (`@argus/wiki-v1.0.1` → `@argus/wiki-v2.0.0`, confirmed via `git log --oneline -- apps/wiki/package.json`
  and `git show @argus/wiki-v2.0.0:apps/wiki/package.json`). This is a real precedent for "don't
  rewrite release history for a rebrand/rewrite — let the version number reflect it via a normal
  bump instead," though note it's not a perfect match: wiki kept its package identity throughout,
  where ccbot's rewrite is being framed as wanting a clean slate specifically.

This session does not have direct read access to the user's memory vault, so the
`project_semantic_release_rollout` memory entry referenced in the ticket could not be read
directly; the above is sourced entirely from this repo's actual git/GitHub history.

## Recommendation

**Use a fresh `tagFormat` prefix on `apps/ccbot/.releaserc.json` (§3), and do not touch the
existing `@argus/ccbot-v1.0.0` tag, notes ref, or GitHub Release.** This is the only option with
zero blast radius on the shared release workflow and the other tracked packages, requires no
destructive git operation, and is a standard, documented semantic-release customization point
(not a hack). Concrete change:

```diff
 {
   "extends": "semantic-release-monorepo",
+  "tagFormat": "ccbot-rewrite-v${version}",
   "branches": ["main"],
   ...
 }
```

Accept that the rewrite's first automated release will land on `1.0.0` under the new prefix
(semantic-release has no supported override for this — §1 — confirmed via its own FAQ and
hardcoded `FIRST_RELEASE` constant), **unless** the repo owner wants exactly `0.1.0` badly enough
to manually seed a `ccbot-rewrite-v0.1.0` tag pointing at the rewrite's first commit before the
next release-triggering push (§3) — that's an additive, low-risk git write, but still a manual
git-tag push that should be executed by the repo owner, not an agent, per this house's git-safety
rules.

**Do not delete or rewrite `@argus/ccbot-v1.0.0`, its notes ref
(`refs/notes/semantic-release-@argus/ccbot-v1.0.0`), or its GitHub Release** (§2) — it's
destructive, only weakly reversible, and buys nothing the tag-prefix approach doesn't already give
cleanly. If the repo owner decides they want it anyway (e.g. to keep the tag list visually
uncluttered), the exact commands are in §2, but this needs explicit sign-off and should not be run
by an agent; execute it in isolation and verify the very next `Release @argus/ccbot` CI step
succeeds before trusting the rest of that day's release chain (agent#182 already showed a broken
per-package release step silently voids every package release after it in the same job).

## Sources cited

- https://semantic-release.gitbook.io/semantic-release/support/faq ("Can I set the initial release version of my package to 0.0.1?")
- https://semantic-release.gitbook.io/semantic-release/support/troubleshooting (tag deletion commands, notes/channel recovery)
- https://semantic-release.gitbook.io/semantic-release/usage/configuration (`tagFormat` definition)
- https://github.com/semantic-release/semantic-release/blob/master/lib/definitions/constants.js (`FIRST_RELEASE = "1.0.0"`, `GIT_NOTE_REF`)
- https://github.com/semantic-release/semantic-release/issues/837 ("Set First Version", closed, no `firstVersion` option added)
- https://github.com/semantic-release/semantic-release/discussions/2706 ("Restart to version 1")
- https://github.com/pmowrer/semantic-release-monorepo (README, `src/index.js`, `src/version-to-git-tag.js` — `${name}-v${version}` tag template)
- This repo: `apps/ccbot/.releaserc.json`, `.releaserc.json` (root), `.github/workflows/release.yml`, `git tag -l`, `git ls-remote origin 'refs/notes/*'`, `gh release view "@argus/ccbot-v1.0.0" -R deanjstone/argus`
- `gh issue view 182/187/204 -R deanjstone/argus`, `git log --oneline -- apps/wiki/package.json`
