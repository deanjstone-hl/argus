---
title: Dell-Server Integration Plan
status: archived
date: 2026-06-21
summary: Archived 2026-06 plan for integrating the Dell homelab server; do not act on it
read_when:
  - "tracing the homelab's original integration plan"
---

> **Archived ([#418](https://github.com/deanjstone/argus/issues/418)).** Historical record of the
> 2026-06 plan. Homelab provisioning is owned by the homelab repo, and the units this plan
> specifies (`argus-session.service`, ccbot) are decommissioned. Do not act on it.

## Context

Adding a third environment — Dell Inspiron running Ubuntu 24.04 LTS Desktop (`dell-server`), managed via `~/repos/linux-server/`. Always-on Docker host reachable via Tailscale. User account is `srvr` (distinct from `deanj` on WSL2/Windows) to eliminate SSH ambiguity.

Claude Code sessions will run on dell-server with the same topology as WSL2. ccbot will run there too, feeding into a new central relay rather than each machine operating independently.

Three environments post-integration:

| Env | Machine | User | Home | Service manager |
|---|---|---|---|---|
| WSL2 | LNV-LGN5 | `deanj` | `/home/deanj` | systemd user |
| Windows | LNV-LGN5 | `deanj` | `C:\Users\deanj` | winget / manual |
| dell-server | Dell Inspiron | `srvr` | `/home/srvr` | systemd user + Docker |

---

## Architecture

### Session topology

Dell-server runs the same Claude + tmux topology as WSL2:

- `argus-session.service` (systemd user) — starts `main:argus` tmux session on boot
- ccbot (systemd user) — hook scripts + local receiver
- Session naming: same tmux-based rule; `/home/srvr` home dir → `SRVR_` prefix

### ccbot — central relay

All Telegram inbound traffic routes through one relay instead of each machine running an independent webhook server (which would require a separate bot token per machine or polling mode).

```
Telegram API
    │  (one bot token, one webhook URL)
    ▼
cloudflared tunnel ──► ccbot-relay (Docker on dell-server)
                              │
                 ┌────────────┴────────────┐
                 ▼  (Tailscale HTTP)       ▼  (localhost)
           WSL2 ccbot               dell-server ccbot
           local-receiver           local-receiver
           (systemd)                (systemd)
```

- **Outbound** (hook scripts → Telegram API): direct from each machine, unchanged
- **Inbound** (Telegram → Claude): single webhook to relay → relay inspects target machine from session context → forwards via Tailscale HTTP to correct machine's local receiver
- `MACHINE_PREFIX` env var on each machine (`wsl`, `dell`) prepended to outbound topic labels so Telegram topics are unambiguous across machines

### Service split on dell-server: systemd vs Docker

| Service | Manager | Reason |
|---|---|---|
| `argus-session` | systemd user | tmux session, same pattern as WSL2 |
| `ccbot` (receiver) | systemd user | needs user context to execute Claude hooks |
| `ccbot-relay` | Docker | always-on public-facing service; cloudflared tunnel |
| `agent-engine` | Docker | stateless HTTP server, no user context needed |
| `syncthing` | Docker | already running |

---

## Changes required

### `argus/packages/ccbot/`

1. Add `MACHINE_PREFIX` env var support in `workspace-router.ts` and all `detectSessionName` call sites
2. Add `--mode=relay`: Telegram webhook receiver + machine registry + forward-to-receiver logic
3. Add `--mode=receiver`: local HTTP listener accepting forwarded inbound commands from relay
4. `deploy.sh`: add `--target=server` — rsync to `srvr@dell-server:~/.argus/ccbot/` + restart systemd user service
5. WSL2 `ccbot.service`: remove `Wants=cloudflared-ccbot.service` (relay handles the public endpoint)

### `argus/packages/agent-engine/`

1. Add `Dockerfile`
2. `deploy.sh`: add `--target=server` — build, rsync or push artifact, restart via `docker compose`

### `argus/config/dell-server/` (new)

| File | Notes |
|---|---|
| `CLAUDE.md` | Near-identical to wsl2; `srvr` user; memory at `/data/CORTEX/MEMORY/`; same tmux session rule; relay note |
| `settings.json` | Hooks point to `node /home/srvr/.argus/ccbot/dist/...`; same hook structure as wsl2 |
| `gitconfig` | Symlink to `../wsl2/gitconfig` |
| `systemd/user/argus-session.service` | wsl2 version with `deanj` → `srvr` |
| `systemd/user/ccbot.service` | wsl2 version with `deanj` → `srvr`; no cloudflared dependency |

Skills installed: `write-adr`, `cortex-search`, `new-project`, `save-and-clear`, `memorise`, `archive-project`, `bw-sudo`, `tmux-mgmt`

Skills excluded: `deploy` (runs from WSL2 targeting server), `launch-claude` (no WT), `update-tools` (needs server-specific variant)

### `argus/config/scripts/`

- Rename `install-wsl2.sh` → `install-wsl2.sh`; update any references
- New `install-dell-server.sh`: `srvr` paths, CORTEX at `/data/CORTEX/MEMORY`, dell-server skills subset, enables both systemd user services

### `argus/config/wsl2/CLAUDE.md` + global `~/.claude/CLAUDE.md`

- Add session naming rule: `/home/srvr` → `SRVR_`; add dell-server examples

### `linux-server/services/`

- `ccbot-relay/`: Docker compose + cloudflared tunnel; `.env.example` with bot token, webhook secret, machine registry
- `agent-engine/`: Docker compose; port 3747 bound to Tailscale interface only

### `linux-server/scripts/phase8-claude.sh`

Extend after Claude Code install:

1. Clone argus to `~/repos/argus`
2. Run `config/scripts/install-dell-server.sh`
3. Enable `argus-session` and `ccbot` systemd user services

---

## Implementation order

1. ccbot: `MACHINE_PREFIX` + relay mode + receiver mode — unblocks all multi-machine routing
2. `config/dell-server/` + `install-dell-server.sh`
3. `linux-server/services/ccbot-relay/` + `linux-server/services/agent-engine/`
4. WSL2 ccbot service: drop cloudflared dependency
5. agent-engine: Dockerfile + `deploy.sh --target=server`
6. Rename `install-wsl2.sh` → `install-wsl2.sh`; update global CLAUDE.md session naming
7. `linux-server/scripts/phase8-claude.sh` extension
