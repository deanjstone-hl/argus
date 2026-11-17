// Reconcile ecosystem/manifest.json's skill entries with the installed skills (argus#928).
//   node scripts/ecosystem/sync-skills.ts [--check] [--skills <dir>]...
// Reads ~/repos/argus-config/envs/wsl2/skills and ~/repos/sys-admin/skills unless --skills is
// given. Without --check it rewrites the manifest; with it, it only reports and exits 1 on drift.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseManifest } from './manifest.ts'
import { formatManifest, readSkills, reconcileSkills } from './skills.ts'

const args = process.argv.slice(2)
const check = args.includes('--check')
const given = args.flatMap((arg, index) => (arg === '--skills' && args[index + 1] ? [args[index + 1] as string] : []))
const roots = given.length > 0 ? given : [join(homedir(), 'repos/argus-config/envs/wsl2/skills'), join(homedir(), 'repos/sys-admin/skills')]
const manifestPath = new URL('../../ecosystem/manifest.json', import.meta.url)

const parsed = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
if (!parsed.ok) {
  for (const error of parsed.errors) console.error(`ecosystem manifest: ${error}`)
  process.exit(1)
}

const { manifest, added, removed } = reconcileSkills(parsed.manifest, readSkills(roots))
for (const name of added) console.log(`+ ${name}`)
for (const name of removed) console.log(`- ${name}`)

if (added.length === 0 && removed.length === 0) {
  console.log('ecosystem skills: in step with the installed skills')
} else if (check) {
  console.error(`ecosystem skills: ${added.length} missing, ${removed.length} stale; run without --check to rewrite the manifest`)
  process.exit(1)
} else {
  writeFileSync(manifestPath, formatManifest(manifest))
  console.log(`ecosystem skills: manifest rewritten (${added.length} added, ${removed.length} removed)`)
}
