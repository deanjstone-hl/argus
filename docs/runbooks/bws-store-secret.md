---
summary: "Store a secret in Bitwarden Secrets Manager from a hidden prompt with scripts/bws-store-secret.sh; env variables, examples, what it prints"
read_when:
  - "a runbook or ticket says to put a token or key into Secrets Manager"
  - "the owner must supply a secret value and it must not touch a chat, a `!` command or a typed command line"
  - "rotating a secret under an existing key"
---

# Store a secret from a hidden prompt

`scripts/bws-store-secret.sh` ([argus#21](https://github.com/deanjstone/argus/issues/21)) puts one
value into Bitwarden Secrets Manager (BWS). The owner pastes the value at a hidden prompt
(`read -rsp`), so it never appears in a chat, a `!` command, shell history or a command line they
type. Every name comes from an environment variable, so the script holds nothing specific to one
secret. An agent prepares the command and the owner runs it: an agent never runs it against the real
store and never sees the value.

## Run it

```bash
BWS_SECRET_KEY=example-service-token \
BWS_SIBLING_KEY=example-service-other-token \
SECRET_NOTE="what it is for" \
  bash scripts/bws-store-secret.sh
```

Preview first. `--dry-run` reads the secret list, says whether it would create or replace, and
changes nothing; it does not prompt:

```bash
BWS_SECRET_KEY=example-service-token BWS_PROJECT_ID=<project-uuid> bash scripts/bws-store-secret.sh --dry-run
```

| Variable | Needed | Meaning |
|---|---|---|
| `BWS_SECRET_KEY` | yes | The key to store under |
| `BWS_PROJECT_ID` | one of the two | The project to create the secret in |
| `BWS_SIBLING_KEY` | one of the two | An existing key; the secret goes in that key's project. `BWS_PROJECT_ID` wins if both are set |
| `SECRET_NOTE` | no | The secret's note |
| `SECRET_EXPIRES` | no | `YYYY-MM-DD`. The note then ends `Expires <date>` |
| `SECRET_PREFIX` | no | Warns (and still stores) when the pasted value does not start with it |
| `BWS_TOKEN_FILE` | no | File that sets `BWS_ACCESS_TOKEN` (default `~/.bws_token`); a `BWS_ACCESS_TOKEN` already in the environment is used instead |

A GitHub fine-grained token: set `SECRET_PREFIX=github_pat_`. `SECRET_EXPIRES` then defaults to 12
months from today, the standing rule for those tokens; set it to override. Put the date in the note
so the renewal is visible in the vault.

## Behaviour

- A missing required variable, a malformed `SECRET_EXPIRES` or an unknown argument exits 2 before
  anything is read or called.
- An empty paste prints `Nothing pasted, nothing stored.` and exits 1.
- The key already exists in that project: the value is replaced with `bws secret edit --value`, never
  a second secret. An existing note is kept unless `SECRET_NOTE` or an expiry is given.
- After the write it lists the secrets and exits 1 with `Store FAILED` unless the key is visible.
- It prints the project, the length of the paste and the key. Never the value.

While `bws` runs, the value is in that one process's arguments (`bws` 2.x has no stdin form), visible
only to the same user for that moment.

## Tests

`scripts/bws-store-secret.test.ts` runs the real script against a stub `bws` on `PATH`; the real
Secrets Manager is never called. It covers create, replace, a missing variable, an empty paste, a
wrong prefix, the expiry note, the dry run and that the value never reaches stdout or stderr. The
repo's script tests are vitest (`pnpm run test:scripts`), so this suite is too.
