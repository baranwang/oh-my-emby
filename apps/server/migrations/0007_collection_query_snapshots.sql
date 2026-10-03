CREATE TABLE collection_query_snapshots (
 query_key TEXT PRIMARY KEY,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 expires_at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(7,'collection_query_snapshots',CAST(unixepoch('subsec') * 1000 AS INTEGER));
