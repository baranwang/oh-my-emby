import { mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startBunRuntime, type BunRuntime } from "../src/platform/bun/index.js"

describe("Bun production routing", () => {
  let directory: string
  let runtime: BunRuntime

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-bun-routing-"))
    const assetsDir = join(directory, "dashboard")
    await Bun.write(join(assetsDir, "index.html"), "<main>dashboard</main>")
    await Bun.write(join(assetsDir, "assets", "app.js"), "console.log('dashboard')")
    await Bun.write(join(directory, "secret.txt"), "outside-secret")
    await symlink("../secret.txt", join(assetsDir, "leak.txt"))
    runtime = await startBunRuntime({
      hostname: "127.0.0.1",
      port: 0,
      sqlitePath: join(directory, "data.sqlite"),
      cachePath: join(directory, "cache.sqlite"),
      assetsDir,
      migrationsDir: new URL("../migrations", import.meta.url).pathname
    })
  })

  afterAll(async () => {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })

  const request = (path: string, init?: RequestInit) => fetch(`${runtime.origin}${path}`, init)

  it("never turns a missing hashed asset into index.html", async () => {
    const response = await request("/dashboard/assets/missing-abc123.js", {
      headers: { accept: "text/html,*/*" }
    })
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html")
  })

  it("keeps symlinked assets outside the Dashboard root as plain 404", async () => {
    const response = await request("/dashboard/leak.txt", {
      headers: { accept: "text/html,*/*" }
    })
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).not.toContain("text/html")
    expect(await response.text()).not.toContain("outside-secret")
  })

  it("redirects GET / to the dashboard", async () => {
    const response = await request("/", {
      redirect: "manual",
      headers: { accept: "text/html" }
    })
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/dashboard")

    const dashboard = await request("/dashboard", { headers: { accept: "text/html" } })
    expect(dashboard.status).toBe(200)
    expect(await dashboard.text()).toContain("<main>dashboard</main>")
  })

  it("serves the SPA only for GET and HEAD Dashboard navigations", async () => {
    const get = await request("/dashboard/servers", { headers: { accept: "text/html" } })
    expect(get.status).toBe(200)
    expect(await get.text()).toBe("<main>dashboard</main>")

    const head = await request("/dashboard/libraries", {
      method: "HEAD",
      headers: { accept: "text/html" }
    })
    expect(head.status).toBe(200)
    expect(head.headers.get("content-type")).toContain("text/html")
    expect(await head.text()).toBe("")

    const post = await request("/dashboard/servers", {
      method: "POST",
      headers: { accept: "text/html" }
    })
    expect(post.status).toBe(405)
    expect(post.headers.get("content-type")).not.toContain("text/html")
  })

  it.each([
    "/dashboard/%2e%2e%2fsecret",
    "/dashboard/%252e%252e%252fsecret",
    "/dashboard/assets/missing.css",
    "/api/dashboard/not-a-route",
    "/emby/not-a-route",
    "/not-a-route"
  ])("keeps %s misses non-HTML", async (path) => {
    const response = await request(path, { headers: { accept: "text/html" } })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html")
  })

  it("uses the preserved public Host and Origin for Dashboard cookies", async () => {
    const response = await request("/api/dashboard/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "dashboard.example.com",
        origin: "https://dashboard.example.com",
      },
      body: JSON.stringify({ username: "owner", password: "valid password" })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toMatch(/oh_my_emby_session=.*; Path=\/api\/dashboard;.* HttpOnly;.* Secure;.* SameSite=Lax/i)
  })

  it("ignores forwarded headers when the public Host was not preserved", async () => {
    const response = await runtime.handle(new Request("http://internal:3000/api/dashboard/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://dashboard.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "dashboard.example.com"
      },
      body: JSON.stringify({ username: "owner", password: "valid password" })
    }), "198.51.100.7")
    expect(response.status).toBe(403)
  })

  it("allows localhost HTTP only from a loopback socket", async () => {
    const localDirectory = await mkdtemp(join(tmpdir(), "oh-my-emby-local-http-"))
    const assetsDir = join(localDirectory, "dashboard")
    await Bun.write(join(assetsDir, "index.html"), "local")
    const local = await startBunRuntime({
      hostname: "127.0.0.1",
      port: 0,
      sqlitePath: join(localDirectory, "data.sqlite"),
      cachePath: join(localDirectory, "cache.sqlite"),
      assetsDir,
      migrationsDir: new URL("../migrations", import.meta.url).pathname
    })
    try {
      const request = new Request("http://localhost:3000/api/dashboard/bootstrap")
      expect((await local.handle(request, "127.0.0.1")).status).toBe(200)
      expect((await local.handle(request, "198.51.100.7")).status).toBe(403)
    } finally {
      await local.close()
      await rm(localDirectory, { recursive: true, force: true })
    }
  })
})
