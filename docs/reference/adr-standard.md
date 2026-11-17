---
title: ADR Standard
status: active
date: 2026-06-14
summary: "Canonical ADR file layout, front matter and status values across projects"
read_when:
  - "writing, promoting or declining an ADR"
---

# ADR Standard

Canonical format for Architecture Decision Records across all projects.

## File layout

```
docs/
├── DECISIONS.md       # index table (required)
└── decisions/
    ├── _template.md   # copy to start a new ADR (do not edit in place)
    ├── adr-001-slug.md
    ├── adr-002-slug.md
    └── ...
```

- Directory is always `docs/decisions/` — not `documentation/decisions/`, not `docs/adr/`
- Filename: `adr-NNN-kebab-case-title.md` — three-digit zero-padded, all lowercase
- Index lives at `docs/DECISIONS.md`, not inside `docs/decisions/`
- `_template.md` lives in each project's `docs/decisions/` as a copy — do not symlink

## Frontmatter

```yaml
---
title: ADR-NNN — Title
status: draft | proposed | accepted | superseded | declined
date: YYYY-MM-DD
supersedes: adr-NNN    # optional; include when this replaces a prior ADR
summary: "ADR-NNN: <the decision, in one line>"   # Full-tier repos with a docs index
read_when:                                       # same — see Repo Structure Standard, "Docs index"
  - <a situation where an agent should open this ADR>
---
```

**Status values:**

| Value | Meaning |
|---|---|
| `draft` | Under discussion; not yet in force |
| `proposed` | A speculative proposal, not yet a locked decision — the `request-for-change/` equivalent (see [Repo Structure Standard](../system-specs/common/repo-structure-standard.md)); promote to `accepted` or `declined` in place, no new file |
| `accepted` | Decision made and in effect |
| `superseded` | Replaced by a later ADR; do not delete, just update status |
| `declined` | A `proposed` ADR that was not adopted; kept as a record, not deleted |

## Required sections

```markdown
## Context
## Decision
## Consequences
```

- **Context** — why the decision was needed; constraints; options considered
- **Decision** — what was chosen and why, stated directly
- **Consequences** — what changes; trade-offs accepted; follow-up work

## Optional sections

```markdown
## Alternatives considered   # for decisions with meaningful option evaluation
## References                # commits, PRs, external links
```

## Index (docs/DECISIONS.md)

Every project needs a `docs/DECISIONS.md`:

```markdown
# Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](decisions/adr-001-slug.md) | Title | accepted |
```

Add each new ADR to the index table when it is created.

## Argus context

Template source: `~/argus/docs/decisions/_template.md`  
This standard: `~/argus/docs/reference/adr-standard.md`

## Projects needing migration

These projects use a non-standard format and should be migrated when next touched:

| Project | Current format | Action needed |
|---|---|---|
| ios-scripts | flat `docs/DECISIONS.md` | Split into `docs/decisions/adr-NNN-*.md`; convert flat file to index table |
| ghostty-win | flat `docs/DECISIONS.md` | Split into `docs/decisions/adr-NNN-*.md`; convert flat file to index table |
| budget | `documentation/decisions/ADR-NNN-*.md`, no frontmatter, `Accepted` status | Move to `docs/decisions/`, add frontmatter, lowercase filenames |
| cmdpal | `docs/decisions/ADR-NNN-*.md`, `approved` status | Rename to lowercase, update status to `accepted` |
| argus | `docs/decisions/adr-NNN-*.md`, `decided` status | Update `status: decided` → `status: accepted` in existing files |
