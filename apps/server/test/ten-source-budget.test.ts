import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { UpstreamInvalidResponse, UpstreamUnavailable } from "../src/core/errors.js"
import { Federation, makeFederationLayer } from "../src/core/federation.js"
import { makeIdentityLayer } from "../src/core/identity.js"
import type { UpstreamServer } from "../src/core/model.js"
import { Repositories } from "../src/core/repositories.js"
import { UpstreamClient } from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

interface BudgetEvidence {
  readonly peakFetches: number
  readonly publicPageSize: number
  readonly materializedRows: number
  readonly largestSqlWrite: number
  readonly largestResponseBytes: number
  readonly fullLibraryScans: number
  readonly incompleteSourceIds: ReadonlyArray<string>
  readonly mediaVersionCount: number
}

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()

const server = (index: number): UpstreamServer => ({
  id: `server-${index}`,
  catalogNamespace: `catalog:${index}`,
  verifiedCatalogId: `catalog-id:${index}`,
  verifiedBaseUrl: `https://server-${index}.example.com`,
  generation: 1,
  name: `Server ${index}`,
  baseUrl: `https://server-${index}.example.com`,
  username: "upstream-user",
  password: "upstream-password",
  accessToken: `token-${index}`,
  accessTokenExpiresAtMs: null,
  upstreamUserId: `upstream-user-${index}`,
  userAgent: "oh-my-emby-budget",
  enabled: true,
  health: "healthy",
  lastSuccessAtMs: 1_000,
  deletedAtMs: null,
  createdAtMs: 1_000 + index,
  updatedAtMs: 2_000 + index
})

const sourceItem = (serverId: string, index: number, detailed: boolean) => ({
  Id: `${serverId}-movie-${index}`,
  Type: "Movie",
  Name: `Movie ${String(index).padStart(3, "0")}`,
  ProviderIds: { Tmdb: String(1_000 + index) },
  ...(detailed ? {
    MediaSources: [{
      Id: `${serverId}-media-${index}`,
      Name: `${serverId} version`,
      Container: "mkv",
      MediaStreams: [{ Index: 0, Type: "Video", Codec: "h264" }]
    }]
  } : {})
})

const runBudgetScenario = async (): Promise<BudgetEvidence> => {
  const directory = await mkdtemp(join(tmpdir(), "oh-my-emby-budget-"))
  const filename = join(directory, "budget.sqlite")
  try {
    const database = new Database(filename)
    database.exec(migration)
    database.close()

    const realRepositories = makeSqliteRepositoriesLayer({ filename })
    await Effect.runPromise(Effect.gen(function*() {
      const repositories = yield* Repositories
      for (let index = 0; index < 10; index++) yield* repositories.saveServer(server(index))
      yield* repositories.saveVirtualLibrary({
        id: "library-1",
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        sources: Array.from({ length: 10 }, (_, index) => ({
          serverId: `server-${index}`,
          sourceLibraryId: `movies-${index}`,
          sourceLibraryName: `Movies ${index}`,
          mediaType: "movies" as const,
          sourceOrder: index,
          enabled: true
        }))
      }, Array.from({ length: 10 }, (_, index) => ({
        serverId: `server-${index}`,
        generation: 1
      })))
    }).pipe(Effect.provide(realRepositories)))

    let activeFetches = 0
    let peakFetches = 0
    let fullLibraryScans = 0
    let largestSqlWrite = 0
    const measuredRepositories = Layer.effect(Repositories, Effect.gen(function*() {
      const repositories = yield* Repositories
      return Repositories.of({
        ...repositories,
        appendQueryGenerationItems: (input) => {
          largestSqlWrite = Math.max(largestSqlWrite, input.items.length)
          return repositories.appendQueryGenerationItems(input)
        }
      })
    })).pipe(Layer.provide(realRepositories))

    const response = (serverId: string, path: string): Effect.Effect<unknown, UpstreamUnavailable> => {
      const url = new URL(path, "https://local")
      const detailed = url.searchParams.has("AnyProviderIdEquals")
      if (!detailed && (!url.searchParams.has("StartIndex") || !url.searchParams.has("Limit"))) {
        fullLibraryScans++
      }
      const delayMs = serverId === "server-8" || serverId === "server-9" ? 20 : 2
      return Effect.callback((resume) => {
        activeFetches++
        peakFetches = Math.max(peakFetches, activeFetches)
        const timer = setTimeout(() => {
          activeFetches--
          if (serverId === "server-7") {
            resume(Effect.fail(new UpstreamUnavailable({ serverId })))
            return
          }
          if (detailed) {
            const claim = url.searchParams.get("AnyProviderIdEquals") ?? ""
            const index = Number(claim.slice(claim.lastIndexOf(".") + 1)) - 1_000
            resume(Effect.succeed({
              Items: [sourceItem(serverId, index, true)],
              TotalRecordCount: 1
            }))
            return
          }
          const start = Number(url.searchParams.get("StartIndex"))
          const limit = Number(url.searchParams.get("Limit"))
          resume(Effect.succeed({
            Items: Array.from(
              { length: Math.max(0, Math.min(limit, 100 - start)) },
              (_, offset) => sourceItem(serverId, start + offset, false)
            ),
            TotalRecordCount: 100
          }))
        }, delayMs)
        return Effect.sync(() => {
          clearTimeout(timer)
          activeFetches--
        })
      })
    }

    const upstream = Layer.succeed(UpstreamClient, UpstreamClient.of({
      request: ({ serverId, path }, schema) => response(serverId, path).pipe(
        Effect.flatMap((payload) => Schema.decodeUnknownEffect(schema)(payload)),
        Effect.mapError((error) => error instanceof UpstreamUnavailable
          ? error
          : new UpstreamInvalidResponse({ serverId }))
      ),
      authenticate: () => Effect.die("unused"),
      getServerIdentity: () => Effect.die("unused"),
      listSourceLibraries: () => Effect.die("unused"),
      resolvePlayback: () => Effect.die("unused"),
      requestResource: () => Effect.die("unused")
    }))
    const identity = makeIdentityLayer.pipe(Layer.provide(measuredRepositories))
    const dependencies = Layer.mergeAll(measuredRepositories, identity, upstream)
    const federation = makeFederationLayer().pipe(Layer.provide(dependencies))
    const { page, detailed } = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* Federation
      const page = yield* service.list({
        userId: "owner",
        deviceId: "budget-device",
        virtualLibraryId: "library-1",
        startIndex: 0,
        limit: 100,
        sort: [{ field: "Name", direction: "Ascending" }],
        filters: [],
        itemTypes: []
      })
      return { page, detailed: yield* service.detail(page.items[0]!.id) }
    }).pipe(Effect.provide(federation)))

    const inspection = new Database(filename, { readonly: true })
    const materializedRows = inspection.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM query_generation_items"
    ).get()!.count
    inspection.close()
    const encoder = new TextEncoder()
    return {
      peakFetches,
      publicPageSize: page.items.length,
      materializedRows,
      largestSqlWrite,
      largestResponseBytes: Math.max(
        encoder.encode(JSON.stringify(page)).byteLength,
        encoder.encode(JSON.stringify(detailed)).byteLength
      ),
      fullLibraryScans,
      incompleteSourceIds: page.incompleteSourceIds,
      mediaVersionCount: detailed?.mediaVersions.length ?? 0
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("ten-source federation budget", () => {
  it("bounds duplicate-heavy, slow, transient, and enriched source work", async () => {
    const evidence = await runBudgetScenario()
    expect(evidence.peakFetches).toBeLessThanOrEqual(4)
    expect(evidence.publicPageSize).toBe(100)
    expect(evidence.materializedRows).toBeLessThanOrEqual(2_000)
    expect(evidence.largestSqlWrite).toBeGreaterThan(0)
    expect(evidence.largestSqlWrite).toBeLessThanOrEqual(100)
    expect(evidence.largestResponseBytes).toBeLessThan(8 * 1024 * 1024)
    expect(evidence.fullLibraryScans).toBe(0)
    expect(evidence.incompleteSourceIds).toEqual(["server-7"])
    expect(evidence.mediaVersionCount).toBeGreaterThan(1)
  })
})
