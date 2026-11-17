import type { CheckDetail, HealthStatus } from '@argus/watchtower-contract'

export interface HealthResult {
  status: HealthStatus
  detail?: CheckDetail
}

// An adapter reports a result it could work out, and throws for anything it
// could not; the poller turns every throw into the recorded result.
export interface Adapter {
  key: string
  host: string
  intervalMs: number
  // The status a throw is recorded with: `unreachable` for a remote source
  // that may simply not answer, otherwise `down`. A CheckError overrides it.
  failureStatus?: HealthStatus
  check(): Promise<HealthResult>
}

// Thrown by an adapter that knows which status a particular failure deserves,
// such as a source that answered with something unusable.
//
// It lives here rather than in @argus/watchtower-contract: that package ships
// source only, so the collector may import types from it but no runtime value.
export class CheckError extends Error {
  constructor(
    readonly status: HealthStatus,
    message: string,
  ) {
    super(message)
    this.name = 'CheckError'
  }
}
