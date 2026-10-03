CREATE TABLE library_covers (
 library_id TEXT PRIMARY KEY REFERENCES virtual_libraries(id) ON DELETE CASCADE,
 body BLOB NOT NULL CHECK(length(body)<=512000), revision TEXT NOT NULL,
 template_version TEXT NOT NULL, config_digest TEXT NOT NULL,
 width INTEGER NOT NULL CHECK(width=1920), height INTEGER NOT NULL CHECK(height=1080), updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE library_cover_manifests (
 token TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES virtual_libraries(id) ON DELETE CASCADE,
 config_digest TEXT NOT NULL CHECK(json_valid(config_digest)), fences_json TEXT NOT NULL CHECK(json_valid(fences_json)),
 candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)), expected_revision TEXT, expires_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX library_cover_manifest_library ON library_cover_manifests(library_id,expires_at_ms);
CREATE TRIGGER cover_consume_insert AFTER INSERT ON library_covers BEGIN DELETE FROM library_cover_manifests WHERE library_id=NEW.library_id; END;
CREATE TRIGGER cover_consume_update AFTER UPDATE ON library_covers BEGIN DELETE FROM library_cover_manifests WHERE library_id=NEW.library_id; END;
INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(8,'library_covers',CAST(unixepoch('subsec') * 1000 AS INTEGER));
