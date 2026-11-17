// Human units for card detail. Every function takes plain values so the
// formatters stay testable without a DOM or a clock.

export function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const compactCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 })

export function formatCompactCount(value: number): string {
  return compactCount.format(value)
}

const wholeDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const dollarsAndCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

// Whole dollars once cents stop mattering; ccusage reports cost in USD.
export function formatCurrency(value: number): string {
  return (value >= 100 ? wholeDollars : dollarsAndCents).format(value)
}

export function formatRelativeTime(isoTimestamp: string, now: number): string {
  const seconds = Math.round((now - new Date(isoTimestamp).getTime()) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

// Shown on hover beside every relative time. The zone defaults to the
// viewer's own; tests pin it.
export function formatAbsoluteTime(isoTimestamp: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone })
    .format(new Date(isoTimestamp))
}

export function formatClockSkew(seconds: number): string {
  if (Math.abs(seconds) < 60) return 'in sync'
  return `${formatDuration(Math.abs(seconds))} ${seconds > 0 ? 'ahead' : 'behind'}`
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

// Binary multiples, labelled GB the way Windows labels them, so C: reads the
// same here as in Explorer. One decimal below 10, whole numbers above.
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value < 10 && unit > 0 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${BYTE_UNITS[unit]}`
}

// The future counterpart of formatRelativeTime: `in 21h`, or `due` once past.
export function formatUntil(isoTimestamp: string, now: number): string {
  const seconds = Math.round((new Date(isoTimestamp).getTime() - now) / 1000)
  if (seconds <= 0) return 'due'
  return `in ${formatDuration(Math.max(seconds, 60))}`
}

// A wait measured in seconds: `12s` under a minute, else as formatDuration.
export function formatSeconds(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)}s` : formatDuration(seconds)
}

// An allowance in milliseconds, in its own unit when it is a whole one:
// `12h`, `7d`, `30m`.
export function formatAllowance(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  if (minutes < 60) return `${minutes}m`
  return formatDuration(minutes * 60)
}

const STORAGE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

// Decimal multiples, the units Cloudflare and Supabase quote plan limits in,
// so a size reads against its limit directly: `36.9 MB of 500 MB`. Three
// significant figures.
export function formatStorage(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < STORAGE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const rounded = value < 100 && unit > 0 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${STORAGE_UNITS[unit]}`
}
