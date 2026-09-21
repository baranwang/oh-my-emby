import * as D1Client from "@effect/sql-d1/D1Client"
import {
  ServerView as ServerViewSchema,
  SourceLibraryView as SourceLibraryViewSchema,
  VirtualLibraryView as VirtualLibraryViewSchema
} from "@oh-my-emby/contracts"
import { Effect, Layer, Result, Schema } from "effect"
import type { Statement } from "effect/unstable/sql/Statement"

import {
  AUTH_RATE_WINDOW_MS,
  DB_BATCH_SIZE,
  OUTBOX_BATCH_SIZE,
  OUTBOX_LEASE_MS,
  UNCERTAINTY_REAPPLY_MS
} from "../../core/limits.js"
import {
  AlreadyInitialized,
  AuthenticationChanged,
  IdentityConflict,
  RepositoryError
} from "../../core/errors.js"
import {
  clustersCompatible,
  stableCanonicalId,
  toClaimSet,
  type ExternalClaim,
  type PreparedIdentityCandidate,
  type ProviderNamespace
} from "../../core/identity.js"
import type {
  CanonicalAlias,
  CanonicalItem,
  DesiredUserState,
  EligibleSource,
  IdentityClaim,
  IdentityResolution,
  JsonValue,
  LibrarySource,
  MaintenanceResult,
  MediaType,
  OutboxClaim,
  QueryGeneration,
  ServerHealth,
  SourceItemRecord,
  SourceMediaVersion,
  UpstreamServer,
  UserRecord,
  UserStateRecord,
  VirtualLibrary
} from "../../core/model.js"
import {
  Repositories,
  type CatalogItemRecord,
  type DetailProjectionSuppression,
  type MetadataProjection,
  type RepositoriesService
} from "../../core/repositories.js"

const decodeServerId = Schema.decodeUnknownSync(ServerViewSchema.fields.id)
const decodeSourceLibraryId = Schema.decodeUnknownSync(SourceLibraryViewSchema.fields.id)
const decodeVirtualLibraryId = Schema.decodeUnknownSync(VirtualLibraryViewSchema.fields.id)

const failure = (operation: string, cause: unknown) => new RepositoryError({
  operation,
  message: cause instanceof Error ? cause.message : String(cause)
})

const database = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => failure(operation, cause)))

const authDatabase = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) =>
    cause instanceof AuthenticationChanged ? cause : failure(operation, cause)
  ))

const identityDatabase = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) =>
    cause instanceof IdentityConflict ? cause : failure(operation, cause)
  ))

const decode = <A>(operation: string, evaluate: () => A) => Effect.try({
  try: evaluate,
  catch: (cause) => failure(operation, cause)
})

const boolean = (value: unknown, field: string): boolean => {
  if (value === 0) return false
  if (value === 1) return true
  throw new TypeError(`${field} must be encoded as 0 or 1`)
}

const integer = (value: unknown, field: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  throw new TypeError(`${field} must be a safe integer`)
}

const bytes = (value: unknown, field: string): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(value)
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError(`${field} must be bytes`)
}

const mediaType = (value: unknown): MediaType => {
  if (value === "movies" || value === "series") return value
  throw new TypeError("media_type is invalid")
}

const health = (value: unknown): ServerHealth => {
  if (value === "unknown" || value === "healthy" || value === "degraded") return value
  throw new TypeError("health is invalid")
}

const normalizeJson = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects")
    }
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        normalizeJson((value as Record<string, unknown>)[key])
      ])
    )
  }
  throw new TypeError("value is not valid JSON")
}

const canonicalJson = (value: unknown): string => JSON.stringify(normalizeJson(value))
const json = (value: unknown, field: string): JsonValue => {
  if (typeof value !== "string") throw new TypeError(`${field} must be JSON text`)
  return normalizeJson(JSON.parse(value))
}

const mergeMissingJson = (current: JsonValue, incoming: JsonValue): JsonValue => {
  if (
    typeof current !== "object" || current === null || Array.isArray(current) ||
    typeof incoming !== "object" || incoming === null || Array.isArray(incoming)
  ) return current
  const currentObject = current as { readonly [key: string]: JsonValue }
  const incomingObject = incoming as { readonly [key: string]: JsonValue }
  const merged: Record<string, JsonValue> = { ...incomingObject }
  for (const [key, value] of Object.entries(currentObject)) {
    const candidate = incomingObject[key]
    merged[key] = candidate === undefined ? value : mergeMissingJson(value, candidate)
  }
  return merged
}

const mergeProjectionJson = (current: JsonValue, incoming: JsonValue): JsonValue => {
  if (
    typeof current !== "object" || current === null || Array.isArray(current) ||
    typeof incoming !== "object" || incoming === null || Array.isArray(incoming)
  ) return incoming
  const currentObject = current as { readonly [key: string]: JsonValue }
  const incomingObject = incoming as { readonly [key: string]: JsonValue }
  const merged: Record<string, JsonValue> = { ...currentObject }
  for (const [key, value] of Object.entries(incomingObject)) {
    merged[key] = currentObject[key] === undefined ? value : mergeProjectionJson(currentObject[key], value)
  }
  return merged
}

const desiredUserState = (value: unknown): DesiredUserState => {
  const decoded = json(value, "payload_json")
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    throw new TypeError("payload_json must contain a desired user state object")
  }
  const fields = decoded as Record<string, JsonValue>
  if (
    typeof fields.played !== "boolean" ||
    typeof fields.favorite !== "boolean" ||
    typeof fields.playCount !== "number" ||
    !Number.isSafeInteger(fields.playCount) ||
    fields.playCount < 0 ||
    typeof fields.positionTicks !== "number" ||
    !Number.isSafeInteger(fields.positionTicks) ||
    fields.positionTicks < 0 ||
    (fields.lastPlayedVersionId !== null && typeof fields.lastPlayedVersionId !== "string")
  ) {
    throw new TypeError("payload_json contains an invalid desired user state")
  }
  return {
    played: fields.played,
    favorite: fields.favorite,
    playCount: fields.playCount,
    positionTicks: fields.positionTicks,
    lastPlayedVersionId: fields.lastPlayedVersionId
  }
}

interface UserRow {
  readonly username: string
  readonly password_hash: unknown
  readonly password_salt: unknown
  readonly pbkdf2_iterations: unknown
  readonly auth_generation: unknown
  readonly created_at_ms: unknown
  readonly updated_at_ms: unknown
}

interface DashboardSessionRow {
  readonly id: string
  readonly token_hash: unknown
  readonly auth_generation: unknown
  readonly created_at_ms: unknown
  readonly last_seen_at_ms: unknown
  readonly expires_at_ms: unknown
  readonly username: string
  readonly current_auth_generation: unknown
}

interface EmbyTokenRow {
  readonly id: string
  readonly token_hash: unknown
  readonly auth_generation: unknown
  readonly device_id: string
  readonly device_name: string
  readonly created_at_ms: unknown
  readonly last_used_at_ms: unknown
  readonly expires_at_ms: unknown
  readonly username: string
  readonly current_auth_generation: unknown
}

interface AuthRateLimitRow {
  readonly window_started_at_ms: unknown
  readonly attempt_count: unknown
  readonly blocked_until_ms: unknown | null
}

const userRecord = (row: UserRow): UserRecord => ({
  username: row.username,
  password: {
    hash: bytes(row.password_hash, "password_hash"),
    salt: bytes(row.password_salt, "password_salt"),
    iterations: integer(row.pbkdf2_iterations, "pbkdf2_iterations")
  },
  authGeneration: integer(row.auth_generation, "auth_generation"),
  createdAtMs: integer(row.created_at_ms, "created_at_ms"),
  updatedAtMs: integer(row.updated_at_ms, "updated_at_ms")
})

interface ServerRow {
  readonly id: string
  readonly catalog_namespace: string
  readonly verified_catalog_id: string | null
  readonly verified_base_url: string | null
  readonly generation: unknown
  readonly name: string
  readonly base_url: string
  readonly username: string
  readonly password: string | null
  readonly access_token: string | null
  readonly access_token_expires_at_ms: unknown | null
  readonly upstream_user_id: string | null
  readonly user_agent: string
  readonly enabled: unknown
  readonly health: unknown
  readonly last_success_at_ms: unknown | null
  readonly deleted_at_ms: unknown | null
  readonly created_at_ms: unknown
  readonly updated_at_ms: unknown
}

const upstreamServer = (row: ServerRow): UpstreamServer => ({
  id: decodeServerId(row.id),
  catalogNamespace: row.catalog_namespace,
  verifiedCatalogId: row.verified_catalog_id,
  verifiedBaseUrl: row.verified_base_url,
  generation: integer(row.generation, "generation"),
  name: row.name,
  // Revalidate at the outbound request boundary as well as the Dashboard contract.
  baseUrl: row.base_url as UpstreamServer["baseUrl"],
  username: row.username,
  password: row.password,
  accessToken: row.access_token,
  accessTokenExpiresAtMs: row.access_token_expires_at_ms === null
    ? null
    : integer(row.access_token_expires_at_ms, "access_token_expires_at_ms"),
  upstreamUserId: row.upstream_user_id,
  userAgent: row.user_agent,
  enabled: boolean(row.enabled, "enabled"),
  health: health(row.health),
  lastSuccessAtMs: row.last_success_at_ms === null
    ? null
    : integer(row.last_success_at_ms, "last_success_at_ms"),
  deletedAtMs: row.deleted_at_ms === null ? null : integer(row.deleted_at_ms, "deleted_at_ms"),
  createdAtMs: integer(row.created_at_ms, "created_at_ms"),
  updatedAtMs: integer(row.updated_at_ms, "updated_at_ms")
})

interface UserStateRow {
  readonly canonical_id: string
  readonly revision: unknown
  readonly played: unknown
  readonly favorite: unknown
  readonly play_count: unknown
  readonly position_ticks: unknown
  readonly last_played_version_id: string | null
  readonly updated_at_ms: unknown
}

interface CanonicalRow {
  readonly id: string
  readonly item_type: string
  readonly identity_state: string
  readonly display_metadata_json: unknown
  readonly created_at_ms: unknown
  readonly updated_at_ms: unknown
}

interface IdentityClaimRow {
  readonly canonical_id: string
  readonly namespace: string
  readonly value: string
  readonly state: string
  readonly source_item_id: string
  readonly created_at_ms: unknown
}

interface SourceItemRow {
  readonly id: string
  readonly server_id: string
  readonly catalog_namespace: string
  readonly server_generation: unknown
  readonly source_library_id: string
  readonly upstream_item_id: string
  readonly item_type: string
  readonly canonical_id: string | null
  readonly quarantine_reason: string | null
  readonly created_at_ms: unknown
  readonly updated_at_ms: unknown
}

interface MediaVersionRow {
  readonly id: string
  readonly source_item_id: string
  readonly server_generation: unknown
  readonly upstream_media_source_id: string
  readonly label: string
  readonly capabilities_json: unknown
  readonly streams_json: unknown
  readonly updated_at_ms: unknown
}

const canonicalItem = (row: CanonicalRow): CanonicalItem => ({
  id: row.id,
  itemType: row.item_type,
  identityState: row.identity_state,
  displayMetadata: json(row.display_metadata_json, "display_metadata_json"),
  createdAtMs: integer(row.created_at_ms, "created_at_ms"),
  updatedAtMs: integer(row.updated_at_ms, "updated_at_ms")
})

const identityClaim = (row: IdentityClaimRow): IdentityClaim => ({
  namespace: row.namespace,
  value: row.value,
  state: row.state,
  sourceItemId: row.source_item_id,
  createdAtMs: integer(row.created_at_ms, "created_at_ms")
})

const sourceItem = (row: SourceItemRow): SourceItemRecord => ({
  id: row.id,
  serverId: row.server_id,
  catalogNamespace: row.catalog_namespace,
  serverGeneration: integer(row.server_generation, "server_generation"),
  sourceLibraryId: row.source_library_id,
  upstreamItemId: row.upstream_item_id,
  itemType: row.item_type,
  canonicalId: row.canonical_id,
  quarantineReason: row.quarantine_reason,
  createdAtMs: integer(row.created_at_ms, "created_at_ms"),
  updatedAtMs: integer(row.updated_at_ms, "updated_at_ms")
})

const mediaVersion = (row: MediaVersionRow): SourceMediaVersion => ({
  id: row.id,
  sourceItemId: row.source_item_id,
  serverGeneration: integer(row.server_generation, "server_generation"),
  upstreamMediaSourceId: row.upstream_media_source_id,
  label: row.label,
  capabilities: json(row.capabilities_json, "capabilities_json"),
  streams: json(row.streams_json, "streams_json"),
  updatedAtMs: integer(row.updated_at_ms, "updated_at_ms")
})

const providerNamespaces = new Set<string>(["tmdb:movie", "tmdb:tv", "imdb:title"])
const externalClaims = (rows: ReadonlyArray<IdentityClaimRow>): ReadonlyArray<ExternalClaim> => rows
  .filter((row): row is IdentityClaimRow & { readonly namespace: ProviderNamespace } =>
    row.state === "exact" && providerNamespaces.has(row.namespace)
  )
  .map(({ namespace, value }) => ({ namespace, value }))

const userState = (row: UserStateRow): UserStateRecord => ({
  canonicalId: row.canonical_id,
  revision: integer(row.revision, "revision"),
  played: boolean(row.played, "played"),
  favorite: boolean(row.favorite, "favorite"),
  playCount: integer(row.play_count, "play_count"),
  positionTicks: integer(row.position_ticks, "position_ticks"),
  lastPlayedVersionId: row.last_played_version_id,
  updatedAtMs: integer(row.updated_at_ms, "updated_at_ms")
})

const makeRepositories = Effect.gen(function*() {
  const sql = yield* D1Client.D1Client
  yield* sql.unsafe("PRAGMA foreign_keys = ON").pipe(Effect.orDie)
  const pragma = yield* sql.unsafe<{ foreign_keys: number }>("PRAGMA foreign_keys").pipe(Effect.orDie)
  if (pragma[0]?.foreign_keys !== 1) {
    return yield* Effect.die("SQLite foreign key enforcement is unavailable")
  }

  const claimUser: RepositoriesService["claimUser"] = (input) => Effect.suspend(() => {
    const nowMs = input.nowMs ?? Date.now()
    return Effect.gen(function*() {
      const inserted = yield* Effect.result(sql.unsafe<UserRow>(`
        INSERT INTO users (
          singleton, username, password_hash, password_salt, pbkdf2_iterations,
          auth_generation, created_at_ms, updated_at_ms
        ) SELECT 1, ?, ?, ?, ?, 1, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE singleton = 1)
        RETURNING *
      `, [
        input.username,
        input.password.hash,
        input.password.salt,
        input.password.iterations,
        nowMs,
        nowMs
      ]))
      if (Result.isFailure(inserted)) {
        const existing = yield* sql.unsafe<{ readonly singleton: number }>(
          "SELECT singleton FROM users WHERE singleton = 1"
        )
        if (existing[0]) return yield* Effect.fail(new AlreadyInitialized())
        return yield* Effect.fail(inserted.failure)
      }
      if (inserted.success[0] === undefined) return yield* Effect.fail(new AlreadyInitialized())
      return yield* decode("claimUser", () => userRecord(inserted.success[0]!))
    }).pipe(Effect.mapError((cause) =>
      cause instanceof AlreadyInitialized ? cause : failure("claimUser", cause)
    ))
  })

  const getUserByName: RepositoriesService["getUserByName"] = (username) =>
    database("getUserByName", sql.unsafe<UserRow>("SELECT * FROM users WHERE username = ?", [username])).pipe(
      Effect.flatMap((rows) => decode("getUserByName", () => rows[0] ? userRecord(rows[0]) : null))
    )

  const getUser: RepositoriesService["getUser"] = () =>
    database("getUser", sql.unsafe<UserRow>("SELECT * FROM users WHERE singleton = 1")).pipe(
      Effect.flatMap((rows) => decode("getUser", () => rows[0] ? userRecord(rows[0]) : null))
    )

  const issueDashboardSession: RepositoriesService["issueDashboardSession"] = (input) =>
    authDatabase("issueDashboardSession", Effect.gen(function*() {
      const rows = yield* sql.unsafe<{ auth_generation: unknown }>(`
        INSERT INTO dashboard_sessions (
          id, user_singleton, token_hash, auth_generation, created_at_ms,
          last_seen_at_ms, expires_at_ms
        )
        SELECT ?, 1, ?, auth_generation, ?, ?, ?
        FROM users
        WHERE singleton = 1 AND auth_generation = ?
        RETURNING auth_generation
      `, [
        input.id,
        input.tokenHash,
        input.createdAtMs,
        input.lastSeenAtMs,
        input.expiresAtMs,
        input.expectedAuthGeneration
      ])
      if (!rows[0]) return yield* Effect.fail(new AuthenticationChanged())
      return {
        id: input.id,
        tokenHash: input.tokenHash,
        authGeneration: integer(rows[0].auth_generation, "auth_generation"),
        createdAtMs: input.createdAtMs,
        lastSeenAtMs: input.lastSeenAtMs,
        expiresAtMs: input.expiresAtMs
      }
    }))

  const issueEmbyToken: RepositoriesService["issueEmbyToken"] = (input) =>
    authDatabase("issueEmbyToken", Effect.gen(function*() {
      const rows = yield* sql.unsafe<{ auth_generation: unknown }>(`
        INSERT INTO emby_tokens (
          id, user_singleton, token_hash, auth_generation, device_id, device_name,
          created_at_ms, last_used_at_ms, expires_at_ms
        )
        SELECT ?, 1, ?, auth_generation, ?, ?, ?, ?, ?
        FROM users
        WHERE singleton = 1 AND auth_generation = ?
        RETURNING auth_generation
      `, [
        input.id,
        input.tokenHash,
        input.deviceId,
        input.deviceName,
        input.createdAtMs,
        input.lastUsedAtMs,
        input.expiresAtMs,
        input.expectedAuthGeneration
      ])
      if (!rows[0]) return yield* Effect.fail(new AuthenticationChanged())
      return {
        id: input.id,
        tokenHash: input.tokenHash,
        authGeneration: integer(rows[0].auth_generation, "auth_generation"),
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        createdAtMs: input.createdAtMs,
        lastUsedAtMs: input.lastUsedAtMs,
        expiresAtMs: input.expiresAtMs
      }
    }))

  const lookupDashboardSession: RepositoriesService["lookupDashboardSession"] = (input) =>
    database("lookupDashboardSession", Effect.gen(function*() {
      const rows = yield* sql.unsafe<DashboardSessionRow>(`
        SELECT s.*, u.username, u.auth_generation AS current_auth_generation
        FROM dashboard_sessions s
        JOIN users u ON u.singleton = s.user_singleton
        WHERE s.token_hash = ?
        LIMIT 1
      `, [input.tokenHash])
      const row = rows[0]
      if (!row) return null
      const authGeneration = integer(row.auth_generation, "auth_generation")
      const currentAuthGeneration = integer(row.current_auth_generation, "current_auth_generation")
      const expiresAtMs = integer(row.expires_at_ms, "expires_at_ms")
      if (authGeneration !== currentAuthGeneration || expiresAtMs <= input.nowMs) return null
      let lastSeenAtMs = integer(row.last_seen_at_ms, "last_seen_at_ms")
      let nextExpiresAtMs = expiresAtMs
      if (input.nowMs - lastSeenAtMs >= input.refreshAfterMs) {
        const refreshed = yield* sql.unsafe<{ id: string }>(`
          UPDATE dashboard_sessions
          SET last_seen_at_ms = ?, expires_at_ms = ?
          WHERE id = ? AND auth_generation = ? AND expires_at_ms > ?
            AND auth_generation = (SELECT auth_generation FROM users WHERE singleton = 1)
          RETURNING id
        `, [
          input.nowMs,
          input.nowMs + input.idleMs,
          row.id,
          authGeneration,
          input.nowMs
        ])
        if (!refreshed[0]) return null
        lastSeenAtMs = input.nowMs
        nextExpiresAtMs = input.nowMs + input.idleMs
      }
      return {
        id: row.id,
        tokenHash: bytes(row.token_hash, "token_hash"),
        authGeneration,
        username: row.username,
        createdAtMs: integer(row.created_at_ms, "created_at_ms"),
        lastSeenAtMs,
        expiresAtMs: nextExpiresAtMs
      }
    }))

  const lookupEmbyToken: RepositoriesService["lookupEmbyToken"] = (input) =>
    database("lookupEmbyToken", Effect.gen(function*() {
      const rows = yield* sql.unsafe<EmbyTokenRow>(`
        SELECT t.*, u.username, u.auth_generation AS current_auth_generation
        FROM emby_tokens t
        JOIN users u ON u.singleton = t.user_singleton
        WHERE t.token_hash = ?
        LIMIT 1
      `, [input.tokenHash])
      const row = rows[0]
      if (!row) return null
      const authGeneration = integer(row.auth_generation, "auth_generation")
      if (
        authGeneration !== integer(row.current_auth_generation, "current_auth_generation") ||
        integer(row.expires_at_ms, "expires_at_ms") <= input.nowMs
      ) return null
      yield* sql.unsafe(
        "UPDATE emby_tokens SET last_used_at_ms = ? WHERE id = ? AND auth_generation = ?",
        [input.nowMs, row.id, authGeneration]
      )
      return {
        id: row.id,
        tokenHash: bytes(row.token_hash, "token_hash"),
        authGeneration,
        username: row.username,
        deviceId: row.device_id,
        deviceName: row.device_name,
        createdAtMs: integer(row.created_at_ms, "created_at_ms"),
        lastUsedAtMs: input.nowMs,
        expiresAtMs: integer(row.expires_at_ms, "expires_at_ms")
      }
    }))

  const deleteDashboardSession: RepositoriesService["deleteDashboardSession"] = (id, authGeneration) =>
    database("deleteDashboardSession", sql.unsafe(
      "DELETE FROM dashboard_sessions WHERE id = ? AND auth_generation = ?",
      [id, authGeneration]
    )).pipe(Effect.asVoid)

  const consumeAuthAttempt: RepositoriesService["consumeAuthAttempt"] = (input) =>
    database("consumeAuthAttempt", Effect.gen(function*() {
      const inserted = yield* sql.unsafe<AuthRateLimitRow>(`
        INSERT INTO auth_rate_limits (
          scope_key, window_started_at_ms, attempt_count, blocked_until_ms
        ) SELECT ?, ?, 1, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM auth_rate_limits
          WHERE scope_key = ? AND window_started_at_ms > ?
        )
        RETURNING window_started_at_ms, attempt_count, blocked_until_ms
      `, [input.scopeKey, input.nowMs, input.scopeKey, input.nowMs - input.windowMs])
      if (inserted[0]) return true
      const updated = yield* sql.unsafe<AuthRateLimitRow>(`
        UPDATE auth_rate_limits
        SET attempt_count = attempt_count + 1,
            blocked_until_ms = CASE
              WHEN attempt_count + 1 >= ? THEN ?
              ELSE blocked_until_ms
            END
        WHERE scope_key = ?
          AND window_started_at_ms = (
            SELECT MAX(window_started_at_ms) FROM auth_rate_limits WHERE scope_key = ?
          )
          AND window_started_at_ms > ?
          AND (blocked_until_ms IS NULL OR blocked_until_ms <= ?)
        RETURNING window_started_at_ms, attempt_count, blocked_until_ms
      `, [
        input.maxAttempts,
        input.nowMs + input.blockMs,
        input.scopeKey,
        input.scopeKey,
        input.nowMs - input.windowMs,
        input.nowMs
      ])
      return updated[0] !== undefined
    }))

  const clearAuthAttempts: RepositoriesService["clearAuthAttempts"] = (scopeKey) =>
    database(
      "clearAuthAttempts",
      sql.unsafe("DELETE FROM auth_rate_limits WHERE scope_key = ?", [scopeKey])
    ).pipe(Effect.asVoid)

  const revokeAuthentication: RepositoriesService["revokeAuthentication"] = (input) =>
    authDatabase("revokeAuthentication", Effect.gen(function*() {
      const result = yield* Effect.result(sql.batch([
        sql.unsafe(`
          UPDATE users
          SET password_hash = ?, password_salt = ?, pbkdf2_iterations = ?,
              auth_generation = auth_generation + 1, updated_at_ms = ?
          WHERE singleton = 1 AND auth_generation = ?
        `, [
          input.password.hash,
          input.password.salt,
          input.password.iterations,
          input.updatedAtMs,
          input.expectedAuthGeneration
        ]),
        sql.unsafe(`
          DELETE FROM dashboard_sessions
          WHERE EXISTS (
            SELECT 1 FROM users
            WHERE singleton = 1 AND auth_generation = ? AND updated_at_ms = ?
          )
        `, [input.expectedAuthGeneration + 1, input.updatedAtMs]),
        sql.unsafe(`
          DELETE FROM emby_tokens
          WHERE EXISTS (
            SELECT 1 FROM users
            WHERE singleton = 1 AND auth_generation = ? AND updated_at_ms = ?
          )
        `, [input.expectedAuthGeneration + 1, input.updatedAtMs]),
        sql.unsafe(`
          INSERT INTO schema_migrations(version, name, applied_at_ms)
          SELECT 1, 'd1-auth-revocation-fence', 0
          WHERE NOT EXISTS (
            SELECT 1 FROM users
            WHERE singleton = 1 AND auth_generation = ? AND updated_at_ms = ?
              AND password_hash = ? AND password_salt = ? AND pbkdf2_iterations = ?
          )
        `, [
          input.expectedAuthGeneration + 1,
          input.updatedAtMs,
          input.password.hash,
          input.password.salt,
          input.password.iterations
        ])
      ]))
      if (Result.isFailure(result)) {
        const users = yield* sql.unsafe<{ readonly auth_generation: unknown }>(
          "SELECT auth_generation FROM users WHERE singleton = 1"
        )
        if (
          users[0] === undefined ||
          integer(users[0].auth_generation, "auth_generation") !== input.expectedAuthGeneration
        ) return yield* Effect.fail(new AuthenticationChanged())
        return yield* Effect.fail(result.failure)
      }
    }))

  const listServers: RepositoriesService["listServers"] = () =>
    database("listServers", sql.unsafe<ServerRow>(
      "SELECT * FROM upstream_servers WHERE deleted_at_ms IS NULL ORDER BY id"
    )).pipe(
      Effect.flatMap((rows) => decode("listServers", () => rows.map(upstreamServer)))
    )

  const getServer: RepositoriesService["getServer"] = (id) =>
    database("getServer", sql.unsafe<ServerRow>(
      "SELECT * FROM upstream_servers WHERE id = ? AND deleted_at_ms IS NULL",
      [id]
    )).pipe(
      Effect.flatMap((rows) => decode("getServer", () => rows[0] === undefined ? null : upstreamServer(rows[0])))
    )

  const createServer: RepositoriesService["createServer"] = (input, limit) =>
    database("createServer", sql.unsafe<ServerRow>(`
      INSERT INTO upstream_servers (
        id, catalog_namespace, verified_catalog_id, verified_base_url, generation, name, base_url,
        username, password, access_token, access_token_expires_at_ms, upstream_user_id, user_agent,
        enabled, health, last_success_at_ms, deleted_at_ms, created_at_ms, updated_at_ms
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT count(*) FROM upstream_servers WHERE deleted_at_ms IS NULL) < ?
      RETURNING *
    `, [
      input.id,
      input.catalogNamespace,
      input.verifiedCatalogId,
      input.verifiedBaseUrl,
      input.generation,
      input.name,
      input.baseUrl,
      input.username,
      input.password,
      input.accessToken,
      input.accessTokenExpiresAtMs,
      input.upstreamUserId,
      input.userAgent,
      input.enabled ? 1 : 0,
      input.health,
      input.lastSuccessAtMs,
      input.deletedAtMs,
      input.createdAtMs,
      input.updatedAtMs,
      limit
    ])).pipe(
      Effect.flatMap((rows) => decode("createServer", () => rows[0] === undefined ? null : upstreamServer(rows[0])))
    )

  const saveServer: RepositoriesService["saveServer"] = (input) =>
    database("saveServer", sql.unsafe<ServerRow>(`
        INSERT INTO upstream_servers (
          id, catalog_namespace, verified_catalog_id, verified_base_url, generation, name, base_url,
          username, password, access_token, access_token_expires_at_ms, upstream_user_id, user_agent,
          enabled, health, last_success_at_ms, deleted_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          catalog_namespace = excluded.catalog_namespace,
          verified_catalog_id = excluded.verified_catalog_id,
          verified_base_url = excluded.verified_base_url,
          generation = excluded.generation,
          name = excluded.name,
          base_url = excluded.base_url,
          username = excluded.username,
          password = excluded.password,
          access_token = excluded.access_token,
          access_token_expires_at_ms = excluded.access_token_expires_at_ms,
          upstream_user_id = excluded.upstream_user_id,
          user_agent = excluded.user_agent,
          enabled = excluded.enabled,
          health = excluded.health,
          last_success_at_ms = excluded.last_success_at_ms,
          deleted_at_ms = excluded.deleted_at_ms,
          updated_at_ms = excluded.updated_at_ms
        RETURNING *
      `, [
        input.id,
        input.catalogNamespace,
        input.verifiedCatalogId,
        input.verifiedBaseUrl,
        input.generation,
        input.name,
        input.baseUrl,
        input.username,
        input.password,
        input.accessToken,
        input.accessTokenExpiresAtMs,
        input.upstreamUserId,
        input.userAgent,
        input.enabled ? 1 : 0,
        input.health,
        input.lastSuccessAtMs,
        input.deletedAtMs,
        input.createdAtMs,
        input.updatedAtMs
      ])).pipe(Effect.flatMap((rows) => decode("saveServer", () => upstreamServer(rows[0]!))))

  const saveServerResult: RepositoriesService["saveServerResult"] = (input) =>
    database("saveServerResult", sql.unsafe<ServerRow>(`
        UPDATE upstream_servers SET
          verified_catalog_id = CASE WHEN ? = 1 THEN ? ELSE verified_catalog_id END,
          verified_base_url = CASE WHEN ? = 1 THEN ? ELSE verified_base_url END,
          access_token = CASE WHEN ? = 1 THEN ? ELSE access_token END,
          access_token_expires_at_ms = CASE WHEN ? = 1 THEN ? ELSE access_token_expires_at_ms END,
          upstream_user_id = CASE WHEN ? = 1 THEN ? ELSE upstream_user_id END,
          health = CASE WHEN ? = 1 THEN ? ELSE health END,
          last_success_at_ms = CASE WHEN ? = 1 THEN ? ELSE last_success_at_ms END,
          updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND generation = ?
        RETURNING *
      `, [
        input.verifiedCatalogId === undefined ? 0 : 1,
        input.verifiedCatalogId ?? null,
        input.verifiedBaseUrl === undefined ? 0 : 1,
        input.verifiedBaseUrl ?? null,
        input.accessToken === undefined ? 0 : 1,
        input.accessToken ?? null,
        input.accessTokenExpiresAtMs === undefined ? 0 : 1,
        input.accessTokenExpiresAtMs ?? null,
        input.upstreamUserId === undefined ? 0 : 1,
        input.upstreamUserId ?? null,
        input.health === undefined ? 0 : 1,
        input.health ?? "unknown",
        input.lastSuccessAtMs === undefined ? 0 : 1,
        input.lastSuccessAtMs ?? null,
        input.updatedAtMs,
        input.serverId,
        input.expectedGeneration
      ])).pipe(Effect.flatMap((saved) => decode(
        "saveServerResult",
        () => saved[0] === undefined ? null : upstreamServer(saved[0])
      )))

  const saveServerConfiguration: RepositoriesService["saveServerConfiguration"] = (input, expectedGeneration) =>
    database("saveServerConfiguration", sql.unsafe<ServerRow>(`
        UPDATE upstream_servers SET
          verified_catalog_id = ?, verified_base_url = ?, generation = ?, name = ?, base_url = ?,
          username = ?, password = ?, access_token = ?, access_token_expires_at_ms = ?, upstream_user_id = ?, user_agent = ?,
          enabled = ?, health = ?, last_success_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND generation = ?
        RETURNING *
      `, [
        input.verifiedCatalogId,
        input.verifiedBaseUrl,
        input.generation,
        input.name,
        input.baseUrl,
        input.username,
        input.password,
        input.accessToken,
        input.accessTokenExpiresAtMs,
        input.upstreamUserId,
        input.userAgent,
        input.enabled ? 1 : 0,
        input.health,
        input.lastSuccessAtMs,
        input.updatedAtMs,
        input.id,
        expectedGeneration
      ])).pipe(Effect.flatMap((rows) => decode(
        "saveServerConfiguration",
        () => rows[0] === undefined ? null : upstreamServer(rows[0])
      )))

  const deleteServer: RepositoriesService["deleteServer"] = (id) =>
    database("deleteServer", sql.unsafe(`
      UPDATE upstream_servers SET
        enabled = 0, health = 'unknown', generation = generation + 1,
        access_token = NULL, access_token_expires_at_ms = NULL, upstream_user_id = NULL,
        deleted_at_ms = ?, updated_at_ms = ?
      WHERE id = ? AND deleted_at_ms IS NULL
    `, [Date.now(), Date.now(), id])).pipe(Effect.asVoid)

  interface LibraryRow {
    readonly id: string
    readonly name: string
    readonly media_type: unknown
    readonly enabled: unknown
    readonly created_at_ms: unknown
    readonly updated_at_ms: unknown
    readonly server_id: string | null
    readonly source_library_id: string | null
    readonly source_library_name: string | null
    readonly source_media_type: unknown | null
    readonly source_order: unknown | null
    readonly source_enabled: unknown | null
  }

  const listVirtualLibraries: RepositoriesService["listVirtualLibraries"] = () =>
    database("listVirtualLibraries", sql.unsafe<LibraryRow>(`
      SELECT
        vl.*,
        ls.server_id,
        ls.source_library_id,
        ls.source_library_name,
        ls.media_type AS source_media_type,
        ls.source_order,
        ls.enabled AS source_enabled
      FROM virtual_libraries vl
      LEFT JOIN library_sources ls ON ls.virtual_library_id = vl.id
      ORDER BY vl.id, ls.source_order, ls.server_id, ls.source_library_id
    `)).pipe(Effect.flatMap((rows) => decode("listVirtualLibraries", () => {
      const libraries = new Map<string, VirtualLibrary & { sources: Array<LibrarySource> }>()
      for (const row of rows) {
        let library = libraries.get(row.id)
        if (!library) {
          library = {
            id: decodeVirtualLibraryId(row.id),
            name: row.name,
            mediaType: mediaType(row.media_type),
            enabled: boolean(row.enabled, "enabled"),
            createdAtMs: integer(row.created_at_ms, "created_at_ms"),
            updatedAtMs: integer(row.updated_at_ms, "updated_at_ms"),
            sources: []
          }
          libraries.set(row.id, library)
        }
        if (row.server_id !== null && row.source_library_id !== null && row.source_library_name !== null) {
          library.sources.push({
            serverId: decodeServerId(row.server_id),
            sourceLibraryId: decodeSourceLibraryId(row.source_library_id),
            sourceLibraryName: row.source_library_name,
            mediaType: mediaType(row.source_media_type),
            sourceOrder: integer(row.source_order, "source_order"),
            enabled: boolean(row.source_enabled, "source_enabled")
          })
        }
      }
      return Array.from(libraries.values())
    })))

  const saveVirtualLibrary: RepositoriesService["saveVirtualLibrary"] = (input, serverFences) => {
    if (serverFences.length === 0) return Effect.succeed(null)
    return database("saveVirtualLibrary", Effect.gen(function*() {
      const eligibility = serverFences.map(() => `EXISTS(
        SELECT 1 FROM upstream_servers us
        WHERE us.id = ? AND us.generation = ? AND us.enabled = 1
          AND us.deleted_at_ms IS NULL AND us.health = 'healthy'
          AND us.verified_base_url IS NOT NULL
      )`).join(" AND ")
      const fences = serverFences.flatMap((fence) => [fence.serverId, fence.generation])
      yield* sql.batch([
        sql.unsafe(`
          INSERT INTO virtual_libraries (
            id, name, media_type, enabled, created_at_ms, updated_at_ms
          ) SELECT ?, ?, ?, ?, ?, ?
          WHERE ${eligibility}
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            media_type = excluded.media_type,
            enabled = excluded.enabled,
            updated_at_ms = excluded.updated_at_ms
        `, [
          input.id,
          input.name,
          input.mediaType,
          input.enabled ? 1 : 0,
          input.createdAtMs,
          input.updatedAtMs,
          ...fences
        ]),
        sql.unsafe(`
          DELETE FROM library_sources
          WHERE virtual_library_id = ?
            AND EXISTS (
              SELECT 1 FROM virtual_libraries
              WHERE id = ? AND updated_at_ms = ?
            )
            AND ${eligibility}
        `, [input.id, input.id, input.updatedAtMs, ...fences]),
        ...input.sources.map((source) => sql.unsafe(`
          INSERT INTO library_sources (
            virtual_library_id, server_id, source_library_id, source_library_name,
            media_type, source_order, enabled
          ) SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM virtual_libraries
            WHERE id = ? AND updated_at_ms = ?
          ) AND ${eligibility}
        `, [
          input.id,
          source.serverId,
          source.sourceLibraryId,
          source.sourceLibraryName,
          source.mediaType,
          source.sourceOrder,
          source.enabled ? 1 : 0,
          input.id,
          input.updatedAtMs,
          ...fences
        ]))
      ])
      const saved = yield* sql.unsafe<{ readonly id: string }>(`
        SELECT id FROM virtual_libraries
        WHERE id = ? AND updated_at_ms = ? AND ${eligibility}
      `, [input.id, input.updatedAtMs, ...fences])
      return saved[0] === undefined ? null : input
    }))
  }

  const deleteVirtualLibrary: RepositoriesService["deleteVirtualLibrary"] = (id) =>
    database("deleteVirtualLibrary", sql.unsafe("DELETE FROM virtual_libraries WHERE id = ?", [id])).pipe(
      Effect.asVoid
    )

  const isSourceEligible: RepositoriesService["isSourceEligible"] = (serverId, sourceLibraryId) =>
    database("isSourceEligible", sql.unsafe<{ readonly eligible: unknown }>(`
      SELECT EXISTS(
        SELECT 1
        FROM library_sources ls
        JOIN virtual_libraries vl ON vl.id = ls.virtual_library_id
        JOIN upstream_servers us ON us.id = ls.server_id
        WHERE ls.server_id = ? AND ls.source_library_id = ?
          AND vl.enabled = 1 AND ls.enabled = 1 AND us.enabled = 1
          AND us.deleted_at_ms IS NULL
          AND us.health = 'healthy'
          AND (us.verified_catalog_id IS NOT NULL OR us.verified_base_url IS NOT NULL)
      ) AS eligible
    `, [serverId, sourceLibraryId])).pipe(
      Effect.flatMap((rows) => decode("isSourceEligible", () => boolean(rows[0]?.eligible, "eligible")))
    )

  interface EligibleSourceRow {
    readonly virtual_library_id: string
    readonly server_id: string
    readonly server_name: string
    readonly source_library_id: string
    readonly source_library_name: string
    readonly media_type: unknown
    readonly source_order: unknown
    readonly source_enabled: unknown
    readonly catalog_namespace: string
    readonly verified_catalog_id: string
    readonly generation: unknown
    readonly base_url: string
    readonly username: string
    readonly password: string | null
    readonly access_token: string | null
    readonly access_token_expires_at_ms: unknown | null
    readonly user_agent: string
  }

  const eligibleSource = (row: EligibleSourceRow): EligibleSource => ({
    virtualLibraryId: decodeVirtualLibraryId(row.virtual_library_id),
    serverId: decodeServerId(row.server_id),
    name: row.server_name,
    sourceLibraryId: decodeSourceLibraryId(row.source_library_id),
    sourceLibraryName: row.source_library_name,
    mediaType: mediaType(row.media_type),
    sourceOrder: integer(row.source_order, "source_order"),
    enabled: boolean(row.source_enabled, "source_enabled"),
    catalogNamespace: row.catalog_namespace,
    verifiedCatalogId: row.verified_catalog_id ?? row.catalog_namespace,
    serverGeneration: integer(row.generation, "generation"),
    baseUrl: row.base_url as EligibleSource["baseUrl"],
    username: row.username,
    password: row.password,
    accessToken: row.access_token,
    accessTokenExpiresAtMs: row.access_token_expires_at_ms === null
      ? null
      : integer(row.access_token_expires_at_ms, "access_token_expires_at_ms"),
    userAgent: row.user_agent
  })

  const resolveEligibleSources: RepositoriesService["resolveEligibleSources"] = (libraryId) =>
    database("resolveEligibleSources", sql.unsafe<EligibleSourceRow>(`
      SELECT
        ls.virtual_library_id,
        ls.server_id,
        us.name AS server_name,
        ls.source_library_id,
        ls.source_library_name,
        ls.media_type,
        ls.source_order,
        ls.enabled AS source_enabled,
        us.catalog_namespace,
        us.verified_catalog_id,
        us.generation,
        us.base_url,
        us.username,
        us.password,
        us.access_token,
        us.access_token_expires_at_ms,
        us.user_agent
      FROM library_sources ls
      JOIN virtual_libraries vl ON vl.id = ls.virtual_library_id
      JOIN upstream_servers us ON us.id = ls.server_id
      WHERE ls.virtual_library_id = ?
        AND vl.enabled = 1
        AND ls.enabled = 1
        AND us.enabled = 1
        AND us.deleted_at_ms IS NULL
        AND us.health = 'healthy'
        AND (us.verified_catalog_id IS NOT NULL OR us.verified_base_url IS NOT NULL)
      ORDER BY ls.source_order, ls.server_id, ls.source_library_id
    `, [libraryId])).pipe(Effect.flatMap((rows) => decode(
      "resolveEligibleSources",
      () => rows.map(eligibleSource)
    )))

  const resolveCanonicalIdInTransaction = (id: string) => Effect.gen(function*() {
    const rows = yield* sql.unsafe<{ readonly canonical_id: string }>(`
      SELECT id AS canonical_id FROM canonical_items WHERE id = ?
      UNION ALL
      SELECT canonical_id FROM canonical_aliases
      WHERE alias_id = ? AND NOT EXISTS (SELECT 1 FROM canonical_items WHERE id = ?)
      LIMIT 1
    `, [id, id, id])
    return rows[0]?.canonical_id ?? null
  })

  const lookupCanonicalId: RepositoriesService["lookupCanonicalId"] = (id) =>
    database("lookupCanonicalId", resolveCanonicalIdInTransaction(id))

  const assertIdentityFence = (candidate: PreparedIdentityCandidate, lock: boolean) => Effect.gen(function*() {
    const rows = lock
      ? yield* sql.unsafe<{ readonly id: string }>(`
          UPDATE upstream_servers
          SET updated_at_ms = updated_at_ms
          WHERE id = ? AND catalog_namespace = ? AND verified_catalog_id = ?
            AND generation = ? AND deleted_at_ms IS NULL
          RETURNING id
        `, [
          candidate.serverId,
          candidate.catalogNamespace,
          candidate.verifiedCatalogId,
          candidate.serverGeneration
        ])
      : yield* sql.unsafe<{ readonly id: string }>(`
          SELECT id FROM upstream_servers
          WHERE id = ? AND catalog_namespace = ? AND verified_catalog_id = ?
            AND generation = ? AND deleted_at_ms IS NULL
        `, [
          candidate.serverId,
          candidate.catalogNamespace,
          candidate.verifiedCatalogId,
          candidate.serverGeneration
        ])
    if (!rows[0]) {
      return yield* Effect.fail(new IdentityConflict({ message: "server-generation-changed" }))
    }
  })

  const eligibleTargetConditions = `
    server.generation = item.server_generation
    AND server.enabled = 1
    AND server.deleted_at_ms IS NULL
    AND (server.verified_catalog_id IS NOT NULL OR server.verified_base_url IS NOT NULL)
    AND binding.enabled = 1
    AND library.enabled = 1
  `
  const eligibleTargetSql = `item.canonical_id = ? AND ${eligibleTargetConditions}`

  const outboxPayload = (state: UserStateRecord): DesiredUserState => ({
    played: state.played,
    favorite: state.favorite,
    playCount: state.playCount,
    positionTicks: state.positionTicks,
    lastPlayedVersionId: state.lastPlayedVersionId
  })

  const upsertOutboxTarget = (
    target: {
      readonly id: string
      readonly server_id: string
      readonly server_generation: number
    },
    state: UserStateRecord,
    nowMs: number
  ) => sql.unsafe(`
    INSERT INTO state_outbox (
      target_id, canonical_id, source_item_id, server_id, server_generation,
      desired_revision, delivered_revision, payload_json, attempt_count,
      next_attempt_at_ms, lease_owner, lease_expires_at_ms, dispatched_at_ms,
      uncertain_since_ms, permanent_failure_code, last_failure_code,
      last_failure_at_ms, eligible, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?)
    ON CONFLICT(target_id) DO UPDATE SET
      canonical_id = excluded.canonical_id,
      source_item_id = excluded.source_item_id,
      server_id = excluded.server_id,
      server_generation = excluded.server_generation,
      attempt_count = CASE
        WHEN state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json THEN 0
        ELSE state_outbox.attempt_count
      END,
      next_attempt_at_ms = CASE
        WHEN state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json
          OR state_outbox.eligible = 0
          THEN excluded.next_attempt_at_ms
        ELSE state_outbox.next_attempt_at_ms
      END,
      lease_owner = CASE
        WHEN state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json THEN NULL
        ELSE state_outbox.lease_owner
      END,
      lease_expires_at_ms = CASE
        WHEN state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json THEN NULL
        ELSE state_outbox.lease_expires_at_ms
      END,
      dispatched_at_ms = CASE
        WHEN state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json THEN NULL
        ELSE state_outbox.dispatched_at_ms
      END,
      uncertain_since_ms = CASE
        WHEN (
          state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json
        ) AND state_outbox.dispatched_at_ms IS NOT NULL
          AND state_outbox.lease_owner IS NOT NULL
          THEN COALESCE(state_outbox.uncertain_since_ms, excluded.updated_at_ms)
        ELSE state_outbox.uncertain_since_ms
      END,
      permanent_failure_code = CASE
        WHEN state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json THEN NULL
        ELSE state_outbox.permanent_failure_code
      END,
      last_failure_code = CASE
        WHEN (
          state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json
        ) AND state_outbox.dispatched_at_ms IS NOT NULL
          AND state_outbox.lease_owner IS NOT NULL
          THEN 'superseded_after_dispatch'
        WHEN state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json THEN NULL
        ELSE state_outbox.last_failure_code
      END,
      last_failure_at_ms = CASE
        WHEN (
          state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json
        ) AND state_outbox.dispatched_at_ms IS NOT NULL
          AND state_outbox.lease_owner IS NOT NULL
          THEN excluded.updated_at_ms
        WHEN state_outbox.desired_revision <> excluded.desired_revision
          OR state_outbox.canonical_id <> excluded.canonical_id
          OR state_outbox.server_generation <> excluded.server_generation
          OR state_outbox.payload_json <> excluded.payload_json THEN NULL
        ELSE state_outbox.last_failure_at_ms
      END,
      desired_revision = excluded.desired_revision,
      payload_json = excluded.payload_json,
      eligible = 1,
      updated_at_ms = excluded.updated_at_ms
  `, [
    target.id,
    state.canonicalId,
    target.id,
    target.server_id,
    target.server_generation,
    state.revision,
    canonicalJson(outboxPayload(state)),
    nowMs,
    nowMs
  ])


  const resolveIdentityD1: RepositoriesService["resolveIdentity"] = (candidate) =>
    identityDatabase("resolveIdentity", Effect.gen(function*() {
      yield* assertIdentityFence(candidate, false)

      type MatchClaim = { readonly namespace: string; readonly value: string }
      let matchClaims: ReadonlyArray<MatchClaim> = candidate.claims
      let proposedCanonicalId = candidate.proposedCanonicalId
      let identityState = candidate.claims.length > 0 ? "exact" : "source-exclusive"
      let quarantineReason = candidate.sourceExclusiveReason

      if (candidate.fallback !== null) {
        const parentId = yield* resolveCanonicalIdInTransaction(candidate.fallback.canonicalSeriesId)
        const parent = parentId === null ? [] : yield* sql.unsafe<{ readonly id: string }>(
          "SELECT id FROM canonical_items WHERE id = ? AND item_type = 'Series'",
          [parentId]
        )
        if (parent[0]) {
          const namespace = `fallback:${candidate.fallback.kind}`
          const value = JSON.stringify(candidate.fallback.kind === "season"
            ? [parent[0].id, candidate.fallback.seasonNumber]
            : [parent[0].id, candidate.fallback.seasonNumber, candidate.fallback.episodeNumber])
          matchClaims = [{ namespace, value }]
          proposedCanonicalId = yield* Effect.promise(() => stableCanonicalId([namespace, value]))
          identityState = "fallback"
          quarantineReason = null
        } else {
          matchClaims = []
          proposedCanonicalId = null
          identityState = "source-exclusive"
          quarantineReason = "parent-unresolved"
        }
      }

      const existingRows = yield* sql.unsafe<SourceItemRow>(`
        SELECT * FROM source_items
        WHERE catalog_namespace = ? AND upstream_item_id = ? AND item_type = ?
        LIMIT 1
      `, [candidate.catalogNamespace, candidate.upstreamItemId, candidate.itemType])
      const existing = existingRows[0]
      const sourceItemId = existing?.id ?? candidate.sourceItemId

      const candidateIds = new Set<string>()
      if (existing?.canonical_id) candidateIds.add(existing.canonical_id)
      if (proposedCanonicalId !== null) {
        const proposedTarget = yield* resolveCanonicalIdInTransaction(proposedCanonicalId)
        if (proposedTarget !== null) candidateIds.add(proposedTarget)
      }
      if (matchClaims.length > 0) {
        const predicate = matchClaims.map(() => "(ic.namespace = ? AND ic.value = ?)").join(" OR ")
        const matched = yield* sql.unsafe<{ readonly canonical_id: string }>(`
          SELECT DISTINCT ic.canonical_id
          FROM identity_claims ic
          JOIN canonical_items ci ON ci.id = ic.canonical_id
          WHERE ic.state = 'exact' AND ci.item_type = ? AND (${predicate})
        `, [candidate.itemType, ...matchClaims.flatMap(({ namespace, value }) => [namespace, value])])
        for (const row of matched) candidateIds.add(row.canonical_id)
      }

      const ids = [...candidateIds]
      const canonicalRows = ids.length === 0 ? [] : yield* sql.unsafe<CanonicalRow>(`
        SELECT * FROM canonical_items
        WHERE id IN (${ids.map(() => "?").join(", ")}) AND item_type = ?
        ORDER BY created_at_ms, id
      `, [...ids, candidate.itemType])
      const clusterClaims = canonicalRows.length === 0 ? [] : yield* sql.unsafe<IdentityClaimRow>(`
        SELECT * FROM identity_claims
        WHERE canonical_id IN (${canonicalRows.map(() => "?").join(", ")})
        ORDER BY created_at_ms, canonical_id, namespace
      `, canonicalRows.map(({ id }) => id))

      const stateRank = { "source-exclusive": 0, fallback: 1, exact: 2 } as const
      const retainedIdentityState = [
        identityState,
        ...canonicalRows.map(({ identity_state }) => identity_state),
        ...(clusterClaims.some(({ namespace, state }) => state === "exact" && providerNamespaces.has(namespace))
          ? ["exact"]
          : clusterClaims.some(({ namespace, state }) => state === "exact" && namespace.startsWith("fallback:"))
            ? ["fallback"]
            : [])
      ].reduce((retained, state) =>
        (stateRank[state as keyof typeof stateRank] ?? -1) > (stateRank[retained as keyof typeof stateRank] ?? -1)
          ? state
          : retained
      )

      let incompatible = false
      const candidateSet = toClaimSet(candidate.claims)
      for (const row of canonicalRows) {
        if (!clustersCompatible(
          candidateSet,
          toClaimSet(externalClaims(clusterClaims.filter((entry) => entry.canonical_id === row.id)))
        )) incompatible = true
      }
      const values = new Map<string, string>()
      for (const entry of [
        ...clusterClaims.filter(({ state }) => state === "exact").map(({ namespace, value }) => ({ namespace, value })),
        ...matchClaims
      ]) {
        const current = values.get(entry.namespace)
        if (current !== undefined && current !== entry.value) incompatible = true
        values.set(entry.namespace, entry.value)
      }

      let survivorId: string
      let reason = quarantineReason
      if (incompatible) {
        survivorId = existing?.canonical_id ?? candidate.sourceExclusiveCanonicalId
        const target = yield* resolveCanonicalIdInTransaction(survivorId)
        if (target !== null) survivorId = target
        reason = "ambiguous-identity"
      } else if (canonicalRows[0]) {
        survivorId = canonicalRows[0].id
      } else {
        survivorId = proposedCanonicalId ?? candidate.sourceExclusiveCanonicalId
        const target = yield* resolveCanonicalIdInTransaction(survivorId)
        if (target !== null) survivorId = target
      }
      const retiredIds = incompatible
        ? []
        : canonicalRows.map(({ id }) => id).filter((id) => id !== survivorId)
      const writes: Array<Statement<unknown>> = []

      writes.push(sql.unsafe(`
        INSERT OR IGNORE INTO canonical_items (
          id, item_type, identity_state, display_metadata_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        survivorId,
        candidate.itemType,
        incompatible ? "source-exclusive" : identityState,
        canonicalJson(candidate.displayMetadata),
        candidate.observedAtMs,
        candidate.observedAtMs
      ]))
      writes.push(sql.unsafe(`
        INSERT INTO source_items (
          id, server_id, catalog_namespace, server_generation, source_library_id,
          upstream_item_id, item_type, canonical_id, quarantine_reason, created_at_ms,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          server_generation = excluded.server_generation,
          source_library_id = excluded.source_library_id,
          canonical_id = excluded.canonical_id,
          quarantine_reason = excluded.quarantine_reason,
          updated_at_ms = excluded.updated_at_ms
      `, [
        sourceItemId,
        candidate.serverId,
        candidate.catalogNamespace,
        candidate.serverGeneration,
        candidate.sourceLibraryId,
        candidate.upstreamItemId,
        candidate.itemType,
        survivorId,
        reason,
        existing === undefined ? candidate.observedAtMs : integer(existing.created_at_ms, "created_at_ms"),
        candidate.observedAtMs
      ]))

      if (retiredIds.length > 0) {
        const retired = retiredIds.map(() => "?").join(", ")
        const cluster = [survivorId, ...retiredIds]
        writes.push(sql.unsafe(`
          DELETE FROM query_generation_items AS retired_item
          WHERE retired_item.canonical_id IN (${retired})
            AND EXISTS (
              SELECT 1 FROM query_generation_items AS preferred
              WHERE preferred.generation_id = retired_item.generation_id
                AND (preferred.canonical_id = ? OR (
                  preferred.canonical_id IN (${retired}) AND preferred.ordinal < retired_item.ordinal
                ))
            )
        `, [...retiredIds, survivorId, ...retiredIds]))
        writes.push(sql.unsafe(
          `UPDATE query_generation_items SET canonical_id = ? WHERE canonical_id IN (${retired})`,
          [survivorId, ...retiredIds]
        ))
        writes.push(sql.unsafe(
          `UPDATE source_items SET canonical_id = ? WHERE canonical_id IN (${retired})`,
          [survivorId, ...retiredIds]
        ))
        writes.push(sql.unsafe(
          `UPDATE state_outbox SET canonical_id = ? WHERE canonical_id IN (${retired})`,
          [survivorId, ...retiredIds]
        ))
        writes.push(sql.unsafe(`
          INSERT INTO playback_watermarks (canonical_id, started_at_ms, session_id)
          SELECT ?, started_at_ms, session_id
          FROM playback_watermarks
          WHERE canonical_id IN (${cluster.map(() => "?").join(", ")})
          ORDER BY started_at_ms DESC, session_id DESC
          LIMIT 1
          ON CONFLICT(canonical_id) DO UPDATE SET
            started_at_ms = excluded.started_at_ms,
            session_id = excluded.session_id
        `, [survivorId, ...cluster]))
        writes.push(sql.unsafe(
          `DELETE FROM playback_watermarks WHERE canonical_id IN (${retired})`,
          retiredIds
        ))
        writes.push(sql.unsafe(
          `UPDATE playback_sessions SET canonical_id = ? WHERE canonical_id IN (${retired})`,
          [survivorId, ...retiredIds]
        ))
        writes.push(sql.unsafe(`
          INSERT INTO user_state (
            canonical_id, revision, played, favorite, play_count, position_ticks,
            last_played_version_id, updated_at_ms
          )
          SELECT ?, revision, played, favorite, play_count, position_ticks,
            last_played_version_id, updated_at_ms
          FROM user_state
          WHERE canonical_id IN (${cluster.map(() => "?").join(", ")})
          ORDER BY revision DESC, updated_at_ms DESC, canonical_id
          LIMIT 1
          ON CONFLICT(canonical_id) DO UPDATE SET
            revision = excluded.revision,
            played = excluded.played,
            favorite = excluded.favorite,
            play_count = excluded.play_count,
            position_ticks = excluded.position_ticks,
            last_played_version_id = excluded.last_played_version_id,
            updated_at_ms = excluded.updated_at_ms
          WHERE excluded.revision > user_state.revision
             OR (excluded.revision = user_state.revision AND excluded.updated_at_ms > user_state.updated_at_ms)
        `, [survivorId, ...cluster]))
        writes.push(sql.unsafe(
          `DELETE FROM user_state WHERE canonical_id IN (${retired})`,
          retiredIds
        ))
        for (const row of clusterClaims.filter(({ canonical_id, state }) =>
          state === "exact" && retiredIds.includes(canonical_id)
        )) {
          writes.push(sql.unsafe(`
            INSERT OR IGNORE INTO identity_claims (
              canonical_id, namespace, value, state, source_item_id, created_at_ms
            ) VALUES (?, ?, ?, 'exact', ?, ?)
          `, [survivorId, row.namespace, row.value, row.source_item_id, row.created_at_ms]))
        }
        writes.push(sql.unsafe(
          `DELETE FROM identity_claims WHERE canonical_id IN (${retired})`,
          retiredIds
        ))
        writes.push(sql.unsafe(
          `UPDATE canonical_aliases SET canonical_id = ? WHERE canonical_id IN (${retired})`,
          [survivorId, ...retiredIds]
        ))
        for (const retiredId of retiredIds) {
          writes.push(sql.unsafe(`
            INSERT INTO canonical_aliases (alias_id, canonical_id, retired_at_ms)
            VALUES (?, ?, ?)
            ON CONFLICT(alias_id) DO UPDATE SET
              canonical_id = excluded.canonical_id,
              retired_at_ms = excluded.retired_at_ms
          `, [retiredId, survivorId, candidate.observedAtMs]))
        }
        writes.push(sql.unsafe(`DELETE FROM canonical_items WHERE id IN (${retired})`, retiredIds))
      }

      if (incompatible) {
        if (existing?.canonical_id === null || existing === undefined) {
          for (const entry of candidate.claims) {
            writes.push(sql.unsafe(`
              INSERT INTO identity_claims (
                canonical_id, namespace, value, state, source_item_id, created_at_ms
              ) VALUES (?, ?, ?, 'quarantined', ?, ?)
              ON CONFLICT(canonical_id, namespace) DO UPDATE SET
                value = excluded.value,
                state = excluded.state,
                source_item_id = excluded.source_item_id
            `, [survivorId, entry.namespace, entry.value, sourceItemId, candidate.observedAtMs]))
          }
        }
      } else {
        writes.push(sql.unsafe(
          "DELETE FROM identity_claims WHERE canonical_id = ? AND state <> 'exact'",
          [survivorId]
        ))
        for (const entry of matchClaims) {
          writes.push(sql.unsafe(`
            INSERT INTO identity_claims (
              canonical_id, namespace, value, state, source_item_id, created_at_ms
            ) VALUES (?, ?, ?, 'exact', ?, ?)
            ON CONFLICT(canonical_id, namespace) DO UPDATE SET
              value = excluded.value,
              state = excluded.state,
              source_item_id = excluded.source_item_id
          `, [survivorId, entry.namespace, entry.value, sourceItemId, candidate.observedAtMs]))
        }
        if (proposedCanonicalId !== null && proposedCanonicalId !== survivorId) {
          writes.push(sql.unsafe(`
            INSERT INTO canonical_aliases (alias_id, canonical_id, retired_at_ms)
            VALUES (?, ?, ?)
            ON CONFLICT(alias_id) DO UPDATE SET canonical_id = excluded.canonical_id
          `, [proposedCanonicalId, survivorId, candidate.observedAtMs]))
        }
      }

      writes.push(sql.unsafe(`
        UPDATE canonical_items
        SET identity_state = ?, updated_at_ms = ?
        WHERE id = ?
      `, [incompatible ? "source-exclusive" : retainedIdentityState, candidate.observedAtMs, survivorId]))
      for (const version of candidate.mediaVersions) {
        writes.push(sql.unsafe(`
          INSERT INTO source_media_versions (
            id, source_item_id, server_generation, upstream_media_source_id,
            label, capabilities_json, streams_json, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_item_id = excluded.source_item_id,
            server_generation = excluded.server_generation,
            label = excluded.label,
            capabilities_json = excluded.capabilities_json,
            streams_json = excluded.streams_json,
            updated_at_ms = excluded.updated_at_ms
        `, [
          version.id,
          sourceItemId,
          candidate.serverGeneration,
          version.upstreamMediaSourceId,
          version.label,
          canonicalJson(version.capabilities),
          canonicalJson(version.streams),
          candidate.observedAtMs
        ]))
      }

      writes.push(sql.unsafe(`
        UPDATE state_outbox
        SET eligible = 0, lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE canonical_id = ? AND eligible = 1 AND NOT EXISTS (
          SELECT 1
          FROM source_items item
          JOIN upstream_servers server ON server.id = item.server_id
          JOIN library_sources binding
            ON binding.server_id = item.server_id
            AND binding.source_library_id = item.source_library_id
          JOIN virtual_libraries library ON library.id = binding.virtual_library_id
          WHERE item.id = state_outbox.source_item_id AND ${eligibleTargetSql}
        )
      `, [candidate.observedAtMs, survivorId, survivorId]))
      writes.push(sql.unsafe(`
        INSERT INTO state_outbox (
          target_id, canonical_id, source_item_id, server_id, server_generation,
          desired_revision, delivered_revision, payload_json, attempt_count,
          next_attempt_at_ms, lease_owner, lease_expires_at_ms, dispatched_at_ms,
          uncertain_since_ms, permanent_failure_code, last_failure_code,
          last_failure_at_ms, eligible, updated_at_ms
        )
        SELECT item.id, state.canonical_id, item.id, item.server_id, item.server_generation,
          state.revision, 0,
          json_object(
            'played', json(CASE WHEN state.played = 1 THEN 'true' ELSE 'false' END),
            'favorite', json(CASE WHEN state.favorite = 1 THEN 'true' ELSE 'false' END),
            'playCount', state.play_count,
            'positionTicks', state.position_ticks,
            'lastPlayedVersionId', CASE
              WHEN state.last_played_version_id IS NULL THEN json('null')
              ELSE state.last_played_version_id
            END
          ),
          0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?
        FROM user_state state
        JOIN source_items item ON item.canonical_id = state.canonical_id
        JOIN upstream_servers server ON server.id = item.server_id
        JOIN library_sources binding
          ON binding.server_id = item.server_id
          AND binding.source_library_id = item.source_library_id
        JOIN virtual_libraries library ON library.id = binding.virtual_library_id
        WHERE state.canonical_id = ? AND ${eligibleTargetConditions}
        ON CONFLICT(target_id) DO UPDATE SET
          canonical_id = excluded.canonical_id,
          source_item_id = excluded.source_item_id,
          server_id = excluded.server_id,
          server_generation = excluded.server_generation,
          desired_revision = excluded.desired_revision,
          payload_json = excluded.payload_json,
          attempt_count = CASE
            WHEN state_outbox.desired_revision <> excluded.desired_revision THEN 0
            ELSE state_outbox.attempt_count
          END,
          next_attempt_at_ms = CASE
            WHEN state_outbox.desired_revision <> excluded.desired_revision OR state_outbox.eligible = 0
              THEN excluded.next_attempt_at_ms
            ELSE state_outbox.next_attempt_at_ms
          END,
          lease_owner = CASE WHEN state_outbox.desired_revision <> excluded.desired_revision THEN NULL ELSE state_outbox.lease_owner END,
          lease_expires_at_ms = CASE WHEN state_outbox.desired_revision <> excluded.desired_revision THEN NULL ELSE state_outbox.lease_expires_at_ms END,
          dispatched_at_ms = CASE WHEN state_outbox.desired_revision <> excluded.desired_revision THEN NULL ELSE state_outbox.dispatched_at_ms END,
          permanent_failure_code = CASE WHEN state_outbox.desired_revision <> excluded.desired_revision THEN NULL ELSE state_outbox.permanent_failure_code END,
          eligible = 1,
          updated_at_ms = excluded.updated_at_ms
      `, [candidate.observedAtMs, candidate.observedAtMs, survivorId]))
      writes.push(sql.unsafe(`
        INSERT INTO schema_migrations(version, name, applied_at_ms)
        SELECT 1, 'd1-identity-fence', 0
        WHERE NOT EXISTS (
          SELECT 1 FROM upstream_servers
          WHERE id = ? AND catalog_namespace = ? AND verified_catalog_id = ?
            AND generation = ? AND deleted_at_ms IS NULL
        )
      `, [
        candidate.serverId,
        candidate.catalogNamespace,
        candidate.verifiedCatalogId,
        candidate.serverGeneration
      ]))

      const batchResult = yield* Effect.result(sql.batch(writes))
      if (Result.isFailure(batchResult)) {
        const fenceResult = yield* Effect.result(assertIdentityFence(candidate, false))
        return yield* Effect.fail(
          Result.isFailure(fenceResult) && fenceResult.failure instanceof IdentityConflict
            ? fenceResult.failure
            : batchResult.failure
        )
      }

      const canonicals = yield* sql.unsafe<CanonicalRow>("SELECT * FROM canonical_items WHERE id = ?", [survivorId])
      const sources = yield* sql.unsafe<SourceItemRow>("SELECT * FROM source_items WHERE id = ?", [sourceItemId])
      const claims = yield* sql.unsafe<IdentityClaimRow>(
        "SELECT * FROM identity_claims WHERE canonical_id = ? ORDER BY namespace",
        [survivorId]
      )
      const aliases = yield* sql.unsafe<{
        readonly alias_id: string
        readonly canonical_id: string
        readonly retired_at_ms: unknown
      }>("SELECT * FROM canonical_aliases WHERE canonical_id = ? ORDER BY alias_id", [survivorId])
      const versions = yield* sql.unsafe<MediaVersionRow>(
        "SELECT * FROM source_media_versions WHERE source_item_id = ? ORDER BY id",
        [sourceItemId]
      )
      return yield* decode("resolveIdentity", (): IdentityResolution => ({
        canonical: canonicalItem(canonicals[0]!),
        aliases: aliases.map((row): CanonicalAlias => ({
          aliasId: row.alias_id,
          canonicalId: row.canonical_id,
          retiredAtMs: integer(row.retired_at_ms, "retired_at_ms")
        })),
        claims: claims.map(identityClaim),
        sourceItem: sourceItem(sources[0]!),
        mediaVersions: versions.map(mediaVersion)
      }))
    }))

  const persistIdentityResult: RepositoriesService["persistIdentityResult"] = (result) =>
    database("persistIdentityResult", Effect.gen(function*() {
      const canonical = result.canonical
      const source = result.sourceItem
      const stateRows = yield* sql.unsafe<UserStateRow>(
        "SELECT * FROM user_state WHERE canonical_id = ?",
        [canonical.id]
      )
      const state = stateRows[0] ? userState(stateRows[0]) : null
      const targets = state === null ? [] : [...yield* readEligibleStateTargets(canonical.id)]
      if (state !== null && !targets.some(({ id }) => id === source.id)) {
        const eligible = yield* sql.unsafe<{ readonly eligible: unknown }>(`
          SELECT EXISTS(
            SELECT 1
            FROM upstream_servers server
            JOIN library_sources binding ON binding.server_id = server.id
            JOIN virtual_libraries library ON library.id = binding.virtual_library_id
            WHERE server.id = ? AND server.generation = ?
              AND binding.source_library_id = ?
              AND server.enabled = 1 AND server.deleted_at_ms IS NULL
              AND (server.verified_catalog_id IS NOT NULL OR server.verified_base_url IS NOT NULL)
              AND binding.enabled = 1 AND library.enabled = 1
          ) AS eligible
        `, [source.serverId, source.serverGeneration, source.sourceLibraryId])
        if (eligible[0] && boolean(eligible[0].eligible, "eligible")) {
          targets.push({
            id: source.id,
            server_id: source.serverId,
            server_generation: source.serverGeneration
          })
        }
      }
      const writes: Array<Statement<unknown>> = [sql.unsafe(`
        INSERT INTO canonical_items (
          id, item_type, identity_state, display_metadata_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          item_type = excluded.item_type,
          identity_state = excluded.identity_state,
          display_metadata_json = excluded.display_metadata_json,
          updated_at_ms = excluded.updated_at_ms
      `, [
        canonical.id,
        canonical.itemType,
        canonical.identityState,
        canonicalJson(canonical.displayMetadata),
        canonical.createdAtMs,
        canonical.updatedAtMs
      ]), sql.unsafe(`
        INSERT INTO source_items (
          id, server_id, catalog_namespace, server_generation, source_library_id,
          upstream_item_id, item_type, canonical_id, quarantine_reason, created_at_ms,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          server_generation = excluded.server_generation,
          source_library_id = excluded.source_library_id,
          canonical_id = excluded.canonical_id,
          quarantine_reason = excluded.quarantine_reason,
          updated_at_ms = excluded.updated_at_ms
      `, [
        source.id,
        source.serverId,
        source.catalogNamespace,
        source.serverGeneration,
        source.sourceLibraryId,
        source.upstreamItemId,
        source.itemType,
        source.canonicalId,
        source.quarantineReason,
        source.createdAtMs,
        source.updatedAtMs
      ])]
      for (const alias of result.aliases) {
        writes.push(sql.unsafe(`
          INSERT INTO canonical_aliases (alias_id, canonical_id, retired_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(alias_id) DO UPDATE SET
            canonical_id = excluded.canonical_id,
            retired_at_ms = excluded.retired_at_ms
        `, [alias.aliasId, alias.canonicalId, alias.retiredAtMs]))
      }
      for (const claim of result.claims) {
        writes.push(sql.unsafe(`
          INSERT INTO identity_claims (
            canonical_id, namespace, value, state, source_item_id, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(canonical_id, namespace) DO UPDATE SET
            value = excluded.value,
            state = excluded.state,
            source_item_id = excluded.source_item_id
        `, [canonical.id, claim.namespace, claim.value, claim.state, claim.sourceItemId, claim.createdAtMs]))
      }
      for (const version of result.mediaVersions) {
        writes.push(sql.unsafe(`
          INSERT INTO source_media_versions (
            id, source_item_id, server_generation, upstream_media_source_id,
            label, capabilities_json, streams_json, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            server_generation = excluded.server_generation,
            label = excluded.label,
            capabilities_json = excluded.capabilities_json,
            streams_json = excluded.streams_json,
            updated_at_ms = excluded.updated_at_ms
        `, [
          version.id,
          version.sourceItemId,
          version.serverGeneration,
          version.upstreamMediaSourceId,
          version.label,
          canonicalJson(version.capabilities),
          canonicalJson(version.streams),
          version.updatedAtMs
        ]))
      }
      if (state !== null) {
        writes.push(sql.unsafe(`
          INSERT INTO schema_migrations(version, name, applied_at_ms)
          SELECT 1, 'd1-identity-state-fence', 0
          WHERE NOT EXISTS (
            SELECT 1 FROM user_state
            WHERE canonical_id = ? AND revision = ? AND updated_at_ms = ?
          )
        `, [state.canonicalId, state.revision, state.updatedAtMs]))
        writes.push(sql.unsafe(`
          UPDATE state_outbox
          SET eligible = 0, lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
          WHERE canonical_id = ? AND eligible = 1 AND NOT EXISTS (
            SELECT 1
            FROM source_items item
            JOIN upstream_servers server ON server.id = item.server_id
            JOIN library_sources binding
              ON binding.server_id = item.server_id
              AND binding.source_library_id = item.source_library_id
            JOIN virtual_libraries library ON library.id = binding.virtual_library_id
            WHERE item.id = state_outbox.source_item_id AND ${eligibleTargetSql}
          )
        `, [canonical.updatedAtMs, canonical.id, canonical.id]))
        for (const target of targets) {
          writes.push(upsertOutboxTarget(target, state, canonical.updatedAtMs))
        }
      }
      yield* sql.batch(writes)
      return canonical
    }))

  interface QueryGenerationRow {
    readonly id: string
    readonly query_key: string
    readonly revision: unknown
    readonly user_key: string
    readonly device_id: string
    readonly virtual_library_id: string
    readonly normalized_query_json: unknown
    readonly source_state_json: unknown
    readonly all_sources_exhausted: unknown
    readonly state_dependent: unknown
    readonly created_at_ms: unknown
    readonly expires_at_ms: unknown
  }

  const queryGeneration = (row: QueryGenerationRow): QueryGeneration => ({
    id: row.id,
    queryKey: row.query_key,
    revision: integer(row.revision, "revision"),
    userKey: row.user_key,
    deviceId: row.device_id,
    virtualLibraryId: row.virtual_library_id,
    normalizedQuery: json(row.normalized_query_json, "normalized_query_json"),
    sourceState: json(row.source_state_json, "source_state_json"),
    allSourcesExhausted: boolean(row.all_sources_exhausted, "all_sources_exhausted"),
    stateDependent: boolean(row.state_dependent, "state_dependent"),
    createdAtMs: integer(row.created_at_ms, "created_at_ms"),
    expiresAtMs: integer(row.expires_at_ms, "expires_at_ms")
  })

  const readQueryGeneration: RepositoriesService["readQueryGeneration"] = (key) =>
    database("readQueryGeneration", sql.unsafe<QueryGenerationRow>(
      "SELECT * FROM query_generations WHERE query_key = ?",
      [key]
    )).pipe(Effect.flatMap((rows) =>
      decode("readQueryGeneration", () => rows[0] ? queryGeneration(rows[0]) : null)
    ))

  interface QueryGenerationItemRow {
    readonly ordinal: unknown
    readonly canonical_id: string
    readonly sort_values_json: unknown
  }

  const readQueryGenerationItems: RepositoriesService["readQueryGenerationItems"] = (generationId) =>
    database("readQueryGenerationItems", sql.unsafe<QueryGenerationItemRow>(`
      SELECT ordinal, canonical_id, sort_values_json
      FROM query_generation_items
      WHERE generation_id = ?
      ORDER BY ordinal
    `, [generationId])).pipe(Effect.flatMap((rows) => decode("readQueryGenerationItems", () => rows.map((row) => ({
      ordinal: integer(row.ordinal, "ordinal"),
      canonicalId: row.canonical_id,
      sortValues: json(row.sort_values_json, "sort_values_json")
    })))))

  const appendQueryGenerationItems: RepositoriesService["appendQueryGenerationItems"] = (input) => {
    if (input.items.length > DB_BATCH_SIZE) {
      return Effect.fail(new RepositoryError({
        operation: "appendQueryGenerationItems",
        message: `at most ${DB_BATCH_SIZE} items may be appended atomically`
      }))
    }
    const requiredRevision = input.expected?.id === input.generation.id
      ? input.expected.revision + 1
      : 0
    if (input.generation.revision !== requiredRevision) {
      return Effect.fail(new RepositoryError({
        operation: "appendQueryGenerationItems",
        message: `generation revision must be ${requiredRevision}`
      }))
    }
    return database("appendQueryGenerationItems", Effect.gen(function*() {
      const generation = input.generation
      const current = yield* sql.unsafe<QueryGenerationRow>(
        "SELECT * FROM query_generations WHERE query_key = ?",
        [generation.queryKey]
      )
      const matchesExpected = input.expected === null
        ? current.length === 0
        : current[0]?.id === input.expected.id && integer(current[0].revision, "revision") === input.expected.revision
      if (!matchesExpected) return false

      const assertExpected = input.expected === null
        ? sql.unsafe(`
            INSERT INTO schema_migrations(version, name, applied_at_ms)
            SELECT 1, 'd1-query-cas', 0
            WHERE EXISTS (SELECT 1 FROM query_generations WHERE query_key = ?)
          `, [generation.queryKey])
        : sql.unsafe(`
            INSERT INTO schema_migrations(version, name, applied_at_ms)
            SELECT 1, 'd1-query-cas', 0
            WHERE NOT EXISTS (
              SELECT 1 FROM query_generations
              WHERE query_key = ? AND id = ? AND revision = ?
            )
          `, [generation.queryKey, input.expected.id, input.expected.revision])

      const insert = sql.unsafe(`
        INSERT INTO query_generations (
          id, query_key, revision, user_key, device_id, virtual_library_id,
          normalized_query_json, source_state_json, all_sources_exhausted,
          state_dependent, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        generation.id,
        generation.queryKey,
        generation.revision,
        generation.userKey,
        generation.deviceId,
        generation.virtualLibraryId,
        canonicalJson(generation.normalizedQuery),
        canonicalJson(generation.sourceState),
        generation.allSourcesExhausted ? 1 : 0,
        generation.stateDependent ? 1 : 0,
        generation.createdAtMs,
        generation.expiresAtMs
      ])
      const mutate = input.expected === null
        ? [insert]
        : input.expected.id === generation.id
          ? [sql.unsafe(`
              UPDATE query_generations
              SET revision = ?, normalized_query_json = ?, source_state_json = ?,
                  all_sources_exhausted = ?, state_dependent = ?, expires_at_ms = ?
              WHERE query_key = ? AND id = ? AND revision = ?
            `, [
              generation.revision,
              canonicalJson(generation.normalizedQuery),
              canonicalJson(generation.sourceState),
              generation.allSourcesExhausted ? 1 : 0,
              generation.stateDependent ? 1 : 0,
              generation.expiresAtMs,
              generation.queryKey,
              input.expected.id,
              input.expected.revision
            ])]
          : [
              sql.unsafe(
                "DELETE FROM query_generations WHERE query_key = ? AND id = ? AND revision = ?",
                [generation.queryKey, input.expected.id, input.expected.revision]
              ),
              insert
            ]

      const batch = sql.batch([
        assertExpected,
        ...mutate,
        ...input.items.map((item) => sql.unsafe(`
          INSERT INTO query_generation_items (
            generation_id, ordinal, canonical_id, sort_values_json
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(generation_id, canonical_id) DO NOTHING
        `, [generation.id, item.ordinal, item.canonicalId, canonicalJson(item.sortValues)])),
        sql.unsafe(`
          INSERT INTO schema_migrations(version, name, applied_at_ms)
          SELECT 1, 'd1-query-commit', 0
          WHERE NOT EXISTS (
            SELECT 1 FROM query_generations
            WHERE query_key = ? AND id = ? AND revision = ?
          )
        `, [generation.queryKey, generation.id, generation.revision])
      ])
      return yield* batch.pipe(Effect.as(true), Effect.catch((cause) =>
        sql.unsafe<QueryGenerationRow>(
          "SELECT * FROM query_generations WHERE query_key = ?",
          [generation.queryKey]
        ).pipe(Effect.flatMap((latest) => {
          const stillExpected = input.expected === null
            ? latest.length === 0
            : latest[0]?.id === input.expected.id &&
              integer(latest[0].revision, "revision") === input.expected.revision
          return stillExpected ? Effect.fail(cause) : Effect.succeed(false)
        }))
      ))
    }))
  }

  interface MetadataProjectionRow {
    readonly source_item_id: string
    readonly projection_key: string
    readonly payload_json: unknown
    readonly fresh_until_ms: unknown
    readonly stale_until_ms: unknown
    readonly updated_at_ms: unknown
  }

  const metadataProjection = (row: MetadataProjectionRow): MetadataProjection => ({
    sourceItemId: row.source_item_id,
    projectionKey: row.projection_key,
    payload: json(row.payload_json, "payload_json"),
    freshUntilMs: integer(row.fresh_until_ms, "fresh_until_ms"),
    staleUntilMs: integer(row.stale_until_ms, "stale_until_ms"),
    updatedAtMs: integer(row.updated_at_ms, "updated_at_ms")
  })

  const readMetadataProjection: RepositoriesService["readMetadataProjection"] = (sourceItemId, projectionKey) =>
    database("readMetadataProjection", sql.unsafe<MetadataProjectionRow>(`
      SELECT * FROM source_metadata_cache
      WHERE source_item_id = ? AND projection_key = ?
    `, [sourceItemId, projectionKey])).pipe(Effect.flatMap((rows) => decode(
      "readMetadataProjection",
      () => rows[0] ? metadataProjection(rows[0]) : null
    )))

  const writeMetadataProjection: RepositoriesService["writeMetadataProjection"] = (input) =>
    database("writeMetadataProjection", sql.unsafe(`
      INSERT INTO source_metadata_cache (
        source_item_id, projection_key, payload_json,
        fresh_until_ms, stale_until_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_item_id, projection_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        fresh_until_ms = excluded.fresh_until_ms,
        stale_until_ms = excluded.stale_until_ms,
        updated_at_ms = excluded.updated_at_ms
    `, [
      input.sourceItemId,
      input.projectionKey,
      canonicalJson(input.payload),
      input.freshUntilMs,
      input.staleUntilMs,
      input.updatedAtMs
    ])).pipe(Effect.asVoid)

  const suppressDetailProjections: RepositoriesService["suppressDetailProjections"] = (
    input: DetailProjectionSuppression
  ) => database("suppressDetailProjections", sql.unsafe(`
    UPDATE source_metadata_cache
    SET payload_json = ?, fresh_until_ms = ?, stale_until_ms = ?, updated_at_ms = ?
    WHERE projection_key = 'detail'
      AND source_item_id IN (
        SELECT id FROM source_items
        WHERE canonical_id = ?
          AND server_id = ?
          AND server_generation = ?
          AND source_library_id = ?
      )
  `, [
    canonicalJson({ suppressed: true }),
    input.observedAtMs,
    input.observedAtMs,
    input.observedAtMs,
    input.canonicalId,
    input.serverId,
    input.serverGeneration,
    input.sourceLibraryId
  ])).pipe(Effect.asVoid)

  const mergeCanonicalMetadata: RepositoriesService["mergeCanonicalMetadata"] = (
    canonicalId,
    sourceItemId,
    metadata,
    updatedAtMs
  ) => {
    const attempt = (remaining: number): Effect.Effect<void, RepositoryError> => database(
      "mergeCanonicalMetadata",
      Effect.gen(function*() {
        const rows = yield* sql.unsafe<CanonicalRow>(
          "SELECT * FROM canonical_items WHERE id = ?",
          [canonicalId]
        )
        if (!rows[0]) return
        const primary = yield* sql.unsafe<{ readonly id: string }>(`
          SELECT item.id
          FROM source_items item
          WHERE item.canonical_id = ?
          ORDER BY COALESCE((
            SELECT MIN(binding.source_order)
            FROM library_sources binding
            JOIN virtual_libraries library ON library.id = binding.virtual_library_id
            JOIN upstream_servers server ON server.id = binding.server_id
            WHERE binding.server_id = item.server_id
              AND binding.source_library_id = item.source_library_id
              AND binding.enabled = 1 AND library.enabled = 1
              AND server.enabled = 1 AND server.deleted_at_ms IS NULL
              AND server.generation = item.server_generation
          ), 2147483647), item.server_id, item.upstream_item_id, item.id
          LIMIT 1
        `, [canonicalId])
        const encodedCurrent = String(rows[0].display_metadata_json)
        const current = json(encodedCurrent, "display_metadata_json")
        const merged = primary[0]?.id === sourceItemId
          ? mergeProjectionJson(current, metadata)
          : mergeMissingJson(current, metadata)
        const updated = yield* sql.unsafe<{ readonly id: string }>(`
          UPDATE canonical_items
          SET display_metadata_json = ?, updated_at_ms = MAX(updated_at_ms, ?)
          WHERE id = ? AND display_metadata_json = ?
          RETURNING id
        `, [canonicalJson(merged), updatedAtMs, canonicalId, encodedCurrent])
        if (updated[0]) return
        if (remaining === 0) {
          return yield* Effect.fail(failure(
            "mergeCanonicalMetadata",
            "metadata changed during every compare-and-swap attempt"
          ))
        }
        return yield* attempt(remaining - 1)
      })
    )
    return attempt(8)
  }

  const readCatalogItems: RepositoriesService["readCatalogItems"] = (canonicalIds, usableAtMs) => {
    const ids = [...new Set(canonicalIds)].slice(0, DB_BATCH_SIZE)
    if (ids.length === 0) return Effect.succeed([])
    const placeholders = ids.map(() => "?").join(", ")
    return database("readCatalogItems", Effect.gen(function*() {
      const canonicals = yield* sql.unsafe<CanonicalRow>(`
        SELECT * FROM canonical_items WHERE id IN (${placeholders})
      `, ids)
      const claims = yield* sql.unsafe<IdentityClaimRow>(`
        SELECT * FROM identity_claims
        WHERE canonical_id IN (${placeholders}) AND state = 'exact'
        ORDER BY canonical_id, namespace
      `, ids)
      const sources = yield* sql.unsafe<SourceItemRow>(`
        SELECT * FROM source_items
        WHERE canonical_id IN (${placeholders})
        ORDER BY canonical_id, server_id, upstream_item_id
      `, ids)
      const versions = yield* sql.unsafe<MediaVersionRow & { readonly canonical_id: string }>(`
        SELECT version.*, item.canonical_id
        FROM source_media_versions version
        JOIN source_items item ON item.id = version.source_item_id
        WHERE item.canonical_id IN (${placeholders})
          AND version.server_generation = item.server_generation
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM source_metadata_cache cache
            JOIN json_each(cache.payload_json, '$.MediaSources') detail_version
            WHERE cache.source_item_id = item.id
              AND cache.projection_key = 'detail'
              AND cache.stale_until_ms > ?
              AND json_extract(detail_version.value, '$.Id') = version.upstream_media_source_id
          ))
          AND EXISTS (
            SELECT 1
            FROM upstream_servers server
            JOIN library_sources binding
              ON binding.server_id = item.server_id
              AND binding.source_library_id = item.source_library_id
            JOIN virtual_libraries library ON library.id = binding.virtual_library_id
            WHERE server.id = item.server_id
              AND server.generation = item.server_generation
              AND server.enabled = 1 AND server.deleted_at_ms IS NULL
              AND binding.enabled = 1 AND library.enabled = 1
          )
        ORDER BY COALESCE((
          SELECT MIN(binding.source_order)
          FROM library_sources binding
          JOIN virtual_libraries library ON library.id = binding.virtual_library_id
          WHERE binding.server_id = item.server_id
            AND binding.source_library_id = item.source_library_id
            AND binding.enabled = 1 AND library.enabled = 1
        ), 2147483647), item.server_id, item.upstream_item_id, version.upstream_media_source_id
      `, [...ids, usableAtMs ?? null, usableAtMs ?? null])
      const states = yield* sql.unsafe<UserStateRow>(`
        SELECT * FROM user_state WHERE canonical_id IN (${placeholders})
      `, ids)
      return yield* decode("readCatalogItems", () => {
        const byId = new Map(canonicals.map((row) => [row.id, row]))
        return canonicalIds.flatMap((id): ReadonlyArray<CatalogItemRecord> => {
          const row = byId.get(id)
          if (!row) return []
          const state = states.find((candidate) => candidate.canonical_id === id)
          return [{
            canonical: canonicalItem(row),
            claims: claims.filter((candidate) => candidate.canonical_id === id).map(identityClaim),
            sourceItems: sources.filter((candidate) => candidate.canonical_id === id).map(sourceItem),
            mediaVersions: versions.filter((candidate) => candidate.canonical_id === id).map(mediaVersion),
            userState: state ? userState(state) : null
          }]
        })
      })
    }))
  }

  const resolveEligibleSourcesForCanonical: RepositoriesService["resolveEligibleSourcesForCanonical"] = (canonicalId) =>
    database("resolveEligibleSourcesForCanonical", sql.unsafe<EligibleSourceRow>(`
      SELECT DISTINCT
        target.virtual_library_id,
        target.server_id,
        server.name AS server_name,
        target.source_library_id,
        target.source_library_name,
        target.media_type,
        target.source_order,
        target.enabled AS source_enabled,
        server.catalog_namespace,
        server.verified_catalog_id,
        server.generation,
        server.base_url,
        server.username,
        server.password,
        server.access_token,
        server.access_token_expires_at_ms,
        server.user_agent
      FROM source_items item
      JOIN library_sources origin
        ON origin.server_id = item.server_id
        AND origin.source_library_id = item.source_library_id
      JOIN virtual_libraries library ON library.id = origin.virtual_library_id
      JOIN library_sources target ON target.virtual_library_id = library.id
      JOIN upstream_servers server ON server.id = target.server_id
      WHERE item.canonical_id = ?
        AND library.enabled = 1 AND origin.enabled = 1 AND target.enabled = 1
        AND server.enabled = 1 AND server.deleted_at_ms IS NULL
        AND server.health = 'healthy'
        AND (server.verified_catalog_id IS NOT NULL OR server.verified_base_url IS NOT NULL)
      ORDER BY target.source_order, target.server_id, target.source_library_id
    `, [canonicalId])).pipe(Effect.flatMap((rows) => decode(
      "resolveEligibleSourcesForCanonical",
      () => rows.map(eligibleSource)
    )))

  const listStateMemberCanonicalIds: RepositoriesService["listStateMemberCanonicalIds"] = (input) => {
    const predicates = ["binding.virtual_library_id = ?"]
    const parameters: Array<string | number> = [input.virtualLibraryId]
    if (input.favorite !== undefined) {
      predicates.push("state.favorite = ?")
      parameters.push(input.favorite ? 1 : 0)
    }
    if (input.resume !== undefined) {
      predicates.push(input.resume ? "state.position_ticks > 0 AND state.played = 0" : "state.position_ticks = 0")
    }
    if (input.played !== undefined) {
      predicates.push("state.played = ?")
      parameters.push(input.played ? 1 : 0)
    }
    parameters.push(Math.max(0, Math.min(2_000, input.limit)))
    return database("listStateMemberCanonicalIds", sql.unsafe<{ readonly canonical_id: string }>(`
      SELECT DISTINCT state.canonical_id
      FROM user_state state
      JOIN source_items item ON item.canonical_id = state.canonical_id
      JOIN library_sources binding
        ON binding.server_id = item.server_id
        AND binding.source_library_id = item.source_library_id
      JOIN virtual_libraries library ON library.id = binding.virtual_library_id
      JOIN upstream_servers server ON server.id = item.server_id
      WHERE ${predicates.join(" AND ")}
        AND binding.enabled = 1 AND library.enabled = 1
        AND server.enabled = 1 AND server.deleted_at_ms IS NULL
      ORDER BY state.canonical_id
      LIMIT ?
    `, parameters)).pipe(Effect.map((rows) => rows.map(({ canonical_id }) => canonical_id)))
  }

  const invalidateStateDependentQueryGenerations: RepositoriesService["invalidateStateDependentQueryGenerations"] = () =>
    database(
      "invalidateStateDependentQueryGenerations",
      sql.unsafe("DELETE FROM query_generations WHERE state_dependent = 1")
    ).pipe(Effect.asVoid)

  type EligibleStateTarget = {
    readonly id: string
    readonly server_id: string
    readonly server_generation: number
  }

  const readEligibleStateTargets = (canonicalId: string) => sql.unsafe<EligibleStateTarget>(`
    SELECT DISTINCT item.id, item.server_id, item.server_generation
    FROM source_items item
    JOIN upstream_servers server ON server.id = item.server_id
    JOIN library_sources binding
      ON binding.server_id = item.server_id
      AND binding.source_library_id = item.source_library_id
    JOIN virtual_libraries library ON library.id = binding.virtual_library_id
    WHERE ${eligibleTargetSql}
    ORDER BY item.id
  `, [canonicalId])

  const stateBatchStatements = (
    state: UserStateRecord,
    previousRevision: number,
    targets: ReadonlyArray<EligibleStateTarget>
  ) => [
    sql.unsafe(`
      INSERT INTO user_state (
        canonical_id, revision, played, favorite, play_count, position_ticks,
        last_played_version_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_id) DO UPDATE SET
        revision = excluded.revision,
        played = excluded.played,
        favorite = excluded.favorite,
        play_count = excluded.play_count,
        position_ticks = excluded.position_ticks,
        last_played_version_id = excluded.last_played_version_id,
        updated_at_ms = excluded.updated_at_ms
      WHERE user_state.revision = ?
    `, [
      state.canonicalId,
      state.revision,
      state.played ? 1 : 0,
      state.favorite ? 1 : 0,
      state.playCount,
      state.positionTicks,
      state.lastPlayedVersionId,
      state.updatedAtMs,
      previousRevision
    ]),
    sql.unsafe(`
      UPDATE state_outbox
      SET eligible = 0, lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE canonical_id = ? AND eligible = 1 AND NOT EXISTS (
        SELECT 1
        FROM source_items item
        JOIN upstream_servers server ON server.id = item.server_id
        JOIN library_sources binding
          ON binding.server_id = item.server_id
          AND binding.source_library_id = item.source_library_id
        JOIN virtual_libraries library ON library.id = binding.virtual_library_id
        WHERE item.id = state_outbox.source_item_id AND ${eligibleTargetSql}
      )
    `, [state.updatedAtMs, state.canonicalId, state.canonicalId]),
    ...targets.map((target) => upsertOutboxTarget(target, state, state.updatedAtMs)),
    sql.unsafe(`
      INSERT INTO schema_migrations(version, name, applied_at_ms)
      SELECT 1, 'd1-state-assertion', 0
      WHERE NOT EXISTS (
        SELECT 1 FROM user_state
        WHERE canonical_id = ? AND revision = ? AND played = ? AND favorite = ?
          AND play_count = ? AND position_ticks = ?
          AND last_played_version_id IS ? AND updated_at_ms = ?
      )
    `, [
      state.canonicalId,
      state.revision,
      state.played ? 1 : 0,
      state.favorite ? 1 : 0,
      state.playCount,
      state.positionTicks,
      state.lastPlayedVersionId,
      state.updatedAtMs
    ])
  ] as const

  const writeUserStateAndTargets: RepositoriesService["writeUserStateAndTargets"] = (input) =>
    database("writeUserStateAndTargets", Effect.gen(function*() {
      const previousRows = yield* sql.unsafe<UserStateRow>(
        "SELECT * FROM user_state WHERE canonical_id = ?",
        [input.canonicalId]
      )
      const previous = previousRows[0] ? userState(previousRows[0]) : null
      const state: UserStateRecord = {
        canonicalId: input.canonicalId,
        revision: (previous?.revision ?? 0) + 1,
        played: input.patch.played ?? previous?.played ?? false,
        favorite: input.patch.favorite ?? previous?.favorite ?? false,
        playCount: input.patch.playCount ?? previous?.playCount ?? 0,
        positionTicks: input.patch.positionTicks ?? previous?.positionTicks ?? 0,
        lastPlayedVersionId: "lastPlayedVersionId" in input.patch
          ? input.patch.lastPlayedVersionId ?? null
          : previous?.lastPlayedVersionId ?? null,
        updatedAtMs: input.updatedAtMs
      }
      if (
        !Number.isSafeInteger(state.updatedAtMs) ||
        !Number.isSafeInteger(state.playCount) || state.playCount < 0 ||
        !Number.isSafeInteger(state.positionTicks) || state.positionTicks < 0 ||
        typeof state.played !== "boolean" || typeof state.favorite !== "boolean" ||
        (state.lastPlayedVersionId !== null && typeof state.lastPlayedVersionId !== "string")
      ) return yield* Effect.fail(failure("writeUserStateAndTargets", "invalid desired user state"))

      const targets = yield* readEligibleStateTargets(state.canonicalId)
      yield* sql.batch(stateBatchStatements(state, previous?.revision ?? 0, targets))
      return state
    }))

  interface PlaybackSessionRow {
    readonly id: string
    readonly canonical_id: string
    readonly version_id: string
    readonly started_at_ms: unknown
    readonly last_event_at_ms: unknown
    readonly last_position_ticks: unknown
    readonly stop_applied: unknown
    readonly state_revision: unknown
  }

  interface PlaybackWatermarkRow {
    readonly started_at_ms: unknown
    readonly session_id: string
  }

  const recordPlaybackEventAndTargets: RepositoriesService["recordPlaybackEventAndTargets"] = (input) =>
    database("recordPlaybackEventAndTargets", Effect.gen(function*() {
      if (
        input.localSessionId.length === 0 || input.canonicalId.length === 0 || input.versionId.length === 0 ||
        !Number.isSafeInteger(input.positionTicks) || input.positionTicks < 0 ||
        !Number.isSafeInteger(input.occurredAtMs)
      ) return yield* Effect.fail(failure("recordPlaybackEventAndTargets", "invalid playback event"))

      const sessions = yield* sql.unsafe<PlaybackSessionRow>(
        "SELECT * FROM playback_sessions WHERE id = ?",
        [input.localSessionId]
      )
      const session = sessions[0]

      if (input.kind === "start") {
        const watermarks = yield* sql.unsafe<PlaybackWatermarkRow>(
          "SELECT started_at_ms, session_id FROM playback_watermarks WHERE canonical_id = ?",
          [input.canonicalId]
        )
        const watermark = watermarks[0]
        const watermarkStartedAtMs = watermark
          ? integer(watermark.started_at_ms, "started_at_ms")
          : null
        const staleWatermark = watermark !== undefined && watermarkStartedAtMs !== null && (
          watermarkStartedAtMs > input.occurredAtMs ||
          (watermarkStartedAtMs === input.occurredAtMs && watermark.session_id >= input.localSessionId)
        )
        if (
          session ||
          staleWatermark
        ) return null
        const previousRows = yield* sql.unsafe<UserStateRow>(
          "SELECT * FROM user_state WHERE canonical_id = ?",
          [input.canonicalId]
        )
        const previous = previousRows[0] ? userState(previousRows[0]) : null
        const state: UserStateRecord = {
          canonicalId: input.canonicalId,
          revision: (previous?.revision ?? 0) + 1,
          played: false,
          favorite: previous?.favorite ?? false,
          playCount: previous?.playCount ?? 0,
          positionTicks: input.positionTicks,
          lastPlayedVersionId: input.versionId,
          updatedAtMs: input.occurredAtMs
        }
        const targets = yield* readEligibleStateTargets(state.canonicalId)
        yield* sql.batch([
          sql.unsafe(`
            INSERT INTO schema_migrations(version, name, applied_at_ms)
            SELECT 1, 'd1-playback-start-cas', 0
            WHERE EXISTS (SELECT 1 FROM playback_sessions WHERE id = ?)
               OR EXISTS (
                 SELECT 1 FROM playback_watermarks
                 WHERE canonical_id = ? AND (
                   started_at_ms > ? OR (started_at_ms = ? AND session_id >= ?)
                 )
               )
          `, [
            input.localSessionId,
            input.canonicalId,
            input.occurredAtMs,
            input.occurredAtMs,
            input.localSessionId
          ]),
          ...stateBatchStatements(state, previous?.revision ?? 0, targets),
          sql.unsafe(`
            INSERT INTO playback_sessions (
              id, canonical_id, version_id, started_at_ms, last_event_at_ms,
              last_position_ticks, stop_applied, state_revision
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
          `, [
            input.localSessionId,
            input.canonicalId,
            input.versionId,
            input.occurredAtMs,
            input.occurredAtMs,
            input.positionTicks,
            state.revision
          ]),
          sql.unsafe(`
            INSERT INTO playback_watermarks (canonical_id, started_at_ms, session_id)
            VALUES (?, ?, ?)
            ON CONFLICT(canonical_id) DO UPDATE SET
              started_at_ms = excluded.started_at_ms,
              session_id = excluded.session_id
            WHERE playback_watermarks.started_at_ms < excluded.started_at_ms
               OR (playback_watermarks.started_at_ms = excluded.started_at_ms
                 AND playback_watermarks.session_id < excluded.session_id)
          `, [input.canonicalId, input.occurredAtMs, input.localSessionId]),
          sql.unsafe(`
            INSERT INTO schema_migrations(version, name, applied_at_ms)
            SELECT 1, 'd1-playback-start-commit', 0
            WHERE NOT EXISTS (
              SELECT 1 FROM playback_sessions
              WHERE id = ? AND canonical_id = ? AND state_revision = ?
            )
          `, [input.localSessionId, input.canonicalId, state.revision])
        ])
        return state
      }

      const latestRows = yield* sql.unsafe<PlaybackSessionRow>(`
        SELECT * FROM playback_sessions
        WHERE canonical_id = ?
        ORDER BY started_at_ms DESC, id DESC
        LIMIT 1
      `, [input.canonicalId])
      const latest = latestRows[0]
      if (
        !session || session.canonical_id !== input.canonicalId ||
        (latest && latest.id !== session.id) ||
        boolean(session.stop_applied, "stop_applied") ||
        input.occurredAtMs < integer(session.last_event_at_ms, "last_event_at_ms")
      ) return null

      const currentRows = yield* sql.unsafe<UserStateRow>(
        "SELECT * FROM user_state WHERE canonical_id = ?",
        [input.canonicalId]
      )
      const current = currentRows[0] ? userState(currentRows[0]) : null
      const played = input.kind === "stop" ? input.played : false
      const state: UserStateRecord = {
        canonicalId: input.canonicalId,
        revision: (current?.revision ?? 0) + 1,
        played,
        favorite: current?.favorite ?? false,
        playCount: (current?.playCount ?? 0) + (input.kind === "stop" && played ? 1 : 0),
        positionTicks: played ? 0 : input.positionTicks,
        lastPlayedVersionId: input.versionId,
        updatedAtMs: input.occurredAtMs
      }
      const targets = yield* readEligibleStateTargets(state.canonicalId)
      yield* sql.batch([
        sql.unsafe(`
          INSERT INTO schema_migrations(version, name, applied_at_ms)
          SELECT 1, 'd1-playback-event-cas', 0
          WHERE NOT EXISTS (
            SELECT 1 FROM playback_sessions session
            WHERE session.id = ? AND session.canonical_id = ? AND session.version_id = ?
              AND session.stop_applied = 0 AND session.last_event_at_ms <= ?
              AND NOT EXISTS (
                SELECT 1 FROM playback_sessions latest
                WHERE latest.canonical_id = session.canonical_id
                  AND (latest.started_at_ms > session.started_at_ms
                    OR (latest.started_at_ms = session.started_at_ms AND latest.id > session.id))
              )
          )
        `, [input.localSessionId, input.canonicalId, input.versionId, input.occurredAtMs]),
        ...stateBatchStatements(state, current?.revision ?? 0, targets),
        sql.unsafe(`
          UPDATE playback_sessions
          SET last_event_at_ms = ?, last_position_ticks = ?, stop_applied = ?, state_revision = ?
          WHERE id = ? AND canonical_id = ? AND version_id = ?
            AND stop_applied = 0 AND last_event_at_ms <= ?
        `, [
          input.occurredAtMs,
          input.positionTicks,
          input.kind === "stop" ? 1 : 0,
          state.revision,
          input.localSessionId,
          input.canonicalId,
          input.versionId,
          input.occurredAtMs
        ]),
        sql.unsafe(`
          INSERT INTO schema_migrations(version, name, applied_at_ms)
          SELECT 1, 'd1-playback-event-commit', 0
          WHERE NOT EXISTS (
            SELECT 1 FROM playback_sessions
            WHERE id = ? AND state_revision = ? AND last_event_at_ms = ?
          )
        `, [input.localSessionId, state.revision, input.occurredAtMs])
      ])
      return state
    }))

  interface OutboxRow {
    readonly target_id: string
    readonly canonical_id: string
    readonly source_item_id: string
    readonly upstream_item_id: string
    readonly upstream_user_id: string
    readonly server_id: string
    readonly server_generation: unknown
    readonly desired_revision: unknown
    readonly payload_json: unknown
    readonly attempt_count: unknown
    readonly lease_owner: string
    readonly lease_expires_at_ms: unknown
  }

  const outboxClaim = (row: OutboxRow): OutboxClaim => ({
    targetId: row.target_id,
    canonicalId: row.canonical_id,
    sourceItemId: row.source_item_id,
    upstreamItemId: row.upstream_item_id,
    upstreamUserId: row.upstream_user_id,
    serverId: row.server_id,
    serverGeneration: integer(row.server_generation, "server_generation"),
    desiredRevision: integer(row.desired_revision, "desired_revision"),
    payload: desiredUserState(row.payload_json),
    attemptCount: integer(row.attempt_count, "attempt_count"),
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: integer(row.lease_expires_at_ms, "lease_expires_at_ms")
  })

  const claimOutboxTargets: RepositoriesService["claimOutboxTargets"] = (input) => {
    if (!Number.isSafeInteger(input.nowMs) || input.leaseOwner.length === 0) {
      return Effect.fail(failure("claimOutboxTargets", "invalid claim request"))
    }
    return database("claimOutboxTargets", Effect.gen(function*() {
      yield* sql.unsafe(`
        UPDATE state_outbox
        SET uncertain_since_ms = CASE
              WHEN dispatched_at_ms IS NULL THEN uncertain_since_ms
              ELSE COALESCE(uncertain_since_ms, ?)
            END,
            last_failure_code = CASE
              WHEN dispatched_at_ms IS NULL THEN last_failure_code
              ELSE COALESCE(last_failure_code, 'lease_expired_after_dispatch')
            END,
            last_failure_at_ms = CASE
              WHEN dispatched_at_ms IS NULL THEN last_failure_at_ms
              ELSE COALESCE(last_failure_at_ms, ?)
            END,
            next_attempt_at_ms = MIN(next_attempt_at_ms, ?),
            lease_owner = NULL,
            lease_expires_at_ms = NULL,
            dispatched_at_ms = NULL,
            updated_at_ms = ?
        WHERE target_id IN (
          SELECT target_id
          FROM state_outbox
          WHERE lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
          ORDER BY lease_expires_at_ms, target_id
          LIMIT ${OUTBOX_BATCH_SIZE}
        )
      `, [input.nowMs, input.nowMs, input.nowMs, input.nowMs, input.nowMs])
      const candidates = yield* sql.unsafe<{ target_id: string }>(`
        SELECT outbox.target_id
        FROM state_outbox outbox
        WHERE outbox.eligible = 1
          AND permanent_failure_code IS NULL
          AND next_attempt_at_ms <= ?
          AND lease_expires_at_ms IS NULL
          AND (delivered_revision < desired_revision OR uncertain_since_ms IS NOT NULL)
          AND EXISTS (
            SELECT 1
            FROM source_items item
            JOIN upstream_servers server ON server.id = item.server_id
            JOIN library_sources binding
              ON binding.server_id = item.server_id
              AND binding.source_library_id = item.source_library_id
            JOIN virtual_libraries library ON library.id = binding.virtual_library_id
            WHERE item.id = outbox.source_item_id
              AND item.canonical_id = outbox.canonical_id
              AND server.upstream_user_id IS NOT NULL
              AND ${eligibleTargetConditions}
          )
        ORDER BY next_attempt_at_ms, outbox.target_id
        LIMIT ?
      `, [input.nowMs, OUTBOX_BATCH_SIZE])
      if (candidates.length === 0) return []
      const batches = yield* sql.batch(candidates.map((candidate) => sql.unsafe<OutboxRow>(`
        UPDATE state_outbox
        SET lease_owner = ?, lease_expires_at_ms = ?, dispatched_at_ms = NULL,
            attempt_count = attempt_count + 1
        WHERE target_id = ?
          AND eligible = 1
          AND permanent_failure_code IS NULL
          AND next_attempt_at_ms <= ?
          AND lease_expires_at_ms IS NULL
          AND (delivered_revision < desired_revision OR uncertain_since_ms IS NOT NULL)
          AND EXISTS (
            SELECT 1
            FROM source_items item
            JOIN upstream_servers server ON server.id = item.server_id
            JOIN library_sources binding
              ON binding.server_id = item.server_id
              AND binding.source_library_id = item.source_library_id
            JOIN virtual_libraries library ON library.id = binding.virtual_library_id
            WHERE item.id = state_outbox.source_item_id
              AND item.canonical_id = state_outbox.canonical_id
              AND server.upstream_user_id IS NOT NULL
              AND ${eligibleTargetConditions}
          )
        RETURNING
          target_id, canonical_id, source_item_id, server_id, server_generation,
          (SELECT upstream_item_id FROM source_items WHERE id = source_item_id) AS upstream_item_id,
          (SELECT upstream_user_id FROM upstream_servers WHERE id = server_id) AS upstream_user_id,
          desired_revision, payload_json, attempt_count, lease_owner, lease_expires_at_ms
      `, [
        input.leaseOwner,
        input.nowMs + OUTBOX_LEASE_MS,
        candidate.target_id,
        input.nowMs
      ])))
      const claimed: Array<OutboxClaim> = []
      for (const rows of batches) {
        if (rows[0]) claimed.push(yield* decode("claimOutboxTargets", () => outboxClaim(rows[0]!)))
      }
      return claimed
    }))
  }

  const markOutboxDispatched: RepositoriesService["markOutboxDispatched"] = (input) =>
    database("markOutboxDispatched", sql.unsafe<{ target_id: string }>(`
      UPDATE state_outbox
      SET dispatched_at_ms = ?, updated_at_ms = ?
      WHERE target_id = ?
        AND desired_revision = ?
        AND server_generation = ?
        AND lease_owner = ?
        AND lease_expires_at_ms > ?
        AND eligible = 1
        AND EXISTS (
          SELECT 1 FROM upstream_servers server
          WHERE server.id = state_outbox.server_id
            AND server.generation = ?
            AND server.enabled = 1
            AND server.deleted_at_ms IS NULL
        )
      RETURNING target_id
    `, [
      input.dispatchedAtMs,
      input.dispatchedAtMs,
      input.targetId,
      input.desiredRevision,
      input.serverGeneration,
      input.leaseOwner,
      input.dispatchedAtMs,
      input.serverGeneration
    ])).pipe(Effect.map((rows) => rows.length === 1))

  const acknowledgeOutboxTarget: RepositoriesService["acknowledgeOutboxTarget"] = (input) =>
    database("acknowledgeOutboxTarget", sql.unsafe<{ target_id: string }>(`
      UPDATE state_outbox
      SET delivered_revision = ?,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          dispatched_at_ms = NULL,
          next_attempt_at_ms = CASE
            WHEN uncertain_since_ms IS NULL THEN next_attempt_at_ms
            ELSE ?
          END,
          permanent_failure_code = NULL,
          last_failure_code = CASE WHEN uncertain_since_ms IS NULL THEN NULL ELSE last_failure_code END,
          last_failure_at_ms = CASE WHEN uncertain_since_ms IS NULL THEN NULL ELSE last_failure_at_ms END,
          updated_at_ms = ?
      WHERE target_id = ?
        AND desired_revision = ?
        AND server_generation = ?
        AND lease_owner = ?
        AND lease_expires_at_ms > ?
        AND eligible = 1
        AND EXISTS (
          SELECT 1 FROM upstream_servers server
          WHERE server.id = state_outbox.server_id
            AND server.generation = ?
            AND server.enabled = 1
            AND server.deleted_at_ms IS NULL
        )
      RETURNING target_id
    `, [
      input.desiredRevision,
      input.acknowledgedAtMs + UNCERTAINTY_REAPPLY_MS,
      input.acknowledgedAtMs,
      input.targetId,
      input.desiredRevision,
      input.serverGeneration,
      input.leaseOwner,
      input.acknowledgedAtMs,
      input.serverGeneration
    ])).pipe(Effect.map((rows) => rows.length === 1))

  const markOutboxUncertain: RepositoriesService["markOutboxUncertain"] = (input) =>
    database("markOutboxUncertain", sql.unsafe(`
      UPDATE state_outbox
      SET uncertain_since_ms = COALESCE(uncertain_since_ms, ?),
          last_failure_code = ?,
          last_failure_at_ms = ?,
          next_attempt_at_ms = CASE
            WHEN delivered_revision < desired_revision THEN MIN(next_attempt_at_ms, ?)
            ELSE ?
          END,
          updated_at_ms = ?
      WHERE target_id = ? AND desired_revision >= ?
    `, [
      input.uncertainAtMs,
      input.code,
      input.uncertainAtMs,
      input.uncertainAtMs,
      input.nextAttemptAtMs,
      input.uncertainAtMs,
      input.targetId,
      input.desiredRevision
    ])).pipe(Effect.asVoid)

  const recordOutboxFailure: RepositoriesService["recordOutboxFailure"] = (input) =>
    database("recordOutboxFailure", sql.unsafe<{ target_id: string }>(`
      UPDATE state_outbox
      SET permanent_failure_code = CASE WHEN ? THEN ? ELSE NULL END,
          last_failure_code = ?,
          last_failure_at_ms = ?,
          next_attempt_at_ms = ?,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          dispatched_at_ms = NULL,
          updated_at_ms = ?
      WHERE target_id = ?
        AND desired_revision = ?
        AND server_generation = ?
        AND lease_owner = ?
        AND lease_expires_at_ms > ?
      RETURNING target_id
    `, [
      input.permanent ? 1 : 0,
      input.code,
      input.code,
      input.failedAtMs,
      input.nextAttemptAtMs,
      input.failedAtMs,
      input.targetId,
      input.desiredRevision,
      input.serverGeneration,
      input.leaseOwner,
      input.failedAtMs
    ])).pipe(Effect.map((rows) => rows.length === 1))

  const runMaintenanceBatch: RepositoriesService["runMaintenanceBatch"] = (nowMs) =>
    database("runMaintenanceBatch", Effect.gen(function*() {
      const remove = (table: string, predicate: string, parameters: ReadonlyArray<number> = [nowMs]) =>
        sql.unsafe<{ rowid: number }>(`
        DELETE FROM ${table}
        WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT 100)
        RETURNING rowid
      `, parameters)
      const missing = yield* sql.unsafe<UserStateRow & {
        readonly target_id: string
        readonly server_id: string
        readonly server_generation: number
      }>(`
        SELECT state.*, item.id AS target_id, item.server_id, item.server_generation
        FROM user_state state
        JOIN source_items item ON item.canonical_id = state.canonical_id
        JOIN upstream_servers server ON server.id = item.server_id
        JOIN library_sources binding
          ON binding.server_id = item.server_id
          AND binding.source_library_id = item.source_library_id
        JOIN virtual_libraries library ON library.id = binding.virtual_library_id
        LEFT JOIN state_outbox outbox ON outbox.target_id = item.id
        WHERE item.canonical_id = state.canonical_id
          AND ${eligibleTargetConditions}
          AND (outbox.target_id IS NULL OR outbox.eligible = 0 OR outbox.desired_revision <> state.revision)
        ORDER BY item.id
        LIMIT 100
      `)
      const results = yield* sql.batch([
        remove("dashboard_sessions", "expires_at_ms <= ?"),
        remove("emby_tokens", "expires_at_ms <= ?"),
        remove(
          "auth_rate_limits",
          "(blocked_until_ms IS NOT NULL AND blocked_until_ms <= ?) OR (blocked_until_ms IS NULL AND window_started_at_ms <= ?)",
          [nowMs, nowMs - AUTH_RATE_WINDOW_MS]
        ),
        remove(
          "playback_sessions",
          "last_event_at_ms <= ?",
          [nowMs - 24 * 60 * 60_000]
        ),
        remove("query_generations", "expires_at_ms <= ?"),
        remove("source_metadata_cache", "stale_until_ms <= ?"),
        sql.unsafe<{ target_id: string }>(`
          UPDATE state_outbox
          SET uncertain_since_ms = CASE
                WHEN dispatched_at_ms IS NULL THEN uncertain_since_ms
                ELSE COALESCE(uncertain_since_ms, ?)
              END,
              lease_owner = NULL,
              lease_expires_at_ms = NULL,
              dispatched_at_ms = NULL,
              last_failure_code = CASE
                WHEN dispatched_at_ms IS NULL THEN last_failure_code
                ELSE COALESCE(last_failure_code, 'lease_expired_after_dispatch')
              END,
              last_failure_at_ms = CASE
                WHEN dispatched_at_ms IS NULL THEN last_failure_at_ms
                ELSE COALESCE(last_failure_at_ms, ?)
              END,
              next_attempt_at_ms = MIN(next_attempt_at_ms, ?),
              updated_at_ms = ?
          WHERE target_id IN (
            SELECT target_id
            FROM state_outbox
            WHERE lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
            LIMIT 100
          )
          RETURNING target_id
        `, [nowMs, nowMs, nowMs, nowMs, nowMs]),
        sql.unsafe<{ target_id: string }>(`
          UPDATE state_outbox
          SET eligible = 0, lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
          WHERE target_id IN (
            SELECT outbox.target_id
            FROM state_outbox outbox
            WHERE outbox.eligible = 1 AND NOT EXISTS (
              SELECT 1
              FROM source_items item
              JOIN upstream_servers server ON server.id = item.server_id
              JOIN library_sources binding
                ON binding.server_id = item.server_id
                AND binding.source_library_id = item.source_library_id
              JOIN virtual_libraries library ON library.id = binding.virtual_library_id
              WHERE item.id = outbox.source_item_id
                AND item.canonical_id = outbox.canonical_id
                AND ${eligibleTargetConditions}
            )
            LIMIT 100
          )
          RETURNING target_id
        `, [nowMs]),
        ...missing.map((row) => upsertOutboxTarget({
          id: row.target_id,
          server_id: row.server_id,
          server_generation: row.server_generation
        }, userState(row), nowMs)),
        sql.unsafe(`
          INSERT INTO maintenance_status (singleton, last_run_at_ms)
          VALUES (1, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            last_run_at_ms = MAX(maintenance_status.last_run_at_ms, excluded.last_run_at_ms)
        `, [nowMs])
      ])
      return {
        expiredDashboardSessions: results[0]!.length,
        expiredEmbyTokens: results[1]!.length,
        expiredRateLimits: results[2]!.length,
        expiredPlaybackSessions: results[3]!.length,
        expiredQueryGenerations: results[4]!.length,
        expiredMetadataCacheRows: results[5]!.length,
        releasedOutboxLeases: results[6]!.length,
        cancelledOutboxTargets: results[7]!.length,
        createdOutboxTargets: missing.length
      } satisfies MaintenanceResult
    }))

  const readSystemStatus: RepositoriesService["readSystemStatus"] = () =>
    database("readSystemStatus", Effect.gen(function*() {
      const cache = yield* sql.unsafe<{ count: number }>("SELECT COUNT(*) AS count FROM source_metadata_cache")
      const maintenance = yield* sql.unsafe<{ last_run_at_ms: number }>(
        "SELECT last_run_at_ms FROM maintenance_status WHERE singleton = 1"
      )
      const outbox = yield* sql.unsafe<{
        pending: number
        failed: number
        uncertain: number
      }>(`
        SELECT
          SUM(CASE WHEN eligible = 1 AND permanent_failure_code IS NULL AND delivered_revision < desired_revision THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN last_failure_code IS NOT NULL OR permanent_failure_code IS NOT NULL THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN uncertain_since_ms IS NOT NULL THEN 1 ELSE 0 END) AS uncertain
        FROM state_outbox
      `)
      const upstream = yield* sql.unsafe<{ health: string; count: number }>(`
        SELECT health, COUNT(*) AS count
        FROM upstream_servers
        WHERE deleted_at_ms IS NULL
        GROUP BY health
      `)
      const counts = new Map(upstream.map((row) => [row.health, integer(row.count, "count")]))
      return {
        database: "healthy" as const,
        cacheEntries: integer(cache[0]?.count ?? 0, "cache count"),
        maintenanceLastRunAtMs: maintenance[0]?.last_run_at_ms ?? null,
        outboxPending: integer(outbox[0]?.pending ?? 0, "outbox pending"),
        outboxFailed: integer(outbox[0]?.failed ?? 0, "outbox failed"),
        outboxUncertain: integer(outbox[0]?.uncertain ?? 0, "outbox uncertain"),
        upstreamHealthy: counts.get("healthy") ?? 0,
        upstreamDegraded: counts.get("degraded") ?? 0,
        upstreamUnknown: counts.get("unknown") ?? 0
      }
    }))

  const listOutboxFailures: RepositoriesService["listOutboxFailures"] = () =>
    database("listOutboxFailures", sql.unsafe<{
      readonly server_id: string
      readonly code: string
      readonly failed_at_ms: unknown
      readonly attempt_count: unknown
      readonly next_attempt_at_ms: unknown | null
      readonly uncertain_since_ms: unknown | null
      readonly permanent_failure_code: string | null
    }>(`
      SELECT server_id,
        COALESCE(permanent_failure_code, last_failure_code, 'delivery_uncertain') AS code,
        COALESCE(last_failure_at_ms, uncertain_since_ms, updated_at_ms) AS failed_at_ms,
        attempt_count,
        next_attempt_at_ms,
        uncertain_since_ms,
        permanent_failure_code
      FROM state_outbox
      WHERE permanent_failure_code IS NOT NULL
        OR last_failure_code IS NOT NULL
        OR uncertain_since_ms IS NOT NULL
      ORDER BY failed_at_ms DESC, target_id
      LIMIT 100
    `)).pipe(Effect.flatMap((rows) => decode("listOutboxFailures", () => rows.map((row) => ({
      serverId: decodeServerId(row.server_id),
      code: row.code,
      failedAtMs: integer(row.failed_at_ms, "failed_at_ms"),
      attemptCount: integer(row.attempt_count, "attempt_count"),
      nextAttemptAtMs: row.permanent_failure_code === null
        ? integer(row.next_attempt_at_ms, "next_attempt_at_ms")
        : null,
      uncertainSinceMs: row.uncertain_since_ms === null
        ? null
        : integer(row.uncertain_since_ms, "uncertain_since_ms")
    })))))

  return Repositories.of({
    claimUser,
    getUser,
    getUserByName,
    issueDashboardSession,
    issueEmbyToken,
    lookupDashboardSession,
    lookupEmbyToken,
    deleteDashboardSession,
    consumeAuthAttempt,
    clearAuthAttempts,
    revokeAuthentication,
    listServers,
    getServer,
    createServer,
    saveServer,
    saveServerConfiguration,
    saveServerResult,
    deleteServer,
    listVirtualLibraries,
    saveVirtualLibrary,
    deleteVirtualLibrary,
    isSourceEligible,
    resolveEligibleSources,
    resolveIdentity: resolveIdentityD1,
    lookupCanonicalId,
    persistIdentityResult,
    readQueryGeneration,
    readQueryGenerationItems,
    appendQueryGenerationItems,
    readMetadataProjection,
    writeMetadataProjection,
    suppressDetailProjections,
    mergeCanonicalMetadata,
    readCatalogItems,
    resolveEligibleSourcesForCanonical,
    listStateMemberCanonicalIds,
    invalidateStateDependentQueryGenerations,
    writeUserStateAndTargets,
    recordPlaybackEventAndTargets,
    claimOutboxTargets,
    markOutboxDispatched,
    acknowledgeOutboxTarget,
    markOutboxUncertain,
    recordOutboxFailure,
    runMaintenanceBatch,
    readSystemStatus,
    listOutboxFailures
  })
})

export const makeD1RepositoriesLayer = (
  db: D1Client.D1ClientConfig["db"]
): Layer.Layer<Repositories> => Layer.effect(Repositories, makeRepositories).pipe(
  Layer.provide(D1Client.layer({ db }).pipe(Layer.orDie))
)
