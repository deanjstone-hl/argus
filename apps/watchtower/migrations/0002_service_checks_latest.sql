-- argus#676: GET /checks read every row of service_checks (a correlated
-- MAX per row: ~1.6M rows read, ~3.4 s at 797k rows). Keep the latest check
-- per service_key in its own table, upserted alongside every insert, so the
-- dashboard read is bounded by the number of service keys, not by history.
CREATE TABLE service_checks_latest (
  service_key TEXT PRIMARY KEY,
  host        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'down', 'unreachable')),
  detail      TEXT,
  checked_at  TEXT NOT NULL
);

-- Backfill from existing history: newest row per key, ties on checked_at
-- broken by id so the result is deterministic.
INSERT INTO service_checks_latest (service_key, host, status, detail, checked_at)
SELECT service_key, host, status, detail, checked_at
FROM (
  SELECT service_key, host, status, detail, checked_at,
         ROW_NUMBER() OVER (PARTITION BY service_key ORDER BY checked_at DESC, id DESC) AS rn
  FROM service_checks
)
WHERE rn = 1;

-- Retention prunes by age across all keys; without this the scheduled
-- DELETE scans the whole history table on every run.
CREATE INDEX idx_service_checks_checked_at ON service_checks (checked_at);
