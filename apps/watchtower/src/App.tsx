import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import SignIn from './pages/SignIn'
import Dashboard from './pages/Dashboard'
import PasskeyGate from './components/PasskeyGate'
import { useThemePreference } from '@/hooks/use-theme-preference'
import { themeCookieDomain } from '@/lib/theme-domain'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [passkeyCount, setPasskeyCount] = useState<number | null>(null)
  const { preference, setMode } = useThemePreference({ cookieDomain: themeCookieDomain(window.location.hostname) })

  useEffect(() => {
    void supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (!session) setPasskeyCount(null)
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    void supabase.auth.passkey.list().then(({ data }) => {
      setPasskeyCount(data?.length ?? 0)
    })
  }, [session])

  async function refreshPasskeyCount() {
    const { data } = await supabase.auth.passkey.list()
    setPasskeyCount(data?.length ?? 0)
  }

  if (loading || (session && passkeyCount === null)) return null
  if (!session) return <SignIn />
  if (passkeyCount === 0) return <PasskeyGate onEnrolled={refreshPasskeyCount} />

  return <Dashboard mode={preference.mode} onModeChange={setMode} />
}

export default App
