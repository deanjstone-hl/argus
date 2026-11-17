// Validate ecosystem/manifest.json against the contract the hub enforces on fetch, so a bad
// manifest fails the PR and the release workflow, not the hub's hourly sync.
//   node scripts/ecosystem/validate.ts [path]
import { readFileSync } from 'node:fs'

import { parseManifest } from './manifest.ts'

const path = process.argv[2] ?? new URL('../../ecosystem/manifest.json', import.meta.url)
const result = parseManifest(JSON.parse(readFileSync(path, 'utf8')))
if (!result.ok) {
  for (const error of result.errors) console.error(`ecosystem manifest: ${error}`)
  process.exit(1)
}
console.log(`ecosystem manifest: ${result.manifest.entries.length} entries valid`)
