import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { Federation, makeFederationLayer, type FederatedQuery } from "../src/core/federation.js"
import { makeIdentityLayer } from "../src/core/identity.js"
import { MetadataProviders } from "../src/core/metadata-providers.js"
import type { UpstreamServer } from "../src/core/model.js"
import { Repositories } from "../src/core/repositories.js"
import { UpstreamClient } from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = [
  await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text(),
  await Bun.file(new URL("../migrations/0002_dashboard_alignment.sql", import.meta.url)).text()
].join("\n")
const movie = (id: string, name: string) => ({
  Id: id,
  Type: "Movie",
  Name: name,
  ProviderIds: { Tmdb: id.replace(/\D/g, "") }
})
const query = (overrides: Partial<FederatedQuery> = {}): FederatedQuery => ({
  userId: "owner",
  deviceId: "device",
  virtualLibraryId: "library",
  startIndex: 0,
  limit: 2,
  sort: [{ field: "Name", direction: "Ascending" }],
  filters: [],
  itemTypes: [],
  ...overrides
})

describe("federated pagination generations", () => {
  let directory: string
  let filename: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-pagination-"))
    filename = join(directory, "pagination.sqlite")
    const database = new Database(filename)
    database.exec(migration)
    database.close()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const setup = async (handle: (path: string) => unknown) => {
    const repositories = makeSqliteRepositoriesLayer({ filename })
    const upstreamServer: UpstreamServer = {
      id: "server" as any,
      catalogNamespace: "catalog:server",
      verifiedCatalogId: "catalog-id:server",
      verifiedBaseUrl: "https://server.example.com",
      generation: 1,
      name: "Server",
      endpoints: [
        {
          id: "endpoint-server",
          protocol: "https",
          host: "server.example.com",
          port: null,
          path: "",
          displayUrl: "https://server.example.com" as any,
          verifiedCatalogId: "catalog-id:server",
          health: "healthy",
          lastSuccessAtMs: 1_000,
          order: 0,
          createdAtMs: 1_000,
          updatedAtMs: 1_000
        }
      ],
      baseUrl: "https://server.example.com" as any,
      username: "upstream-user",
      password: "password",
      accessToken: "token",
      accessTokenExpiresAtMs: null,
      upstreamUserId: "upstream-user-id",
      userAgentPolicy: "fixed",
      userAgent: "test",
      enabled: true,
      health: "healthy",
      lastSuccessAtMs: 1_000,
      deletedAtMs: null,
      createdAtMs: 1_000,
      updatedAtMs: 1_000
    }
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      yield* repo.saveServer(upstreamServer)
      yield* repo.saveVirtualLibrary({
        id: "library" as any,
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        sources: [{
          serverId: "server" as any,
          sourceLibraryId: "movies" as any,
          sourceLibraryName: "Movies",
          mediaType: "movies",
          sourceOrder: 0,
          enabled: true
        }]
      }, [{ serverId: "server", generation: 1 }])
    }).pipe(Effect.provide(repositories)))
    const upstream = Layer.succeed(UpstreamClient, UpstreamClient.of({
      request: ({ path }) => Effect.promise(() => Promise.resolve(handle(path))) as any,
      authenticate: () => Effect.die("unused") as any,
      getServerIdentity: () => Effect.die("unused") as any,
      listSourceLibraries: () => Effect.die("unused") as any,
      resolvePlayback: () => Effect.die("unused") as any
    }))
    const dependencies = Layer.mergeAll(
      repositories,
      makeIdentityLayer.pipe(Layer.provide(repositories)),
      upstream,
      Layer.succeed(MetadataProviders, MetadataProviders.of({
        refresh: (record) => Effect.succeed(record),
        overlayCached: (record) => Effect.succeed(record),
        resolveCachedImage: () => Effect.succeed(null)
      }))
    )
    return { layer: makeFederationLayer().pipe(Layer.provide(dependencies)), repositories }
  }

  it("does not move published ordinals after metadata enrichment", async () => {
    let detailed = false
    const { layer } = await setup((path) => {
      detailed ||= path.includes("AnyProviderIdEquals=")
      return {
        Items: detailed
          ? [movie("1", "Zulu"), movie("2", "Alpha")]
          : [movie("1", "Alpha"), movie("2", "Zulu")],
        TotalRecordCount: 2
      }
    })
    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const first = yield* federation.list(query())
      yield* federation.detail(first.items[0]!.id)
      const replay = yield* federation.list(query())
      expect(replay.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id))
    }).pipe(Effect.provide(layer)))
  })

  it("allows a provisional count to fall and then returns a stable terminal empty page", async () => {
    const { layer } = await setup((path) => {
      const start = Number(new URL(path, "https://local").searchParams.get("StartIndex"))
      return start === 0
        ? { Items: [movie("1", "A"), movie("2", "B")], TotalRecordCount: 6 }
        : start === 2
          ? { Items: [movie("1", "A"), movie("2", "B")], TotalRecordCount: 4 }
          : { Items: [], TotalRecordCount: 2 }
    })
    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const first = yield* federation.list(query({ startIndex: 0, limit: 2 }))
      const second = yield* federation.list(query({ startIndex: 2, limit: 2 }))
      const terminal = yield* federation.list(query({ startIndex: 4, limit: 2 }))
      const replay = yield* federation.list(query({ startIndex: 4, limit: 2 }))
      expect(second.totalRecordCount).toBeLessThan(first.totalRecordCount)
      expect(terminal.items).toEqual([])
      expect(terminal.exhausted).toBe(true)
      expect(replay).toEqual(terminal)
    }).pipe(Effect.provide(layer)))
  })

  it("raises a provisional count as more distinct rows are published", async () => {
    const { layer } = await setup(() => ({
      Items: [movie("1", "A"), movie("2", "B"), movie("3", "C")],
      TotalRecordCount: 3
    }))
    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      const first = yield* federation.list(query({ startIndex: 0, limit: 1 }))
      const second = yield* federation.list(query({ startIndex: 1, limit: 1 }))
      expect(second.totalRecordCount).toBeGreaterThan(first.totalRecordCount)
    }).pipe(Effect.provide(layer)))
  })

  it("deduplicates heavy pages and uses canonical ID as the final tie-breaker", async () => {
    const { layer } = await setup((path) => {
      const start = Number(new URL(path, "https://local").searchParams.get("StartIndex"))
      return start === 0
        ? { Items: [movie("2", "Same"), movie("1", "Same"), movie("1", "Same")], TotalRecordCount: 3 }
        : { Items: [], TotalRecordCount: 3 }
    })
    const page = await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ limit: 3 }))
    }).pipe(Effect.provide(layer)))
    expect(new Set(page.items.map(({ id }) => id)).size).toBe(page.items.length)
    expect(page.items.map(({ id }) => id)).toEqual(page.items.map(({ id }) => id).toSorted())
  })

  it("clamps page size to 100 and rejects windows beyond 2,000 rows", async () => {
    const requestedLimits: Array<number> = []
    const { layer } = await setup((path) => {
      requestedLimits.push(Number(new URL(path, "https://local").searchParams.get("Limit")))
      return { Items: [], TotalRecordCount: 0 }
    })
    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      yield* federation.list(query({ limit: 1_000 }))
      const error = yield* Effect.flip(federation.list(query({ startIndex: 1_950, limit: 100 })))
      expect(error._tag).toBe("FederationLimitExceeded")
    }).pipe(Effect.provide(layer)))
    expect(requestedLimits).toEqual([100])
  })

  it("uses one durable generation when only offset and limit change", async () => {
    const { layer } = await setup((path) => {
      const url = new URL(path, "https://local")
      const start = Number(url.searchParams.get("StartIndex"))
      const limit = Number(url.searchParams.get("Limit"))
      const all = Array.from({ length: 150 }, (_, index) => movie(String(index + 1), String(index).padStart(3, "0")))
      return { Items: all.slice(start, start + limit), TotalRecordCount: all.length }
    })
    await Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      yield* federation.list(query({ startIndex: 0, limit: 100 }))
      yield* federation.list(query({ startIndex: 100, limit: 50 }))
    }).pipe(Effect.provide(layer)))
    const database = new Database(filename)
    expect(database.query("SELECT count(*) AS count FROM query_generations").get()).toEqual({ count: 1 })
    expect(database.query("SELECT count(*) AS count FROM query_generation_items").get()).toEqual({ count: 150 })
    database.close()
  })

  it("resumes after an interrupted generation chunk without skipping ordinals", async () => {
    const { layer } = await setup((path) => {
      const url = new URL(path, "https://local")
      const start = Number(url.searchParams.get("StartIndex"))
      const limit = Number(url.searchParams.get("Limit"))
      const all = Array.from({ length: 150 }, (_, index) => movie(String(index + 1), String(index).padStart(3, "0")))
      return { Items: all.slice(start, start + limit), TotalRecordCount: all.length }
    })
    const interrupted = new Database(filename)
    interrupted.exec(`
      CREATE TRIGGER abort_second_generation_chunk
      BEFORE INSERT ON query_generation_items
      WHEN NEW.ordinal >= 100
      BEGIN
        SELECT RAISE(ABORT, 'stop after first generation chunk');
      END;
    `)
    interrupted.close()

    const run = () => Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ startIndex: 100, limit: 50 }))
    }).pipe(Effect.provide(layer)))

    await expect(run()).rejects.toMatchObject({ _tag: "RepositoryError" })
    const checkpoint = new Database(filename)
    expect(checkpoint.query("SELECT count(*) AS count FROM query_generation_items").get()).toEqual({ count: 100 })
    const row = checkpoint.query<{ source_state_json: string }, []>(
      "SELECT source_state_json FROM query_generations"
    ).get()!
    expect((JSON.parse(row.source_state_json).sources[0] as { continuation: number }).continuation).toBe(100)
    checkpoint.exec("DROP TRIGGER abort_second_generation_chunk")
    checkpoint.close()

    const resumed = await run()
    expect(resumed.items).toHaveLength(50)
    const complete = new Database(filename)
    expect(complete.query(`
      SELECT count(*) AS count, min(ordinal) AS first, max(ordinal) AS last
      FROM query_generation_items
    `).get()).toEqual({ count: 150, first: 0, last: 149 })
    complete.close()
  })

  it("converges concurrent same-query publications on the repository winner", async () => {
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const { layer } = await setup(async () => {
      const arrival = ++arrivals
      if (arrivals === 2) release()
      await barrier
      return {
        Items: [movie(String(arrival), arrival === 1 ? "Alpha" : "Beta")],
        TotalRecordCount: 1
      }
    })
    const run = () => Effect.runPromise(Effect.gen(function*() {
      const federation = yield* Federation
      return yield* federation.list(query({ limit: 1 }))
    }).pipe(Effect.provide(layer)))

    const [first, second] = await Promise.all([run(), run()])
    expect(first.items.map(({ id }) => id)).toEqual(second.items.map(({ id }) => id))
    const database = new Database(filename)
    expect(database.query("SELECT count(*) AS count FROM query_generations").get()).toEqual({ count: 1 })
    expect(database.query("SELECT count(*) AS count FROM query_generation_items").get()).toEqual({ count: 1 })
    database.close()
  })
})
