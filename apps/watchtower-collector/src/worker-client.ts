import { createCheckTarget, type CheckTarget } from './post-check.js'

// The D1 store: `POST /watchtower/checks` on the argus-watchtower-api Worker,
// bearer WATCHTOWER_COLLECTOR_TOKEN (the Worker refuses every request while
// its own secret is unset, argus#574).
export function createWorkerTarget(options: { url: string; token?: string | undefined }): CheckTarget {
  return createCheckTarget('d1', { label: 'worker-client', url: options.url, token: options.token })
}
