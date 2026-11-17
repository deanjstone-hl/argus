---
summary: Index of argus's self-contained HTML/SVG diagrams, one per app flow plus the repo architecture and build and deploy
read_when:
  - tracing how an argus app, the repo or its deploy path fits together
  - redrawing a diagram after its sources changed
  - linking a diagram step from the ops hub Diagrams page
---

# Diagrams

Self-contained HTML/SVG diagrams for argus, drawn with the [diagram-design](https://github.com/cathrynlavery/diagram-design)
Claude Code plugin (v2.6.119, default skin) in the house style of
[argus-config's diagrams](https://github.com/deanjstone/argus-config/tree/main/docs/diagrams)
(map [argus-config#1433](https://github.com/deanjstone/argus-config/issues/1433), ticket
[argus#1208](https://github.com/deanjstone/argus/issues/1208)). Open the `.html` file in a browser.

Each step node is a `<g id="step-<flow>-<step>">`, the deep-link contract of
[ops-hub#13](https://github.com/deanjstone/ops-hub/issues/13): the hub links
`#/diagrams/<repo>/<path>#<step-id>`, and the page also highlights the targeted step (`:target`).
Anything inferred is marked `[speculation]` in the diagram or its source line.

| Diagram | Type | Flow | Step ids |
|---|---|---|---|
| [`architecture.html`](architecture.html) | Architecture | `arch` | `cli` `engine` `vault` `models` `loopstate` `callers` `t3peer` `hub` `t3` `manifest` `shim` `collector` `packages` `worker` `dashboard` |
| [`agent.html`](agent.html) | Process (agent-cli, agent-engine) | `agent` | `cmd` `health` `chat` `plan` `session` `dag` `route` `reply` |
| [`loop-state.html`](loop-state.html) | Request (loop-state-mcp) | `lstate` | `caller` `hub` `publish` `auth` `mcp` `routes` `store` `result` |
| [`loop-state-slots.html`](loop-state-slots.html) | State machine (loop-state-mcp) | `slots` | `running` `awaiting` `parked` `resumed` `ready` `gone` |
| [`t3-peer.html`](t3-peer.html) | Request (t3-peer-mcp) | `peer` | `call` `mint` `tunnel` `read` `write` `peer` `reuse` |
| [`watchtower.html`](watchtower.html) | Data flow (watchtower, collector, usage shim) | `wt` | `sources` `shim` `collector` `post` `d1` `prune` `get` `dash` |
| [`build-deploy.html`](build-deploy.html) | Pipeline (CI, Release, deploy targets) | `build` | `push` `ci` `approve` `release` `cloudflare` `homelab` `wsl2` `ecosystem` |

The two shared packages (`bearer-auth`, `watchtower-contract`) are in the architecture diagram, not
drawn on their own. The older hand-drawn
[`../architecture/watchtower-data-flow.html`](../architecture/watchtower-data-flow.html) stays where it is.

## Not drawn

- Product apps that left this repo (ops-hub, memory-mcp, email, wiki, x-mcp, vault-agent): they have their own repos.
- Each watchtower collector adapter, and which host runs the usage shim.
- The agent-engine run-plan, live-notes and plans routes, and the loop-state leases, directives and `slot_rebuild`.

## Network

The diagrams use the system font stack and make no network request.

## Redrawing

The diagrams are hand-checked against their sources, not generated from them. After the sources change,
redraw with the plugin and rerun its checks: `self_check.py` in the skill directory and
`verify-geometry.py` in the plugin's `scripts/`.
