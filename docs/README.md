---
summary: Map of the docs/ tree and what each directory holds
read_when:
  - "you are new to the repo's docs"
  - deciding where a new doc belongs
---

# docs/

This repo is **Full** tier under the account-wide
[Repo Structure Standard](system-specs/common/repo-structure-standard.md). Categories are
created as-needed, not scaffolded empty.

`node scripts/docs-list.ts` prints every doc below with its `summary:` and `read_when:` front
matter. A new doc needs both fields, or CI fails (archive/, research/ and `_`-prefixed templates
are exempt).

| Directory | Holds |
|---|---|
| [`decisions/`](decisions/) | ADRs. Index: [`DECISIONS.md`](DECISIONS.md). Speculative proposals live here too, as `status: proposed`. |
| [`architecture/`](architecture/) | How the system is put together, and why — orchestrator strategy, the memory system, the Watchtower data flow. |
| [`diagrams/`](diagrams/) | Self-contained HTML/SVG diagrams: the repo architecture, each app's main flow, and build and deploy. Index: [`diagrams/README.md`](diagrams/README.md). |
| [`runbooks/`](runbooks/) | Step-by-step procedures for an owner or an agent to run: [`bws-store-secret.md`](runbooks/bws-store-secret.md) stores a secret from a hidden prompt. |
| [`reference/`](reference/) | Look-it-up material for this repo: ADR format, brrr, one-off evaluations. |
| [`system-specs/`](system-specs/) | `common/` for shared cross-repo conventions, `features/` and `modules/` as they gain content. |
| [`task-specs/`](task-specs/) | Design-doc overflow: `<slug>/design.md` for the minority of tasks whose write-up is too long for an issue body. The owning issue links to the file. |
| [`agents/`](agents/) | Agent-workflow conventions (issue tracker, domain docs). An account-wide convention referenced by `.claude/SYSTEM.md` here and in several packages — kept as-is rather than folded into `reference/`. |
| [`templates/`](templates/) | Templates read by name from outside this repo — currently `impl-plan-template.html`, the canonical source for the `impl-plan` skill. |

There is no `TODO.md` and no `plans/`. GitHub Issues are the authoritative backlog; long-form
plans are `task-specs/`.

## Read by path from argus-config

argus-config skills and rules read these files from `~/repos/argus` by absolute path. They stay
here, because argus is the Full-tier reference repo, but **moving or renaming one breaks the
reader**: update argus-config in the same change ([#418](https://github.com/deanjstone/argus/issues/418)).

| File | Read by (argus-config) |
|---|---|
| `docs/system-specs/common/repo-structure-standard.md` | `envs/wsl2/skills/repo-standard-rollout/SKILL.md` |
| `docs/reference/adr-standard.md`, `docs/decisions/_template.md` | `envs/{wsl2,homelab}/rules/adr.md` (and the `adr` skill through them) |
| `docs/templates/impl-plan-template.html` | `envs/wsl2/skills/impl-plan/SKILL.md` |

## Moved out

Removed in [#418](https://github.com/deanjstone/argus/issues/418) because another repo owns them.
Each was already present at the new location, byte-identical unless noted.

| Was here | Now lives in |
|---|---|
| `reference/agent-patterns.md`, `reference/skills-and-subagents.md`, `reference/token-reduction.md` | neocortex (CORTEX) `PROJECTS/Argus Orchestrator/reference/` |
| `reference/cortex-ai-upgrade-scan-2026-06-14.md` | neocortex (CORTEX) `PROJECTS/Argus Orchestrator/` |
| `reference/session-notes/2026-06-11-session-summary.md`, `2026-06-13-sessions.md` | neocortex (CORTEX) `PROJECTS/Argus Orchestrator/sessions/` (`2026-06-11 Session Summary.md`, `2026-06-13 Sessions.md`) |
| `TODO.md` | GitHub Issues. Its open items were obsolete (ccgram, `spawn-claude`) or already tracked (#23). |
| `decisions/adr-003`, `adr-004`, `adr-005` | myargus `docs/decisions/` (pointer stubs remain here) |
