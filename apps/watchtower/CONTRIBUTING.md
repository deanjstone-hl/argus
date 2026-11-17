# Contributing

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) to drive automated versioning via [semantic-release](https://semantic-release.gitbook.io/). Every promotion to `deploy` runs the `Release` workflow (`.github/workflows/release.yml`), which tests the promoted SHA and then scans the new commits to decide the next version and GitHub release. The GitHub Release notes are the changelog; nothing is committed back.

Format:

```
type(scope): subject

body (optional)

footer (optional)
```

| Type | Effect | Example |
|---|---|---|
| `fix` | patch release (`x.y.Z`) | `fix: pin wrangler as a devDependency to unblock Deploy` |
| `feat` | minor release (`x.Y.z`) | `feat: add ai-usage adapter for cross-host ccusage monitoring` |
| `feat!` / `fix!` / footer `BREAKING CHANGE:` | major release (`X.y.z`) | `feat!: replace passkey auth with the shared shell session` |
| `docs`, `chore`, `ci`, `refactor`, `test`, `style` | no release | `chore: add BWS provisioning for collector/usage-shim .env` |

`scope` is optional and free-form.

Squash-merged PRs should carry a Conventional Commits–style title, since that becomes the commit message on `main`. Past commits predate this convention and are left untouched.
