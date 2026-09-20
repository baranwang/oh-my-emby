import { DashboardApi } from "@oh-my-emby/contracts"
import { Effect, Layer, Option, Result } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { Auth, type DashboardSession } from "../core/auth.js"

export const DASHBOARD_SESSION_COOKIE = "oh_my_emby_session"

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

const cookieOptions = (expiresAtMs: number) => ({
  expires: new Date(expiresAtMs),
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/dashboard"
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
    path: "/dashboard"
  }).pipe(Effect.orDie)

const statusFor = (tag: string): number => {
  switch (tag) {
    case "ForbiddenOrigin": return 403
    case "AlreadyInitialized": return 409
    case "InvalidCredentials":
    case "AuthenticationChanged":
    case "RateLimited": return 401
    default: return 500
  }
}

const publicFailure = (error: { readonly _tag?: string }): HttpServerResponse.HttpServerResponse => {
  const tag = error._tag ?? "RepositoryError"
  const body = tag === "AlreadyInitialized"
    ? { _tag: "Conflict", code: "already_initialized" }
    : tag === "ForbiddenOrigin"
    ? { _tag: "ForbiddenOrigin" }
    : tag === "InvalidCredentials" || tag === "AuthenticationChanged" || tag === "RateLimited"
    ? { _tag: "Unauthorized" }
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
