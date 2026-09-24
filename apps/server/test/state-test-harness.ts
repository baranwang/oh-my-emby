import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Schema } from "effect"

import { UpstreamClient, type UpstreamClientService, type UpstreamRequest } from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()

export interface StateHarness {
  readonly directory: string
  readonly filename: string
  readonly repositories: ReturnType<typeof makeSqliteRepositoriesLayer>
  readonly database: <A>(use: (database: Database) => A) => A
  readonly seed: (sourceCount?: number) => void
  readonly addSource: (id: string, upstreamItemId?: string) => void
  readonly dispose: () => Promise<void>
}

export const makeStateHarness = async (): Promise<StateHarness> => {
  const directory = await mkdtemp(join(tmpdir(), "oh-my-emby-state-"))
  const filename = join(directory, "state.sqlite")
  const database = <A>(use: (database: Database) => A): A => {
    const connection = new Database(filename)
    try {
      connection.exec("PRAGMA foreign_keys = ON")
      return use(connection)
    } finally {
      connection.close()
    }
  }
  database((connection) => connection.exec(migration))

  const addSource = (id: string, upstreamItemId = id) => database((connection) => connection.run(`
    INSERT INTO source_items (
      id, server_id, catalog_namespace, server_generation, source_library_id,
      upstream_item_id, item_type, canonical_id, quarantine_reason, created_at_ms, updated_at_ms
    ) VALUES (?, 'server-1', 'catalog:server-1', 1, 'movies-1', ?, 'Movie',
      'canonical-1', NULL, 1000, 1000)
  `, [id, upstreamItemId]))

  const seed = (sourceCount = 1) => database((connection) => connection.transaction(() => {
    connection.run(`
      INSERT INTO upstream_servers (
        id, catalog_namespace, verified_catalog_id, verified_base_url, generation, name, base_url,
        username, password, access_token, access_token_expires_at_ms, upstream_user_id, user_agent,
        enabled, health, last_success_at_ms, created_at_ms, updated_at_ms
      ) VALUES ('server-1', 'catalog:server-1', 'verified:server-1',
        'https://server-1.example.com', 1, 'Server 1', 'https://server-1.example.com',
        'upstream-user', 'upstream-password', 'upstream-token', NULL, 'upstream-user-id', 'test-agent',
        1, 'healthy', 1000, 1000, 1000)
    `)
    connection.run(`
      INSERT INTO virtual_libraries (id, name, media_type, enabled, created_at_ms, updated_at_ms)
      VALUES ('library-1', 'Movies', 'movies', 1, 1000, 1000)
    `)
    connection.run(`
      INSERT INTO library_sources (
        virtual_library_id, server_id, source_library_id, source_library_name,
        media_type, source_order, enabled
      ) VALUES ('library-1', 'server-1', 'movies-1', 'Movies', 'movies', 0, 1)
    `)
    connection.run(`
      INSERT INTO canonical_items (
        id, item_type, identity_state, display_metadata_json, created_at_ms, updated_at_ms
      ) VALUES ('canonical-1', 'Movie', 'exact', '{"Name":"Movie"}', 1000, 1000)
    `)
    for (let index = 0; index < sourceCount; index += 1) {
      connection.run(`
        INSERT INTO source_items (
          id, server_id, catalog_namespace, server_generation, source_library_id,
          upstream_item_id, item_type, canonical_id, quarantine_reason, created_at_ms, updated_at_ms
        ) VALUES (?, 'server-1', 'catalog:server-1', 1, 'movies-1', ?, 'Movie',
          'canonical-1', NULL, 1000, 1000)
      `, [`source-${index + 1}`, `upstream-${index + 1}`])
    }
  })())

  return {
    directory,
    filename,
    repositories: makeSqliteRepositoriesLayer({ filename }),
    database,
    seed,
    addSource,
    dispose: () => rm(directory, { recursive: true, force: true })
  }
}

export const makeUpstreamLayer = (
  request: (input: UpstreamRequest) => Effect.Effect<unknown, any>
): Layer.Layer<UpstreamClient> => {
  const unavailable = () => Effect.die(new Error("not used by state tests"))
  return Layer.succeed(UpstreamClient, UpstreamClient.of({
    request: ((input: UpstreamRequest, _schema: Schema.Schema<unknown>) => request(input)) as UpstreamClientService["request"],
    authenticate: unavailable,
    getServerIdentity: unavailable,
    listSourceLibraries: unavailable,
    resolvePlayback: unavailable
  }))
}
