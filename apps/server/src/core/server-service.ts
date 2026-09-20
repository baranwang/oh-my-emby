import type { ServerInput, ServerView, SourceLibraryView } from "@oh-my-emby/contracts"
import { Context, Effect, Layer } from "effect"

import {
  CatalogIdentityMismatch,
  CatalogIdentityUnverifiable,
  ObsoleteGeneration,
  ServerLimitExceeded,
  ServerNotFound,
  UpstreamUnavailable,
  type UpstreamFailure
} from "./errors.js"
import { MAX_CONFIGURED_UPSTREAMS } from "./limits.js"
import type { SaveServerResultCommand, UpstreamServer } from "./model.js"
import { Repositories } from "./repositories.js"
import { UpstreamClient, normalizeUpstreamBaseUrl } from "./upstream-client.js"

export interface ServerRequestFence {
  readonly serverId: string
  readonly generation: number
}

export interface ServerResult {
  readonly accessToken?: string | null
  readonly accessTokenExpiresAtMs?: number | null
  readonly verifiedCatalogId?: string | null
  readonly verifiedBaseUrl?: string | null
  readonly health?: UpstreamServer["health"]
  readonly lastSuccessAtMs?: number | null
}

export interface ConnectionTestResult {
  readonly reachable: boolean
  readonly catalogId: string | null
}

export interface ServerServiceApi {
  readonly list: () => Effect.Effect<ReadonlyArray<ServerView>, import("./errors.js").RepositoryError>
  readonly get: (serverId: string) => Effect.Effect<ServerView, ServerNotFound | import("./errors.js").RepositoryError>
  readonly getRecord: (
    serverId: string
  ) => Effect.Effect<UpstreamServer, ServerNotFound | import("./errors.js").RepositoryError>
  readonly create: (
    input: ServerInput
  ) => Effect.Effect<ServerView, ServerLimitExceeded | import("./errors.js").RepositoryError>
  readonly update: (
    serverId: string,
    input: ServerInput
  ) => Effect.Effect<ServerView, ObsoleteGeneration | ServerNotFound | import("./errors.js").RepositoryError>
  readonly delete: (
    serverId: string
  ) => Effect.Effect<void, ServerNotFound | import("./errors.js").RepositoryError>
  readonly beginRequest: (
    serverId: string
  ) => Effect.Effect<ServerRequestFence, ServerNotFound | import("./errors.js").RepositoryError>
  readonly persistResult: (
    request: ServerRequestFence,
    result: ServerResult
  ) => Effect.Effect<UpstreamServer, ObsoleteGeneration | import("./errors.js").RepositoryError>
  readonly testConnection: (
    serverId: string
  ) => Effect.Effect<ConnectionTestResult, UpstreamFailure>
  readonly listSourceLibraries: (
    serverId: string
  ) => Effect.Effect<ReadonlyArray<SourceLibraryView>, UpstreamFailure>
}

export class ServerService extends Context.Service<ServerService, ServerServiceApi>()(
  "oh-my-emby/ServerService"
) {}

const toView = (server: UpstreamServer): ServerView => ({
  id: server.id,
  name: server.name,
  baseUrl: server.baseUrl,
  username: server.username,
  hasPassword: server.password !== null,
  userAgent: server.userAgent,
  enabled: server.enabled,
  verifiedCatalogId: server.verifiedCatalogId,
  generation: server.generation,
  health: server.health
})

const nextPassword = (current: string | null, patch: ServerInput["password"]): string | null => {
  switch (patch._tag) {
    case "Preserve": return current
    case "Set": return patch.value
    case "Clear": return null
  }
}

export const makeServerServiceLayer: Layer.Layer<ServerService, never, Repositories | UpstreamClient> =
  Layer.effect(ServerService, Effect.gen(function*() {
    const repositories = yield* Repositories
    const upstream = yield* UpstreamClient

    const getRecord: ServerServiceApi["getRecord"] = (serverId) => repositories.getServer(serverId).pipe(
      Effect.flatMap((server) => server === null
        ? Effect.fail(new ServerNotFound({ serverId }))
        : Effect.succeed(server))
    )

    const list: ServerServiceApi["list"] = () => repositories.listServers().pipe(
      Effect.map((servers) => servers.map(toView))
    )

    const get: ServerServiceApi["get"] = (serverId) => getRecord(serverId).pipe(Effect.map(toView))

    const create: ServerServiceApi["create"] = (input) => Effect.gen(function*() {
      const servers = yield* repositories.listServers()
      if (servers.length >= MAX_CONFIGURED_UPSTREAMS) return yield* Effect.fail(new ServerLimitExceeded())
      const id = crypto.randomUUID()
      const nowMs = Date.now()
      const baseUrl = normalizeUpstreamBaseUrl(input.baseUrl)
      const saved = yield* repositories.saveServer({
        id: id as ServerView["id"],
        catalogNamespace: `catalog:${id}`,
        verifiedCatalogId: null,
        verifiedBaseUrl: null,
        generation: 1,
        name: input.name,
        baseUrl: baseUrl as ServerView["baseUrl"],
        username: input.username,
        password: input.password._tag === "Set" ? input.password.value : null,
        accessToken: null,
        accessTokenExpiresAtMs: null,
        userAgent: input.userAgent,
        enabled: input.enabled,
        health: "unknown",
        lastSuccessAtMs: null,
        deletedAtMs: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs
      })
      return toView(saved)
    })

    const update: ServerServiceApi["update"] = (serverId, input) => Effect.gen(function*() {
      const current = yield* getRecord(serverId)
      const baseUrl = normalizeUpstreamBaseUrl(input.baseUrl)
      const password = nextPassword(current.password, input.password)
      const authenticationChanged = baseUrl !== current.baseUrl ||
        input.username !== current.username || password !== current.password
      const saved = yield* repositories.saveServerConfiguration({
        ...current,
        generation: authenticationChanged ? current.generation + 1 : current.generation,
        name: input.name,
        baseUrl: baseUrl as ServerView["baseUrl"],
        username: input.username,
        password,
        accessToken: authenticationChanged ? null : current.accessToken,
        accessTokenExpiresAtMs: authenticationChanged ? null : current.accessTokenExpiresAtMs,
        userAgent: input.userAgent,
        enabled: input.enabled,
        health: authenticationChanged ? "unknown" : current.health,
        updatedAtMs: Date.now()
      }, current.generation)
      if (saved === null) return yield* Effect.fail(new ObsoleteGeneration({ serverId }))
      return toView(saved)
    })

    const remove: ServerServiceApi["delete"] = (serverId) => Effect.gen(function*() {
      yield* getRecord(serverId)
      yield* repositories.deleteServer(serverId)
    })

    const beginRequest: ServerServiceApi["beginRequest"] = (serverId) => getRecord(serverId).pipe(
      Effect.map((server) => ({ serverId: server.id, generation: server.generation }))
    )

    const persistResult: ServerServiceApi["persistResult"] = (request, result) => {
      const command: SaveServerResultCommand = {
        serverId: request.serverId,
        expectedGeneration: request.generation,
        updatedAtMs: Date.now(),
        ...(result.accessToken === undefined ? {} : { accessToken: result.accessToken }),
        ...(result.accessTokenExpiresAtMs === undefined ? {} : { accessTokenExpiresAtMs: result.accessTokenExpiresAtMs }),
        ...(result.verifiedCatalogId === undefined ? {} : { verifiedCatalogId: result.verifiedCatalogId }),
        ...(result.verifiedBaseUrl === undefined ? {} : { verifiedBaseUrl: result.verifiedBaseUrl }),
        ...(result.health === undefined ? {} : { health: result.health }),
        ...(result.lastSuccessAtMs === undefined ? {} : { lastSuccessAtMs: result.lastSuccessAtMs })
      }
      return repositories.saveServerResult(command).pipe(Effect.flatMap((saved) => saved === null
        ? Effect.fail(new ObsoleteGeneration({ serverId: request.serverId }))
        : Effect.succeed(saved)))
    }

    const testConnection: ServerServiceApi["testConnection"] = (serverId) => Effect.gen(function*() {
      const server = yield* getRecord(serverId)
      const fence = { serverId, generation: server.generation }
      const identity = yield* upstream.getServerIdentity(serverId)
      if (server.verifiedCatalogId !== null && identity !== server.verifiedCatalogId) {
        yield* persistResult(fence, { accessToken: null, health: "unknown" })
        return yield* Effect.fail(identity === null
          ? new CatalogIdentityUnverifiable({ serverId })
          : new CatalogIdentityMismatch({ serverId }))
      }
      if (
        identity === null &&
        server.verifiedBaseUrl !== null &&
        server.verifiedBaseUrl !== server.baseUrl
      ) {
        yield* persistResult(fence, { accessToken: null, health: "unknown" })
        return yield* Effect.fail(new CatalogIdentityUnverifiable({ serverId }))
      }
      yield* persistResult(fence, {
        verifiedCatalogId: identity,
        verifiedBaseUrl: server.baseUrl,
        health: "healthy",
        lastSuccessAtMs: Date.now()
      })
      return { reachable: true, catalogId: identity }
    })

    const listSourceLibraries: ServerServiceApi["listSourceLibraries"] = (serverId) => Effect.gen(function*() {
      const server = yield* getRecord(serverId)
      if (!server.enabled || server.health !== "healthy" || server.verifiedBaseUrl === null) {
        return yield* Effect.fail(new UpstreamUnavailable({ serverId }))
      }
      return yield* upstream.listSourceLibraries(serverId)
    })

    return ServerService.of({
      list,
      get,
      getRecord,
      create,
      update,
      delete: remove,
      beginRequest,
      persistResult,
      testConnection,
      listSourceLibraries
    })
  }))
