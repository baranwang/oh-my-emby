import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

import type { CanonicalFixture, UserStateRecord } from "../src/core/model.js"
import {
  applySqliteMigrations,
  makeSqliteRepositoriesLayer
} from "../src/platform/bun/sqlite-repositories.js"
import { repositoryContract, type RepositoryHarness } from "./repository-contract.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()
const alignmentMigration = await Bun.file(
  new URL("../migrations/0002_dashboard_alignment.sql", import.meta.url)
).text()

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
  withDatabase(filename, (database) => {
    database.exec(migration)
    database.exec(alignmentMigration)
  })

  return {
    layer: makeSqliteRepositoriesLayer({ filename }),
    seedCanonicalWithEligibleSources: async (fixture: CanonicalFixture) => {
      withDatabase(filename, (database) => database.transaction(() => {
        database.run(`
          INSERT INTO upstream_servers (
            id, catalog_namespace, verified_catalog_id, generation, name, base_url,
            username, password, access_token, access_token_expires_at_ms, upstream_user_id, user_agent,
            enabled, health, last_success_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, 'upstream-user-id', ?, 1, 'healthy', ?, ?, ?)
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
          INSERT INTO upstream_server_endpoints (
            id, server_id, protocol, host, port, path, endpoint_order,
            verified_catalog_id, health, last_success_at_ms, created_at_ms, updated_at_ms
          ) VALUES (
            'server-1:endpoint', 'server-1', 'https', 'server-1.example.com', NULL, '', 0,
            'verified:server-1', 'healthy', 1000, 1000, 1000
          )
        `)
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
    failNext: async (operation) => {
      const trigger = operation === "state_outbox_insert"
        ? `CREATE TRIGGER fail_state_outbox_insert BEFORE INSERT ON state_outbox
          BEGIN SELECT RAISE(ABORT, 'injected state_outbox_insert failure'); END;`
        : operation === "server_endpoint_insert"
          ? `CREATE TRIGGER fail_server_endpoint_insert BEFORE INSERT ON upstream_server_endpoints
            WHEN NEW.id = 'endpoint-trigger-failure'
            BEGIN SELECT RAISE(ABORT, 'injected server endpoint failure'); END;`
          : `CREATE TRIGGER fail_metadata_setting_write BEFORE INSERT ON metadata_provider_settings
            WHEN NEW.provider_id = 'tmdb' AND NEW.updated_at_ms = 3000
            BEGIN SELECT RAISE(ABORT, 'injected metadata setting failure'); END;`
      withDatabase(filename, (database) => database.exec(trigger))
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

it("migrates a legacy server base URL into its first ordered endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-my-emby-legacy-migration-"))
  const filename = join(directory, "legacy.sqlite")
  const migrationsDirectory = join(directory, "migrations")
  try {
    await mkdir(migrationsDirectory)
    await Bun.write(join(migrationsDirectory, "0002_dashboard_alignment.sql"), await Bun.file(
      new URL("../migrations/0002_dashboard_alignment.sql", import.meta.url)
    ).text())
    withDatabase(filename, (database) => database.exec(`
      CREATE TABLE upstream_servers (
        id TEXT PRIMARY KEY,
        verified_catalog_id TEXT,
        base_url TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        health TEXT NOT NULL,
        last_success_at_ms INTEGER,
        deleted_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (1, 'initial', 1000);
      INSERT INTO upstream_servers VALUES (
        'legacy-server', 'catalog-1', 'https://emby.example.com:8443/emby', '',
        'healthy', 1500, NULL, 1000, 2000
      );
    `))

    await applySqliteMigrations(filename, migrationsDirectory)

    const migrated = withDatabase(filename, (database) => ({
      server: database.query<Record<string, unknown>, []>(
        "SELECT user_agent_policy FROM upstream_servers"
      ).get(),
      endpoint: database.query<Record<string, unknown>, []>(
        "SELECT server_id, protocol, host, port, path, endpoint_order FROM upstream_server_endpoints"
      ).get()
    }))
    expect(migrated).toEqual({
      server: { user_agent_policy: "client-preferred" },
      endpoint: {
        server_id: "legacy-server",
        protocol: "https",
        host: "emby.example.com",
        port: 8443,
        path: "/emby",
        endpoint_order: 0
      }
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
