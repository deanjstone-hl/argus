import { createCheckTarget, type CheckTarget } from './post-check.js'

// The ops hub's store (argus#1200): the same payload to `POST /watchtower/checks`
// on the hub, with the collector's own device token.
export function createHubTarget(options: { url: string; token: string }): CheckTarget {
  return createCheckTarget('hub', { label: 'hub-client', url: options.url, token: options.token })
}
