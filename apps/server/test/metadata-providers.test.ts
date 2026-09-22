import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import {
  MetadataProviders,
  makeMetadataProvidersLayer
} from "../src/core/metadata-providers.js"
import type {
  ExternalMetadataCacheEntry,
  MetadataProviderSetting
} from "../src/core/model.js"
import { Repositories, type CatalogItemRecord } from "../src/core/repositories.js"

const record = (itemType: "Movie" | "Series" = "Movie"): CatalogItemRecord => ({
  canonical: {
    id: "canonical-1",
    itemType,
    identityState: "exact",
    displayMetadata: {
      Name: "Upstream title",
      Overview: "Upstream overview",
      Tagline: "Upstream tagline"
    },
    createdAtMs: 1,
    updatedAtMs: 1
  },
  claims: [
    {
      namespace: "imdb:title",
      value: "tt1104001",
      state: "exact",
      sourceItemId: "source-1",
      createdAtMs: 1
    },
    {
      namespace: itemType === "Movie" ? "tmdb:movie" : "tmdb:tv",
      value: "20526",
      state: "exact",
      sourceItemId: "source-1",
      createdAtMs: 1
    }
  ],
  sourceItems: [],
  mediaVersions: [],
  userState: null
})

const settings = (
  order: readonly ["tmdb" | "trakt", "tmdb" | "trakt"] = ["tmdb", "trakt"]
): [MetadataProviderSetting, MetadataProviderSetting] => order.map((id, index) => ({
  id,
  enabled: true,
  order: index,
  language: id === "tmdb" ? "zh-CN" : null,
  credential: `${id}-secret`,
  status: "ready",
  updatedAtMs: 1
})) as [MetadataProviderSetting, MetadataProviderSetting]

const fixture = (options: {
  readonly providerSettings?: [MetadataProviderSetting, MetadataProviderSetting]
  readonly fetch: typeof fetch
  readonly now?: () => number
  readonly deadlineMs?: number
  readonly maxResponseBytes?: number
}) => {
  let providerSettings = options.providerSettings ?? settings()
  const cache = new Map<string, ExternalMetadataCacheEntry>()
  const writes: Array<ExternalMetadataCacheEntry> = []
  const repositories = Layer.succeed(Repositories, Repositories.of({
    readMetadataSettings: () => Effect.succeed(providerSettings),
    writeMetadataSettings: (next) => Effect.sync(() => {
      providerSettings = [...next] as [MetadataProviderSetting, MetadataProviderSetting]
      return providerSettings
    }),
    readExternalMetadata: (providerId, namespace, value) =>
      Effect.succeed(cache.get(`${providerId}:${namespace}:${value}`) ?? null),
    writeExternalMetadata: (entry) => Effect.sync(() => {
      cache.set(`${entry.providerId}:${entry.identityNamespace}:${entry.identityValue}`, entry)
      writes.push(entry)
    })
  } as any))
  const layer = makeMetadataProvidersLayer({
    fetch: options.fetch,
    now: options.now ?? (() => 10_000),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes })
  }).pipe(Layer.provide(repositories))
  const run = <A>(effect: Effect.Effect<A, any, MetadataProviders>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return {
    run,
    cache,
    writes,
    get settings() { return providerSettings }
  }
}

describe("MetadataProviders", () => {
  it("uses exact IMDb adapters and merges the first non-empty configured fields", async () => {
    const requests: Array<Request> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.startsWith("https://api.trakt.tv/")) {
        return Response.json({
          title: "Trakt title",
          overview: "",
          images: {
            poster: ["//walter-r2.trakt.tv/images/poster.jpg"],
            fanart: ["https://images.example.com/rejected.jpg"]
          }
        })
      }
      return Response.json({
        movie_results: [{
          title: "TMDB title",
          overview: "TMDB overview",
          poster_path: "/tmdb-poster.jpg",
          backdrop_path: "/tmdb-backdrop.jpg"
        }],
        tv_results: []
      })
    }
    const test = fixture({ fetch, providerSettings: settings(["trakt", "tmdb"]) })

    const original = record()
    const enriched = await test.run(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).refresh(original)
    }))

    expect(enriched.canonical.displayMetadata).toEqual({
      Name: "Trakt title",
      Overview: "TMDB overview",
      Tagline: "Upstream tagline",
      ExternalImages: {
        Primary: "https://walter-r2.trakt.tv/images/poster.jpg",
        Backdrop: ["https://image.tmdb.org/t/p/w1280/tmdb-backdrop.jpg"]
      }
    })
    expect(enriched.claims).toBe(original.claims)
    expect(enriched.sourceItems).toBe(original.sourceItems)
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.trakt.tv/movies/tt1104001?extended=full",
      "https://api.themoviedb.org/3/find/tt1104001?external_source=imdb_id&language=zh-CN"
    ])
    expect(requests[0]?.headers.get("trakt-api-key")).toBe("trakt-secret")
    expect(requests[0]?.headers.get("trakt-api-version")).toBe("2")
    expect(requests[0]?.headers.get("accept")).toBe("application/json")
    expect(requests[0]?.headers.get("content-type")).toBe("application/json")
    expect(requests[0]?.headers.get("user-agent")).toMatch(/^oh-my-emby\//)
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer tmdb-secret")
  })

  it("uses fresh positive and negative cache entries without provider fan-out", async () => {
    let calls = 0
    const test = fixture({
      fetch: async (input) => {
        calls++
        return new Request(input).url.includes("themoviedb")
          ? Response.json({ movie_results: [], tv_results: [] })
          : new Response(null, { status: 404 })
      }
    })
    const original = record()

    const before = await test.run(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).overlayCached(original)
    }))
    expect(before.canonical.displayMetadata).toEqual(original.canonical.displayMetadata)
    expect(calls).toBe(0)

    await test.run(Effect.gen(function*() {
      const providers = yield* MetadataProviders
      yield* providers.refresh(original)
      yield* providers.refresh(original)
    }))
    expect(calls).toBe(2)
    expect(test.writes).toHaveLength(2)
    expect(test.writes.every(({ found, payload }) => !found && payload === null)).toBe(true)
  })

  it("bounds provider failures, falls back upstream, and recovers degraded status on success", async () => {
    let healthy = false
    const test = fixture({
      fetch: async (input) => {
        const url = new Request(input).url
        if (!healthy) {
          if (url.includes("themoviedb")) {
            return new Response("{".repeat(100), { headers: { "content-length": "100" } })
          }
          return new Response(null, { status: 429 })
        }
        return url.includes("themoviedb")
          ? Response.json({ movie_results: [{ title: "Recovered" }], tv_results: [] })
          : Response.json({ title: "Trakt recovered", overview: "", images: {} })
      },
      maxResponseBytes: 80
    })
    const original = record()

    const fallback = await test.run(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).refresh(original)
    }))
    expect(fallback.canonical.displayMetadata).toEqual(original.canonical.displayMetadata)
    expect(test.settings.map(({ status }) => status)).toEqual(["degraded", "degraded"])
    expect(JSON.stringify(test.settings)).not.toContain("Provider")

    healthy = true
    const recovered = await test.run(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).refresh(original)
    }))
    expect(recovered.canonical.displayMetadata).toMatchObject({ Name: "Recovered" })
    expect(test.settings.map(({ status }) => status)).toEqual(["ready", "ready"])
  })

  it.each([
    ["timeout", (request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })],
    ["malformed JSON", () => Promise.resolve(new Response("{"))]
  ] as const)("treats %s as a degraded provider fallback", async (_failure, fetchTmdb) => {
    const configured = settings()
    configured[1] = { ...configured[1], enabled: false }
    const test = fixture({
      providerSettings: configured,
      fetch: ((input: RequestInfo | URL) => fetchTmdb(new Request(input))) as typeof fetch,
      deadlineMs: 5
    })
    const original = record()

    const fallback = await test.run(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).refresh(original)
    }))
    expect(fallback.canonical.displayMetadata).toEqual(original.canonical.displayMetadata)
    expect(test.settings[0].status).toBe("degraded")
  })

  it("applies the provider deadline while reading the response body", async () => {
    const configured = settings()
    configured[1] = { ...configured[1], enabled: false }
    let timer: ReturnType<typeof setTimeout>
    const test = fixture({
      providerSettings: configured,
      deadlineMs: 5,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              movie_results: [{ title: "Too late" }],
              tv_results: []
            })))
            controller.close()
          }, 30)
        },
        cancel() { clearTimeout(timer) }
      }))
    })

    const fallback = await test.run(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).refresh(record())
    }))
    expect(fallback.canonical.displayMetadata).toMatchObject({ Name: "Upstream title" })
    expect(test.settings[0].status).toBe("degraded")
  })

  it("returns only allowlisted HTTPS cached artwork by image type and index", async () => {
    const test = fixture({
      providerSettings: settings(["trakt", "tmdb"]),
      fetch: async (input) => new Request(input).url.includes("trakt.tv")
        ? Response.json({
            title: "Trakt",
            images: {
              poster: "http://walter-r2.trakt.tv/insecure.jpg",
              fanart: [
                "//walter-r2.trakt.tv/backdrop-1.jpg",
                "https://walter-r2.trakt.tv.evil.example/backdrop-2.jpg"
              ]
            }
          })
        : Response.json({
            movie_results: [{
              title: "TMDB",
              poster_path: "https://evil.example/poster.jpg",
              backdrop_path: "/backdrop-2.jpg"
            }],
            tv_results: []
          })
    })
    const original = record()
    await test.run(Effect.gen(function*() {
      yield* (yield* MetadataProviders).refresh(original)
    }))

    const images = await test.run(Effect.gen(function*() {
      const providers = yield* MetadataProviders
      return yield* Effect.all([
        providers.resolveCachedImage(original, "Primary"),
        providers.resolveCachedImage(original, "Backdrop"),
        providers.resolveCachedImage(original, "Backdrop", 1),
        providers.resolveCachedImage(original, "Logo")
      ])
    }))
    expect(images.map((image) => image?.href ?? null)).toEqual([
      null,
      "https://walter-r2.trakt.tv/backdrop-1.jpg",
      null,
      null
    ])
  })

  it("rejects a cached TMDB image outside the required size path", async () => {
    const configured = settings()
    configured[1] = { ...configured[1], enabled: false }
    const test = fixture({ providerSettings: configured, fetch: async () => Effect.die("unused") as never })
    test.cache.set("tmdb:imdb:title:tt1104001", {
      providerId: "tmdb",
      identityNamespace: "imdb:title",
      identityValue: "tt1104001",
      payload: {
        ExternalImages: { Primary: "https://image.tmdb.org/t/p/original/poster.jpg" }
      },
      found: true,
      fetchedAtMs: 9_000,
      freshUntilMs: 20_000,
      staleUntilMs: 30_000
    })

    const image = await test.run(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).resolveCachedImage(record(), "Primary")
    }))
    expect(image).toBeNull()
  })

  it("does not treat upstream display metadata as an external image cache entry", async () => {
    const configured = settings()
    configured[1] = { ...configured[1], enabled: false }
    const test = fixture({ providerSettings: configured, fetch: async () => Effect.die("unused") as never })
    const original = record()
    const injected: CatalogItemRecord = {
      ...original,
      canonical: {
        ...original.canonical,
        displayMetadata: {
          ...original.canonical.displayMetadata as Record<string, unknown>,
          ExternalImages: { Primary: "https://image.tmdb.org/t/p/w780/injected.jpg" }
        } as any
      }
    }

    const image = await test.run(Effect.gen(function*() {
      return yield* (yield* MetadataProviders).resolveCachedImage(injected, "Primary")
    }))
    expect(image).toBeNull()
  })

  it("uses the Trakt show endpoint for exact series metadata", async () => {
    const urls: Array<string> = []
    const test = fixture({
      providerSettings: settings(["trakt", "tmdb"]),
      fetch: async (input) => {
        urls.push(new Request(input).url)
        return Response.json({ title: "Show", overview: "Overview", images: {} })
      }
    })
    await test.run(Effect.gen(function*() {
      const providers = yield* MetadataProviders
      yield* providers.refresh(record("Series"))
    }))
    expect(urls).toEqual([
      "https://api.trakt.tv/shows/tt1104001?extended=full",
      "https://api.themoviedb.org/3/find/tt1104001?external_source=imdb_id&language=zh-CN"
    ])
  })
})
