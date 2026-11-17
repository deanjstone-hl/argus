import { ActivityIcon } from 'lucide-react'
import { useServiceChecks } from '../hooks/useServiceChecks'
import ServiceCard from '../components/ServiceCard'
import { AppShell } from '@/components/app-shell'
import { EmptyPage } from '@/components/empty-page'
import { PageHeader } from '@/components/page-header'
import { APPS } from '@/lib/apps'
import type { ModePreference } from '@/lib/theme-preference'

const SECTIONS = [{ id: 'services', label: 'Services', href: '/', icon: <ActivityIcon /> }]

type Props = {
  mode: ModePreference
  onModeChange: (mode: ModePreference) => void
}

export default function Dashboard({ mode, onModeChange }: Props) {
  const { checks, loading, error } = useServiceChecks()

  const byHost = new Map<string, typeof checks>()
  for (const check of checks) {
    const group = byHost.get(check.host) ?? []
    group.push(check)
    byHost.set(check.host, group)
  }

  const empty = !loading && !error && checks.length === 0

  return (
    <AppShell
      appName="Watchtower"
      sections={SECTIONS}
      activeSectionId="services"
      apps={APPS}
      currentAppId="watchtower"
      mode={mode}
      onModeChange={onModeChange}
    >
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <PageHeader title="Watchtower" description="Infra health, live from the collector." hideOnPhone />

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {empty && (
          <EmptyPage
            icon={<ActivityIcon />}
            title="No service checks yet"
            description="Checks appear here once the collector reports in."
          />
        )}

        {Array.from(byHost.entries()).map(([host, hostChecks]) => (
          <section key={host} className="space-y-3">
            <h2 className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">{host}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {hostChecks.map((check) => (
                <ServiceCard key={check.service_key} check={check} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  )
}
