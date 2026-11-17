/** Constant-time string equality; both inputs are hashed so length does not leak. */
export function timingSafeEqual(a: string, b: string): Promise<boolean>

/**
 * True only when `header` is exactly `Bearer <secret>`. Returns false when the
 * secret is unset or empty, so an unprovisioned secret fails closed.
 */
export function checkBearer(
  header: string | null | undefined,
  secret: string | null | undefined,
): Promise<boolean>
