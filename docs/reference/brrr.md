---
title: brrr — Push Notification Integration
description: Reference for integrating brrr (brrr.now) native iOS push notifications across the argus stack
tags: [notifications, ios, brrr, ccbot, hooks]
created: 2026-07-02
summary: brrr iOS push notification integration and the brrr-notify wiring
read_when:
  - sending or debugging a push notification
  - touching the brrr-notify action or hook
---

# brrr — Push Notification Integration

> **Historical (ccbot sections).** ccbot-argus is decommissioned (argus#302) and its source was removed in #407. The ccbot-argus parts below describe the integration as it was built and are kept as a record. `brrr-notify` and the hook wiring are unaffected. Telegram is no longer the primary channel.

**brrr** (https://brrr.now) is a minimalist native iOS/iPadOS/macOS push notification service by Simon B. Støvring. Zero-account, zero-stored-messages, one webhook URL.

## Why brrr in the argus stack

brrr is the stack's one push channel. It is native APNs, needs no account, stores
nothing server-side, and takes a single HTTP call from any script, hook or service.
It is read-only: a push can open a URL (`open_url`) but cannot carry a reply, so any
"answer this" flow opens a page that can.

**Never send `critical`.** It is not to be used without the user's explicit permission
in that conversation. `time-sensitive` is the highest level any sender may choose.

---

## API reference

**Base URL:** `https://api.brrr.now/v1/`

### Secret format

```
br_usr_a1b2c3d4e5f6g7h8i9j0
```

Treat as a password. Store in Bitwarden as `brrr-webhook-secret`.

### Send endpoints

**Plain text POST (simplest):**
```bash
curl -X POST https://api.brrr.now/v1/{secret} -d 'Hello world'
```

**GET (browser / quick test):**
```
https://api.brrr.now/v1/{secret}?message=Hello&title=Test
```

**Authorization header (avoids secret in URL logs):**
```bash
curl -X POST https://api.brrr.now/v1/send \
  -H 'Authorization: Bearer {secret}' \
  -d 'Hello world'
```

**JSON payload (full control):**
```bash
curl -X POST https://api.brrr.now/v1/{secret} \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "argus",
    "subtitle": "agent-engine",
    "message": "Task completed",
    "thread_id": "agent-engine",
    "interruption_level": "passive",
    "sound": "upbeat_bells"
  }'
```

### Payload fields

| Field | Type | Notes |
|---|---|---|
| `message` | String | Required. Primary notification body. |
| `title` | String | First line (bold). |
| `subtitle` | String | Second line under title. |
| `thread_id` | String | Groups related notifications. Use project name. |
| `interruption_level` | String | `passive` · `active` · `time-sensitive` · `critical` |
| `volume` | Number | 0–1. Only applies to `critical` level. |
| `sound` | String | 16 options — e.g. `upbeat_bells`, `chime`. |
| `open_url` | String | URL opened when notification is tapped. |
| `image_url` | String | Notification image. |
| `expiration_date` | ISO 8601 | Delivery retry window. |
| `filter_criteria` | String | Focus filter matching string. |

`icon_url` (String) replaces the app icon with a custom image, but hides `subtitle`.
Sounds: `default`, `system`, `brrr`, `bell_ringing`, `bubble_ding`,
`bubbly_success_ding`, `cat_meow`, `calm1`, `calm2`, `cha_ching`, `dog_barking`,
`door_bell`, `duck_quack`, `emergency`, `short_triple_blink`, `upbeat_bells`,
`warm_soft_error` ([docs](https://brrr.now/docs/)).

### Notification classes

Every sender tags each push with one class. The class sets `filter_criteria` and
`sound`, so the phone (not the sender) decides what breaks through, and each class is
recognisable by ear.

| Class | `filter_criteria` | `sound` | Level | Used for |
|---|---|---|---|---|
| Waiting | `waiting` | `door_bell` | `active` | A session needs an answer (Notification, PermissionRequest) |
| Failure | `failure` | `warm_soft_error` | `active` or `time-sensitive` | Run failed, CI failed, sync drift, agent-engine task failed |
| Done | `done` | `bubbly_success_ding` | `passive` | Run complete, CI passed, drift recovered, task completed |
| Board | `board` | `bubble_ding` | `active` | Notice-board message (see `docs/research/agent-notice-board-survey.md`) |
| Quota | `quota` | `calm1` | `passive` | The 5-hour window passed 85% (Aquila, once per window) |

Also set, where the sender has them:

- `subtitle`: the repo or workspace, so the body stays short.
- `thread_id`: groups in Notification Center. Per-repo for session pushes
  (`argus-runs-<repo>`), fixed per source otherwise (`github-actions`, `syncthing-drift`).
- `open_url`: where tapping should land, e.g. the GitHub Actions run.
- `expiration_date`: on `waiting` pushes, about 10 minutes out, so a late delivery does
  not nag about a session that has already been answered.

**Focus filters (one-off, on the phone):** Settings → Focus → *Work* / *Sleep* → Focus
Filters → brrr, and enter the criteria that may break through, e.g. Work = `waiting`,
`failure`; Sleep = `failure`.

---

## Stack integration map

```
┌─────────────────────────────────────────────────────┐
│                  argus stack                         │
│                                                      │
│  ccbot-argus                                         │
│  ├─ TelegramChannel (interactive: Allow/Deny, cmds) │
│  ├─ SlackChannel                                     │
│  └─ BrrrChannel ← NEW (native push, Focus bypass)   │
│                                                      │
│  hooks/ (Stop, SubagentStop, AskUserQuestion)        │
│  └─ brrr-notify shell wrapper ← NEW                 │
│                                                      │
│  agent-engine                                        │
│  └─ task completion → brrr push ← NEW               │
│                                                      │
│  GitHub Actions (argus, myargus)                     │
│  └─ deploy success/failure → brrr push ← NEW        │
└─────────────────────────────────────────────────────┘
```

---

## Integration implementations

### 1. Bitwarden secret (prerequisite)

```bash
# After installing brrr iOS app and copying the webhook URL:
bw create item '{
  "type": 1,
  "name": "brrr-webhook-secret",
  "notes": "brrr.now webhook secret for argus push notifications",
  "login": {
    "password": "br_usr_..."
  }
}'
```

Retrieve at runtime:
```bash
BRRR_SECRET=$(bw get password brrr-webhook-secret)
```

### 2. brrr-notify shell wrapper

The canonical script is argus-config
[`envs/wsl2/bin/brrr-notify`](https://github.com/deanjstone/argus-config/blob/main/envs/wsl2/bin/brrr-notify),
linked to `~/.local/bin/brrr-notify`. Read it there: the copy that used to be inlined here had
drifted from it and lacked the argus-config#290 PATH fix
([#418](https://github.com/deanjstone/argus/issues/418)).

Usage from any hook script:
```bash
brrr-notify "Task completed in agent-engine" --level passive --thread agent-engine
brrr-notify "Permission required" --level time-sensitive --thread argus
```

### 3. ccbot-argus BrrrChannel

New channel at `packages/ccbot/src/channels/brrr/brrr.ts`. The channel:
- POSTs to `https://api.brrr.now/v1/send` with `Authorization: Bearer` header
- Maps ccbot notification `type` → interruption level (see mapping table above)
- Sets `thread_id` to the workspace/project name
- Falls back silently if secret is missing (no BW session)

Config in `.env`:
```env
BRRR_WEBHOOK_SECRET=br_usr_...
BRRR_ENABLED=true
```

Config block in `ccbot.config.json`:
```json
{
  "channels": {
    "brrr": {
      "enabled": true,
      "config": {
        "secret": "${BRRR_WEBHOOK_SECRET}",
        "defaultThread": "argus",
        "levelMap": {
          "waiting": "time-sensitive",
          "permission": "time-sensitive",
          "stuck": "active",
          "completed": "passive",
          "error": "active"
        }
      }
    }
  }
}
```

### 4. GitHub Actions

Add to `.github/workflows/deploy-*.yml`:

```yaml
- name: Notify via brrr
  if: always()
  run: |
    STATUS="${{ job.status }}"
    LEVEL="passive"
    [[ "$STATUS" == "failure" ]] && LEVEL="active"
    curl -sS -X POST "https://api.brrr.now/v1/send" \
      -H "Authorization: Bearer ${{ secrets.BRRR_WEBHOOK_SECRET }}" \
      -H "Content-Type: application/json" \
      -d "{
        \"title\": \"argus CI\",
        \"message\": \"${{ github.workflow }}: ${STATUS}\",
        \"interruption_level\": \"${LEVEL}\",
        \"thread_id\": \"github-actions\"
      }"
```

Add `BRRR_WEBHOOK_SECRET` to GitHub Actions secrets.

> The `brrr-notify` composite action this section describes was removed with the public cut (argus#1207): a workflow a pull request starts reads no secret but the read-only token, so CI no longer sends a brrr notification.

### 5. agent-engine task completion

In the agent-engine HTTP API task completion handler, fire a brrr push via `fetch`:

```typescript
async function notifyBrrr(message: string, level = 'passive', thread = 'agent-engine') {
  const secret = process.env.BRRR_WEBHOOK_SECRET;
  if (!secret) return;
  await fetch('https://api.brrr.now/v1/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, interruption_level: level, thread_id: thread, title: 'agent-engine' }),
  });
}
```

Call on task state transitions: `completed`, `failed`, `waiting_for_input`.

---

## Secrets checklist

| Secret | Bitwarden item name | Used by |
|---|---|---|
| Webhook secret | `brrr-webhook-secret` | ccbot, brrr-notify, agent-engine |
| GitHub Actions secret | `BRRR_WEBHOOK_SECRET` | CI/CD deploy notifications |

---

## References

- App: https://brrr.now/ (App Store — iOS/iPadOS/macOS)
- Docs: https://brrr.now/docs/
- Learn: https://brrr.now/learn/
- Creator: Simon B. Støvring (@simonbs)
