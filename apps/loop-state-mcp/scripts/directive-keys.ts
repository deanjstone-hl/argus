import { writeFileSync } from 'node:fs'

import { directiveKeyPlaces } from '../src/directives.js'

writeFileSync(new URL('../directive-keys.json', import.meta.url), `${JSON.stringify(directiveKeyPlaces(), null, 2)}\n`)
