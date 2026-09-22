import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { LibraryService, makeLibraryServiceLayer } from "../src/core/library-service.js"
import type { UpstreamServer } from "../src/core/model.js"
import { Repositories } from "../src/core/repositories.js"
import { UpstreamClient } from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = [
  await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text(),
  await Bun.file(new URL("../migrations/0002_dashboard_alignment.sql", import.meta.url)).text()
].join("\n")
const server = (id: string, overrides: Partial<UpstreamServer> = {}): UpstreamServer => ({
  id: id as any,
  catalogNamespace: `catalog:${id}`,
  verifiedCatalogId: `identity:${id}`,
  verifiedBaseUrl: `https://${id}.example.com`,
  generation: 1,
  name: id,
  endpoints: [
    {
      id: `endpoint-${id}`,
      protocol: "https",
      host: `${id}.example.com`,
      port: null,
      path: "",
      displayUrl: `https://${id}.example.com` as any,
      verifiedCatalogId: `identity:${id}`,
      health: "healthy",
      lastSuccessAtMs: 1_000,
      order: 0,
      createdAtMs: 1_000,
      updatedAtMs: 1_000
    }
  ],
  baseUrl: `https://${id}.example.com` as any,
  username: "alice",
  password: "secret",
  accessToken: "token",
  accessTokenExpiresAtMs: null,
  upstreamUserId: `${id}-user`,
  userAgentPolicy: "fixed",
  userAgent: "Agent/1",
  enabled: true,
  health: "healthy",
  lastSuccessAtMs: 1_000,
  deletedAtMs: null,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
  ...overrides
})

const discovered = [
  { id: "movies" as any, serverId: "server-1" as any, name: "Movies", mediaType: "movies" as const },
  { id: "series" as any, serverId: "server-1" as any, name: "Series", mediaType: "series" as const }
]

describe("LibraryService", () => {
  let directory: string
  let filename: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-library-service-"))
    filename = join(directory, "library.sqlite")
    const database = new Database(filename)
    database.exec(migration)
    database.close()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const setup = async (
    servers: ReadonlyArray<UpstreamServer> = [server("server-1")],
    discover: (serverId: string) => Effect.Effect<ReadonlyArray<(typeof discovered)[number]>> =
      (serverId) => Effect.succeed(discovered.map((item) => ({ ...item, serverId: serverId as any })))
  ) => {
    const repositories = makeSqliteRepositoriesLayer({ filename })
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      for (const item of servers) yield* repo.saveServer(item)
    }).pipe(Effect.provide(repositories)))
    const upstream = Layer.succeed(UpstreamClient, UpstreamClient.of({
      request: () => Effect.die("unused") as any,
      authenticate: () => Effect.die("unused") as any,
      getServerIdentity: () => Effect.die("unused") as any,
      listSourceLibraries: discover,
      resolvePlayback: () => Effect.die("unused") as any
    }))
    const service = makeLibraryServiceLayer.pipe(Layer.provide(Layer.merge(repositories, upstream)))
    return { repositories, service }
  }

  it("rejects movies-versus-series binding mismatches", async () => {
    const { service } = await setup()
    await expect(Effect.runPromise(Effect.gen(function*() {
      const libraries = yield* LibraryService
      return yield* libraries.create({
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        sources: [{ serverId: "server-1" as any, sourceLibraryId: "series" as any, enabled: true }]
      })
    }).pipe(Effect.provide(service)))).rejects.toMatchObject({ _tag: "LibraryValidationFailed" })
  })

  it("preserves source order and excludes disabled bindings from eligibility", async () => {
    const { repositories, service } = await setup([server("server-1"), server("server-2")])
    const created = await Effect.runPromise(Effect.gen(function*() {
      const libraries = yield* LibraryService
      return yield* libraries.create({
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        sources: [
          { serverId: "server-2" as any, sourceLibraryId: "movies" as any, enabled: true },
          { serverId: "server-1" as any, sourceLibraryId: "movies" as any, enabled: false }
        ]
      })
    }).pipe(Effect.provide(service)))
    expect(created.sources.map((source) => source.serverId)).toEqual(["server-2", "server-1"])
    const eligible = await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      return yield* repo.resolveEligibleSources(created.id)
    }).pipe(Effect.provide(repositories)))
    expect(eligible.map((source) => source.serverId)).toEqual(["server-2"])
  })

  it("deletes only library metadata and keeps canonical state", async () => {
    const { repositories, service } = await setup()
    const library = await Effect.runPromise(Effect.gen(function*() {
      const libraries = yield* LibraryService
      return yield* libraries.create({
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        sources: [{ serverId: "server-1" as any, sourceLibraryId: "movies" as any, enabled: true }]
      })
    }).pipe(Effect.provide(service)))
    await Effect.runPromise(Effect.gen(function*() {
      const repo = yield* Repositories
      yield* repo.persistIdentityResult({
        canonical: {
          id: "canonical-1",
          itemType: "Movie",
          identityState: "exact",
          displayMetadata: { Name: "Movie" },
          createdAtMs: 1_000,
          updatedAtMs: 1_000
        },
        aliases: [],
        claims: [],
        sourceItem: {
          id: "source-1",
          serverId: "server-1",
          catalogNamespace: "catalog:server-1",
          serverGeneration: 1,
          sourceLibraryId: "movies",
          upstreamItemId: "item-1",
          itemType: "Movie",
          canonicalId: "canonical-1",
          quarantineReason: null,
          createdAtMs: 1_000,
          updatedAtMs: 1_000
        },
        mediaVersions: []
      })
    }).pipe(Effect.provide(repositories)))
    await Effect.runPromise(Effect.gen(function*() {
      const libraries = yield* LibraryService
      yield* libraries.delete(library.id)
    }).pipe(Effect.provide(service)))
    const database = new Database(filename)
    expect(database.query("SELECT count(*) AS count FROM canonical_items").get()).toEqual({ count: 1 })
    database.close()
  })

  it("keeps a source eligible while another enabled library still binds it", async () => {
    const { service } = await setup()
    await Effect.runPromise(Effect.gen(function*() {
      const libraries = yield* LibraryService
      const first = yield* libraries.create({
        name: "Movies A",
        mediaType: "movies",
        enabled: true,
        sources: [{ serverId: "server-1" as any, sourceLibraryId: "movies" as any, enabled: true }]
      })
      yield* libraries.create({
        name: "Movies B",
        mediaType: "movies",
        enabled: true,
        sources: [{ serverId: "server-1" as any, sourceLibraryId: "movies" as any, enabled: true }]
      })
      yield* libraries.delete(first.id)
      expect(yield* libraries.isSourceEligible("server-1", "movies")).toBe(true)
    }).pipe(Effect.provide(service)))
  })

  it.each([
    ["unverified", server("server-1", { verifiedCatalogId: null, verifiedBaseUrl: null, health: "unknown" })],
    ["disabled", server("server-1", { enabled: false })]
  ])("rejects a %s server", async (_name, upstreamServer) => {
    const { service } = await setup([upstreamServer])
    await expect(Effect.runPromise(Effect.gen(function*() {
      const libraries = yield* LibraryService
      return yield* libraries.create({
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        sources: [{ serverId: "server-1" as any, sourceLibraryId: "movies" as any, enabled: true }]
      })
    }).pipe(Effect.provide(service)))).rejects.toMatchObject({ _tag: "LibraryValidationFailed" })
  })

  it("rejects a library save when a server changes during discovery", async () => {
    const { service } = await setup([server("server-1")], (serverId) => Effect.sync(() => {
      const database = new Database(filename)
      database.run(`
        UPDATE upstream_servers
        SET generation = generation + 1, enabled = 0, health = 'unknown', access_token = NULL
        WHERE id = ?
      `, [serverId])
      database.close()
      return discovered.map((item) => ({ ...item, serverId: serverId as any }))
    }))
    await expect(Effect.runPromise(Effect.gen(function*() {
      const libraries = yield* LibraryService
      return yield* libraries.create({
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        sources: [{ serverId: "server-1" as any, sourceLibraryId: "movies" as any, enabled: true }]
      })
    }).pipe(Effect.provide(service)))).rejects.toMatchObject({ _tag: "LibraryValidationFailed" })
    const database = new Database(filename)
    expect(database.query("SELECT count(*) AS count FROM virtual_libraries").get()).toEqual({ count: 0 })
    database.close()
  })
})
