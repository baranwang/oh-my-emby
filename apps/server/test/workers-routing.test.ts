import { env } from "cloudflare:workers"
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext
} from "cloudflare:test"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { MAX_IMAGE_BYTES } from "../src/core/limits.js"
import { Repositories } from "../src/core/repositories.js"
import { UpstreamClient } from "../src/core/upstream-client.js"
import { serveDashboardAsset, type AssetsBinding } from "../src/platform/workers/assets.js"
import {
  makeWorkersResourceCache,
  type WorkersCacheBinding
} from "../src/platform/workers/cache.js"
import worker, {
  makeWorkersCoreLayer,
  parseTrustedProxyAddresses
} from "../src/platform/workers/index.js"

const request = (path: string, init?: RequestInit) => new Request(`https://app.example.com${path}`, init)

describe("Workers Dashboard assets", () => {
  const assets = (files: Readonly<Record<string, string>>) => {
    const paths: Array<string> = []
    const binding: AssetsBinding = {
      fetch: async (input) => {
        const path = new URL(input.url).pathname
        paths.push(path)
        const body = files[path]
        return body === undefined
          ? new Response("<h1>asset missing</h1>", { status: 404, headers: { "content-type": "text/html" } })
          : new Response(input.method === "HEAD" ? null : body, {
            headers: { "content-type": path === "/index.html" ? "text/html" : "application/javascript" }
          })
      }
    }
    return { binding, paths }
  }

  it("serves the exact prefix-stripped asset before considering SPA fallback", async () => {
    const fixture = assets({ "/assets/app.js": "console.log('ok')", "/index.html": "<main>app</main>" })
    const response = await Effect.runPromise(serveDashboardAsset(
      request("/dashboard/assets/app.js", { headers: { accept: "text/html" } }),
      fixture.binding
    ))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("console.log('ok')")
    expect(fixture.paths).toEqual(["/assets/app.js"])
  })

  it("falls back to index only for safe HTML GET and HEAD navigations", async () => {
    const fixture = assets({ "/index.html": "<main>app</main>" })
    const get = await Effect.runPromise(serveDashboardAsset(
      request("/dashboard/servers", { headers: { accept: "text/html,application/xhtml+xml" } }),
      fixture.binding
    ))
    const head = await Effect.runPromise(serveDashboardAsset(
      request("/dashboard/libraries", { method: "HEAD", headers: { accept: "text/html" } }),
      fixture.binding
    ))

    expect(get.status).toBe(200)
    expect(await get.text()).toBe("<main>app</main>")
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(fixture.paths).toEqual(["/servers", "/index.html", "/libraries", "/index.html"])
  })

  it.each([
    ["missing JavaScript", "/dashboard/assets/missing.js", { headers: { accept: "text/html" } }],
    ["missing source map", "/dashboard/assets/app.js.map", { headers: { accept: "text/html" } }],
    ["JSON navigation", "/dashboard/servers", { headers: { accept: "application/json" } }],
    ["unsupported method", "/dashboard/servers", { method: "POST", headers: { accept: "text/html" } }],
    ["encoded traversal", "/dashboard/%2e%2e%2fsecret", { headers: { accept: "text/html" } }],
    ["double-encoded traversal", "/dashboard/%252e%252e%252fsecret", { headers: { accept: "text/html" } }]
  ] as const)("keeps %s responses non-HTML", async (_name, path, init) => {
    const fixture = assets({ "/index.html": "<main>app</main>" })
    const response = await Effect.runPromise(serveDashboardAsset(request(path, init), fixture.binding))

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get("content-type")).not.toContain("text/html")
    expect(fixture.paths).not.toContain("/index.html")
  })
})

class MemoryCache implements WorkersCacheBinding {
  readonly entries = new Map<string, Response>()
  readonly urls: Array<string> = []

  async match(request: Request): Promise<Response | undefined> {
    this.urls.push(request.url)
    return this.entries.get(request.url)?.clone()
  }

  async put(request: Request, response: Response): Promise<void> {
    this.urls.push(request.url)
    this.entries.set(request.url, response.clone())
  }

  async delete(request: Request): Promise<boolean> {
    this.urls.push(request.url)
    return this.entries.delete(request.url)
  }
}

describe("Workers resource cache", () => {
  it("round-trips bounded bodies without persisting the logical key in cache metadata", async () => {
    const cache = new MemoryCache()
    const service = makeWorkersResourceCache(cache)
    const key = "image:https://upstream.example/image?api_key=secret"
    const body = new Uint8Array([1, 2, 3])
    const expiresAtMs = 2_000_000_000_000

    await Effect.runPromise(service.put(key, {
      status: 200,
      headers: [["content-type", "image/png"], ["cache-control", "private, no-store"]],
      body
    }, expiresAtMs))
    const cached = await Effect.runPromise(service.get(key))

    expect(cached).toEqual({
      status: 200,
      headers: [["content-type", "image/png"]],
      body,
      expiresAtMs
    })
    expect(cache.urls.every((url) => !url.includes("upstream") && !url.includes("secret"))).toBe(true)
  })

  it("rejects oversized cache writes and evicts expired entries", async () => {
    const cache = new MemoryCache()
    const service = makeWorkersResourceCache(cache)

    await expect(Effect.runPromise(service.put("oversized", {
      status: 200,
      headers: [["content-type", "image/png"]],
      body: new Uint8Array(MAX_IMAGE_BYTES + 1)
    }, Date.now() + 10_000))).rejects.toMatchObject({ _tag: "ResourceCacheError" })

    await Effect.runPromise(service.put("expired", {
      status: 200,
      headers: [["content-type", "image/png"]],
      body: new Uint8Array([1])
    }, 1))
    expect(await Effect.runPromise(service.get("expired"))).toBeNull()
    expect(cache.entries.size).toBe(0)
  })
})

const runWorkerFetch = async (path: string, init?: RequestInit) => {
  const context = createExecutionContext()
  const response = await worker.fetch(new Request(`http://localhost:8787${path}`, init), env, context)
  await waitOnExecutionContext(context)
  return response
}

describe("Workers production runtime", () => {
  it("normalizes the trusted-proxy CSV without retaining empty entries", () => {
    expect(parseTrustedProxyAddresses(" 10.0.0.1, ,2001:db8::1 ,")).toEqual([
      "10.0.0.1",
      "2001:db8::1"
    ])
  })

  it("routes the real Dashboard API and only falls back to HTML for Dashboard navigations", async () => {
    const bootstrap = await runWorkerFetch("/api/dashboard/bootstrap")
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.headers.get("content-type")).toContain("application/json")

    const navigation = await runWorkerFetch("/dashboard/servers", {
      headers: { accept: "text/html,application/xhtml+xml" }
    })
    expect(navigation.status).toBe(200)
    expect(navigation.headers.get("content-type")).toContain("text/html")
    expect(await navigation.text()).toBe("<main>dashboard</main>")

    const exactAsset = await runWorkerFetch("/dashboard/assets/app.js", {
      headers: { accept: "text/html" }
    })
    expect(exactAsset.status).toBe(200)
    expect(exactAsset.headers.get("content-type")).toContain("application/javascript")

    for (const path of [
      "/api/dashboard/not-a-route",
      "/emby/not-a-route",
      "/dashboard/assets/missing.js",
      "/not-a-route"
    ]) {
      const response = await runWorkerFetch(path, { headers: { accept: "text/html" } })
      expect(response.status, path).toBeGreaterThanOrEqual(400)
      expect(response.headers.get("content-type"), path).not.toContain("text/html")
    }
  })

  it("accepts the configured localhost custom port for Dashboard mutations", async () => {
    const response = await runWorkerFetch("/api/dashboard/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:8787"
      },
      body: JSON.stringify({ username: "owner", password: "valid password" })
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain("oh_my_emby_session=")
  })

  it("runs scheduled maintenance through waitUntil", async () => {
    const scheduledTime = 2_000_000_000_000
    const context = createExecutionContext()
    worker.scheduled(createScheduledController({ scheduledTime, cron: "*/5 * * * *" }), env, context)
    await waitOnExecutionContext(context)

    expect(await env.DB.prepare(
      "SELECT last_run_at_ms FROM maintenance_status WHERE singleton = 1"
    ).first()).toEqual({ last_run_at_ms: scheduledTime })
  })

  it("accepts a registered custom-port URL but keeps delivery fail-closed without a peer-validating transport", async () => {
    const { registered, delivery } = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const repositories = yield* Repositories
      const upstream = yield* UpstreamClient
      yield* repositories.saveServer({
        id: "workers-resource-server",
        catalogNamespace: "catalog:workers-resource-server",
        verifiedCatalogId: "verified:workers-resource-server",
        verifiedBaseUrl: "https://media.example.com:8443",
        generation: 1,
        name: "Workers resource server",
        baseUrl: "https://media.example.com:8443",
        username: "owner",
        password: "password",
        accessToken: "token",
        accessTokenExpiresAtMs: null,
        upstreamUserId: "upstream-owner",
        userAgent: "oh-my-emby-test",
        enabled: true,
        health: "healthy",
        lastSuccessAtMs: 1,
        deletedAtMs: null,
        createdAtMs: 1,
        updatedAtMs: 1
      })
      const registered = yield* upstream.resolvePlayback({
        id: "workers-resource-version",
        sourceItemId: "workers-resource-item",
        serverGeneration: 1,
        upstreamMediaSourceId: "upstream-version",
        label: "Custom port",
        capabilities: {
          serverId: "workers-resource-server",
          url: "https://media.example.com:8443/video"
        },
        streams: [],
        updatedAtMs: 1
      })
      const delivery = yield* upstream.requestResource({
        serverId: "workers-resource-server",
        generation: 1,
        url: new URL("https://media.example.com:8443/image.jpg"),
        accept: ["image/jpeg"]
      }).pipe(Effect.result)
      return { registered, delivery }
    })).pipe(Effect.provide(makeWorkersCoreLayer(env))))

    expect(registered.url).toBe("https://media.example.com:8443/video")
    expect(Result.isFailure(delivery)).toBe(true)
    if (Result.isFailure(delivery)) expect(delivery.failure).toMatchObject({ _tag: "UpstreamUnavailable" })
  })
})
