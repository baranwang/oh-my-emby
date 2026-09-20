import { Database } from "bun:sqlite"
import { Effect } from "effect"

import { MAX_IMAGE_BYTES } from "../../core/limits.js"
import {
  ResourceCacheError,
  type CachedResource,
  type ResourceCacheService
} from "../../core/resource-cache.js"

const safeHeaders = ["content-type", "content-disposition", "etag", "last-modified"] as const

interface CacheRow {
  readonly status: number
  readonly headers_json: string
  readonly body: Uint8Array
  readonly expires_at_ms: number
}

const failure = () => new ResourceCacheError({ message: "Bun resource cache operation failed" })
const digest = (key: string): string => new Bun.CryptoHasher("sha256").update(key).digest("hex")

const headersFrom = (headers: ReadonlyArray<readonly [string, string]>) => headers.filter(([name]) =>
  safeHeaders.includes(name.toLowerCase() as typeof safeHeaders[number])
)

export interface BunResourceCache {
  readonly service: ResourceCacheService
  readonly close: () => void
}

export const openBunResourceCache = (
  filename: string,
  maxBytes = 256 * 1024 * 1024
): BunResourceCache => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("cache size must be a non-negative integer")
  const database = new Database(filename, { create: true })
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS resource_cache (
      key_hash TEXT PRIMARY KEY,
      status INTEGER NOT NULL,
      headers_json TEXT NOT NULL,
      body BLOB NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      accessed_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_resource_cache_lru
      ON resource_cache(accessed_at_ms, key_hash);
  `)

  const trim = () => {
    let total = database.query<{ size: number }, []>(
      "SELECT COALESCE(SUM(length(body)), 0) AS size FROM resource_cache"
    ).get()?.size ?? 0
    if (total <= maxBytes) return
    for (const row of database.query<{ key_hash: string; size: number }, []>(
      "SELECT key_hash, length(body) AS size FROM resource_cache ORDER BY accessed_at_ms, key_hash"
    ).all()) {
      database.query("DELETE FROM resource_cache WHERE key_hash = ?").run(row.key_hash)
      total -= row.size
      if (total <= maxBytes) break
    }
  }

  const service: ResourceCacheService = {
    get: (key) => Effect.try({
      try: (): CachedResource | null => {
        const keyHash = digest(key)
        const row = database.query<CacheRow, [string]>(`
          SELECT status, headers_json, body, expires_at_ms
          FROM resource_cache
          WHERE key_hash = ?
        `).get(keyHash)
        if (row === null) return null
        if (row.expires_at_ms <= Date.now()) {
          database.query("DELETE FROM resource_cache WHERE key_hash = ?").run(keyHash)
          return null
        }
        database.query("UPDATE resource_cache SET accessed_at_ms = ? WHERE key_hash = ?")
          .run(Date.now(), keyHash)
        const headers = JSON.parse(row.headers_json) as ReadonlyArray<readonly [string, string]>
        return {
          status: row.status,
          headers,
          body: Uint8Array.from(row.body),
          expiresAtMs: row.expires_at_ms
        }
      },
      catch: failure
    }),
    put: (key, resource, expiresAtMs) => Effect.try({
      try: () => {
        if (
          resource.body.byteLength > MAX_IMAGE_BYTES ||
          !Number.isSafeInteger(expiresAtMs)
        ) throw failure()
        database.transaction(() => {
          database.query(`
            INSERT INTO resource_cache(key_hash, status, headers_json, body, expires_at_ms, accessed_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(key_hash) DO UPDATE SET
              status = excluded.status,
              headers_json = excluded.headers_json,
              body = excluded.body,
              expires_at_ms = excluded.expires_at_ms,
              accessed_at_ms = excluded.accessed_at_ms
          `).run(
            digest(key),
            resource.status,
            JSON.stringify(headersFrom(resource.headers)),
            resource.body,
            expiresAtMs,
            Date.now()
          )
          trim()
        })()
      },
      catch: failure
    }),
    prune: (nowMs) => Effect.try({
      try: () => {
        database.query("DELETE FROM resource_cache WHERE expires_at_ms <= ?").run(nowMs)
        trim()
      },
      catch: failure
    })
  }

  let closed = false
  return {
    service,
    close: () => {
      if (closed) return
      closed = true
      database.close()
    }
  }
}
