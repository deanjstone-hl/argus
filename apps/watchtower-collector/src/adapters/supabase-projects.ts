import type { Adapter, HealthResult } from '../adapter.js'

interface SupabaseProject {
  id: string
  name: string
  status: string
  region: string
}

const DEGRADED_STATES = new Set(['COMING_UP', 'RESTORING', 'PAUSING', 'RESTARTING', 'UPGRADING'])

async function checkSupabaseProject(token: string, ref: string): Promise<HealthResult> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`project ${ref} returned ${response.status}`)
  }
  const project = (await response.json()) as SupabaseProject

  const status =
    project.status === 'ACTIVE_HEALTHY'
      ? 'healthy'
      : DEGRADED_STATES.has(project.status)
        ? 'degraded'
        : 'down'

  return { status, detail: { name: project.name, projectStatus: project.status, region: project.region } }
}

export function createSupabaseProjectAdapter(
  token: string,
  ref: string,
  intervalMs = 300_000,
): Adapter {
  return {
    key: `supabase:${ref}`,
    host: 'supabase',
    intervalMs,
    failureStatus: 'unreachable',
    check: () => checkSupabaseProject(token, ref),
  }
}
