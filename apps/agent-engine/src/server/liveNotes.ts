import { Hono } from 'hono';
import type { LiveNoteRefreshExecutor } from '../core/LiveNotes.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LiveNotesConfig {
  supabaseUrl: string;
  supabaseKey: string;
}

export interface LiveNotesDeps {
  executor: LiveNoteRefreshExecutor;
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// The refresh writes note rows as the service role, so both values are needed.
export function liveNotesConfigFromEnv(env: Record<string, string | undefined>): LiveNotesConfig | null {
  const supabaseUrl = nonBlank(env['SUPABASE_URL']);
  const supabaseKey = nonBlank(env['SUPABASE_SERVICE_ROLE_KEY']);
  if (!supabaseUrl || !supabaseKey) return null;
  return { supabaseUrl, supabaseKey };
}

const NOT_CONFIGURED =
  'live notes not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY';

// `resolveDeps` runs per request, so the routes stay inert (503) until the
// config is present. Access is gated by the caller in http.ts, with the same
// browser gate as /task/run-plan: the homelab timer sends no Origin and passes
// through, a browser must be the owner.
export function createLiveNotesRoutes(resolveDeps: () => LiveNotesDeps | null): Hono {
  const routes = new Hono();

  routes.post('/task/live-notes/tick', async (c) => {
    const deps = resolveDeps();
    if (!deps) return c.json({ error: NOT_CONFIGURED }, 503);

    try {
      return c.json(await deps.executor.tick());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: message }, 500);
    }
  });

  routes.post('/task/live-notes/:id/run', async (c) => {
    const deps = resolveDeps();
    if (!deps) return c.json({ error: NOT_CONFIGURED }, 503);

    const id = c.req.param('id');
    if (!UUID_PATTERN.test(id)) return c.json({ error: 'id must be a UUID' }, 400);

    try {
      const result = await deps.executor.refresh(id);
      if (result.outcome === 'not_found') return c.json({ error: 'note not found' }, 404);
      if (result.outcome === 'skipped') return c.json({ error: 'note is already running', ...result }, 409);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}
