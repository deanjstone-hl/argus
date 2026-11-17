# t3-peer-mcp

MCP server that lets the T3 Code environment it runs in see, message and control threads on
another environment's T3 server. Deployed on WSL2 and homelab, each one points at the other, so
an agent in a T3 thread on one machine can work with threads on the other.

T3 has no server-to-server federation, and its own `t3-code` MCP tools only reach the server they
run on. Each T3 server binds only to `127.0.0.1:3773`.

## Tools

| Tool | What it does |
|---|---|
| `peer_projects` | Live projects on the peer, with their workspace roots (the peer's paths) |
| `peer_thread_list` | Threads on the peer, newest first. Filter by project root, title, status. Archived threads with `includeArchived` |
| `peer_thread_read` | One thread's status, active run, and last N messages |
| `peer_thread_send` | Message a thread. `auto` starts an idle thread or steers a running turn. Also `queue`, `steer` and `restart` |
| `peer_thread_launch` | Create a thread in a peer project and start its first turn, in the main checkout or a new worktree |
| `peer_thread_interrupt` | Interrupt the active run |
| `peer_thread_organize` | Archive, unarchive, settle or unsettle a thread |

Every message and launch prompt gets a trailing `[Sent via t3-peer from the <self> T3 environment]`
line, so the receiving agent knows the message came from the other environment and not from its
user. Launched threads run in `full-access` mode with nobody watching.

## How it reaches the peer

Everything goes over SSH. Nothing new is exposed on the network, and no token is stored anywhere.

1. `ssh <peer> bash -s` runs a short script on the peer. It finds the T3 binary (from
   `~/.t3/runtime/service-state.json`, or from the pid in `server-runtime.json` on a desktop
   backend) and runs `t3 auth session issue --ttl 15m`. The token comes back on the SSH channel's
   stdout and is kept in memory only. It never appears in argv, a URL or a file.
2. `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<peer port>` opens a tunnel to the peer's T3.
3. Reads use T3's HTTP API (`/api/orchestration/shell`, `/api/orchestration/threads/:id/bounded`)
   with `x-t3-orchestration-protocol: 2`. Writes use the `/ws?orchestrationProtocol=2`
   Effect-RPC socket (`orchestration.dispatchCommand`, `orchestration.launchThread`,
   `orchestration.getArchivedShellSnapshot`), because T3 0.0.46 removed the HTTP dispatch route.
4. The session is reused for 12 minutes, then replaced, and the old one is revoked. The last one
   is revoked when the server exits.

The command schemas were read from the installed T3 binary (`strings <t3> | grep
OrchestrationV2Command`). If a call breaks after a `t3 update`, look there first. An unknown
`/api` route answers `200` with the web app's HTML instead of a 404, so the client checks the
content type on every read.

## Configuration

`T3_PEER_CONFIG` names a JSON file. The default is `~/.argus/t3-peer-mcp/peers.json`:

```json
{ "self": "wsl", "peers": [{ "name": "homelab", "ssh": "homelab" }] }
```

`ssh` is any destination `ssh` accepts. The host key must already be in `known_hosts`, because
the server runs ssh with `BatchMode=yes`. The per-environment files live in argus-config
(`envs/<env>/t3-peers.json`). argus-config's `register_t3_peer_mcp` registers the server in
`~/.claude.json` through `hooks/t3-peer-mcp-launch.sh` and points `T3_PEER_CONFIG` at the file.

## Run, test, deploy

```bash
pnpm test               # vitest: command builders, RPC reply parsing, config, tool helpers
pnpm run build
bash deploy.sh          # build, sync dist/ and runtime deps to ~/.argus/t3-peer-mcp/
```

Run `deploy.sh` on each environment. On homelab, run it from `/home/srvr/repos/argus` once the
change is on `main`. A new T3 thread picks the server up. A running thread does not.
