import { Context, Effect, Exit, Layer, Schema, Scope } from "effect"

import type { FederationFailure } from "./federation.js"
import { Federation } from "./federation.js"
import {
  AUXILIARY_PROXY_DEADLINE_MS,
  IMAGE_CACHE_TTL_MS,
  MAX_IMAGE_BYTES,
  MAX_SUBTITLE_BYTES
} from "./limits.js"
import type { EligibleSource, JsonValue, SourceItemRecord, SourceMediaVersion } from "./model.js"
import { MetadataProviders } from "./metadata-providers.js"
import {
  ResourceCacheError,
  type CachedResource,
  type CountedResource,
  type ResourceCacheService
} from "./resource-cache.js"
import { Repositories, type CatalogItemRecord } from "./repositories.js"
import { UpstreamClient, endpointUrl } from "./upstream-client.js"

export class PlaybackNotFound extends Schema.TaggedError<PlaybackNotFound>()("PlaybackNotFound", {}) {}
export class PlaybackUnavailable extends Schema.TaggedError<PlaybackUnavailable>()("PlaybackUnavailable", {}) {}
export class ResourceRejected extends Schema.TaggedError<ResourceRejected>()("ResourceRejected", {}) {}
export class ResourceTooLarge extends Schema.TaggedError<ResourceTooLarge>()("ResourceTooLarge", {}) {}
export class ResourceTimeout extends Schema.TaggedError<ResourceTimeout>()("ResourceTimeout", {}) {}
export class ResourceInvalidResponse extends Schema.TaggedError<ResourceInvalidResponse>()(
  "ResourceInvalidResponse",
  {}
) {}
export class ResourceUnavailable extends Schema.TaggedError<ResourceUnavailable>()("ResourceUnavailable", {}) {}

export type PlaybackFailure = PlaybackNotFound | PlaybackUnavailable | FederationFailure
export type ResourceFailure =
  | PlaybackFailure
  | ResourceRejected
  | ResourceTooLarge
  | ResourceTimeout
  | ResourceInvalidResponse
  | ResourceUnavailable
  | ResourceCacheError

export interface PlaybackInfo {
  readonly playSessionId: string
  readonly mediaSources: ReadonlyArray<JsonValue>
}

export interface VideoSelection {
  readonly canonicalId: string
  readonly mediaSourceId?: string
  readonly clientUserAgent?: string
}

export interface ImageSelection {
  readonly canonicalId: string
  readonly imageType: string
  readonly imageIndex?: number
  readonly clientUserAgent?: string
}

export interface SubtitleSelection {
  readonly canonicalId: string
  readonly mediaSourceId: string
  readonly streamIndex: number
  readonly format: string
  readonly clientUserAgent?: string
}

export interface RegisteredResourceRequest {
  readonly key: string
  readonly kind: "image" | "subtitle"
  readonly serverId: string
  readonly generation: number
  readonly url: URL
  readonly maxBytes: number
  readonly acceptedMimeTypes: ReadonlyArray<string>
  readonly open: () => Effect.Effect<Response, ResourceFailure, Scope.Scope>
}

export type ResourceDecision =
  | { readonly _tag: "Redirect"; readonly location: URL }
  | { readonly _tag: "Proxy"; readonly request: RegisteredResourceRequest }

export interface PlaybackService {
  readonly getInfo: (canonicalId: string, clientUserAgent?: string) => Effect.Effect<PlaybackInfo, PlaybackFailure>
  readonly resolveVideoRedirect: (input: VideoSelection) => Effect.Effect<URL, PlaybackFailure>
  readonly resolveImage: (input: ImageSelection) => Effect.Effect<ResourceDecision, ResourceFailure>
  readonly resolveSubtitle: (input: SubtitleSelection) => Effect.Effect<ResourceDecision, ResourceFailure>
}

export class Playback extends Context.Service<Playback, PlaybackService>()("oh-my-emby/Playback") {}

export interface PlaybackConfig {
  readonly sessionId?: () => string
  readonly isClientUsableResource?: (input: {
    readonly kind: "image" | "subtitle"
    readonly serverId: string
    readonly url: URL
  }) => boolean
}

const jsonObject = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const sourceKey = (serverId: string, sourceLibraryId: string) => `${serverId}\0${sourceLibraryId}`

const orderedVersions = (
  record: CatalogItemRecord,
  eligibleSources: ReadonlyArray<EligibleSource>
): ReadonlyArray<SourceMediaVersion> => {
  const items = new Map(record.sourceItems.map((item) => [item.id, item]))
  const order = new Map(eligibleSources.map((source) => [
    sourceKey(source.serverId, source.sourceLibraryId),
    source.sourceOrder
  ]))
  return [...record.mediaVersions].sort((left, right) => {
    const leftItem = items.get(left.sourceItemId)
    const rightItem = items.get(right.sourceItemId)
    const leftOrder = leftItem === undefined
      ? Number.MAX_SAFE_INTEGER
      : (order.get(sourceKey(leftItem.serverId, leftItem.sourceLibraryId)) ?? Number.MAX_SAFE_INTEGER)
    const rightOrder = rightItem === undefined
      ? Number.MAX_SAFE_INTEGER
      : (order.get(sourceKey(rightItem.serverId, rightItem.sourceLibraryId)) ?? Number.MAX_SAFE_INTEGER)
    return (
      leftOrder - rightOrder ||
      (leftItem?.serverId ?? "").localeCompare(rightItem?.serverId ?? "") ||
      (leftItem?.upstreamItemId ?? "").localeCompare(rightItem?.upstreamItemId ?? "") ||
      left.upstreamMediaSourceId.localeCompare(right.upstreamMediaSourceId)
    )
  })
}

const orderedSourceItems = (
  record: CatalogItemRecord,
  eligibleSources: ReadonlyArray<EligibleSource>
): ReadonlyArray<SourceItemRecord> => {
  const order = new Map(eligibleSources.map((source) => [
    sourceKey(source.serverId, source.sourceLibraryId),
    source.sourceOrder
  ]))
  return [...record.sourceItems].sort((left, right) =>
    (order.get(sourceKey(left.serverId, left.sourceLibraryId)) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(sourceKey(right.serverId, right.sourceLibraryId)) ?? Number.MAX_SAFE_INTEGER) ||
    left.serverId.localeCompare(right.serverId) ||
    left.upstreamItemId.localeCompare(right.upstreamItemId) ||
    left.id.localeCompare(right.id)
  )
}

const tokenized = (url: URL, source: EligibleSource): URL => {
  if (source.accessToken !== null) url.searchParams.set("api_key", source.accessToken)
  return url
}

const eligibleEndpoint = (source: EligibleSource) =>
  source.endpoints.find(
    (endpoint) => endpoint.health === "healthy" && endpoint.verifiedCatalogId === source.verifiedCatalogId
  )!

const mediaPath = (canonicalId: string, versionId: string) =>
  `/Videos/${encodeURIComponent(canonicalId)}/stream?MediaSourceId=${encodeURIComponent(versionId)}`

const subtitlePath = (
  canonicalId: string,
  versionId: string,
  index: number,
  format: string
) => `/Videos/${encodeURIComponent(canonicalId)}/${encodeURIComponent(versionId)}` +
  `/Subtitles/${index}/Stream.${encodeURIComponent(format)}`

const streamFields = [
  "Index", "Type", "Codec", "CodecTag", "Language", "DisplayTitle", "Title", "Profile",
  "Level", "AspectRatio", "PixelFormat", "VideoRange", "ChannelLayout", "SampleRate",
  "Channels", "BitRate", "BitDepth", "Width", "Height", "AverageFrameRate",
  "RealFrameRate", "IsDefault", "IsForced", "IsExternal", "IsTextSubtitleStream",
  "IsInterlaced", "IsAVC", "IsAnamorphic", "SupportsExternalStream"
] as const

const scalar = (value: JsonValue | undefined): value is string | number | boolean =>
  typeof value === "string" || typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value))

const publicStreams = (
  canonicalId: string,
  version: SourceMediaVersion
): ReadonlyArray<JsonValue> => Array.isArray(version.streams)
  ? version.streams.flatMap((entry): ReadonlyArray<JsonValue> => {
      if (!jsonObject(entry)) return []
      const output = Object.fromEntries(streamFields.flatMap((key) => (scalar(entry[key]) ? [[key, entry[key]]] : []))
        )
        const index = entry.Index
      const format = typeof entry.Codec === "string" ? entry.Codec.toLowerCase() : ""
      if (
        typeof index === "number" && Number.isSafeInteger(index) && index >= 0 &&
        entry.Type === "Subtitle" && entry.IsExternal === true && textSubtitle(format, entry)
      ) output.DeliveryUrl = subtitlePath(canonicalId, version.id, index, format)
      return Object.keys(output).length === 0 ? [] : [output as JsonValue]
    })
  : []

const mediaSource = (canonicalId: string, version: SourceMediaVersion): JsonValue => {
  const details = jsonObject(version.capabilities) ? version.capabilities : {}
  const keep = ["Protocol", "Container", "Size", "RunTimeTicks", "Bitrate", "VideoType", "IsRemote"] as const
  const local = mediaPath(canonicalId, version.id)
  return {
    ...Object.fromEntries(keep.flatMap((key) => (scalar(details[key]) ? [[key, details[key]]] : []))),
    Id: version.id,
    Name: version.label,
    Path: local,
    DirectStreamUrl: local,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: false,
    MediaStreams: publicStreams(canonicalId, version)
  }
}

const subtitleFormats = new Set(["srt", "vtt", "ass", "ssa", "ttml"])
const bitmapSubtitleFormats = new Set(["pgs", "pgssub", "dvbsub", "dvdsub", "vobsub", "hdmv_pgs_subtitle"])

const textSubtitle = (format: string, stream: Readonly<Record<string, JsonValue>>): boolean =>
  subtitleFormats.has(format) && !bitmapSubtitleFormats.has(format) && stream.IsTextSubtitleStream !== false

const imageMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]
const subtitleMimeTypes: Readonly<Record<string, ReadonlyArray<string>>> = {
  srt: ["application/x-subrip", "text/srt", "text/plain"],
  vtt: ["text/vtt", "text/plain"],
  ass: ["text/x-ass", "text/plain"],
  ssa: ["text/x-ssa", "text/plain"],
  ttml: ["application/ttml+xml", "application/xml", "text/xml"]
}

export const makePlaybackLayer = (
  config: PlaybackConfig = {}
): Layer.Layer<Playback, never, Federation | MetadataProviders | Repositories | UpstreamClient> => Layer.effect(
  Playback,
  Effect.gen(function*() {
    const federation = yield* Federation
    const metadataProviders = yield* MetadataProviders
    const repositories = yield* Repositories
    const upstream = yield* UpstreamClient
    const sessionId = config.sessionId ?? (() => crypto.randomUUID())
    const isClientUsableResource = config.isClientUsableResource ?? (() => false)

    const record = (canonicalId: string, enrich: boolean, clientUserAgent?: string) => Effect.gen(function*() {
      const membership = enrich
        ? yield* federation.enrichVersions(canonicalId, clientUserAgent)
        : ((yield* federation.lookupMembership(canonicalId))?.item ?? null)
          if (membership === null) return yield* Effect.fail(new PlaybackNotFound())
      const current = (yield* repositories.readCatalogItems([membership.id]))[0]
      if (!current) return yield* Effect.fail(new PlaybackNotFound())
      const eligibleSources = yield* repositories.resolveEligibleSourcesForCanonical(membership.id)
      return { current, eligibleSources }
    })

    const sourceRegistration = (
      item: SourceItemRecord,
      eligibleSources: ReadonlyArray<EligibleSource>,
      build: (source: EligibleSource) => URL
    ): Effect.Effect<{ readonly source: EligibleSource; readonly url: URL }, PlaybackUnavailable> =>
      Effect.gen(function*() {
        const eligible = yield* repositories.isSourceEligible(item.serverId, item.sourceLibraryId)
          .pipe(Effect.mapError(() => new PlaybackUnavailable()))
        const source = eligibleSources.find((candidate) =>
          candidate.serverId === item.serverId &&
          candidate.sourceLibraryId === item.sourceLibraryId &&
          candidate.serverGeneration === item.serverGeneration &&
              candidate.endpoints.some(
                (endpoint) =>
                  endpoint.health === "healthy" && endpoint.verifiedCatalogId === candidate.verifiedCatalogId
              )
          )
          if (!eligible || source === undefined) return yield* Effect.fail(new PlaybackUnavailable())
        return { source, url: build(source) }
      })

    const registration = (
      item: SourceItemRecord,
      version: SourceMediaVersion,
      eligibleSources: ReadonlyArray<EligibleSource>,
      build: (source: EligibleSource) => URL
    ): Effect.Effect<{ readonly source: EligibleSource; readonly resolved: URL }, PlaybackUnavailable> =>
      item.serverGeneration !== version.serverGeneration
        ? Effect.fail(new PlaybackUnavailable())
        : sourceRegistration(item, eligibleSources, build).pipe(Effect.flatMap(({ source, url }) => {
            const capabilities = jsonObject(version.capabilities) ? version.capabilities : {}
            return upstream.resolvePlayback({
              ...version,
              capabilities: { ...capabilities, serverId: source.serverId, url: url.href }
            }).pipe(
              Effect.mapError(() => new PlaybackUnavailable()),
              Effect.map((resolved) => ({ source, resolved: new URL(resolved.url) }))
            )
          }))

    const versionRegistration = (
      record: CatalogItemRecord,
      eligibleSources: ReadonlyArray<EligibleSource>,
      version: SourceMediaVersion,
      build: (source: EligibleSource, item: SourceItemRecord) => URL
    ) => {
      const item = record.sourceItems.find(({ id }) => id === version.sourceItemId)
      return item === undefined
        ? Effect.fail(new PlaybackUnavailable())
        : registration(item, version, eligibleSources, (source) => build(source, item))
    }

    const registeredVideo = (
      record: CatalogItemRecord,
      eligibleSources: ReadonlyArray<EligibleSource>,
      version: SourceMediaVersion
    ) => versionRegistration(record, eligibleSources, version, (source, item) => {
      const url = endpointUrl(eligibleEndpoint(source), `/Videos/${encodeURIComponent(item.upstreamItemId)}/stream`)
      url.searchParams.set("MediaSourceId", version.upstreamMediaSourceId)
      url.searchParams.set("Static", "true")
      return tokenized(url, source)
    })

    const video = (
      record: CatalogItemRecord,
      eligibleSources: ReadonlyArray<EligibleSource>,
      version: SourceMediaVersion
    ) => registeredVideo(record, eligibleSources, version).pipe(Effect.map(({ resolved }) => resolved))

    const videoRedirect = (
      record: CatalogItemRecord,
      eligibleSources: ReadonlyArray<EligibleSource>,
      version: SourceMediaVersion,
        clientUserAgent?: string
      ) => registeredVideo(record, eligibleSources, version).pipe(Effect.flatMap(({ source, resolved }) =>
      upstream.resolvePlaybackRedirect({
        serverId: source.serverId,
        generation: source.serverGeneration,
        url: resolved.href,
                ...(clientUserAgent === undefined ? {} : { clientUserAgent })
              })
              .pipe(Effect.mapError(() => new PlaybackUnavailable()))
    ))

    const getInfo: PlaybackService["getInfo"] = (canonicalId, clientUserAgent) => Effect.gen(function*() {
      const { current, eligibleSources } = yield* record(canonicalId, true, clientUserAgent)
      const available: Array<SourceMediaVersion> = []
      for (const version of orderedVersions(current, eligibleSources)) {
        if (yield* Effect.isSuccess(video(current, eligibleSources, version))) available.push(version)
      }
      if (available.length === 0) return yield* Effect.fail(new PlaybackUnavailable())
      return {
        playSessionId: sessionId(),
        mediaSources: available.map((version) => mediaSource(current.canonical.id, version))
      }
    })

    const resolveVideoRedirect: PlaybackService["resolveVideoRedirect"] = (input) => Effect.gen(function*() {
      const { current, eligibleSources } = yield* record(input.canonicalId, false)
      const versions = orderedVersions(current, eligibleSources)
      if (input.mediaSourceId !== undefined) {
        const selected = versions.find(({ id }) => id === input.mediaSourceId)
        if (selected === undefined) return yield* Effect.fail(new PlaybackNotFound())
        return yield* videoRedirect(current, eligibleSources, selected, input.clientUserAgent)
      }
      for (const candidate of versions) {
        const attempted = yield* Effect.result(videoRedirect(current, eligibleSources, candidate, input.clientUserAgent))
        if (attempted._tag === "Success") return attempted.success
      }
      return yield* Effect.fail(new PlaybackUnavailable())
    })

    const resolveImage: PlaybackService["resolveImage"] = (input) => Effect.gen(function*() {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(input.imageType) ||
        (input.imageIndex !== undefined && (!Number.isSafeInteger(input.imageIndex) || input.imageIndex < 0))) {
        return yield* Effect.fail(new ResourceRejected())
      }
      const { current, eligibleSources } = yield* record(input.canonicalId, false)
      const external = yield* metadataProviders.resolveCachedImage(
        current,
        input.imageType,
        input.imageIndex
      )
      if (external !== null) return { _tag: "Redirect", location: external }
      for (const version of orderedVersions(current, eligibleSources)) {
        const attempted = yield* Effect.result(versionRegistration(
          current,
          eligibleSources,
          version,
          (source, item) => tokenized(
                  endpointUrl(
                    eligibleEndpoint(source),
            `/Items/${encodeURIComponent(item.upstreamItemId)}/Images/${encodeURIComponent(input.imageType)}` +
              (input.imageIndex === undefined ? "" : `/${input.imageIndex}`)
          ), source)
        ))
        if (attempted._tag === "Failure") continue
        if (isClientUsableResource({
          kind: "image",
          serverId: attempted.success.source.serverId,
          url: attempted.success.resolved
        })) {
          return { _tag: "Redirect", location: attempted.success.resolved }
        }
        return {
          _tag: "Proxy",
          request: {
            key: `image:${current.canonical.id}:${input.imageType}:` +
              `${input.imageIndex === undefined ? "default" : input.imageIndex}:${version.id}:` +
              `${attempted.success.source.serverGeneration}`,
            kind: "image",
            serverId: attempted.success.source.serverId,
            generation: attempted.success.source.serverGeneration,
            url: attempted.success.resolved,
            maxBytes: MAX_IMAGE_BYTES,
            acceptedMimeTypes: imageMimeTypes,
            open: () => upstream.requestResource({
              serverId: attempted.success.source.serverId,
              generation: attempted.success.source.serverGeneration,
              url: attempted.success.resolved,
              accept: imageMimeTypes,
                      ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent })
                    })
                    .pipe(Effect.mapError(() => new ResourceUnavailable()))
          }
        }
      }
      for (const item of orderedSourceItems(current, eligibleSources)) {
        const attempted = yield* Effect.result(sourceRegistration(
          item,
          eligibleSources,
          (source) => tokenized(
                  endpointUrl(
                    eligibleEndpoint(source),
            `/Items/${encodeURIComponent(item.upstreamItemId)}/Images/${encodeURIComponent(input.imageType)}` +
              (input.imageIndex === undefined ? "" : `/${input.imageIndex}`)
          ), source)
        ))
        if (attempted._tag === "Failure") continue
        if (isClientUsableResource({
          kind: "image",
          serverId: attempted.success.source.serverId,
          url: attempted.success.url
        })) {
          return { _tag: "Redirect", location: attempted.success.url }
        }
        return {
          _tag: "Proxy",
          request: {
            key: `image:${current.canonical.id}:${input.imageType}:` +
              `${input.imageIndex === undefined ? "default" : input.imageIndex}:${item.id}:` +
              `${attempted.success.source.serverGeneration}`,
            kind: "image",
            serverId: attempted.success.source.serverId,
            generation: attempted.success.source.serverGeneration,
            url: attempted.success.url,
            maxBytes: MAX_IMAGE_BYTES,
            acceptedMimeTypes: imageMimeTypes,
            open: () => upstream.requestResource({
              serverId: attempted.success.source.serverId,
              generation: attempted.success.source.serverGeneration,
              url: attempted.success.url,
              accept: imageMimeTypes,
                      ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent })
                    })
                    .pipe(Effect.mapError(() => new ResourceUnavailable()))
          }
        } as const
      }
      return yield* Effect.fail(new ResourceRejected())
    })

    const resolveSubtitle: PlaybackService["resolveSubtitle"] = (input) => Effect.gen(function*() {
      const format = input.format.toLowerCase()
      const acceptedMimeTypes = subtitleMimeTypes[format]
      if (acceptedMimeTypes === undefined || !Number.isSafeInteger(input.streamIndex) || input.streamIndex < 0) {
        return yield* Effect.fail(new ResourceRejected())
      }
      const { current, eligibleSources } = yield* record(input.canonicalId, false)
      const version = current.mediaVersions.find(({ id }) => id === input.mediaSourceId)
      if (version === undefined || !Array.isArray(version.streams)) return yield* Effect.fail(new ResourceRejected())
      const stream = version.streams.find((candidate) =>
        jsonObject(candidate) && candidate.Index === input.streamIndex
      )
      if (!jsonObject(stream) || stream.Type !== "Subtitle" || stream.IsExternal !== true) {
        return yield* Effect.fail(new ResourceRejected())
      }
      const codec = typeof stream.Codec === "string" ? stream.Codec.toLowerCase() : format
      if (!textSubtitle(codec, stream) || codec !== format) return yield* Effect.fail(new ResourceRejected())
      const registered = yield* versionRegistration(current, eligibleSources, version, (source, item) => {
        const url = endpointUrl(
              eligibleEndpoint(source),
          `/Videos/${encodeURIComponent(item.upstreamItemId)}/${encodeURIComponent(version.upstreamMediaSourceId)}` +
            `/Subtitles/${input.streamIndex}/Stream.${format}`
        )
        return tokenized(url, source)
      })
      if (isClientUsableResource({
        kind: "subtitle",
        serverId: registered.source.serverId,
        url: registered.resolved
      })) return { _tag: "Redirect", location: registered.resolved }
      return {
        _tag: "Proxy",
        request: {
          key: `subtitle:${current.canonical.id}:${version.id}:${input.streamIndex}:${format}:` +
            `${registered.source.serverGeneration}`,
          kind: "subtitle",
          serverId: registered.source.serverId,
          generation: registered.source.serverGeneration,
          url: registered.resolved,
          maxBytes: MAX_SUBTITLE_BYTES,
          acceptedMimeTypes,
          open: () => upstream.requestResource({
            serverId: registered.source.serverId,
            generation: registered.source.serverGeneration,
            url: registered.resolved,
            accept: acceptedMimeTypes,
                    ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent })
                  })
                  .pipe(Effect.mapError(() => new ResourceUnavailable()))
        }
      }
    })

    return Playback.of({ getInfo, resolveVideoRedirect, resolveImage, resolveSubtitle })
  })
)

export interface ResourceDeliveryConfig {
  readonly cache?: ResourceCacheService
  readonly now?: () => number
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
}

const safeHeaders = (headers: Headers): ReadonlyArray<readonly [string, string]> => [
  "content-type", "content-disposition", "etag", "last-modified"
].flatMap((name): ReadonlyArray<readonly [string, string]> => {
  const value = headers.get(name)
  return value === null ? [] : [[name, value] as const]
}).concat([["cache-control", "private, no-store"]])

const responseFromCache = (cached: CachedResource): Response => {
  const headers = new Headers(Object.fromEntries(cached.headers))
  headers.set("cache-control", "private, no-store")
  return new Response(cached.body.slice(), { status: cached.status, headers })
}

const concat = (chunks: ReadonlyArray<Uint8Array>, length: number): Uint8Array => {
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export const serveRegisteredResource = (
  request: RegisteredResourceRequest,
  config: ResourceDeliveryConfig
): Effect.Effect<Response, ResourceFailure> => Effect.gen(function*() {
  const now = config.now ?? Date.now
  if (request.kind === "image" && config.cache !== undefined) {
    const cached = yield* config.cache.get(request.key)
    if (cached !== null && cached.expiresAtMs > now()) return responseFromCache(cached)
  }

  const deadlineMs = config.deadlineMs ?? AUXILIARY_PROXY_DEADLINE_MS
  const startedAtMs = Date.now()
  const scope = yield* Scope.make()
  const upstream = yield* request.open().pipe(
    Scope.provide(scope),
    Effect.timeout(deadlineMs),
    Effect.catchTag("TimeoutError", () => Effect.fail(new ResourceTimeout())),
    Effect.catch((error) => Scope.close(scope, Exit.fail(error)).pipe(
      Effect.andThen(Effect.fail(error))
    ))
  )
  if (upstream.status < 200 || upstream.status >= 300 || upstream.body === null) {
    yield* Scope.close(scope, Exit.succeed(undefined))
    return yield* Effect.fail(new ResourceInvalidResponse())
  }
  const mime = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mime === undefined || !request.acceptedMimeTypes.includes(mime)) {
    yield* Scope.close(scope, Exit.succeed(undefined))
    return yield* Effect.fail(new ResourceInvalidResponse())
  }
  const advertised = upstream.headers.get("content-length")
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > request.maxBytes)) {
    yield* Scope.close(scope, Exit.succeed(undefined))
    return yield* Effect.fail(new ResourceTooLarge())
  }

  const headers = safeHeaders(upstream.headers)
  const reader = upstream.body.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const finalize = async (exit: Exit.Exit<unknown, unknown>) => {
    if (finished) return
    finished = true
    if (timer !== undefined) clearTimeout(timer)
    if (abortListener !== undefined) config.signal?.removeEventListener("abort", abortListener)
    await Effect.runPromise(Scope.close(scope, exit).pipe(Effect.ignore))
  }
  const remainingMs = Math.max(0, deadlineMs - (Date.now() - startedAtMs))
  const body = new ReadableStream<Uint8Array>({
    start(output) {
      const abort = (error: ResourceTimeout | DOMException) => {
        void reader.cancel(error).catch(() => undefined)
        output.error(error)
        void finalize(Exit.fail(error))
      }
      abortListener = () => abort(new DOMException("aborted", "AbortError"))
      timer = setTimeout(() => abort(new ResourceTimeout()), remainingMs)
      if (config.signal?.aborted) abortListener()
      else config.signal?.addEventListener("abort", abortListener, { once: true })
    },
    async pull(output) {
      try {
        const next = await reader.read()
        if (next.done) {
          if (request.kind === "image" && config.cache !== undefined) {
            const counted: CountedResource = {
              status: upstream.status,
              headers,
              body: concat(chunks, length)
            }
            await Effect.runPromise(config.cache.put(request.key, counted, now() + IMAGE_CACHE_TTL_MS).pipe(
              Effect.ignore
            ))
          }
          output.close()
          await finalize(Exit.succeed(undefined))
          return
        }
        length += next.value.byteLength
        if (length > request.maxBytes) {
          await reader.cancel()
          const error = new ResourceTooLarge()
          output.error(error)
          await finalize(Exit.fail(error))
          return
        }
        if (request.kind === "image") chunks.push(next.value.slice())
        output.enqueue(next.value)
      } catch (cause) {
        const error = cause instanceof ResourceTimeout ? cause : new ResourceUnavailable()
        output.error(error)
        await finalize(Exit.fail(error))
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await finalize(Exit.succeed(undefined))
    }
  })
  return new Response(body, { status: upstream.status, headers: Object.fromEntries(headers) })
})
