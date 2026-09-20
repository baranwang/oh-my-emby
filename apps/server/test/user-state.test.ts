import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { UserState, makeUserStateLayer } from "../src/core/user-state.js"
import { Repositories } from "../src/core/repositories.js"
import { makeStateHarness, type StateHarness } from "./state-test-harness.js"

describe("local user state", () => {
  let harness: StateHarness
  let nowMs: number
  let layer: Layer.Layer<UserState | Repositories>

  beforeEach(async () => {
    harness = await makeStateHarness()
    harness.seed()
    nowMs = 2_000
    const state = makeUserStateLayer({ now: () => nowMs }).pipe(Layer.provide(harness.repositories))
    layer = Layer.merge(harness.repositories, state)
  })

  afterEach(async () => harness.dispose())

  it("commits state and eligible targets atomically", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const state = yield* UserState
      const saved = yield* state.write("canonical-1", {
        played: true,
        favorite: true,
        positionTicks: 10
      })
      expect(saved).toMatchObject({ revision: 1, playCount: 0, lastPlayedVersionId: null })
    }).pipe(Effect.provide(layer)))

    const rows = harness.database((database) => database.query<{
      desired_revision: number
      payload_json: string
    }, []>("SELECT desired_revision, payload_json FROM state_outbox").all())
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      played: true,
      favorite: true,
      positionTicks: 10,
      playCount: 0
    })
  })

  it("rolls back local state when target creation fails", async () => {
    harness.database((database) => database.exec(`
      CREATE TRIGGER fail_state_target BEFORE INSERT ON state_outbox
      BEGIN SELECT RAISE(ABORT, 'target failure'); END
    `))
    await expect(Effect.runPromise(Effect.gen(function*() {
      const state = yield* UserState
      yield* state.write("canonical-1", { favorite: true })
    }).pipe(Effect.provide(layer)))).rejects.toMatchObject({ _tag: "RepositoryError" })
    expect(harness.database((database) => database.query("SELECT * FROM user_state").all())).toEqual([])
  })

  it("invalidates state-dependent generations only after the state transaction commits", async () => {
    harness.database((database) => {
      database.run(`
        INSERT INTO query_generations (
          id, query_key, revision, user_key, device_id, virtual_library_id,
          normalized_query_json, source_state_json, all_sources_exhausted,
          state_dependent, created_at_ms, expires_at_ms
        ) VALUES ('generation-1', 'favorites', 0, 'owner', 'device', 'library-1',
          '{}', '{}', 1, 1, 1000, 10000)
      `)
      database.exec(`
        CREATE TRIGGER fail_invalidation BEFORE DELETE ON query_generations
        BEGIN SELECT RAISE(ABORT, 'invalidation failure'); END
      `)
    })

    await expect(Effect.runPromise(Effect.gen(function*() {
      const state = yield* UserState
      yield* state.write("canonical-1", { favorite: true })
    }).pipe(Effect.provide(layer)))).rejects.toMatchObject({ _tag: "RepositoryError" })
    expect(harness.database((database) => database.query("SELECT * FROM user_state").all())).toHaveLength(1)
    expect(harness.database((database) => database.query("SELECT * FROM state_outbox").all())).toHaveLength(1)
  })

  it("enqueues the latest edited state when a mapping appears later", async () => {
    harness.database((database) => database.run("DELETE FROM source_items"))
    await Effect.runPromise(Effect.gen(function*() {
      const state = yield* UserState
      yield* state.write("canonical-1", { favorite: true, positionTicks: 22 })
      const repositories = yield* Repositories
      yield* repositories.persistIdentityResult({
        canonical: {
          id: "canonical-1",
          itemType: "Movie",
          identityState: "exact",
          displayMetadata: { Name: "Movie" },
          createdAtMs: 1_000,
          updatedAtMs: 3_000
        },
        aliases: [],
        claims: [],
        sourceItem: {
          id: "late-source",
          serverId: "server-1",
          catalogNamespace: "catalog:server-1",
          serverGeneration: 1,
          sourceLibraryId: "movies-1",
          upstreamItemId: "late-upstream",
          itemType: "Movie",
          canonicalId: "canonical-1",
          quarantineReason: null,
          createdAtMs: 3_000,
          updatedAtMs: 3_000
        },
        mediaVersions: []
      })
    }).pipe(Effect.provide(layer)))

    const target = harness.database((database) => database.query<{
      desired_revision: number
      payload_json: string
    }, []>("SELECT desired_revision, payload_json FROM state_outbox WHERE target_id = 'late-source'").get())
    expect(target?.desired_revision).toBe(1)
    expect(JSON.parse(target!.payload_json)).toMatchObject({ favorite: true, positionTicks: 22 })
  })

  it("clears the last-played version when null is explicitly written", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const state = yield* UserState
      yield* state.write("canonical-1", { lastPlayedVersionId: "version-1" })
      yield* state.write("canonical-1", { lastPlayedVersionId: null })
    }).pipe(Effect.provide(layer)))
    const version = harness.database((database) => database.query<{
      last_played_version_id: string | null
    }, []>("SELECT last_played_version_id FROM user_state").get()?.last_played_version_id)
    expect(version).toBeNull()
  })

  it("folds playback idempotently, rejects stale sessions, and accepts a current backward seek", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const state = yield* UserState
      yield* state.recordPlaybackEvent({
        kind: "start", localSessionId: "session-1", canonicalId: "canonical-1",
        versionId: "version-1", positionTicks: 0, occurredAtMs: 10_000
      })
      yield* state.recordPlaybackEvent({
        kind: "progress", localSessionId: "session-1", canonicalId: "canonical-1",
        versionId: "version-1", positionTicks: 100, occurredAtMs: 11_000
      })
      yield* state.recordPlaybackEvent({
        kind: "start", localSessionId: "session-1", canonicalId: "canonical-1",
        versionId: "version-1", positionTicks: 0, occurredAtMs: 10_000
      })
      yield* state.recordPlaybackEvent({
        kind: "stop", localSessionId: "session-1", canonicalId: "canonical-1",
        versionId: "version-1", positionTicks: 120, occurredAtMs: 12_000, played: true
      })
      yield* state.recordPlaybackEvent({
        kind: "stop", localSessionId: "session-1", canonicalId: "canonical-1",
        versionId: "version-1", positionTicks: 120, occurredAtMs: 12_000, played: true
      })
      yield* state.recordPlaybackEvent({
        kind: "start", localSessionId: "session-2", canonicalId: "canonical-1",
        versionId: "version-2", positionTicks: 200, occurredAtMs: 20_000
      })
      yield* state.recordPlaybackEvent({
        kind: "progress", localSessionId: "session-1", canonicalId: "canonical-1",
        versionId: "version-1", positionTicks: 999, occurredAtMs: 21_000
      })
      yield* state.recordPlaybackEvent({
        kind: "progress", localSessionId: "session-2", canonicalId: "canonical-1",
        versionId: "version-2", positionTicks: 50, occurredAtMs: 22_000
      })
      yield* state.recordPlaybackEvent({
        kind: "progress", localSessionId: "session-2", canonicalId: "canonical-1",
        versionId: "version-2", positionTicks: 999, occurredAtMs: 21_500
      })
    }).pipe(Effect.provide(layer)))

    const state = harness.database((database) => database.query<{
      play_count: number
      played: number
      position_ticks: number
      last_played_version_id: string
    }, []>("SELECT play_count, played, position_ticks, last_played_version_id FROM user_state").get())
    expect(state).toEqual({
      play_count: 1,
      played: 0,
      position_ticks: 50,
      last_played_version_id: "version-2"
    })
  })
})
