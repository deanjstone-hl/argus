# @argus/agent-engine

HTTP server on port 3747 backing the `agent` CLI — chat, vector search, and the context API.

## Run

```bash
pnpm run build       # tsc → dist/
pnpm run start       # HTTP server (dist/server/http.js)
pnpm run test        # vitest
```

## Deploy

```bash
./deploy.sh           # local  — rsync dist/ → ~/.argus/agent-engine, then restart the unit
./deploy.sh server    # remote — rsync over SSH to $ARGUS_SERVER_HOST (default srvr@homelab), restart there
```

From a Claude Code session: `deploy agent-engine`.

Local mode restarts the `agent-engine` user unit when it is installed and polls
`http://localhost:3747/health` for ~10 s, failing the deploy if it doesn't answer — no separate
manual restart. With no unit installed it exits 0, prints the install hint and a `Start: node …`
line, and leaves nothing running.

Runtime state lives outside the repo: `~/.argus/engine.pid`, `~/.argus/engine.log`.

On WSL2 the engine runs as the `agent-engine` systemd user service. Install or regenerate the unit
once per machine with `bash systemd/install-agent-engine.sh`. It writes a generated copy of
[`systemd/agent-engine.service`](systemd/agent-engine.service) with this machine's fnm node path,
so the repo file is a template, not the deployed unit. homelab installs the same template through
its own `services/agent-engine/install.sh`.

## Chat endpoint

`POST /chat` takes `{ message, sessionId? }`.

- Without `sessionId` the message goes through the planner (`engine.run`) and the reply is
  `{ text }`. This is what `agent run` sends.
- With `sessionId` (a UUID the caller picks) the message is one turn of a conversation the
  `claude` CLI persists itself: the engine runs `claude --print --resume <sessionId>`, or
  `--session-id <sessionId>` when the CLI has no such conversation yet. The reply is
  `{ text, sessionId }`. There is no engine-side store; transcripts live under
  `~/.claude/projects/`, keyed by the engine's working directory, so a session only resumes on
  the engine that started it.

The `claude --print` child inherits the user's MCP servers, so `claude-memory` tools are
available to the model, and recall is model-driven (`memory_search`). Every spawn passes
`--settings '{"disableAllHooks":true}'` (`src/models/claudeCliArgs.ts`), so the child does not run the
user's Claude Code hooks; several of them write memory and the vault. The unit's `PATH` must include
`~/.local/bin`, where the native `claude` launcher lives; `install-agent-engine.sh` adds it.

## Run-plan endpoint

`POST /task/run-plan` takes `{ plan: DAGPlan }` and runs every task it can. The reply is
`{ text, tasks }`:

- `text` joins the outputs of the completed tasks with a blank line, as before.
- `tasks` maps each task id to `{ status, output?, error? }`. `status` is `completed`, `failed`
  or `skipped`; a task is skipped when a dependency did not complete. One failed task no longer
  hides its siblings' results, and a tool-argument validation failure is `failed`, not output.
- A task with `toolName: 'feedback_loop'` runs as a feedback loop (`runWithFeedback`) using
  its top-level `validator`, `maxRounds` and `initialPrompt`. `initialPrompt` may be a
  `$task_<id>` reference. A loop that never passes its validator is `failed`, with its last
  output kept.
- A cycle, or a dependency id that names no task, rejects the whole plan with `500 { error }`
  before anything runs. The message names the task.

### Browser access

The myargus `/workflows` editor calls this route from the browser
([#543](https://github.com/deanjstone/argus/issues/543)). A request that carries an `Origin`
header is a browser request:

- The origin must be in `ARGUS_CORS_ORIGINS`, or the request (preflight included) gets `403`
  and no `Access-Control-Allow-Origin`. `*` is ignored. `/health` uses the same allow-list,
  without a token, so the UI can probe reachability.
- It must send the shell's Supabase session token as `Authorization: Bearer <access_token>`.
  The engine verifies it against the project's published key set
  (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, so no secret is needed) and requires
  `sub` to equal `ARGUS_PLANS_OWNER_USER_ID`. A missing, expired or forged token gets `401`,
  another user's token `403`, and missing config `503`.

A request with no `Origin` (agent-cli, scripts, `curl`) needs no token and behaves as before.
The `/task/live-notes/*` routes sit behind the same gate.

| Variable | Example |
|---|---|
| `ARGUS_CORS_ORIGINS` | `https://myargus.cc,http://localhost:5173` |
| `SUPABASE_URL` | The myargus project URL, shared with the plans endpoint |
| `ARGUS_PLANS_OWNER_USER_ID` | The owner's `auth.users` id, shared with the plans endpoint |

## Plans endpoint

`POST /plans` publishes an implementation plan to the myargus.cc Supabase project for the shell
app's `/plans` routes ([ADR-010 in myargus](https://github.com/deanjstone/myargus/blob/main/docs/decisions/adr-010-plans-feature.md)).
It writes `plans.plans` and `plans.plan_steps`, the tables created by myargus#141's migration
(`supabase/migrations/20261008000000_plans_schema.sql`).

```http
POST /plans
Authorization: Bearer <ARGUS_PLANS_TOKEN>
Content-Type: application/json

{ "title": "Ship Plans", "subtitle": "optional", "slug": "optional", "sessionId": "optional",
  "steps": [
    { "type": "predone", "title": "Write ADR", "doneNote": "Completed 04 Jul 2026" },
    { "type": "user", "title": "Add endpoint", "badge": "wsl", "checkLabel": "Tests pass", "content": "<p>…</p>" },
    "A bare string is a user step with only a title"
  ] }
```

- Steps use the impl-plan skill's step objects unchanged. `type` defaults to `user`, and `badge` is
  one of `wsl`, `win`, `server` or `generic`.
- `slug` is optional and derived from `title` when omitted.
- Publishing is idempotent on `slug`. A republish updates the plan in place and returns `200`. A new
  plan returns `201`. Steps ticked off in the shell stay ticked, `predone` steps are marked complete,
  and steps past the new length are removed.
- The response is `{ plan, created, url }`, where `url` is the shell's `/plans/<slug>` page, built from the links registry (`links.json`).
- Errors: `400` for invalid input, `401` for a missing or wrong token, `500` for a Supabase failure.

The route is inert until all four required variables are set in `~/.argus/agent-engine/.env`. That runtime directory is already outside the deploy copy, so [argus-config#1267](https://github.com/deanjstone/argus-config/issues/1267) leaves it where it is.
Until then every request gets `503` "plans endpoint not configured".

| Variable | Required | Source |
|---|---|---|
| `SUPABASE_URL` | yes | Bitwarden `myargus-supabase-url` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Bitwarden `myargus-supabase-service-role-key` |
| `ARGUS_PLANS_TOKEN` | yes | Bitwarden `agent-engine-plans-token` |
| `ARGUS_PLANS_OWNER_USER_ID` | yes | The owner's `auth.users` id in the myargus project; becomes `plans.user_id` |
| `ARGUS_PLANS_BASE_URL` | no. Replaces only the origin of the plan URL (for a local or preview shell); a path on it is ignored and a value that is not an http(s) URL leaves the route unconfigured | — |

The `plans` schema must also be in the project's exposed schemas (`db_schema`), or the Data API
rejects every call. See `docs/supabase-config.md` in myargus.

Callers send the same token as a bearer token. Browser access with a Supabase session token
applies to `/task/run-plan` and the live-notes routes only; see [Browser access](#browser-access).

## Live notes

The refresh side of myargus map [#121](https://github.com/deanjstone/myargus/issues/121)
(built in [myargus#337](https://github.com/deanjstone/myargus/issues/337)). A note row in
`public.knowledge_live_notes` carries an `objective` and its own schedule; the engine re-runs the
objective against the knowledge graph and rewrites the note's `body`. The design is settled in
myargus#122 and #123.

| Route | Does |
|---|---|
| `POST /task/live-notes/tick` | Refreshes the active notes that are due: `is_active` and `last_run_at` older than `interval_minutes`, or never run. Never-run first, then longest overdue, at most 10 per tick, one after another. Replies `{ due, results }` |
| `POST /task/live-notes/:id/run` | Refreshes one note by id, due or not (the UI's Run now). Replies `{ noteId, outcome }`; `404` for an unknown id, `409` while that note is already running |

Both sit behind the [browser gate](#browser-access) and answer `503` until `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set. The rows are written with the service role, so every graph
query filters on the note's own `user_id`.

- **Dispatch.** `live_note_refresh` is a `TaskType`. `engine.runDirect` sends the prompt to the
  model `routeTask` picks, with no Haiku planner, and runs Claude text-only (`--tools=` and
  `--strict-mcp-config`): the prompt carries graph text the owner did not write.
- **Graph.** The chats closest in meaning to the objective (similarity above 0.5, the knowledge
  app's default), then the chats that mention its keywords (title weighs twice a summary), best
  25 together, plus one hop of linked chats and the edges between them
  ([myargus#340](https://github.com/deanjstone/myargus/issues/340)). The objective is embedded
  with transformers.js and `Xenova/nomic-embed-text-v1` at `q8`, exactly as the knowledge app
  embeds chats in the browser, so the vectors compare (Ollama's `nomic-embed-text` is v1.5, a
  different model). The model, about 140 MB, downloads to `~/.argus/models/` on the first refresh.
  The search is myargus's `match_knowledge_chats_for_user` RPC, which takes the owner explicitly
  because the service role has no `auth.uid()`. Semantic search is best effort: if the model or
  the RPC fails (the migration not applied yet, say), the read logs a warning and matches by
  keyword alone.
- **Prompt.** Objective, current body and graph go in; the full replacement body comes out. The
  body and the graph are fenced as untrusted data. An empty reply is a failure. A reply wrapped
  in one markdown fence is unwrapped.
- **Success** writes `body` and `last_run_at`, sets `consecutive_failures` to 0 and clears
  `last_error`. **Failure** (a graph read error, a model error, an empty reply) increments
  `consecutive_failures`, sets `last_error` and `last_error_at`, and still stamps `last_run_at`,
  so the note retries on its normal cadence. The third consecutive failure sets `is_active` to
  false and `pause_reason` to `auto-failure`. Only an active note is auto-paused: a run on demand
  against a note the owner paused keeps that pause.
- **Overlap.** A note that is already running is skipped, by the tick and by Run now alike.

`systemd/live-notes-tick.{service,timer}` is the one shared timer: every 10 minutes it POSTs the
tick on loopback. It is not installed by `deploy.sh`.

```bash
# On the host that runs agent-engine, once the migration is applied and the .env has Supabase:
cp systemd/live-notes-tick.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now live-notes-tick.timer
```

## Deployment identity

The engine reports which deployment it is (WSL2's is **Aquila**, argus#706). It reads the
identity once at startup, so restart it after editing the file.

- The file is `envs/<env>/identity.json` in argus-config, the only override surface
  (`{ schema_version, name, persona, environment }`). The engine finds it beside the composed
  `CLAUDE.md` that `~/.claude/CLAUDE.md` links to, so each machine reads its own env's file.
  `ARGUS_IDENTITY_PATH` names a file explicitly. An env with no `identity.json` (homelab,
  Windows) has no identity.
- Deployments are addressed by `name`. `environment` is a filter, never an address.

| Route | Response |
|---|---|
| `GET /identity` | `{ name, environment, schema_version }`; `404` with no identity; `500` with the reason when the file is invalid |
| `GET /deployments?environment=<env>` | `{ deployments: [...] }`, this engine only, filtered by `environment` |
| `GET /deployments/:name` | The deployment named `name`, or `404` |
| `GET /health` | Also carries `deployment`: the name, or `null` |

There is no name→endpoint registry. Each engine reports only itself over its existing HTTP
port. A registry, if one is needed later, keys on `name` and serves the same shape.

## Layout

- `src/core/` — planner, registry, routing, feedback loop
- `src/models/` — provider adapters (Claude, Haiku)
- `src/search/` — vector search over the context bundle
- `src/server/` — HTTP server
- `src/core/LiveNotes.ts`, `LiveNoteStore.ts` — live-note refresh executor, and its Supabase store and graph reader
- `systemd/` — `agent-engine` unit template and its installer, and the live-notes tick timer
- `test/` — vitest suite
