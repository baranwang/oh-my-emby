import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { MAX_CONTROL_RESPONSE_BYTES } from "../src/core/limits.js"
import type { UpstreamServer } from "../src/core/model.js"
import { Repositories } from "../src/core/repositories.js"
import {
  UpstreamClient,
  makeUpstreamClientLayer,
  type DestinationPolicy
} from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()
const JsonOk = Schema.Struct({ ok: Schema.Boolean })

const server = (overrides: Partial<UpstreamServer> = {}): UpstreamServer => ({
  id: "server-1" as any,
  catalogNamespace: "catalog:server-1",
  verifiedCatalogId: "catalog-id",
  verifiedBaseUrl: "https://example.com",
  generation: 1,
  name: "Home",
  baseUrl: "https://example.com" as any,
  username: "alice",
  password: "password",
  accessToken: "token-1",
  accessTokenExpiresAtMs: null,
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
        baseUrl: "https://example.com/emby" as any,
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
    ["URL credentials", "https://user:pass@example.com", "InvalidUpstreamUrl"],
    ["unsupported schemes", "ftp://example.com", "InvalidUpstreamUrl"],
    ["Workers IPv4 literals", "https://127.0.0.1", "DestinationRejected"],
    ["Workers IPv6 literals", "https://[::1]", "DestinationRejected"],
    ["Workers private hostnames", "http://media.local", "DestinationRejected"]
  ])("rejects %s", async (_name, baseUrl, tag) => {
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
    }), { rawBaseUrl: baseUrl })).rejects.toMatchObject({ _tag: tag })
    expect(called).toBe(false)
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
      server: server({ baseUrl: "http://192.168.1.20:8096" as any, verifiedBaseUrl: "http://192.168.1.20:8096" }),
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
      server: server({ baseUrl: "http://192.168.1.20:8096" as any }),
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
      server: server({ baseUrl: "http://192.168.1.20:8096" as any }),
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
    }), { server: server({ baseUrl: "https://EXAMPLE.COM" as any }) })
    expect(urls).toEqual(["https://example.com/System/Info"])
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
        accessToken: "token-2"
      }))
    }).pipe(Effect.provide(repositories)))

    const calls: Array<Request> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (request.url.endsWith("/Users/AuthenticateByName")) {
        return Response.json({ AccessToken: "token-1-new", ServerId: "catalog-id" })
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
    expect(stored.find((item) => item.id === "server-2")?.accessToken).toBe("token-2")
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

  it("retries one transient GET but never retries POST or explicit not-found", async () => {
    let attempts = 0
    await expect(run(async () => {
      attempts++
      if (attempts === 1) throw new TypeError("temporary network failure")
      return Response.json({ ok: true })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/info", method: "GET" }, JsonOk)
    }))).resolves.toEqual({ ok: true })
    expect(attempts).toBe(2)

    attempts = 0
    await expect(run(async () => {
      attempts++
      throw new TypeError("write outcome unknown")
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({
        serverId: "server-1",
        generation: 1,
        path: "/state",
        method: "POST",
        body: new TextEncoder().encode("{}")
      }, JsonOk)
    }))).rejects.toMatchObject({ _tag: "UpstreamUnavailable" })
    expect(attempts).toBe(1)

    attempts = 0
    await expect(run(async () => {
      attempts++
      return new Response(null, { status: 404 })
    }, Effect.gen(function*() {
      const client = yield* UpstreamClient
      return yield* client.request({ serverId: "server-1", generation: 1, path: "/missing", method: "GET" }, JsonOk)
    }))).rejects.toMatchObject({ _tag: "UpstreamNotFound" })
    expect(attempts).toBe(1)
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
