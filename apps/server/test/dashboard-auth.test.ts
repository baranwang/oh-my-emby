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
  makeDashboardRequestPolicy,
  publicFailure
} from "../src/api/dashboard.js"
import { makeAuthLayer } from "../src/core/auth.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const publicOrigin = "https://dashboard.example.com"
const credentials = { username: "owner", password: "valid password" }
const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()

const placeholderGroups = Layer.effectContext(Effect.gen(function*() {
  const services = yield* Effect.context<any>()
  let context = Context.empty()
  for (const identifier of ["servers", "libraries", "system"] as const) {
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

const makeClient = (headers: () => Readonly<Record<string, string>>) => Effect.gen(function*() {
  const handler = yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(DashboardApi))
  const localClient = HttpClient.make((request) => {
    const serverRequest = HttpServerRequest.fromClientRequest(request)
    return handler.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.orDie,
      Effect.map((response) => HttpServerResponse.toClientResponse(response, { request }))
    )
  }).pipe(HttpClient.mapRequest((request) => HttpClientRequest.setHeaders(request, headers())))
  return yield* HttpApiClient.makeWith(DashboardApi, { httpClient: localClient, baseUrl: publicOrigin })
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
    const handlers = makeDashboardAuthLayers({
      publicOrigin,
      trustedProxyAddresses: []
    }).pipe(Layer.provide(auth))
    layer = Layer.mergeAll(handlers, placeholderGroups, HttpServer.layerServices)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const withClient = <A>(
    headers: () => Readonly<Record<string, string>>,
    use: (client: HttpApiClient.Client<any>) => Effect.Effect<A, any, any>
  ) => Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const client = yield* makeClient(headers)
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

  it("rejects a mutation from any origin except the exact configured origin", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "https://dashboard.example.com",
      trustedProxyAddresses: []
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "https://dashboard.example.com/api/dashboard/login",
      remoteAddress: "198.51.100.7",
      headers: { origin: "https://evil.example.com" }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("allows explicit localhost HTTP development", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "http://localhost:3000",
      trustedProxyAddresses: []
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "http://localhost:3000/api/dashboard/login",
      remoteAddress: "127.0.0.1",
      headers: { origin: "http://localhost:3000" }
    }))).resolves.toMatchObject({ clientKey: "127.0.0.1" })
  })

  it("rejects localhost HTTP requests arriving from a non-loopback client", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "http://localhost:3000",
      trustedProxyAddresses: []
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "http://localhost:3000/api/dashboard/login",
      remoteAddress: "198.51.100.7",
      headers: { origin: "http://localhost:3000" }
    }))).rejects.toEqual({ _tag: "ForbiddenOrigin" })
  })

  it("accepts proxy transport headers only from an explicit trusted address", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "https://dashboard.example.com",
      trustedProxyAddresses: ["10.0.0.2"]
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
      method: "POST",
      requestUrl: "http://internal:3000/api/dashboard/login",
      remoteAddress: "10.0.0.2",
      headers: {
        origin: "https://dashboard.example.com",
        "x-forwarded-for": "198.51.100.9, 10.0.0.2",
        "x-forwarded-host": "dashboard.example.com",
        "x-forwarded-proto": "https"
      }
    }))).resolves.toEqual({ clientKey: "198.51.100.9" })
  })

  it("never lets arbitrary forwarded headers grant transport trust", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "https://dashboard.example.com",
      trustedProxyAddresses: ["10.0.0.2"]
    })
    await expect(Effect.runPromise(guardDashboardRequest(policy, {
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

  it("rejects non-localhost HTTP public origins at configuration time", () => {
    expect(() => makeDashboardRequestPolicy({
      publicOrigin: "http://dashboard.example.com",
      trustedProxyAddresses: []
    })).toThrow("public origin")
  })
})
