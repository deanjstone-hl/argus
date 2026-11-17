// Plain JS with a hand-written .d.ts, not TypeScript: the usage shim runs its
// own compiled output on Node, so it cannot load a source-only .ts dependency.
// The Workers bundle this file as it is.

const encoder = new TextEncoder()

// Both sides are hashed first so the byte compare runs over equal-length
// inputs and leaks neither content nor length. crypto.subtle is on Workers
// (without nodejs_compat) and on Node alike; the Workers-only
// subtle.timingSafeEqual is not used so the same code runs in both.
export async function timingSafeEqual(a, b) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])
  const leftBytes = new Uint8Array(left)
  const rightBytes = new Uint8Array(right)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index]
  }
  return difference === 0
}

// False when the secret is unset or empty: a service whose secret was never
// provisioned must refuse everything rather than match `Bearer undefined`.
export async function checkBearer(header, secret) {
  if (!secret) return false
  return timingSafeEqual(header ?? '', `Bearer ${secret}`)
}
