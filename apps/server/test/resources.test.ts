import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { makeEmbyHandler, type EmbyServices } from "../src/api/emby.js"
import {
  serveRegisteredResource,
  type RegisteredResourceRequest
} from "../src/core/playback.js"
import { ResourceCache, type CachedResource, type CountedResource } from "../src/core/resource-cache.js"
import { ResourceCacheError } from "../src/core/resource-cache.js"

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
  open: () => Effect.succeed(new Response(kind, {
    headers: { "content-type": kind === "image" ? "image/png" : "text/vtt" }
  })),
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

  it("delivers validated external artwork through the existing Emby image route", async () => {
    const response = await Effect.runPromise(makeEmbyHandler(baseServices({
      playback: {
        getInfo: () => Effect.die("unused"),
        resolveImage: () => Effect.succeed({
          _tag: "Redirect",
          location: new URL("https://image.tmdb.org/t/p/w780/poster.jpg")
        })
      }
    }))(new Request(
      "https://local/Items/movie-1/Images/Primary",
      { headers: { authorization: "Bearer local-token" } }
    )))

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://image.tmdb.org/t/p/w780/poster.jpg")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  it("advertises cached provider artwork with opaque tags and serves the advertised routes", async () => {
    const selections: Array<unknown> = []
    const item = {
      id: "movie-1",
      itemType: "Movie",
      displayMetadata: {
        Name: "Movie",
        ExternalImages: {
          Primary: "https://image.tmdb.org/t/p/w780/poster.jpg",
          Backdrop: [
            "https://image.tmdb.org/t/p/w1280/backdrop-0.jpg",
            "https://image.tmdb.org/t/p/w1280/backdrop-1.jpg"
          ]
        }
      },
      mediaVersions: [],
      userState: null,
      incompleteSourceIds: []
    } as const
    const app = makeEmbyHandler(baseServices({
      federation: {
        list: () => Effect.succeed({
          items: [item],
          totalRecordCount: 1,
          exhausted: true,
          incompleteSourceIds: []
        }),
        search: () => Effect.die("unused"),
        detail: () => Effect.succeed(item),
        lookupMembership: () => Effect.succeed(null)
      },
      playback: {
        getInfo: () => Effect.die("unused"),
        resolveImage: (input) => {
          selections.push(input)
          const suffix = input.imageType === "Primary"
            ? "w780/poster.jpg"
            : `w1280/backdrop-${input.imageIndex ?? 0}.jpg`
          return Effect.succeed({
            _tag: "Redirect",
            location: new URL(`https://image.tmdb.org/t/p/${suffix}`)
          })
        }
      }
    }))
    const authorization = { authorization: "Bearer local-token" }

    const list = await Effect.runPromise(app(new Request(
      "https://local/Users/owner/Items?ParentId=library-1",
      { headers: authorization }
    )))
    const body = await list.json() as any
    expect(body.Items[0]).toMatchObject({
      ImageTags: { Primary: "external" },
      BackdropImageTags: ["external-0", "external-1"]
    })
    expect(JSON.stringify(body)).not.toContain("image.tmdb.org")

    const primary = await Effect.runPromise(app(new Request(
      "https://local/Items/movie-1/Images/Primary",
      { headers: authorization }
    )))
    const backdrop = await Effect.runPromise(app(new Request(
      "https://local/Items/movie-1/Images/Backdrop/1",
      { headers: authorization }
    )))
    expect(primary.status).toBe(302)
    expect(primary.headers.get("location")).toBe("https://image.tmdb.org/t/p/w780/poster.jpg")
    expect(backdrop.status).toBe(302)
    expect(backdrop.headers.get("location")).toBe("https://image.tmdb.org/t/p/w1280/backdrop-1.jpg")
    expect(selections).toEqual([
      { canonicalId: "movie-1", imageType: "Primary" },
      { canonicalId: "movie-1", imageType: "Backdrop", imageIndex: 1 }
    ])
  })

  it("streams allowlisted images, strips unsafe headers, and caches only the complete body", async () => {
    const responseCache = cache()
    const body = new TextEncoder().encode("png-body")
    const response = await Effect.runPromise(serveRegisteredResource(request("image", {
      open: () => Effect.succeed(new Response(body, { headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=60",
        "set-cookie": "upstream=secret",
        "www-authenticate": "Bearer secret",
        connection: "keep-alive",
        "x-upstream-token": "secret"
      } }))
    }), {
      cache: responseCache.service,
      now: () => 1_000
    }))

    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("www-authenticate")).toBeNull()
    expect(response.headers.get("connection")).toBeNull()
    expect(response.headers.get("x-upstream-token")).toBeNull()
    await expect(response.text()).resolves.toBe("png-body")
    expect(responseCache.puts).toBe(1)
    expect(responseCache.values.get("image:registered")?.expiresAtMs).toBe(21_601_000)
    responseCache.values.set("image:registered", {
      ...responseCache.values.get("image:registered")!,
      headers: [["cache-control", "public, max-age=86400"], ["content-type", "image/png"]]
    })

    const cached = await Effect.runPromise(serveRegisteredResource(request("image", {
      open: () => Effect.die("cache miss")
    }), {
      cache: responseCache.service,
      now: () => 2_000
    }))
    expect(cached.headers.get("cache-control")).toBe("private, no-store")
    await expect(cached.text()).resolves.toBe("png-body")
  })

  it("rejects disallowed MIME and advertised or streamed oversize images without cache entries", async () => {
    const wrongMimeCache = cache()
    await expect(Effect.runPromise(serveRegisteredResource(request("image", {
      open: () => Effect.succeed(new Response("html", { headers: { "content-type": "text/html" } }))
    }), {
      cache: wrongMimeCache.service
    }))).rejects.toMatchObject({ _tag: "ResourceInvalidResponse" })

    const advertisedCache = cache()
    await expect(Effect.runPromise(serveRegisteredResource(request("image", {
      maxBytes: 2,
      open: () => Effect.succeed(new Response("abc", { headers: {
        "content-type": "image/png",
        "content-length": "3"
      } }))
    }), {
      cache: advertisedCache.service
    }))).rejects.toMatchObject({ _tag: "ResourceTooLarge" })

    const streamedCache = cache()
    const response = await Effect.runPromise(serveRegisteredResource(request("image", {
      maxBytes: 2,
      open: () => Effect.succeed(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3]))
          controller.close()
        }
      }), { headers: { "content-type": "image/png" } }))
    }), {
      cache: streamedCache.service
    }))
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: "ResourceTooLarge" })
    expect(streamedCache.puts).toBe(0)
  })

  it("cancels a registered resource at the auxiliary deadline", async () => {
    let aborted = false
    await expect(Effect.runPromise(serveRegisteredResource(request("subtitle", {
      open: () => Effect.tryPromise({
        try: (signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true
            reject(new DOMException("aborted", "AbortError"))
          })
        }),
        catch: () => ({ _tag: "ResourceUnavailable" } as any)
      })
    }), {
      deadlineMs: 5,
    }))).rejects.toMatchObject({ _tag: "ResourceTimeout" })
    expect(aborted).toBe(true)
  })

  it("keeps the upstream scope until request cancellation", async () => {
    let released = false
    let upstreamCancelled = false
    const signal = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancelled = true
      }
    })
    const response = await Effect.runPromise(serveRegisteredResource(request("subtitle", {
      open: () => Effect.acquireRelease(
        Effect.succeed(new Response(body, { headers: { "content-type": "text/vtt" } })),
        () => Effect.sync(() => { released = true })
      )
    }), { signal: signal.signal }))

    expect(released).toBe(false)
    signal.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(upstreamCancelled).toBe(true)
    expect(released).toBe(true)
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" })
  })

  it("handles rejected upstream cancellation while releasing the scope on request abort", async () => {
    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on("unhandledRejection", onUnhandled)
    try {
      let released = false
      const signal = new AbortController()
      const response = await Effect.runPromise(serveRegisteredResource(request("subtitle", {
        open: () => Effect.acquireRelease(
          Effect.succeed(new Response(new ReadableStream<Uint8Array>({
            cancel: () => Promise.reject(new Error("underlying cancel failed"))
          }), { headers: { "content-type": "text/vtt" } })),
          () => Effect.sync(() => { released = true })
        )
      }), { signal: signal.signal }))

      signal.abort()
      await expect(response.text()).rejects.toMatchObject({ name: "AbortError" })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(released).toBe(true)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("does not fail successful delivery when the optional image cache write fails", async () => {
    const failingCache = ResourceCache.of({
      get: () => Effect.succeed(null),
      put: () => Effect.fail(new ResourceCacheError({ message: "unavailable" })),
      prune: () => Effect.void
    })
    const response = await Effect.runPromise(serveRegisteredResource(request("image", {
      open: () => Effect.succeed(new Response("image-ok", { headers: { "content-type": "image/png" } }))
    }), { cache: failingCache }))

    await expect(response.text()).resolves.toBe("image-ok")
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
