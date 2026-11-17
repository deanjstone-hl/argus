# herdr-remote deep-dive

**Ticket:** [deanjstone/argus#131](https://github.com/deanjstone/argus/issues/131) (child of map [#129](https://github.com/deanjstone/argus/issues/129))
**Date:** 2026-08-05
**Primary source:** [dcolinmorgan/herdr-remote](https://github.com/dcolinmorgan/herdr-remote) (README, source under `relay/`, `LICENSE`, issue tracker) fetched directly via `gh api`/`gh repo view` — not a secondhand summary. Comparison points against collie use the locally cloned `~/projects/reference/collie` (README.md, ARCHITECTURE.md, CHANGELOG.md, `.env.example`).

---

## 1. Architecture

herdr-remote is **not** a single herdr plugin the way collie is — it's an umbrella project with five components, only one of which is a herdr plugin:

| Component | What it is | Source |
|---|---|---|
| **Herdi.app** | Standalone native macOS menu bar app (packaged as a `.dmg` release asset). Zero-config: discovers local herdr agents directly, no relay needed for local-only use. | README "Install" section |
| **`relay/herdr_relay.py`** | Python (uv-run) WebSocket + HTTP server on port 8375. This is the bridge/hub all remote surfaces talk to — functionally the same role as collie's `bridge`. 603 lines. | `relay/herdr_relay.py` |
| **Web PWA** (`web/`) | Phone client, served by the relay itself at `/` (`index.html`), plus a live hosted demo at `herdr-demo.pages.dev` (Cloudflare Pages). Connects over WebSocket to whatever relay/tunnel URL the user pastes in. | README, `herdr_relay.py:366-378` |
| **`relay/herdr_telegram.py`** | Standalone Telegram bot (python-telegram-bot), 898 lines. Owns its own BotFather bot/token — this is a full command bot, not a notification forwarder (see §3). | `relay/herdr_telegram.py` |
| **`relay/herdr_tui.py`** | Terminal UI client, also talks to the relay over WS. | README "Terminal TUI" |
| **[dcolinmorgan/herdr-push](https://github.com/dcolinmorgan/herdr-push)** | The actual herdr plugin (`herdr plugin install dcolinmorgan/herdr-push`). Zero-dependency (curl + system Python/jq) — fires on herdr's `pane.agent_status_changed` event, `curl POST`s to whatever `HERDR_RELAY` URL is configured. This is the herdr-side hook that feeds the relay; it's the closest analog to collie's plugin role, but push-only. | `dcolinmorgan/herdr-push` README |

Published architecture diagram (README):

```
                    macOS Menu Bar (Herdi.app)      <- zero config

  Web App (phone)   Telegram Bot   TUI (terminal)
         \_______________|________________/
                  WebSocket
                     |
            relay (:8375)  <- Cloudflare tunnel
                     |
        local poll (herdr CLI) | herdr-push (HTTP POST)
              |                        |
           herdr local            herdr remote
```

So: local monitoring goes through the native menu-bar app talking to herdr directly (no relay, no plugin). Remote/phone/Telegram monitoring — the part actually relevant to this map's "(b) remote-access layer" — goes through the `relay` process, fed either by the relay polling the local `herdr` CLI directly, or by the `herdr-push` plugin POSTing events in from a separate/remote herdr instance.

This is architecturally broader in scope than collie: collie is one bridge process serving one PWA over `tailscale serve`. herdr-remote bundles a native macOS app, a relay/bridge, a PWA, a full Telegram bot, and a TUI, with a separate companion plugin repo for the herdr-side push hook.

---

## 2. Tunnel mechanism and security model — the crux

**Mechanism:** [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) via the `cloudflared` binary, confirmed in `relay/start.sh`:

```bash
if [ "$TUNNEL_MODE" = "temp" ]; then
    echo "Starting temp tunnel..."
    cloudflared tunnel --url "http://localhost:$WS_PORT" 2>&1 &
    ...
    TUNNEL_URL=$(grep -o 'https://[^ ]*\.trycloudflare\.com' /proc/$TUNNEL_PID/fd/1 ...)
```

Default mode is `temp` — a **Cloudflare "quick tunnel"**: no Cloudflare account, no auth, `cloudflared` just requests an ephemeral `*.trycloudflare.com` hostname from Cloudflare's edge and proxies it to `localhost:8375`. This is what "free tunnel, no Tailscale needed" means concretely — it is a third-party relay (Cloudflare's edge network terminates TLS and routes inbound traffic from the public internet to the local port), not self-hosted and not peer-to-peer. An optional `named` mode exists (`HERDR_TUNNEL_MODE=named`) that binds to a real Cloudflare account/tunnel via `cloudflared tunnel login`, configured through `install-service.sh`.

**Exposure model — what's reachable with just the URL:**

The relay's own HTTP/WS handler (`relay/herdr_relay.py`) shows:

- `AUTH_TOKEN = os.environ.get("HERDR_RELAY_TOKEN", "")` — **empty by default** (line 47). Auth is opt-in, not opt-out.
- Token check (lines 333–347) runs before both HTTP responses and the WebSocket upgrade, so *if set* it does gate both — but nothing forces it to be set. The README's own "Remote monitoring" quick-start (`herdr plugin install ... && cd herdr-remote/relay && ./start.sh`, then paste the tunnel URL into the PWA) never mentions setting a token — the documented 10-second path runs with **no authentication at all**.
- CORS is wide open: `Access-Control-Allow-Origin: *` on every response, including the VAPID key and event-POST endpoints (lines 360, 399, 425).
- WebSocket `handle_client` (line 429) logs `Origin` and connecting IP/user-agent but **never validates them** — no Host-header allowlist, no origin allowlist, nothing equivalent to DNS-rebinding protection.
- Once connected (with or without a token, depending on config), a client can send message types including `respond` (approve/reject a blocked agent action), `read_pane` (full terminal output — can include source, secrets, credentials pasted into a shell), `send_keys`/`send_text` (inject arbitrary keystrokes/commands into the real terminal pane — i.e., command execution on the host), and `create_tab` (lines 461–531). This is a **full read/write control surface**, not read-only monitoring — a leaked/guessed tunnel URL with no token is equivalent to an unauthenticated shell.

**The one mitigating factor:** `relay/install-service.sh`, the *managed* install path (`./install-service.sh`, sets up a systemd/launchd service), does prompt for a relay token and **defaults to yes** (`Secure the relay with an access token? [Y/n]`, line 288) — it generates a 32-byte hex token via `generate_relay_token()` (`python3 -c 'import secrets; print(secrets.token_hex(32))'`) and appends it as `?token=` to `HERDR_RELAY`, stored in `~/.config/herdr-remote/secrets.env` at mode `0600`. So the "hardened" path exists and defaults on — but it's the *installer* path, not the README's advertised zero-config quick start, and there is no runtime warning (unlike collie, see below) if a relay is ever started without a token.

**Comparison to collie's tailnet-only model** (from `~/projects/reference/collie/README.md`, `ARCHITECTURE.md`, `.env.example`):

| | collie | herdr-remote |
|---|---|---|
| Exposure surface | Tailnet only, via `tailscale serve` (never `funnel`) — reachable only to devices already on the tailnet | Public internet, via a Cloudflare quick-tunnel URL anyone with the link can reach |
| Identity gate | Optional `COLLIE_TRUSTED_USER` — rejects any tailnet login but the one configured, using the `Tailscale-User-Login` header injected by `tailscale serve` | No identity concept at all — only a shared bearer/query-string token, optional, off by default in the documented quick-start |
| Anti-DNS-rebinding | Optional `COLLIE_PUBLIC_HOSTS` — explicit Host-header allowlist | None — CORS is `*`, Origin header is logged but not checked |
| Fail-open warnings | Bridge prints explicit startup warnings if `COLLIE_TRUSTED_USER` or `COLLIE_PUBLIC_HOSTS` is unset (`README.md:256-257`: *"any tailnet device/user that reaches the bridge gets full write access"*) | No equivalent runtime warning when `HERDR_RELAY_TOKEN` is unset |
| Default posture | Fail-open but tailnet-scoped (attacker must already be on the tailnet or exploit Tailscale itself) and self-documents the risk | Fail-open **and** internet-scoped in the primary documented flow (anyone with the URL, globally, no Tailscale/VPN needed) |

**Realistic threat model:** collie's worst case (both env vars unset) is "any device on your own tailnet has full control" — already flagged as a known gap in project memory. herdr-remote's worst case, and its *default advertised path*, is "anyone who obtains the `trycloudflare.com` URL — via shoulder-surfing, browser history sync, a leaked screenshot, Cloudflare/ISP-level logging, or simply enumerating short-lived quick-tunnel subdomains — has full read/write control of your terminal, including arbitrary command injection." This is a materially larger blast radius than collie's already-acknowledged gap, and it is the *documented default*, not an edge case reachable only by misconfiguration. The named-tunnel + `install-service.sh` path narrows this (token defaults on, tied to a real Cloudflare account instead of an anonymous quick tunnel), but that is the harder, opt-in path — the inverse of collie's "tailnet-only always, auth optional on top" posture.

**License note (governance-relevant, not security):** herdr-remote is dual-licensed **AGPL-3.0-or-later** + commercial (`LICENSE` file, confirmed via `gh api .../contents/LICENSE`). collie is MIT (`gh api repos/AltanS/collie/license`). AGPL's network-copyleft clause is a real consideration if argus were to fork/modify and self-host a derivative rather than just run it as-is.

---

## 3. Telegram integration

`relay/herdr_telegram.py` (898 lines, uses `python-telegram-bot`) is a **standalone bot with its own BotFather token** — not a plugin into ccbot, not a webhook consumer of ccbot, and not merely a notification channel. It is fully chat-native and bidirectional:

- Commands registered (`main()`, lines ~868-883): `/start`, `/agents`, `/status`, `/read`, `/reply`, `/send`, `/trust`, `/digest`, `/interrupt`.
- `/read`, `/reply`, `/send` let the user read pane output and send text/commands to a blocked or running agent directly from Telegram — the bot relays these over the same WebSocket protocol described in §2 (`respond`, `send_text`, `send_keys` message types), so it inherits the relay's control surface (arbitrary command injection into the agent's terminal), not just approve/reject.
- `/trust` — trusts all tools for a blocked agent (auto-approve), `/interrupt` — sends Ctrl+C to the pane.
- Inline callback buttons (`CallbackQueryHandler`) drive one-tap approve/reject from notifications, and replying directly to a bot message routes text back to the correct pane via a `pending` map keyed by `(chat_id, message_id)`.

**Auth model for the Telegram surface specifically:**
- `CHAT_ID = os.environ.get("HERDR_TG_CHAT_ID", "")`.
- `authorized(update)` (line 126): **if `CHAT_ID` is unset, every chat is authorized** — this is explicitly a "first-run discovery mode" so the user can message the bot once to learn their chat ID before locking it down (line 320: `text += "\n\nChat ID: {chat_id}"`).
- Once `HERDR_TG_CHAT_ID` is set, `filters.Chat(chat_id=int(CHAT_ID))` is applied to every `CommandHandler` and the text `MessageHandler` (lines 868-883), and `handle_callback` independently re-checks `str(update.effective_chat.id) != CHAT_ID` before honoring button presses (line 553) — so once configured, it's a hard single-chat allowlist, not just a UI filter.
- Deployment: `install-service.sh` walks through creating the bot via `@BotFather /newbot`, validates the token against the live Telegram API (`validate_telegram_token`), and stores it plus the chat ID in `~/.config/herdr-remote/secrets.env` (mode `0600`). Notably, the README states the Telegram path talks to the relay **over localhost** and therefore does **not** require the Cloudflare tunnel at all — only outbound internet to `api.telegram.org` is needed. This means Telegram-only usage of herdr-remote can avoid the tunnel exposure discussed in §2 entirely, at the cost of losing phone-PWA/menu-bar remote access.

**Relevance to the separate Telegram-overlap ticket:** herdr-remote's bot is herdr-specific, single-project-relay-scoped (one relay process ↔ one Telegram bot ↔ one chat), and has no concept of multiple projects/repos or the topic-per-project routing ccbot already does. ccbot is a general Claude Code hook bridge across all of argus's repos with per-chat/topic routing (see `deanjstone/ccbot`); herdr-remote's bot is scoped purely to herdr agent panes (read/send/interrupt/trust/digest) with none of ccbot's session/hook/multi-project awareness. They don't share code or protocol — adopting herdr-remote's Telegram bot would mean running a **second, independent Telegram bot** alongside ccbot's, with its own BotFather token and its own single-chat allowlist, rather than extending ccbot. Whether that's additive (herd-specific commands ccbot doesn't have: `/trust`, `/interrupt`, `/digest`, one-tap approve) or redundant (both end up polling/relaying "agent needs you" signals into Telegram) is a design call for that downstream ticket, not resolved here — but the two systems are structurally independent, not layered.

---

## 4. Maturity and scope vs. collie

| | herdr-remote | collie | herdr-push (companion plugin) |
|---|---|---|---|
| Created | 2026-06-21 | 2026-06-28 | 2026-06-23 |
| Last push | 2026-07-31 | 2026-08-04 | 2026-07-09 |
| Stars | 183 | 244 | 7 |
| Forks | 26 | 32 | 2 |
| Open issues | 9 | 0 | 0 |
| Total commits (all-time, `gh api .../commits`) | 112 | — (not queried; out of scope) | — |
| License | AGPL-3.0-or-later + commercial | MIT | — |

Both projects are roughly the same age (within a week of each other) and both are active as of the ticket date (2026-08-05); collie has marginally more stars/forks and zero open issues (vs. herdr-remote's 9 open, including a currently-open bug about the HTTP event-push endpoint silently returning 200 while discarding the event — issue [#21](https://github.com/dcolinmorgan/herdr-remote/issues/21)). Sample of open issues: Windows support requested but unimplemented ([#6](https://github.com/dcolinmorgan/herdr-remote/issues/6)), a Telegram/Codex Enter-key bug ([#17](https://github.com/dcolinmorgan/herdr-remote/issues/17)), and a licensing clarification thread ([#3](https://github.com/dcolinmorgan/herdr-remote/issues/3), closed — the AGPL/commercial dual-license was added in response).

**Scope comparison:** herdr-remote is **not** "one plugin among herdr's marketplace" the way collie is. collie is a single bridge+PWA plugin. herdr-remote is a small product suite: a signed native macOS menu-bar app with its own release cadence (`Herdi.app`, versioned independently — README changelog goes v0.5.0 → v0.7.0 with app-specific features like a "notch panel," Web Push/VAPID, workspace drill-down UI), a relay/bridge, a PWA, a full Telegram bot, a TUI, and a separate zero-dep companion plugin repo (`herdr-push`) that does the actual herdr-plugin-marketplace integration. If argus adopts herdr-remote's approach, the more accurate framing is "adopt an external multi-surface product" rather than "install a plugin" — a larger surface to vet, update, and trust than collie's single bridge process.

---

## Summary for the map ticket

- herdr-remote's "no Tailscale needed" tunnel is a real, third-party, public-internet-facing Cloudflare quick-tunnel (`*.trycloudflare.com`), not a self-hosted or peer-to-peer mechanism, and its documented default path ships with **no authentication and no origin/host validation** on the relay that grants full read + arbitrary-command-injection access to any agent pane. This is a strictly larger and more exposed threat surface than collie's already-flagged tailnet-only gap, and it directly conflicts with the house tailnet-only / never-`funnel` standing preference.
- A hardened path exists (`install-service.sh`, named tunnel, token defaulted-on) but is opt-in and not the documented quick-start; even hardened, there's no per-identity gate analogous to `COLLIE_TRUSTED_USER` — only a shared bearer token.
- Its Telegram bot is a separate, fully chat-native, bidirectional control bot (own BotFather token, per-chat allowlist once configured) — structurally independent of ccbot, not a plugin into it. Feeds directly into the downstream Telegram-overlap ticket.
- Scope-wise it's a broader multi-surface product (native app + relay + PWA + Telegram bot + TUI + companion plugin) than collie's single-plugin footprint, and is AGPL/commercial dual-licensed vs. collie's MIT — both relevant if any part of it is being adopted/forked rather than just referenced architecturally.

**Recommendation implied by the above (for the calling session to weigh, not decided here):** herdr-remote is a strong architectural *reference* for menu-bar/phone/Telegram UX patterns (notch panel, one-tap approve, `/digest`, workspace drill-down), but its tunnel/auth defaults should not be adopted as-is — any custom remote-access layer built for argus should keep collie's tailnet-only-by-default, explicit-warning-on-unset-guardrails posture rather than herdr-remote's opt-in-token-over-public-tunnel posture.
