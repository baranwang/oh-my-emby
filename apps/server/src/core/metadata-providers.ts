import { Context, Effect, Layer, Result, Schema } from "effect"

import { METADATA_FRESH_MS, METADATA_STALE_MS } from "./limits.js"
import type {
  ExternalMetadataCacheEntry,
  JsonValue,
  MetadataProviderSetting
} from "./model.js"
import { Repositories, type CatalogItemRecord } from "./repositories.js"

const PROVIDER_DEADLINE_MS = 5_000
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024
const PRODUCT_USER_AGENT = "oh-my-emby/0.0.0"

type ProviderId = MetadataProviderSetting["id"]
type FailureReason = "credential" | "rate-limit" | "timeout" | "unavailable" | "invalid-response"

export interface ExternalMetadataPayload {
  readonly Name?: string
  readonly Overview?: string
  readonly ExternalImages?: {
    readonly Primary?: string
    readonly Backdrop?: ReadonlyArray<string>
  }
}

export class MetadataProviderFailure extends Schema.TaggedError<MetadataProviderFailure>()(
  "MetadataProviderFailure",
  {
    providerId: Schema.Literals(["tmdb", "trakt"]),
    reason: Schema.Literals(["credential", "rate-limit", "timeout", "unavailable", "invalid-response"])
  }
) {}

export interface MetadataProvidersApi {
  readonly refresh: (
    record: CatalogItemRecord
  ) => Effect.Effect<CatalogItemRecord, import("./errors.js").RepositoryError>
  readonly overlayCached: (
    record: CatalogItemRecord
  ) => Effect.Effect<CatalogItemRecord, import("./errors.js").RepositoryError>
  readonly resolveCachedImage: (
    record: CatalogItemRecord,
    imageType: string,
    imageIndex?: number
  ) => Effect.Effect<URL | null, import("./errors.js").RepositoryError>
}

export class MetadataProviders extends Context.Service<MetadataProviders, MetadataProvidersApi>()(
  "oh-my-emby/MetadataProviders"
) {}

export interface MetadataProvidersConfig {
  readonly fetch: typeof globalThis.fetch
  readonly now?: () => number
  readonly deadlineMs?: number
  readonly maxResponseBytes?: number
}

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  return normalized === "" ? undefined : normalized
}

const allowedImage = (
  providerId: ProviderId,
  value: string,
  tmdbSize?: "w780" | "w1280"
): string | undefined => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const hostname = providerId === "tmdb" ? "image.tmdb.org" : "walter-r2.trakt.tv"
  return url.protocol === "https:" &&
    url.hostname === hostname &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    (providerId !== "tmdb" || tmdbSize === undefined || url.pathname.startsWith(`/t/p/${tmdbSize}/`))
    ? url.href
    : undefined
}

const tmdbImage = (path: unknown, size: "w780" | "w1280"): string | undefined => {
  const value = text(path)
  if (value === undefined || !/^\/[A-Za-z0-9_./-]+$/.test(value)) return undefined
  return allowedImage("tmdb", `https://image.tmdb.org/t/p/${size}${value}`, size)
}

const imageValues = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string")
  if (object(value) && typeof value.full === "string") return [value.full]
  return []
}

const traktImages = (value: unknown): ReadonlyArray<string> => imageValues(value).flatMap((raw) => {
  const normalized = raw.startsWith("//") ? `https:${raw}` : raw
  const accepted = allowedImage("trakt", normalized)
  return accepted === undefined ? [] : [accepted]
})

const payload = (
  name: string | undefined,
  overview: string | undefined,
  primary: string | undefined,
  backdrops: ReadonlyArray<string>
): ExternalMetadataPayload => ({
  ...(name === undefined ? {} : { Name: name }),
  ...(overview === undefined ? {} : { Overview: overview }),
  ...(primary === undefined && backdrops.length === 0
    ? {}
    : { ExternalImages: {
        ...(primary === undefined ? {} : { Primary: primary }),
        ...(backdrops.length === 0 ? {} : { Backdrop: backdrops })
      } })
})

const tmdbPayload = (value: unknown, itemType: string): ExternalMetadataPayload | null => {
  if (!object(value)) throw new TypeError("invalid TMDB response")
  const results = itemType === "Movie" ? value.movie_results : value.tv_results
  if (!Array.isArray(results)) throw new TypeError("invalid TMDB response")
  if (results.length === 0) return null
  const first = results[0]
  if (!object(first)) throw new TypeError("invalid TMDB result")
  return payload(
    text(itemType === "Movie" ? first.title : first.name),
    text(first.overview),
    tmdbImage(first.poster_path, "w780"),
    [tmdbImage(first.backdrop_path, "w1280")].filter((entry): entry is string => entry !== undefined)
  )
}

const traktPayload = (value: unknown): ExternalMetadataPayload => {
  if (!object(value)) throw new TypeError("invalid Trakt response")
  const images = object(value.images) ? value.images : {}
  return payload(
    text(value.title),
    text(value.overview),
    traktImages(images.poster)[0],
    traktImages(images.fanart)
  )
}

const cachedPayload = (
  providerId: ProviderId,
  value: JsonValue | null
): ExternalMetadataPayload | null => {
  if (!object(value)) return null
  const images = object(value.ExternalImages) ? value.ExternalImages : {}
  const primary = text(images.Primary)
  const backdrops = Array.isArray(images.Backdrop)
    ? images.Backdrop.flatMap((entry) => {
        const candidate = text(entry)
        const accepted = candidate === undefined
          ? undefined
          : allowedImage(providerId, candidate, providerId === "tmdb" ? "w1280" : undefined)
        return accepted === undefined ? [] : [accepted]
      })
    : []
  const acceptedPrimary = primary === undefined
    ? undefined
    : allowedImage(providerId, primary, providerId === "tmdb" ? "w780" : undefined)
  return payload(text(value.Name), text(value.Overview), acceptedPrimary, backdrops)
}

const mergePayloads = (
  payloads: ReadonlyArray<ExternalMetadataPayload>
): ExternalMetadataPayload => {
  const first = <A>(pick: (entry: ExternalMetadataPayload) => A | undefined): A | undefined => {
    for (const entry of payloads) {
      const value = pick(entry)
      if (value !== undefined && (!Array.isArray(value) || value.length > 0)) return value
    }
  }
  return payload(
    first(({ Name }) => Name),
    first(({ Overview }) => Overview),
    first(({ ExternalImages }) => ExternalImages?.Primary),
    first(({ ExternalImages }) => ExternalImages?.Backdrop) ?? []
  )
}

const readBoundedJson = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<unknown> => {
  const advertised = response.headers.get("content-length")
  if (advertised !== null && /^\d+$/.test(advertised) && Number(advertised) > maxBytes) {
    throw new TypeError("provider response too large")
  }
  if (response.body === null) throw new TypeError("provider response body missing")
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Array<Uint8Array> = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new TypeError("provider response too large")
      }
      chunks.push(next.value)
    }
  } finally {
    signal.removeEventListener("abort", abort)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body))
}

const providerFailure = (providerId: ProviderId, reason: FailureReason) =>
  new MetadataProviderFailure({ providerId, reason })

export const makeMetadataProvidersLayer = (
  config: MetadataProvidersConfig
): Layer.Layer<MetadataProviders, never, Repositories> => Layer.effect(
  MetadataProviders,
  Effect.gen(function*() {
    const repositories = yield* Repositories
    const now = config.now ?? Date.now
    const deadlineMs = config.deadlineMs ?? PROVIDER_DEADLINE_MS
    const maxResponseBytes = config.maxResponseBytes ?? MAX_PROVIDER_RESPONSE_BYTES

    const updateStatus = (providerId: ProviderId, status: "ready" | "degraded") => Effect.gen(function*() {
      const current = yield* repositories.readMetadataSettings()
      const provider = current.find(({ id }) => id === providerId)
      if (provider === undefined || provider.status === status || provider.credential === null) return
      yield* repositories.writeMetadataSettings(current.map((setting) => setting.id === providerId
        ? { ...setting, status }
        : setting
      ) as unknown as [MetadataProviderSetting, MetadataProviderSetting])
    })

    const requestJson = (
      setting: MetadataProviderSetting,
      request: Request
    ): Effect.Effect<{ readonly found: boolean; readonly value: unknown }, MetadataProviderFailure> => Effect.gen(function*() {
      const response = yield* Effect.tryPromise({
        try: (signal) => config.fetch(new Request(request, { signal, redirect: "error" })),
        catch: () => providerFailure(setting.id, "unavailable")
      })
      if (response.status === 404) return { found: false, value: null }
      if (response.status === 401 || response.status === 403) {
        return yield* Effect.fail(providerFailure(setting.id, "credential"))
      }
      if (response.status === 429) return yield* Effect.fail(providerFailure(setting.id, "rate-limit"))
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(providerFailure(setting.id, "unavailable"))
      }
      const value = yield* Effect.tryPromise({
        try: (signal) => readBoundedJson(response, maxResponseBytes, signal),
        catch: () => providerFailure(setting.id, "invalid-response")
      })
      return { found: true, value }
    }).pipe(
      Effect.timeout(deadlineMs),
      Effect.catchTag("TimeoutError", () => Effect.fail(providerFailure(setting.id, "timeout")))
    )

    const fetchPayload = (
      setting: MetadataProviderSetting,
      itemType: string,
      imdbId: string
    ): Effect.Effect<ExternalMetadataPayload | null, MetadataProviderFailure> => Effect.gen(function*() {
      if (setting.credential === null) return null
      if (setting.id === "tmdb") {
        const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`)
        url.searchParams.set("external_source", "imdb_id")
        if (setting.language?.trim()) url.searchParams.set("language", setting.language.trim())
        const result = yield* requestJson(setting, new Request(url, { headers: {
          authorization: `Bearer ${setting.credential}`,
          accept: "application/json"
        } }))
        if (!result.found) return null
        return yield* Effect.try({
          try: () => tmdbPayload(result.value, itemType),
          catch: () => providerFailure(setting.id, "invalid-response")
        })
      }
      const kind = itemType === "Movie" ? "movies" : "shows"
      const url = new URL(`https://api.trakt.tv/${kind}/${encodeURIComponent(imdbId)}`)
      url.searchParams.set("extended", "full")
      const result = yield* requestJson(setting, new Request(url, { headers: {
        accept: "application/json",
        "content-type": "application/json",
        "trakt-api-key": setting.credential,
        "trakt-api-version": "2",
        "user-agent": PRODUCT_USER_AGENT
      } }))
      if (!result.found) return null
      return yield* Effect.try({
        try: () => traktPayload(result.value),
        catch: () => providerFailure(setting.id, "invalid-response")
      })
    })

    const identity = (record: CatalogItemRecord) => {
      if (record.canonical.itemType !== "Movie" && record.canonical.itemType !== "Series") return null
      const claim = record.claims.find(({ namespace, state }) => namespace === "imdb:title" && state === "exact")
      return claim === undefined ? null : { namespace: claim.namespace, value: claim.value }
    }

    const readCached = (
      setting: MetadataProviderSetting,
      key: { readonly namespace: string; readonly value: string },
      freshOnly: boolean
    ) => repositories.readExternalMetadata(setting.id, key.namespace, key.value).pipe(Effect.map((entry) => {
      if (entry === null || entry.fetchedAtMs < setting.updatedAtMs) return null
      const usableUntil = freshOnly ? entry.freshUntilMs : entry.staleUntilMs
      return usableUntil > now() ? entry : null
    }))

    const writeCache = (
      setting: MetadataProviderSetting,
      key: { readonly namespace: string; readonly value: string },
      value: ExternalMetadataPayload | null
    ) => {
      const fetchedAtMs = now()
      const entry: ExternalMetadataCacheEntry = {
        providerId: setting.id,
        identityNamespace: key.namespace,
        identityValue: key.value,
        payload: value as JsonValue | null,
        found: value !== null,
        fetchedAtMs,
        freshUntilMs: fetchedAtMs + METADATA_FRESH_MS,
        staleUntilMs: fetchedAtMs + (value === null ? METADATA_FRESH_MS : METADATA_STALE_MS)
      }
      return repositories.writeExternalMetadata(entry)
    }

    const configured = () => repositories.readMetadataSettings().pipe(Effect.map((providers) =>
      [...providers]
        .sort((left, right) => left.order - right.order)
        .filter(({ enabled, credential }) => enabled && credential !== null)
    ))

    const cachedPayloads = (record: CatalogItemRecord) => Effect.gen(function*() {
      const key = identity(record)
      if (key === null) return []
      const values: Array<ExternalMetadataPayload> = []
      for (const setting of yield* configured()) {
        const entry = yield* readCached(setting, key, false)
        const normalized = entry?.found ? cachedPayload(setting.id, entry.payload) : null
        if (normalized !== null) values.push(normalized)
      }
      return values
    })

    const overlayCached: MetadataProvidersApi["overlayCached"] = (record) => Effect.gen(function*() {
      const external = mergePayloads(yield* cachedPayloads(record))
      return {
        ...record,
        canonical: {
          ...record.canonical,
          displayMetadata: {
            ...(object(record.canonical.displayMetadata) ? record.canonical.displayMetadata : {}),
            ...external
          }
        }
      }
    })

    const refresh: MetadataProvidersApi["refresh"] = (record) => Effect.gen(function*() {
      const key = identity(record)
      if (key === null) return record
      const values: Array<ExternalMetadataPayload> = []
      for (const setting of yield* configured()) {
        const fresh = yield* readCached(setting, key, true)
        if (fresh !== null) {
          const normalized = fresh.found ? cachedPayload(setting.id, fresh.payload) : null
          if (normalized !== null) values.push(normalized)
          continue
        }
        const stale = yield* readCached(setting, key, false)
        const attempted = yield* fetchPayload(setting, record.canonical.itemType, key.value).pipe(Effect.result)
        if (Result.isFailure(attempted)) {
          yield* updateStatus(setting.id, "degraded")
          const normalized = stale?.found ? cachedPayload(setting.id, stale.payload) : null
          if (normalized !== null) values.push(normalized)
          continue
        }
        yield* writeCache(setting, key, attempted.success)
        yield* updateStatus(setting.id, "ready")
        if (attempted.success !== null) values.push(attempted.success)
      }
      const external = mergePayloads(values)
      return {
        ...record,
        canonical: {
          ...record.canonical,
          displayMetadata: {
            ...(object(record.canonical.displayMetadata) ? record.canonical.displayMetadata : {}),
            ...external
          }
        }
      }
    })

    const resolveCachedImage: MetadataProvidersApi["resolveCachedImage"] = (
      record,
      imageType,
      imageIndex
    ) => Effect.gen(function*() {
      if (imageType !== "Primary" && imageType !== "Backdrop") return null
      if (imageIndex !== undefined && (!Number.isSafeInteger(imageIndex) || imageIndex < 0)) return null
      const images = mergePayloads(yield* cachedPayloads(record)).ExternalImages
      if (!object(images)) return null
      const selected = imageType === "Primary"
        ? ((imageIndex ?? 0) === 0 ? text(images.Primary) : undefined)
        : (Array.isArray(images.Backdrop) ? text(images.Backdrop[imageIndex ?? 0]) : undefined)
      if (selected === undefined) return null
      const providerId = selected.includes("image.tmdb.org") ? "tmdb" : "trakt"
      const accepted = allowedImage(
        providerId,
        selected,
        providerId === "tmdb" ? (imageType === "Primary" ? "w780" : "w1280") : undefined
      )
      return accepted === undefined ? null : new URL(accepted)
    })

    return MetadataProviders.of({ refresh, overlayCached, resolveCachedImage })
  })
)
