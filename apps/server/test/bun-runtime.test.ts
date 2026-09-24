import { Database } from "bun:sqlite"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, it } from "vitest"
import { Effect } from "effect"

import { openBunResourceCache } from "../src/platform/bun/cache.js"
import {
  readBunRuntimeConfig,
  scheduleMaintenance,
  startBunRuntime,
  type BunRuntimeConfig
} from "../src/platform/bun/index.js"

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-my-emby-bun-runtime-"))
  const assetsDir = join(directory, "dashboard")
  const migrationsDir = join(directory, "migrations")
  await Bun.write(join(assetsDir, "index.html"), "dashboard")
  await cp(new URL("../migrations", import.meta.url).pathname, migrationsDir, { recursive: true })
  const config: BunRuntimeConfig = {
    hostname: "127.0.0.1",
    port: 0,
    sqlitePath: join(directory, "data.sqlite"),
    cachePath: join(directory, "cache.sqlite"),
    assetsDir,
    migrationsDir
  }
  return { directory, config }
}

const dashboardHeaders = {
  "content-type": "application/json",
  host: "dashboard.example.com",
  origin: "https://dashboard.example.com",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "dashboard.example.com"
}

describe("Bun process lifecycle", () => {
  it("starts from defaults without any origin, proxy, or upstream allowlist variables", () => {
    const config = readBunRuntimeConfig({ DATA_DIR: "/tmp/oh-my-emby-config-test" })
    expect(config.hostname).toBe("0.0.0.0")
    expect(config.port).toBe(3000)
    expect(config.sqlitePath).toBe("/tmp/oh-my-emby-config-test/oh-my-emby.sqlite")
    expect(readBunRuntimeConfig({
      DATA_DIR: "/tmp/oh-my-emby-config-test",
      PUBLIC_ORIGIN: "ftp://invalid",
      TRUSTED_PROXIES: "127.0.0.1",
      PRIVATE_UPSTREAM_HOSTS: "localhost",
      REGISTERED_RESOURCE_ORIGINS: "https://cdn.example.com"
    })).toEqual(config)
  })

  it("applies migrations before listening and never listens after a migration failure", async () => {
    const { directory, config } = await fixture()
    await Bun.write(join(config.migrationsDir, "0003_marker.sql"), `
      CREATE TABLE startup_marker (value TEXT NOT NULL);
      INSERT INTO startup_marker VALUES ('migrated');
      INSERT INTO schema_migrations(version, name, applied_at_ms) VALUES (3, 'marker', 3);
    `)
    const runtime = await startBunRuntime(config)
    try {
      const database = new Database(config.sqlitePath)
      expect(database.query("SELECT value FROM startup_marker").get()).toEqual({ value: "migrated" })
      database.close()
      expect((await fetch(`${runtime.origin}/health`)).status).toBe(200)
    } finally {
      await runtime.close()
    }

    await Bun.write(join(config.migrationsDir, "0004_broken.sql"), "THIS IS NOT SQL")
    await expect(startBunRuntime({ ...config, port: 49173 })).rejects.toBeDefined()
    await expect(fetch("http://127.0.0.1:49173/health")).rejects.toBeDefined()
    await rm(directory, { recursive: true, force: true })
  })

  it("never overlaps process-owned maintenance ticks and waits for an active tick on close", async () => {
    let active = 0
    let maximum = 0
    let calls = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const maintenance = scheduleMaintenance(async () => {
      calls += 1
      active += 1
      maximum = Math.max(maximum, active)
      await blocked
      active -= 1
    }, 5)

    await Bun.sleep(25)
    expect(calls).toBe(1)
    expect(maximum).toBe(1)
    release()
    await maintenance.cancel()
    expect(active).toBe(0)
  })

  it("keeps SQLite authentication state across a process restart", async () => {
    const { directory, config } = await fixture()
    const first = await startBunRuntime(config)
    const claim = await fetch(`${first.origin}/api/dashboard/claim`, {
      method: "POST",
      headers: dashboardHeaders,
      body: JSON.stringify({ username: "owner", password: "valid password" })
    })
    expect(claim.status).toBe(200)
    const cookie = claim.headers.get("set-cookie")!.split(";", 1)[0]!
    await first.close()

    const second = await startBunRuntime(config)
    try {
      const session = await fetch(`${second.origin}/api/dashboard/session`, {
        headers: {
          cookie,
          host: "dashboard.example.com"
        }
      })
      expect(session.status).toBe(200)
      expect(await session.json()).toMatchObject({ authenticated: true, username: "owner" })
    } finally {
      await second.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("persists a size-capped disk LRU without storing logical cache keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oh-my-emby-bun-cache-"))
    const filename = join(directory, "cache.sqlite")
    const first = openBunResourceCache(filename, 5)
    const expiresAtMs = Date.now() + 60_000
    await Effect.runPromise(first.service.put("secret:first", {
      status: 200,
      headers: [["content-type", "image/png"]],
      body: new Uint8Array([1, 2, 3])
    }, expiresAtMs))
    await Bun.sleep(2)
    await Effect.runPromise(first.service.put("secret:second", {
      status: 200,
      headers: [["content-type", "image/png"]],
      body: new Uint8Array([4, 5, 6])
    }, expiresAtMs))
    first.close()

    const database = new Database(filename, { readonly: true })
    expect(JSON.stringify(database.query("SELECT key_hash FROM resource_cache").all())).not.toContain("secret")
    database.close()

    const second = openBunResourceCache(filename, 5)
    try {
      expect(await Effect.runPromise(second.service.get("secret:first"))).toBeNull()
      expect(await Effect.runPromise(second.service.get("secret:second"))).toMatchObject({
        status: 200,
        body: new Uint8Array([4, 5, 6])
      })
    } finally {
      second.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
