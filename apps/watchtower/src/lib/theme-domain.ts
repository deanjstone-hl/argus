import { COOKIE_DOMAIN } from '@/lib/links'

// The theme cookie is shared across every myargus app on the device. Anywhere else
// (localhost, a Pages preview) the browser would drop a cookie scoped to a domain the
// page is not on, so the choice stays host-only and falls back to localStorage.
export function themeCookieDomain(hostname: string): string | undefined {
  const host = hostname.toLowerCase()
  const shared = COOKIE_DOMAIN.slice(1)
  return host === shared || host.endsWith(COOKIE_DOMAIN) ? COOKIE_DOMAIN : undefined
}
