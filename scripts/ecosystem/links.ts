/**
 * The manifest's app hrefs against the links registry (`links.json`, vendored from
 * deanjstone-hl/frontend, ADR-0004; argus#18). An href inside the registry's domain must be the
 * canonical root of a registered app: https, no `www`, an app root ending in `/`. A retired
 * host fails, and so does a host that only redirects. Hrefs outside the domain are not the
 * registry's to judge.
 */
import type { Manifest } from './manifest.ts'

export interface LinksEntry {
  id: string
  bucket: string
  status: 'live' | 'planned' | 'redirect' | 'retired'
  host?: string
  path?: string
  redirect?: string
}

export interface LinksRegistry {
  domain: string
  entries: LinksEntry[]
}

const APP_BUCKETS = ['internal', 'external']

const mount = (path: string | undefined) => (path ?? '').replace(/\/+$/, '')

export function checkManifestLinks(manifest: Manifest, registry: LinksRegistry): string[] {
  const errors: string[] = []
  manifest.entries.forEach((entry, index) => {
    if (entry.href === undefined) return
    const at = `entries[${index}].href ${JSON.stringify(entry.href)}`
    const url = new URL(entry.href)
    const inDomain = url.hostname === registry.domain || url.hostname.endsWith(`.${registry.domain}`)
    if (!inDomain) return

    const found = registry.entries.find(
      (candidate) => APP_BUCKETS.includes(candidate.bucket) && candidate.host === url.hostname && mount(candidate.path) === mount(url.pathname),
    )
    if (!found) {
      errors.push(`${at} is not an app in links.json`)
    } else if (found.status === 'retired') {
      errors.push(`${at} names a retired host (${found.id} in links.json)`)
    } else if (found.status === 'redirect') {
      errors.push(`${at} names a host that only redirects (${found.id} in links.json): link to its target`)
    } else {
      const canonical = `https://${found.host}${mount(found.path)}/`
      if (entry.href !== canonical) errors.push(`${at} is not the canonical form of ${found.id}: write ${JSON.stringify(canonical)}`)
    }
  })
  return errors
}
