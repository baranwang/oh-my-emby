CREATE TABLE movie_collections (
  id TEXT PRIMARY KEY,
  tmdb_collection_id TEXT UNIQUE,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE collection_sources (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES movie_collections(id),
  server_id TEXT NOT NULL REFERENCES upstream_servers(id),
  catalog_namespace TEXT NOT NULL,
  server_generation INTEGER NOT NULL,
  upstream_boxset_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(server_id, catalog_namespace, server_generation, upstream_boxset_id)
) STRICT;
CREATE TABLE collection_aliases (
  alias_id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES movie_collections(id)
) STRICT;
CREATE TABLE collection_members (
  collection_id TEXT NOT NULL REFERENCES movie_collections(id),
  evidence_key TEXT NOT NULL,
  source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  canonical_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK(evidence_type IN ('tmdb','boxset')),
  collection_source_id TEXT REFERENCES collection_sources(id),
  server_generation INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(evidence_key, source_item_id)
) STRICT;
CREATE TABLE collection_membership_updates (
  source_item_id TEXT PRIMARY KEY REFERENCES source_items(id) ON DELETE CASCADE,
  server_generation INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX collection_members_collection ON collection_members(collection_id);
CREATE TABLE collection_revision (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL) STRICT;
INSERT INTO collection_revision VALUES(1, 0);
INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(6,'movie_collections',CAST(unixepoch('subsec') * 1000 AS INTEGER));
