ALTER TABLE upstream_servers ADD COLUMN user_agent_policy TEXT NOT NULL DEFAULT 'fixed'
  CHECK (user_agent_policy IN ('fixed', 'client-preferred', 'passthrough'));

UPDATE upstream_servers
SET user_agent_policy = 'client-preferred'
WHERE trim(user_agent) = '';

CREATE TABLE IF NOT EXISTS upstream_server_endpoints (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL CHECK (protocol IN ('http', 'https')),
  host TEXT NOT NULL,
  port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  path TEXT NOT NULL,
  endpoint_order INTEGER NOT NULL CHECK (endpoint_order >= 0),
  verified_catalog_id TEXT,
  health TEXT NOT NULL CHECK (health IN ('unknown', 'healthy', 'degraded')),
  last_success_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (server_id, endpoint_order),
  UNIQUE (server_id, protocol, host, port, path)
) STRICT;

CREATE TABLE IF NOT EXISTS metadata_provider_settings (
  provider_id TEXT PRIMARY KEY CHECK (provider_id IN ('tmdb', 'trakt')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  provider_order INTEGER NOT NULL UNIQUE CHECK (provider_order IN (0, 1)),
  language TEXT,
  credential TEXT,
  status TEXT NOT NULL CHECK (status IN ('unconfigured', 'ready', 'degraded')),
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS external_metadata_cache (
  provider_id TEXT NOT NULL CHECK (provider_id IN ('tmdb', 'trakt')),
  identity_namespace TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  found INTEGER NOT NULL CHECK (found IN (0, 1)),
  fetched_at_ms INTEGER NOT NULL,
  fresh_until_ms INTEGER NOT NULL,
  stale_until_ms INTEGER NOT NULL,
  PRIMARY KEY (provider_id, identity_namespace, identity_value)
) STRICT;

WITH legacy AS (
  SELECT
    id,
    verified_catalog_id,
    health,
    last_success_at_ms,
    created_at_ms,
    updated_at_ms,
    lower(substr(base_url, 1, instr(base_url, '://') - 1)) AS protocol,
    substr(base_url, instr(base_url, '://') + 3) AS remainder
  FROM upstream_servers
  WHERE deleted_at_ms IS NULL
), split AS (
  SELECT
    *,
    CASE WHEN instr(remainder, '/') = 0 THEN remainder
      ELSE substr(remainder, 1, instr(remainder, '/') - 1) END AS authority,
    CASE WHEN instr(remainder, '/') = 0 OR substr(remainder, instr(remainder, '/')) = '/' THEN ''
      ELSE substr(remainder, instr(remainder, '/')) END AS path
  FROM legacy
), parsed AS (
  SELECT
    *,
    CASE
      WHEN substr(authority, 1, 1) = '[' THEN substr(authority, 1, instr(authority, ']'))
      WHEN instr(authority, ':') > 0 THEN substr(authority, 1, instr(authority, ':') - 1)
      ELSE authority
    END AS host,
    CASE
      WHEN substr(authority, 1, 1) = '[' AND substr(authority, instr(authority, ']') + 1, 1) = ':'
        THEN CAST(substr(authority, instr(authority, ']') + 2) AS INTEGER)
      WHEN substr(authority, 1, 1) <> '[' AND instr(authority, ':') > 0
        THEN CAST(substr(authority, instr(authority, ':') + 1) AS INTEGER)
      ELSE NULL
    END AS port
  FROM split
)
INSERT INTO upstream_server_endpoints (
  id, server_id, protocol, host, port, path, endpoint_order,
  verified_catalog_id, health, last_success_at_ms, created_at_ms, updated_at_ms
)
SELECT
  id || ':endpoint:0', id, protocol, host, port, path, 0,
  verified_catalog_id, health, last_success_at_ms, created_at_ms, updated_at_ms
FROM parsed
WHERE protocol IN ('http', 'https')
  AND NOT EXISTS (
    SELECT 1 FROM upstream_server_endpoints endpoint WHERE endpoint.server_id = parsed.id
  );

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (2, 'dashboard_alignment', CAST(unixepoch('subsec') * 1000 AS INTEGER));
