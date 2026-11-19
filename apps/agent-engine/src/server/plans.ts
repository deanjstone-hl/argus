import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { parsePlanInput, type PlanStore } from '../core/PlanStore.js';
import { routeUrl } from '../lib/links.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlansConfig {
  supabaseUrl: string;
  supabaseKey: string;
  token: string;
  ownerUserId: string;
  /** Replaces the registry's origin for the plan URLs (local or preview runs); never a path. */
  origin?: string | undefined;
}

export interface PlansDeps {
  store: PlanStore;
  token: string;
  origin?: string | undefined;
}

// The plan URLs come from the links registry; the environment may replace only the origin
// (decision 5 of the links map). A path on the value is dropped, and a value that is not an
// http(s) URL is refused, so a typo never sends a link to the production host.
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// All four are required. Without the token the route would be an unauthenticated
// write into Supabase reachable by anything on the tailnet, so a missing token
// is "not configured", the same as a missing Supabase URL or key. The owner id
// fills plans.user_id, which is NOT NULL and references auth.users.
export function plansConfigFromEnv(env: Record<string, string | undefined>): PlansConfig | null {
  const supabaseUrl = nonBlank(env['SUPABASE_URL']);
  const supabaseKey = nonBlank(env['SUPABASE_SERVICE_ROLE_KEY']);
  const token = nonBlank(env['ARGUS_PLANS_TOKEN']);
  const ownerUserId = nonBlank(env['ARGUS_PLANS_OWNER_USER_ID']);
  if (!supabaseUrl || !supabaseKey || !token || !ownerUserId || !UUID_PATTERN.test(ownerUserId)) return null;
  const override = nonBlank(env['ARGUS_PLANS_BASE_URL']);
  const origin = override === null ? undefined : originOf(override);
  if (origin === null) return null;
  return { supabaseUrl, supabaseKey, token, ownerUserId, origin };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isAuthorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1].trim()), digest(token));
}

// `resolveDeps` runs per request, so the route stays inert (503) until the
// config is present and needs no restart-order coordination with its callers.
export function createPlansRoutes(resolveDeps: () => PlansDeps | null): Hono {
  const routes = new Hono();

  routes.post('/plans', async (c) => {
    const deps = resolveDeps();
    if (!deps) {
      return c.json(
        { error: 'plans endpoint not configured: set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ARGUS_PLANS_TOKEN and ARGUS_PLANS_OWNER_USER_ID (a UUID)' },
        503
      );
    }

    if (!isAuthorized(c.req.header('authorization'), deps.token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400);
    }

    const parsed = parsePlanInput(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    try {
      const { plan, created } = await deps.store.publish(parsed.value);
      const options = deps.origin === undefined ? undefined : { origin: deps.origin };
      const url = routeUrl('shell', '/plans/:slug', { slug: plan.slug }, options);
      return c.json({ plan, created, url }, created ? 201 : 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}
