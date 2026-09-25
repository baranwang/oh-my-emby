CREATE TABLE item_flags (
  canonical_id TEXT PRIMARY KEY,
  watchlisted INTEGER NOT NULL DEFAULT 0 CHECK (watchlisted IN (0, 1)),
  watchlisted_at_ms INTEGER,
  hidden_from_resume INTEGER NOT NULL DEFAULT 0 CHECK (hidden_from_resume IN (0, 1))
) STRICT;

CREATE TABLE playback_history (
  id TEXT PRIMARY KEY,
  play_session_id TEXT NOT NULL UNIQUE,
  canonical_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  media_source_id TEXT,
  source_name TEXT,
  device_name TEXT,
  client_name TEXT,
  started_at_ms INTEGER NOT NULL,
  stopped_at_ms INTEGER,
  position_ticks INTEGER NOT NULL DEFAULT 0 CHECK (position_ticks >= 0),
  runtime_ticks INTEGER,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;

CREATE INDEX idx_playback_history_started ON playback_history(started_at_ms, id);

CREATE TABLE emby_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash BLOB NOT NULL,
  password_salt BLOB NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE emby_connection_devices (
  connection_id TEXT NOT NULL REFERENCES emby_connections(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL PRIMARY KEY
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (4, 'drivemby_compat', CAST(unixepoch('subsec') * 1000 AS INTEGER));
