import type { HealthStatus, ServiceCheck } from '@argus/watchtower-contract'
import { ChevronRightIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatCard } from '../lib/cards/registry'
import type { DetailRow } from '../lib/cards/types'
import { formatAbsoluteTime, formatRelativeTime } from '../lib/cards/units'
import StatusPill from './StatusPill'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

// The reason line takes its status's colour role (see StatusPill).
const REASON_TONE: Record<HealthStatus, string> = {
  healthy: 'text-muted-foreground',
  degraded: 'text-chart-3',
  unreachable: 'text-muted-foreground',
  down: 'text-destructive',
}

function Chevron({ hidden }: { hidden?: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        'size-3 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90',
        hidden && 'invisible',
      )}
    />
  )
}

function Row({ row, indent }: { row: DetailRow; indent?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-2xs', indent && 'pl-2')}>
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {row.swatch !== undefined && (
          <span
            className="h-2 w-2 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: row.swatch ?? 'transparent' }}
          />
        )}
        <span className="truncate" title={indent ? row.label : undefined}>
          {row.label}
        </span>
      </span>
      <span
        title={row.title}
        className={cn('shrink-0 text-right', row.tone === 'warn' ? 'text-chart-3' : 'text-foreground')}
      >
        {row.value}
      </span>
    </div>
  )
}

export default function ServiceCard({ check }: { check: ServiceCheck }) {
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(false)

  // Re-render every 30s so ages and staleness stay current without a fresh row.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const view = formatCard(check, now)
  const hasDetail = view.rows.length > 0 || view.sections.length > 0 || view.raw !== null

  return (
    <Card className="gap-0 py-0">
      <Collapsible open={hasDetail && expanded} onOpenChange={setExpanded} disabled={!hasDetail}>
        <CollapsibleTrigger className="group flex w-full flex-col gap-1.5 p-4 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default">
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Chevron hidden={!hasDetail} />
              <span className="truncate text-sm font-medium" title={check.service_key}>
                {view.title}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-2xs text-muted-foreground" title={formatAbsoluteTime(check.checked_at)}>
                {formatRelativeTime(check.checked_at, now)}
              </span>
              {view.stale && (
                <Badge
                  variant="outline"
                  className="h-6 px-2 text-muted-foreground"
                  title={`No check since ${view.stale.at}: the collector reports at least every 5 min`}
                >
                  Stale
                </Badge>
              )}
              <StatusPill status={check.status} />
            </div>
          </div>
          {view.reason ? (
            <p className={cn('pl-4 text-2xs font-medium', REASON_TONE[check.status])}>{view.reason}</p>
          ) : (
            view.summary && <p className="pl-4 text-2xs text-muted-foreground">{view.summary}</p>
          )}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <Separator />
          <div className="space-y-2 px-4 py-3">
            {view.rows.map((row) => (
              <Row key={row.label} row={row} />
            ))}
            {view.sections.map((section) => (
              <div key={section.title} className="space-y-1 pt-1">
                <span className="text-2xs text-muted-foreground">{section.title}</span>
                {section.rows.length === 0 && <div className="pl-2 text-2xs text-muted-foreground">{section.empty}</div>}
                {section.rows.map((row, index) => (
                  <Row key={`${row.label}-${index}`} row={row} indent />
                ))}
              </div>
            ))}
            {view.raw !== null && (
              <Collapsible className="pt-1">
                <CollapsibleTrigger className="group flex items-center gap-2 text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
                  <Chevron />
                  Raw detail <span className="font-mono">{check.service_key}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug text-muted-foreground">
                    {view.raw}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
