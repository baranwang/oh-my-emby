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

const migration = [
  await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text(),
  await Bun.file(new URL("../migrations/0002_dashboard_alignment.sql", import.meta.url)).text()
].join("\n")
const endpointInput = (host: string, id?: string) => ({
  ...(id === undefined ? {} : { id }),
  protocol: "https" as const,
  host,
  port: null,
  path: ""
})
const input = {
  name: "Home",
  endpoints: [endpointInput("one.example.com")],
  username: "alice",
  password: { _tag: "Set" as const, value: "secret" },
  userAgentPolicy: "fixed" as const,
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

  it("normalizes endpoints, preserves stable IDs, and fences order and User-Agent changes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerService
        const deduplicated = yield* service.create({
          ...input,
          endpoints: [
            endpointInput("ONE.example.com"),
            { protocol: "https", host: "one.example.com", port: 443, path: "/" }
          ]
        } as any)
        expect(deduplicated.endpoints).toHaveLength(1)
        expect(deduplicated.endpoints[0]).toMatchObject({
          host: "one.example.com",
          port: null,
          path: "",
          displayUrl: "https://one.example.com/"
        })

        const withTwo = yield* service.update(deduplicated.id, {
          ...input,
          endpoints: [endpointInput("one.example.com", deduplicated.endpoints[0]!.id), endpointInput("two.example.com")]
        })
        const endpointIds = withTwo.endpoints.map(({ id }) => id)
        expect(withTwo.generation).toBe(2)

        const renamed = yield* service.update(deduplicated.id, {
          ...input,
          name: "Renamed",
          endpoints: withTwo.endpoints.map(({ id, protocol, host, port, path }) => ({
            id,
            protocol,
            host,
            port,
            path
          }))
        })
        expect(renamed.generation).toBe(2)
        expect(renamed.endpoints.map(({ id }) => id)).toEqual(endpointIds)

        const reordered = yield* service.update(deduplicated.id, {
          ...input,
          endpoints: [...renamed.endpoints].reverse().map(({ id, protocol, host, port, path }) => ({
            id,
            protocol,
            host,
            port,
            path
          }))
        })
        expect(reordered.generation).toBe(3)
        expect(reordered.endpoints.map(({ id }) => id)).toEqual([...endpointIds].reverse())

        yield* service.persistResult(yield* service.beginRequest(deduplicated.id), {
          accessToken: "cached-token",
          upstreamUserId: "upstream-user-id"
        })
        const userAgentChanged = yield* service.update(deduplicated.id, {
          ...input,
          endpoints: reordered.endpoints.map(({ id, protocol, host, port, path }) => ({
            id,
            protocol,
            host,
            port,
            path
          })),
          userAgentPolicy: "client-preferred",
          userAgent: "Fallback/2"
        })
        expect(userAgentChanged.generation).toBe(4)
        const stored = yield* service.getRecord(deduplicated.id)
        expect(stored.accessToken).toBeNull()
        expect(stored.upstreamUserId).toBeNull()
      }).pipe(Effect.provide(layer(async () => Response.json({ Id: "catalog-id" }))))
    )
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

  it("tests every endpoint in order and makes only same-catalog endpoints eligible", async () => {
    const seen: Array<string> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      seen.push(request.url)
      if (request.url.includes("offline.example.com")) throw new TypeError("offline")
      if (request.url.endsWith("/Users/AuthenticateByName")) {
        return Response.json({ AccessToken: "token", User: { Id: "upstream-user-id" },
          ServerId: "stable-id"
        })
      }
      return Response.json({ Id: "stable-id" })
    }
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
        const configured = yield* service.update(created.id, {
          ...input,
          endpoints: [
            endpointInput("one.example.com", created.endpoints[0]!.id),
            endpointInput("offline.example.com"),
            endpointInput("two.example.com")
          ]
        })
        const result = yield* service.testConnection(created.id)
        expect(result).toEqual({ reachable: true, catalogId: "stable-id",
          endpoints: [
            {
              endpointId: configured.endpoints[0]!.id,
              reachable: true,
              catalogId: "stable-id",
              health: "healthy"
            },
            {
              endpointId: configured.endpoints[1]!.id,
              reachable: false,
              catalogId: null,
              health: "unknown"
            },
            {
              endpointId: configured.endpoints[2]!.id,
              reachable: true,
              catalogId: "stable-id",
              health: "healthy"
            }
          ]
        })
        const stored = yield* service.getRecord(created.id)
        expect(stored.endpoints.map(({ verifiedCatalogId, health }) => ({ verifiedCatalogId, health }))).toEqual([
          { verifiedCatalogId: "stable-id", health: "healthy" },
          { verifiedCatalogId: null, health: "unknown" },
          { verifiedCatalogId: "stable-id", health: "healthy" }
        ])
      }).pipe(Effect.provide(layer(fetch)))
    )
    expect(seen.filter((url) => url.endsWith("/Users/AuthenticateByName"))).toEqual([
      "https://one.example.com/Users/AuthenticateByName",
      "https://offline.example.com/Users/AuthenticateByName",
      "https://two.example.com/Users/AuthenticateByName"
    ])
  })

  it("keeps an unavailable endpoint as an ineligible connection-test warning", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerService
        const created = yield* service.create(input)
        const result = yield* service.testConnection(created.id)
        expect(result).toEqual({
          reachable: false,
          catalogId: null,
          endpoints: [
            {
              endpointId: created.endpoints[0]!.id,
              reachable: false,
              catalogId: null,
              health: "unknown"
            }
          ]
        })
        expect(yield* service.getRecord(created.id)).toMatchObject({
          health: "unknown",
          endpoints: [expect.objectContaining({ health: "unknown", verifiedCatalogId: null })]
        })
      }).pipe(Effect.provide(layer(async () => new Response(null, { status: 503 }))))
    )
  })

  it("rejects a reported catalog mismatch before persisting an update", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerService
        const created = yield* service.create(input)
        yield* service.testConnection(created.id)
        const before = yield* service.getRecord(created.id)

        expect((yield* Effect.flip(service.update(created.id, {
          ...input,
          endpoints: [
            endpointInput("one.example.com", created.endpoints[0]!.id),
            endpointInput("mismatch.example.com")
          ]
        })))._tag).toBe("CatalogIdentityMismatch")
        expect(yield* service.getRecord(created.id)).toEqual(before)
      }).pipe(Effect.provide(layer(async (input, init) => {
        const request = new Request(input, init)
        return Response.json({
          AccessToken: "token",
          User: { Id: "upstream-user-id" },
          ServerId: request.url.includes("mismatch.example.com") ? "different-id" : "stable-id"
        })
      })))
    )
  })

  it("saves an unreachable candidate endpoint as unverified and ineligible", async () => {
    const calls: Array<string> = []
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
      yield* service.testConnection(created.id)

      const updated = yield* service.update(created.id, {
        ...input,
        endpoints: [
          endpointInput("one.example.com", created.endpoints[0]!.id),
          endpointInput("offline.example.com")
        ]
      })
      expect(updated.endpoints[1]).toMatchObject({
        host: "offline.example.com",
        verifiedCatalogId: null,
        health: "unknown"
      })
    }).pipe(Effect.provide(layer(async (input, init) => {
      const request = new Request(input, init)
      calls.push(request.url)
      if (request.url.includes("offline.example.com")) return new Response(null, { status: 503 })
      return Response.json({
        AccessToken: "token",
        User: { Id: "upstream-user-id" },
        ServerId: "stable-id"
      })
    }))))
    expect(calls).toContain("https://offline.example.com/Users/AuthenticateByName")
  })

  it("does not let an identity-less endpoint replacement reuse its namespace", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* ServerService
      const created = yield* service.create(input)
      expect(yield* service.testConnection(created.id)).toMatchObject({ reachable: true, catalogId: null })
      yield* service.update(created.id, { ...input,
          endpoints: [endpointInput("two.example.com")]
        })
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
