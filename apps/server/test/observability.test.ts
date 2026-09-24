import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { makeObservability } from "../src/core/observability.js"
import { Repositories } from "../src/core/repositories.js"
import { UpstreamClient, makeUpstreamClientLayer } from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = [
  await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text(),
  await Bun.file(new URL("../migrations/0002_dashboard_alignment.sql", import.meta.url)).text()
].join("\n")
const JsonOk = Schema.Struct({ ok: Schema.Boolean })

describe("upstream observability", () => {
  it("emits only the structured allowlist and never serializes secrets", async () => {
    const records: Array<string> = []
    const observability = makeObservability((record) => records.push(JSON.stringify(record)))
    await Effect.runPromise(observability.upstreamRequest({
      requestId: "request-1",
      route: "/api/dashboard/servers/:id/test",
      serverId: "server-1",
      durationMs: 25,
      cacheOutcome: "miss",
      retryOutcome: "retried",
      failureCategory: "timeout",
      password: "secret-password",
      token: "secret-token",
      authorization: "Bearer secret-token",
      requestBody: { password: "secret-password" },
      rawUpstreamBody: "secret response",
      url: "https://example.com/video?api_key=secret-token"
    } as any))

    expect(records).toHaveLength(1)
    const parsed = JSON.parse(records[0]!)
    expect(parsed).toEqual({
      requestId: "request-1",
      route: "/api/dashboard/servers/:id/test",
      serverId: "server-1",
      durationMs: 25,
      cacheOutcome: "miss",
      retryOutcome: "retried",
      failureCategory: "timeout"
    })
    const serialized = records[0]!
    for (const forbidden of [
      "password", "token", "authorization", "requestBody", "rawUpstreamBody", "url",
      "secret-password", "secret-token", "secret response", "api_key"
    ]) expect(serialized).not.toContain(forbidden)
  })

  it("captures real successful and failed upstream requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oh-my-emby-observability-"))
    const filename = join(directory, "observability.sqlite")
    try {
      const database = new Database(filename)
      database.exec(migration)
      database.close()
      const repositories = makeSqliteRepositoriesLayer({ filename })
      await Effect.runPromise(Effect.gen(function*() {
        const repo = yield* Repositories
        yield* repo.saveServer({
          id: "server-1" as any,
          catalogNamespace: "catalog:server-1",
          verifiedCatalogId: "catalog-id",
          verifiedBaseUrl: "https://example.com",
          generation: 1,
          name: "Home",
            endpoints: ["example.com", "backup.example.com"].map((host, order) => ({
              id: `endpoint-${order + 1}`,
              protocol: "https" as const,
              host,
              port: null,
              path: "",
              displayUrl: `https://${host}` as any,
              verifiedCatalogId: "catalog-id",
              health: "healthy" as const,
              lastSuccessAtMs: 1_000,
              order,
              createdAtMs: 1_000,
              updatedAtMs: 1_000
            })),
            baseUrl: "https://example.com" as any,
          username: "alice",
          password: "secret",
          accessToken: "secret-token",
          accessTokenExpiresAtMs: null,
          upstreamUserId: "upstream-user-id",
            userAgentPolicy: "fixed",
            userAgent: "Agent/1",
          enabled: true,
          health: "healthy",
          lastSuccessAtMs: 1_000,
          deletedAtMs: null,
          createdAtMs: 1_000,
          updatedAtMs: 1_000
        })
      }).pipe(Effect.provide(repositories)))

      const records: Array<Record<string, unknown>> = []
      const observability = makeObservability((record) => records.push(record as any))
      const fetch: typeof globalThis.fetch = async (input) => {
        const url = new URL(new Request(input).url)
        const path = url.pathname
        if (path.endsWith("/success")) {
          if (url.hostname === "example.com") throw new TypeError("transient")
          return Response.json({ ok: true })
        }
        return new Response(null, { status: 500 })
      }
      const client = makeUpstreamClientLayer({
        fetch,
        destinationPolicy: { platform: "workers" },
        observability
      }).pipe(Layer.provide(repositories))
      await Effect.runPromise(Effect.gen(function*() {
        const upstream = yield* UpstreamClient
        yield* upstream.request({
          serverId: "server-1",
          generation: 1,
          path: "/success?api_key=must-not-log",
          method: "GET"
        }, JsonOk)
        yield* upstream.request({
          serverId: "server-1",
          generation: 1,
          path: "/failed?api_key=must-not-log",
          method: "GET"
        }, JsonOk).pipe(Effect.flip)
      }).pipe(Effect.provide(client)))

      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({
        route: "/success",
        serverId: "server-1",
        cacheOutcome: "bypass",
        retryOutcome: "retried",
        failureCategory: "none"
      })
      expect(records[1]).toMatchObject({
        route: "/failed",
        serverId: "server-1",
        cacheOutcome: "bypass",
        retryOutcome: "failed",
        failureCategory: "UpstreamRejected"
      })
      for (const record of records) {
        expect(record.requestId).toEqual(expect.any(String))
        expect(record.durationMs).toEqual(expect.any(Number))
        expect(JSON.stringify(record)).not.toContain("api_key")
        expect(JSON.stringify(record)).not.toContain("must-not-log")
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
