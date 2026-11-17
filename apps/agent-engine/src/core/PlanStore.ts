import type { SupabaseClient } from '@supabase/supabase-js';

// Schema, table and column names for ADR-010's Plans feature (myargus repo,
// docs/decisions/adr-010-plans-feature.md). The migration is owned by
// myargus#141 (supabase/migrations/20261008000000_plans_schema.sql) — keep
// these in step with it.
const PLANS_SCHEMA = 'plans';
const PLANS_TABLE = 'plans';
const PLAN_STEPS_TABLE = 'plan_steps';
const PLAN_COLUMNS = 'id, slug, title, subtitle, session_id';
const STEP_COLUMNS = 'id, position, kind, title, badge, check_label, content, done_note, completed_at';

const MAX_SLUG_LENGTH = 80;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 10_000;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_STEPS = 500;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STEP_KINDS = ['predone', 'user'] as const;
const STEP_BADGES = ['wsl', 'win', 'server', 'generic'] as const;

export type PlanStepKind = (typeof STEP_KINDS)[number];
export type PlanStepBadge = (typeof STEP_BADGES)[number];

// Mirrors the impl-plan skill's step objects (`type`, `doneNote`, `checkLabel`),
// so the publish mode (myargus#143) can POST its STEPS array unchanged.
export interface PlanStepInput {
  kind: PlanStepKind;
  title: string;
  badge: PlanStepBadge | null;
  checkLabel: string | null;
  content: string | null;
  doneNote: string | null;
}

export interface PlanInput {
  slug: string;
  title: string;
  subtitle: string | null;
  sessionId: string | null;
  steps: PlanStepInput[];
}

export interface PlanStep {
  id: string;
  position: number;
  kind: PlanStepKind;
  title: string;
  badge: PlanStepBadge | null;
  check_label: string | null;
  content: string | null;
  done_note: string | null;
  completed_at: string | null;
}

export interface Plan {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  session_id: string | null;
  steps: PlanStep[];
}

export interface PublishResult {
  plan: Plan;
  created: boolean;
}

export interface PlanStore {
  publish(input: PlanInput): Promise<PublishResult>;
}

export interface PlanStoreOptions {
  // plans.user_id is NOT NULL and the service role carries no JWT, so the
  // owner's auth.users id has to come from config.
  ownerUserId: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export type ParseResult = Parsed<PlanInput>;

export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

function parseTitle(value: unknown, field: string): Parsed<string> {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: `${field} must be a non-blank string` };
  const title = value.trim();
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: `${field} must be at most ${MAX_TITLE_LENGTH} characters` };
  return { ok: true, value: title };
}

function parseOptionalText(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` };
  if (value.length > maxLength) return { ok: false, error: `${field} must be at most ${maxLength} characters` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

function parseEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): Parsed<T | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return { ok: false, error: `${field} must be one of ${allowed.join(', ')}` };
  }
  return { ok: true, value: value as T };
}

function parseStep(value: unknown, index: number): Parsed<PlanStepInput> {
  const field = `steps[${index}]`;
  if (typeof value === 'string') {
    const title = parseTitle(value, field);
    if (!title.ok) return title;
    return { ok: true, value: { kind: 'user', title: title.value, badge: null, checkLabel: null, content: null, doneNote: null } };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `${field} must be a string or an object with a title` };
  }
  const step = value as Record<string, unknown>;

  const kind = parseEnum(step['type'], `${field}.type`, STEP_KINDS);
  if (!kind.ok) return kind;
  const title = parseTitle(step['title'], `${field}.title`);
  if (!title.ok) return title;
  const badge = parseEnum(step['badge'], `${field}.badge`, STEP_BADGES);
  if (!badge.ok) return badge;
  const checkLabel = parseOptionalText(step['checkLabel'], `${field}.checkLabel`);
  if (!checkLabel.ok) return checkLabel;
  const content = parseOptionalText(step['content'], `${field}.content`, MAX_CONTENT_LENGTH);
  if (!content.ok) return content;
  const doneNote = parseOptionalText(step['doneNote'], `${field}.doneNote`);
  if (!doneNote.ok) return doneNote;

  return {
    ok: true,
    value: {
      kind: kind.value ?? 'user',
      title: title.value,
      badge: badge.value,
      checkLabel: checkLabel.value,
      content: content.value,
      doneNote: doneNote.value,
    },
  };
}

export function parsePlanInput(body: unknown): ParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;

  const title = parseTitle(record['title'], 'title');
  if (!title.ok) return title;

  let slug: string;
  const rawSlug = record['slug'];
  if (rawSlug === undefined || rawSlug === null) {
    slug = slugify(title.value);
    if (!slug) return { ok: false, error: 'title must contain at least one letter or digit to derive a slug' };
  } else {
    if (typeof rawSlug !== 'string' || rawSlug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(rawSlug)) {
      return { ok: false, error: `slug must be lowercase letters, digits and single hyphens, at most ${MAX_SLUG_LENGTH} characters` };
    }
    slug = rawSlug;
  }

  const subtitle = parseOptionalText(record['subtitle'], 'subtitle');
  if (!subtitle.ok) return subtitle;
  const sessionId = parseOptionalText(record['sessionId'], 'sessionId', MAX_TITLE_LENGTH);
  if (!sessionId.ok) return sessionId;

  const rawSteps = record['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { ok: false, error: 'steps must be a non-empty array' };
  }
  if (rawSteps.length > MAX_STEPS) {
    return { ok: false, error: `steps must have at most ${MAX_STEPS} entries` };
  }
  const steps: PlanStepInput[] = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    const step = parseStep(rawStep, index);
    if (!step.ok) return step;
    steps.push(step.value);
  }

  return { ok: true, value: { slug, title: title.value, subtitle: subtitle.value, sessionId: sessionId.value, steps } };
}

// Publishing is idempotent on slug: a republish updates the plan row in place
// and upserts steps on (plan_id, position). The step upsert never carries
// completed_at, so progress ticked off in the shell app survives a republish;
// predone steps get completed_at only while it is still unset. The writes are
// not one transaction, and a failure part-way is converged by the next
// successful publish.
export function createPlanStore(client: SupabaseClient, options: PlanStoreOptions): PlanStore {
  const db = () => client.schema(PLANS_SCHEMA);

  return {
    async publish(input: PlanInput): Promise<PublishResult> {
      const fail = (stage: string, message: string) => new Error(`${stage} failed for plan "${input.slug}": ${message}`);

      const existing = await db().from(PLANS_TABLE).select('id').eq('slug', input.slug).maybeSingle();
      if (existing.error) throw fail('lookup', existing.error.message);

      const planWrite = await db()
        .from(PLANS_TABLE)
        .upsert(
          {
            user_id: options.ownerUserId,
            slug: input.slug,
            title: input.title,
            subtitle: input.subtitle,
            session_id: input.sessionId,
          },
          { onConflict: 'slug' }
        )
        .select(PLAN_COLUMNS)
        .single();
      if (planWrite.error) throw fail('upsert', planWrite.error.message);
      const planRow = planWrite.data as Omit<Plan, 'steps'>;

      const stepsWrite = await db()
        .from(PLAN_STEPS_TABLE)
        .upsert(
          input.steps.map((step, position) => ({
            plan_id: planRow.id,
            position,
            kind: step.kind,
            title: step.title,
            badge: step.badge,
            check_label: step.checkLabel,
            content: step.content,
            done_note: step.doneNote,
          })),
          { onConflict: 'plan_id,position' }
        );
      if (stepsWrite.error) throw fail('step upsert', stepsWrite.error.message);

      const predone = await db()
        .from(PLAN_STEPS_TABLE)
        .update({ completed_at: new Date().toISOString() })
        .eq('plan_id', planRow.id)
        .eq('kind', 'predone')
        .is('completed_at', null);
      if (predone.error) throw fail('predone completion', predone.error.message);

      const trim = await db()
        .from(PLAN_STEPS_TABLE)
        .delete()
        .eq('plan_id', planRow.id)
        .gte('position', input.steps.length);
      if (trim.error) throw fail('step trim', trim.error.message);

      const steps = await db()
        .from(PLAN_STEPS_TABLE)
        .select(STEP_COLUMNS)
        .eq('plan_id', planRow.id)
        .order('position', { ascending: true });
      if (steps.error) throw fail('step read', steps.error.message);

      return { plan: { ...planRow, steps: (steps.data ?? []) as PlanStep[] }, created: existing.data === null };
    },
  };
}
