import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Context, Effect, Layer, Result } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Cookies from "effect/unstable/http/Cookies"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DashboardApi } from "@oh-my-emby/contracts"

import {
  DASHBOARD_SESSION_COOKIE,
  dashboardSessionResponse,
  guardDashboardRequest,
  makeDashboardAuthLayers,
  makeDashboardSystemLayer,
  publicFailure
} from "../src/api/dashboard.js"
import { makeAuthLayer } from "../src/core/auth.js"
import { makeMetadataSettingsLayer } from "../src/core/metadata-settings.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const publicOrigin = "https://dashboard.example.com"
const credentials = { username: "owner", password: "valid password" }
const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()

const placeholderGroups = Layer.effectContext(Effect.gen(function*() {
  const services = yield* Effect.context<any>()
  let context = Context.empty()
  for (const identifier of ["servers", "libraries"] as const) {
    const group = DashboardApi.groups[identifier] as any
    const handlers = new Map<string, any>()
    const routes: Array<any> = []
    for (const endpointIdentifier in group.endpoints) {
      const endpoint = group.endpoints[endpointIdentifier]
      const handler = {
        endpoint,
        handler: () => Effect.die(new Error(`Unhandled endpoint: ${endpointIdentifier}`)),
        isRaw: false,
        uninterruptible: false
      }
      handlers.set(endpointIdentifier, handler)
      routes.push(HttpApiBuilder.handlerToRoute(group, handler, services))
    }
    context = Context.add(context, group, { handlers, routes })
  }
  return context
}))

const makeClient = (
  headers: () => Readonly<Record<string, string>>,
  baseUrl = publicOrigin
) => Effect.gen(function*() {
  const handler = yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(DashboardApi))
  const localClient = HttpClient.make((request) => {
    const serverRequest = HttpServerRequest.fromClientRequest(request)
    return handler.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.orDie,
      Effect.map((response) => HttpServerResponse.toClientResponse(response, { request }))
    )
  }).pipe(HttpClient.mapRequest((request) => HttpClientRequest.setHeaders(request, headers())))
  return yield* HttpApiClient.makeWith(DashboardApi, { httpClient: localClient, baseUrl })
})

describe("Dashboard authentication boundary", () => {
  let directory: string
  let filename: string
  let layer: Layer.Layer<any>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-dashboard-auth-"))
    filename = join(directory, "dashboard-auth.sqlite")
    const database = new Database(filename)
    database.exec(migration)
    database.close()
    const repositories = makeSqliteRepositoriesLayer({ filename })
    const auth = makeAuthLayer().pipe(Layer.provide(repositories))
    const metadataSettings = makeMetadataSettingsLayer.pipe(Layer.provide(repositories))
    const handlers = Layer.merge(
      makeDashboardAuthLayers().pipe(Layer.provide(auth)),
      makeDashboardSystemLayer().pipe(
        Layer.provide(Layer.mergeAll(repositories, auth, metadataSettings))
      )
    )
    layer = Layer.mergeAll(handlers, placeholderGroups, HttpServer.layerServices)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const withClient = <A>(
    headers: () => Readonly<Record<string, string>>,
    use: (client: HttpApiClient.Client<any>) => Effect.Effect<A, any, any>,
    baseUrl = publicOrigin
  ) => Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const client = yield* makeClient(headers, baseUrl)
    return yield* use(client)
  })).pipe(Effect.provide(layer)))

  it("sets the opaque session cookie with all required flags", () => {
    const response = dashboardSessionResponse({
      token: "opaque-token",
      expiresAtMs: Date.UTC(2030, 0, 1),
      view: { authenticated: true, username: "owner" }
    })
    expect(Cookies.toSetCookieHeaders(response.cookies)).toEqual([
      expect.stringContaining("oh_my_emby_session=opaque-token")
    ])
    const header = Cookies.toSetCookieHeaders(response.cookies)[0]!
    expect(header).toContain("HttpOnly")
    expect(header).toContain("Secure")
    expect(header).toContain("SameSite=Lax")
    expect(header).toContain("Path=/api/dashboard")
    expect(response.body._tag).toBe("Uint8Array")
    if (response.body._tag !== "Uint8Array") throw new Error("expected encoded JSON response")
    const body = JSON.parse(new TextDecoder().decode(response.body.body))
    expect(body).toEqual({ authenticated: true, username: "owner" })
    expect(body).not.toHaveProperty("token")
  })

  it("limits upstream rejection diagnostics to opted-in callers", () => {
    const failure = {
      _tag: "UpstreamRejected",
      serverId: "server-1",
      status: 401,
      detail: "Invalid username or password"
    }
    const publicFailureWithDiagnostic = publicFailure as (
      error: typeof failure,
      includeDiagnostic?: boolean
    ) => ReturnType<typeof publicFailure>
    const response = publicFailure(failure)
    const diagnosticResponse = publicFailureWithDiagnostic(failure, true)

    expect(response.body._tag).toBe("Uint8Array")
    if (response.body._tag !== "Uint8Array") throw new Error("expected encoded JSON response")
    expect(JSON.parse(new TextDecoder().decode(response.body.body))).toEqual({
      _tag: "UpstreamRejected",
      serverId: "server-1",
      status: 401
    })
    expect(diagnosticResponse.body._tag).toBe("Uint8Array")
    if (diagnosticResponse.body._tag !== "Uint8Array") throw new Error("expected encoded JSON response")
    expect(JSON.parse(new TextDecoder().decode(diagnosticResponse.body.body))).toEqual({
      _tag: "UpstreamRejected",
      serverId: "server-1",
      status: 401,
      detail: "Invalid username or password"
    })
  })

  it("limits upstream unavailability diagnostics to opted-in callers", () => {
    const failure = {
      _tag: "UpstreamUnavailable",
      serverId: "server-1",
      detail: "connection refused"
    }
    const response = publicFailure(failure)
    const diagnosticResponse = publicFailure(failure, true)

    expect(response.body._tag).toBe("Uint8Array")
    if (response.body._tag !== "Uint8Array") throw new Error("expected encoded JSON response")
    expect(JSON.parse(new TextDecoder().decode(response.body.body))).toEqual({
      _tag: "UpstreamUnavailable",
      serverId: "server-1"
    })
    expect(diagnosticResponse.body._tag).toBe("Uint8Array")
    if (diagnosticResponse.body._tag !== "Uint8Array") throw new Error("expected encoded JSON response")
    expect(JSON.parse(new TextDecoder().decode(diagnosticResponse.body.body))).toEqual({
      _tag: "UpstreamUnavailable",
      serverId: "server-1",
      detail: "connection refused"
    })
  })

  it("executes the real typed auth routes with cookie issuance, session lookup, and logout expiry", async () => {
    const requestHeaders: Record<string, string> = { origin: publicOrigin }
    await withClient(() => requestHeaders, (client) => Effect.gen(function*() {
      const [claimed, claimResponse] = yield* client.auth.claim({
        payload: credentials,
        responseMode: "decoded-and-response"
      })
      expect(claimed).toEqual({ authenticated: true, username: "owner" })
      const issued = Cookies.toSetCookieHeaders(claimResponse.cookies)[0]!
      expect(issued).toContain("Path=/api/dashboard")
      expect(issued).toContain("HttpOnly")
      expect(issued).toContain("Secure")
      expect(issued).toContain("SameSite=Lax")

      requestHeaders.cookie = Cookies.toCookieHeader(claimResponse.cookies)
      expect(yield* client.auth.getSession()).toEqual({ authenticated: true, username: "owner" })

      const logoutResponse = yield* client.auth.logout({ responseMode: "response-only" })
      const expired = Cookies.toSetCookieHeaders(logoutResponse.cookies)[0]!
      expect(expired).toContain(`${DASHBOARD_SESSION_COOKIE}=`)
      expect(expired).toContain("Path=/api/dashboard")
      expect(expired).toContain("HttpOnly")
      expect(expired).toContain("Secure")
      expect(expired).toContain("SameSite=Lax")
    }))
  })

  it("decodes real claim and login origin failures through the typed API", async () => {
    await withClient(() => ({ origin: "https://evil.example.com" }), (client) => Effect.gen(function*() {
      const claim = yield* client.auth.claim({ payload: credentials }).pipe(Effect.result)
      expect(Result.isFailure(claim) && claim.failure).toEqual({ _tag: "ForbiddenOrigin" })
      const login = yield* client.auth.login({ payload: credentials }).pipe(Effect.result)
      expect(Result.isFailure(login) && login.failure).toEqual({ _tag: "ForbiddenOrigin" })
    }))
  })

  it("redacts repository failures on the real typed route", async () => {
    const database = new Database(filename)
    database.run("DROP TABLE auth_rate_limits")
    database.close()
    await withClient(() => ({ origin: publicOrigin }), (client) => Effect.gen(function*() {
      const result = yield* client.auth.login({ payload: credentials }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isSuccess(result)) return
      expect(result.failure._tag).toBe("Internal")
      expect(Object.keys(result.failure).sort()).toEqual(["_tag", "requestId"])
      expect(JSON.stringify(result.failure)).not.toContain(credentials.password)
      expect(JSON.stringify(result.failure)).not.toContain("auth_rate_limits")
    }))
  })

  it("authenticates metadata settings routes and origin-checks mutations", async () => {
    const requestHeaders: Record<string, string> = { origin: publicOrigin }
    await withClient(() => requestHeaders, (client) => Effect.gen(function*() {
      const unauthenticatedGet = yield* client.system.getMetadataSettings().pipe(Effect.result)
      expect(Result.isFailure(unauthenticatedGet) && unauthenticatedGet.failure).toEqual({ _tag: "Unauthorized" })
      const unauthenticatedPut = yield* client.system.updateMetadataSettings({ payload: {
        providers: [
          { id: "tmdb", enabled: false, order: 0, language: null, credential: { _tag: "Preserve" } },
          { id: "trakt", enabled: false, order: 1, language: null, credential: { _tag: "Preserve" } }
        ]
      } }).pipe(Effect.result)
      expect(Result.isFailure(unauthenticatedPut) && unauthenticatedPut.failure).toEqual({ _tag: "Unauthorized" })

      const [, response] = yield* client.auth.claim({
        payload: credentials,
        responseMode: "decoded-and-response"
      })
      requestHeaders.cookie = Cookies.toCookieHeader(response.cookies)
      expect((yield* client.system.getMetadataSettings()).providers.map(({ id }) => id)).toEqual(["tmdb", "trakt"])

      requestHeaders.origin = "https://evil.example.com"
      const forbiddenPut = yield* client.system.updateMetadataSettings({ payload: {
        providers: [
          { id: "tmdb", enabled: true, order: 0, language: "zh-CN", credential: { _tag: "Set", value: "secret-token" } },
          { id: "trakt", enabled: false, order: 1, language: null, credential: { _tag: "Preserve" } }
        ]
      } }).pipe(Effect.result)
      expect(Result.isFailure(forbiddenPut) && forbiddenPut.failure).toEqual({ _tag: "ForbiddenOrigin" })
    }))

    await withClient(
      () => ({ origin: "https://evil.example.com", cookie: requestHeaders.cookie! }),
      (client) => Effect.gen(function*() {
        const allowedGet = yield* client.system.getMetadataSettings()
        expect(allowedGet.providers.map(({ id }) => id)).toEqual(["tmdb", "trakt"])
      }),
      "https://evil.example.com"
    )
  })

  it("returns only hasCredential after updating metadata settings", async () => {
    const requestHeaders: Record<string, string> = { origin: publicOrigin }
    await withClient(() => requestHeaders, (client) => Effect.gen(function*() {
      const [, response] = yield* client.auth.claim({
        payload: credentials,
        responseMode: "decoded-and-response"
      })
      requestHeaders.cookie = Cookies.toCookieHeader(response.cookies)
      const updated = yield* client.system.updateMetadataSettings({ payload: { providers: [
        { id: "trakt", enabled: true, order: 0, language: null, credential: { _tag: "Set", value: "trakt-client" } },
        { id: "tmdb", enabled: true, order: 1, language: "zh-CN", credential: { _tag: "Set", value: "tmdb-token" } }
      ] } })
      expect(updated.providers.map(({ id, hasCredential, status }) => ({ id, hasCredential, status }))).toEqual([
        { id: "trakt", hasCredential: true, status: "ready" },
        { id: "tmdb", hasCredential: true, status: "ready" }
      ])
      expect(JSON.stringify(updated)).not.toContain("trakt-client")
      expect(JSON.stringify(updated)).not.toContain("tmdb-token")
      expect(JSON.stringify(updated)).not.toContain("credential")
    }))
  })

  it("rejects a mutation from another origin", async () => {
    await expect(Effect.runPromise(guardDashboardRequest({
      method: "POST",
      requestUrl: "https://dashboard.example.com/api/dashboard/login",
      remoteAddress: "198.51.100.7",
      headers: { origin: "https://evil.example.com" }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("accepts the preserved public Host behind TLS termination without proxy configuration", async () => {
    await expect(Effect.runPromise(guardDashboardRequest({
      method: "POST",
      requestUrl: "http://internal:3000/api/dashboard/login",
      remoteAddress: "10.0.0.2",
      headers: {
        host: "dashboard.example.com:8443",
        origin: "https://dashboard.example.com:8443"
      }
    }))).resolves.toEqual({ clientKey: "10.0.0.2" })
  })

  it("rejects a mismatched or malformed Host even with a valid Origin", async () => {
    for (const host of ["other.example.com", "dashboard.example.com/path", "dashboard.example.com@evil.example.com"]) {
      await expect(Effect.runPromise(guardDashboardRequest({
        method: "POST",
        requestUrl: `${publicOrigin}/api/dashboard/login`,
        remoteAddress: "198.51.100.7",
        headers: { host, origin: publicOrigin }
      }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
    }
  })

  it("never uses forwarded IPs for rate limiting", async () => {
    await expect(Effect.runPromise(guardDashboardRequest({
      method: "POST",
      requestUrl: `${publicOrigin}/api/dashboard/login`,
      remoteAddress: "10.0.0.2",
      headers: {
        host: "dashboard.example.com",
        origin: publicOrigin,
        "x-forwarded-for": "198.51.100.9",
        "x-forwarded-host": "evil.example.com",
        "x-forwarded-proto": "http"
      }
    }))).resolves.toEqual({ clientKey: "10.0.0.2" })
  })

  it("allows explicit localhost HTTP development", async () => {
    await expect(Effect.runPromise(guardDashboardRequest({
      method: "POST",
      requestUrl: "http://localhost:3000/api/dashboard/login",
      remoteAddress: "127.0.0.1",
      headers: { origin: "http://localhost:3000" }
    }))).resolves.toMatchObject({ clientKey: "127.0.0.1" })
  })

  it("rejects localhost HTTP requests arriving from a non-loopback client", async () => {
    await expect(Effect.runPromise(guardDashboardRequest({
      method: "POST",
      requestUrl: "http://localhost:3000/api/dashboard/login",
      remoteAddress: "198.51.100.7",
      headers: { origin: "http://localhost:3000" }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("rejects localhost HTTP safe reads from a non-loopback client", async () => {
    await expect(Effect.runPromise(guardDashboardRequest({
      method: "GET",
      requestUrl: "http://localhost:3000/api/dashboard/bootstrap",
      remoteAddress: "198.51.100.7",
      headers: { host: "localhost:3000" }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("never lets forwarded headers replace a missing public Host", async () => {
    await expect(Effect.runPromise(guardDashboardRequest({
      method: "POST",
      requestUrl: "http://internal:3000/api/dashboard/login",
      remoteAddress: "198.51.100.7",
      headers: {
        origin: "https://dashboard.example.com",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "dashboard.example.com",
        "x-forwarded-proto": "https"
      }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("rejects public HTTP mutations and malformed or absent origins", async () => {
    for (const origin of ["http://dashboard.example.com", "https://dashboard.example.com/path", "null", undefined]) {
      await expect(Effect.runPromise(guardDashboardRequest({
        method: "POST",
        requestUrl: `${publicOrigin}/api/dashboard/login`,
        remoteAddress: "198.51.100.7",
        headers: { host: "dashboard.example.com", origin }
      }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
    }
  })

  it("accepts a safe read without Origin on an arbitrary valid Host", async () => {
    await expect(Effect.runPromise(guardDashboardRequest({
      method: "GET",
      requestUrl: "https://other.example.com/api/dashboard/bootstrap",
      remoteAddress: "198.51.100.7",
      headers: { host: "other.example.com" }
    }))).resolves.toEqual({ clientKey: "198.51.100.7" })
  })
})
