import { Effect, type Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type {
  CanonicalFixture,
  StateWrite,
  UserStateRecord
} from "../src/core/model.js"
import { Repositories } from "../src/core/repositories.js"

export interface RepositoryHarness {
  readonly layer: Layer.Layer<Repositories>
  readonly seedCanonicalWithEligibleSources: (fixture: CanonicalFixture) => Promise<void>
  readonly failNext: (operation: "state_outbox_insert") => Promise<void>
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
  iterations: 310_000
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
  played: true,
  favorite: false,
  playCount: 2,
  positionTicks: 123_456,
  lastPlayedVersionId: null,
  updatedAtMs: 2_000
}

const server = (id: string, sourceOrder = 0) => ({
  id,
  catalogNamespace: `catalog:${id}`,
  verifiedCatalogId: `verified:${id}`,
  verifiedBaseUrl: `https://${id}.example.com`,
  generation: 1,
  name: id,
  baseUrl: `https://${id}.example.com`,
  username: "upstream-user",
  password: "upstream-password",
  accessToken: null,
  accessTokenExpiresAtMs: null,
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

    it("invalidates every state-dependent query generation after a state write", async () => {
      await harness.seedCanonicalWithEligibleSources(canonicalFixture)
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.appendQueryGenerationItems({
          generation: {
            id: "generation-1",
            queryKey: "favorites",
            revision: 0,
            userKey: "owner",
            deviceId: "device-1",
            virtualLibraryId: "library-1",
            normalizedQuery: { IsFavorite: true },
            sourceState: {},
            allSourcesExhausted: true,
            stateDependent: true,
            createdAtMs: 1_000,
            expiresAtMs: 10_000
          },
          items: [],
          expected: null
        })
        yield* repo.writeUserStateAndTargets(stateFixture)
        expect(yield* repo.readQueryGeneration("favorites")).toBeNull()
      }).pipe(Effect.provide(harness.layer)))
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
          leaseOwner: "worker-1",
          leaseMs: 60_000,
          limit: 50
        })
        const second = yield* repo.claimOutboxTargets({
          nowMs: 3_001,
          leaseOwner: "worker-2",
          leaseMs: 60_000,
          limit: 50
        })

        expect(first).toHaveLength(1)
        expect(first[0]?.leaseOwner).toBe("worker-1")
        expect(first[0]?.leaseExpiresAtMs).toBe(63_000)
        expect(second).toEqual([])
      }).pipe(Effect.provide(harness.layer)))
    })

    it("stops claiming an uncertain target after its guarded retry is acknowledged", async () => {
      await harness.seedCanonicalWithEligibleSources(canonicalFixture)
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.writeUserStateAndTargets(stateFixture)
        const [first] = yield* repo.claimOutboxTargets({
          nowMs: 3_000,
          leaseOwner: "worker-1",
          leaseMs: 60_000,
          limit: 50
        })
        expect(first).toBeDefined()
        yield* repo.markOutboxUncertain({
          targetId: first!.targetId,
          leaseOwner: first!.leaseOwner,
          uncertainAtMs: 3_500
        })
        const [retry] = yield* repo.claimOutboxTargets({
          nowMs: 4_000,
          leaseOwner: "worker-2",
          leaseMs: 60_000,
          limit: 50
        })
        expect(retry).toBeDefined()
        expect(yield* repo.acknowledgeOutboxTarget({
          targetId: retry!.targetId,
          desiredRevision: retry!.desiredRevision,
          leaseOwner: retry!.leaseOwner,
          acknowledgedAtMs: 4_500
        })).toBe(true)
        expect(yield* repo.claimOutboxTargets({
          nowMs: 5_000,
          leaseOwner: "worker-3",
          leaseMs: 60_000,
          limit: 50
        })).toEqual([])
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
          leaseOwner: "worker-1",
          leaseMs: 60_000,
          limit: 50
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
        expect(user?.password.iterations).toBe(310_000)
      }).pipe(Effect.provide(harness.layer)))
    })
  })
}
