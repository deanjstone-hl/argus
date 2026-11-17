-- Enables the frontend dashboard (task-005) to subscribe to new service_checks rows
-- instead of polling on a fixed timer that's wrong for adapters with different intervals.
alter publication supabase_realtime add table public.service_checks;
