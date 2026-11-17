// Real `TZ=UTC systemctl show --property=…` output, captured 2026-10-16 on
// homelab (budget-api-cron, notice-board, taskview-migrate, cloudflared) and
// WSL2 (memory-reconcile, agent-engine).

export const BUDGET_API_CRON_TIMER = `Unit=budget-api-cron.service
NextElapseUSecRealtime=Sat 2026-10-17 09:00:00 UTC
LastTriggerUSec=Fri 2026-10-16 09:00:11 UTC
Result=success
Id=budget-api-cron.timer
Description=Daily trigger for budget-api-cron.service (matches vercel.json's "0 9 * * *")
LoadState=loaded
ActiveState=active
SubState=waiting
ActiveEnterTimestamp=Fri 2026-10-09 00:13:02 UTC
`

export const BUDGET_API_CRON_SERVICE = `Result=success
NRestarts=0
ExecMainStartTimestamp=Fri 2026-10-16 09:00:11 UTC
ExecMainExitTimestamp=Fri 2026-10-16 09:00:49 UTC
ExecMainStatus=0
Id=budget-api-cron.service
Description=Budget API cron trigger (notifications)
LoadState=loaded
ActiveState=inactive
SubState=dead
ActiveEnterTimestamp=
`

export const NOTICE_BOARD_SERVICE = `Result=success
NRestarts=2
ExecMainStartTimestamp=Sat 2026-10-10 23:58:26 UTC
ExecMainExitTimestamp=
ExecMainStatus=0
Id=notice-board.service
Description=Argus notice board (repo-addressed agent messages; tailnet-only via tailscale serve)
LoadState=loaded
ActiveState=active
SubState=running
ActiveEnterTimestamp=Sat 2026-10-10 23:58:26 UTC
`

export const TASKVIEW_MIGRATE_SERVICE = `Result=exit-code
NRestarts=0
ExecMainStartTimestamp=Fri 2026-10-09 00:13:06 UTC
ExecMainExitTimestamp=Fri 2026-10-09 00:13:11 UTC
ExecMainStatus=2
Id=taskview-migrate.service
Description=TaskView database migration
LoadState=loaded
ActiveState=failed
SubState=failed
ActiveEnterTimestamp=
`

export const MISSING_SERVICE = `Result=success
NRestarts=0
ExecMainStartTimestamp=
ExecMainExitTimestamp=
ExecMainStatus=0
Id=missing.service
Description=missing.service
LoadState=not-found
ActiveState=inactive
SubState=dead
ActiveEnterTimestamp=
`

export const CLOUDFLARED_SERVICE = `Result=success
NRestarts=4
ExecMainStartTimestamp=Fri 2026-10-09 00:13:31 UTC
ExecMainExitTimestamp=
ExecMainStatus=0
Id=cloudflared.service
Description=Cloudflare Tunnel client
LoadState=loaded
ActiveState=active
SubState=running
ActiveEnterTimestamp=Fri 2026-10-09 00:13:32 UTC
`

export const MEMORY_RECONCILE_TIMER = `Unit=memory-reconcile.service
NextElapseUSecRealtime=Fri 2026-10-16 11:27:00 UTC
LastTriggerUSec=Fri 2026-10-16 11:07:06 UTC
Result=success
Id=memory-reconcile.timer
Description=Memory reconciler timer — carries non-stdio memory writes to disk
LoadState=loaded
ActiveState=active
SubState=waiting
ActiveEnterTimestamp=Fri 2026-10-16 07:27:12 UTC
`

export const MEMORY_RECONCILE_SERVICE = `Result=success
NRestarts=0
ExecMainStartTimestamp=Fri 2026-10-16 11:17:27 UTC
ExecMainExitTimestamp=Fri 2026-10-16 11:17:59 UTC
ExecMainStatus=0
Id=memory-reconcile.service
Description=Memory store→files reconciler — mirrors non-stdio writes to CONTEXT
LoadState=loaded
ActiveState=inactive
SubState=dead
ActiveEnterTimestamp=
`

export const AGENT_ENGINE_SERVICE = `Result=success
NRestarts=0
ExecMainStartTimestamp=Fri 2026-10-16 07:27:13 UTC
ExecMainExitTimestamp=
ExecMainStatus=0
Id=agent-engine.service
Description=Argus Agent Engine
LoadState=loaded
ActiveState=active
SubState=running
ActiveEnterTimestamp=Fri 2026-10-16 07:27:13 UTC
`

// Hand-varied from the real rows above, for states not live on 2026-10-16.
export function withProperties(output: string, overrides: Record<string, string>): string {
  const lines = output.trim().split('\n').map((line) => {
    const key = line.split('=')[0] ?? ''
    return key in overrides ? `${key}=${overrides[key]}` : line
  })
  return `${lines.join('\n')}\n`
}
