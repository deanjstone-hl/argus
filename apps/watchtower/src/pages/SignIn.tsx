import { Login } from '@/components/login'
import { supabase } from '../lib/supabase'

async function signInWithPasskey() {
  const { error } = await supabase.auth.signInWithPasskey()
  if (error) throw new Error(error.message)
}

async function sendEmailLink(email: string) {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  if (error) throw new Error(error.message)
}

export default function SignIn() {
  return (
    <Login
      appName="Watchtower"
      description="Infra monitoring"
      onPasskeySignIn={signInWithPasskey}
      onEmailLink={sendEmailLink}
      footer="Uses device passkey (Face ID, Touch ID, Windows Hello)"
    />
  )
}
