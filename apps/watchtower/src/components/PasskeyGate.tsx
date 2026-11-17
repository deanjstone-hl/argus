import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface PasskeyGateProps {
  onEnrolled: () => void
}

export default function PasskeyGate({ onEnrolled }: PasskeyGateProps) {
  const [enrolling, setEnrolling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleEnroll() {
    setEnrolling(true)
    setError(null)
    const { error } = await supabase.auth.registerPasskey()
    if (error) {
      setError(error.message)
      setEnrolling(false)
    } else {
      setEnrolling(false)
      onEnrolled()
    }
  }

  return (
    <div className="min-h-app flex items-center justify-center px-edge pt-safe pb-safe">
      <div className="w-full max-w-sm space-y-8 py-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">watchtower</h1>
          <p className="mt-2 text-sm text-muted-foreground">One last step before you continue</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="font-semibold">Set up a passkey</CardTitle>
            <CardDescription>
              Passkeys let you sign in with Face ID, Touch ID, or Windows Hello — no password or email link needed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={handleEnroll} disabled={enrolling} className="h-11 w-full font-semibold">
              {enrolling ? 'Follow the prompt on your device…' : 'Set up passkey'}
            </Button>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
