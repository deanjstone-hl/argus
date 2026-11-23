# Ecosystem manifest

`manifest.json` lists the apps, projects and skills of the Argus system and the edges between
them. myargus.cc's System Map page (`/map`) draws it; nothing else in the shell holds these facts
([myargus#310](https://github.com/deanjstone/myargus/issues/310)).

```
manifest.json ──(ecosystem-release workflow, on promotion)──▶ argus release `ecosystem`, asset ecosystem.json
   ──(ops hub, hourly, GitHub App)──▶ hub SQLite ──▶ GET /api/ecosystem ──▶ shell /map
```

Edit `manifest.json`, open a PR, merge. A merge publishes nothing: the workflow runs on the push
to `deploy`, the owner's promotion (argus#1168), so the asset changes only after the Approve. It
validates the manifest and replaces the release asset; the hub has the new copy within its next
hourly sync. If a promotion ran no workflow, replay it with
`gh workflow run ecosystem-release.yml -R deanjstone/argus --ref deploy` (an owner step). The contract is `parseManifest` in
`scripts/ecosystem/manifest.ts`, shared with the ops hub's copy in
[`deanjstone-hl/ops-hub`](https://github.com/deanjstone-hl/ops-hub) (`src/ecosystem/manifest.ts`, which
validates on fetch) and the shell's reader in myargus (`apps/shell/src/lib/ecosystem.ts`): change
them together.

- `version`: `1`.
- `entries[]`: `name` (unique), `description`, `category` (`app` | `project` | `skill`); optional
  `href` (http(s)), `status` (`live` | `active` | `scaffold` | `archived`), `tags[]` and
  `connects[]`, the names of other entries.
- Check locally: `node scripts/ecosystem/validate.ts`.

## Skills

Which skills exist comes from the machine, not from hand-editing: argus-config's
`envs/wsl2/skills` and sys-admin's `skills`. After a skill is added or removed there, run

```
node scripts/ecosystem/sync-skills.ts          # rewrite
node scripts/ecosystem/sync-skills.ts --check  # report, exit 1 on drift
```

and commit the result. It adds an entry (name, first sentence of the skill's description) for each
installed skill the manifest does not name, and removes a skill entry whose skills are all gone.
Anything hand-written on an entry that stays is untouched: description, `connects`, `status`,
`tags`, `href`. A grouped entry (`issues / todo`) covers every name in it. Entries tagged
`built-in`, `cortex` or `external` (installed outside those two roots) are never added or removed.

CI runs `--check` in the `Ecosystem skills` job of `ci.yml` ([argus#928](https://github.com/deanjstone/argus/issues/928)):
when the manifest or its generator change, and weekly for drift that starts in the other repos.
argus-config and sys-admin are private, so the job checks them out with the repo secret
`SKILLS_READ_TOKEN`, a fine-grained PAT with read-only Contents on those two repos. With the
secret empty (a fork or Dependabot PR, or before it is set) the job posts a notice and passes.
`ecosystem-release` is left alone: it publishes on a promotion that changes the manifest, and
upstream skill drift should not block that.
