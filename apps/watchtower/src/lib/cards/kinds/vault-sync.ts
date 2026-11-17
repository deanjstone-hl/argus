import { list, row, rows, text } from '../fields'
import type { CardFormatter } from '../types'

// `<host>:vault:<name>`: the session-start vault-sync check (argus-config's
// vault-staleness.sh) run on that host. The hook's lines are the reason,
// in its own words.
const KEY = /^[\w-]+:vault:(.+)$/

const tildePath = (path: string) => path.replace(/^\/home\/[^/]+/, '~')

export const vaultSyncFormatter: CardFormatter = {
  id: 'vault-sync',
  matches: (check) => KEY.test(check.service_key),
  format: (check, detail) => {
    const vault = text(detail, 'vault') ?? KEY.exec(check.service_key)?.[1] ?? check.service_key
    const path = text(detail, 'path')
    const lines = list<unknown>(detail, 'lines')
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.replace(/^Vault sync: /, ''))
    const notCheckout = detail.checkout === false
    return {
      title: `${vault} sync`,
      summary: notCheckout ? 'not a git checkout' : lines.length === 0 ? 'published and fetching' : 'publishing has stopped',
      reason: notCheckout ? `${path === null ? vault : tildePath(path)} is not a git checkout` : lines.join(' ') || null,
      rows: rows(row('Path', path === null ? null : tildePath(path))),
    }
  },
}
