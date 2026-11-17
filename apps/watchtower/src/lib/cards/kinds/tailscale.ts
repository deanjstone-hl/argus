import { afterPrefix, list, num, row, rows, text, timeRow } from '../fields'
import type { CardFormatter } from '../types'
import { formatAllowance, formatRelativeTime, formatUntil } from '../units'

// Last-seen for each tailnet device, as homelab sees it.
const PREFIX = 'tailscale:'

export const tailscaleFormatter: CardFormatter = {
  id: 'tailscale',
  matches: (check) => check.service_key.startsWith(PREFIX),
  format: (check, detail, now) => {
    const online = detail.online === true
    const self = detail.self === true
    const lastSeen = online ? null : text(detail, 'lastSeen')
    const companion = text(detail, 'companion')
    const allowance = num(detail, 'offlineAfterMs')
    const keyExpiry = text(detail, 'keyExpiry')
    const seen = lastSeen === null ? null : formatRelativeTime(lastSeen, now)

    let reason: string | null = null
    if (!online && detail.companionOnline === true && companion !== null && lastSeen !== null) {
      reason = `Offline ${seen?.replace(/ ago$/, '')} while ${companion} is online`
    } else if (!online) {
      reason = `${seen === null ? 'Never seen' : `Last seen ${seen}`}${allowance === null ? '' : `, longer than the ${formatAllowance(allowance)} allowed`}`
    }

    return {
      title: text(detail, 'name') ?? afterPrefix(check.service_key, PREFIX),
      summary: online ? (self ? 'online · this host' : 'online') : seen === null ? 'offline' : `offline · last seen ${seen}`,
      reason,
      rows: rows(
        row('State', online ? 'online' : 'offline'),
        timeRow('Last seen', lastSeen, now),
        row('OS', text(detail, 'os')),
        row('Address', list<unknown>(detail, 'ips').find((ip): ip is string => typeof ip === 'string') ?? null),
        keyExpiry === null ? null : row('Key expires', formatUntil(keyExpiry, now)),
        row('Allowed offline', allowance === null ? null : formatAllowance(allowance)),
        row('Alongside', companion),
      ),
    }
  },
}
