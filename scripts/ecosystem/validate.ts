// Validate ecosystem/manifest.json against the contract the hub enforces on fetch, and its app
// hrefs against links.json, so a bad manifest fails the PR and the release workflow, not the
// hub's hourly sync.
//   node scripts/ecosystem/validate.ts [path]
import { readFileSync } from 'node:fs'

import { checkManifestLinks, type LinksRegistry } from './links.ts'
import { parseManifest } from './manifest.ts'

const path = process.argv[2] ?? new URL('../../ecosystem/manifest.json', import.meta.url)
const result = parseManifest(JSON.parse(readFileSync(path, 'utf8')))
if (!result.ok) {
  for (const error of result.errors) console.error(`ecosystem manifest: ${error}`)
  process.exit(1)
}

// The app hrefs against the links registry vendored at the repo root (argus#18).
const registry = JSON.parse(readFileSync(new URL('../../links.json', import.meta.url), 'utf8')) as LinksRegistry
const linkErrors = checkManifestLinks(result.manifest, registry)
if (linkErrors.length > 0) {
  for (const error of linkErrors) console.error(`ecosystem manifest: ${error}`)
  process.exit(1)
}
console.log(`ecosystem manifest: ${result.manifest.entries.length} entries valid`)
