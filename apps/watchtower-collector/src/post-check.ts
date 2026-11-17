import type { CheckInput } from '@argus/watchtower-contract'

export interface RecordOptions {
  retryDelayMs?: number
}

/** One store the collector writes each check to. `name` is the flag's target: `d1` or `hub`. */
export interface CheckTarget {
  name: 'd1' | 'hub'
  record(input: CheckInput, options?: RecordOptions): Promise<void>
}

const DEFAULT_RETRY_DELAY_MS = 1_000

// The target answered and refused the request itself (4xx).
class RejectedError extends Error {}

interface TargetRequest {
  /** Prefixes the error message: `worker-client` or `hub-client`. */
  label: string
  /** The service's origin, without the path. */
  url: string
  token?: string | undefined
}

async function post(request: TargetRequest, input: CheckInput): Promise<void> {
  const response = await fetch(`${request.url.replace(/\/+$/, '')}/watchtower/checks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
    },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    const message = `${request.label}: POST /watchtower/checks failed with ${response.status}: ${await response.text()}`
    throw response.status < 500 ? new RejectedError(message) : new Error(message)
  }
}

// id/checked_at are NOT sent: each target sets both itself, so the two stores
// never trust a collector clock.
//
// A network failure or a 5xx is retried once after a short pause: the bursts
// seen in production were blips of a few seconds. A 4xx is not, since the same
// request would meet the same answer. A retry after a lost response can write
// the same check twice, which is harmless: only the newest row per key is read.
export function createCheckTarget(name: CheckTarget['name'], request: TargetRequest): CheckTarget {
  return {
    name,
    async record(input, options = {}) {
      try {
        await post(request, input)
      } catch (error) {
        if (error instanceof RejectedError) throw error
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS))
        await post(request, input)
      }
    },
  }
}
