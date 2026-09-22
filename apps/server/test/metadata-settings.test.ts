import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  MetadataSettings,
  makeMetadataSettingsLayer
} from "../src/core/metadata-settings.js"
import { Repositories } from "../src/core/repositories.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()

describe("MetadataSettings", () => {
  let directory: string
  let filename: string
  let repositories: ReturnType<typeof makeSqliteRepositoriesLayer>
  let layer: Layer.Layer<MetadataSettings>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-metadata-settings-"))
    filename = join(directory, "metadata.sqlite")
    const database = new Database(filename)
    database.exec(migration)
    database.close()
    repositories = makeSqliteRepositoriesLayer({ filename })
    layer = makeMetadataSettingsLayer.pipe(Layer.provide(repositories))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const run = <A, E>(effect: Effect.Effect<A, E, MetadataSettings>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))

  it("returns disabled TMDB then Trakt defaults without credentials", async () => {
    const view = await run(Effect.gen(function*() {
      return yield* (yield* MetadataSettings).get()
    }))

    expect(view).toEqual({
      providers: [
        { id: "tmdb", enabled: false, order: 0, language: null, hasCredential: false, status: "unconfigured" },
        { id: "trakt", enabled: false, order: 1, language: null, hasCredential: false, status: "unconfigured" }
      ]
    })
    expect(JSON.stringify(view)).not.toContain("credential")
  })

  it("atomically reorders providers and applies Set, Preserve, and Clear", async () => {
    const configured = await run(Effect.gen(function*() {
      const settings = yield* MetadataSettings
      return yield* settings.update({ providers: [
        { id: "trakt", enabled: true, order: 0, language: null, credential: { _tag: "Set", value: "trakt-client" } },
        { id: "tmdb", enabled: true, order: 1, language: "zh-CN", credential: { _tag: "Set", value: "tmdb-token" } }
      ] })
    }))
    expect(configured.providers).toEqual([
      { id: "trakt", enabled: true, order: 0, language: null, hasCredential: true, status: "ready" },
      { id: "tmdb", enabled: true, order: 1, language: "zh-CN", hasCredential: true, status: "ready" }
    ])
    expect(JSON.stringify(configured)).not.toContain("trakt-client")
    expect(JSON.stringify(configured)).not.toContain("tmdb-token")

    const disabled = await run(Effect.gen(function*() {
      const settings = yield* MetadataSettings
      return yield* settings.update({ providers: [
        { id: "tmdb", enabled: false, order: 0, language: "en-US", credential: { _tag: "Preserve" } },
        { id: "trakt", enabled: true, order: 1, language: null, credential: { _tag: "Preserve" } }
      ] })
    }))
    expect(disabled.providers[0]).toEqual({
      id: "tmdb",
      enabled: false,
      order: 0,
      language: "en-US",
      hasCredential: true,
      status: "ready"
    })

    const cleared = await run(Effect.gen(function*() {
      const settings = yield* MetadataSettings
      return yield* settings.update({ providers: [
        { id: "tmdb", enabled: true, order: 0, language: null, credential: { _tag: "Clear" } },
        { id: "trakt", enabled: true, order: 1, language: null, credential: { _tag: "Preserve" } }
      ] })
    }))
    expect(cleared.providers[0]).toEqual({
      id: "tmdb",
      enabled: true,
      order: 0,
      language: null,
      hasCredential: false,
      status: "unconfigured"
    })

    const stored = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* Repositories).readMetadataSettings()
    }).pipe(Effect.provide(repositories)))
    expect(stored.map(({ id, credential }) => ({ id, credential }))).toEqual([
      { id: "tmdb", credential: null },
      { id: "trakt", credential: "trakt-client" }
    ])
  })

  it("retains an observed degraded status until a credential is replaced or cleared", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const repository = yield* Repositories
      yield* repository.writeMetadataSettings([
        { id: "tmdb", enabled: true, order: 0, language: null, credential: "old-token", status: "degraded", updatedAtMs: 1 },
        { id: "trakt", enabled: false, order: 1, language: null, credential: null, status: "unconfigured", updatedAtMs: 1 }
      ])
    }).pipe(Effect.provide(repositories)))

    const preserved = await run(Effect.gen(function*() {
      return yield* (yield* MetadataSettings).update({ providers: [
        { id: "tmdb", enabled: false, order: 0, language: null, credential: { _tag: "Preserve" } },
        { id: "trakt", enabled: false, order: 1, language: null, credential: { _tag: "Preserve" } }
      ] })
    }))
    expect(preserved.providers[0]?.status).toBe("degraded")

    const replaced = await run(Effect.gen(function*() {
      return yield* (yield* MetadataSettings).update({ providers: [
        { id: "tmdb", enabled: false, order: 0, language: null, credential: { _tag: "Set", value: "new-token" } },
        { id: "trakt", enabled: false, order: 1, language: null, credential: { _tag: "Preserve" } }
      ] })
    }))
    expect(replaced.providers[0]?.status).toBe("ready")
  })

  it("rejects missing or duplicate provider IDs and duplicate order without writing", async () => {
    const invalid = [
      { providers: [{ id: "tmdb", enabled: false, order: 0, language: null, credential: { _tag: "Preserve" } }] },
      { providers: [
        { id: "tmdb", enabled: false, order: 0, language: null, credential: { _tag: "Preserve" } },
        { id: "tmdb", enabled: false, order: 1, language: null, credential: { _tag: "Preserve" } }
      ] },
      { providers: [
        { id: "tmdb", enabled: false, order: 0, language: null, credential: { _tag: "Preserve" } },
        { id: "trakt", enabled: false, order: 0, language: null, credential: { _tag: "Preserve" } }
      ] }
    ]

    for (const input of invalid) {
      await expect(run(Effect.gen(function*() {
        return yield* (yield* MetadataSettings).update(input as any)
      }))).rejects.toMatchObject({ _tag: "RepositoryError", operation: "updateMetadataSettings" })
    }

    expect(await run(Effect.gen(function*() {
      return yield* (yield* MetadataSettings).get()
    }))).toEqual({ providers: [
      { id: "tmdb", enabled: false, order: 0, language: null, hasCredential: false, status: "unconfigured" },
      { id: "trakt", enabled: false, order: 1, language: null, hasCredential: false, status: "unconfigured" }
    ] })
  })

  it("rolls back both provider rows when one reordered write fails", async () => {
    await run(Effect.gen(function*() {
      yield* (yield* MetadataSettings).update({ providers: [
        { id: "trakt", enabled: true, order: 0, language: null, credential: { _tag: "Set", value: "trakt-client" } },
        { id: "tmdb", enabled: true, order: 1, language: null, credential: { _tag: "Set", value: "tmdb-token" } }
      ] })
    }))
    const database = new Database(filename)
    database.exec(`CREATE TRIGGER fail_metadata_update BEFORE INSERT ON metadata_provider_settings
      WHEN NEW.provider_id = 'tmdb' AND NEW.provider_order = 0
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`)
    database.close()

    await expect(run(Effect.gen(function*() {
      return yield* (yield* MetadataSettings).update({ providers: [
        { id: "tmdb", enabled: false, order: 0, language: null, credential: { _tag: "Preserve" } },
        { id: "trakt", enabled: false, order: 1, language: null, credential: { _tag: "Preserve" } }
      ] })
    }))).rejects.toMatchObject({ _tag: "RepositoryError" })
    const cleanup = new Database(filename)
    cleanup.exec("DROP TRIGGER fail_metadata_update")
    cleanup.close()

    expect((await run(Effect.gen(function*() {
      return yield* (yield* MetadataSettings).get()
    }))).providers.map(({ id, order, enabled }) => ({ id, order, enabled }))).toEqual([
      { id: "trakt", order: 0, enabled: true },
      { id: "tmdb", order: 1, enabled: true }
    ])
  })
})
