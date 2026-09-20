import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PreparedIdentityCandidate } from "../src/core/identity.js"
import { Repositories, type RepositoriesService } from "../src/core/repositories.js"
import { makeD1RepositoriesLayer } from "../src/platform/workers/d1-repositories.js"
import {
  canonicalFixture,
  passwordRecord,
  repositoryContract,
  type RepositoryHarness
} from "./repository-contract.js"

const tables = [
  "playback_watermarks",
  "playback_sessions",
  "state_outbox",
  "query_generation_items",
  "query_generations",
  "source_metadata_cache",
  "user_state",
  "source_media_versions",
  "identity_claims",
  "canonical_aliases",
  "source_items",
  "canonical_items",
  "library_sources",
  "virtual_libraries",
  "dashboard_sessions",
  "emby_tokens",
  "auth_rate_limits",
  "upstream_servers",
  "users",
  "maintenance_status"
] as const

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run()

const makeHarness = async (): Promise<RepositoryHarness> => ({
  layer: makeD1RepositoriesLayer(env.DB),
  seedCanonicalWithEligibleSources: async (fixture) => {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO upstream_servers (
          id, catalog_namespace, verified_catalog_id, verified_base_url, generation,
          name, base_url, username, password, access_token, access_token_expires_at_ms,
          upstream_user_id, user_agent, enabled, health, last_success_at_ms,
          deleted_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, ?, 'user', 'password', NULL, NULL, ?, 'test', 1, 'healthy', 1000, NULL, 1000, 1000)
      `).bind("server-1", "catalog:server-1", "verified:server-1", "https://server-1.example.com", "Server", "https://server-1.example.com", "upstream-user:server-1"),
      env.DB.prepare(`
        INSERT INTO virtual_libraries (id, name, media_type, enabled, created_at_ms, updated_at_ms)
        VALUES ('library-1', 'Movies', 'movies', 1, 1000, 1000)
      `),
      env.DB.prepare(`
        INSERT INTO library_sources (
          virtual_library_id, server_id, source_library_id, source_library_name,
          media_type, source_order, enabled
        ) VALUES ('library-1', 'server-1', 'movies', 'Movies', 'movies', 0, 1)
      `),
      env.DB.prepare(`
        INSERT INTO canonical_items (
          id, item_type, identity_state, display_metadata_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(fixture.id, fixture.itemType, fixture.identityState, JSON.stringify(fixture.displayMetadata), fixture.createdAtMs, fixture.updatedAtMs),
      env.DB.prepare(`
        INSERT INTO source_items (
          id, server_id, catalog_namespace, server_generation, source_library_id,
          upstream_item_id, item_type, canonical_id, quarantine_reason, created_at_ms, updated_at_ms
        ) VALUES (?, 'server-1', 'catalog:server-1', 1, 'movies', 'item-1', ?, ?, NULL, 1000, 1000)
      `).bind(`${fixture.id}:source`, fixture.itemType, fixture.id)
    ])
  },
  failNext: async (operation) => {
    if (operation !== "state_outbox_insert") throw new Error(`unsupported operation: ${operation}`)
    await run(`
      CREATE TRIGGER fail_state_outbox_insert
      BEFORE INSERT ON state_outbox
      BEGIN SELECT RAISE(ABORT, 'injected state_outbox_insert failure'); END
    `)
  },
  getUserState: async (canonicalId) => {
    const row = await env.DB.prepare("SELECT * FROM user_state WHERE canonical_id = ?").bind(canonicalId).first<Record<string, unknown>>()
    if (row === null) return null
    return {
      canonicalId,
      revision: Number(row.revision),
      played: row.played === 1,
      favorite: row.favorite === 1,
      playCount: Number(row.play_count),
      positionTicks: Number(row.position_ticks),
      lastPlayedVersionId: row.last_played_version_id === null ? null : String(row.last_played_version_id),
      updatedAtMs: Number(row.updated_at_ms)
    }
  },
  readStorageRow: (table, id) => env.DB.prepare(`SELECT * FROM ${table} WHERE ${table === "user_state" ? "canonical_id" : "id"} = ?`).bind(id).first<Record<string, unknown>>(),
  replaceOutboxPayload: async (payloadJson) => {
    await run("UPDATE state_outbox SET payload_json = ?", payloadJson)
  },
  dispose: async () => {
    await env.DB.prepare("DROP TRIGGER IF EXISTS fail_state_outbox_insert").run()
    await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  }
})

repositoryContract(makeHarness)

const useRepositories = <A>(
  harness: RepositoryHarness,
  run: (repositories: RepositoriesService) => Effect.Effect<A, unknown>
) => Effect.runPromise(Effect.gen(function*() {
  return yield* run(yield* Repositories)
}).pipe(Effect.provide(harness.layer)))

describe("D1 parity regressions", () => {
  const server = (id: string) => ({
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
    upstreamUserId: `upstream-user:${id}`,
    userAgent: "oh-my-emby-test",
    enabled: true,
    health: "healthy" as const,
    lastSuccessAtMs: 1_000,
    deletedAtMs: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000
  })

  const identityCandidate = (
    serverId: string,
    upstreamItemId: string,
    claims: PreparedIdentityCandidate["claims"],
    overrides: Partial<PreparedIdentityCandidate> = {}
  ): PreparedIdentityCandidate => ({
    serverId,
    catalogNamespace: `catalog:${serverId}`,
    verifiedCatalogId: `verified:${serverId}`,
    serverGeneration: 1,
    sourceLibraryId: "movies",
    upstreamItemId,
    itemType: "Movie",
    displayMetadata: { Name: upstreamItemId },
    claims,
    fallback: null,
    sourceItemId: `source-${upstreamItemId}`,
    sourceExclusiveCanonicalId: `exclusive-${upstreamItemId}`,
    proposedCanonicalId: `proposed-${upstreamItemId}`,
    sourceExclusiveReason: null,
    mediaVersions: [],
    observedAtMs: 1_000,
    ...overrides
  })

  it("rolls back the complete identity cluster when a batched write fails", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    await run(`
      CREATE TRIGGER fail_identity_source
      BEFORE INSERT ON source_items
      WHEN NEW.id = 'source-new'
      BEGIN SELECT RAISE(ABORT, 'injected identity failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.resolveIdentity({
        serverId: "server-1",
        catalogNamespace: "catalog:server-1",
        verifiedCatalogId: "verified:server-1",
        serverGeneration: 1,
        sourceLibraryId: "movies",
        upstreamItemId: "new-item",
        itemType: "Movie",
        displayMetadata: { Name: "New Movie" },
        claims: [{ namespace: "tmdb:movie", value: "100" }],
        fallback: null,
        sourceItemId: "source-new",
        sourceExclusiveCanonicalId: "canonical-exclusive",
        proposedCanonicalId: "canonical-new",
        sourceExclusiveReason: null,
        mediaVersions: [],
        observedAtMs: 2_000
      }))).rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare("SELECT id FROM canonical_items WHERE id = 'canonical-new'").first()).toBeNull()
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_identity_source")
      await harness.dispose()
    }
  })

  it("merges every compatible identity cluster into the oldest canonical", async () => {
    const harness = await makeHarness()
    try {
      await useRepositories(harness, (repositories) => Effect.gen(function*() {
        yield* repositories.saveServer(server("merge-a"))
        yield* repositories.saveServer(server("merge-b"))
        yield* repositories.saveServer(server("merge-c"))

        const oldest = yield* repositories.resolveIdentity(identityCandidate(
          "merge-a",
          "oldest",
          [{ namespace: "tmdb:movie", value: "10" }],
          { proposedCanonicalId: "canonical-oldest", observedAtMs: 1_000 }
        ))
        const newest = yield* repositories.resolveIdentity(identityCandidate(
          "merge-b",
          "newest",
          [{ namespace: "imdb:title", value: "tt1" }],
          { proposedCanonicalId: "canonical-newest", observedAtMs: 2_000 }
        ))
        const merged = yield* repositories.resolveIdentity(identityCandidate(
          "merge-c",
          "bridge",
          [
            { namespace: "imdb:title", value: "tt1" },
            { namespace: "tmdb:movie", value: "10" }
          ],
          { proposedCanonicalId: "canonical-bridge", observedAtMs: 3_000 }
        ))

        expect(merged.canonical.id).toBe(oldest.canonical.id)
        expect(yield* repositories.lookupCanonicalId(newest.canonical.id)).toBe(oldest.canonical.id)
      }))
      expect(await env.DB.prepare(`
        SELECT id, canonical_id FROM source_items ORDER BY id
      `).all()).toMatchObject({
        results: [
          { id: "source-bridge", canonical_id: "canonical-oldest" },
          { id: "source-newest", canonical_id: "canonical-oldest" },
          { id: "source-oldest", canonical_id: "canonical-oldest" }
        ]
      })
      expect(await env.DB.prepare(
        "SELECT id FROM canonical_items WHERE id = 'canonical-newest'"
      ).first()).toBeNull()
    } finally {
      await harness.dispose()
    }
  })

  it("rolls back identity writes when the final server-generation fence changes", async () => {
    const harness = await makeHarness()
    await useRepositories(harness, (repositories) => repositories.saveServer(server("fenced-server")))
    let intercepted = false
    const fencedDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: Parameters<D1Database["batch"]>[0]) => {
            if (!intercepted) {
              intercepted = true
              await target.prepare(`
                UPDATE upstream_servers SET generation = generation + 1 WHERE id = 'fenced-server'
              `).run()
            }
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      }
    })
    try {
      await expect(useRepositories({ ...harness, layer: makeD1RepositoriesLayer(fencedDb) }, (repositories) => repositories.resolveIdentity(identityCandidate(
        "fenced-server",
        "fenced-item",
        [{ namespace: "tmdb:movie", value: "99" }],
        { proposedCanonicalId: "canonical-fenced" }
      )))).rejects.toMatchObject({ _tag: "IdentityConflict" })
      expect(await env.DB.prepare(
        "SELECT id FROM source_items WHERE id = 'source-fenced-item'"
      ).first()).toBeNull()
      expect(await env.DB.prepare(
        "SELECT generation FROM upstream_servers WHERE id = 'fenced-server'"
      ).first()).toEqual({ generation: 2 })
    } finally {
      await harness.dispose()
    }
  })

  it("rolls back an immutable query-generation append when an item insert fails", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    await run(`
      CREATE TRIGGER fail_query_item
      BEFORE INSERT ON query_generation_items
      BEGIN SELECT RAISE(ABORT, 'injected query item failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.appendQueryGenerationItems({
        expected: null,
        generation: {
          id: "generation-1",
          queryKey: "query-1",
          revision: 0,
          userKey: "owner",
          deviceId: "device-1",
          virtualLibraryId: "library-1",
          normalizedQuery: { sort: "Name" },
          sourceState: {},
          allSourcesExhausted: false,
          stateDependent: true,
          createdAtMs: 2_000,
          expiresAtMs: 5_000
        },
        items: [{ ordinal: 0, canonicalId: canonicalFixture.id, sortValues: ["A"] }]
      }))).rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare("SELECT id FROM query_generations WHERE id = 'generation-1'").first()).toBeNull()
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_query_item")
      await harness.dispose()
    }
  })

  it("returns false for stale query revisions without mutating immutable appends", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    await run(`
      INSERT INTO canonical_items (
        id, item_type, identity_state, display_metadata_json, created_at_ms, updated_at_ms
      ) VALUES
        ('canonical-2', 'Movie', 'exact', '{"Name":"Second"}', 1000, 1000),
        ('canonical-3', 'Movie', 'exact', '{"Name":"Third"}', 1000, 1000)
    `)
    const generation = {
      id: "generation-cas",
      queryKey: "query-cas",
      revision: 0,
      userKey: "owner",
      deviceId: "device-1",
      virtualLibraryId: "library-1",
      normalizedQuery: { sort: "Name" },
      sourceState: { page: 1 },
      allSourcesExhausted: false,
      stateDependent: false,
      createdAtMs: 2_000,
      expiresAtMs: 10_000
    } as const
    try {
      await useRepositories(harness, (repositories) => Effect.gen(function*() {
        expect(yield* repositories.appendQueryGenerationItems({
          expected: null,
          generation,
          items: [{ ordinal: 0, canonicalId: canonicalFixture.id, sortValues: ["A"] }]
        })).toBe(true)
        expect(yield* repositories.appendQueryGenerationItems({
          expected: { id: generation.id, revision: 0 },
          generation: { ...generation, revision: 1, sourceState: { page: 2 } },
          items: [
            { ordinal: 99, canonicalId: canonicalFixture.id, sortValues: ["changed"] },
            { ordinal: 1, canonicalId: "canonical-2", sortValues: ["B"] }
          ]
        })).toBe(true)
        expect(yield* repositories.appendQueryGenerationItems({
          expected: { id: generation.id, revision: 0 },
          generation: { ...generation, revision: 1, sourceState: { page: 999 } },
          items: [{ ordinal: 2, canonicalId: "canonical-3", sortValues: ["C"] }]
        })).toBe(false)

        expect(yield* repositories.readQueryGeneration(generation.queryKey)).toMatchObject({
          revision: 1,
          sourceState: { page: 2 }
        })
        expect(yield* repositories.readQueryGenerationItems(generation.id)).toEqual([
          { ordinal: 0, canonicalId: canonicalFixture.id, sortValues: ["A"] },
          { ordinal: 1, canonicalId: "canonical-2", sortValues: ["B"] }
        ])
      }))
    } finally {
      await harness.dispose()
    }
  })

  it("rolls back playback state and outbox when the session write fails", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    await run(`
      CREATE TRIGGER fail_playback_session
      BEFORE INSERT ON playback_sessions
      BEGIN SELECT RAISE(ABORT, 'injected playback failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.recordPlaybackEventAndTargets({
        kind: "start",
        localSessionId: "session-1",
        canonicalId: canonicalFixture.id,
        versionId: "version-1",
        positionTicks: 0,
        occurredAtMs: 10_000
      }))).rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare("SELECT canonical_id FROM user_state").first()).toBeNull()
      expect(await env.DB.prepare("SELECT target_id FROM state_outbox").first()).toBeNull()
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_playback_session")
      await harness.dispose()
    }
  })

  it("enforces playback watermarks, stop idempotence, and stale-session rejection", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    try {
      await useRepositories(harness, (repositories) => Effect.gen(function*() {
        const first = yield* repositories.recordPlaybackEventAndTargets({
          kind: "start",
          localSessionId: "session-old",
          canonicalId: canonicalFixture.id,
          versionId: "version-old",
          positionTicks: 100,
          occurredAtMs: 10_000
        })
        expect(first).toMatchObject({ revision: 1, positionTicks: 100 })
        expect(yield* repositories.recordPlaybackEventAndTargets({
          kind: "start",
          localSessionId: "session-old",
          canonicalId: canonicalFixture.id,
          versionId: "version-old",
          positionTicks: 999,
          occurredAtMs: 10_001
        })).toBeNull()

        const latest = yield* repositories.recordPlaybackEventAndTargets({
          kind: "start",
          localSessionId: "session-new",
          canonicalId: canonicalFixture.id,
          versionId: "version-new",
          positionTicks: 200,
          occurredAtMs: 20_000
        })
        expect(latest).toMatchObject({ revision: 2, positionTicks: 200 })
        expect(yield* repositories.recordPlaybackEventAndTargets({
          kind: "progress",
          localSessionId: "session-old",
          canonicalId: canonicalFixture.id,
          versionId: "version-old",
          positionTicks: 300,
          occurredAtMs: 30_000
        })).toBeNull()
        expect(yield* repositories.recordPlaybackEventAndTargets({
          kind: "start",
          localSessionId: "session-stale",
          canonicalId: canonicalFixture.id,
          versionId: "version-stale",
          positionTicks: 400,
          occurredAtMs: 15_000
        })).toBeNull()

        const stopped = yield* repositories.recordPlaybackEventAndTargets({
          kind: "stop",
          localSessionId: "session-new",
          canonicalId: canonicalFixture.id,
          versionId: "version-new",
          positionTicks: 500,
          occurredAtMs: 40_000,
          played: true
        })
        expect(stopped).toMatchObject({ revision: 3, played: true, playCount: 1, positionTicks: 0 })
        expect(yield* repositories.recordPlaybackEventAndTargets({
          kind: "stop",
          localSessionId: "session-new",
          canonicalId: canonicalFixture.id,
          versionId: "version-new",
          positionTicks: 600,
          occurredAtMs: 50_000,
          played: true
        })).toBeNull()
      }))
      expect(await harness.getUserState(canonicalFixture.id)).toMatchObject({
        revision: 3,
        played: true,
        playCount: 1,
        positionTicks: 0,
        lastPlayedVersionId: "version-new"
      })
    } finally {
      await harness.dispose()
    }
  })

  it("rolls back password replacement and token revocation as one batch", async () => {
    const harness = await makeHarness()
    await useRepositories(harness, (repositories) => Effect.gen(function*() {
      yield* repositories.claimUser({ username: "owner", password: passwordRecord, nowMs: 1_000 })
      yield* repositories.issueDashboardSession({
        id: "session-1",
        tokenHash: new Uint8Array([10]),
        expectedAuthGeneration: 1,
        createdAtMs: 1_000,
        lastSeenAtMs: 1_000,
        expiresAtMs: 10_000
      })
      yield* repositories.issueEmbyToken({
        id: "token-1",
        tokenHash: new Uint8Array([11]),
        expectedAuthGeneration: 1,
        deviceId: "device-1",
        deviceName: "SenPlayer",
        createdAtMs: 1_000,
        lastUsedAtMs: 1_000,
        expiresAtMs: 10_000
      })
    }))
    await run(`
      CREATE TRIGGER fail_emby_token_revoke
      BEFORE DELETE ON emby_tokens
      BEGIN SELECT RAISE(ABORT, 'injected auth revocation failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.revokeAuthentication({
        password: {
          hash: new Uint8Array([20]),
          salt: new Uint8Array([21]),
          iterations: 310_000
        },
        expectedAuthGeneration: 1,
        updatedAtMs: 2_000
      }))).rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare("SELECT auth_generation FROM users WHERE singleton = 1").first()).toEqual({
        auth_generation: 1
      })
      expect(await env.DB.prepare("SELECT count(*) AS count FROM dashboard_sessions").first()).toEqual({ count: 1 })
      expect(await env.DB.prepare("SELECT count(*) AS count FROM emby_tokens").first()).toEqual({ count: 1 })
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_emby_token_revoke")
      await harness.dispose()
    }
  })

  it("rejects a same-millisecond authentication revocation CAS loser", async () => {
    const harness = await makeHarness()
    const replacements = [
      {
        password: {
          hash: new Uint8Array([20]),
          salt: new Uint8Array([21]),
          iterations: 310_000
        },
        expectedAuthGeneration: 1,
        updatedAtMs: 2_000
      },
      {
        password: {
          hash: new Uint8Array([30]),
          salt: new Uint8Array([31]),
          iterations: 320_000
        },
        expectedAuthGeneration: 1,
        updatedAtMs: 2_000
      }
    ] as const
    try {
      await useRepositories(harness, (repositories) => Effect.gen(function*() {
        yield* repositories.claimUser({ username: "owner", password: passwordRecord, nowMs: 1_000 })
        yield* repositories.issueDashboardSession({
          id: "session-1",
          tokenHash: new Uint8Array([10]),
          expectedAuthGeneration: 1,
          createdAtMs: 1_000,
          lastSeenAtMs: 1_000,
          expiresAtMs: 10_000
        })
        yield* repositories.issueEmbyToken({
          id: "token-1",
          tokenHash: new Uint8Array([11]),
          expectedAuthGeneration: 1,
          deviceId: "device-1",
          deviceName: "SenPlayer",
          createdAtMs: 1_000,
          lastUsedAtMs: 1_000,
          expiresAtMs: 10_000
        })
      }))

      const results = await Promise.allSettled(replacements.map((replacement) =>
        useRepositories(harness, (repositories) => repositories.revokeAuthentication(replacement))
      ))
      const winner = results.findIndex((result) => result.status === "fulfilled")
      const rejected = results.filter((result) => result.status === "rejected")

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]).toMatchObject({ reason: { _tag: "AuthenticationChanged" } })

      const row = await env.DB.prepare(`
        SELECT password_hash, password_salt, pbkdf2_iterations, auth_generation, updated_at_ms
        FROM users WHERE singleton = 1
      `).first<Record<string, unknown>>()
      expect(row).not.toBeNull()
      expect(Array.from(row!.password_hash as Uint8Array)).toEqual(Array.from(replacements[winner]!.password.hash))
      expect(Array.from(row!.password_salt as Uint8Array)).toEqual(Array.from(replacements[winner]!.password.salt))
      expect(row).toMatchObject({
        pbkdf2_iterations: replacements[winner]!.password.iterations,
        auth_generation: 2,
        updated_at_ms: 2_000
      })
      expect(await env.DB.prepare("SELECT count(*) AS count FROM dashboard_sessions").first()).toEqual({ count: 0 })
      expect(await env.DB.prepare("SELECT count(*) AS count FROM emby_tokens").first()).toEqual({ count: 0 })
    } finally {
      await harness.dispose()
    }
  })

  it("rolls back a virtual-library replacement when a source insert fails", async () => {
    const harness = await makeHarness()
    await useRepositories(harness, (repositories) => Effect.gen(function*() {
      yield* repositories.saveServer(server("library-server"))
      yield* repositories.saveVirtualLibrary({
        id: "library-rollback",
        name: "Original",
        mediaType: "movies",
        enabled: true,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        sources: [{
          serverId: "library-server",
          sourceLibraryId: "old-source",
          sourceLibraryName: "Old source",
          mediaType: "movies",
          sourceOrder: 0,
          enabled: true
        }]
      }, [{ serverId: "library-server", generation: 1 }])
    }))
    await run(`
      CREATE TRIGGER fail_library_source_replace
      BEFORE INSERT ON library_sources
      WHEN NEW.source_library_id = 'new-source'
      BEGIN SELECT RAISE(ABORT, 'injected library source failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.saveVirtualLibrary({
        id: "library-rollback",
        name: "Changed",
        mediaType: "movies",
        enabled: true,
        createdAtMs: 1_000,
        updatedAtMs: 2_000,
        sources: [{
          serverId: "library-server",
          sourceLibraryId: "new-source",
          sourceLibraryName: "New source",
          mediaType: "movies",
          sourceOrder: 0,
          enabled: true
        }]
      }, [{ serverId: "library-server", generation: 1 }]))).rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare("SELECT name FROM virtual_libraries WHERE id = 'library-rollback'").first()).toEqual({
        name: "Original"
      })
      expect(await env.DB.prepare("SELECT source_library_id FROM library_sources WHERE virtual_library_id = 'library-rollback'").first()).toEqual({
        source_library_id: "old-source"
      })
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_library_source_replace")
      await harness.dispose()
    }
  })

  it("rolls back compatibility identity persistence when the source write fails", async () => {
    const harness = await makeHarness()
    await useRepositories(harness, (repositories) => repositories.saveServer(server("persist-server")))
    await run(`
      CREATE TRIGGER fail_persisted_source
      BEFORE INSERT ON source_items
      WHEN NEW.id = 'persist-fail'
      BEGIN SELECT RAISE(ABORT, 'injected persisted source failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.persistIdentityResult({
        canonical: {
          id: "persist-canonical",
          itemType: "Movie",
          identityState: "source-exclusive",
          displayMetadata: { Name: "Persist me" },
          createdAtMs: 1_000,
          updatedAtMs: 1_000
        },
        aliases: [],
        claims: [],
        sourceItem: {
          id: "persist-fail",
          serverId: "persist-server",
          catalogNamespace: "catalog:persist-server",
          serverGeneration: 1,
          sourceLibraryId: "movies",
          upstreamItemId: "upstream-persist",
          itemType: "Movie",
          canonicalId: "persist-canonical",
          quarantineReason: null,
          createdAtMs: 1_000,
          updatedAtMs: 1_000
        },
        mediaVersions: []
      }))).rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare("SELECT id FROM canonical_items WHERE id = 'persist-canonical'").first()).toBeNull()
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_persisted_source")
      await harness.dispose()
    }
  })

  it("rolls back bounded maintenance when its final status write fails", async () => {
    const harness = await makeHarness()
    await useRepositories(harness, (repositories) => Effect.gen(function*() {
      yield* repositories.claimUser({ username: "owner", password: passwordRecord, nowMs: 1_000 })
      yield* repositories.issueDashboardSession({
        id: "expired-session",
        tokenHash: new Uint8Array([30]),
        expectedAuthGeneration: 1,
        createdAtMs: 1_000,
        lastSeenAtMs: 1_000,
        expiresAtMs: 1_500
      })
      yield* repositories.issueEmbyToken({
        id: "expired-token",
        tokenHash: new Uint8Array([31]),
        expectedAuthGeneration: 1,
        deviceId: "device-1",
        deviceName: "SenPlayer",
        createdAtMs: 1_000,
        lastUsedAtMs: 1_000,
        expiresAtMs: 1_500
      })
    }))
    await run(`
      CREATE TRIGGER fail_maintenance_status
      BEFORE INSERT ON maintenance_status
      BEGIN SELECT RAISE(ABORT, 'injected maintenance status failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.runMaintenanceBatch(2_000)))
        .rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare("SELECT id FROM dashboard_sessions WHERE id = 'expired-session'").first())
        .not.toBeNull()
      expect(await env.DB.prepare("SELECT id FROM emby_tokens WHERE id = 'expired-token'").first())
        .not.toBeNull()
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_maintenance_status")
      await harness.dispose()
    }
  })

  it("serializes concurrent singleton claims into one success and one AlreadyInitialized", async () => {
    const harness = await makeHarness()
    try {
      const claims = await Promise.all([
        useRepositories(harness, (repositories) => Effect.result(repositories.claimUser({
          username: "first",
          password: passwordRecord,
          nowMs: 1_000
        }))),
        useRepositories(harness, (repositories) => Effect.result(repositories.claimUser({
          username: "second",
          password: passwordRecord,
          nowMs: 1_000
        })))
      ])
      expect(claims.filter((claim) => claim._tag === "Success")).toHaveLength(1)
      expect(claims.filter((claim) => claim._tag === "Failure").map((claim) => claim.failure._tag))
        .toEqual(["AlreadyInitialized"])
      expect(await env.DB.prepare("SELECT count(*) AS count FROM users").first()).toEqual({ count: 1 })
    } finally {
      await harness.dispose()
    }
  })

  it("keeps concurrent auth attempts in one SQL-side rate-limit window", async () => {
    const harness = await makeHarness()
    try {
      const attempts = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        useRepositories(harness, (repositories) => repositories.consumeAuthAttempt({
          scopeKey: "login:owner",
          nowMs: 1_000 + index,
          windowMs: 60_000,
          maxAttempts: 3,
          blockMs: 60_000
        }))))
      expect(attempts.filter(Boolean)).toHaveLength(3)
      expect(await env.DB.prepare(`
        SELECT count(*) AS windows, max(attempt_count) AS attempts
        FROM auth_rate_limits WHERE scope_key = 'login:owner'
      `).first()).toEqual({ windows: 1, attempts: 3 })
    } finally {
      await harness.dispose()
    }
  })

  it("preserves independent concurrent server-result fields", async () => {
    const harness = await makeHarness()
    try {
      await useRepositories(harness, (repositories) => repositories.saveServer(server("result-server")))
      await Promise.all([
        useRepositories(harness, (repositories) => repositories.saveServerResult({
          serverId: "result-server",
          expectedGeneration: 1,
          accessToken: "new-token",
          updatedAtMs: 2_000
        })),
        useRepositories(harness, (repositories) => repositories.saveServerResult({
          serverId: "result-server",
          expectedGeneration: 1,
          health: "degraded",
          updatedAtMs: 2_001
        }))
      ])
      expect(await env.DB.prepare(`
        SELECT access_token, health FROM upstream_servers WHERE id = 'result-server'
      `).first()).toEqual({ access_token: "new-token", health: "degraded" })
    } finally {
      await harness.dispose()
    }
  })

  it("rolls back late identity mapping when existing-state target sync fails", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    await useRepositories(harness, (repositories) => repositories.writeUserStateAndTargets({
      canonicalId: canonicalFixture.id,
      patch: {
        played: false,
        favorite: true,
        playCount: 0,
        positionTicks: 22,
        lastPlayedVersionId: null
      },
      updatedAtMs: 2_000
    }))
    await run(`
      CREATE TRIGGER fail_late_identity_outbox
      BEFORE INSERT ON state_outbox
      WHEN NEW.target_id = 'late-persist'
      BEGIN SELECT RAISE(ABORT, 'injected late identity outbox failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.persistIdentityResult({
        canonical: canonicalFixture,
        aliases: [],
        claims: [],
        sourceItem: {
          id: "late-persist",
          serverId: "server-1",
          catalogNamespace: "catalog:server-1",
          serverGeneration: 1,
          sourceLibraryId: "movies",
          upstreamItemId: "late-upstream",
          itemType: "Movie",
          canonicalId: canonicalFixture.id,
          quarantineReason: null,
          createdAtMs: 3_000,
          updatedAtMs: 3_000
        },
        mediaVersions: []
      }))).rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare("SELECT id FROM source_items WHERE id = 'late-persist'").first()).toBeNull()
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_late_identity_outbox")
      await harness.dispose()
    }
  })

  it("merges concurrent canonical metadata without dropping either projection", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    try {
      await Promise.all([
        useRepositories(harness, (repositories) => repositories.mergeCanonicalMetadata(
          canonicalFixture.id,
          `${canonicalFixture.id}:source`,
          { Name: "Renamed" },
          2_000
        )),
        useRepositories(harness, (repositories) => repositories.mergeCanonicalMetadata(
          canonicalFixture.id,
          `${canonicalFixture.id}:source`,
          { Overview: "Loaded" },
          2_001
        ))
      ])
      const row = await env.DB.prepare(
        "SELECT display_metadata_json FROM canonical_items WHERE id = ?"
      ).bind(canonicalFixture.id).first<{ display_metadata_json: string }>()
      expect(JSON.parse(row!.display_metadata_json)).toEqual({
        Name: "Renamed",
        Overview: "Loaded"
      })
    } finally {
      await harness.dispose()
    }
  })

  it("hydrates catalog state and exposes media versions only while their detail projection is usable", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    await run(`
      INSERT INTO source_media_versions (
        id, source_item_id, server_generation, upstream_media_source_id,
        label, capabilities_json, streams_json, updated_at_ms
      ) VALUES (
        'version-1', ?, 1, 'upstream-version-1',
        'Version 1', '{}', '[]', 2000
      )
    `, `${canonicalFixture.id}:source`)
    try {
      await useRepositories(harness, (repositories) => Effect.gen(function*() {
        yield* repositories.writeUserStateAndTargets({
          canonicalId: canonicalFixture.id,
          patch: {
            played: false,
            favorite: true,
            playCount: 2,
            positionTicks: 123,
            lastPlayedVersionId: "version-1"
          },
          updatedAtMs: 2_000
        })
        yield* repositories.writeMetadataProjection({
          sourceItemId: `${canonicalFixture.id}:source`,
          projectionKey: "detail",
          payload: { MediaSources: [{ Id: "upstream-version-1" }] },
          freshUntilMs: 3_000,
          staleUntilMs: 5_000,
          updatedAtMs: 2_000
        })

        expect(yield* repositories.readMetadataProjection(
          `${canonicalFixture.id}:source`,
          "detail"
        )).toMatchObject({
          payload: { MediaSources: [{ Id: "upstream-version-1" }] },
          freshUntilMs: 3_000,
          staleUntilMs: 5_000
        })
        const [usable] = yield* repositories.readCatalogItems([canonicalFixture.id], 4_999)
        expect(usable).toMatchObject({
          canonical: { id: canonicalFixture.id, displayMetadata: { Name: "A Movie" } },
          sourceItems: [{ id: `${canonicalFixture.id}:source` }],
          mediaVersions: [{ id: "version-1", upstreamMediaSourceId: "upstream-version-1" }],
          userState: { favorite: true, playCount: 2, positionTicks: 123 }
        })
        const [expired] = yield* repositories.readCatalogItems([canonicalFixture.id], 5_000)
        expect(expired?.mediaVersions).toEqual([])
      }))
    } finally {
      await harness.dispose()
    }
  })

  it("invalidates only state-dependent query generations", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    const generation = (id: string, stateDependent: boolean) => ({
      id,
      queryKey: `query-${id}`,
      revision: 0,
      userKey: "owner",
      deviceId: "device-1",
      virtualLibraryId: "library-1",
      normalizedQuery: {},
      sourceState: {},
      allSourcesExhausted: false,
      stateDependent,
      createdAtMs: 2_000,
      expiresAtMs: 10_000
    })
    try {
      await useRepositories(harness, (repositories) => Effect.gen(function*() {
        yield* repositories.appendQueryGenerationItems({
          expected: null,
          generation: generation("state", true),
          items: [{ ordinal: 0, canonicalId: canonicalFixture.id, sortValues: [] }]
        })
        yield* repositories.appendQueryGenerationItems({
          expected: null,
          generation: generation("catalog", false),
          items: [{ ordinal: 0, canonicalId: canonicalFixture.id, sortValues: [] }]
        })

        yield* repositories.invalidateStateDependentQueryGenerations()

        expect(yield* repositories.readQueryGeneration("query-state")).toBeNull()
        expect(yield* repositories.readQueryGeneration("query-catalog")).toMatchObject({
          id: "catalog",
          stateDependent: false
        })
      }))
    } finally {
      await harness.dispose()
    }
  })

  it("rolls back every outbox lease when one candidate claim fails", async () => {
    const harness = await makeHarness()
    await harness.seedCanonicalWithEligibleSources(canonicalFixture)
    await run(`
      INSERT INTO source_items (
        id, server_id, catalog_namespace, server_generation, source_library_id,
        upstream_item_id, item_type, canonical_id, quarantine_reason, created_at_ms, updated_at_ms
      ) VALUES (
        'source-second', 'server-1', 'catalog:server-1', 1, 'movies',
        'item-second', 'Movie', ?, NULL, 1000, 1000
      )
    `, canonicalFixture.id)
    await useRepositories(harness, (repositories) => repositories.writeUserStateAndTargets({
      canonicalId: canonicalFixture.id,
      patch: {
        played: false,
        favorite: true,
        playCount: 0,
        positionTicks: 0,
        lastPlayedVersionId: null
      },
      updatedAtMs: 2_000
    }))
    await run(`
      CREATE TRIGGER fail_second_outbox_claim
      BEFORE UPDATE ON state_outbox
      WHEN NEW.target_id = 'source-second' AND NEW.lease_owner IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected outbox claim failure'); END
    `)
    try {
      await expect(useRepositories(harness, (repositories) => repositories.claimOutboxTargets({
        nowMs: 3_000,
        leaseOwner: "worker-1"
      }))).rejects.toMatchObject({ _tag: "RepositoryError" })
      expect(await env.DB.prepare(
        "SELECT count(*) AS count FROM state_outbox WHERE lease_owner IS NOT NULL"
      ).first()).toEqual({ count: 0 })
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_second_outbox_claim")
      await harness.dispose()
    }
  })
})

// This direct check documents the controller ruling: Wrangler owns d1_migrations,
// while the application keeps its cross-runtime schema_migrations shape.
it("keeps Wrangler and application migration bookkeeping separate", async () => {
  const wrangler = await env.DB.prepare("PRAGMA table_info(d1_migrations)").all<{ name: string }>()
  const application = await env.DB.prepare("PRAGMA table_info(schema_migrations)").all<{ name: string }>()

  expect(wrangler.results.map(({ name }) => name)).toEqual(["id", "name", "applied_at"])
  expect(application.results.map(({ name }) => name)).toEqual(["version", "name", "applied_at_ms"])
  expect(await env.DB.prepare("SELECT version, name FROM schema_migrations").first()).toEqual({
    version: 1,
    name: "initial"
  })
})
