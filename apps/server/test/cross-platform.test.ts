import { Database } from "bun:sqlite"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { acceptanceUpstreamFetch, crossPlatformAcceptance } from "./cross-platform-contract.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"
import { startBunRuntime } from "../src/platform/bun/index.js"

crossPlatformAcceptance("docker", {
  startFresh: async () => {
    const directory = await mkdtemp(join(tmpdir(), "oh-my-emby-acceptance-"))
    const assetsDir = join(directory, "dashboard")
    const migrationsDir = join(directory, "migrations")
    const sqlitePath = join(directory, "data.sqlite")
    await Bun.write(join(assetsDir, "index.html"), "<main>dashboard</main>")
    await Bun.write(join(assetsDir, "assets", "app.js"), "console.log('dashboard')")
    await cp(new URL("../migrations", import.meta.url).pathname, migrationsDir, { recursive: true })
    const config = {
      hostname: "127.0.0.1",
      port: 0,
      publicOrigin: "https://dashboard.example.com",
      trustedProxyAddresses: ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
      administratorPrivateHosts: [],
      registeredResourceOrigins: [],
      sqlitePath,
      cachePath: join(directory, "cache.sqlite"),
      assetsDir,
      migrationsDir,
      upstreamFetch: acceptanceUpstreamFetch
    }
    const runtime = await startBunRuntime(config)
    const repositories = () => makeSqliteRepositoriesLayer({ filename: sqlitePath })
    return {
      publicOrigin: config.publicOrigin,
      repositories: repositories(),
      request: (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        headers.set("x-forwarded-proto", "https")
        headers.set("x-forwarded-host", "dashboard.example.com")
        return fetch(`${runtime.origin}${path}`, { ...init, headers })
      },
      inspectStorage: async () => {
        const database = new Database(sqlitePath, { readonly: true })
        try {
          const migrationNames = database.query<{ name: string }, []>(
            "SELECT name FROM schema_migrations ORDER BY version"
          ).all().map(({ name }) => name)
          const enabledEncoding = database.query<{ enabled: number }, []>(
            "SELECT enabled FROM upstream_servers ORDER BY id LIMIT 1"
          ).get()!.enabled
          return { migrationNames, enabledEncoding }
        } finally {
          database.close()
        }
      },
      reopenRepositories: repositories,
      close: async () => {
        await runtime.close()
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
})
