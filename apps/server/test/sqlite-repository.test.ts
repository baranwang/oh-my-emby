import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CanonicalFixture, UserStateRecord } from "../src/core/model.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"
import { repositoryContract, type RepositoryHarness } from "./repository-contract.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()

const withDatabase = <A>(filename: string, use: (database: Database) => A): A => {
  const database = new Database(filename)
  try {
    database.exec("PRAGMA foreign_keys = ON")
    return use(database)
  } finally {
    database.close()
  }
}

const makeHarness = async (): Promise<RepositoryHarness> => {
  const directory = await mkdtemp(join(tmpdir(), "oh-my-emby-repository-"))
  const filename = join(directory, "repository.sqlite")
  withDatabase(filename, (database) => database.exec(migration))

  return {
    layer: makeSqliteRepositoriesLayer({ filename }),
    seedCanonicalWithEligibleSources: async (fixture: CanonicalFixture) => {
      withDatabase(filename, (database) => database.transaction(() => {
        database.run(`
          INSERT INTO upstream_servers (
            id, catalog_namespace, verified_catalog_id, generation, name, base_url,
            username, password, access_token, access_token_expires_at_ms, user_agent,
            enabled, health, last_success_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?, 1, 'healthy', ?, ?, ?)
        `, [
          "server-1",
          "catalog:server-1",
          "verified:server-1",
          "Server 1",
          "https://server-1.example.com",
          "upstream-user",
          "upstream-password",
          "oh-my-emby-test",
          1_000,
          1_000,
          1_000
        ])
        database.run(`
          INSERT INTO virtual_libraries (
            id, name, media_type, enabled, created_at_ms, updated_at_ms
          ) VALUES ('library-1', 'Movies', 'movies', 1, 1000, 1000)
        `)
        database.run(`
          INSERT INTO library_sources (
            virtual_library_id, server_id, source_library_id, source_library_name,
            media_type, source_order, enabled
          ) VALUES ('library-1', 'server-1', 'movies-1', 'Movies', 'movies', 0, 1)
        `)
        database.run(`
          INSERT INTO canonical_items (
            id, item_type, identity_state, display_metadata_json, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
          fixture.id,
          fixture.itemType,
          fixture.identityState,
          JSON.stringify(fixture.displayMetadata),
          fixture.createdAtMs,
          fixture.updatedAtMs
        ])
        database.run(`
          INSERT INTO source_items (
            id, server_id, catalog_namespace, server_generation, source_library_id,
            upstream_item_id, item_type, canonical_id, quarantine_reason,
            created_at_ms, updated_at_ms
          ) VALUES ('source-item-1', 'server-1', 'catalog:server-1', 1, 'movies-1',
            'upstream-item-1', 'Movie', ?, NULL, 1000, 1000)
        `, [fixture.id])
      })())
    },
    failNext: async () => {
      withDatabase(filename, (database) => database.exec(`
        CREATE TRIGGER fail_state_outbox_insert
        BEFORE INSERT ON state_outbox
        BEGIN
          SELECT RAISE(ABORT, 'injected state_outbox_insert failure');
        END;
      `))
    },
    getUserState: async (canonicalId: string) =>
      withDatabase(filename, (database) => {
        const row = database.query<{
          canonical_id: string
          revision: number
          played: number
          favorite: number
          play_count: number
          position_ticks: number
          last_played_version_id: string | null
          updated_at_ms: number
        }, [string]>("SELECT * FROM user_state WHERE canonical_id = ?").get(canonicalId)
        return row === null ? null : {
          canonicalId: row.canonical_id,
          revision: row.revision,
          played: row.played === 1,
          favorite: row.favorite === 1,
          playCount: row.play_count,
          positionTicks: row.position_ticks,
          lastPlayedVersionId: row.last_played_version_id,
          updatedAtMs: row.updated_at_ms
        } satisfies UserStateRecord
      }),
    readStorageRow: async (table, id) =>
      withDatabase(filename, (database) => {
        if (table === "upstream_servers") {
          return database.query<Record<string, unknown>, [string]>(
            "SELECT * FROM upstream_servers WHERE id = ?"
          ).get(id)
        }
        return database.query<Record<string, unknown>, [string]>(
          "SELECT * FROM user_state WHERE canonical_id = ?"
        ).get(id)
      }),
    replaceOutboxPayload: async (payloadJson) => {
      withDatabase(filename, (database) => {
        database.run("UPDATE state_outbox SET payload_json = ?", [payloadJson])
      })
    },
    dispose: () => rm(directory, { recursive: true, force: true })
  }
}

repositoryContract(makeHarness)
