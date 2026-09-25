import { Effect } from "effect"

import { RepositoryError } from "./errors.js"
import { PBKDF2_ITERATIONS } from "./limits.js"

const encoder = new TextEncoder()
const maxConnections = 10

export interface ItemFlags {
  readonly watchlisted: boolean
  readonly watchlistedAtMs: number | null
  readonly hiddenFromResume: boolean
}

export interface PlaybackHistoryInput {
  readonly kind: "start" | "progress" | "stop"
  readonly playSessionId: string
  readonly canonicalId: string
  readonly itemName: string
  readonly mediaSourceId: string | null
  readonly sourceName: string | null
  readonly deviceName: string | null
  readonly clientName: string | null
  readonly positionTicks: number
  readonly runtimeTicks: number | null
  readonly completed: boolean
  readonly nowMs: number
}

export interface PlaybackHistoryQuery {
  readonly cursor: { readonly startedAtMs: number; readonly id: string } | null
  readonly startIndex: number
  readonly limit: number
  readonly search: string | null
  readonly itemId: string | null
}

export interface PlaybackHistoryRow {
  readonly id: string
  readonly canonicalId: string
  readonly itemName: string
  readonly mediaSourceId: string | null
  readonly sourceName: string | null
  readonly deviceName: string | null
  readonly clientName: string | null
  readonly startedAtMs: number
  readonly stoppedAtMs: number | null
  readonly positionTicks: number
  readonly runtimeTicks: number | null
  readonly completed: boolean
}

export interface PlaybackHistoryPage {
  readonly items: ReadonlyArray<PlaybackHistoryRow>
  readonly total: number
  readonly nextCursor: string | null
}

export interface ConnectionDevice {
  readonly id: string
  readonly deviceId: string
  readonly deviceName: string
  readonly lastUsedAtMs: number
}

export interface ConnectionView {
  readonly id: string
  readonly name: string
  readonly createdAtMs: number
  readonly devices: ReadonlyArray<ConnectionDevice>
}

export interface CreatedConnection {
  readonly id: string
  readonly name: string
  readonly password: string
  readonly createdAtMs: number
}

export interface ItemCounts {
  readonly MovieCount: number
  readonly SeriesCount: number
  readonly EpisodeCount: number
  readonly ItemCount: number
}

export interface DrivembyCompat {
  readonly flagsFor: (
    ids: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, ItemFlags>, RepositoryError>
  readonly setWatchlisted: (
    canonicalId: string,
    watchlisted: boolean,
    nowMs: number
  ) => Effect.Effect<ItemFlags, RepositoryError>
  readonly setHiddenFromResume: (
    canonicalId: string,
    hidden: boolean
  ) => Effect.Effect<ItemFlags, RepositoryError>
  readonly listWatchlist: () => Effect.Effect<
    ReadonlyArray<{ readonly canonicalId: string; readonly watchlistedAtMs: number }>,
    RepositoryError
  >
  readonly hiddenIds: () => Effect.Effect<ReadonlySet<string>, RepositoryError>
  readonly recordPlayback: (input: PlaybackHistoryInput) => Effect.Effect<void, RepositoryError>
  readonly listHistory: (
    query: PlaybackHistoryQuery
  ) => Effect.Effect<PlaybackHistoryPage, RepositoryError>
  readonly deleteHistory: (id: string) => Effect.Effect<boolean, RepositoryError>
  readonly clearHistory: (beforeMs: number) => Effect.Effect<number, RepositoryError>
  readonly counts: () => Effect.Effect<ItemCounts, RepositoryError>
  readonly genres: (
    startIndex: number,
    limit: number
  ) => Effect.Effect<{ readonly names: ReadonlyArray<string>; readonly total: number }, RepositoryError>
  readonly createConnection: (input: {
    readonly name: string
    readonly password: string | null
    readonly nowMs: number
  }) => Effect.Effect<CreatedConnection | null, RepositoryError>
  readonly listConnections: () => Effect.Effect<ReadonlyArray<ConnectionView>, RepositoryError>
  readonly updateConnection: (input: {
    readonly id: string
    readonly password: string | null
    readonly nowMs: number
  }) => Effect.Effect<CreatedConnection | null, RepositoryError>
  readonly deleteConnection: (id: string, nowMs: number) => Effect.Effect<boolean, RepositoryError>
  readonly verifyConnection: (password: string) => Effect.Effect<string | null, RepositoryError>
  readonly linkConnectionDevice: (
    connectionId: string,
    tokenId: string
  ) => Effect.Effect<void, RepositoryError>
  readonly deleteEmbyToken: (tokenId: string) => Effect.Effect<void, RepositoryError>
}

export interface SqlExec {
  readonly unsafe: <A extends object>(
    statement: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<A>, unknown>
}

const schema = [
  `CREATE TABLE IF NOT EXISTS item_flags (
    canonical_id TEXT PRIMARY KEY,
    watchlisted INTEGER NOT NULL DEFAULT 0 CHECK (watchlisted IN (0, 1)),
    watchlisted_at_ms INTEGER,
    hidden_from_resume INTEGER NOT NULL DEFAULT 0 CHECK (hidden_from_resume IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS playback_history (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_playback_history_started ON playback_history(started_at_ms, id)`,
  `CREATE TABLE IF NOT EXISTS emby_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash BLOB NOT NULL,
    password_salt BLOB NOT NULL,
    password_iterations INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS emby_connection_devices (
    connection_id TEXT NOT NULL,
    token_id TEXT NOT NULL PRIMARY KEY
  )`
]

const failure = (operation: string, cause: unknown) => new RepositoryError({
  operation,
  message: cause instanceof Error ? cause.message : String(cause)
})

const query = <A extends object>(sql: SqlExec, operation: string, statement: string, params: ReadonlyArray<unknown> = []) =>
  sql.unsafe<A>(statement, params).pipe(Effect.mapError((cause) => failure(operation, cause)))

const flag = (watchlisted: boolean, watchlistedAtMs: number | null, hiddenFromResume: boolean): ItemFlags => ({
  watchlisted,
  watchlistedAtMs,
  hiddenFromResume
})

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error("expected bytes")
}

const integer = (value: unknown): number => {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error("expected integer")
  return parsed
}

const nullableInteger = (value: unknown): number | null => value === null || value === undefined
  ? null
  : integer(value)

const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value)

const randomDigits = (length: number): string => {
  const values = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(values, (byte) => String(byte % 10)).join("")
}

const derivePassword = (password: string, salt: Uint8Array, iterations: number) => Effect.tryPromise({
  try: async () => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
    const normalized = new Uint8Array(salt.byteLength)
    normalized.set(salt)
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: normalized, iterations },
      key,
      256
    ))
  },
  catch: (cause) => failure("derivePassword", cause)
})

const passwordRecord = (password: string) => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return derivePassword(password, salt, PBKDF2_ITERATIONS).pipe(
    Effect.map((hash) => ({ hash, salt, iterations: PBKDF2_ITERATIONS }))
  )
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

export const encodeHistoryCursor = (startedAtMs: number, id: string): string =>
  btoa(`${startedAtMs}:${id}`).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

export const decodeHistoryCursor = (cursor: string): { readonly startedAtMs: number; readonly id: string } | null => {
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/")
    const textValue = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
    const splitAt = textValue.indexOf(":")
    if (splitAt <= 0) return null
    const startedAtMs = Number(textValue.slice(0, splitAt))
    const id = textValue.slice(splitAt + 1)
    return Number.isSafeInteger(startedAtMs) && id.length > 0 ? { startedAtMs, id } : null
  } catch {
    return null
  }
}

const likeTerm = (value: string): string => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

interface FlagRow {
  readonly canonical_id: string
  readonly watchlisted: unknown
  readonly watchlisted_at_ms: unknown
  readonly hidden_from_resume: unknown
}

const readFlag = (row: FlagRow): ItemFlags => flag(
  integer(row.watchlisted) === 1,
  nullableInteger(row.watchlisted_at_ms),
  integer(row.hidden_from_resume) === 1
)

interface HistorySqlRow {
  readonly id: string
  readonly canonical_id: string
  readonly item_name: string
  readonly media_source_id: unknown
  readonly source_name: unknown
  readonly device_name: unknown
  readonly client_name: unknown
  readonly started_at_ms: unknown
  readonly stopped_at_ms: unknown
  readonly position_ticks: unknown
  readonly runtime_ticks: unknown
  readonly completed: unknown
}

const historyRow = (row: HistorySqlRow): PlaybackHistoryRow => ({
  id: row.id,
  canonicalId: row.canonical_id,
  itemName: row.item_name,
  mediaSourceId: text(row.media_source_id),
  sourceName: text(row.source_name),
  deviceName: text(row.device_name),
  clientName: text(row.client_name),
  startedAtMs: integer(row.started_at_ms),
  stoppedAtMs: nullableInteger(row.stopped_at_ms),
  positionTicks: integer(row.position_ticks),
  runtimeTicks: nullableInteger(row.runtime_ticks),
  completed: integer(row.completed) === 1
})

const revokeConnectionTokens = (sql: SqlExec, connectionId: string) => Effect.gen(function*() {
  const links = yield* query<{ readonly token_id: string }>(
    sql,
    "revokeConnectionTokens",
    "SELECT token_id FROM emby_connection_devices WHERE connection_id = ?",
    [connectionId]
  )
  for (const link of links) {
    yield* query(sql, "revokeConnectionTokens", "DELETE FROM emby_tokens WHERE id = ?", [link.token_id])
  }
  yield* query(
    sql,
    "revokeConnectionTokens",
    "DELETE FROM emby_connection_devices WHERE connection_id = ?",
    [connectionId]
  )
})

export const makeSqlDrivembyCompat = (sql: SqlExec): Effect.Effect<DrivembyCompat, RepositoryError> =>
  Effect.gen(function*() {
    for (const statement of schema) yield* query(sql, "ensureDrivembySchema", statement)

    const readFlags = (canonicalId: string) => query<FlagRow>(
      sql,
      "readItemFlags",
      "SELECT canonical_id, watchlisted, watchlisted_at_ms, hidden_from_resume FROM item_flags WHERE canonical_id = ?",
      [canonicalId]
    ).pipe(Effect.map((rows) => rows[0] ? readFlag(rows[0]) : flag(false, null, false)))

    const flagsFor: DrivembyCompat["flagsFor"] = (ids) => {
      const unique = [...new Set(ids)]
      if (unique.length === 0) return Effect.succeed(new Map())
      const placeholders = unique.map(() => "?").join(", ")
      return query<FlagRow>(
        sql,
        "flagsFor",
        `SELECT canonical_id, watchlisted, watchlisted_at_ms, hidden_from_resume
         FROM item_flags WHERE canonical_id IN (${placeholders})`,
        unique
      ).pipe(Effect.map((rows) => new Map(rows.map((row) => [row.canonical_id, readFlag(row)]))))
    }

    const setWatchlisted: DrivembyCompat["setWatchlisted"] = (canonicalId, watchlisted, nowMs) =>
      query(
        sql,
        "setWatchlisted",
        `INSERT INTO item_flags (canonical_id, watchlisted, watchlisted_at_ms, hidden_from_resume)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(canonical_id) DO UPDATE SET
           watchlisted = excluded.watchlisted,
           watchlisted_at_ms = excluded.watchlisted_at_ms`,
        [canonicalId, watchlisted ? 1 : 0, watchlisted ? nowMs : null]
      ).pipe(Effect.flatMap(() => readFlags(canonicalId)))

    const setHiddenFromResume: DrivembyCompat["setHiddenFromResume"] = (canonicalId, hidden) =>
      query(
        sql,
        "setHiddenFromResume",
        `INSERT INTO item_flags (canonical_id, watchlisted, watchlisted_at_ms, hidden_from_resume)
         VALUES (?, 0, NULL, ?)
         ON CONFLICT(canonical_id) DO UPDATE SET hidden_from_resume = excluded.hidden_from_resume`,
        [canonicalId, hidden ? 1 : 0]
      ).pipe(Effect.flatMap(() => readFlags(canonicalId)))

    const listWatchlist: DrivembyCompat["listWatchlist"] = () => query<{
      readonly canonical_id: string
      readonly watchlisted_at_ms: unknown
    }>(
      sql,
      "listWatchlist",
      `SELECT canonical_id, watchlisted_at_ms FROM item_flags
       WHERE watchlisted = 1
       ORDER BY watchlisted_at_ms DESC, canonical_id DESC`
    ).pipe(Effect.map((rows) => rows.flatMap((row) => {
      const watchlistedAtMs = nullableInteger(row.watchlisted_at_ms)
      return watchlistedAtMs === null ? [] : [{ canonicalId: row.canonical_id, watchlistedAtMs }]
    })))

    const hiddenIds: DrivembyCompat["hiddenIds"] = () => query<{ readonly canonical_id: string }>(
      sql,
      "hiddenIds",
      "SELECT canonical_id FROM item_flags WHERE hidden_from_resume = 1"
    ).pipe(Effect.map((rows) => new Set(rows.map((row) => row.canonical_id))))

    const recordPlayback: DrivembyCompat["recordPlayback"] = (input) => input.kind === "start"
      ? query(
        sql,
        "recordPlayback",
        `INSERT INTO playback_history (
           id, play_session_id, canonical_id, item_name, media_source_id, source_name,
           device_name, client_name, started_at_ms, stopped_at_ms, position_ticks,
           runtime_ticks, completed, deleted
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 0)
         ON CONFLICT(play_session_id) DO NOTHING`,
        [
          crypto.randomUUID(),
          input.playSessionId,
          input.canonicalId,
          input.itemName,
          input.mediaSourceId,
          input.sourceName,
          input.deviceName,
          input.clientName,
          input.nowMs,
          input.positionTicks,
          input.runtimeTicks
        ]
      ).pipe(Effect.asVoid)
      : query(
        sql,
        "recordPlayback",
        `UPDATE playback_history SET
           position_ticks = ?,
           runtime_ticks = COALESCE(?, runtime_ticks),
           stopped_at_ms = CASE WHEN ? THEN ? ELSE stopped_at_ms END,
           completed = CASE WHEN ? THEN 1 ELSE completed END
         WHERE play_session_id = ? AND deleted = 0`,
        [
          input.positionTicks,
          input.runtimeTicks,
          input.kind === "stop" ? 1 : 0,
          input.nowMs,
          input.completed ? 1 : 0,
          input.playSessionId
        ]
      ).pipe(Effect.asVoid)

    const listHistory: DrivembyCompat["listHistory"] = (input) => Effect.gen(function*() {
      const filters = ["deleted = 0"]
      const params: Array<string | number> = []
      if (input.search) {
        filters.push("item_name LIKE ? ESCAPE '\\'")
        params.push(likeTerm(input.search))
      }
      if (input.itemId) {
        filters.push("canonical_id = ?")
        params.push(input.itemId)
      }
      const where = filters.join(" AND ")
      const totalRows = yield* query<{ readonly total: unknown }>(
        sql,
        "listHistory",
        `SELECT COUNT(*) AS total FROM playback_history WHERE ${where}`,
        params
      )
      const pageFilters = [...filters]
      const pageParams = [...params]
      if (input.cursor) {
        pageFilters.push("(started_at_ms < ? OR (started_at_ms = ? AND id < ?))")
        pageParams.push(input.cursor.startedAtMs, input.cursor.startedAtMs, input.cursor.id)
      }
      const offset = input.cursor ? 0 : input.startIndex
      const rows = yield* query<HistorySqlRow>(
        sql,
        "listHistory",
        `SELECT id, canonical_id, item_name, media_source_id, source_name, device_name, client_name,
                started_at_ms, stopped_at_ms, position_ticks, runtime_ticks, completed
         FROM playback_history
         WHERE ${pageFilters.join(" AND ")}
         ORDER BY started_at_ms DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...pageParams, input.limit + 1, offset]
      )
      const page = rows.slice(0, input.limit).map(historyRow)
      const last = page.at(-1)
      return {
        items: page,
        total: integer(totalRows[0]?.total ?? 0),
        nextCursor: rows.length > input.limit && last
          ? encodeHistoryCursor(last.startedAtMs, last.id)
          : null
      }
    })

    const deleteHistory: DrivembyCompat["deleteHistory"] = (id) => query<{ readonly id: string }>(
      sql,
      "deleteHistory",
      "UPDATE playback_history SET deleted = 1 WHERE id = ? AND deleted = 0 RETURNING id",
      [id]
    ).pipe(Effect.map((rows) => rows.length > 0))

    const clearHistory: DrivembyCompat["clearHistory"] = (beforeMs) => query<{ readonly id: string }>(
      sql,
      "clearHistory",
      "UPDATE playback_history SET deleted = 1 WHERE deleted = 0 AND started_at_ms <= ? RETURNING id",
      [beforeMs]
    ).pipe(Effect.map((rows) => rows.length))

    const counts: DrivembyCompat["counts"] = () => query<{
      readonly item_type: string
      readonly count: unknown
    }>(
      sql,
      "itemCounts",
      "SELECT item_type, COUNT(*) AS count FROM canonical_items GROUP BY item_type"
    ).pipe(Effect.map((rows) => {
      const byType = new Map(rows.map((row) => [row.item_type, integer(row.count)]))
      const movie = byType.get("Movie") ?? 0
      const series = byType.get("Series") ?? 0
      const episode = byType.get("Episode") ?? 0
      const itemCount = [...byType.values()].reduce((sum, count) => sum + count, 0)
      return { MovieCount: movie, SeriesCount: series, EpisodeCount: episode, ItemCount: itemCount }
    }))

    const genres: DrivembyCompat["genres"] = (startIndex, limit) => query<{
      readonly display_metadata_json: string
    }>(
      sql,
      "genres",
      `SELECT display_metadata_json FROM canonical_items
       WHERE item_type IN ('Movie', 'Series', 'Episode')`
    ).pipe(Effect.map((rows) => {
      const names = new Set<string>()
      for (const row of rows) {
        const metadata = JSON.parse(row.display_metadata_json) as { readonly Genres?: unknown }
        if (!Array.isArray(metadata.Genres)) continue
        for (const name of metadata.Genres) {
          if (typeof name === "string" && name.trim()) names.add(name)
        }
      }
      const sorted = [...names].sort((left, right) => left.localeCompare(right))
      return { names: sorted.slice(startIndex, startIndex + limit), total: sorted.length }
    }))

    const insertConnection = (name: string, password: string, nowMs: number) => Effect.gen(function*() {
      const record = yield* passwordRecord(password)
      const id = crypto.randomUUID()
      yield* query(
        sql,
        "insertConnection",
        `INSERT INTO emby_connections (
           id, name, password_hash, password_salt, password_iterations, created_at_ms, revoked_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [id, name, record.hash, record.salt, record.iterations, nowMs]
      )
      return { id, name, password, createdAtMs: nowMs }
    })

    const createConnection: DrivembyCompat["createConnection"] = (input) => Effect.gen(function*() {
      const active = yield* query<{ readonly count: unknown }>(
        sql,
        "createConnection",
        "SELECT COUNT(*) AS count FROM emby_connections WHERE revoked_at_ms IS NULL"
      )
      if (integer(active[0]?.count ?? 0) >= maxConnections) return null
      return yield* insertConnection(input.name, input.password ?? randomDigits(6), input.nowMs)
    })

    const listConnections: DrivembyCompat["listConnections"] = () => query<{
      readonly id: string
      readonly name: string
      readonly created_at_ms: unknown
      readonly token_id: unknown
      readonly device_id: unknown
      readonly device_name: unknown
      readonly last_used_at_ms: unknown
    }>(
      sql,
      "listConnections",
      `SELECT connection.id, connection.name, connection.created_at_ms,
              token.id AS token_id, token.device_id, token.device_name, token.last_used_at_ms
       FROM emby_connections connection
       LEFT JOIN emby_connection_devices link ON link.connection_id = connection.id
       LEFT JOIN emby_tokens token ON token.id = link.token_id
       WHERE connection.revoked_at_ms IS NULL
       ORDER BY connection.created_at_ms, connection.id, token.device_name`
    ).pipe(Effect.map((rows) => {
      const grouped = new Map<string, {
        id: string
        name: string
        createdAtMs: number
        devices: Array<ConnectionDevice>
      }>()
      for (const row of rows) {
        const current = grouped.get(row.id) ?? {
          id: row.id,
          name: row.name,
          createdAtMs: integer(row.created_at_ms),
          devices: []
        }
        if (row.token_id !== null && row.token_id !== undefined) {
          current.devices.push({
            id: String(row.token_id),
            deviceId: String(row.device_id),
            deviceName: String(row.device_name),
            lastUsedAtMs: integer(row.last_used_at_ms)
          })
        }
        grouped.set(row.id, current)
      }
      return [...grouped.values()]
    }))

    const updateConnection: DrivembyCompat["updateConnection"] = (input) => Effect.gen(function*() {
      const existing = yield* query<{ readonly id: string; readonly name: string; readonly created_at_ms: unknown }>(
        sql,
        "updateConnection",
        "SELECT id, name, created_at_ms FROM emby_connections WHERE id = ? AND revoked_at_ms IS NULL",
        [input.id]
      )
      const row = existing[0]
      if (!row) return null
      const password = input.password ?? randomDigits(6)
      const record = yield* passwordRecord(password)
      yield* revokeConnectionTokens(sql, input.id)
      yield* query(
        sql,
        "updateConnection",
        `UPDATE emby_connections
         SET password_hash = ?, password_salt = ?, password_iterations = ?
         WHERE id = ? AND revoked_at_ms IS NULL`,
        [record.hash, record.salt, record.iterations, input.id]
      )
      return { id: row.id, name: row.name, password, createdAtMs: integer(row.created_at_ms) }
    })

    const deleteConnection: DrivembyCompat["deleteConnection"] = (id, nowMs) => Effect.gen(function*() {
      const updated = yield* query<{ readonly id: string }>(
        sql,
        "deleteConnection",
        "UPDATE emby_connections SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL RETURNING id",
        [nowMs, id]
      )
      if (updated.length === 0) return false
      yield* revokeConnectionTokens(sql, id)
      return true
    })

    const verifyConnection: DrivembyCompat["verifyConnection"] = (password) => Effect.gen(function*() {
      const rows = yield* query<{
        readonly id: string
        readonly password_hash: unknown
        readonly password_salt: unknown
        readonly password_iterations: unknown
      }>(
        sql,
        "verifyConnection",
        `SELECT id, password_hash, password_salt, password_iterations
         FROM emby_connections WHERE revoked_at_ms IS NULL`
      )
      let matched: string | null = null
      for (const row of rows) {
        const hash = yield* derivePassword(password, bytes(row.password_salt), integer(row.password_iterations))
        if (sameBytes(hash, bytes(row.password_hash)) && matched === null) matched = row.id
      }
      return matched
    })

    const linkConnectionDevice: DrivembyCompat["linkConnectionDevice"] = (connectionId, tokenId) => query(
      sql,
      "linkConnectionDevice",
      `INSERT INTO emby_connection_devices (connection_id, token_id) VALUES (?, ?)
       ON CONFLICT(token_id) DO UPDATE SET connection_id = excluded.connection_id`,
      [connectionId, tokenId]
    ).pipe(Effect.asVoid)

    const deleteEmbyToken: DrivembyCompat["deleteEmbyToken"] = (tokenId) => query(
      sql,
      "deleteEmbyToken",
      "DELETE FROM emby_connection_devices WHERE token_id = ?",
      [tokenId]
    ).pipe(
      Effect.flatMap(() => query(sql, "deleteEmbyToken", "DELETE FROM emby_tokens WHERE id = ?", [tokenId])),
      Effect.asVoid
    )

    return {
      flagsFor,
      setWatchlisted,
      setHiddenFromResume,
      listWatchlist,
      hiddenIds,
      recordPlayback,
      listHistory,
      deleteHistory,
      clearHistory,
      counts,
      genres,
      createConnection,
      listConnections,
      updateConnection,
      deleteConnection,
      verifyConnection,
      linkConnectionDevice,
      deleteEmbyToken
    }
  })

const emptyFlags = flag(false, null, false)

export const makeMemoryDrivembyCompat = (): DrivembyCompat => {
  const flags = new Map<string, ItemFlags>()
  const history: Array<PlaybackHistoryRow & { readonly playSessionId: string; readonly deleted: boolean }> = []
  const connections: Array<{
    id: string
    name: string
    password: string
    createdAtMs: number
    hash: Uint8Array
    salt: Uint8Array
    iterations: number
    revoked: boolean
    devices: Array<ConnectionDevice>
  }> = []
  const deletedTokens = new Set<string>()

  const current = (id: string) => flags.get(id) ?? emptyFlags

  return {
    flagsFor: (ids) => Effect.sync(() => new Map(ids.map((id) => [id, current(id)]))),
    setWatchlisted: (canonicalId, watchlisted, nowMs) => Effect.sync(() => {
      const next = flag(watchlisted, watchlisted ? nowMs : null, current(canonicalId).hiddenFromResume)
      flags.set(canonicalId, next)
      return next
    }),
    setHiddenFromResume: (canonicalId, hidden) => Effect.sync(() => {
      const previous = current(canonicalId)
      const next = flag(previous.watchlisted, previous.watchlistedAtMs, hidden)
      flags.set(canonicalId, next)
      return next
    }),
    listWatchlist: () => Effect.sync(() => [...flags.entries()].flatMap(([canonicalId, value]) =>
      value.watchlisted && value.watchlistedAtMs !== null
        ? [{ canonicalId, watchlistedAtMs: value.watchlistedAtMs }]
        : []
    ).sort((left, right) => right.watchlistedAtMs - left.watchlistedAtMs || right.canonicalId.localeCompare(left.canonicalId))),
    hiddenIds: () => Effect.sync(() => new Set([...flags.entries()].flatMap(([id, value]) =>
      value.hiddenFromResume ? [id] : []
    ))),
    recordPlayback: (input) => Effect.sync(() => {
      const existing = history.find((row) => row.playSessionId === input.playSessionId)
      if (input.kind === "start") {
        if (existing) return
        history.push({
          id: crypto.randomUUID(),
          playSessionId: input.playSessionId,
          canonicalId: input.canonicalId,
          itemName: input.itemName,
          mediaSourceId: input.mediaSourceId,
          sourceName: input.sourceName,
          deviceName: input.deviceName,
          clientName: input.clientName,
          startedAtMs: input.nowMs,
          stoppedAtMs: null,
          positionTicks: input.positionTicks,
          runtimeTicks: input.runtimeTicks,
          completed: false,
          deleted: false
        })
        return
      }
      if (!existing || existing.deleted) return
      const index = history.indexOf(existing)
      history[index] = {
        ...existing,
        positionTicks: input.positionTicks,
        runtimeTicks: input.runtimeTicks ?? existing.runtimeTicks,
        stoppedAtMs: input.kind === "stop" ? input.nowMs : existing.stoppedAtMs,
        completed: input.completed || existing.completed
      }
    }),
    listHistory: (queryInput) => Effect.sync(() => {
      const visible = history.filter((row) => !row.deleted
        && (queryInput.search === null || row.itemName.toLowerCase().includes(queryInput.search.toLowerCase()))
        && (queryInput.itemId === null || row.canonicalId === queryInput.itemId))
        .sort((left, right) => right.startedAtMs - left.startedAtMs || right.id.localeCompare(left.id))
      const paged = queryInput.cursor
        ? visible.filter((row) => row.startedAtMs < queryInput.cursor!.startedAtMs
          || (row.startedAtMs === queryInput.cursor!.startedAtMs && row.id < queryInput.cursor!.id))
        : visible.slice(queryInput.startIndex)
      const items = paged.slice(0, queryInput.limit)
      const last = items.at(-1)
      return {
        items,
        total: visible.length,
        nextCursor: paged.length > queryInput.limit && last
          ? encodeHistoryCursor(last.startedAtMs, last.id)
          : null
      }
    }),
    deleteHistory: (id) => Effect.sync(() => {
      const row = history.find((entry) => entry.id === id && !entry.deleted)
      if (!row) return false
      const index = history.indexOf(row)
      history[index] = { ...row, deleted: true }
      return true
    }),
    clearHistory: (beforeMs) => Effect.sync(() => {
      let deleted = 0
      for (let index = 0; index < history.length; index += 1) {
        const row = history[index]!
        if (!row.deleted && row.startedAtMs <= beforeMs) {
          history[index] = { ...row, deleted: true }
          deleted += 1
        }
      }
      return deleted
    }),
    counts: () => Effect.succeed({ MovieCount: 0, SeriesCount: 0, EpisodeCount: 0, ItemCount: 0 }),
    genres: () => Effect.succeed({ names: [], total: 0 }),
    createConnection: (input) => Effect.promise(async () => {
      if (connections.filter((connection) => !connection.revoked).length >= maxConnections) return null
      const password = input.password ?? randomDigits(6)
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const hash = await Effect.runPromise(derivePassword(password, salt, PBKDF2_ITERATIONS))
      const created = {
        id: crypto.randomUUID(),
        name: input.name,
        password,
        createdAtMs: input.nowMs,
        hash,
        salt,
        iterations: PBKDF2_ITERATIONS,
        revoked: false,
        devices: []
      }
      connections.push(created)
      return { id: created.id, name: created.name, password, createdAtMs: created.createdAtMs }
    }),
    listConnections: () => Effect.sync(() => connections.filter((connection) => !connection.revoked).map((connection) => ({
      id: connection.id,
      name: connection.name,
      createdAtMs: connection.createdAtMs,
      devices: connection.devices
    }))),
    updateConnection: (input) => Effect.promise(async () => {
      const connection = connections.find((entry) => entry.id === input.id && !entry.revoked)
      if (!connection) return null
      const password = input.password ?? randomDigits(6)
      const salt = crypto.getRandomValues(new Uint8Array(16))
      connection.hash = await Effect.runPromise(derivePassword(password, salt, PBKDF2_ITERATIONS))
      connection.salt = salt
      connection.iterations = PBKDF2_ITERATIONS
      connection.devices = []
      return { id: connection.id, name: connection.name, password, createdAtMs: connection.createdAtMs }
    }),
    deleteConnection: (id) => Effect.sync(() => {
      const connection = connections.find((entry) => entry.id === id && !entry.revoked)
      if (!connection) return false
      connection.revoked = true
      for (const device of connection.devices) deletedTokens.add(device.id)
      connection.devices = []
      return true
    }),
    verifyConnection: (password) => Effect.promise(async () => {
      let matched: string | null = null
      for (const connection of connections) {
        if (connection.revoked) continue
        const hash = await Effect.runPromise(derivePassword(password, connection.salt, connection.iterations))
        if (sameBytes(hash, connection.hash) && matched === null) matched = connection.id
      }
      return matched
    }),
    linkConnectionDevice: (connectionId, tokenId) => Effect.sync(() => {
      const connection = connections.find((entry) => entry.id === connectionId && !entry.revoked)
      if (!connection) return
      connection.devices.push({
        id: tokenId,
        deviceId: tokenId,
        deviceName: tokenId,
        lastUsedAtMs: connection.createdAtMs
      })
    }),
    deleteEmbyToken: (tokenId) => Effect.sync(() => {
      deletedTokens.add(tokenId)
      for (const connection of connections) {
        connection.devices = connection.devices.filter((device) => device.id !== tokenId)
      }
    })
  }
}
