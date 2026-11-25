---
summary: "Account-wide repo structure standard: tiers, docs/ taxonomy, AGENTS.md, PR template, docs index"
read_when:
  - applying the standard to a repo
  - adding a doc or a docs/ directory
  - running repo-standard-rollout
---

# Repo Structure Standard

The account-wide standard for repo documentation, structure, and PR/issue conventions,
resolved via [wayfinder map #147](https://github.com/deanjstone/argus/issues/147) and its
eight grilling tickets, [#148](https://github.com/deanjstone/argus/issues/148)–[#155](https://github.com/deanjstone/argus/issues/155).
This doc is the synthesized, skimmable record; each linked issue holds the full reasoning.

This is the first real content under `docs/system-specs/common/` — the location [#149](https://github.com/deanjstone/argus/issues/149)
established for shared, cross-repo conventions. It's also the input the `repo-standard-rollout`
skill (`~/repos/argus-config/envs/wsl2/skills/repo-standard-rollout/`) reads tier assignments and
file-taxonomy rules from — not just descriptive prose.

## Tiering ([#153](https://github.com/deanjstone/argus/issues/153))

Repos are tiered by size/maturity, not by security surface (that's the separate CI-tiering axis)
or visibility (parked governance/OSS fog). Final per-repo assignment happens during rollout —
these lists are illustrative.

### Full
Multi-feature apps with real ongoing development — `argus`, `myargus`, `budget`, `reader-app`,
`knowledge-app`, `stockade`, `t3code`.

- `AGENTS.md` + PR template
- Full `docs/` taxonomy: `architecture/`, `build/`, `ci/`, `guides/`, `reference/`,
  `system-specs/{common,features,modules}/` (with `CONTEXT.md`/`context/` as index),
  `task-specs/` for design-doc overflow
- [Docs index](#docs-index-444): `summary:` + `read_when:` on every doc, enforced in CI

### Standard
Config/tooling repos with real structure but no app-feature surface — `argus-config`,
`sys-admin`, `cmdpal-argus`, `frontend`.

- `AGENTS.md` + PR template
- `architecture/` and `reference/` only, created as-needed
- `CONTEXT.md` stays the full detail store — no `system-specs/` split
- [Docs index](#docs-index-444) front matter on every doc under `docs/`; CI enforcement optional
- No `task-specs/`

### Trimmed
Small personal-utility repos — `scriptable-private`, `erto-apps`, `atto1`, and similar.

- `AGENTS.md`/`CLAUDE.md` convention + PR template only
- No `docs/` subdirectories at all — README covers it, `CONTEXT.md` optional

Every category above is created **as-needed**, never as mandatory empty scaffolding — a tier
sets the ceiling a repo may grow into, not a checklist of empty folders to create on day one.

## `docs/` taxonomy ([#149](https://github.com/deanjstone/argus/issues/149))

KiroCrew's `docs/` categories, decided category-by-category against this account's existing
conventions (issue-tracker-as-record, the `adr` skill, single-context `CONTEXT.md`):

- **`architecture/` (+ `design-notes/`), `build/`, `ci/`, `guides/`, `reference/`** — adopted
  as-is, created once a repo has real content of that kind.
- **`system-specs/`** — adopted in full: `common/` (shared conventions, e.g. this doc),
  `features/` (per-feature specs), `modules/` (per-module specs). `CONTEXT.md` becomes the
  index, not the detail store, once a repo is large enough to need the split — a capacity
  split gated by tier, not a mandate.
- **`task-specs/`** — adopted, narrowed to design-doc overflow only. GitHub Issues remain the
  authoritative record for all non-trivial work; `docs/task-specs/<slug>/design.md` is only
  for the minority of tasks whose write-up is too long for an issue body, with the owning
  issue linking to the file. No mandatory `{year}/{month}/` dating.
- **`request-for-change/`** — **not** adopted as a separate directory. Speculative/still-being-argued
  proposals live in `docs/decisions/` instead, with `status: proposed` (see below) — one
  decisions directory, not two competing ones.

## Docs index ([#444](https://github.com/deanjstone/argus/issues/444))

Agents otherwise guess which doc to open. Every doc under `docs/` carries two front-matter
fields, and a script turns them into an index an agent reads first:

```yaml
---
summary: One line saying what the doc is
read_when:
  - a situation in which an agent should open it
  - another one
---
```

- **`summary:`** — one line. Say what the doc *is*, including when it is historical or
  superseded, so a stale doc is not mistaken for current state.
- **`read_when:`** — a list of triggers, phrased as the situation an agent is in. A block list
  or an inline `[a, b]` both work.
- **Scope:** every `.md` under `docs/`, except `docs/archive/` and `docs/research/`
  (point-in-time records, not onboarding material) and `_`-prefixed templates. A template such
  as `docs/decisions/_template.md` carries placeholder fields so the docs made from it start
  compliant.
- **Script:** `node scripts/docs-list.ts [repo-root]` prints the index; `--check` prints only
  the problems and exits 1 if any doc lacks either field. It has no dependencies and needs Node
  22.18+ (type stripping). argus runs `--check` in `scripts/ci.sh`. Another repo adopting the
  index copies the script rather than reaching into argus, since its CI cannot see this repo.
- **By tier:** Full — required and enforced in CI. Standard — the fields are required on any
  doc under `docs/`; wiring the check into CI is optional. Trimmed — not applicable (no `docs/`).

## ADR `proposed` status ([#149](https://github.com/deanjstone/argus/issues/149))

The `adr` skill's allowed `status` values extend from `draft | accepted | superseded` to
`draft | proposed | accepted | superseded | declined`. `proposed` is what KiroCrew's
`request-for-change/` would have held — a still-being-argued proposal, not yet a locked
decision. A `proposed` ADR is promoted to `accepted` or `declined` in place (frontmatter +
`docs/DECISIONS.md` status column updated) — no new file, no new ADR number. See the `adr`
skill (`~/repos/argus-config/envs/wsl2/skills/adr/SKILL.md`) and
[`docs/reference/adr-standard.md`](../../reference/adr-standard.md) for the mechanics.

## AGENTS.md as canonical cross-tool file ([#150](https://github.com/deanjstone/argus/issues/150))

`AGENTS.md` is the canonical cross-tool instructions file at repo root, project-level only —
the global `~/.claude/CLAUDE.md` is unaffected. `CLAUDE.md` becomes `@AGENTS.md` (Claude
Code's native import syntax auto-loads the file into context) plus a small local section for
content that's genuinely Claude-Code-only (hooks, skills, the `/compact` workflow),
which other tools would just ignore. Where nothing Claude-only remains, `CLAUDE.md` is
deleted rather than kept as a one-line `@AGENTS.md` stub: Claude Code 2.1.277+ reads
`AGENTS.md` directly when no `CLAUDE.md` exists in the working directory or above it
([argus-config#381](https://github.com/deanjstone/argus-config/issues/381)). Rollout is going-forward + opportunistic: baked into
`new-project`/`github-setup`/`project-init-extended` for new repos, migrated by hand as each
existing repo is next touched — no dedicated migration sprint.

## Issue/PR templates ([#151](https://github.com/deanjstone/argus/issues/151))

- **Issue forms:** skipped account-wide. No `.github/ISSUE_TEMPLATE/*.yml` — repos are
  solo-maintained/private, and issue structure is already enforced at creation time by the
  wayfinder/todo skills. Revisit if a repo goes public with outside contributors.
- **PR template content:** unchanged — `Summary (1-3 bullets) → Why → Test plan (checklist) →
  Claude Code footer`, already committed as a real `.github/pull_request_template.md` file
  (not just CLAUDE.md prose) so it also surfaces in GitHub's web PR-creation UI.
- **Rollout:** same going-forward + opportunistic approach as `AGENTS.md`.

## AI-review-gated CI ([#152](https://github.com/deanjstone/argus/issues/152))

Skipped entirely — none of KiroCrew's automatic-on-PR AI review workflows
(`claude-review.yml`, `codex-review.yml`, `design-review.yml`, `ux-review.yml`,
`ai-review-human-override.yml`, fork-* variants) are adopted. All four authenticate via AWS
OIDC → Bedrock (new infra, not just a workflow file); the blocking lanes (`claude-review`,
`codex-review`) require branch protection, which 403s on this account's private + GitHub Free
repos; and the manual `/code-review ultra` / `/codex:review` / `/codex:adversarial-review`
flows already cover the need solo-authorship doesn't otherwise justify. Revisit if a Pro
upgrade or going public is separately decided, or the repo gains external contributors.

## `template-repo-with-claude` ([#154](https://github.com/deanjstone/argus/issues/154))

Archived for real (`gh repo archive`, confirmed `archived: true`) — see
[`template-repo-with-claude#126`](https://github.com/deanjstone/template-repo-with-claude/pull/126)
and [argus#156](https://github.com/deanjstone/argus/pull/156). No successor repo: this
decision-doc-first destination makes a copyable template repo redundant. The standard itself
(this document) is what `new-project`/`github-setup`/`project-init-extended` apply going
forward.

## Rollout mechanics ([#155](https://github.com/deanjstone/argus/issues/155))

Applied by a new checklist-driven skill, `repo-standard-rollout`
(`~/repos/argus-config/envs/wsl2/skills/repo-standard-rollout/SKILL.md`) — not a blind script. It
reads a target repo's tier (from this doc's illustrative lists, or asks if the repo isn't
listed), checks what already exists in the repo, and creates only what's missing —
judgment-based, mirroring how the semantic-release rollout was actually executed.

**Pilot phase:** one repo per tier first — `argus` (Full), `argus-config` (Standard),
`atto1` (Trimmed). **Wider rollout:** once the pilots landed, the AGENTS.md adoption went to
the remaining active repos through the skill in
[#448](https://github.com/deanjstone/argus/issues/448) — `budget`, `myargus` (Full),
`homelab`, `sys-admin`, `frontend` (Standard), `scriptable-private` (Trimmed). Archived
or parked repos were skipped. The skill is now approved for any active repo. Wiring it into
the `new-project`/`github-setup`/`project-init-extended` chain is still deferred.

## Explicitly out of scope of this standard

Carried forward from map #147 as still-parked fog, not decided here:

- The [#148](https://github.com/deanjstone/argus/issues/148) consolidation-into-`argus`
  migration (subtree-merging `ccbot`, `argus-context`, `watchtower`, `code-relay` into
  `apps/`/`packages/`) — `argus` is confirmed as this standard's home repo, but the migration
  itself is separate follow-on work.
- Governance/OSS-contributor apparatus (`GOVERNANCE.md`, `MAINTAINERS.md`, `TENETS.md`,
  `CODE_OF_CONDUCT.md`, `CODEOWNERS`) — remains parked.
