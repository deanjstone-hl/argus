import type { Adapter, HealthResult } from '../adapter.js'

interface PagesProject {
  name: string
  latest_deployment?: {
    id: string
    created_on: string
    latest_stage: { name: string; status: string }
    environment: string
  }
}

// default_environment is the whole environment object, script metadata
// included; only its name is kept.
interface WorkersService {
  id: string
  default_environment: { environment: string }
  created_on: string
  modified_on: string
}

type CloudflareProjectKind = 'pages' | 'worker'

interface CloudflareProject {
  name: string
  kind: CloudflareProjectKind
}

async function fetchCloudflare<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`)
  }
  const body = (await response.json()) as { success: boolean; result: T; errors: unknown[] }
  if (!body.success) {
    throw new Error(`${url} reported failure: ${JSON.stringify(body.errors)}`)
  }
  return body.result
}

async function checkPagesProject(
  accountId: string,
  token: string,
  name: string,
): Promise<HealthResult> {
  const project = await fetchCloudflare<PagesProject>(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${name}`,
    token,
  )
  const stageStatus = project.latest_deployment?.latest_stage.status
  const status = stageStatus === 'success' ? 'healthy' : stageStatus ? 'down' : 'degraded'

  return {
    status,
    detail: {
      deploymentId: project.latest_deployment?.id,
      stageStatus,
      environment: project.latest_deployment?.environment,
      deployedOn: project.latest_deployment?.created_on,
    },
  }
}

async function checkWorkerService(
  accountId: string,
  token: string,
  name: string,
): Promise<HealthResult> {
  const service = await fetchCloudflare<WorkersService>(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/services/${name}`,
    token,
  )
  return {
    status: 'healthy',
    detail: {
      defaultEnvironment: service.default_environment.environment,
      modifiedOn: service.modified_on,
    },
  }
}

export function createCloudflareAdapter(
  accountId: string,
  token: string,
  project: CloudflareProject,
  intervalMs = 300_000,
): Adapter {
  return {
    key: `cloudflare:${project.name}`,
    host: 'cloudflare',
    intervalMs,
    failureStatus: 'unreachable',
    check: () =>
      project.kind === 'pages'
        ? checkPagesProject(accountId, token, project.name)
        : checkWorkerService(accountId, token, project.name),
  }
}
