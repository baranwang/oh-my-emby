import { Effect, type Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type {
  CanonicalFixture,
  ExternalMetadataCacheEntry,
  MetadataProviderSetting,
  StateWrite,
  UpstreamServer,
  UserStateRecord
} from "../src/core/model.js"
import { Repositories } from "../src/core/repositories.js"

export interface RepositoryHarness {
  readonly layer: Layer.Layer<Repositories>
  readonly seedCanonicalWithEligibleSources: (fixture: CanonicalFixture) => Promise<void>
  readonly failNext: (
    operation: "state_outbox_insert" | "server_endpoint_insert" | "metadata_setting_write"
  ) => Promise<void>
  readonly getUserState: (canonicalId: string) => Promise<UserStateRecord | null>
  readonly readStorageRow: (
    table: "upstream_servers" | "user_state",
    id: string
  ) => Promise<Record<string, unknown> | null>
  readonly replaceOutboxPayload: (payloadJson: string) => Promise<void>
  readonly dispose: () => Promise<void>
}

export const passwordRecord = {
  hash: new Uint8Array([1, 2, 3]),
  salt: new Uint8Array([4, 5, 6]),
  iterations: PBKDF2_ITERATIONS
}

export const canonicalFixture: CanonicalFixture = {
  id: "canonical-1",
  itemType: "Movie",
  identityState: "exact",
  displayMetadata: { Name: "A Movie" },
  createdAtMs: 1_000,
  updatedAtMs: 1_000
}

export const stateFixture: StateWrite = {
  canonicalId: canonicalFixture.id,
  patch: {
    played: true,
    favorite: false,
    playCount: 2,
    positionTicks: 123_456,
    lastPlayedVersionId: null
  },
  updatedAtMs: 2_000
}

const endpoint = (
  id: string,
  protocol: "http" | "https",
  host: string,
  port: number | null,
  path: string,
  order: number,
  verifiedCatalogId = `verified:${id}`
) => ({
  id,
  protocol,
  host,
  port,
  path,
  displayUrl: `${protocol}://${host}${port === null ? "" : `:${port}`}${path || "/"}`,
  verifiedCatalogId,
  health: "healthy" as const,
  lastSuccessAtMs: 1_234,
  order,
  createdAtMs: 1_000,
  updatedAtMs: 2_000
})

const server = (id: string, sourceOrder = 0): UpstreamServer => ({
  id,
  catalogNamespace: `catalog:${id}`,
  verifiedCatalogId: `verified:${id}`,
  verifiedBaseUrl: `https://${id}.example.com`,
  generation: 1,
  name: id,
  endpoints: [endpoint(`${id}:endpoint`, "https", `${id}.example.com`, null, "", 0, `verified:${id}`)],
  username: "upstream-user",
  password: "upstream-password",
  accessToken: null,
  accessTokenExpiresAtMs: null,
  upstreamUserId: `upstream-user:${id}`,
  userAgentPolicy: "fixed",
  userAgent: "oh-my-emby-test",
  enabled: true,
  health: "healthy" as const,
  lastSuccessAtMs: 1_234,
  deletedAtMs: null,
  createdAtMs: 1_000 + sourceOrder,
  updatedAtMs: 2_000 + sourceOrder
})

export const repositoryContract = (makeHarness: () => Promise<RepositoryHarness>) => {
  describe("repository contract", () => {
    let harness: RepositoryHarness

    beforeEach(async () => {
      harness = await makeHarness()
    })

    afterEach(async () => {
      await harness.dispose()
    })

    it("claims the singleton user exactly once", async () => {
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        const first = yield* repo.claimUser({ username: "owner", password: passwordRecord })
        const second = yield* Effect.flip(repo.claimUser({ username: "other", password: passwordRecord }))
        expect(first.username).toBe("owner")
        expect(second._tag).toBe("AlreadyInitialized")
      }).pipe(Effect.provide(harness.layer)))
    })

    it("issues Emby tokens with last-used time and the current auth generation", async () => {
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.claimUser({ username: "owner", password: passwordRecord, nowMs: 1_000 })
        const token = yield* repo.issueEmbyToken({
          id: "token-1",
          tokenHash: new Uint8Array([7, 8, 9]),
          expectedAuthGeneration: 1,
          deviceId: "device-1",
          deviceName: "SenPlayer",
          createdAtMs: 2_000,
          lastUsedAtMs: 2_500,
          expiresAtMs: 3_000
        })
        expect(token.lastUsedAtMs).toBe(2_500)
        expect(token.authGeneration).toBe(1)
      }).pipe(Effect.provide(harness.layer)))
    })

    it("enforces foreign keys on the repository connection", async () => {
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        const error = yield* Effect.flip(repo.persistIdentityResult({
          canonical: canonicalFixture,
          aliases: [],
          claims: [],
          sourceItem: {
            id: "orphan-source-item",
            serverId: "missing-server",
            catalogNamespace: "missing-catalog",
            serverGeneration: 1,
            sourceLibraryId: "missing-library",
            upstreamItemId: "upstream-item",
            itemType: "Movie",
            canonicalId: canonicalFixture.id,
            quarantineReason: null,
            createdAtMs: 1_000,
            updatedAtMs: 1_000
          },
          mediaVersions: []
        }))
        expect(error._tag).toBe("RepositoryError")
      }).pipe(Effect.provide(harness.layer)))
    })

    it("returns eligible sources in configured order", async () => {
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.saveServer(server("server-b", 1))
        yield* repo.saveServer(server("server-a", 2))
        yield* repo.saveVirtualLibrary({
          id: "library-1",
          name: "Movies",
          mediaType: "movies",
          enabled: true,
          createdAtMs: 3_000,
          updatedAtMs: 3_000,
          sources: [
            {
              serverId: "server-b",
              sourceLibraryId: "movies-b",
              sourceLibraryName: "B Movies",
              mediaType: "movies",
              sourceOrder: 1,
              enabled: true
            },
            {
              serverId: "server-a",
              sourceLibraryId: "movies-a",
              sourceLibraryName: "A Movies",
              mediaType: "movies",
              sourceOrder: 0,
              enabled: true
            }
          ]
        }, [
          { serverId: "server-b", generation: 1 },
          { serverId: "server-a", generation: 1 }
        ])

        const sources = yield* repo.resolveEligibleSources("library-1")
        expect(sources.map((source) => source.serverId)).toEqual(["server-a", "server-b"])
        expect(sources.map((source) => source.endpoints.map(({ id }) => id))).toEqual([
          ["server-a:endpoint"],
          ["server-b:endpoint"]
        ])
      }).pipe(Effect.provide(harness.layer)))
    })

    it("creates, reads, reorders, and deletes server endpoints atomically", async () => {
      const initial = {
        ...server("server-endpoints"),
        endpoints: [
          endpoint("endpoint-public", "https", "emby.example.com", 8443, "/emby", 0),
          endpoint("endpoint-lan", "http", "192.168.1.10", 8096, "", 1)
        ]
      }

      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        expect(yield* repo.createServer(initial, 10)).not.toBeNull()
        const created = yield* repo.getServer(initial.id)
        expect(created?.endpoints.map(({ protocol, host, port, path }) => ({ protocol, host, port, path }))).toEqual([
          { protocol: "https", host: "emby.example.com", port: 8443, path: "/emby" },
          { protocol: "http", host: "192.168.1.10", port: 8096, path: "" }
        ])

        const reordered = yield* repo.saveServerConfiguration({
          ...initial,
          generation: 2,
          name: "reordered",
          endpoints: [
            { ...initial.endpoints[1]!, order: 0 },
            { ...initial.endpoints[0]!, order: 1 }
          ]
        }, 1)
        expect(reordered?.endpoints.map(({ id }) => id)).toEqual(["endpoint-lan", "endpoint-public"])

        const reduced = yield* repo.saveServerConfiguration({
          ...reordered!,
          generation: 3,
          endpoints: [{ ...reordered!.endpoints[0]!, order: 0 }]
        }, 2)
        expect(reduced?.name).toBe("reordered")
        expect(reduced?.endpoints.map(({ id }) => id)).toEqual(["endpoint-lan"])
      }).pipe(Effect.provide(harness.layer)))
    })

    it("rolls back server configuration when endpoint replacement fails", async () => {
      const original = server("server-endpoint-rollback")
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.saveServer(original)
      }).pipe(Effect.provide(harness.layer)))
      await harness.failNext("server_endpoint_insert")

      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* Effect.flip(repo.saveServerConfiguration({
          ...original,
          generation: 2,
          name: "must roll back",
          endpoints: [endpoint("endpoint-trigger-failure", "https", "failed.example.com", null, "", 0)]
        }, 1))
        const persisted = yield* repo.getServer(original.id)
        expect(persisted?.name).toBe(original.name)
        expect(persisted?.generation).toBe(1)
        expect(persisted?.endpoints.map(({ id }) => id)).toEqual([`${original.id}:endpoint`])
      }).pipe(Effect.provide(harness.layer)))
    })

    it("rejects a replayed server configuration without replacing endpoints", async () => {
      const original = server("server-endpoint-replay")
      const accepted = {
        ...original,
        generation: 2,
        updatedAtMs: 3_000,
        endpoints: [endpoint("endpoint-accepted", "https", "accepted.example.com", null, "", 0)]
      }

      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.saveServer(original)
        expect(yield* repo.saveServerConfiguration(accepted, 1)).not.toBeNull()

        const replayed = yield* repo.saveServerConfiguration({
          ...accepted,
          endpoints: [endpoint("endpoint-replayed", "https", "replayed.example.com", null, "", 0)]
        }, 1)
        expect(replayed).toBeNull()

        const persisted = yield* repo.getServer(original.id)
        expect(persisted?.endpoints.map(({ id }) => id)).toEqual(["endpoint-accepted"])
      }).pipe(Effect.provide(harness.layer)))
    })

    it("seeds and atomically round-trips the two metadata provider settings", async () => {
      const configured: readonly [MetadataProviderSetting, MetadataProviderSetting] = [
        {
          id: "trakt",
          enabled: true,
          order: 0,
          language: null,
          credential: "trakt-client-id",
          status: "ready",
          updatedAtMs: 2_000
        },
        {
          id: "tmdb",
          enabled: true,
          order: 1,
          language: "zh-CN",
          credential: "tmdb-token",
          status: "ready",
          updatedAtMs: 2_000
        }
      ]

      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        expect(yield* repo.readMetadataSettings()).toEqual([
          { id: "tmdb", enabled: false, order: 0, language: null, credential: null, status: "unconfigured", updatedAtMs: 0 },
          { id: "trakt", enabled: false, order: 1, language: null, credential: null, status: "unconfigured", updatedAtMs: 0 }
        ])
        expect(yield* repo.writeMetadataSettings(configured)).toEqual(configured)
        expect(yield* repo.readMetadataSettings()).toEqual(configured)
      }).pipe(Effect.provide(harness.layer)))
      expect(await harness.readStorageRow("upstream_servers", "tmdb")).toBeNull()

      await harness.failNext("metadata_setting_write")
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* Effect.flip(repo.writeMetadataSettings([
          { ...configured[0], enabled: false, updatedAtMs: 3_000 },
          { ...configured[1], enabled: false, updatedAtMs: 3_000 }
        ]))
        expect(yield* repo.readMetadataSettings()).toEqual(configured)
      }).pipe(Effect.provide(harness.layer)))
    })

    it("updates one provider status only while its settings revision still matches", async () => {
      const configured: readonly [MetadataProviderSetting, MetadataProviderSetting] = [
        {
          id: "trakt",
          enabled: true,
          order: 0,
          language: null,
          credential: "trakt-client-id",
          status: "ready",
          updatedAtMs: 2_000
        },
        {
          id: "tmdb",
          enabled: true,
          order: 1,
          language: "zh-CN",
          credential: "tmdb-token",
          status: "ready",
          updatedAtMs: 2_000
        }
      ]

      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.writeMetadataSettings(configured)
        expect(yield* repo.updateMetadataProviderStatus({
          providerId: "tmdb",
          expectedUpdatedAtMs: 2_000,
          status: "degraded"
        })).toBe(true)

        yield* repo.writeMetadataSettings([
          configured[0],
          {
            ...configured[1],
            credential: "rotated-token",
            status: "ready",
            updatedAtMs: 3_000
          }
        ])
        expect(yield* repo.updateMetadataProviderStatus({
          providerId: "tmdb",
          expectedUpdatedAtMs: 2_000,
          status: "degraded"
        })).toBe(false)
        expect(yield* repo.readMetadataSettings()).toEqual([
          configured[0],
          {
            ...configured[1],
            credential: "rotated-token",
            status: "ready",
            updatedAtMs: 3_000
          }
        ])
      }).pipe(Effect.provide(harness.layer)))
    })

    it("round-trips positive and negative external metadata cache entries", async () => {
      const positive: ExternalMetadataCacheEntry = {
        providerId: "tmdb",
        identityNamespace: "tmdb:movie",
        identityValue: "42",
        payload: { title: "The Answer" },
        found: true,
        fetchedAtMs: 1_000,
        freshUntilMs: 2_000,
        staleUntilMs: 3_000
      }
      const negative: ExternalMetadataCacheEntry = {
        providerId: "trakt",
        identityNamespace: "imdb:title",
        identityValue: "tt0000001",
        payload: null,
        found: false,
        fetchedAtMs: 1_100,
        freshUntilMs: 2_100,
        staleUntilMs: 3_100
      }

      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.writeExternalMetadata(positive)
        yield* repo.writeExternalMetadata(negative)
        expect(yield* repo.readExternalMetadata("tmdb", "tmdb:movie", "42")).toEqual(positive)
        expect(yield* repo.readExternalMetadata("trakt", "imdb:title", "tt0000001")).toEqual(negative)
      }).pipe(Effect.provide(harness.layer)))
    })

    it("rolls back state when atomic outbox creation fails", async () => {
      await harness.seedCanonicalWithEligibleSources(canonicalFixture)
      await harness.failNext("state_outbox_insert")
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* Effect.flip(repo.writeUserStateAndTargets(stateFixture))
      }).pipe(Effect.provide(harness.layer)))
      expect(await harness.getUserState(canonicalFixture.id)).toBeNull()
    })

    it("encodes booleans as integers and preserves epoch milliseconds", async () => {
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.saveServer(server("server-storage"))
      }).pipe(Effect.provide(harness.layer)))

      const row = await harness.readStorageRow("upstream_servers", "server-storage")
      expect(row?.enabled).toBe(1)
      expect(row?.created_at_ms).toBe(1_000)
      expect(row?.updated_at_ms).toBe(2_000)
    })

    it("leases due outbox targets once until the lease expires", async () => {
      await harness.seedCanonicalWithEligibleSources(canonicalFixture)
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.writeUserStateAndTargets(stateFixture)
        const first = yield* repo.claimOutboxTargets({
          nowMs: 3_000,
          leaseOwner: "worker-1"
        })
        const second = yield* repo.claimOutboxTargets({
          nowMs: 3_001,
          leaseOwner: "worker-2"
        })

        expect(first).toHaveLength(1)
        expect(first[0]?.leaseOwner).toBe("worker-1")
        expect(first[0]?.leaseExpiresAtMs).toBe(63_000)
        expect(second).toEqual([])
      }).pipe(Effect.provide(harness.layer)))
    })

    it("keeps an acknowledged uncertain target due for periodic reconciliation", async () => {
      await harness.seedCanonicalWithEligibleSources(canonicalFixture)
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.writeUserStateAndTargets(stateFixture)
        const [first] = yield* repo.claimOutboxTargets({
          nowMs: 3_000,
          leaseOwner: "worker-1"
        })
        expect(first).toBeDefined()
        yield* repo.markOutboxUncertain({
          targetId: first!.targetId,
          desiredRevision: first!.desiredRevision,
          code: "timeout_after_dispatch",
          uncertainAtMs: 3_500,
          nextAttemptAtMs: 4_000
        })
        yield* repo.recordOutboxFailure({
          targetId: first!.targetId,
          desiredRevision: first!.desiredRevision,
          serverGeneration: first!.serverGeneration,
          leaseOwner: first!.leaseOwner,
          code: "timeout_after_dispatch",
          failedAtMs: 3_500,
          nextAttemptAtMs: 4_000,
          permanent: false
        })
        const [retry] = yield* repo.claimOutboxTargets({
          nowMs: 4_000,
          leaseOwner: "worker-2"
        })
        expect(retry).toBeDefined()
        expect(yield* repo.acknowledgeOutboxTarget({
          targetId: retry!.targetId,
          desiredRevision: retry!.desiredRevision,
          serverGeneration: retry!.serverGeneration,
          leaseOwner: retry!.leaseOwner,
          acknowledgedAtMs: 4_500
        })).toBe(true)
        expect(yield* repo.claimOutboxTargets({
          nowMs: 5_000,
          leaseOwner: "worker-3"
        })).toEqual([])
        expect(yield* repo.claimOutboxTargets({
          nowMs: 4_500 + 15 * 60_000,
          leaseOwner: "worker-3"
        })).toHaveLength(1)
      }).pipe(Effect.provide(harness.layer)))
    })

    it("rejects malformed persisted outbox payloads", async () => {
      await harness.seedCanonicalWithEligibleSources(canonicalFixture)
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.writeUserStateAndTargets(stateFixture)
      }).pipe(Effect.provide(harness.layer)))
      await harness.replaceOutboxPayload(JSON.stringify({ played: "yes" }))

      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        const error = yield* Effect.flip(repo.claimOutboxTargets({
          nowMs: 3_000,
          leaseOwner: "worker-1"
        }))
        expect(error._tag).toBe("RepositoryError")
      }).pipe(Effect.provide(harness.layer)))
    })

    it("persists data after the SQLite layer closes and reopens", async () => {
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.claimUser({ username: "owner", password: passwordRecord })
      }).pipe(Effect.provide(harness.layer)))

      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        const user = yield* repo.getUserByName("owner")
        expect(user?.username).toBe("owner")
        expect(user?.password.iterations).toBe(PBKDF2_ITERATIONS)
      }).pipe(Effect.provide(harness.layer)))
    })
  })
}
