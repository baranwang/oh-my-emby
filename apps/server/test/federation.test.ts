import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  Federation,
  makeFederationLayer,
  type FederatedQuery
} from "../src/core/federation.js"
import {
  UpstreamRejected,
  UpstreamNotFound,
  UpstreamUnavailable,
  type UpstreamFailure
} from "../src/core/errors.js"
import { makeIdentityLayer } from "../src/core/identity.js"
import { METADATA_FRESH_MS, METADATA_STALE_MS } from "../src/core/limits.js"
import type { UpstreamServer } from "../src/core/model.js"
import { Repositories } from "../src/core/repositories.js"
import { UpstreamClient } from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()

const server = (index: number): UpstreamServer => ({
  id: `server-${index}` as any,
  catalogNamespace: `catalog:${index}`,
  verifiedCatalogId: `catalog-id:${index}`,
  verifiedBaseUrl: `https://server-${index}.example.com`,
  generation: 1,
  name: `Server ${index}`,
  baseUrl: `https://server-${index}.example.com` as any,
  username: "upstream-user",
  password: "upstream-password",
  accessToken: "token",
  accessTokenExpiresAtMs: null,
  userAgent: "oh-my-emby-test",
  enabled: true,
  health: "healthy",
  lastSuccessAtMs: 1_000,
  deletedAtMs: null,
  createdAtMs: 1_000,
  updatedAtMs: 1_000
})

const item = (
  id: string,
  name = id,
  extra: Record<string, unknown> = {}
) => ({
  Id: id,
  Type: "Movie",
  Name: name,
  ProviderIds: { Tmdb: id.replace(/\D/g, "") || id },
  ...extra
})

const query = (overrides: Partial<FederatedQuery> = {}): FederatedQuery => ({
  userId: "owner",
  deviceId: "device-1",
  virtualLibraryId: "library-1",
  startIndex: 0,
  limit: 20,
  sort: [{ field: "Name", direction: "Ascending" }],
  filters: [],
  ...overrides
})

type RequestHandler = (
  serverId: string,
  path: string
) => Effect.Effect<unknown, UpstreamFailure>

describe("Federation", () => {
  let directory: string
  let filename: string
  let repositories: ReturnType<typeof makeSqliteRepositoriesLayer>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-federation-"))
    filename = join(directory, "federation.sqlite")
    const database = new Database(filename)
    database.exec(migration)
    database.close()
    repositories = makeSqliteRepositoriesLayer({ filename })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const setup = async (
    sourceCount: number,
    handle: RequestHandler,
    options: { readonly now?: () => number; readonly listDeadlineMs?: number } = {}
  ) => {
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      for (let index = 0; index < sourceCount; index++) yield* repo.saveServer(server(index))
      yield* repo.saveVirtualLibrary({
        id: "library-1" as any,
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        sources: Array.from({ length: sourceCount }, (_, index) => ({
          serverId: `server-${index}` as any,
          sourceLibraryId: `movies-${index}` as any,
          sourceLibraryName: `Movies ${index}`,
          mediaType: "movies" as const,
          sourceOrder: index,
          enabled: true
        }))
      }, Array.from({ length: sourceCount }, (_, index) => ({
        serverId: `server-${index}`,
        generation: 1
      })))
    }).pipe(Effect.provide(repositories)))

    const upstream = Layer.succeed(UpstreamClient, UpstreamClient.of({
      request: ({ serverId, path }) => handle(serverId, path) as any,
      authenticate: () => Effect.die("unused") as any,
      getServerIdentity: () => Effect.die("unused") as any,
      listSourceLibraries: () => Effect.die("unused") as any,
      resolvePlayback: () => Effect.die("unused") as any
    }))
    const identity = makeIdentityLayer.pipe(Layer.provide(repositories))
    const dependencies = Layer.mergeAll(repositories, identity, upstream)
    return makeFederationLayer(options).pipe(Layer.provide(dependencies))
  }

  it("caps ten-source fan-out at four, cancels deadlines, and keeps partial successes", async () => {
    let active = 0
    let peak = 0
    let cancelled = false
    const layer = await setup(10, (serverId) => {
      if (serverId === "server-8") return Effect.fail(new UpstreamUnavailable({ serverId }))
      return Effect.callback<unknown, UpstreamFailure>((resume) => {
        active++
        peak = Math.max(peak, active)
        const timer = setTimeout(() => {
          active--
          resume(Effect.succeed({ Items: [item(`${serverId}-1`)], TotalRecordCount: 1 }))
        }, serverId === "server-9" ? 100 : 5)
        return Effect.sync(() => {
          clearTimeout(timer)
          active--
          if (serverId === "server-9") cancelled = true
        })
      })
    }, { listDeadlineMs: 25 })

    const page = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query())
    }).pipe(Effect.provide(layer)))

    expect(peak).toBe(4)
    expect(cancelled).toBe(true)
    expect(page.items).toHaveLength(8)
    expect(page.incompleteSourceIds).toEqual(["server-8", "server-9"])
  })

  it("fails a total miss when every source is unavailable", async () => {
    const layer = await setup(2, (serverId) => Effect.fail(new UpstreamUnavailable({ serverId })))
    const error = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* Effect.flip(federation.list(query()))
    }).pipe(Effect.provide(layer)))
    expect(error._tag).toBe("FederationUnavailable")
  })

  it("does not use an unrelated cached list to satisfy a failed search", async () => {
    const layer = await setup(1, (serverId, path) => path.includes("SearchTerm=")
      ? Effect.fail(new UpstreamUnavailable({ serverId }))
      : Effect.succeed({ Items: [item("movie-10", "Cached")], TotalRecordCount: 1 }))

    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      yield* federation.list(query())
      const failed = yield* Effect.flip(federation.search({ ...query(), searchTerm: "Needle" }))
      expect(failed._tag).toBe("FederationUnavailable")
    }).pipe(Effect.provide(layer)))
  })

  it("does not replay arbitrary first-page metadata after a deep-page transient failure", async () => {
    const layer = await setup(1, (serverId, path) => {
      const url = new URL(path, "https://local")
      const start = Number(url.searchParams.get("StartIndex"))
      if (!url.searchParams.has("SearchTerm")) {
        return Effect.succeed({
          Items: Array.from({ length: 100 }, (_, index) => item(`aaa-warm-${1_000 + index}`)),
          TotalRecordCount: 100
        })
      }
      if (start === 0) {
        return Effect.succeed({
          Items: Array.from({ length: 100 }, (_, index) => item(`zzz-target-${2_000 + index}`)),
          TotalRecordCount: 200
        })
      }
      return Effect.fail(new UpstreamUnavailable({ serverId }))
    })

    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      yield* federation.list(query({ limit: 100 }))
      const deep = yield* federation.search({
        ...query({ startIndex: 100, limit: 1 }),
        searchTerm: "Needle"
      })
      expect(deep.items).toEqual([])
      expect(deep.incompleteSourceIds).toEqual(["server-0"])
    }).pipe(Effect.provide(layer)))
  })

  it("does not let a lightweight projection erase richer cached metadata", async () => {
    let rich = true
    const layer = await setup(1, () => Effect.succeed({
      Items: [item("movie-10", "Movie", rich ? { Overview: "Rich overview" } : {})],
      TotalRecordCount: 1
    }))
    const run = (deviceId: string, fields: ReadonlyArray<string>) => Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ deviceId, fields }))
    }).pipe(Effect.provide(layer)))

    await run("rich", ["Overview"])
    rich = false
    await run("light", ["Name"])
    const replay = await run("replay", ["Overview"])
    expect(replay.items[0]?.displayMetadata).toMatchObject({ Name: "Movie", Overview: "Rich overview" })
  })

  it("updates fields present in a fresh primary projection without erasing omitted fields", async () => {
    let response = item("movie-10", "Old name", { Overview: "Keep me" })
    const layer = await setup(1, () => Effect.succeed({ Items: [response], TotalRecordCount: 1 }))
    const run = (deviceId: string) => Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ deviceId }))
    }).pipe(Effect.provide(layer)))

    await run("old")
    response = item("movie-10", "New name")
    const refreshed = await run("new")
    expect(refreshed.items[0]?.displayMetadata).toMatchObject({ Name: "New name", Overview: "Keep me" })
  })

  it("keeps client field projections distinct while sharing offset and limit identity", async () => {
    let calls = 0
    const layer = await setup(1, (_serverId, path) => {
      calls++
      return Effect.succeed({
        Items: [item("movie-10", "Movie", path.includes("Overview") ? { Overview: "Loaded" } : {})],
        TotalRecordCount: 1
      })
    })
    const run = (fields: ReadonlyArray<string>) => Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ fields }))
    }).pipe(Effect.provide(layer)))

    await run(["Name"])
    const detailedProjection = await run(["Overview"])
    expect(detailedProjection.items[0]?.displayMetadata).toMatchObject({ Overview: "Loaded" })
    expect(calls).toBe(2)
  })

  it("sorts duplicates by the winning source metadata after concurrent identity merge", async () => {
    const layer = await setup(2, (serverId) => serverId === "server-0"
      ? Effect.promise(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { Items: [item("primary-10", "Zulu", { ProviderIds: { Tmdb: "10" } })], TotalRecordCount: 1 }
        })
      : Effect.succeed({
          Items: [
            item("copy-10", "Alpha", { ProviderIds: { Tmdb: "10" } }),
            item("movie-11", "Beta", { ProviderIds: { Tmdb: "11" } })
          ],
          TotalRecordCount: 2
        }))
    const page = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query())
    }).pipe(Effect.provide(layer)))
    expect(page.items.map(({ displayMetadata }) =>
      typeof displayMetadata === "object" && displayMetadata !== null && !Array.isArray(displayMetadata)
        ? displayMetadata.Name
        : null
    )).toEqual(["Beta", "Zulu"])
  })

  it("hydrates favorite and resume membership from canonical local state", async () => {
    let calls = 0
    const layer = await setup(1, () => {
      calls++
      return Effect.succeed({ Items: [item("movie-10")], TotalRecordCount: 1 })
    })
    const discovered = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query())
    }).pipe(Effect.provide(layer)))
    const canonicalId = discovered.items[0]!.id
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      yield* repo.writeUserStateAndTargets({
        canonicalId,
        played: false,
        favorite: true,
        playCount: 0,
        positionTicks: 123,
        lastPlayedVersionId: null,
        updatedAtMs: 2_000
      })
      yield* repo.invalidateStateDependentQueryGenerations()
    }).pipe(Effect.provide(repositories)))

    const favorites = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ filters: [{ field: "favorite", value: true }] }))
    }).pipe(Effect.provide(layer)))
    const resume = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({
        deviceId: "resume-device",
        filters: [{ field: "resume", value: true }]
      }))
    }).pipe(Effect.provide(layer)))

    expect(favorites.items.map(({ id }) => id)).toEqual([canonicalId])
    expect(resume.items.map(({ id }) => id)).toEqual([canonicalId])
    expect(calls).toBe(1)
  })

  it("discovers neutral items for negative local-state filters", async () => {
    let calls = 0
    const layer = await setup(1, () => {
      calls++
      return Effect.succeed({ Items: [item("movie-10")], TotalRecordCount: 1 })
    })
    const page = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ filters: [{ field: "favorite", value: false }] }))
    }).pipe(Effect.provide(layer)))
    expect(page.items).toHaveLength(1)
    expect(calls).toBe(1)
  })

  it("caps duplicate and locally filtered source scans at 2,000 rows", async () => {
    let scanned = 0
    const layer = await setup(10, (_serverId, path) => {
      const limit = Number(new URL(path, "https://local").searchParams.get("Limit"))
      const count = Math.min(95, limit)
      scanned += count
      return Effect.succeed({
        Items: Array.from({ length: count }, (_, index) => ({
          Id: `unsupported-${index}`,
          Type: "BoxSet",
          Name: "Filtered"
        })),
        TotalRecordCount: 10_000
      })
    })
    const page = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ filters: [{ field: "played", value: true }] }))
    }).pipe(Effect.provide(layer)))
    expect(scanned).toBe(2_000)
    expect(page.items).toEqual([])
    expect(page.exhausted).toBe(true)
  })

  it("enriches versions with typed provider IDs and never fuzzy search", async () => {
    const paths: Array<string> = []
    const layer = await setup(2, (serverId, path) => {
      paths.push(path)
      if (serverId === "server-0") return Effect.succeed({
        Items: [item("movie-10", "Movie", {
          MediaSources: [{ Id: "source-a", Name: "A" }]
        })],
        TotalRecordCount: 1
      })
      if (path.includes("AnyProviderIdEquals=tmdb.10")) return Effect.succeed({
        Items: [item("copy-10", "Movie", {
          ProviderIds: { Tmdb: "10" },
          MediaSources: [{ Id: "source-b", Name: "B" }]
        })],
        TotalRecordCount: 1
      })
      return Effect.succeed({ Items: [], TotalRecordCount: 0 })
    })

    const detailed = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const page = yield* federation.list(query())
      return yield* federation.detail(page.items[0]!.id)
    }).pipe(Effect.provide(layer)))

    expect(detailed?.mediaVersions).toHaveLength(2)
    expect(detailed?.mediaVersions.map(({ label }) => label)).toEqual(["A", "B"])
    expect(paths.filter((path) => path.includes("AnyProviderIdEquals=tmdb.10"))).toHaveLength(2)
    expect(paths.every((path) => !path.includes("SearchTerm="))).toBe(true)
  })

  it("exact-enriches a mapped item that has no current media versions and caches the positive result", async () => {
    let exactCalls = 0
    const layer = await setup(1, (_serverId, path) => {
      if (path.includes("AnyProviderIdEquals=tmdb.10")) {
        exactCalls++
        return Effect.succeed({
          Items: [item("movie-10", "Movie", {
            MediaSources: [{ Id: "source-a", Name: "A" }]
          })],
          TotalRecordCount: 1
        })
      }
      return Effect.succeed({ Items: [item("movie-10", "Movie")], TotalRecordCount: 1 })
    })
    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const page = yield* federation.list(query())
      const first = yield* federation.detail(page.items[0]!.id)
      const second = yield* federation.detail(page.items[0]!.id)
      expect(first?.mediaVersions).toHaveLength(1)
      expect(second?.mediaVersions).toHaveLength(1)
    }).pipe(Effect.provide(layer)))
    expect(exactCalls).toBe(1)
  })

  it("keeps successful exact enrichments when another source returns an invalid response", async () => {
    const layer = await setup(3, (serverId, path) => {
      if (!path.includes("AnyProviderIdEquals=")) {
        return Effect.succeed(serverId === "server-0"
          ? {
              Items: [item("movie-10", "Movie", { MediaSources: [{ Id: "source-a", Name: "A" }] })],
              TotalRecordCount: 1
            }
          : { Items: [], TotalRecordCount: 0 })
      }
      if (serverId === "server-1") return Effect.succeed({ invalid: true })
      if (serverId === "server-0") return Effect.succeed({
        Items: [item("movie-10", "Movie", { MediaSources: [{ Id: "source-a", Name: "A" }] })],
        TotalRecordCount: 1
      })
      return Effect.succeed({
        Items: [item("copy-10", "Movie", { MediaSources: [{ Id: "source-c", Name: "C" }] })],
        TotalRecordCount: 1
      })
    })
    const detailed = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const page = yield* federation.list(query())
      return yield* federation.detail(page.items[0]!.id)
    }).pipe(Effect.provide(layer)))
    expect(detailed?.mediaVersions.map(({ label }) => label)).toEqual(["A", "C"])
    expect(detailed?.incompleteSourceIds).toEqual(["server-1"])
  })

  it("does not expose expired exact versions after a transient refresh failure", async () => {
    let now = 1_000
    let unavailable = false
    const layer = await setup(1, (serverId) => unavailable
      ? Effect.fail(new UpstreamUnavailable({ serverId }))
      : Effect.succeed({
          Items: [item("movie-10", "Movie", { MediaSources: [{ Id: "source-a", Name: "A" }] })],
          TotalRecordCount: 1
        }), { now: () => now })
    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const page = yield* federation.list(query())
      expect((yield* federation.detail(page.items[0]!.id))?.mediaVersions).toHaveLength(1)
      now += METADATA_STALE_MS + 1
      unavailable = true
      const expired = yield* federation.detail(page.items[0]!.id)
      expect(expired?.mediaVersions).toEqual([])
      expect(expired?.incompleteSourceIds).toEqual(["server-0"])
    }).pipe(Effect.provide(layer)))
  })

  it("hides a version omitted by the latest successful detail projection", async () => {
    let now = 1_000
    let mediaSources: ReadonlyArray<{ readonly Id: string; readonly Name: string }> = [{ Id: "source-a", Name: "A" }]
    const layer = await setup(1, (_serverId, path) => Effect.succeed(path.includes("AnyProviderIdEquals=")
      ? { Items: [item("movie-10", "Movie", { MediaSources: mediaSources })], TotalRecordCount: 1 }
      : { Items: [item("movie-10")], TotalRecordCount: 1 }), { now: () => now })

    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const page = yield* federation.list(query())
      expect((yield* federation.detail(page.items[0]!.id))?.mediaVersions.map(({ label }) => label)).toEqual(["A"])
      now += METADATA_FRESH_MS + 1
      mediaSources = []
      expect((yield* federation.detail(page.items[0]!.id))?.mediaVersions).toEqual([])
    }).pipe(Effect.provide(layer)))
  })

  it.each([
    ["transient", true],
    ["auth", false],
    ["not-found", false],
    ["invalid", false]
  ] as const)("classifies %s exact refreshes when exposing stale detail versions", async (failure, visible) => {
    let now = 1_000
    let mode: "success" | typeof failure = "success"
    const layer = await setup(1, (serverId, path) => {
      if (!path.includes("AnyProviderIdEquals=")) {
        return Effect.succeed({ Items: [item("movie-10")], TotalRecordCount: 1 })
      }
      if (mode === "transient") return Effect.fail(new UpstreamUnavailable({ serverId }))
      if (mode === "auth") return Effect.fail(new UpstreamRejected({ serverId, status: 401 }))
      if (mode === "not-found") return Effect.fail(new UpstreamNotFound({ serverId }))
      if (mode === "invalid") return Effect.succeed({ invalid: true })
      return Effect.succeed({
        Items: [item("movie-10", "Movie", { MediaSources: [{ Id: "source-a", Name: "A" }] })],
        TotalRecordCount: 1
      })
    }, { now: () => now })

    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const page = yield* federation.list(query())
      expect((yield* federation.detail(page.items[0]!.id))?.mediaVersions.map(({ label }) => label)).toEqual(["A"])
      now += METADATA_FRESH_MS + 1
      mode = failure
      const refreshed = yield* federation.detail(page.items[0]!.id)
      expect(refreshed?.mediaVersions.map(({ label }) => label)).toEqual(visible ? ["A"] : [])
    }).pipe(Effect.provide(layer)))
  })

  it.each([
    ["transient", ["A", "B"]],
    ["auth", []],
    ["not-found", []],
    ["invalid", []]
  ] as const)("classifies %s refreshes across sibling detail projections", async (failure, expected) => {
    let now = 1_000
    let mode: "success" | typeof failure = "success"
    const siblings = (withVersions: boolean) => [
      item("copy-a", "A", {
        ProviderIds: { Tmdb: "10" },
        ...(withVersions ? { MediaSources: [{ Id: "source-a", Name: "A" }] } : {})
      }),
      item("copy-b", "B", {
        ProviderIds: { Tmdb: "10" },
        ...(withVersions ? { MediaSources: [{ Id: "source-b", Name: "B" }] } : {})
      })
    ]
    const layer = await setup(1, (serverId, path) => {
      if (!path.includes("AnyProviderIdEquals=")) {
        return Effect.succeed({ Items: siblings(false), TotalRecordCount: 2 })
      }
      if (mode === "transient") return Effect.fail(new UpstreamUnavailable({ serverId }))
      if (mode === "auth") return Effect.fail(new UpstreamRejected({ serverId, status: 401 }))
      if (mode === "not-found") return Effect.fail(new UpstreamNotFound({ serverId }))
      if (mode === "invalid") return Effect.succeed({ invalid: true })
      return Effect.succeed({ Items: siblings(true), TotalRecordCount: 2 })
    }, { now: () => now })

    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const page = yield* federation.list(query())
      expect((yield* federation.detail(page.items[0]!.id))?.mediaVersions.map(({ label }) => label)).toEqual(["A", "B"])
      now += METADATA_FRESH_MS + 1
      mode = failure
      const refreshed = yield* federation.detail(page.items[0]!.id)
      expect(refreshed?.mediaVersions.map(({ label }) => label)).toEqual(expected)
    }).pipe(Effect.provide(layer)))
  })
})
