import type { SourceLibraryView } from "@oh-my-emby/contracts"
import { Context, Effect, Layer, Schema } from "effect"

import {
  DestinationRejected,
  HttpsDowngrade,
  InvalidUpstreamUrl,
  ObsoleteGeneration,
  RedirectLimitExceeded,
  RedirectLoop,
  ResponseTooLarge,
  ServerNotFound,
  UpstreamInvalidResponse,
  UpstreamNotFound,
  UpstreamRejected,
  UpstreamTimeout,
  UpstreamUnavailable,
  type UpstreamFailure
} from "./errors.js"
import {
  MAX_CONTROL_RESPONSE_BYTES,
  UPSTREAM_DETAIL_DEADLINE_MS,
  UPSTREAM_LIST_DEADLINE_MS
} from "./limits.js"
import type { SourceMediaVersion, UpstreamServer } from "./model.js"
import { Repositories } from "./repositories.js"

const MAX_REDIRECTS = 3
const redirects = new Set([301, 302, 303, 307, 308])
const utf8 = new TextDecoder()

export interface DestinationPolicy {
  readonly platform: "workers" | "docker"
  readonly administratorPrivateHosts?: ReadonlyArray<string>
  readonly registeredResourceOrigins?: ReadonlyArray<string>
}

export interface UpstreamRequest {
  readonly serverId: string
  readonly generation: number
  readonly path: string
  readonly method: "GET" | "POST" | "DELETE"
  readonly body?: Uint8Array
  readonly resourcePolicy?: "control" | "registered-resource"
}

export interface AuthenticatedServer {
  readonly server: UpstreamServer
  readonly catalogId: string | null
}

export type SourceLibrary = SourceLibraryView

export interface ResolvedPlayback {
  readonly serverId: string
  readonly generation: number
  readonly url: string
}

export interface UpstreamClientService {
  readonly request: <A>(
    request: UpstreamRequest,
    schema: Schema.Schema<A>
  ) => Effect.Effect<A, UpstreamFailure>
  readonly authenticate: (
    server: UpstreamServer
  ) => Effect.Effect<AuthenticatedServer, UpstreamFailure>
  readonly getServerIdentity: (serverId: string) => Effect.Effect<string | null, UpstreamFailure>
  readonly listSourceLibraries: (
    serverId: string
  ) => Effect.Effect<ReadonlyArray<SourceLibrary>, UpstreamFailure>
  readonly resolvePlayback: (
    version: SourceMediaVersion
  ) => Effect.Effect<ResolvedPlayback, UpstreamFailure>
}

export class UpstreamClient extends Context.Service<UpstreamClient, UpstreamClientService>()(
  "oh-my-emby/UpstreamClient"
) {}

export interface UpstreamClientConfig {
  readonly fetch: typeof globalThis.fetch
  readonly destinationPolicy: DestinationPolicy
  readonly timeoutMs?: number
}

const normalizedBaseUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new InvalidUpstreamUrl()
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) throw new InvalidUpstreamUrl()
  return url
}

export const normalizeUpstreamBaseUrl = (value: string): string => {
  const url = normalizedBaseUrl(value)
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url.href.replace(/\/$/, "")
}

const isIpLiteral = (hostname: string): boolean => {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (bare.includes(":")) return true
  const parts = bare.split(".")
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

const isPrivateHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase()
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return true
  }
  if (!isIpLiteral(lower)) return false
  const bare = lower.replace(/^\[/, "").replace(/\]$/, "")
  if (bare.includes(":")) return bare === "::1" || bare.startsWith("fc") || bare.startsWith("fd") || bare.startsWith("fe80:")
  const [a = 0, b = 0] = bare.split(".").map(Number)
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

const validateDestination = (
  url: URL,
  server: UpstreamServer,
  policy: DestinationPolicy,
  resourcePolicy: UpstreamRequest["resourcePolicy"] = "control"
): Effect.Effect<void, DestinationRejected> => {
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Effect.fail(new DestinationRejected({ serverId: server.id }))
  }
  if (url.username !== "" || url.password !== "") {
    return Effect.fail(new DestinationRejected({ serverId: server.id }))
  }
  if (policy.platform === "workers") {
    if (isIpLiteral(hostname) || isPrivateHostname(hostname)) {
      return Effect.fail(new DestinationRejected({ serverId: server.id }))
    }
    return Effect.void
  }
  if (isPrivateHostname(hostname) || isIpLiteral(hostname)) {
    if (resourcePolicy === "control" && url.origin !== normalizedBaseUrl(server.baseUrl).origin) {
      return Effect.fail(new DestinationRejected({ serverId: server.id }))
    }
    const allowed = new Set((policy.administratorPrivateHosts ?? []).map((item) => item.toLowerCase()))
    if (!allowed.has(hostname.replace(/^\[/, "").replace(/\]$/, ""))) {
      return Effect.fail(new DestinationRejected({ serverId: server.id }))
    }
  }
  if (resourcePolicy === "registered-resource" && url.origin !== normalizedBaseUrl(server.baseUrl).origin) {
    if (!(policy.registeredResourceOrigins ?? []).includes(url.origin)) {
      return Effect.fail(new DestinationRejected({ serverId: server.id }))
    }
  }
  return Effect.void
}

const classifyStatus = (serverId: string, response: Response): Effect.Effect<void, UpstreamFailure> => {
  if (response.ok) return Effect.void
  if (response.status === 404) return Effect.fail(new UpstreamNotFound({ serverId }))
  return Effect.fail(new UpstreamRejected({ serverId, status: response.status }))
}

const readBoundedJson = (
  response: Response,
  serverId: string
): Effect.Effect<unknown, ResponseTooLarge | UpstreamInvalidResponse | UpstreamUnavailable> => Effect.gen(function*() {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_CONTROL_RESPONSE_BYTES) {
    return yield* Effect.fail(new ResponseTooLarge({ serverId }))
  }
  if (response.body === null) return yield* Effect.fail(new UpstreamInvalidResponse({ serverId }))
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  while (true) {
    const result = yield* Effect.tryPromise({
      try: (signal) => {
        const cancel = () => { void reader.cancel() }
        signal.addEventListener("abort", cancel, { once: true })
        return reader.read().finally(() => signal.removeEventListener("abort", cancel))
      },
      catch: () => new UpstreamUnavailable({ serverId })
    })
    if (result.done) break
    size += result.value.byteLength
    if (size > MAX_CONTROL_RESPONSE_BYTES) {
      yield* Effect.promise(() => reader.cancel()).pipe(Effect.ignore)
      return yield* Effect.fail(new ResponseTooLarge({ serverId }))
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return yield* Effect.try({
    try: () => JSON.parse(utf8.decode(bytes)) as unknown,
    catch: () => new UpstreamInvalidResponse({ serverId })
  })
})

const AuthenticationResponse = Schema.Struct({
  AccessToken: Schema.String,
  ServerId: Schema.optional(Schema.String)
})

const PublicSystemInfo = Schema.Struct({
  Id: Schema.optional(Schema.String)
})

const VirtualFolders = Schema.Array(Schema.Struct({
  ItemId: Schema.String,
  Name: Schema.String,
  CollectionType: Schema.optional(Schema.String)
}))

export const makeUpstreamClientLayer = (
  config: UpstreamClientConfig
): Layer.Layer<UpstreamClient, never, Repositories> => Layer.effect(UpstreamClient, Effect.gen(function*() {
  const repositories = yield* Repositories
  const timeoutMs = config.timeoutMs ?? UPSTREAM_DETAIL_DEADLINE_MS

  const deadline = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    serverId: string,
    durationMs = timeoutMs
  ): Effect.Effect<A, E | UpstreamTimeout, R> => effect.pipe(
    Effect.timeout(durationMs),
    Effect.catchTag("TimeoutError", () => Effect.fail(new UpstreamTimeout({ serverId })))
  )

  const getServer = (serverId: string): Effect.Effect<UpstreamServer, ServerNotFound | import("./errors.js").RepositoryError> =>
    repositories.getServer(serverId).pipe(Effect.flatMap((server) =>
      server === null ? Effect.fail(new ServerNotFound({ serverId })) : Effect.succeed(server)
    ))

  const fetchOnce = (
    server: UpstreamServer,
    url: URL,
    init: RequestInit
  ): Effect.Effect<Response, UpstreamUnavailable | UpstreamTimeout> => Effect.tryPromise({
    try: (signal) => config.fetch(new Request(url, { ...init, signal }), { signal }),
    catch: () => new UpstreamUnavailable({ serverId: server.id })
  }).pipe(
    Effect.timeout(timeoutMs),
    Effect.catchTag("TimeoutError", () => Effect.fail(new UpstreamTimeout({ serverId: server.id })))
  )

  const fetchWithRedirects = (
    server: UpstreamServer,
    request: UpstreamRequest,
    token: string | null,
    transportRetry = true
  ): Effect.Effect<Response, UpstreamFailure> => Effect.gen(function*() {
    const base = yield* Effect.try({
      try: () => normalizedBaseUrl(server.baseUrl),
      catch: (error) => error instanceof InvalidUpstreamUrl ? error : new InvalidUpstreamUrl()
    })
    const url = yield* Effect.try({
      try: () => new URL(request.path, `${base.href.replace(/\/$/, "")}/`),
      catch: () => new InvalidUpstreamUrl()
    })
    yield* validateDestination(url, server, config.destinationPolicy, request.resourcePolicy)

    let current = url
    let method: UpstreamRequest["method"] = request.method
    let body = request.body
    let headers = new Headers({
      accept: "application/json",
      "user-agent": server.userAgent,
      "x-emby-authorization": `MediaBrowser Client="oh-my-emby", Device="oh-my-emby", DeviceId="${server.id}", Version="0.0.0"`
    })
    if (body !== undefined) headers.set("content-type", "application/json")
    if (token !== null) headers.set("x-emby-token", token)
    const visited = new Set([current.href])

    for (let redirectCount = 0; ; redirectCount++) {
      const init: RequestInit = body === undefined
        ? { method, headers, redirect: "manual" }
        : { method, headers, body: Uint8Array.from(body).buffer, redirect: "manual" }
      const response = yield* fetchOnce(server, current, init).pipe(
        Effect.catchTag("UpstreamUnavailable", (failure) =>
          transportRetry && request.method === "GET" && (request.resourcePolicy ?? "control") === "control"
            ? fetchWithRedirects(server, request, token, false)
            : Effect.fail(failure)
        )
      )
      if (!redirects.has(response.status)) return response
      if (redirectCount >= MAX_REDIRECTS) {
        return yield* Effect.fail(new RedirectLimitExceeded({ serverId: server.id }))
      }
      const location = response.headers.get("location")
      if (location === null) return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: server.id }))
      const next = yield* Effect.try({
        try: () => new URL(location, current),
        catch: () => new InvalidUpstreamUrl()
      })
      yield* validateDestination(next, server, config.destinationPolicy, request.resourcePolicy)
      if (current.protocol === "https:" && next.protocol === "http:") {
        return yield* Effect.fail(new HttpsDowngrade({ serverId: server.id }))
      }
      if (visited.has(next.href)) return yield* Effect.fail(new RedirectLoop({ serverId: server.id }))
      visited.add(next.href)
      if (next.origin !== current.origin) {
        if (method !== "GET") return yield* Effect.fail(new DestinationRejected({ serverId: server.id }))
        headers = new Headers({ accept: "application/json", "user-agent": server.userAgent })
        body = undefined
      } else if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET"
        body = undefined
        headers.delete("content-type")
      }
      current = next
    }
  })

  const decodeResponse = <A>(
    response: Response,
    serverId: string,
    schema: Schema.Schema<A>
  ): Effect.Effect<A, UpstreamFailure> => Effect.gen(function*() {
    yield* classifyStatus(serverId, response)
    const value = yield* readBoundedJson(response, serverId)
    const decode = Schema.decodeUnknownEffect(schema) as (
      input: unknown
    ) => Effect.Effect<A, unknown, never>
    return yield* decode(value).pipe(
      Effect.mapError(() => new UpstreamInvalidResponse({ serverId }))
    )
  })

  const authenticate: UpstreamClientService["authenticate"] = (server) => deadline(Effect.gen(function*() {
    if (server.password === null) return yield* Effect.fail(new UpstreamRejected({ serverId: server.id, status: 401 }))
    const body = new TextEncoder().encode(JSON.stringify({ Username: server.username, Pw: server.password }))
    const response = yield* fetchWithRedirects(server, {
      serverId: server.id,
      generation: server.generation,
      path: "/Users/AuthenticateByName",
      method: "POST",
      body
    }, null, false)
    const authenticated = yield* decodeResponse(response, server.id, AuthenticationResponse)
    const saved = yield* repositories.saveServerResult({
      serverId: server.id,
      expectedGeneration: server.generation,
      accessToken: authenticated.AccessToken,
      accessTokenExpiresAtMs: null,
      updatedAtMs: Date.now()
    })
    if (saved === null) return yield* Effect.fail(new ObsoleteGeneration({ serverId: server.id }))
    return {
      server: saved,
      catalogId: authenticated.ServerId?.trim() || null
    }
  }), server.id)

  const request: UpstreamClientService["request"] = <A>(
    input: UpstreamRequest,
    schema: Schema.Schema<A>
  ) => deadline(Effect.gen(function*() {
    const server = yield* getServer(input.serverId)
    if (server.generation !== input.generation) {
      return yield* Effect.fail(new ObsoleteGeneration({ serverId: input.serverId }))
    }
    let response = yield* fetchWithRedirects(server, input, server.accessToken)
    if (response.status === 401 && server.password !== null) {
      const refreshed = yield* authenticate(server)
      response = yield* fetchWithRedirects(refreshed.server, input, refreshed.server.accessToken, false)
    }
    const decoded = yield* decodeResponse(response, input.serverId, schema)
    const current = yield* getServer(input.serverId)
    if (current.generation !== input.generation) {
      return yield* Effect.fail(new ObsoleteGeneration({ serverId: input.serverId }))
    }
    return decoded
  }), input.serverId, config.timeoutMs ?? (
    input.path === "/Library/VirtualFolders" ? UPSTREAM_LIST_DEADLINE_MS : UPSTREAM_DETAIL_DEADLINE_MS
  ))

  const getServerIdentity: UpstreamClientService["getServerIdentity"] = (serverId) => deadline(Effect.gen(function*() {
    const server = yield* getServer(serverId)
    const authenticated = yield* authenticate(server)
    if (authenticated.catalogId !== null) return authenticated.catalogId
    const response = yield* fetchWithRedirects(authenticated.server, {
      serverId,
      generation: server.generation,
      path: "/System/Info/Public",
      method: "GET"
    }, null)
    const info = yield* decodeResponse(response, serverId, PublicSystemInfo)
    return info.Id?.trim() || null
  }), serverId)

  const listSourceLibraries: UpstreamClientService["listSourceLibraries"] = (serverId) => Effect.gen(function*() {
    const server = yield* getServer(serverId)
    const folders = yield* request({
      serverId,
      generation: server.generation,
      path: "/Library/VirtualFolders",
      method: "GET"
    }, VirtualFolders)
    return folders.flatMap((folder): ReadonlyArray<SourceLibrary> => {
      const mediaType = folder.CollectionType === "movies"
        ? "movies" as const
        : folder.CollectionType === "tvshows" || folder.CollectionType === "series"
        ? "series" as const
        : null
      return mediaType === null || folder.ItemId.trim() === "" || folder.Name.trim() === ""
        ? []
        : [{ id: folder.ItemId as SourceLibrary["id"], serverId: server.id, name: folder.Name, mediaType }]
    })
  })

  const resolvePlayback: UpstreamClientService["resolvePlayback"] = (version) => Effect.gen(function*() {
    if (typeof version.capabilities !== "object" || version.capabilities === null || Array.isArray(version.capabilities)) {
      return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: "unknown" }))
    }
    const details = version.capabilities as Record<string, unknown>
    if (typeof details.serverId !== "string" || typeof details.url !== "string") {
      return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: "unknown" }))
    }
    const server = yield* getServer(details.serverId)
    if (server.generation !== version.serverGeneration) {
      return yield* Effect.fail(new ObsoleteGeneration({ serverId: server.id }))
    }
    const url = yield* Effect.try({
      try: () => new URL(details.url as string),
      catch: () => new InvalidUpstreamUrl()
    })
    yield* validateDestination(url, server, config.destinationPolicy, "registered-resource")
    return { serverId: server.id, generation: server.generation, url: url.href }
  })

  return UpstreamClient.of({ request, authenticate, getServerIdentity, listSourceLibraries, resolvePlayback })
}))
