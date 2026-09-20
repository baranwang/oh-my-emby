import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { makeEmbyHandler, type EmbyServices } from "../src/api/emby.js"
import {
  serveRegisteredResource,
  type RegisteredResourceRequest
} from "../src/core/playback.js"
import { ResourceCache, type CachedResource, type CountedResource } from "../src/core/resource-cache.js"

const request = (
  kind: "image" | "subtitle",
  overrides: Partial<RegisteredResourceRequest> = {}
): RegisteredResourceRequest => ({
  key: `${kind}:registered`,
  kind,
  serverId: "server-1",
  generation: 1,
  url: new URL(`https://cdn.example.com/${kind}`),
  maxBytes: kind === "image" ? 20 * 1024 * 1024 : 5 * 1024 * 1024,
  acceptedMimeTypes: kind === "image" ? ["image/png"] : ["text/vtt"],
  ...overrides
})

const cache = () => {
  const values = new Map<string, CachedResource>()
  let gets = 0
  let puts = 0
  const service = ResourceCache.of({
    get: (key) => Effect.sync(() => {
      gets++
      return values.get(key) ?? null
    }),
    put: (key, value: CountedResource, expiresAtMs) => Effect.sync(() => {
      puts++
      values.set(key, { ...value, expiresAtMs })
    }),
    prune: () => Effect.succeed(undefined)
  })
  return { service, values, get gets() { return gets }, get puts() { return puts } }
}

const principal = {
  id: "token-id",
  username: "owner",
  authGeneration: 1,
  deviceId: "device",
  deviceName: "client"
}

const baseServices = (overrides: Partial<EmbyServices> = {}): EmbyServices => ({
  config: { serverId: "virtual", serverName: "Virtual", version: "0" },
  now: () => 1,
  auth: {
    loginEmby: () => Effect.die("unused"),
    authenticateEmby: () => Effect.succeed(principal)
  },
  federation: {
    list: () => Effect.die("unused"),
    search: () => Effect.die("unused"),
    detail: () => Effect.die("unused"),
    lookupMembership: () => Effect.succeed(null)
  },
  userState: { write: () => Effect.die("unused"), recordPlaybackEvent: () => Effect.die("unused") },
  libraries: { list: () => Effect.succeed([]) },
  playback: { getInfo: () => Effect.die("unused") },
  ...overrides
})

describe("bounded auxiliary resources", () => {
  it("authenticates image requests before cache lookup", async () => {
    const responseCache = cache()
    const services = baseServices({
      auth: {
        loginEmby: () => Effect.die("unused"),
        authenticateEmby: () => Effect.fail({ _tag: "InvalidCredentials" } as any)
      },
      resourceCache: responseCache.service,
      playback: {
        getInfo: () => Effect.die("unused"),
        resolveImage: () => Effect.die("must authenticate first")
      }
    })
    const response = await Effect.runPromise(makeEmbyHandler(services)(new Request(
      "https://local/Items/movie-1/Images/Primary?api_key=invalid"
    )))

    expect(response.status).toBe(401)
    expect(responseCache.gets).toBe(0)
  })

  it("streams allowlisted images, strips unsafe headers, and caches only the complete body", async () => {
    const responseCache = cache()
    const body = new TextEncoder().encode("png-body")
    const response = await Effect.runPromise(serveRegisteredResource(request("image"), {
      cache: responseCache.service,
      now: () => 1_000,
      fetch: async () => new Response(body, { headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=60",
        "set-cookie": "upstream=secret",
        "www-authenticate": "Bearer secret",
        connection: "keep-alive",
        "x-upstream-token": "secret"
      } })
    }))

    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("www-authenticate")).toBeNull()
    expect(response.headers.get("connection")).toBeNull()
    expect(response.headers.get("x-upstream-token")).toBeNull()
    await expect(response.text()).resolves.toBe("png-body")
    expect(responseCache.puts).toBe(1)
    expect(responseCache.values.get("image:registered")?.expiresAtMs).toBe(21_601_000)

    const cached = await Effect.runPromise(serveRegisteredResource(request("image"), {
      cache: responseCache.service,
      now: () => 2_000,
      fetch: async () => { throw new Error("cache miss") }
    }))
    await expect(cached.text()).resolves.toBe("png-body")
  })

  it("rejects disallowed MIME and advertised or streamed oversize images without cache entries", async () => {
    const wrongMimeCache = cache()
    await expect(Effect.runPromise(serveRegisteredResource(request("image"), {
      cache: wrongMimeCache.service,
      fetch: async () => new Response("html", { headers: { "content-type": "text/html" } })
    }))).rejects.toMatchObject({ _tag: "ResourceInvalidResponse" })

    const advertisedCache = cache()
    await expect(Effect.runPromise(serveRegisteredResource(request("image", { maxBytes: 2 }), {
      cache: advertisedCache.service,
      fetch: async () => new Response("abc", { headers: {
        "content-type": "image/png",
        "content-length": "3"
      } })
    }))).rejects.toMatchObject({ _tag: "ResourceTooLarge" })

    const streamedCache = cache()
    const response = await Effect.runPromise(serveRegisteredResource(request("image", { maxBytes: 2 }), {
      cache: streamedCache.service,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3]))
          controller.close()
        }
      }), { headers: { "content-type": "image/png" } })
    }))
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: "ResourceTooLarge" })
    expect(streamedCache.puts).toBe(0)
  })

  it("cancels a registered resource at the auxiliary deadline", async () => {
    let aborted = false
    await expect(Effect.runPromise(serveRegisteredResource(request("subtitle"), {
      deadlineMs: 5,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("aborted", "AbortError"))
        })
      })
    }))).rejects.toMatchObject({ _tag: "ResourceTimeout" })
    expect(aborted).toBe(true)
  })

  it("accepts registered external text subtitles by version and stream index", async () => {
    let selection: unknown
    const response = await Effect.runPromise(makeEmbyHandler(baseServices({
      playback: {
        getInfo: () => Effect.die("unused"),
        resolveSubtitle: (input) => {
          selection = input
          return Effect.succeed({ _tag: "Redirect", location: new URL("https://cdn.example/sub.srt?sig=secret") })
        }
      }
    }))(new Request(
      "https://local/Videos/movie-1/version-a/Subtitles/11/Stream.srt",
      { headers: { authorization: "Bearer local-token" } }
    )))

    expect(response.status).toBe(302)
    expect(selection).toEqual({
      canonicalId: "movie-1",
      mediaSourceId: "version-a",
      streamIndex: 11,
      format: "srt"
    })
    expect(response.headers.get("location")).toContain("sig=secret")
  })

  it("rejects embedded or bitmap subtitles and caller-provided resource URLs", async () => {
    const seen: Array<unknown> = []
    const response = await Effect.runPromise(makeEmbyHandler(baseServices({
      playback: {
        getInfo: () => Effect.die("unused"),
        resolveSubtitle: (input) => {
          seen.push(input)
          return Effect.fail({ _tag: "ResourceRejected" } as any)
        }
      }
    }))(new Request(
      "https://local/Videos/movie-1/version-a/Subtitles/9/Stream.pgs?url=https://evil.invalid/private",
      { headers: { authorization: "Bearer local-token" } }
    )))

    expect(response.status).toBe(404)
    expect(seen).toEqual([{
      canonicalId: "movie-1",
      mediaSourceId: "version-a",
      streamIndex: 9,
      format: "pgs"
    }])
    expect(JSON.stringify(seen)).not.toContain("evil.invalid")
  })
})
