import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { MAX_CONNECTION_DIAGNOSTIC_BYTES, MAX_CONTROL_RESPONSE_BYTES } from "../src/core/limits.js"
import type { UpstreamEndpoint, UpstreamServer } from "../src/core/model.js"
import { Repositories } from "../src/core/repositories.js"
import {
  UpstreamClient,
  effectiveUserAgent,
  endpointUrl,
  makeUpstreamClientLayer,
  type DestinationPolicy
} from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = [
  await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text(),
  await Bun.file(new URL("../migrations/0002_dashboard_alignment.sql", import.meta.url)).text()
].join("\n")
const JsonOk = Schema.Struct({ ok: Schema.Boolean })

const endpoint = (host = "example.com", order = 0, overrides: Partial<UpstreamEndpoint> = {}): UpstreamEndpoint => ({
  id: `endpoint-${order}`,
  protocol: "https",
  host,
  port: null,
  path: "",
  displayUrl: `https://${host}` as any,
  verifiedCatalogId: "catalog-id",
  health: "healthy",
  lastSuccessAtMs: 1_000,
  order,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
  ...overrides
})

const server = (overrides: Partial<UpstreamServer> = {}): UpstreamServer => ({
  id: "server-1" as any,
  catalogNamespace: "catalog:server-1",
  verifiedCatalogId: "catalog-id",
  verifiedBaseUrl: "https://example.com",
  generation: 1,
  name: "Home",
  endpoints: [endpoint()],
  baseUrl: "https://example.com" as any,
  username: "alice",
  password: "password",
  accessToken: "token-1",
  accessTokenExpiresAtMs: null,
  upstreamUserId: "upstream-user-id",
  userAgentPolicy: "fixed",
  userAgent: "Configured-Agent/1",
  enabled: true,
  health: "healthy",
  lastSuccessAtMs: 1_000,
  deletedAtMs: null,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
  ...overrides
})

const workers: DestinationPolicy = { platform: "workers" }

describe("UpstreamClient", () => {
  let directory: string
  let filename: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-upstream-"))
    filename = join(directory, "upstream.sqlite")
    const database = new Database(filename)
    database.exec(migration)
    database.close()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const run = async <A>(
    fetch: typeof globalThis.fetch,
    use: Effect.Effect<A, any, UpstreamClient>,
    options: {
      readonly server?: UpstreamServer
      readonly policy?: DestinationPolicy
      readonly timeoutMs?: number
      readonly rawBaseUrl?: string
    } = {}
  ) => {
    const repositories = makeSqliteRepositoriesLayer({ filename })
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      yield* repo.saveServer(options.server ?? server())
    }).pipe(Effect.provide(repositories)))
    if (options.rawBaseUrl !== undefined) {
      const database = new Database(filename)
      database.run("UPDATE upstream_servers SET base_url = ? WHERE id = 'server-1'", [options.rawBaseUrl])
      database.close()
    }
    return Effect.runPromise(use.pipe(Effect.provide(
      makeUpstreamClientLayer({
        fetch,
        destinationPolicy: options.policy ?? workers,
        timeoutMs: options.timeoutMs
      }).pipe(Layer.provide(repositories))
    )))
  }

  it("resolves endpoint URLs and the exact User-Agent policy matrix", () => {
    expect(endpointUrl(endpoint("example.com", 0, { port: 8443, path: "/emby" }), "/System/Info").href).toBe(
      "https://example.com:8443/emby/System/Info"
    )
    expect(effectiveUserAgent(server({ userAgentPolicy: "fixed", userAgent: "Configured/1" }), "Client/1")).toBe(
      "Configured/1"
    )
    expect(
      effectiveUserAgent(server({ userAgentPolicy: "client-preferred", userAgent: "Fallback/1" }), "Client/1")
    ).toBe("Client/1")
    expect(
      effectiveUserAgent(server({ userAgentPolicy: "client-preferred", userAgent: "Fallback/1" }), undefined)
    ).toBe("Fallback/1")
    expect(effectiveUserAgent(server({ userAgentPolicy: "passthrough", userAgent: null }), "Client/1")).toBe("Client/1")
    expect(effectiveUserAgent(server({ userAgentPolicy: "passthrough", userAgent: null }), undefined)).toBe(
      "oh-my-emby/0.0.0"
    )
  })

  it("drops credentials and identity headers on a cross-origin redirect", async () => {
    const calls: Array<Request> = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      calls.push(request)
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example.net/info" } })
        : Response.json({ ok: true })
    }
    await run(fetch, Effect.gen(function*() {
      const client = yield* UpstreamClient
      yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }))
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers.get("user-agent")).toBe("Configured-Agent/1")
    expect(calls[0]!.headers.has("x-emby-token")).toBe(true)
    for (const header of ["x-emby-token", "authorization", "x-emby-authorization"]) {
      expect(calls[1]!.headers.has(header)).toBe(false)
    }
  })

  it("keeps relative API paths under the configured base path and rejects absolute initial destinations", async () => {
    const urls: Array<string> = []
    await run(async (input, init) => {
      urls.push(new Request(input, init).url)
      return Response.json({ ok: true })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }), {
      server: server({
          endpoints: [endpoint("example.com", 0, { path: "/emby" })],
          baseUrl: "https://stale.example.com" as any,
        verifiedBaseUrl: "https://example.com/emby"
      })
    })
    expect(urls).toEqual(["https://example.com/emby/System/Info"])

    for (const path of ["https://evil.example.net/steal", "//evil.example.net/steal"]) {
      let called = false
      await expect(run(async () => {
        called = true
        return Response.json({ ok: true })
      }, Effect.gen(function*() {
        const client = yield* UpstreamClient
        return yield* client.request({
          serverId: "server-1",
          generation: 1,
          path,
          method: "GET"
        }, JsonOk)
      }))).rejects.toMatchObject({ _tag: "InvalidUpstreamUrl" })
      expect(called).toBe(false)
    }
  })

  it.each([
    ["Workers IPv4 literals", endpoint("127.0.0.1"), "DestinationRejected"],
    ["Workers IPv6 literals", endpoint("[::1]"), "DestinationRejected"],
    ["Workers private hostnames", endpoint("media.local", 0, { protocol: "http" }), "DestinationRejected"]
  ])("rejects %s", async (_name, configuredEndpoint, tag) => {
    let called = false
    await expect(run(async () => {
      called = true
      return Response.json({ ok: true })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }), { server: server({ endpoints: [configuredEndpoint] }) }
      )
    ).rejects.toMatchObject({ _tag: tag })
    expect(called).toBe(false)
  })

  it("never reads the legacy base_url for runtime selection", async () => {
    const urls: Array<string> = []
    await run(
      async (input, init) => {
        urls.push(new Request(input, init).url)
        return Response.json({ ok: true })
      },
      Effect.gen(function* () {
        const client = yield* UpstreamClient
        return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
      }),
      { rawBaseUrl: "ftp://user:pass@legacy.invalid" }
    )
    expect(urls).toEqual(["https://example.com/info"])
  })

  it("allows a public Docker IP upstream without a private-host allowlist", async () => {
    const urls: Array<string> = []
    await run(async (input, init) => {
      urls.push(new Request(input, init).url)
      return Response.json({ ok: true })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }), {
      server: server({
          endpoints: [endpoint("203.0.113.9", 0, { protocol: "http", port: 8096 })]
        }),
      policy: { platform: "docker" }
    })

    expect(urls).toEqual(["http://203.0.113.9:8096/System/Info"])
  })

  it("normalizes mixed-case hosts and allows an administrator-configured Docker LAN target", async () => {
    const urls: Array<string> = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(new Request(input, init).url)
      return Response.json({ ok: true })
    }
    await run(fetch, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }), {
      server: server({
          endpoints: [endpoint("192.168.1.20", 0, { protocol: "http", port: 8096 })],
          verifiedBaseUrl: "http://192.168.1.20:8096" }),
      policy: { platform: "docker", administratorPrivateHosts: ["192.168.1.20"] }
    })
    expect(urls).toEqual(["http://192.168.1.20:8096/System/Info"])

    await expect(run(async (input, init) => {
      const request = new Request(input, init)
      return request.url.includes(":8096/")
        ? new Response(null, { status: 302, headers: { location: "http://192.168.1.20:3000/admin" } })
        : Response.json({ ok: true })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }), {
      server: server({
            endpoints: [endpoint("192.168.1.20", 0, { protocol: "http", port: 8096 })]
          }),
      policy: { platform: "docker", administratorPrivateHosts: ["192.168.1.20"] }
    })).rejects.toMatchObject({ _tag: "DestinationRejected" })

    await expect(run(fetch, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }), {
      server: server({
            endpoints: [endpoint("192.168.1.20", 0, { protocol: "http", port: 8096 })]
          }),
      policy: { platform: "docker" }
    })).rejects.toMatchObject({ _tag: "DestinationRejected" })

    urls.length = 0
    await run(fetch, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }), { server: server({ endpoints: [endpoint("EXAMPLE.COM")] }) })
    expect(urls).toEqual(["https://example.com/System/Info"])
  })

  it("rejects a Docker control redirect from a private base to a public origin", async () => {
    const calls: Array<string> = []
    await expect(run(async (input, init) => {
      const request = new Request(input, init)
      calls.push(request.url)
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://public.example.com/info" } })
        : Response.json({ ok: true })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET"
      }, JsonOk)
    }), {
      server: server({
            endpoints: [endpoint("192.168.1.20", 0, { protocol: "http", port: 8096 })],
            verifiedBaseUrl: "http://192.168.1.20:8096"
      }),
      policy: { platform: "docker", administratorPrivateHosts: ["192.168.1.20"] }
    })).rejects.toMatchObject({ _tag: "DestinationRejected" })
    expect(calls).toEqual(["http://192.168.1.20:8096/System/Info"])
  })

  it("allows three redirects but rejects a fourth and redirect loops", async () => {
    const redirecting = (limit: number, loop = false): typeof globalThis.fetch => async (input, init) => {
      const request = new Request(input, init)
      const step = Number(new URL(request.url).searchParams.get("step") ?? "0")
      if (loop) return new Response(null, { status: 302, headers: { location: request.url } })
      return step < limit
        ? new Response(null, { status: 302, headers: { location: `https://example.com/info?step=${step + 1}` } })
        : Response.json({ ok: true })
    }
    await expect(run(redirecting(3), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }))).resolves.toEqual({ ok: true })
    await expect(run(redirecting(4), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }))).rejects.toMatchObject({ _tag: "RedirectLimitExceeded" })
    await expect(run(redirecting(1, true), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }))).rejects.toMatchObject({ _tag: "RedirectLoop" })
  })

  it("rejects HTTPS downgrade and oversized JSON before reading it", async () => {
    await expect(run(async () => new Response(null, {
      status: 302,
      headers: { location: "http://example.com/info" }
    }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }))).rejects.toMatchObject({ _tag: "HttpsDowngrade" })

    await expect(run(async () => new Response("{}", {
      headers: { "content-length": String(MAX_CONTROL_RESPONSE_BYTES + 1) }
    }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }))).rejects.toMatchObject({ _tag: "ResponseTooLarge" })
  })

  it("aborts timed-out fetches", async () => {
    let aborted = false
    const fetch: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true
        reject(new DOMException("aborted", "AbortError"))
      }, { once: true })
    })
    await expect(run(fetch, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }), { timeoutMs: 5 })).rejects.toMatchObject({ _tag: "UpstreamTimeout" })
    expect(aborted).toBe(true)
  })

  it("times out and cancels a stalled response body", async () => {
    let cancelled = false
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({
      pull: () => new Promise(() => undefined),
      cancel: () => {
        cancelled = true
      }
    }))
    const repositories = makeSqliteRepositoriesLayer({ filename })
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      yield* repo.saveServer(server())
    }).pipe(Effect.provide(repositories)))
    const result = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }).pipe(
      Effect.provide(makeUpstreamClientLayer({
        fetch,
        destinationPolicy: workers,
        timeoutMs: 5
      }).pipe(Layer.provide(repositories))),
      Effect.timeout(50),
      Effect.result
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("UpstreamTimeout")
    expect(cancelled).toBe(true)
  })

  it("refreshes an rejected token for only that server and applies the configured User-Agent", async () => {
    const repositories = makeSqliteRepositoriesLayer({ filename })
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      yield* repo.saveServer(server())
      yield* repo.saveServer(server({
        id: "server-2" as any,
        catalogNamespace: "catalog:server-2",
        verifiedCatalogId: "catalog-2",
        accessToken: "token-2",
            endpoints: [
              endpoint("server-2.example.com", 0, {
                id: "server-2-endpoint",
                verifiedCatalogId: "catalog-2"
              })
            ],
            baseUrl: "https://server-2.example.com" as any
          })
        )
      }).pipe(Effect.provide(repositories)))

    const calls: Array<Request> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (request.url.endsWith("/Users/AuthenticateByName")) {
        return Response.json({
          AccessToken: "token-1-new",
          ServerId: "catalog-id",
          User: { Id: "upstream-user-id" }
        })
      }
      return request.headers.get("x-emby-token") === "token-1-new"
        ? Response.json({ ok: true })
        : new Response(null, { status: 401 })
    }
    const clientLayer = makeUpstreamClientLayer({ fetch, destinationPolicy: workers }).pipe(Layer.provide(repositories))
    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* UpstreamClient
      yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/System/Info",
        method: "GET",
        inboundHeaders: { "x-evil": "must-not-forward" }
      } as any, JsonOk)
    }).pipe(Effect.provide(clientLayer)))

    expect(calls.every((request) => request.headers.get("user-agent") === "Configured-Agent/1")).toBe(true)
    expect(calls.every((request) => !request.headers.has("x-evil"))).toBe(true)
    const stored = await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      return yield* repo.listServers()
    }).pipe(Effect.provide(repositories)))
    expect(stored.find((item) => item.id === "server-1")?.accessToken).toBe("token-1-new")
    expect(stored.find((item) => item.id === "server-1")?.upstreamUserId).toBe("upstream-user-id")
    expect(stored.find((item) => item.id === "server-2")?.accessToken).toBe("token-2")
  })

  it("accepts an empty success response for a void upstream operation", async () => {
    await expect(run(async () => new Response(null, { status: 200 }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/state",
        method: "POST",
        body: new TextEncoder().encode("{}")
      }, Schema.Void)
    }))).resolves.toBeUndefined()
  })

  it("does not refresh or replay a POST rejected with 401", async () => {
    const calls: Array<Request> = []
    await expect(run(async (input, init) => {
      calls.push(new Request(input, init))
      return new Response(null, { status: 401 })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/state",
        method: "POST",
        body: new TextEncoder().encode("{}")
      }, JsonOk)
    }))).rejects.toMatchObject({ _tag: "UpstreamRejected", status: 401 })
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(["/state"])
  })

  it("does not attach a rejection body to regular requests", async () => {
    const failure = await run(async () => new Response("do not expose", { status: 401 }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* Effect.flip(client.request({
        serverId: "server-1",
        generation: 1,
        path: "/state",
        method: "POST",
        body: new TextEncoder().encode("{}")
      }, JsonOk))
    }))

    expect(failure).toMatchObject({ _tag: "UpstreamRejected", status: 401 })
    expect(failure).not.toHaveProperty("detail")
  })

  it("captures a bounded, redacted rejection body for connection diagnostics", async () => {
    const body = [
      'password="alpha beta gamma"',
      "Authorization: Bearer bearer-secret",
      "client_secret=client-secret",
      `message=${"x".repeat(MAX_CONNECTION_DIAGNOSTIC_BYTES)}`
    ].join("\n")
    const failure = await run(async () => new Response(body, { status: 401 }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* Effect.flip(client.getServerIdentity("server-1", true))
    }))

    expect(failure).toMatchObject({ _tag: "UpstreamRejected", status: 401 })
    if (failure._tag !== "UpstreamRejected") throw new Error("expected an upstream rejection")
    expect(failure.detail).toContain('password="[redacted]"')
    expect(failure.detail).toContain("Authorization: [redacted]")
    expect(failure.detail).toContain("client_secret=[redacted]")
    expect(failure.detail).not.toContain("alpha beta gamma")
    expect(failure.detail).not.toContain("bearer-secret")
    expect(failure.detail).not.toContain("client-secret")
    expect(new TextEncoder().encode(failure.detail).byteLength).toBeLessThanOrEqual(MAX_CONNECTION_DIAGNOSTIC_BYTES)
  })

  it("captures a redacted transport error only for connection diagnostics", async () => {
    const unavailable: typeof globalThis.fetch = async () => {
      throw new Error("connection refused: Authorization: Bearer bearer-secret")
    }
    const diagnostic = await run(unavailable, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* Effect.flip(client.getServerIdentity("server-1", true))
    }))
    const ordinary = await run(unavailable, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* Effect.flip(client.request({
        serverId: "server-1",
        generation: 1,
        path: "/state",
        method: "POST",
        body: new TextEncoder().encode("{}")
      }, JsonOk))
    }))

    expect(diagnostic).toMatchObject({
      _tag: "UpstreamUnavailable",
      detail: "connection refused: Authorization: [redacted]"
    })
    expect(ordinary).toMatchObject({ _tag: "UpstreamUnavailable" })
    expect(ordinary).not.toHaveProperty("detail")
  })

  it("refreshes and replays an explicitly replay-safe POST rejected with 401", async () => {
    const calls: Array<Request> = []
    await expect(run(async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (request.url.endsWith("/Users/AuthenticateByName")) {
        return Response.json({
          AccessToken: "token-1-new",
          User: { Id: "upstream-user-id" }
        })
      }
      return request.headers.get("x-emby-token") === "token-1-new"
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 401 })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/state",
        method: "POST",
        body: new TextEncoder().encode("{}"),
        replaySafe: true
      }, Schema.Void)
    }))).resolves.toBeUndefined()
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
      "/state",
      "/Users/AuthenticateByName",
      "/state"
    ])
  })

  it("rebuilds a replay-safe user path when authentication returns a different user id", async () => {
    const calls: Array<Request> = []
    await expect(run(async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (request.url.endsWith("/Users/AuthenticateByName")) {
        return Response.json({
          AccessToken: "token-1-new",
          User: { Id: "new-user-id" }
        })
      }
      return request.headers.get("x-emby-token") === "token-1-new"
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 401 })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/Users/upstream-user-id/Items/item-1/UserData",
        method: "POST",
        body: new TextEncoder().encode("{}"),
        replaySafe: true,
        replayPath: (upstreamUserId) => `/Users/${upstreamUserId}/Items/item-1/UserData`
      }, Schema.Void)
    }))).resolves.toBeUndefined()
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
      "/Users/upstream-user-id/Items/item-1/UserData",
      "/Users/AuthenticateByName",
      "/Users/new-user-id/Items/item-1/UserData"
    ])
  })

  it("fails GET over ordered eligible endpoints after transport failure and 503", async () => {
    const calls: Array<string> = []
    await expect(run(async (input, init) => {
          const url = new Request(input, init).url
          calls.push(url)
          if (url.startsWith("https://one.example.com/")) throw new TypeError("temporary network failure")
          if (url.startsWith("https://two.example.com/")) return new Response(null, { status: 503 })
          return Response.json({ ok: true })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }),
        {
          server: server({
            endpoints: [
              endpoint("one.example.com", 0),
              endpoint("two.example.com", 1),
              endpoint("three.example.com", 2)
            ]
          })
        }
      )
    ).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "https://one.example.com/info",
      "https://two.example.com/info",
      "https://three.example.com/info"
    ])
  })

  it.each(["transport", "timeout", "status"] as const)(
    "fails GET over when same-endpoint reauthentication fails by %s",
    async (failure) => {
      const calls: Array<string> = []
      await expect(run(async (input, init) => {
            const request = new Request(input, init)
            calls.push(request.url)
            const url = new URL(request.url)
            if (url.hostname === "two.example.com") return Response.json({ ok: true })
            if (url.pathname === "/info") return new Response(null, { status: 401 })
            if (failure === "transport") throw new TypeError("temporary network failure")
            if (failure === "timeout") return await new Promise<Response>(() => undefined)
            return new Response(null, { status: 503 })
          }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/info", method: "GET" }, JsonOk)
          }),
          {
            timeoutMs: 20,
            server: server({
              endpoints: [endpoint("one.example.com", 0), endpoint("two.example.com", 1)]
            })
          }
        )
      ).resolves.toEqual({ ok: true })
      expect(calls).toEqual([
        "https://one.example.com/info",
        "https://one.example.com/Users/AuthenticateByName",
        "https://two.example.com/info"
      ])
    }
  )

  it("uses a refreshed shared token when a replay fails over to the next endpoint", async () => {
    const calls: Array<string> = []
    await expect(
      run(
        async (input, init) => {
          const request = new Request(input, init)
          const url = new URL(request.url)
          calls.push(`${url.hostname}${url.pathname}:${request.headers.get("x-emby-token") ?? "none"}`)
          if (url.pathname === "/Users/AuthenticateByName") {
            return url.hostname === "one.example.com"
              ? Response.json({ AccessToken: "token-new", User: { Id: "upstream-user-id" } })
              : new Response(null, { status: 401 })
          }
          if (url.hostname === "one.example.com") {
            return request.headers.get("x-emby-token") === "token-new"
              ? new Response(null, { status: 503 })
              : new Response(null, { status: 401 })
          }
          return request.headers.get("x-emby-token") === "token-new"
            ? Response.json({ ok: true })
            : new Response(null, { status: 401 })
        },
        Effect.gen(function* () {
          const client = yield* UpstreamClient
          return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
        }),
        {
          server: server({
            endpoints: [endpoint("one.example.com", 0), endpoint("two.example.com", 1)]
          })
        }
      )
    ).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "one.example.com/info:token-1",
      "one.example.com/Users/AuthenticateByName:none",
      "one.example.com/info:token-new",
      "two.example.com/info:token-new"
    ])
  })

  it("never advances POST after timeout, including replay-safe writes", async () => {
    const calls: Array<string> = []
    await expect(
      run(
        async (input, init) => {
          calls.push(new Request(input, init).url)
          return await new Promise<Response>(() => undefined)
        },
        Effect.gen(function* () {
          const client = yield* UpstreamClient
          return yield* client.request(
            {
              serverId: "server-1",
              generation: 1,
              path: "/state",
        method: "POST",
        body: new TextEncoder().encode("{}"),
              replaySafe: true
            }, JsonOk)
    }),
        {
          timeoutMs: 5,
          server: server({
            endpoints: [endpoint("one.example.com", 0), endpoint("two.example.com", 1)]
          })
        }
      )
    ).rejects.toMatchObject({ _tag: "UpstreamTimeout" })
    expect(calls).toEqual(["https://one.example.com/state"])
  })

  it.each([
    [401, "UpstreamRejected"],
    [404, "UpstreamNotFound"]
  ] as const)("does not fail GET over on HTTP %i", async (status, tag) => {
    const calls: Array<string> = []
    await expect(run(async (input, init) => {
          calls.push(new Request(input, init).url)
          return new Response(null, { status })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/missing", method: "GET" }, JsonOk)
    }),
        {
          server: server({
            password: null,
            endpoints: [endpoint("one.example.com", 0), endpoint("two.example.com", 1)]
          })
        }
      )
    ).rejects.toMatchObject({ _tag: tag })
    expect(calls).toEqual(["https://one.example.com/missing"])
  })

  it("skips a mismatched endpoint instead of sending traffic to it", async () => {
    const calls: Array<string> = []
    await expect(
      run(
        async (input, init) => {
          calls.push(new Request(input, init).url)
          return Response.json({ ok: true })
        },
        Effect.gen(function* () {
          const client = yield* UpstreamClient
          return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
  }),
        {
          server: server({
            endpoints: [
              endpoint("mismatch.example.com", 0, { verifiedCatalogId: "other-catalog" }),
              endpoint("same.example.com", 1)
            ]
          })
        }
      )
    ).resolves.toEqual({ ok: true })
    expect(calls).toEqual(["https://same.example.com/info"])
  })

  it("resolves only a registered media version from the current server generation", async () => {
    const version = {
      id: "version-1",
      sourceItemId: "source-1",
      serverGeneration: 1,
      upstreamMediaSourceId: "media-1",
      label: "Home",
      capabilities: {
        serverId: "server-1",
        url: "https://example.com/Videos/item/stream?api_key=signed"
      },
      streams: [],
      updatedAtMs: 1_000
    }
    await expect(run(async () => Response.json({ ok: true }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.resolvePlayback(version)
    }))).resolves.toEqual({
      serverId: "server-1",
      generation: 1,
      url: "https://example.com/Videos/item/stream?api_key=signed"
    })
    await expect(run(async () => Response.json({ ok: true }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.resolvePlayback({ ...version, serverGeneration: 0 })
    }))).rejects.toMatchObject({ _tag: "ObsoleteGeneration" })
  })

  it("brokers a media redirect with the configured Emby authorization headers", async () => {
    let observed: Request | undefined
    const result = await run(async (input, init) => {
      observed = new Request(input, init)
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example.net/video.mp4?auth_key=signed" }
      })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.resolvePlaybackRedirect({
        serverId: "server-1",
        generation: 1,
        url: "https://example.com/Videos/item/stream?api_key=signed"
      })
    }))

    expect(result.href).toBe("https://cdn.example.net/video.mp4?auth_key=signed")
    expect(observed?.method).toBe("GET")
    expect(observed?.headers.get("accept")).toBe("*/*")
    expect(observed?.headers.get("range")).toBe("bytes=0-")
    expect(observed?.headers.get("user-agent")).toBe("Configured-Agent/1")
    expect(observed?.headers.get("x-emby-token")).toBe("token-1")
    expect(observed?.headers.get("x-emby-authorization")).toBe(
      'MediaBrowser Client="oh-my-emby", Device="oh-my-emby", DeviceId="server-1", Version="0.0.0"'
    )
  })

  it("enforces registered resource origins on Workers", async () => {
    const version = {
      id: "version-1",
      sourceItemId: "source-1",
      serverGeneration: 1,
      upstreamMediaSourceId: "media-1",
      label: "CDN",
      capabilities: {
        serverId: "server-1",
        url: "https://cdn.example.net/Videos/item/stream"
      },
      streams: [],
      updatedAtMs: 1_000
    }
    await expect(run(async () => Response.json({ ok: true }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.resolvePlayback(version)
    }))).rejects.toMatchObject({ _tag: "DestinationRejected" })
    await expect(run(async () => Response.json({ ok: true }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.resolvePlayback(version)
    }), {
      policy: { platform: "workers", registeredResourceOrigins: ["https://cdn.example.net"] }
    })).resolves.toMatchObject({ url: "https://cdn.example.net/Videos/item/stream" })
  })

  it.each([
    ["disabled", { enabled: false }],
    ["unhealthy", { health: "degraded" as const }],
    ["unverified", { verifiedCatalogId: null, verifiedBaseUrl: null }]
  ])("rejects playback from a %s server", async (_name, overrides) => {
    const version = {
      id: "version-1",
      sourceItemId: "source-1",
      serverGeneration: 1,
      upstreamMediaSourceId: "media-1",
      label: "Home",
      capabilities: { serverId: "server-1", url: "https://example.com/Videos/item/stream" },
      streams: [],
      updatedAtMs: 1_000
    }
    await expect(run(async () => Response.json({ ok: true }), Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.resolvePlayback(version)
    }), { server: server(overrides) })).rejects.toMatchObject({ _tag: "UpstreamUnavailable" })
  })

  it.each([
    ["disabled", { enabled: false }],
    ["unhealthy", { health: "degraded" as const }],
    ["unverified", { verifiedCatalogId: null, verifiedBaseUrl: null }]
  ])("does not discover libraries from a %s server", async (_name, overrides) => {
    let called = false
    await expect(run(async () => {
      called = true
      return Response.json([])
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.listSourceLibraries("server-1")
    }), { server: server(overrides) })).rejects.toMatchObject({ _tag: "UpstreamUnavailable" })
    expect(called).toBe(false)
  })
})
