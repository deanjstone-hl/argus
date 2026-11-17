import type { HealthStatus } from '@argus/watchtower-contract'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Status roles by severity, drawn from the registry theme's tokens:
// healthy=chart-2, degraded=chart-3, down=destructive. unreachable sits below
// down deliberately — a sleeping laptop isn't the same severity as a confirmed
// failure, even though both mean "no data right now" — so it takes the muted
// neutral rather than an alarm colour.
const STATUS_STYLES: Record<HealthStatus, { label: string; badge: string; dot: string }> = {
  healthy: { label: 'Healthy', badge: 'bg-chart-2/15 text-chart-2', dot: 'bg-chart-2' },
  degraded: { label: 'Degraded', badge: 'bg-chart-3/15 text-chart-3', dot: 'bg-chart-3' },
  unreachable: { label: 'Unreachable', badge: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
  down: { label: 'Down', badge: 'bg-destructive/15 text-destructive', dot: 'bg-destructive' },
}

export default function StatusPill({ status }: { status: HealthStatus }) {
  const style = STATUS_STYLES[status]
  return (
    <Badge variant="secondary" className={cn('h-6 gap-1.5 px-2.5', style.badge)}>
      <span className={cn('size-1.5 rounded-full', style.dot)} />
      {style.label}
    </Badge>
  )
}
