import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import {
  ServerView as ServerViewSchema,
  SourceLibraryView as SourceLibraryViewSchema,
  VirtualLibraryView as VirtualLibraryViewSchema
} from "@oh-my-emby/contracts"
import { Effect, Layer, Schema, Semaphore } from "effect"

import { OUTBOX_BATCH_SIZE } from "../../core/limits.js"
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
import { Repositories, type RepositoriesService } from "../../core/repositories.js"

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
  const sql = yield* SqliteClient.SqliteClient
  const createServerSemaphore = Semaphore.makeUnsafe(1)
  yield* sql.unsafe("PRAGMA foreign_keys = ON").pipe(Effect.orDie)
  const pragma = yield* sql.unsafe<{ foreign_keys: number }>("PRAGMA foreign_keys").pipe(Effect.orDie)
  if (pragma[0]?.foreign_keys !== 1) {
    return yield* Effect.die("SQLite foreign key enforcement is unavailable")
  }

  const claimUser: RepositoriesService["claimUser"] = (input) => Effect.suspend(() => {
    const nowMs = input.nowMs ?? Date.now()
    return sql.withTransaction(Effect.gen(function*() {
      const existing = yield* sql.unsafe<{ singleton: number }>("SELECT singleton FROM users WHERE singleton = 1")
      if (existing.length > 0) return yield* Effect.fail(new AlreadyInitialized())
      yield* sql.unsafe(`
        INSERT INTO users (
          singleton, username, password_hash, password_salt, pbkdf2_iterations,
          auth_generation, created_at_ms, updated_at_ms
        ) VALUES (1, ?, ?, ?, ?, 1, ?, ?)
      `, [
        input.username,
        input.password.hash,
        input.password.salt,
        input.password.iterations,
        nowMs,
        nowMs
      ])
      const rows = yield* sql.unsafe<UserRow>("SELECT * FROM users WHERE singleton = 1")
      return yield* decode("claimUser", () => userRecord(rows[0]!))
    })).pipe(Effect.mapError((cause) =>
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
    authDatabase("issueDashboardSession", sql.withTransaction(Effect.gen(function*() {
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
    })))

  const issueEmbyToken: RepositoriesService["issueEmbyToken"] = (input) =>
    authDatabase("issueEmbyToken", sql.withTransaction(Effect.gen(function*() {
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
    })))

  const lookupDashboardSession: RepositoriesService["lookupDashboardSession"] = (input) =>
    database("lookupDashboardSession", sql.withTransaction(Effect.gen(function*() {
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
    })))

  const lookupEmbyToken: RepositoriesService["lookupEmbyToken"] = (input) =>
    database("lookupEmbyToken", sql.withTransaction(Effect.gen(function*() {
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
    })))

  const deleteDashboardSession: RepositoriesService["deleteDashboardSession"] = (id, authGeneration) =>
    database("deleteDashboardSession", sql.unsafe(
      "DELETE FROM dashboard_sessions WHERE id = ? AND auth_generation = ?",
      [id, authGeneration]
    )).pipe(Effect.asVoid)

  const consumeAuthAttempt: RepositoriesService["consumeAuthAttempt"] = (input) =>
    database("consumeAuthAttempt", sql.withTransaction(Effect.gen(function*() {
      const rows = yield* sql.unsafe<AuthRateLimitRow>(`
        SELECT window_started_at_ms, attempt_count, blocked_until_ms
        FROM auth_rate_limits
        WHERE scope_key = ?
        ORDER BY window_started_at_ms DESC
        LIMIT 1
      `, [input.scopeKey])
      const row = rows[0]
      if (row) {
        const blockedUntilMs = row.blocked_until_ms === null
          ? null
          : integer(row.blocked_until_ms, "blocked_until_ms")
        if (blockedUntilMs !== null && blockedUntilMs > input.nowMs) return false
        const windowStartedAtMs = integer(row.window_started_at_ms, "window_started_at_ms")
        if (input.nowMs - windowStartedAtMs < input.windowMs) {
          const attempts = integer(row.attempt_count, "attempt_count") + 1
          yield* sql.unsafe(`
            UPDATE auth_rate_limits
            SET attempt_count = ?, blocked_until_ms = ?
            WHERE scope_key = ? AND window_started_at_ms = ?
          `, [
            attempts,
            attempts >= input.maxAttempts ? input.nowMs + input.blockMs : null,
            input.scopeKey,
            windowStartedAtMs
          ])
          return true
        }
      }
      yield* sql.unsafe(`
        INSERT INTO auth_rate_limits (
          scope_key, window_started_at_ms, attempt_count, blocked_until_ms
        ) VALUES (?, ?, 1, NULL)
      `, [input.scopeKey, input.nowMs])
      return true
    })))

  const clearAuthAttempts: RepositoriesService["clearAuthAttempts"] = (scopeKey) =>
    database(
      "clearAuthAttempts",
      sql.unsafe("DELETE FROM auth_rate_limits WHERE scope_key = ?", [scopeKey])
    ).pipe(Effect.asVoid)

  const revokeAuthentication: RepositoriesService["revokeAuthentication"] = (input) =>
    authDatabase("revokeAuthentication", sql.withTransaction(Effect.gen(function*() {
      const updated = yield* sql.unsafe<{ singleton: number }>(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, pbkdf2_iterations = ?,
            auth_generation = auth_generation + 1, updated_at_ms = ?
        WHERE singleton = 1 AND auth_generation = ?
        RETURNING singleton
      `, [
        input.password.hash,
        input.password.salt,
        input.password.iterations,
        input.updatedAtMs,
        input.expectedAuthGeneration
      ])
      if (!updated[0]) return yield* Effect.fail(new AuthenticationChanged())
      yield* sql.unsafe("DELETE FROM dashboard_sessions")
      yield* sql.unsafe("DELETE FROM emby_tokens")
    })))

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
    createServerSemaphore.withPermit(database("createServer", sql.unsafe<ServerRow>(`
      INSERT INTO upstream_servers (
        id, catalog_namespace, verified_catalog_id, verified_base_url, generation, name, base_url,
        username, password, access_token, access_token_expires_at_ms, user_agent,
        enabled, health, last_success_at_ms, deleted_at_ms, created_at_ms, updated_at_ms
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
    ))

  const saveServer: RepositoriesService["saveServer"] = (input) =>
    database("saveServer", sql.withTransaction(Effect.gen(function*() {
      yield* sql.unsafe(`
        INSERT INTO upstream_servers (
          id, catalog_namespace, verified_catalog_id, verified_base_url, generation, name, base_url,
          username, password, access_token, access_token_expires_at_ms, user_agent,
          enabled, health, last_success_at_ms, deleted_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          user_agent = excluded.user_agent,
          enabled = excluded.enabled,
          health = excluded.health,
          last_success_at_ms = excluded.last_success_at_ms,
          deleted_at_ms = excluded.deleted_at_ms,
          updated_at_ms = excluded.updated_at_ms
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
        input.userAgent,
        input.enabled ? 1 : 0,
        input.health,
        input.lastSuccessAtMs,
        input.deletedAtMs,
        input.createdAtMs,
        input.updatedAtMs
      ])
      const rows = yield* sql.unsafe<ServerRow>("SELECT * FROM upstream_servers WHERE id = ?", [input.id])
      return yield* decode("saveServer", () => upstreamServer(rows[0]!))
    })))

  const saveServerResult: RepositoriesService["saveServerResult"] = (input) =>
    database("saveServerResult", sql.withTransaction(Effect.gen(function*() {
      const rows = yield* sql.unsafe<ServerRow>(
        "SELECT * FROM upstream_servers WHERE id = ? AND generation = ?",
        [input.serverId, input.expectedGeneration]
      )
      if (rows[0] === undefined) return null
      const current = upstreamServer(rows[0])
      const updated: UpstreamServer = {
        ...current,
        accessToken: input.accessToken === undefined ? current.accessToken : input.accessToken,
        accessTokenExpiresAtMs: input.accessTokenExpiresAtMs === undefined
          ? current.accessTokenExpiresAtMs
          : input.accessTokenExpiresAtMs,
        verifiedCatalogId: input.verifiedCatalogId === undefined
          ? current.verifiedCatalogId
          : input.verifiedCatalogId,
        verifiedBaseUrl: input.verifiedBaseUrl === undefined
          ? current.verifiedBaseUrl
          : input.verifiedBaseUrl,
        health: input.health ?? current.health,
        lastSuccessAtMs: input.lastSuccessAtMs === undefined
          ? current.lastSuccessAtMs
          : input.lastSuccessAtMs,
        updatedAtMs: input.updatedAtMs
      }
      const saved = yield* sql.unsafe<ServerRow>(`
        UPDATE upstream_servers SET
          verified_catalog_id = ?, verified_base_url = ?, access_token = ?,
          access_token_expires_at_ms = ?, health = ?, last_success_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND generation = ?
        RETURNING *
      `, [
        updated.verifiedCatalogId,
        updated.verifiedBaseUrl,
        updated.accessToken,
        updated.accessTokenExpiresAtMs,
        updated.health,
        updated.lastSuccessAtMs,
        updated.updatedAtMs,
        input.serverId,
        input.expectedGeneration
      ])
      return saved[0] === undefined ? null : upstreamServer(saved[0])
    })))

  const saveServerConfiguration: RepositoriesService["saveServerConfiguration"] = (input, expectedGeneration) =>
    database("saveServerConfiguration", sql.withTransaction(Effect.gen(function*() {
      const rows = yield* sql.unsafe<ServerRow>(`
        UPDATE upstream_servers SET
          verified_catalog_id = ?, verified_base_url = ?, generation = ?, name = ?, base_url = ?,
          username = ?, password = ?, access_token = ?, access_token_expires_at_ms = ?, user_agent = ?,
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
        input.userAgent,
        input.enabled ? 1 : 0,
        input.health,
        input.lastSuccessAtMs,
        input.updatedAtMs,
        input.id,
        expectedGeneration
      ])
      return rows[0] === undefined ? null : upstreamServer(rows[0])
    })))

  const deleteServer: RepositoriesService["deleteServer"] = (id) =>
    database("deleteServer", sql.unsafe(`
      UPDATE upstream_servers SET
        enabled = 0, health = 'unknown', generation = generation + 1,
        access_token = NULL, access_token_expires_at_ms = NULL,
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
    return database("saveVirtualLibrary", sql.withTransaction(Effect.gen(function*() {
      const eligibility = serverFences.map(() => `EXISTS(
        SELECT 1 FROM upstream_servers us
        WHERE us.id = ? AND us.generation = ? AND us.enabled = 1
          AND us.deleted_at_ms IS NULL AND us.health = 'healthy'
          AND us.verified_base_url IS NOT NULL
      )`).join(" AND ")
      const saved = yield* sql.unsafe<{ readonly id: string }>(`
        INSERT INTO virtual_libraries (
          id, name, media_type, enabled, created_at_ms, updated_at_ms
        ) SELECT ?, ?, ?, ?, ?, ?
        WHERE ${eligibility}
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          media_type = excluded.media_type,
          enabled = excluded.enabled,
          updated_at_ms = excluded.updated_at_ms
        RETURNING id
      `, [
        input.id,
        input.name,
        input.mediaType,
        input.enabled ? 1 : 0,
        input.createdAtMs,
        input.updatedAtMs,
        ...serverFences.flatMap((fence) => [fence.serverId, fence.generation])
      ])
      if (saved[0] === undefined) return null
      yield* sql.unsafe("DELETE FROM library_sources WHERE virtual_library_id = ?", [input.id])
      for (const source of input.sources) {
        yield* sql.unsafe(`
          INSERT INTO library_sources (
            virtual_library_id, server_id, source_library_id, source_library_name,
            media_type, source_order, enabled
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          input.id,
          source.serverId,
          source.sourceLibraryId,
          source.sourceLibraryName,
          source.mediaType,
          source.sourceOrder,
          source.enabled ? 1 : 0
        ])
      }
      return input
    })))
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

  const resolveEligibleSources: RepositoriesService["resolveEligibleSources"] = (libraryId) =>
    database("resolveEligibleSources", sql.unsafe<EligibleSourceRow>(`
      SELECT
        ls.virtual_library_id,
        ls.server_id,
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
    `, [libraryId])).pipe(Effect.flatMap((rows) => decode("resolveEligibleSources", () => rows.map((row): EligibleSource => ({
      virtualLibraryId: decodeVirtualLibraryId(row.virtual_library_id),
      serverId: decodeServerId(row.server_id),
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
    })))))

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

  const resolveIdentity: RepositoriesService["resolveIdentity"] = (candidate) =>
    identityDatabase("resolveIdentity", sql.withTransaction(Effect.gen(function*() {
      yield* assertIdentityFence(candidate, true)

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
          proposedCanonicalId = yield* Effect.promise(() => stableCanonicalId([
            namespace,
            value
          ]))
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
      const placeholders = ids.map(() => "?").join(", ")
      const canonicalRows = ids.length === 0 ? [] : yield* sql.unsafe<CanonicalRow>(`
        SELECT * FROM canonical_items
        WHERE id IN (${placeholders}) AND item_type = ?
        ORDER BY created_at_ms, id
      `, [...ids, candidate.itemType])
      const activeIds = new Set(canonicalRows.map(({ id }) => id))
      const clusterClaims = canonicalRows.length === 0 ? [] : yield* sql.unsafe<IdentityClaimRow>(`
        SELECT * FROM identity_claims
        WHERE canonical_id IN (${canonicalRows.map(() => "?").join(", ")})
        ORDER BY created_at_ms, canonical_id, namespace
      `, canonicalRows.map(({ id }) => id))

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

      const ensureCanonical = (id: string, state: string) => sql.unsafe(`
        INSERT OR IGNORE INTO canonical_items (
          id, item_type, identity_state, display_metadata_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        id,
        candidate.itemType,
        state,
        canonicalJson(candidate.displayMetadata),
        candidate.observedAtMs,
        candidate.observedAtMs
      ])

      const saveSource = (canonicalId: string, reason: string | null) => sql.unsafe(`
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
        canonicalId,
        reason,
        existing === undefined ? candidate.observedAtMs : integer(existing.created_at_ms, "created_at_ms"),
        candidate.observedAtMs
      ])

      const saveVersions = Effect.gen(function*() {
        for (const version of candidate.mediaVersions) {
          yield* sql.unsafe(`
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
          ])
        }
      })

      const readResolution = (canonicalId: string) => Effect.gen(function*() {
        const canonicals = yield* sql.unsafe<CanonicalRow>("SELECT * FROM canonical_items WHERE id = ?", [canonicalId])
        const sources = yield* sql.unsafe<SourceItemRow>("SELECT * FROM source_items WHERE id = ?", [sourceItemId])
        const claims = yield* sql.unsafe<IdentityClaimRow>(`
          SELECT * FROM identity_claims WHERE canonical_id = ? ORDER BY namespace
        `, [canonicalId])
        const aliases = yield* sql.unsafe<{
          readonly alias_id: string
          readonly canonical_id: string
          readonly retired_at_ms: unknown
        }>("SELECT * FROM canonical_aliases WHERE canonical_id = ? ORDER BY alias_id", [canonicalId])
        const versions = yield* sql.unsafe<MediaVersionRow>(`
          SELECT * FROM source_media_versions WHERE source_item_id = ? ORDER BY id
        `, [sourceItemId])
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
      })

      if (incompatible) {
        let canonicalId = existing?.canonical_id && activeIds.has(existing.canonical_id)
          ? existing.canonical_id
          : candidate.sourceExclusiveCanonicalId
        const aliasTarget = yield* resolveCanonicalIdInTransaction(canonicalId)
        if (aliasTarget !== null) canonicalId = aliasTarget
        yield* ensureCanonical(canonicalId, "source-exclusive")
        yield* saveSource(canonicalId, "ambiguous-identity")
        if (existing?.canonical_id === null || existing === undefined) {
          for (const entry of candidate.claims) {
            yield* sql.unsafe(`
              INSERT INTO identity_claims (
                canonical_id, namespace, value, state, source_item_id, created_at_ms
              ) VALUES (?, ?, ?, 'quarantined', ?, ?)
              ON CONFLICT(canonical_id, namespace) DO UPDATE SET
                value = excluded.value,
                state = excluded.state,
                source_item_id = excluded.source_item_id
            `, [canonicalId, entry.namespace, entry.value, sourceItemId, candidate.observedAtMs])
          }
        }
        yield* saveVersions
        yield* assertIdentityFence(candidate, false)
        return yield* readResolution(canonicalId)
      }

      let survivorId: string
      if (canonicalRows[0]) {
        survivorId = canonicalRows[0].id
      } else {
        survivorId = proposedCanonicalId ?? candidate.sourceExclusiveCanonicalId
        const aliasTarget = yield* resolveCanonicalIdInTransaction(survivorId)
        if (aliasTarget !== null) survivorId = aliasTarget
        yield* ensureCanonical(survivorId, identityState)
      }
      const retiredIds = canonicalRows.map(({ id }) => id).filter((id) => id !== survivorId)

      yield* saveSource(survivorId, quarantineReason)

      if (retiredIds.length > 0) {
        const retiredPlaceholders = retiredIds.map(() => "?").join(", ")
        yield* sql.unsafe(`
          DELETE FROM query_generations
          WHERE id IN (
            SELECT generation_id FROM query_generation_items
            WHERE canonical_id IN (${retiredPlaceholders})
          )
        `, retiredIds)
        yield* sql.unsafe(`
          UPDATE source_items SET canonical_id = ?
          WHERE canonical_id IN (${retiredPlaceholders})
        `, [survivorId, ...retiredIds])
        yield* sql.unsafe(`
          UPDATE state_outbox SET canonical_id = ?
          WHERE canonical_id IN (${retiredPlaceholders})
        `, [survivorId, ...retiredIds])
        yield* sql.unsafe(`
          UPDATE playback_sessions SET canonical_id = ?
          WHERE canonical_id IN (${retiredPlaceholders})
        `, [survivorId, ...retiredIds])

        const states = yield* sql.unsafe<UserStateRow>(`
          SELECT * FROM user_state
          WHERE canonical_id IN (${[survivorId, ...retiredIds].map(() => "?").join(", ")})
          ORDER BY revision DESC, updated_at_ms DESC, canonical_id
        `, [survivorId, ...retiredIds])
        yield* sql.unsafe(`
          DELETE FROM user_state
          WHERE canonical_id IN (${[survivorId, ...retiredIds].map(() => "?").join(", ")})
        `, [survivorId, ...retiredIds])
        if (states[0]) {
          const state = userState(states[0])
          yield* sql.unsafe(`
            INSERT INTO user_state (
              canonical_id, revision, played, favorite, play_count, position_ticks,
              last_played_version_id, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            survivorId,
            state.revision,
            state.played ? 1 : 0,
            state.favorite ? 1 : 0,
            state.playCount,
            state.positionTicks,
            state.lastPlayedVersionId,
            state.updatedAtMs
          ])
        }

        for (const row of clusterClaims.filter(({ canonical_id, state }) =>
          state === "exact" && retiredIds.includes(canonical_id)
        )) {
          yield* sql.unsafe(`
            INSERT OR IGNORE INTO identity_claims (
              canonical_id, namespace, value, state, source_item_id, created_at_ms
            ) VALUES (?, ?, ?, 'exact', ?, ?)
          `, [survivorId, row.namespace, row.value, row.source_item_id, row.created_at_ms])
        }
        yield* sql.unsafe(`
          DELETE FROM identity_claims WHERE canonical_id IN (${retiredPlaceholders})
        `, retiredIds)
        yield* sql.unsafe(`
          UPDATE canonical_aliases SET canonical_id = ?
          WHERE canonical_id IN (${retiredPlaceholders})
        `, [survivorId, ...retiredIds])
        for (const retiredId of retiredIds) {
          yield* sql.unsafe(`
            INSERT INTO canonical_aliases (alias_id, canonical_id, retired_at_ms)
            VALUES (?, ?, ?)
            ON CONFLICT(alias_id) DO UPDATE SET
              canonical_id = excluded.canonical_id,
              retired_at_ms = excluded.retired_at_ms
          `, [retiredId, survivorId, candidate.observedAtMs])
        }
        yield* sql.unsafe(`DELETE FROM canonical_items WHERE id IN (${retiredPlaceholders})`, retiredIds)
      }

      yield* sql.unsafe(
        "DELETE FROM identity_claims WHERE canonical_id = ? AND state <> 'exact'",
        [survivorId]
      )
      for (const entry of matchClaims) {
        yield* sql.unsafe(`
          INSERT INTO identity_claims (
            canonical_id, namespace, value, state, source_item_id, created_at_ms
          ) VALUES (?, ?, ?, 'exact', ?, ?)
          ON CONFLICT(canonical_id, namespace) DO UPDATE SET
            value = excluded.value,
            state = excluded.state
        `, [survivorId, entry.namespace, entry.value, sourceItemId, candidate.observedAtMs])
      }
      if (proposedCanonicalId !== null && proposedCanonicalId !== survivorId) {
        yield* sql.unsafe(`
          INSERT INTO canonical_aliases (alias_id, canonical_id, retired_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(alias_id) DO UPDATE SET canonical_id = excluded.canonical_id
        `, [proposedCanonicalId, survivorId, candidate.observedAtMs])
      }
      yield* sql.unsafe(`
        UPDATE canonical_items
        SET identity_state = ?, updated_at_ms = ?
        WHERE id = ?
      `, [identityState, candidate.observedAtMs, survivorId])
      yield* saveVersions
      yield* assertIdentityFence(candidate, false)
      return yield* readResolution(survivorId)
    })))

  const persistIdentityResult: RepositoriesService["persistIdentityResult"] = (result) =>
    database("persistIdentityResult", sql.withTransaction(Effect.gen(function*() {
      const canonical = result.canonical
      yield* sql.unsafe(`
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
      ])
      const source = result.sourceItem
      yield* sql.unsafe(`
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
      ])
      for (const alias of result.aliases) {
        yield* sql.unsafe(`
          INSERT INTO canonical_aliases (alias_id, canonical_id, retired_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(alias_id) DO UPDATE SET
            canonical_id = excluded.canonical_id,
            retired_at_ms = excluded.retired_at_ms
        `, [alias.aliasId, alias.canonicalId, alias.retiredAtMs])
      }
      for (const claim of result.claims) {
        yield* sql.unsafe(`
          INSERT INTO identity_claims (
            canonical_id, namespace, value, state, source_item_id, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(canonical_id, namespace) DO UPDATE SET
            value = excluded.value,
            state = excluded.state,
            source_item_id = excluded.source_item_id
        `, [canonical.id, claim.namespace, claim.value, claim.state, claim.sourceItemId, claim.createdAtMs])
      }
      for (const version of result.mediaVersions) {
        yield* sql.unsafe(`
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
        ])
      }
      return canonical
    })))

  interface QueryGenerationRow {
    readonly id: string
    readonly query_key: string
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

  const appendQueryGenerationItems: RepositoriesService["appendQueryGenerationItems"] = (input) =>
    database("appendQueryGenerationItems", sql.withTransaction(Effect.gen(function*() {
      const generation = input.generation
      yield* sql.unsafe(`
        INSERT INTO query_generations (
          id, query_key, user_key, device_id, virtual_library_id,
          normalized_query_json, source_state_json, all_sources_exhausted,
          state_dependent, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(query_key) DO UPDATE SET
          source_state_json = excluded.source_state_json,
          all_sources_exhausted = excluded.all_sources_exhausted,
          expires_at_ms = excluded.expires_at_ms
      `, [
        generation.id,
        generation.queryKey,
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
      for (const item of input.items) {
        yield* sql.unsafe(`
          INSERT OR IGNORE INTO query_generation_items (
            generation_id, ordinal, canonical_id, sort_values_json
          ) VALUES (?, ?, ?, ?)
        `, [generation.id, item.ordinal, item.canonicalId, canonicalJson(item.sortValues)])
      }
    })))

  const writeUserStateAndTargets: RepositoriesService["writeUserStateAndTargets"] = (input) =>
    database("writeUserStateAndTargets", sql.withTransaction(Effect.gen(function*() {
      const previous = yield* sql.unsafe<{ revision: number }>(
        "SELECT revision FROM user_state WHERE canonical_id = ?",
        [input.canonicalId]
      )
      const revision = (previous[0]?.revision ?? 0) + 1
      yield* sql.unsafe(`
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
      `, [
        input.canonicalId,
        revision,
        input.played ? 1 : 0,
        input.favorite ? 1 : 0,
        input.playCount,
        input.positionTicks,
        input.lastPlayedVersionId,
        input.updatedAtMs
      ])

      const targets = yield* sql.unsafe<Pick<SourceItemRecord, "id" | "serverId" | "serverGeneration"> & {
        readonly server_id: string
        readonly server_generation: number
      }>(`
        SELECT DISTINCT si.id, si.server_id, si.server_generation
        FROM source_items si
        JOIN upstream_servers us ON us.id = si.server_id
        JOIN library_sources ls
          ON ls.server_id = si.server_id
          AND ls.source_library_id = si.source_library_id
        JOIN virtual_libraries vl ON vl.id = ls.virtual_library_id
        WHERE si.canonical_id = ?
          AND us.enabled = 1
          AND us.verified_catalog_id IS NOT NULL
          AND ls.enabled = 1
          AND vl.enabled = 1
      `, [input.canonicalId])

      const payload: DesiredUserState = {
        played: input.played,
        favorite: input.favorite,
        playCount: input.playCount,
        positionTicks: input.positionTicks,
        lastPlayedVersionId: input.lastPlayedVersionId
      }
      for (const target of targets) {
        yield* sql.unsafe(`
          INSERT INTO state_outbox (
            target_id, canonical_id, source_item_id, server_id, server_generation,
            desired_revision, delivered_revision, payload_json, attempt_count,
            next_attempt_at_ms, lease_owner, lease_expires_at_ms, dispatched_at_ms,
            uncertain_since_ms, permanent_failure_code, eligible, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, 1, ?)
          ON CONFLICT(target_id) DO UPDATE SET
            canonical_id = excluded.canonical_id,
            server_generation = excluded.server_generation,
            desired_revision = excluded.desired_revision,
            payload_json = excluded.payload_json,
            next_attempt_at_ms = excluded.next_attempt_at_ms,
            permanent_failure_code = NULL,
            eligible = 1,
            updated_at_ms = excluded.updated_at_ms
        `, [
          target.id,
          input.canonicalId,
          target.id,
          target.server_id,
          target.server_generation,
          revision,
          canonicalJson(payload),
          input.updatedAtMs,
          input.updatedAtMs
        ])
      }

      yield* sql.unsafe("DELETE FROM query_generations WHERE state_dependent = 1")

      const rows = yield* sql.unsafe<UserStateRow>("SELECT * FROM user_state WHERE canonical_id = ?", [input.canonicalId])
      return yield* decode("writeUserStateAndTargets", () => userState(rows[0]!))
    })))

  interface OutboxRow {
    readonly target_id: string
    readonly canonical_id: string
    readonly source_item_id: string
    readonly server_id: string
    readonly server_generation: unknown
    readonly desired_revision: unknown
    readonly payload_json: unknown
    readonly lease_owner: string
    readonly lease_expires_at_ms: unknown
  }

  const outboxClaim = (row: OutboxRow): OutboxClaim => ({
    targetId: row.target_id,
    canonicalId: row.canonical_id,
    sourceItemId: row.source_item_id,
    serverId: row.server_id,
    serverGeneration: integer(row.server_generation, "server_generation"),
    desiredRevision: integer(row.desired_revision, "desired_revision"),
    payload: desiredUserState(row.payload_json),
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: integer(row.lease_expires_at_ms, "lease_expires_at_ms")
  })

  const claimOutboxTargets: RepositoriesService["claimOutboxTargets"] = (input) => {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 0), OUTBOX_BATCH_SIZE)
    if (limit === 0 || !Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      return Effect.fail(failure("claimOutboxTargets", "invalid claim request"))
    }
    return database("claimOutboxTargets", sql.withTransaction(Effect.gen(function*() {
      const candidates = yield* sql.unsafe<{ target_id: string }>(`
        SELECT target_id
        FROM state_outbox
        WHERE eligible = 1
          AND permanent_failure_code IS NULL
          AND next_attempt_at_ms <= ?
          AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)
          AND (delivered_revision < desired_revision OR uncertain_since_ms IS NOT NULL)
        ORDER BY next_attempt_at_ms, target_id
        LIMIT ?
      `, [input.nowMs, input.nowMs, limit])
      if (candidates.length === 0) return []
      const claimed: Array<OutboxClaim> = []
      for (const candidate of candidates) {
        const rows = yield* sql.unsafe<OutboxRow>(`
          UPDATE state_outbox
          SET lease_owner = ?, lease_expires_at_ms = ?, attempt_count = attempt_count + 1
          WHERE target_id = ?
            AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)
          RETURNING
            target_id, canonical_id, source_item_id, server_id, server_generation,
            desired_revision, payload_json, lease_owner, lease_expires_at_ms
        `, [input.leaseOwner, input.nowMs + input.leaseMs, candidate.target_id, input.nowMs])
        if (rows[0]) claimed.push(yield* decode("claimOutboxTargets", () => outboxClaim(rows[0]!)))
      }
      return claimed
    })))
  }

  const acknowledgeOutboxTarget: RepositoriesService["acknowledgeOutboxTarget"] = (input) =>
    database("acknowledgeOutboxTarget", sql.unsafe<{ target_id: string }>(`
      UPDATE state_outbox
      SET delivered_revision = desired_revision,
          uncertain_since_ms = NULL,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          dispatched_at_ms = ?,
          updated_at_ms = ?
      WHERE target_id = ?
        AND desired_revision = ?
        AND lease_owner = ?
      RETURNING target_id
    `, [
      input.acknowledgedAtMs,
      input.acknowledgedAtMs,
      input.targetId,
      input.desiredRevision,
      input.leaseOwner
    ])).pipe(Effect.map((rows) => rows.length === 1))

  const markOutboxUncertain: RepositoriesService["markOutboxUncertain"] = (input) =>
    database("markOutboxUncertain", sql.unsafe(`
      UPDATE state_outbox
      SET uncertain_since_ms = COALESCE(uncertain_since_ms, ?),
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          updated_at_ms = ?
      WHERE target_id = ? AND lease_owner = ?
    `, [input.uncertainAtMs, input.uncertainAtMs, input.targetId, input.leaseOwner])).pipe(Effect.asVoid)

  const runMaintenanceBatch: RepositoriesService["runMaintenanceBatch"] = (nowMs) =>
    database("runMaintenanceBatch", sql.withTransaction(Effect.gen(function*() {
      const remove = (table: string, predicate: string) => sql.unsafe<{ rowid: number }>(`
        DELETE FROM ${table}
        WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT 100)
        RETURNING rowid
      `, [nowMs])
      const sessions = yield* remove("dashboard_sessions", "expires_at_ms <= ?")
      const tokens = yield* remove("emby_tokens", "expires_at_ms <= ?")
      const rateLimits = yield* remove(
        "auth_rate_limits",
        "COALESCE(blocked_until_ms, window_started_at_ms) <= ?"
      )
      const generations = yield* remove("query_generations", "expires_at_ms <= ?")
      const cacheRows = yield* remove("source_metadata_cache", "stale_until_ms <= ?")
      const leases = yield* sql.unsafe<{ target_id: string }>(`
        UPDATE state_outbox
        SET uncertain_since_ms = CASE
              WHEN dispatched_at_ms IS NULL THEN uncertain_since_ms
              ELSE COALESCE(uncertain_since_ms, ?)
            END,
            lease_owner = NULL,
            lease_expires_at_ms = NULL,
            updated_at_ms = ?
        WHERE target_id IN (
          SELECT target_id
          FROM state_outbox
          WHERE lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
          LIMIT 100
        )
        RETURNING target_id
      `, [nowMs, nowMs, nowMs])
      return {
        expiredDashboardSessions: sessions.length,
        expiredEmbyTokens: tokens.length,
        expiredRateLimits: rateLimits.length,
        expiredQueryGenerations: generations.length,
        expiredMetadataCacheRows: cacheRows.length,
        releasedOutboxLeases: leases.length
      } satisfies MaintenanceResult
    })))

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
    resolveIdentity,
    lookupCanonicalId,
    persistIdentityResult,
    readQueryGeneration,
    appendQueryGenerationItems,
    writeUserStateAndTargets,
    claimOutboxTargets,
    acknowledgeOutboxTarget,
    markOutboxUncertain,
    runMaintenanceBatch
  })
})

export const makeSqliteRepositoriesLayer = (
  config: SqliteClient.SqliteClientConfig
): Layer.Layer<Repositories> => Layer.effect(Repositories, makeRepositories).pipe(
  Layer.provide(SqliteClient.layer(config))
)
