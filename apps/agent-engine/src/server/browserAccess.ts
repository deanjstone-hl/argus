import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TokenVerifier = (token: string) => Promise<{ sub?: string }>;

export interface BrowserAccessConfig {
  allowedOrigins: string[];
  // null until both the Supabase project and the owner id are configured.
  owner: { userId: string; verify: TokenVerifier } | null;
}

// Supabase signs session tokens with an asymmetric key and publishes the
// public half, so verifying needs only the project URL, never a secret.
// jose caches the fetched key set per verifier, so one verifier is kept per URL.
const verifiers = new Map<string, TokenVerifier>();

function supabaseVerifier(supabaseUrl: string): TokenVerifier {
  const base = supabaseUrl.replace(/\/+$/, '');
  const cached = verifiers.get(base);
  if (cached) return cached;

  const keys = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
  const verify: TokenVerifier = async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `${base}/auth/v1`,
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256'],
    });
    return payload;
  };
  verifiers.set(base, verify);
  return verify;
}

// `*` is dropped on purpose: the allow-list is explicit origins only.
export function browserAccessConfigFromEnv(env: Record<string, string | undefined>): BrowserAccessConfig {
  const allowedOrigins = (env['ARGUS_CORS_ORIGINS'] ?? '')
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(origin => origin !== '' && origin !== '*');

  const supabaseUrl = env['SUPABASE_URL']?.trim();
  const ownerUserId = env['ARGUS_PLANS_OWNER_USER_ID']?.trim();
  const owner = supabaseUrl && ownerUserId && UUID_PATTERN.test(ownerUserId)
    ? { userId: ownerUserId, verify: supabaseVerifier(supabaseUrl) }
    : null;

  return { allowedOrigins, owner };
}

// A request with an `Origin` header came from a browser. Local and
// non-browser callers (agent-cli, scripts, curl) send none, and pass through
// every handler here untouched.
export function createBrowserAccess(resolveConfig: () => BrowserAccessConfig): {
  cors: MiddlewareHandler;
  requireOwner: MiddlewareHandler;
} {
  const corsHandler = cors({
    origin: (origin) => (resolveConfig().allowedOrigins.includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });

  const corsWithRefusal: MiddlewareHandler = async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !resolveConfig().allowedOrigins.includes(origin)) {
      return c.json({ error: 'origin not allowed' }, 403);
    }
    return corsHandler(c, next);
  };

  const requireOwner: MiddlewareHandler = async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.header('origin') === undefined) {
      return next();
    }

    const { owner } = resolveConfig();
    if (!owner) {
      return c.json(
        { error: 'browser access not configured: set SUPABASE_URL and ARGUS_PLANS_OWNER_USER_ID (a UUID)' },
        503
      );
    }

    const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    if (!match?.[1]) {
      return c.json({ error: 'unauthorized: a Supabase session token is required' }, 401);
    }

    let sub: string | undefined;
    try {
      ({ sub } = await owner.verify(match[1].trim()));
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid token';
      return c.json({ error: `unauthorized: ${reason}` }, 401);
    }

    if (sub !== owner.userId) {
      return c.json({ error: 'forbidden: token is not the owner' }, 403);
    }
    return next();
  };

  return { cors: corsWithRefusal, requireOwner };
}
