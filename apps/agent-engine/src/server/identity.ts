import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';

// The deployment identity (argus#706, schema from map #95 decision 1). It lives
// in argus-config as envs/<env>/identity.json and is the only override surface
// (#95 decision 4): the engine reads it, never writes or defaults it.
//
// Version 2 (argus-config 62e8d76) added keys for the profile and charter paths.
// The engine needs only name and environment, so both versions share one shape and
// the extra keys are ignored.
const IdentityFileSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]),
  name: z.string().trim().min(1),
  persona: z.string().trim().min(1),
  environment: z.enum(['wsl2', 'windows', 'homelab']),
});

export interface DeploymentIdentity {
  schemaVersion: 1 | 2;
  name: string;
  environment: 'wsl2' | 'windows' | 'homelab';
}

export interface IdentityState {
  identity: DeploymentIdentity | null;
  // The file read, or null when no identity file applies to this deployment.
  source: string | null;
  error: string | null;
}

export interface LoadIdentityOptions {
  env: Record<string, string | undefined>;
  homeDir?: string;
}

// ARGUS_IDENTITY_PATH names the file explicitly. Otherwise the identity is the
// identity.json beside the composed CLAUDE.md that ~/.claude/CLAUDE.md links to,
// so each machine finds its own env's file with no extra config, and an env with
// no identity.json (homelab, Windows) has no identity rather than borrowing one.
function identityPath(options: LoadIdentityOptions): { path: string; explicit: boolean } | null {
  const explicit = options.env['ARGUS_IDENTITY_PATH']?.trim();
  if (explicit) return { path: explicit, explicit: true };

  const claudeMd = join(options.homeDir ?? homedir(), '.claude', 'CLAUDE.md');
  if (!existsSync(claudeMd)) return null;
  return { path: join(dirname(realpathSync(claudeMd)), 'identity.json'), explicit: false };
}

// Read once at startup. A broken or explicitly named but missing file is
// reported as an error rather than treated as "no identity", so a typo can't
// make a deployment silently anonymous.
export function loadIdentity(options: LoadIdentityOptions): IdentityState {
  const located = identityPath(options);
  if (!located) return { identity: null, source: null, error: null };
  const { path, explicit } = located;

  if (!existsSync(path)) {
    return explicit
      ? { identity: null, source: path, error: `ARGUS_IDENTITY_PATH ${path} does not exist` }
      : { identity: null, source: null, error: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { identity: null, source: path, error: `${path}: invalid JSON (${message})` };
  }

  const parsed = IdentityFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return { identity: null, source: path, error: `${path}: ${issues.join('; ')}` };
  }

  const { schema_version: schemaVersion, name, environment } = parsed.data;
  return { identity: { schemaVersion, name, environment }, source: path, error: null };
}

function wire(identity: DeploymentIdentity) {
  return { name: identity.name, environment: identity.environment, schema_version: identity.schemaVersion };
}

// Deployments are addressed by `name`; `environment` is a filter, never an
// address (#95 decision 5). Each engine reports only itself, so /deployments
// has the shape a future name-keyed registry would serve without being one.
export function createIdentityRoutes(state: IdentityState): Hono {
  const routes = new Hono();
  const deployments = state.identity ? [state.identity] : [];

  routes.get('/identity', (c) => {
    if (state.error) return c.json({ error: state.error }, 500);
    if (!state.identity) return c.json({ error: 'no identity configured for this deployment' }, 404);
    return c.json(wire(state.identity));
  });

  routes.get('/deployments', (c) => {
    const environment = c.req.query('environment');
    const matches = environment ? deployments.filter((d) => d.environment === environment) : deployments;
    return c.json({ deployments: matches.map(wire) });
  });

  routes.get('/deployments/:name', (c) => {
    const match = deployments.find((d) => d.name === c.req.param('name'));
    if (!match) return c.json({ error: `no deployment named ${c.req.param('name')}` }, 404);
    return c.json(wire(match));
  });

  return routes;
}
