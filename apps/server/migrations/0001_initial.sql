PRAGMA foreign_keys = ON;

CREATE TABLE users (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  username TEXT NOT NULL UNIQUE,
  password_hash BLOB NOT NULL,
  password_salt BLOB NOT NULL,
  pbkdf2_iterations INTEGER NOT NULL CHECK (pbkdf2_iterations > 0),
  auth_generation INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE upstream_servers (
  id TEXT PRIMARY KEY,
  catalog_namespace TEXT NOT NULL UNIQUE,
  verified_catalog_id TEXT UNIQUE,
  verified_base_url TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT,
  access_token TEXT,
  access_token_expires_at_ms INTEGER,
  user_agent TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  health TEXT NOT NULL CHECK (health IN ('unknown', 'healthy', 'degraded')),
  last_success_at_ms INTEGER,
  deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE emby_tokens (
  id TEXT PRIMARY KEY,
  user_singleton INTEGER NOT NULL REFERENCES users(singleton) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  auth_generation INTEGER NOT NULL CHECK (auth_generation > 0),
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE dashboard_sessions (
  id TEXT PRIMARY KEY,
  user_singleton INTEGER NOT NULL REFERENCES users(singleton) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  auth_generation INTEGER NOT NULL CHECK (auth_generation > 0),
  created_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_rate_limits (
  scope_key TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  blocked_until_ms INTEGER,
  PRIMARY KEY (scope_key, window_started_at_ms)
) STRICT;

CREATE TABLE virtual_libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movies', 'series')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE library_sources (
  virtual_library_id TEXT NOT NULL REFERENCES virtual_libraries(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  source_library_id TEXT NOT NULL,
  source_library_name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movies', 'series')),
  source_order INTEGER NOT NULL CHECK (source_order >= 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (virtual_library_id, server_id, source_library_id)
) STRICT;

CREATE TABLE canonical_items (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  identity_state TEXT NOT NULL,
  display_metadata_json TEXT NOT NULL CHECK (json_valid(display_metadata_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE canonical_aliases (
  alias_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL REFERENCES canonical_items(id),
  retired_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE identity_claims (
  canonical_id TEXT NOT NULL REFERENCES canonical_items(id),
  namespace TEXT NOT NULL,
  value TEXT NOT NULL,
  state TEXT NOT NULL,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (canonical_id, namespace)
) STRICT;

CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES upstream_servers(id),
  catalog_namespace TEXT NOT NULL,
  server_generation INTEGER NOT NULL CHECK (server_generation > 0),
  source_library_id TEXT NOT NULL,
  upstream_item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  canonical_id TEXT REFERENCES canonical_items(id),
  quarantine_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (catalog_namespace, upstream_item_id, item_type)
) STRICT;

CREATE TABLE source_media_versions (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  server_generation INTEGER NOT NULL CHECK (server_generation > 0),
  upstream_media_source_id TEXT NOT NULL,
  label TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  streams_json TEXT NOT NULL CHECK (json_valid(streams_json)),
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (source_item_id, upstream_media_source_id)
) STRICT;

CREATE TABLE user_state (
  canonical_id TEXT PRIMARY KEY REFERENCES canonical_items(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  played INTEGER NOT NULL CHECK (played IN (0, 1)),
  favorite INTEGER NOT NULL CHECK (favorite IN (0, 1)),
  play_count INTEGER NOT NULL CHECK (play_count >= 0),
  position_ticks INTEGER NOT NULL CHECK (position_ticks >= 0),
  last_played_version_id TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE source_metadata_cache (
  source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  projection_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  fresh_until_ms INTEGER NOT NULL,
  stale_until_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (source_item_id, projection_key)
) STRICT;

CREATE TABLE query_generations (
  id TEXT PRIMARY KEY,
  query_key TEXT NOT NULL UNIQUE,
  user_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  virtual_library_id TEXT NOT NULL REFERENCES virtual_libraries(id) ON DELETE CASCADE,
  normalized_query_json TEXT NOT NULL CHECK (json_valid(normalized_query_json)),
  source_state_json TEXT NOT NULL CHECK (json_valid(source_state_json)),
  all_sources_exhausted INTEGER NOT NULL CHECK (all_sources_exhausted IN (0, 1)),
  state_dependent INTEGER NOT NULL CHECK (state_dependent IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE query_generation_items (
  generation_id TEXT NOT NULL REFERENCES query_generations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  canonical_id TEXT NOT NULL REFERENCES canonical_items(id),
  sort_values_json TEXT NOT NULL CHECK (json_valid(sort_values_json)),
  PRIMARY KEY (generation_id, ordinal),
  UNIQUE (generation_id, canonical_id)
) STRICT;

CREATE TABLE state_outbox (
  target_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL REFERENCES canonical_items(id),
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  server_id TEXT NOT NULL REFERENCES upstream_servers(id),
  server_generation INTEGER NOT NULL CHECK (server_generation > 0),
  desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
  delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK (delivered_revision >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at_ms INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  dispatched_at_ms INTEGER,
  uncertain_since_ms INTEGER,
  permanent_failure_code TEXT,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE playback_sessions (
  id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL REFERENCES canonical_items(id),
  version_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  last_event_at_ms INTEGER NOT NULL,
  last_position_ticks INTEGER NOT NULL CHECK (last_position_ticks >= 0),
  stop_applied INTEGER NOT NULL CHECK (stop_applied IN (0, 1)),
  state_revision INTEGER NOT NULL CHECK (state_revision > 0)
) STRICT;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_identity_claims_external ON identity_claims(namespace, value);
CREATE INDEX idx_source_items_lookup ON source_items(server_id, source_library_id, upstream_item_id, item_type);
CREATE INDEX idx_metadata_cache_expiry ON source_metadata_cache(stale_until_ms);
CREATE INDEX idx_query_generations_expiry ON query_generations(expires_at_ms);
CREATE INDEX idx_state_outbox_due ON state_outbox(next_attempt_at_ms, lease_expires_at_ms)
  WHERE eligible = 1 AND permanent_failure_code IS NULL;
CREATE INDEX idx_state_outbox_uncertain ON state_outbox(uncertain_since_ms)
  WHERE eligible = 1 AND uncertain_since_ms IS NOT NULL;
CREATE INDEX idx_auth_rate_limits_expiry ON auth_rate_limits(blocked_until_ms, window_started_at_ms);
CREATE INDEX idx_library_sources_ordered
  ON library_sources(virtual_library_id, enabled, source_order, server_id, source_library_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (1, 'initial', CAST(unixepoch('subsec') * 1000 AS INTEGER));
