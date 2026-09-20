import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  Identity,
  type ProviderIds,
  type SourceItemCandidate,
  makeIdentityLayer,
  normalizeExternalClaims
} from "../src/core/identity.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()

const source = (
  serverId: string,
  upstreamItemId: string,
  itemType: SourceItemCandidate["itemType"],
  providerIds: ProviderIds = {},
  overrides: Partial<SourceItemCandidate> = {}
): SourceItemCandidate => ({
  serverId,
  catalogNamespace: `catalog:${serverId}`,
  verifiedCatalogId: `verified:${serverId}`,
  serverGeneration: 1,
  sourceLibraryId: itemType === "Movie" ? "movies" : "series",
  upstreamItemId,
  itemType,
  providerIds,
  displayMetadata: { Name: upstreamItemId },
  observedAtMs: 1_000,
  ...overrides
})

const movie = (serverId: string, providerIds: ProviderIds, upstreamItemId = serverId) =>
  source(serverId, upstreamItemId, "Movie", providerIds)

const series = (serverId: string, providerIds: ProviderIds, upstreamItemId = serverId) =>
  source(serverId, upstreamItemId, "Series", providerIds)

const episode = (serverId: string, seasonNumber: number, episodeNumber: number) =>
  source(serverId, serverId, "Episode", {}, {
    canonicalSeriesId: "series-parent",
    seasonNumber,
    episodeNumber
  })

const combinedEpisode = (serverId: string, seasonNumber: number, episodeNumbers: ReadonlyArray<number>) =>
  source(serverId, serverId, "Episode", {}, {
    canonicalSeriesId: "series-parent",
    seasonNumber,
    episodeNumber: episodeNumbers[0],
    combinedEpisodeNumbers: episodeNumbers
  })

describe("exact canonical identity", () => {
  let directory: string
  let filename: string
  let identityLayer: Layer.Layer<Identity>

  const withDatabase = <A>(use: (database: Database) => A): A => {
    const database = new Database(filename)
    try {
      database.exec("PRAGMA foreign_keys = ON")
      return use(database)
    } finally {
      database.close()
    }
  }

  const resolve = (candidate: SourceItemCandidate) => Effect.runPromise(Effect.gen(function*() {
    const identity = yield* Identity
    return yield* identity.resolve(candidate)
  }).pipe(Effect.provide(identityLayer)))

  const lookup = (canonicalId: string) => Effect.runPromise(Effect.gen(function*() {
    const identity = yield* Identity
    return yield* identity.lookupCanonicalId(canonicalId)
  }).pipe(Effect.provide(identityLayer)))

  const resolvePair = async (left: SourceItemCandidate, right: SourceItemCandidate) => {
    const first = await resolve(left)
    const second = await resolve(right)
    return {
      first,
      second,
      decision: second.sourceItem.quarantineReason !== null
        ? "quarantined"
        : first.canonical.id === second.canonical.id ? "merged" : "separate"
    }
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-identity-"))
    filename = join(directory, "identity.sqlite")
    withDatabase((database) => {
      database.exec(migration)
      for (const serverId of ["a", "b", "c"]) {
        database.run(`
          INSERT INTO upstream_servers (
            id, catalog_namespace, verified_catalog_id, verified_base_url, generation,
            name, base_url, username, password, access_token, access_token_expires_at_ms,
            user_agent, enabled, health, last_success_at_ms, deleted_at_ms,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, 1, ?, ?, 'user', NULL, NULL, NULL,
            'identity-test', 1, 'healthy', 1, NULL, 1, 1)
        `, [
          serverId,
          `catalog:${serverId}`,
          `verified:${serverId}`,
          `https://${serverId}.example.com`,
          serverId,
          `https://${serverId}.example.com`
        ])
      }
      database.run(`
        INSERT INTO canonical_items (
          id, item_type, identity_state, display_metadata_json, created_at_ms, updated_at_ms
        ) VALUES ('series-parent', 'Series', 'exact', '{}', 1, 1)
      `)
    })
    const repositories = makeSqliteRepositoriesLayer({ filename })
    identityLayer = makeIdentityLayer.pipe(Layer.provide(repositories))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ["exact movie IDs", movie("a", { tmdbMovie: "10" }), movie("b", { tmdbMovie: "10" }), "merged"],
    ["type mismatch", movie("a", { tmdbMovie: "10" }), series("b", { tmdbTv: "10" }), "separate"],
    [
      "conflicting IMDb",
      movie("a", { tmdbMovie: "10", imdbTitle: "tt1" }),
      movie("b", { tmdbMovie: "10", imdbTitle: "tt2" }),
      "quarantined"
    ],
    ["combined episode", episode("a", 1, 1), combinedEpisode("b", 1, [1, 2]), "separate"],
    ["special versus season one", episode("a", 0, 1), episode("b", 1, 1), "separate"]
  ] as const)("handles %s", async (_, left, right, expected) => {
    expect((await resolvePair(left, right)).decision).toBe(expected)
  })

  it("trims documented claims without case-folding opaque provider IDs", () => {
    expect(normalizeExternalClaims("Movie", {
      tmdbMovie: " 10 ",
      tmdbTv: "ignored-for-movies",
      imdbTitle: " TT-AbC "
    })).toEqual([
      { namespace: "imdb:title", value: "TT-AbC" },
      { namespace: "tmdb:movie", value: "10" }
    ])
  })

  it("uses canonical series plus season number as the season fallback", async () => {
    const first = await resolve(source("a", "season-a", "Season", {}, {
      canonicalSeriesId: "series-parent",
      seasonNumber: 2
    }))
    const second = await resolve(source("b", "season-b", "Season", {}, {
      canonicalSeriesId: "series-parent",
      seasonNumber: 2
    }))
    const specials = await resolve(source("c", "specials", "Season", {}, {
      canonicalSeriesId: "series-parent",
      seasonNumber: 0
    }))

    expect(second.canonical.id).toBe(first.canonical.id)
    expect(specials.canonical.id).not.toBe(first.canonical.id)
  })

  it("quarantines a sparse bridge that would join incompatible clusters", async () => {
    const x = await resolve(movie("a", { tmdbMovie: "10", imdbTitle: "tt1" }, "x"))
    const z = await resolve(movie("b", { imdbTitle: "tt2" }, "z"))
    const y = await resolve(movie("c", { tmdbMovie: "10", imdbTitle: "tt2" }, "y"))

    expect(y.sourceItem.quarantineReason).toBe("ambiguous-identity")
    expect(new Set([x.canonical.id, y.canonical.id, z.canonical.id]).size).toBe(3)
    expect(await lookup(x.canonical.id)).toBe(x.canonical.id)
    expect(await lookup(z.canonical.id)).toBe(z.canonical.id)
  })

  it("keeps a child source-exclusive when its canonical parent cannot be hydrated", async () => {
    const child = await resolve(source("a", "orphan", "Episode", {}, {
      canonicalSeriesId: "missing-series",
      seasonNumber: 1,
      episodeNumber: 2
    }))

    expect(child.canonical.identityState).toBe("source-exclusive")
    expect(child.sourceItem.quarantineReason).toBe("parent-unresolved")
  })

  it("derives source-exclusive IDs from verified catalog and upstream item identity", async () => {
    const first = await resolve(movie("a", {}, "unidentified"))
    const refreshed = await resolve(source("a", "unidentified", "Movie", {}, {
      displayMetadata: { Name: "metadata changed" },
      observedAtMs: 2_000
    }))
    const otherCatalog = await resolve(movie("b", {}, "unidentified"))

    expect(refreshed.canonical.id).toBe(first.canonical.id)
    expect(otherCatalog.canonical.id).not.toBe(first.canonical.id)
  })

  it("attaches late compatible claims without changing an issued canonical ID", async () => {
    const first = await resolve(movie("a", { tmdbMovie: "10" }, "late-claim"))
    const enriched = await resolve(movie("a", { tmdbMovie: "10", imdbTitle: "tt1" }, "late-claim"))

    expect(enriched.canonical.id).toBe(first.canonical.id)
    expect(enriched.claims.map(({ namespace, value, state }) => ({ namespace, value, state }))).toEqual([
      { namespace: "imdb:title", value: "tt1", state: "exact" },
      { namespace: "tmdb:movie", value: "10", state: "exact" }
    ])
  })

  it("keeps the oldest canonical, resolves its alias, and preserves the highest state revision", async () => {
    const oldest = await resolve(source("a", "oldest", "Movie", { tmdbMovie: "10" }, { observedAtMs: 1_000 }))
    const newest = await resolve(source("b", "newest", "Movie", { imdbTitle: "tt1" }, { observedAtMs: 2_000 }))
    withDatabase((database) => {
      database.run(`
        INSERT INTO user_state (
          canonical_id, revision, played, favorite, play_count, position_ticks,
          last_played_version_id, updated_at_ms
        ) VALUES (?, 2, 0, 0, 1, 10, NULL, 2000), (?, 5, 1, 1, 4, 50, NULL, 3000)
      `, [oldest.canonical.id, newest.canonical.id])
    })

    const consolidated = await resolve(source("a", "oldest", "Movie", {
      tmdbMovie: "10",
      imdbTitle: "tt1"
    }, { observedAtMs: 4_000 }))

    expect(consolidated.canonical.id).toBe(oldest.canonical.id)
    expect(await lookup(newest.canonical.id)).toBe(oldest.canonical.id)
    expect(withDatabase((database) => database.query<{
      canonical_id: string
      revision: number
      played: number
      favorite: number
      play_count: number
      position_ticks: number
    }, [string]>("SELECT * FROM user_state WHERE canonical_id = ?").get(oldest.canonical.id))).toMatchObject({
      canonical_id: oldest.canonical.id,
      revision: 5,
      played: 1,
      favorite: 1,
      play_count: 4,
      position_ticks: 50
    })
    expect(withDatabase((database) => database.query(
      "SELECT id FROM canonical_items WHERE id = ?"
    ).get(newest.canonical.id))).toBeNull()
  })

  it("quarantines a late conflict without moving existing user state", async () => {
    const existing = await resolve(movie("a", { tmdbMovie: "10", imdbTitle: "tt1" }, "existing"))
    withDatabase((database) => database.run(`
      INSERT INTO user_state (
        canonical_id, revision, played, favorite, play_count, position_ticks,
        last_played_version_id, updated_at_ms
      ) VALUES (?, 7, 1, 0, 3, 70, NULL, 2000)
    `, [existing.canonical.id]))

    const conflict = await resolve(movie("b", { tmdbMovie: "10", imdbTitle: "tt2" }, "conflict"))

    expect(conflict.sourceItem.quarantineReason).toBe("ambiguous-identity")
    expect(conflict.canonical.id).not.toBe(existing.canonical.id)
    expect(withDatabase((database) => database.query<{ revision: number }, [string]>(
      "SELECT revision FROM user_state WHERE canonical_id = ?"
    ).get(existing.canonical.id))).toEqual({ revision: 7 })
    expect(withDatabase((database) => database.query(
      "SELECT revision FROM user_state WHERE canonical_id = ?"
    ).get(conflict.canonical.id))).toBeNull()
  })

  it("rolls back every identity write when the server generation changes before commit", async () => {
    withDatabase((database) => database.exec(`
      CREATE TRIGGER change_generation_after_identity_insert
      AFTER INSERT ON source_items
      BEGIN
        UPDATE upstream_servers SET generation = generation + 1 WHERE id = NEW.server_id;
      END;
    `))

    const error = await Effect.runPromise(Effect.gen(function*() {
      const identity = yield* Identity
      return yield* Effect.flip(identity.resolve(movie("a", { tmdbMovie: "99" }, "generation-race")))
    }).pipe(Effect.provide(identityLayer)))

    expect(error._tag).toBe("IdentityConflict")
    expect(withDatabase((database) => database.query(
      "SELECT id FROM source_items WHERE upstream_item_id = 'generation-race'"
    ).get())).toBeNull()
    expect(withDatabase((database) => database.query<{ generation: number }, []>(
      "SELECT generation FROM upstream_servers WHERE id = 'a'"
    ).get())).toEqual({ generation: 1 })
  })
})
