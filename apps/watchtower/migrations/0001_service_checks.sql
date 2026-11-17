-- id: SQLite has no gen_random_uuid(); the Worker generates one via
-- crypto.randomUUID() and binds it on INSERT, same convention as
-- apps/memory-mcp's memories table.
CREATE TABLE service_checks (
  id          TEXT PRIMARY KEY,
  service_key TEXT NOT NULL,
  host        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'down', 'unreachable')),
  detail      TEXT,             -- JSON, nullable (was jsonb in Postgres)
  checked_at  TEXT NOT NULL     -- ISO 8601, server-set on insert (was DB default now())
);

CREATE INDEX idx_service_checks_key_time ON service_checks (service_key, checked_at DESC);
