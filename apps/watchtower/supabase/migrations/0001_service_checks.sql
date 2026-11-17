create table public.service_checks (
  id uuid primary key default gen_random_uuid(),
  service_key text not null,
  host text not null,
  status text not null check (status in ('healthy', 'degraded', 'down', 'unreachable')),
  detail jsonb,
  checked_at timestamptz not null default now()
);

create index service_checks_key_time_idx
  on public.service_checks (service_key, checked_at desc);

alter table public.service_checks enable row level security;

-- Collector writes with the service-role key, which bypasses RLS entirely —
-- no insert policy is granted to any other role.

create policy "authenticated users can read service checks"
  on public.service_checks
  for select
  to authenticated
  using (true);
