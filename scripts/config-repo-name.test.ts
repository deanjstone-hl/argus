import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The config repo is being renamed argus-config -> config (argus-config#1401): until the rename lands
// a deploy script reads its helpers from ~/repos/config when that copy exists, else ~/repos/argus-config.
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('apps/watchtower-collector/deploy.sh', () => {
  const script = read('apps/watchtower-collector/deploy.sh')

  it('lists the backlog repos with the config copy of backlog-labels.py first, then the argus-config one', () => {
    const renamed = script.indexOf('"${HOME}/repos/config/hooks/backlog-labels.py"')
    const old = script.indexOf('"${HOME}/repos/argus-config/hooks/backlog-labels.py"')
    expect(renamed).toBeGreaterThan(0)
    expect(old).toBeGreaterThan(renamed)
  })
})
