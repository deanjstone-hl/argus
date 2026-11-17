import { useEffect, useState } from 'react'
import type { ServiceCheck } from '@argus/watchtower-contract'
import { supabase } from '../lib/supabase'

const POLL_INTERVAL_MS = 18_000

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL

if (!apiBaseUrl) {
  throw new Error('Missing VITE_API_BASE_URL env var')
}

// `error` is set whenever the checks could not be loaded (no session, or the
// API refused the request), so the dashboard never reports a failed load as an
// empty store. Cleared on the next successful poll.
export function useServiceChecks(): { checks: ServiceCheck[]; loading: boolean; error: string | null } {
  const [checks, setChecks] = useState<ServiceCheck[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadChecks() {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        if (!cancelled) {
          setError('No active session. Sign in again to load service checks.')
          setLoading(false)
        }
        return
      }

      try {
        const response = await fetch(`${apiBaseUrl}/checks`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          console.error('[useServiceChecks] load failed:', response.status)
          if (!cancelled) setError(`Could not load service checks (HTTP ${response.status}).`)
          return
        }
        // The Worker already reduces to latest-per-service_key and orders
        // by service_key ascending — no client-side reduction needed
        // (previously done here via a latestPerKey() Map, when the source
        // was a raw Supabase select).
        const data = (await response.json()) as ServiceCheck[]
        if (!cancelled) {
          setChecks(data)
          setError(null)
        }
      } catch (caught) {
        console.error('[useServiceChecks] load failed:', caught instanceof Error ? caught.message : caught)
        if (!cancelled) setError('Could not reach the service checks API.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadChecks()
    const timer = setInterval(() => void loadChecks(), POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return { checks, loading, error }
}
