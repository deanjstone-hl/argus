# Contributing

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) to drive automated versioning via [semantic-release](https://semantic-release.gitbook.io/). Every commit/PR title merged to `main` should follow this format:

```
<type>(<scope>): <description>
```

| Type | Version bump | Example |
|---|---|---|
| `fix` | patch | `fix(agent-cli): correct project picker path resolution` |
| `feat` | minor | `feat(agent-engine): add vector search endpoint` |
| `fix!` / `feat!` / `BREAKING CHANGE:` footer | major | `feat(agent-cli)!: drop legacy --run flag` |
| `docs`, `chore`, `ci`, `refactor`, `test`, `style` | none | `docs: update README setup steps` |

## Versioning model — per-package + monorepo

This repo has **independent version tracks per package**, each released automatically when the owner promotes `main` to `deploy` (the `deploy` push runs `release.yml`; a merge to `main` cuts no version, and a promotion holding only `chore`/`docs`/`ci` commits cuts none):

- **`@argus/agent-cli`** (`apps/agent-cli`) — tagged `@argus/agent-cli@X.Y.Z`. Bumps only when a commit touches files under `apps/agent-cli/`.
- **`@argus/agent-engine`** (`apps/agent-engine`) — tagged `@argus/agent-engine@X.Y.Z`. Bumps only when a commit touches files under `apps/agent-engine/`.
- **`argus`** (repo root) — tagged `vX.Y.Z`. Bumps on *any* commit anywhere in the repo, tracking overall monorepo progress independently of the per-package versions.

**Scope your commits accordingly.** Use `scope` in the commit type (e.g. `fix(agent-cli): ...`) to make it clear which package a change belongs to, even though the actual version-bump targeting is based on which files the commit touches, not the scope text itself.

A single commit that touches both packages will bump both package versions and the root version in the same CI run.
