import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import * as Dashboard from "../src/api/dashboard.js"
import { UpstreamNotFound } from "../src/core/errors.js"
import { Repositories } from "../src/core/repositories.js"
import { ServerService, makeServerServiceLayer } from "../src/core/server-service.js"
import { UpstreamClient, makeUpstreamClientLayer } from "../src/core/upstream-client.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"
import {
  authorizeDashboardControlRequest,
  makeDashboardRequestPolicy
} from "../src/api/dashboard.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()
const input = {
  name: "Home",
  baseUrl: "https://one.example.com" as any,
  username: "alice",
  password: { _tag: "Set" as const, value: "secret" },
  userAgent: "Agent/1",
  enabled: true
}

describe("ServerService", () => {
  let directory: string
  let filename: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-server-service-"))
    filename = join(directory, "server.sqlite")
    const database = new Database(filename)
    database.exec(migration)
    database.close()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const layer = (fetch: typeof globalThis.fetch) => {
    const repositories = makeSqliteRepositoriesLayer({ filename })
    const upstream = makeUpstreamClientLayer({
      fetch,
      destinationPolicy: { platform: "workers" }
    }).pipe(Layer.provide(repositories))
    return makeServerServiceLayer.pipe(Layer.provide(Layer.merge(repositories, upstream)))
  }

  it("increments generation, clears authentication, and rejects obsolete persistence", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
      const request = yield* service.beginRequest(created.id)
      yield* service.persistResult(request, {
        accessToken: "cached-token",
        upstreamUserId: "upstream-user-id",
        health: "healthy"
      })
      const changed = yield* service.update(created.id, {
        ...input,
        username: "bob",
        password: { _tag: "Set", value: "new-secret" }
      })
      expect(changed.generation).toBe(2)
      const stored = yield* service.getRecord(created.id)
      expect(stored.accessToken).toBeNull()
      expect(stored.upstreamUserId).toBeNull()
      expect((yield* Effect.flip(service.persistResult(request, { health: "healthy" })))._tag)
        .toBe("ObsoleteGeneration")
    }).pipe(Effect.provide(layer(async () => Response.json({ Id: "catalog-id" })))))
  })

  it("increments generation and clears authentication and health when enabled changes", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
      const request = yield* service.beginRequest(created.id)
      yield* service.persistResult(request, {
        accessToken: "cached-token",
        upstreamUserId: "upstream-user-id",
        health: "healthy"
      })
      const changed = yield* service.update(created.id, { ...input, enabled: false })
      expect(changed.generation).toBe(2)
      expect(changed.health).toBe("unknown")
      const stored = yield* service.getRecord(created.id)
      expect(stored.accessToken).toBeNull()
      expect(stored.upstreamUserId).toBeNull()
      expect((yield* Effect.flip(service.persistResult(request, { health: "healthy" })))._tag)
        .toBe("ObsoleteGeneration")
    }).pipe(Effect.provide(layer(async () => Response.json({ Id: "catalog-id" })))))
  })

  it("enforces the ten-server ceiling atomically across concurrent creates", async () => {
    const repositories = makeSqliteRepositoriesLayer({ filename })
    const upstream = makeUpstreamClientLayer({
      fetch: async () => Response.json({ Id: "unused" }),
      destinationPolicy: { platform: "workers" }
    }).pipe(Layer.provide(repositories))
    const initialService = makeServerServiceLayer.pipe(Layer.provide(Layer.merge(repositories, upstream)))
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      for (let index = 0; index < 9; index++) {
        yield* service.create({ ...input, name: `Server ${index}` })
      }
    }).pipe(Effect.provide(initialService)))

    let arrivals = 0
    let gating = true
    let release = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gatedRepositories = Layer.effect(Repositories, Effect.gen(function*() {
      const base = yield* Repositories
      return Repositories.of({
        ...base,
        listServers: () => base.listServers().pipe(Effect.tap(() => gating
          ? Effect.promise(() => {
            arrivals++
            if (arrivals === 2) release()
            return gate
          })
          : Effect.void))
      })
    })).pipe(Layer.provide(repositories))
    const gatedUpstream = makeUpstreamClientLayer({
      fetch: async () => Response.json({ Id: "unused" }),
      destinationPolicy: { platform: "workers" }
    }).pipe(Layer.provide(gatedRepositories))
    const concurrentService = makeServerServiceLayer.pipe(
      Layer.provide(Layer.merge(gatedRepositories, gatedUpstream))
    )
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const outcomes = yield* Effect.all([
        service.create({ ...input, name: "Concurrent A" }).pipe(Effect.result),
        service.create({ ...input, name: "Concurrent B" }).pipe(Effect.result)
      ], { concurrency: "unbounded" })
      gating = false
      expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1)
      expect(outcomes.filter((outcome) =>
        outcome._tag === "Failure" && outcome.failure._tag === "ServerLimitExceeded"
      )).toHaveLength(1)
      expect(yield* service.list()).toHaveLength(10)
    }).pipe(Effect.provide(concurrentService)))
  })

  it("maps an upstream 404 to the public upstream rejection shape", () => {
    const publicFailure = (Dashboard as any).publicFailure
    expect(publicFailure).toBeTypeOf("function")
    const response = publicFailure(new UpstreamNotFound({ serverId: "server-1" }))
    expect(response.status).toBe(404)
    expect(response.body._tag).toBe("Uint8Array")
    if (response.body._tag !== "Uint8Array") throw new Error("expected encoded JSON response")
    expect(JSON.parse(new TextDecoder().decode(response.body.body))).toEqual({
      _tag: "UpstreamRejected",
      serverId: "server-1",
      status: 404
    })
  })

  it("requires both the origin guard and dashboard authentication for control-plane mutations", async () => {
    const policy = makeDashboardRequestPolicy({
      publicOrigin: "https://dashboard.example.com",
      trustedProxyAddresses: []
    })
    const authenticate = (token: string) => token === "valid"
      ? Effect.succeed({ username: "owner" })
      : Effect.fail({ _tag: "InvalidCredentials" as const })
    const request = {
      method: "POST",
      requestUrl: "https://dashboard.example.com/api/dashboard/servers",
      remoteAddress: "198.51.100.4",
      headers: { origin: "https://dashboard.example.com" }
    }
    await expect(Effect.runPromise(authorizeDashboardControlRequest(
      policy,
      { ...request, headers: { origin: "https://evil.example.com" } },
      "valid",
      authenticate
    ))).rejects.toMatchObject({ _tag: "ForbiddenOrigin" })
    await expect(Effect.runPromise(authorizeDashboardControlRequest(
      policy,
      request,
      undefined,
      authenticate
    ))).rejects.toMatchObject({ _tag: "InvalidCredentials" })
    await expect(Effect.runPromise(authorizeDashboardControlRequest(
      policy,
      request,
      "valid",
      authenticate
    ))).resolves.toMatchObject({ principal: { username: "owner" } })
  })

  it("keeps an edited endpoint ineligible until the stable catalog identity matches", async () => {
    const seen: Array<string> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      seen.push(request.url)
      if (request.url.endsWith("/Users/AuthenticateByName")) {
        return Response.json({ AccessToken: "token", User: { Id: "upstream-user-id" } })
      }
      return Response.json({ Id: request.url.includes("two.example.com") ? "different-id" : "stable-id" })
    }
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
      expect(yield* service.testConnection(created.id)).toEqual({ reachable: true, catalogId: "stable-id" })
      yield* service.update(created.id, { ...input, baseUrl: "https://two.example.com" as any })
      expect((yield* service.get(created.id)).health).toBe("unknown")
      expect((yield* Effect.flip(service.testConnection(created.id)))._tag).toBe("CatalogIdentityMismatch")
      expect((yield* service.get(created.id)).health).toBe("unknown")
    }).pipe(Effect.provide(layer(fetch))))
    expect(seen.some((url) => url.startsWith("https://two.example.com/"))).toBe(true)
  })

  it("does not let an identity-less endpoint replacement reuse its namespace", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
      expect(yield* service.testConnection(created.id)).toEqual({ reachable: true, catalogId: null })
      yield* service.update(created.id, { ...input, baseUrl: "https://two.example.com" as any })
      expect((yield* Effect.flip(service.testConnection(created.id)))._tag).toBe("CatalogIdentityUnverifiable")
    }).pipe(Effect.provide(layer(async (input) => {
      const url = new Request(input).url
      return url.endsWith("/Users/AuthenticateByName")
        ? Response.json({ AccessToken: "token", User: { Id: "upstream-user-id" } })
        : Response.json({ ServerName: "No stable ID" })
    }))))
  })

  it("keeps source-library IDs stable when display names change", async () => {
    let name = "Movies"
    const fetch: typeof globalThis.fetch = async (request) => {
      const url = new Request(request).url
      if (url.endsWith("/Users/AuthenticateByName")) {
        return Response.json({ AccessToken: "token", User: { Id: "upstream-user-id" } })
      }
      if (url.endsWith("/Library/VirtualFolders")) {
        return Response.json([{ ItemId: "library-stable", Name: name, CollectionType: "movies" }])
      }
      return Response.json({ Id: "stable-id" })
    }
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
      yield* service.testConnection(created.id)
      const first = yield* service.listSourceLibraries(created.id)
      name = "Renamed Movies"
      const second = yield* service.listSourceLibraries(created.id)
      expect(first[0]?.id).toBe("library-stable")
      expect(second[0]?.id).toBe("library-stable")
      expect(second[0]?.name).toBe("Renamed Movies")
    }).pipe(Effect.provide(layer(fetch))))
  })

  it("removes a server from control-plane CRUD without deleting its retained row", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
      yield* service.delete(created.id)
      expect(yield* service.list()).toEqual([])
    }).pipe(Effect.provide(layer(async () => Response.json({ Id: "unused" })))))
    const database = new Database(filename)
    expect(database.query("SELECT enabled, deleted_at_ms FROM upstream_servers").get()).toEqual({
      enabled: 0,
      deleted_at_ms: expect.any(Number)
    })
    database.close()
  })
})
