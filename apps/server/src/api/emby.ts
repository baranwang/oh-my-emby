import { Effect, Schema } from "effect"

import type { AuthService } from "../core/auth.js"
import { InvalidCredentials } from "../core/errors.js"
import type {
  CanonicalItemView,
  CatalogFilter,
  FederatedQuery,
  FederationService,
  SortTerm
} from "../core/federation.js"
import type { LibraryServiceApi } from "../core/library-service.js"
import type { JsonValue, PlaybackEvent, UserStatePatch, UserStateRecord } from "../core/model.js"
import type { UserStateService } from "../core/user-state.js"
import {
  EmbyClient,
  type EmbyItemDto as EmbyItemDtoValue,
  EmbyItemsQuery,
  EmbyLoginBody,
  type EmbyMediaSourceDto as EmbyMediaSourceDtoValue,
  type EmbyMediaStreamDto as EmbyMediaStreamDtoValue,
  EmbyPlaybackEvent,
  type EmbyPlaybackInfoDto as EmbyPlaybackInfoDtoValue,
  EmbyUserDataPatch,
  type EmbyItemsQuery as EmbyItemsQueryValue,
  type EmbyPlaybackEvent as EmbyPlaybackEventValue,
  type EmbyUserDataPatch as EmbyUserDataPatchValue
} from "./emby-schemas.js"

export interface PlaybackInfoBoundary {
  readonly playSessionId: string
  readonly mediaSources: ReadonlyArray<JsonValue>
}

/** Task 10 supplies this service. This protocol layer only delegates and maps casing. */
export interface PlaybackBoundary {
  readonly getInfo: (canonicalId: string) => Effect.Effect<PlaybackInfoBoundary, unknown>
}

export interface EmbyServices {
  readonly config: {
    readonly serverId: string
    readonly serverName: string
    readonly version: string
  }
  readonly now: () => number
  readonly auth: Pick<AuthService, "loginEmby" | "authenticateEmby">
  readonly federation: Pick<FederationService, "list" | "search" | "detail" | "lookupMembership">
  readonly userState: Pick<UserStateService, "write" | "recordPlaybackEvent">
  readonly libraries: Pick<LibraryServiceApi, "list">
  readonly playback: PlaybackBoundary
}

class InvalidEmbyRequest extends Schema.TaggedError<InvalidEmbyRequest>()("InvalidEmbyRequest", {}) {}
class EmbyNotFound extends Schema.TaggedError<EmbyNotFound>()("EmbyNotFound", {}) {}
class EmbyForbidden extends Schema.TaggedError<EmbyForbidden>()("EmbyForbidden", {}) {}

const json = (body: unknown, status = 200): Response => Response.json(body, {
  status,
  headers: { "cache-control": "private, no-store" }
})

const failure = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status)

const notFound = (): Response => failure(404, "NotFound", "Resource not found")

const publicFailure = (error: unknown): Response => {
  const tag = typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : "Internal"
  switch (tag) {
    case "InvalidEmbyRequest": return failure(400, "InvalidRequest", "Invalid request")
    case "FederationLimitExceeded": return failure(400, "InvalidRequest", "Invalid request")
    case "InvalidCredentials": return failure(401, "Unauthorized", "Authentication required")
    case "EmbyForbidden": return failure(403, "Forbidden", "Forbidden")
    case "EmbyNotFound":
    case "LibraryNotFound":
    case "ServerNotFound": return notFound()
    case "RateLimited": return failure(429, "RateLimited", "Too many authentication attempts")
    case "FederationUnavailable":
    case "UpstreamUnavailable":
    case "UpstreamTimeout":
    case "UpstreamRejected": return failure(503, "Unavailable", "Service unavailable")
    default: return failure(500, "Internal", "Internal server error")
  }
}

const decode = <A>(schema: Schema.Schema<A>, input: unknown): Effect.Effect<A, InvalidEmbyRequest> => {
  const run = Schema.decodeUnknownEffect(schema) as (value: unknown) => Effect.Effect<A, unknown>
  return run(input).pipe(Effect.mapError(() => new InvalidEmbyRequest()))
}

const readJson = (request: Request) => Effect.tryPromise({
  try: () => request.json(),
  catch: () => new InvalidEmbyRequest()
})

const split = (value: string | null): ReadonlyArray<string> | undefined => value === null
  ? undefined
  : value.split(",").map((entry) => entry.trim())

const number = (value: string | null): number | undefined => value === null
  ? undefined
  : value.trim() === "" ? Number.NaN : Number(value)

const compact = <A extends Record<string, unknown>>(value: A): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))

const decodeItemsQuery = (url: URL) => decode(EmbyItemsQuery, compact({
  ParentId: url.searchParams.get("ParentId") ?? undefined,
  StartIndex: number(url.searchParams.get("StartIndex")),
  Limit: number(url.searchParams.get("Limit")),
  SearchTerm: url.searchParams.get("SearchTerm") ?? undefined,
  SortBy: split(url.searchParams.get("SortBy")),
  SortOrder: split(url.searchParams.get("SortOrder")),
  Fields: split(url.searchParams.get("Fields")),
  Filters: split(url.searchParams.get("Filters")),
  IncludeItemTypes: split(url.searchParams.get("IncludeItemTypes"))
})).pipe(Effect.flatMap((query) => {
  if ((query.SortOrder?.length ?? 0) > 1 && query.SortOrder?.length !== query.SortBy?.length) {
    return Effect.fail(new InvalidEmbyRequest())
  }
  return Effect.succeed(query)
}))

const parseAuthorization = (value: string | null): Readonly<Record<string, string>> => {
  if (!value) return {}
  const input = value.replace(/^\s*(?:MediaBrowser|Emby)\s+/i, "")
  const entries: Array<[string, string]> = []
  for (const match of input.matchAll(/(?:^|,\s*)([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) {
    entries.push([match[1]!.toLowerCase(), match[2] ?? match[3] ?? ""])
  }
  return Object.fromEntries(entries)
}

const token = (request: Request, url: URL): string | null => {
  const direct = request.headers.get("x-emby-token") ?? url.searchParams.get("api_key")
  if (direct?.trim()) return direct.trim()
  const authorization = request.headers.get("authorization")
  const bearer = authorization?.match(/^\s*Bearer\s+(.+?)\s*$/i)?.[1]
  if (bearer) return bearer
  return parseAuthorization(authorization).token ??
    parseAuthorization(request.headers.get("x-emby-authorization")).token ??
    null
}

const client = (request: Request) => {
  const values = {
    ...parseAuthorization(request.headers.get("authorization")),
    ...parseAuthorization(request.headers.get("x-emby-authorization"))
  }
  return decode(EmbyClient, { Device: values.device, DeviceId: values.deviceid })
}

const pathSegment = (value: string): Effect.Effect<string, InvalidEmbyRequest> => Effect.try({
  try: () => Schema.decodeUnknownSync(Schema.NonEmptyString)(decodeURIComponent(value)),
  catch: () => new InvalidEmbyRequest()
})

const normalizedPath = (pathname: string): string => {
  const withoutAlias = pathname === "/emby" ? "/" : pathname.startsWith("/emby/") ? pathname.slice(5) : pathname
  return withoutAlias.length > 1 && withoutAlias.endsWith("/") ? withoutAlias.slice(0, -1) : withoutAlias
}

const object = (value: JsonValue): Readonly<Record<string, JsonValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : {}

const userData = (state: UserStateRecord | null, itemId: string) => ({
  ItemId: itemId,
  Played: state?.played ?? false,
  IsFavorite: state?.favorite ?? false,
  PlayCount: state?.playCount ?? 0,
  PlaybackPositionTicks: state?.positionTicks ?? 0
})

const scalar = (value: JsonValue | undefined): value is string | number | boolean =>
  typeof value === "string" || typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value))

const pickScalars = (
  source: Readonly<Record<string, JsonValue>>,
  keys: ReadonlyArray<string>
): Record<string, string | number | boolean> => Object.fromEntries(keys.flatMap((key) => {
  const value = source[key]
  return scalar(value) ? [[key, value]] : []
}))

const itemScalarFields = [
  "Name", "OriginalTitle", "SortName", "Overview", "ProductionYear", "PremiereDate",
  "DateCreated", "EndDate", "CommunityRating", "CriticRating", "OfficialRating",
  "RunTimeTicks", "IndexNumber", "ParentIndexNumber", "ChildCount", "IsFolder", "IsHD"
] as const

const mediaSourceScalarFields = [
  "Protocol", "Container", "Size", "RunTimeTicks", "Bitrate", "VideoType",
  "SupportsDirectPlay", "SupportsDirectStream", "SupportsTranscoding", "IsRemote"
] as const

const mediaStreamScalarFields = [
  "Index", "Type", "Codec", "CodecTag", "Language", "DisplayTitle", "Title", "Profile",
  "Level", "AspectRatio", "PixelFormat", "VideoRange", "ChannelLayout", "SampleRate",
  "Channels", "BitRate", "BitDepth", "Width", "Height", "AverageFrameRate",
  "RealFrameRate", "IsDefault", "IsForced", "IsExternal", "IsTextSubtitleStream",
  "IsInterlaced", "IsAVC", "IsAnamorphic", "SupportsExternalStream"
] as const

const mediaStreamDto = (value: JsonValue): EmbyMediaStreamDtoValue | null => {
  const stream = pickScalars(object(value), mediaStreamScalarFields)
  return Object.keys(stream).length === 0 ? null : stream as EmbyMediaStreamDtoValue
}

const mediaSourceDto = (
  value: JsonValue,
  identity?: { readonly id: string; readonly name: string; readonly streams: JsonValue }
): EmbyMediaSourceDtoValue | null => {
  const source = object(value)
  const id = identity?.id ?? (typeof source.Id === "string" ? source.Id : "")
  if (!id) return null
  const name = identity?.name ?? (typeof source.Name === "string" ? source.Name : undefined)
  const streams = identity?.streams ?? source.MediaStreams
  return {
    ...pickScalars(source, mediaSourceScalarFields),
    Id: id,
    ...(name ? { Name: name } : {}),
    MediaStreams: Array.isArray(streams)
      ? streams.flatMap((entry) => {
          const mapped = mediaStreamDto(entry)
          return mapped === null ? [] : [mapped]
        })
      : []
  } as EmbyMediaSourceDtoValue
}

const itemDto = (item: CanonicalItemView): EmbyItemDtoValue => {
  const metadata = object(item.displayMetadata)
  return {
    ...pickScalars(metadata, itemScalarFields),
    Id: item.id,
    Type: item.itemType,
    ...(Array.isArray(metadata.Genres) && metadata.Genres.every((entry) => typeof entry === "string" && entry.length > 0)
      ? { Genres: metadata.Genres }
      : {}),
    UserData: userData(item.userState, item.id),
    MediaSources: item.mediaVersions.flatMap((version) => {
      const mapped = mediaSourceDto(version.capabilities, {
        id: version.id,
        name: version.label,
        streams: version.streams
      })
      return mapped === null ? [] : [mapped]
    })
  } as EmbyItemDtoValue
}

const playbackInfoDto = (info: PlaybackInfoBoundary): EmbyPlaybackInfoDtoValue => ({
  PlaySessionId: info.playSessionId,
  MediaSources: info.mediaSources.flatMap((source) => {
    const mapped = mediaSourceDto(source)
    return mapped === null ? [] : [mapped]
  })
})

const filter = (name: NonNullable<EmbyItemsQueryValue["Filters"]>[number]): CatalogFilter => {
  switch (name) {
    case "IsFavorite": return { field: "favorite", value: true }
    case "IsPlayed": return { field: "played", value: true }
    case "IsUnplayed": return { field: "played", value: false }
    case "IsResumable": return { field: "resume", value: true }
  }
}

const query = (
  principal: { readonly username: string; readonly deviceId: string },
  input: EmbyItemsQueryValue
): FederatedQuery => {
  const orders = input.SortOrder ?? []
  const sort: ReadonlyArray<SortTerm> = (input.SortBy ?? []).map((field, index) => ({
    field,
    direction: orders[index] ?? orders[0] ?? "Ascending"
  }))
  return {
    userId: principal.username,
    deviceId: principal.deviceId,
    virtualLibraryId: input.ParentId,
    startIndex: input.StartIndex ?? 0,
    limit: input.Limit ?? 100,
    sort,
    filters: [
      ...(input.Filters ?? []).map(filter)
    ],
    itemTypes: [...new Set(input.IncludeItemTypes ?? [])],
    ...(input.Fields === undefined ? {} : { fields: input.Fields })
  }
}

const principalFor = (services: EmbyServices, request: Request, url: URL) => {
  const value = token(request, url)
  return value
    ? decode(Schema.NonEmptyString, value).pipe(Effect.flatMap(services.auth.authenticateEmby))
    : Effect.fail(new InvalidCredentials())
}

const requireUser = <A extends { readonly username: string }>(principal: A, encoded: string) =>
  pathSegment(encoded).pipe(Effect.flatMap((userId) => userId === principal.username
    ? Effect.succeed(userId)
    : Effect.fail(new EmbyForbidden())))

const statePatch = (body: EmbyUserDataPatchValue): Effect.Effect<UserStatePatch, InvalidEmbyRequest> => {
  const patch: UserStatePatch = {
    ...(body.Played === undefined ? {} : { played: body.Played }),
    ...(body.IsFavorite === undefined ? {} : { favorite: body.IsFavorite }),
    ...(body.PlayCount === undefined ? {} : { playCount: body.PlayCount }),
    ...(body.PlaybackPositionTicks === undefined ? {} : { positionTicks: body.PlaybackPositionTicks }),
    ...(body.LastPlayedVersionId === undefined ? {} : { lastPlayedVersionId: body.LastPlayedVersionId })
  }
  return Object.keys(patch).length === 0
    ? Effect.fail(new InvalidEmbyRequest())
    : Effect.succeed(patch)
}

const playbackEvent = (
  kind: PlaybackEvent["kind"],
  body: EmbyPlaybackEventValue,
  canonicalId: string,
  versionId: string,
  now: number,
  played: boolean
): PlaybackEvent => ({
  kind,
  localSessionId: body.PlaySessionId,
  canonicalId,
  versionId,
  positionTicks: body.PositionTicks ?? 0,
  occurredAtMs: now,
  ...(kind === "stop" ? { played } : {})
} as PlaybackEvent)

const serverInfo = (services: EmbyServices) => ({
  Id: services.config.serverId,
  ServerName: services.config.serverName,
  ProductName: "oh-my-emby",
  Version: services.config.version,
  OperatingSystem: "Unknown",
  StartupWizardCompleted: true
})

const user = (services: EmbyServices, userId: string) => ({
  Id: userId,
  Name: userId,
  ServerId: services.config.serverId,
  HasPassword: true,
  HasConfiguredPassword: true,
  Configuration: {},
  Policy: { IsAdministrator: true, IsDisabled: false }
})

const interruptWhenAborted = (signal: AbortSignal): Effect.Effect<never> => Effect.callback((resume) => {
  const abort = () => resume(Effect.interrupt)
  if (signal.aborted) {
    abort()
    return
  }
  signal.addEventListener("abort", abort, { once: true })
  return Effect.sync(() => signal.removeEventListener("abort", abort))
})

const handle = (services: EmbyServices, request: Request): Effect.Effect<Response, unknown> => Effect.gen(function*() {
  const url = new URL(request.url)
  const path = normalizedPath(url.pathname)
  const method = request.method.toUpperCase()

  if (method === "GET" && path === "/System/Info/Public") return json(serverInfo(services))

  if (method === "POST" && path === "/Users/AuthenticateByName") {
    const metadata = yield* client(request)
    const body = yield* readJson(request).pipe(Effect.flatMap((value) => decode(EmbyLoginBody, value)))
    const session = yield* services.auth.loginEmby({
      username: body.Username,
      password: body.Pw,
      deviceId: metadata.DeviceId,
      deviceName: metadata.Device
    }, { scopeKey: `emby:${body.Username}` })
    return json({
      AccessToken: session.accessToken,
      ServerId: services.config.serverId,
      User: user(services, session.userId)
    })
  }

  const system = method === "GET" && path === "/System/Info"
  const views = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Views$/) : null
  const userItems = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Items$/) : null
  const allItems = method === "GET" && path === "/Items"
  const userDetail = method === "GET" ? path.match(/^\/Users\/([^/]+)\/Items\/([^/]+)$/) : null
  const itemDetail = method === "GET" ? path.match(/^\/Items\/([^/]+)$/) : null
  const userDataRoute = method === "POST" ? path.match(/^\/Users\/([^/]+)\/Items\/([^/]+)\/UserData$/) : null
  const favorite = path.match(/^\/Users\/([^/]+)\/FavoriteItems\/([^/]+)$/)
  const played = path.match(/^\/Users\/([^/]+)\/PlayedItems\/([^/]+)$/)
  const playbackInfo = method === "POST" ? path.match(/^\/Items\/([^/]+)\/PlaybackInfo$/) : null
  const playbackKind = method === "POST"
    ? path === "/Sessions/Playing" ? "start"
      : path === "/Sessions/Playing/Progress" ? "progress"
        : path === "/Sessions/Playing/Stopped" ? "stop"
          : null
    : null

  if (!system && !views && !userItems && !allItems && !userDetail && !itemDetail && !userDataRoute &&
    !favorite && !played && !playbackInfo && !playbackKind) return notFound()

  const principal = yield* principalFor(services, request, url)
  if (system) return json(serverInfo(services))

  if (views) {
    yield* requireUser(principal, views[1]!)
    const libraries = yield* services.libraries.list()
    const items = libraries.filter(({ enabled }) => enabled).map((library) => ({
      Id: library.id,
      Name: library.name,
      Type: "CollectionFolder",
      CollectionType: library.mediaType === "series" ? "tvshows" : "movies",
      IsFolder: true,
      UserData: userData(null, library.id)
    }))
    return json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 })
  }

  if (userItems || allItems) {
    if (userItems) yield* requireUser(principal, userItems[1]!)
    const decoded = yield* decodeItemsQuery(url)
    const input = query(principal, decoded)
    const page = decoded.SearchTerm
      ? yield* services.federation.search({ ...input, searchTerm: decoded.SearchTerm })
      : yield* services.federation.list(input)
    return json({
      Items: page.items.map(itemDto),
      TotalRecordCount: page.totalRecordCount,
      StartIndex: input.startIndex
    })
  }

  if (userDetail || itemDetail) {
    if (userDetail) yield* requireUser(principal, userDetail[1]!)
    const canonicalId = yield* pathSegment((userDetail?.[2] ?? itemDetail?.[1])!)
    const item = yield* services.federation.detail(canonicalId)
    if (item === null) return yield* Effect.fail(new EmbyNotFound())
    return json(itemDto(item))
  }

  if (userDataRoute) {
    yield* requireUser(principal, userDataRoute[1]!)
    const canonicalId = yield* pathSegment(userDataRoute[2]!)
    const body = yield* readJson(request).pipe(
      Effect.flatMap((value) => decode(EmbyUserDataPatch, value))
    )
    const patch = yield* statePatch(body)
    const membership = yield* services.federation.lookupMembership(
      canonicalId,
      body.LastPlayedVersionId ?? undefined
    )
    if (membership === null) return yield* Effect.fail(new EmbyNotFound())
    return json(userData(
      yield* services.userState.write(membership.item.id, patch),
      membership.item.id
    ))
  }

  if (favorite && (method === "POST" || method === "DELETE")) {
    yield* requireUser(principal, favorite[1]!)
    const canonicalId = yield* pathSegment(favorite[2]!)
    const membership = yield* services.federation.lookupMembership(canonicalId)
    if (membership === null) return yield* Effect.fail(new EmbyNotFound())
    return json(userData(yield* services.userState.write(membership.item.id, {
      favorite: method === "POST"
    }), membership.item.id))
  }

  if (played && (method === "POST" || method === "DELETE")) {
    yield* requireUser(principal, played[1]!)
    const canonicalId = yield* pathSegment(played[2]!)
    const membership = yield* services.federation.lookupMembership(canonicalId)
    if (membership === null) return yield* Effect.fail(new EmbyNotFound())
    const patch: UserStatePatch = method === "POST"
      ? { played: true, positionTicks: 0 }
      : { played: false, playCount: 0, positionTicks: 0 }
    return json(userData(
      yield* services.userState.write(membership.item.id, patch),
      membership.item.id
    ))
  }

  if (playbackInfo) {
    const canonicalId = yield* pathSegment(playbackInfo[1]!)
    const membership = yield* services.federation.lookupMembership(canonicalId)
    if (membership === null) return yield* Effect.fail(new EmbyNotFound())
    const info = yield* services.playback.getInfo(membership.item.id)
    return json(playbackInfoDto(info))
  }

  if (playbackKind) {
    const body = yield* readJson(request).pipe(Effect.flatMap((value) => decode(EmbyPlaybackEvent, value)))
    const membership = yield* services.federation.lookupMembership(body.ItemId, body.MediaSourceId)
    if (membership === null || membership.version === null) return yield* Effect.fail(new EmbyNotFound())
    let completed = false
    if (playbackKind === "stop") {
      const runtime = object(membership.item.displayMetadata).RunTimeTicks
      completed = typeof runtime === "number" && runtime > 0 && (body.PositionTicks ?? 0) >= runtime
    }
    yield* services.userState.recordPlaybackEvent(playbackEvent(
      playbackKind,
      body,
      membership.item.id,
      membership.version.id,
      services.now(),
      completed
    ))
    return new Response(null, { status: 204 })
  }

  return notFound()
})

export const makeEmbyHandler = (services: EmbyServices) =>
  (request: Request): Effect.Effect<Response> => handle(services, request).pipe(
    Effect.catch((error) => Effect.succeed(publicFailure(error))),
    Effect.raceFirst(interruptWhenAborted(request.signal))
  )
