const SHARED_DOMAIN = 'myargus.cc'

// The theme cookie is shared across every myargus.cc app on the device. Anywhere else
// (localhost, a Pages preview) the browser would drop a cookie scoped to a domain the
// page is not on, so the choice stays host-only and falls back to localStorage.
export function themeCookieDomain(hostname: string): string | undefined {
  const host = hostname.toLowerCase()
  return host === SHARED_DOMAIN || host.endsWith(`.${SHARED_DOMAIN}`) ? `.${SHARED_DOMAIN}` : undefined
}
