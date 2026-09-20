import { Context, Effect, Layer, Schema } from "effect"

import type { CanonicalItemView, FederationFailure } from "./federation.js"
import { Federation } from "./federation.js"
import {
  AUXILIARY_PROXY_DEADLINE_MS,
  IMAGE_CACHE_TTL_MS,
  MAX_IMAGE_BYTES,
  MAX_SUBTITLE_BYTES
} from "./limits.js"
import type { EligibleSource, JsonValue, SourceItemRecord, SourceMediaVersion } from "./model.js"
import {
  ResourceCacheError,
  type CachedResource,
  type CountedResource,
  type ResourceCacheService
} from "./resource-cache.js"
import { Repositories, type CatalogItemRecord } from "./repositories.js"
import { UpstreamClient, type UpstreamClientService } from "./upstream-client.js"

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
}

export interface ImageSelection {
  readonly canonicalId: string
  readonly imageType: string
  readonly imageIndex?: number
}

export interface SubtitleSelection {
  readonly canonicalId: string
  readonly mediaSourceId: string
  readonly streamIndex: number
  readonly format: string
}

export interface RegisteredResourceRequest {
  readonly key: string
  readonly kind: "image" | "subtitle"
  readonly serverId: string
  readonly generation: number
  readonly url: URL
  readonly maxBytes: number
  readonly acceptedMimeTypes: ReadonlyArray<string>
}

export type ResourceDecision =
  | { readonly _tag: "Redirect"; readonly location: URL }
  | { readonly _tag: "Proxy"; readonly request: RegisteredResourceRequest }

export interface PlaybackService {
  readonly getInfo: (canonicalId: string) => Effect.Effect<PlaybackInfo, PlaybackFailure>
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
      : order.get(sourceKey(leftItem.serverId, leftItem.sourceLibraryId)) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = rightItem === undefined
      ? Number.MAX_SAFE_INTEGER
      : order.get(sourceKey(rightItem.serverId, rightItem.sourceLibraryId)) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder ||
      (leftItem?.serverId ?? "").localeCompare(rightItem?.serverId ?? "") ||
      (leftItem?.upstreamItemId ?? "").localeCompare(rightItem?.upstreamItemId ?? "") ||
      left.upstreamMediaSourceId.localeCompare(right.upstreamMediaSourceId)
  })
}

const appendPath = (baseUrl: string, path: string): URL => {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`
  url.search = ""
  url.hash = ""
  return url
}

const tokenized = (url: URL, source: EligibleSource): URL => {
  if (source.accessToken !== null) url.searchParams.set("api_key", source.accessToken)
  return url
}

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
      const output = Object.fromEntries(streamFields.flatMap((key) => scalar(entry[key]) ? [[key, entry[key]]] : []))
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
    ...Object.fromEntries(keep.flatMap((key) => scalar(details[key]) ? [[key, details[key]]] : [])),
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
): Layer.Layer<Playback, never, Federation | Repositories | UpstreamClient> => Layer.effect(
  Playback,
  Effect.gen(function*() {
    const federation = yield* Federation
    const repositories = yield* Repositories
    const upstream = yield* UpstreamClient
    const sessionId = config.sessionId ?? crypto.randomUUID
    const isClientUsableResource = config.isClientUsableResource ?? (() => false)

    const record = (canonicalId: string, enrich: boolean) => Effect.gen(function*() {
      const membership = enrich
        ? yield* federation.enrichVersions(canonicalId)
        : (yield* federation.lookupMembership(canonicalId))?.item ?? null
      if (membership === null) return yield* Effect.fail(new PlaybackNotFound())
      const current = (yield* repositories.readCatalogItems([membership.id]))[0]
      if (!current) return yield* Effect.fail(new PlaybackNotFound())
      const eligibleSources = yield* repositories.resolveEligibleSourcesForCanonical(membership.id)
      return { current, eligibleSources }
    })

    const registration = (
      item: SourceItemRecord,
      version: SourceMediaVersion,
      eligibleSources: ReadonlyArray<EligibleSource>,
      build: (source: EligibleSource) => URL
    ): Effect.Effect<{ readonly source: EligibleSource; readonly resolved: URL }, PlaybackUnavailable> =>
      Effect.gen(function*() {
        if (item.serverGeneration !== version.serverGeneration) {
          return yield* Effect.fail(new PlaybackUnavailable())
        }
        const eligible = yield* repositories.isSourceEligible(item.serverId, item.sourceLibraryId)
          .pipe(Effect.mapError(() => new PlaybackUnavailable()))
        const source = eligibleSources.find((candidate) =>
          candidate.serverId === item.serverId &&
          candidate.sourceLibraryId === item.sourceLibraryId &&
          candidate.serverGeneration === item.serverGeneration
        )
        if (!eligible || source === undefined) return yield* Effect.fail(new PlaybackUnavailable())
        const url = build(source)
        const capabilities = jsonObject(version.capabilities) ? version.capabilities : {}
        const resolved = yield* upstream.resolvePlayback({
          ...version,
          capabilities: { ...capabilities, serverId: source.serverId, url: url.href }
        }).pipe(Effect.mapError(() => new PlaybackUnavailable()))
        return { source, resolved: new URL(resolved.url) }
      })

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

    const video = (
      record: CatalogItemRecord,
      eligibleSources: ReadonlyArray<EligibleSource>,
      version: SourceMediaVersion
    ) => versionRegistration(record, eligibleSources, version, (source, item) => {
      const url = appendPath(source.baseUrl, `/Videos/${encodeURIComponent(item.upstreamItemId)}/stream`)
      url.searchParams.set("MediaSourceId", version.upstreamMediaSourceId)
      url.searchParams.set("Static", "true")
      return tokenized(url, source)
    }).pipe(Effect.map(({ resolved }) => resolved))

    const getInfo: PlaybackService["getInfo"] = (canonicalId) => Effect.gen(function*() {
      const { current, eligibleSources } = yield* record(canonicalId, true)
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
        return yield* video(current, eligibleSources, selected)
      }
      for (const candidate of versions) {
        const attempted = yield* Effect.result(video(current, eligibleSources, candidate))
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
      for (const version of orderedVersions(current, eligibleSources)) {
        const attempted = yield* Effect.result(versionRegistration(
          current,
          eligibleSources,
          version,
          (source, item) => tokenized(appendPath(
            source.baseUrl,
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
            key: `image:${current.canonical.id}:${input.imageType}:${input.imageIndex ?? 0}:${version.id}`,
            kind: "image",
            serverId: attempted.success.source.serverId,
            generation: attempted.success.source.serverGeneration,
            url: attempted.success.resolved,
            maxBytes: MAX_IMAGE_BYTES,
            acceptedMimeTypes: imageMimeTypes
          }
        }
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
        const url = appendPath(
          source.baseUrl,
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
          key: `subtitle:${current.canonical.id}:${version.id}:${input.streamIndex}:${format}`,
          kind: "subtitle",
          serverId: registered.source.serverId,
          generation: registered.source.serverGeneration,
          url: registered.resolved,
          maxBytes: MAX_SUBTITLE_BYTES,
          acceptedMimeTypes
        }
      }
    })

    return Playback.of({ getInfo, resolveVideoRedirect, resolveImage, resolveSubtitle })
  })
)

export interface ResourceDeliveryConfig {
  readonly fetch: typeof globalThis.fetch
  readonly cache?: ResourceCacheService
  readonly now?: () => number
  readonly deadlineMs?: number
}

const safeHeaders = (headers: Headers): ReadonlyArray<readonly [string, string]> => [
  "content-type", "content-disposition", "cache-control", "etag", "last-modified"
].flatMap((name): ReadonlyArray<readonly [string, string]> => {
  const value = headers.get(name)
  return value === null ? [] : [[name, value] as const]
})

const responseFromCache = (cached: CachedResource): Response => new Response(cached.body.slice(), {
  status: cached.status,
  headers: Object.fromEntries(cached.headers)
})

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

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.deadlineMs ?? AUXILIARY_PROXY_DEADLINE_MS)
  const upstream = yield* Effect.tryPromise({
    try: () => config.fetch(request.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: request.acceptedMimeTypes.join(", ") }
    }),
    catch: () => timedOut ? new ResourceTimeout() : new ResourceUnavailable()
  }).pipe(Effect.tapError(() => Effect.sync(() => clearTimeout(timer))))
  if (upstream.status < 200 || upstream.status >= 300 || upstream.body === null) {
    clearTimeout(timer)
    controller.abort()
    return yield* Effect.fail(new ResourceInvalidResponse())
  }
  const mime = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mime === undefined || !request.acceptedMimeTypes.includes(mime)) {
    clearTimeout(timer)
    controller.abort()
    return yield* Effect.fail(new ResourceInvalidResponse())
  }
  const advertised = upstream.headers.get("content-length")
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > request.maxBytes)) {
    clearTimeout(timer)
    controller.abort()
    return yield* Effect.fail(new ResourceTooLarge())
  }

  const headers = safeHeaders(upstream.headers)
  const reader = upstream.body.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const next = await reader.read()
        if (next.done) {
          clearTimeout(timer)
          if (request.kind === "image" && config.cache !== undefined) {
            const counted: CountedResource = {
              status: upstream.status,
              headers,
              body: concat(chunks, length)
            }
            await Effect.runPromise(config.cache.put(request.key, counted, now() + IMAGE_CACHE_TTL_MS))
          }
          output.close()
          return
        }
        length += next.value.byteLength
        if (length > request.maxBytes) {
          clearTimeout(timer)
          controller.abort()
          await reader.cancel()
          output.error(new ResourceTooLarge())
          return
        }
        if (request.kind === "image") chunks.push(next.value.slice())
        output.enqueue(next.value)
      } catch {
        clearTimeout(timer)
        output.error(timedOut ? new ResourceTimeout() : new ResourceUnavailable())
      }
    },
    async cancel(reason) {
      clearTimeout(timer)
      controller.abort()
      await reader.cancel(reason)
    }
  })
  return new Response(body, { status: upstream.status, headers: Object.fromEntries(headers) })
})
