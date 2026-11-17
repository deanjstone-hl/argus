import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import type { SyncthingFolderDetail } from '@argus/watchtower-contract'
import type { Adapter, HealthResult } from '../adapter.js'

// Syncthing's GUI cert is self-signed and names only the device (e.g.
// `dell-server`), so reaching it by IP needs both the cert pinned as the sole
// CA and the device name supplied for the hostname check.
export interface SyncthingTls {
  caFile: string
  servername: string
}

interface FolderConfig {
  id: string
}

interface FolderStatus {
  errors: number
  pullErrors: number
  needTotalItems: number
  state: string
  error: string
}

type JsonFetcher = <T>(url: string) => Promise<T>

function plainFetcher(apiKey: string): JsonFetcher {
  return async <T>(url: string) => {
    const response = await fetch(url, { headers: { 'X-API-Key': apiKey } })
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`)
    }
    return response.json() as Promise<T>
  }
}

function pinnedFetcher(apiKey: string, tls: SyncthingTls): JsonFetcher {
  const ca = readFileSync(tls.caFile)
  return <T>(url: string) =>
    new Promise<T>((resolve, reject) => {
      const req = request(
        url,
        { headers: { 'X-API-Key': apiKey }, ca, servername: tls.servername, timeout: 10_000 },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`${url} returned ${res.statusCode}`))
              return
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T)
            } catch (error) {
              reject(error)
            }
          })
          res.on('error', reject)
        },
      )
      req.on('timeout', () => req.destroy(new Error(`${url} timed out`)))
      req.on('error', reject)
      req.end()
    })
}

async function checkSyncthing(baseUrl: string, fetchJson: JsonFetcher): Promise<HealthResult> {
  const folders = await fetchJson<FolderConfig[]>(`${baseUrl}/rest/config/folders`)

  const folderStatuses = await Promise.all(
    folders.map(async (folder) => {
      const status = await fetchJson<FolderStatus>(
        `${baseUrl}/rest/db/status?folder=${encodeURIComponent(folder.id)}`,
      )
      return { id: folder.id, ...status }
    }),
  )

  const totalErrors = folderStatuses.reduce((sum, f) => sum + f.errors + f.pullErrors, 0)
  const totalOutOfSync = folderStatuses.reduce((sum, f) => sum + f.needTotalItems, 0)
  const foldersWithError = folderStatuses.filter((f) => f.error !== '')

  const status =
    totalErrors > 0 || foldersWithError.length > 0
      ? 'degraded'
      : totalOutOfSync > 0
        ? 'degraded'
        : 'healthy'

  return {
    status,
    detail: {
      folders: folderStatuses.map((f): SyncthingFolderDetail => ({
        id: f.id,
        state: f.state,
        errors: f.errors + f.pullErrors,
        needTotalItems: f.needTotalItems,
      })),
      totalErrors,
      totalOutOfSync,
    },
  }
}

export function createSyncthingAdapter(
  baseUrl: string,
  apiKey: string,
  intervalMs = 60_000,
  tls?: SyncthingTls,
): Adapter {
  const fetchJson = tls ? pinnedFetcher(apiKey, tls) : plainFetcher(apiKey)
  return {
    key: 'syncthing',
    host: 'homelab',
    intervalMs,
    check: () => checkSyncthing(baseUrl, fetchJson),
  }
}
