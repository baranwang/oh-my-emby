import { DashboardApi } from "@oh-my-emby/contracts"
import { Effect, Layer, Option, Result } from "effect"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as HttpServerRequestModule from "effect/unstable/http/HttpServerRequest"
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { Auth, type AuthService, type DashboardSession } from "../core/auth.js"
import { InvalidCredentials } from "../core/errors.js"
import { LibraryService } from "../core/library-service.js"
import { MetadataSettings } from "../core/metadata-settings.js"
import { Repositories } from "../core/repositories.js"
import { ServerService } from "../core/server-service.js"

export const DASHBOARD_SESSION_COOKIE = "oh_my_emby_session"
const dashboardCookiePath = "/api/dashboard"

export const toDashboardWebResponse = <R>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError,
    R
  >,
  request: Request,
  dashboardRequest: HttpServerRequest
) => Effect.scoped(handler.pipe(
  Effect.provideService(HttpServerRequestModule.HttpServerRequest, dashboardRequest),
  Effect.catchTag("HttpServerError", (error) => error.reason._tag === "RouteNotFound"
    ? HttpServerRespondable.toResponse(error)
    : Effect.die(error)),
  Effect.map((response) => HttpServerResponse.toWeb(response, { withoutBody: request.method === "HEAD" }))
))

export interface DashboardRequestPolicyConfig {
  readonly publicOrigin: string
  readonly trustedProxyAddresses: ReadonlyArray<string>
}

export interface DashboardRequestPolicy {
  readonly publicOrigin: URL
  readonly trustedProxyAddresses: ReadonlySet<string>
}

export interface DashboardRequest {
  readonly method: string
  readonly requestUrl: string
  readonly remoteAddress?: string
  readonly headers: Readonly<Record<string, string | undefined>>
}

export interface GuardedDashboardRequest {
  readonly clientKey: string
}

export interface AuthorizedDashboardRequest<A> extends GuardedDashboardRequest {
  readonly principal: A
}

export interface ForbiddenOriginFailure {
  readonly _tag: "ForbiddenOrigin"
}

const forbiddenOrigin = (): ForbiddenOriginFailure => ({ _tag: "ForbiddenOrigin" })

const isLocalhost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"

const isLoopbackAddress = (address: string | undefined): boolean =>
  address === "127.0.0.1" || address === "::1" || address === "[::1]" || address === "::ffff:127.0.0.1"

export const makeDashboardRequestPolicy = (
  config: DashboardRequestPolicyConfig
): DashboardRequestPolicy => {
  const publicOrigin = new URL(config.publicOrigin)
  if (
    publicOrigin.origin !== config.publicOrigin ||
    (publicOrigin.protocol !== "https:" && !(publicOrigin.protocol === "http:" && isLocalhost(publicOrigin.hostname)))
  ) {
    throw new TypeError("public origin must be an exact HTTPS origin or explicit localhost HTTP origin")
  }
  return {
    publicOrigin,
    trustedProxyAddresses: new Set(config.trustedProxyAddresses)
  }
}

export const guardDashboardRequest = (
  policy: DashboardRequestPolicy,
  request: DashboardRequest
): Effect.Effect<GuardedDashboardRequest, ForbiddenOriginFailure> => Effect.gen(function*() {
  if (policy.publicOrigin.protocol === "http:" && !isLoopbackAddress(request.remoteAddress)) {
    return yield* Effect.fail(forbiddenOrigin())
  }
  const directOrigin = new URL(request.requestUrl).origin
  const trustedProxy = request.remoteAddress !== undefined &&
    policy.trustedProxyAddresses.has(request.remoteAddress)
  const forwardedOrigin = trustedProxy &&
      request.headers["x-forwarded-proto"] !== undefined &&
      request.headers["x-forwarded-host"] !== undefined
    ? `${request.headers["x-forwarded-proto"]}://${request.headers["x-forwarded-host"]}`
    : null
  if (directOrigin !== policy.publicOrigin.origin && forwardedOrigin !== policy.publicOrigin.origin) {
    return yield* Effect.fail(forbiddenOrigin())
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    if (request.headers.origin !== policy.publicOrigin.origin) {
      return yield* Effect.fail(forbiddenOrigin())
    }
  }
  const forwardedFor = trustedProxy ? request.headers["x-forwarded-for"]?.split(",")[0]?.trim() : undefined
  return { clientKey: forwardedFor || request.remoteAddress || "unknown" }
})

export const authorizeDashboardControlRequest = <A, E>(
  policy: DashboardRequestPolicy,
  request: DashboardRequest,
  token: string | undefined,
  authenticate: (token: string) => Effect.Effect<A, E>
): Effect.Effect<AuthorizedDashboardRequest<A>, ForbiddenOriginFailure | InvalidCredentials | E> =>
  Effect.gen(function*() {
    const boundary = yield* guardDashboardRequest(policy, request)
    if (token === undefined) return yield* Effect.fail(new InvalidCredentials())
    const principal = yield* authenticate(token)
    return { ...boundary, principal }
  })

const cookieOptions = (expiresAtMs: number) => ({
  expires: new Date(expiresAtMs),
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: dashboardCookiePath
})

export const dashboardSessionResponse = (session: DashboardSession): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setCookieUnsafe(
    HttpServerResponse.jsonUnsafe(session.view),
    DASHBOARD_SESSION_COOKIE,
    session.token,
    cookieOptions(session.expiresAtMs)
  )

const expireDashboardSession = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.expireCookie(response, DASHBOARD_SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: dashboardCookiePath
  }).pipe(Effect.orDie)

const statusFor = (tag: string): number => {
  switch (tag) {
    case "ForbiddenOrigin": return 403
    case "AlreadyInitialized": return 409
    case "ServerNotFound":
    case "LibraryNotFound":
    case "UpstreamNotFound": return 404
    case "InvalidUpstreamUrl":
    case "LibraryValidationFailed": return 400
    case "CatalogIdentityMismatch":
    case "CatalogIdentityUnverifiable":
    case "ObsoleteGeneration":
    case "ServerLimitExceeded": return 409
    case "UpstreamUnavailable":
    case "DestinationRejected":
    case "RedirectLimitExceeded":
    case "RedirectLoop":
    case "HttpsDowngrade":
    case "ResponseTooLarge":
    case "UpstreamInvalidResponse": return 503
    case "UpstreamRejected": return 502
    case "UpstreamTimeout": return 504
    case "InvalidCredentials":
    case "AuthenticationChanged":
    case "RateLimited": return 401
    default: return 500
  }
}

export const publicFailure = (
  error: { readonly _tag?: string },
  includeDiagnostic = false
): HttpServerResponse.HttpServerResponse => {
  const tag = error._tag ?? "RepositoryError"
  const serverId = "serverId" in error && typeof error.serverId === "string" ? error.serverId : "unknown"
  const detail = includeDiagnostic && "detail" in error && typeof error.detail === "string" ? error.detail : undefined
  const diagnostic = detail === undefined ? {} : { detail }
  const body = tag === "AlreadyInitialized"
    ? { _tag: "Conflict", code: "already_initialized" }
    : tag === "ForbiddenOrigin"
    ? { _tag: "ForbiddenOrigin" }
    : tag === "InvalidCredentials" || tag === "AuthenticationChanged" || tag === "RateLimited"
    ? { _tag: "Unauthorized" }
    : tag === "ServerNotFound" || tag === "LibraryNotFound"
    ? { _tag: "NotFound" }
    : tag === "InvalidUpstreamUrl" || tag === "LibraryValidationFailed"
    ? { _tag: "ValidationFailed", fieldErrors: [{ field: "configuration", message: "invalid configuration" }] }
    : tag === "CatalogIdentityMismatch" || tag === "CatalogIdentityUnverifiable" || tag === "ObsoleteGeneration" || tag === "ServerLimitExceeded"
    ? { _tag: "Conflict", code: tag === "CatalogIdentityMismatch"
      ? "catalog_identity_mismatch"
      : tag === "CatalogIdentityUnverifiable"
      ? "catalog_identity_unverifiable"
      : tag === "ObsoleteGeneration"
      ? "obsolete_generation"
      : "server_limit_exceeded" }
    : tag === "UpstreamRejected"
    ? { _tag: "UpstreamRejected", serverId, status: "status" in error && typeof error.status === "number" ? error.status : 502, ...diagnostic }
    : tag === "UpstreamNotFound"
    ? { _tag: "UpstreamRejected", serverId, status: 404, ...diagnostic }
    : tag === "UpstreamTimeout"
    ? { _tag: "Timeout" }
    : tag === "UpstreamUnavailable" || tag === "DestinationRejected" || tag === "RedirectLimitExceeded" ||
        tag === "RedirectLoop" || tag === "HttpsDowngrade" || tag === "ResponseTooLarge" || tag === "UpstreamInvalidResponse"
    ? { _tag: "UpstreamUnavailable", serverId, ...diagnostic }
    : { _tag: "Internal", requestId: crypto.randomUUID() }
  return HttpServerResponse.jsonUnsafe(body, { status: statusFor(tag) })
}

const requestMetadata = (request: HttpServerRequest): DashboardRequest => {
  const remoteAddress = Option.getOrUndefined(request.remoteAddress)
  const metadata = {
    method: request.method,
    requestUrl: request.originalUrl,
    headers: request.headers
  }
  return remoteAddress === undefined ? metadata : { ...metadata, remoteAddress }
}

const guarded = (policy: DashboardRequestPolicy, request: HttpServerRequest) =>
  guardDashboardRequest(policy, requestMetadata(request))

const authorized = (policy: DashboardRequestPolicy, request: HttpServerRequest, auth: AuthService) =>
  authorizeDashboardControlRequest(
    policy,
    requestMetadata(request),
    request.cookies[DASHBOARD_SESSION_COOKIE],
    auth.authenticateDashboard
  )

const resultOrFailure = <A, E extends { readonly _tag?: string }>(effect: Effect.Effect<A, E, never>) =>
  effect.pipe(Effect.result, Effect.map((result) => Result.isFailure(result) ? publicFailure(result.failure) : result.success))

export const makeDashboardAuthLayers = (
  config: DashboardRequestPolicyConfig
) => {
  const policy = makeDashboardRequestPolicy(config)
  const bootstrap = HttpApiBuilder.group(DashboardApi, "bootstrap", (handlers) => Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handle("getBootstrap", ({ request }) => Effect.gen(function*() {
      const boundary = yield* guarded(policy, request).pipe(Effect.result)
      if (Result.isFailure(boundary)) return publicFailure(boundary.failure)
      const result = yield* auth.bootstrap().pipe(Effect.result)
      return Result.isFailure(result) ? publicFailure(result.failure) : result.success
    }))
  }))
  const authentication = HttpApiBuilder.group(DashboardApi, "auth", (handlers) => Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handleAll({
      getSession: ({ request }) => Effect.gen(function*() {
        const boundary = yield* guarded(policy, request).pipe(Effect.result)
        if (Result.isFailure(boundary)) return publicFailure(boundary.failure)
        const token = request.cookies[DASHBOARD_SESSION_COOKIE]
        if (!token) return { authenticated: false, username: null }
        const principal = yield* auth.authenticateDashboard(token).pipe(Effect.result)
        if (Result.isFailure(principal)) {
          return yield* expireDashboardSession(HttpServerResponse.jsonUnsafe({
            authenticated: false,
            username: null
          }))
        }
        return dashboardSessionResponse({
          token,
          expiresAtMs: principal.success.expiresAtMs,
          view: { authenticated: true, username: principal.success.username }
        })
      }),
      claim: ({ payload, request }) => Effect.gen(function*() {
        const boundary = yield* guarded(policy, request).pipe(Effect.result)
        if (Result.isFailure(boundary)) return publicFailure(boundary.failure)
        const session = yield* auth.claim(payload, {
          scopeKey: `claim:${boundary.success.clientKey}`
        }).pipe(Effect.result)
        return Result.isFailure(session) ? publicFailure(session.failure) : dashboardSessionResponse(session.success)
      }),
      login: ({ payload, request }) => Effect.gen(function*() {
        const boundary = yield* guarded(policy, request).pipe(Effect.result)
        if (Result.isFailure(boundary)) return publicFailure(boundary.failure)
        const session = yield* auth.loginDashboard(payload, {
          scopeKey: `dashboard:${boundary.success.clientKey}:${payload.username}`
        }).pipe(Effect.result)
        return Result.isFailure(session) ? publicFailure(session.failure) : dashboardSessionResponse(session.success)
      }),
      logout: ({ request }) => Effect.gen(function*() {
        const boundary = yield* guarded(policy, request).pipe(Effect.result)
        if (Result.isFailure(boundary)) return publicFailure(boundary.failure)
        const token = request.cookies[DASHBOARD_SESSION_COOKIE]
        if (!token) return publicFailure({ _tag: "InvalidCredentials" })
        const principal = yield* auth.authenticateDashboard(token).pipe(Effect.result)
        if (Result.isFailure(principal)) return publicFailure(principal.failure)
        const logout = yield* auth.logoutDashboard(principal.success).pipe(Effect.result)
        if (Result.isFailure(logout)) return publicFailure(logout.failure)
        return yield* expireDashboardSession(HttpServerResponse.empty())
      }),
      changePassword: ({ payload, request }) => Effect.gen(function*() {
        const boundary = yield* guarded(policy, request).pipe(Effect.result)
        if (Result.isFailure(boundary)) return publicFailure(boundary.failure)
        const token = request.cookies[DASHBOARD_SESSION_COOKIE]
        if (!token) return publicFailure({ _tag: "InvalidCredentials" })
        const principal = yield* auth.authenticateDashboard(token).pipe(Effect.result)
        if (Result.isFailure(principal)) return publicFailure(principal.failure)
        const changed = yield* auth.changePassword(principal.success, payload).pipe(Effect.result)
        return Result.isFailure(changed)
          ? publicFailure(changed.failure)
          : yield* expireDashboardSession(HttpServerResponse.empty())
      })
    })
  }))
  return Layer.merge(bootstrap, authentication)
}

export const makeDashboardControlPlaneLayers = (
  config: DashboardRequestPolicyConfig
) => {
  const policy = makeDashboardRequestPolicy(config)
  const servers = HttpApiBuilder.group(DashboardApi, "servers", (handlers) => Effect.gen(function*() {
    const auth = yield* Auth
    const service = yield* ServerService
    return handlers.handleAll({
      listServers: ({ request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.list())
      }),
      createServer: ({ payload, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.create(payload))
      }),
      getServer: ({ params, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.get(params.id))
      }),
      updateServer: ({ params, payload, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.update(params.id, payload))
      }),
      deleteServer: ({ params, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        const removed = yield* service.delete(params.id).pipe(Effect.result)
        return Result.isFailure(removed) ? publicFailure(removed.failure) : HttpServerResponse.empty()
      }),
      testServerConnection: ({ params, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        const result = yield* service.testConnection(params.id, true).pipe(Effect.result)
        return Result.isFailure(result) ? publicFailure(result.failure, true) : result.success
      }),
      getServerHealth: ({ params, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.getRecord(params.id).pipe(Effect.map((server) => ({
          serverId: server.id,
          health: server.health,
          lastSuccessAtMs: server.lastSuccessAtMs
        }))))
      }),
      listSourceLibraries: ({ params, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.listSourceLibraries(params.id))
      })
    })
  }))
  const libraries = HttpApiBuilder.group(DashboardApi, "libraries", (handlers) => Effect.gen(function*() {
    const auth = yield* Auth
    const service = yield* LibraryService
    return handlers.handleAll({
      listVirtualLibraries: ({ request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.list())
      }),
      createVirtualLibrary: ({ payload, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.create(payload))
      }),
      getVirtualLibrary: ({ params, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.get(params.id))
      }),
      updateVirtualLibrary: ({ params, payload, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(service.update(params.id, payload))
      }),
      deleteVirtualLibrary: ({ params, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        const removed = yield* service.delete(params.id).pipe(Effect.result)
        return Result.isFailure(removed) ? publicFailure(removed.failure) : HttpServerResponse.empty()
      })
    })
  }))
  return Layer.mergeAll(servers, libraries, makeDashboardSystemLayer(config))
}

export const makeDashboardSystemLayer = (
  config: DashboardRequestPolicyConfig
) => {
  const policy = makeDashboardRequestPolicy(config)
  return HttpApiBuilder.group(DashboardApi, "system", (handlers) => Effect.gen(function*() {
    const auth = yield* Auth
    const metadataSettings = yield* MetadataSettings
    const repositories = yield* Repositories
    return handlers.handleAll({
      getSystemStatus: ({ request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(repositories.readSystemStatus())
      }),
      listOutboxFailures: ({ request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(repositories.listOutboxFailures())
      }),
      getMetadataSettings: ({ request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(metadataSettings.get())
      }),
      updateMetadataSettings: ({ payload, request }) => Effect.gen(function*() {
        const access = yield* authorized(policy, request, auth).pipe(Effect.result)
        if (Result.isFailure(access)) return publicFailure(access.failure)
        return yield* resultOrFailure(metadataSettings.update(payload))
      })
    })
  }))
}
