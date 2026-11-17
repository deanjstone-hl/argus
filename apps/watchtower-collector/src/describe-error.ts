// undici reports a network failure as `TypeError: fetch failed` and puts the
// reason (ECONNRESET, ENOTFOUND, a connect timeout) on `cause`, so the
// message alone cannot tell one failure from another.
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause: unknown = error.cause
  if (typeof cause !== 'object' || cause === null) return error.message
  const { code, message } = cause as { code?: unknown; message?: unknown }
  const named = typeof code === 'string' ? ` ${code}` : ''
  const detail = typeof message === 'string' ? `: ${message}` : ''
  return named || detail ? `${error.message} (cause${named}${detail})` : error.message
}
