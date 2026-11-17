import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { parsePlanInput, type PlanStore } from '../core/PlanStore.js';

const DEFAULT_PLANS_BASE_URL = 'https://myargus.cc/plans';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlansConfig {
  supabaseUrl: string;
  supabaseKey: string;
  token: string;
  ownerUserId: string;
  baseUrl: string;
}

export interface PlansDeps {
  store: PlanStore;
  token: string;
  baseUrl: string;
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
  const baseUrl = (nonBlank(env['ARGUS_PLANS_BASE_URL']) ?? DEFAULT_PLANS_BASE_URL).replace(/\/+$/, '');
  return { supabaseUrl, supabaseKey, token, ownerUserId, baseUrl };
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
      return c.json({ plan, created, url: `${deps.baseUrl}/${plan.slug}` }, created ? 201 : 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}
