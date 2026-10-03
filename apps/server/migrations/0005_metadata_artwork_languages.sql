CREATE TABLE metadata_artwork_settings (
  provider_id TEXT PRIMARY KEY REFERENCES metadata_provider_settings(provider_id) ON DELETE CASCADE,
  logo_language TEXT NOT NULL DEFAULT 'original' CHECK (logo_language IN ('metadata', 'original', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-SG', 'es-ES', 'en-US', 'ar-SA', 'ja-JP', 'ko-KR', 'ru-RU', 'fr-FR')),
  poster_language TEXT NOT NULL DEFAULT 'original' CHECK (poster_language IN ('metadata', 'original', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-SG', 'es-ES', 'en-US', 'ar-SA', 'ja-JP', 'ko-KR', 'ru-RU', 'fr-FR')),
  system_language TEXT NOT NULL DEFAULT 'en-US' CHECK (system_language IN ('en-US', 'zh-CN'))
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (5, 'metadata_artwork_languages', CAST(unixepoch('subsec') * 1000 AS INTEGER));
