import type {
  ConnectionTestView,
  ServerEndpointInput,
  ServerEndpointView,
  ServerInput, ServerView, SourceLibraryView } from "@oh-my-emby/contracts"
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
import type { SaveServerResultCommand, UpstreamEndpoint, UpstreamServer } from "./model.js"
import { Repositories } from "./repositories.js"
import { UpstreamClient, endpointUrl, normalizeUpstreamBaseUrl } from "./upstream-client.js"

export interface ServerRequestFence {
  readonly serverId: string
  readonly generation: number
}

export interface ServerResult {
  readonly accessToken?: string | null
  readonly accessTokenExpiresAtMs?: number | null
  readonly upstreamUserId?: string | null
  readonly verifiedCatalogId?: string | null
  readonly verifiedBaseUrl?: string | null
  readonly health?: UpstreamServer["health"]
  readonly lastSuccessAtMs?: number | null
}

export type ConnectionTestResult = ConnectionTestView

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
    serverId: string,
    includeDiagnostic?: boolean
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
  endpoints: server.endpoints,
  username: server.username,
  hasPassword: server.password !== null,
  userAgentPolicy: server.userAgentPolicy,
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

const normalizedEndpoint = (
  input: ServerEndpointInput,
  order: number,
  nowMs: number,
  current: ReadonlyArray<UpstreamEndpoint> = []
): UpstreamEndpoint => {
  const url = endpointUrl(input)
  const displayUrl = normalizeUpstreamBaseUrl(url.href)
  const byId = input.id === undefined ? undefined : current.find(({ id }) => id === input.id)
  const existing =
    byId ?? current.find((endpoint) => normalizeUpstreamBaseUrl(endpointUrl(endpoint).href) === displayUrl)
  const unchanged = existing !== undefined && normalizeUpstreamBaseUrl(endpointUrl(existing).href) === displayUrl
  return {
    id: existing?.id ?? crypto.randomUUID(),
    protocol: url.protocol.slice(0, -1) as UpstreamEndpoint["protocol"],
    host: url.hostname,
    port: url.port === "" ? null : Number(url.port),
    path: url.pathname === "/" ? "" : url.pathname,
    displayUrl: displayUrl as ServerEndpointView["displayUrl"],
    verifiedCatalogId: unchanged ? existing.verifiedCatalogId : null,
    health: unchanged ? existing.health : "unknown",
    lastSuccessAtMs: unchanged ? existing.lastSuccessAtMs : null,
    order,
    createdAtMs: existing?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs
  }
}

const normalizedEndpoints = (
  input: ReadonlyArray<ServerEndpointInput>,
  nowMs: number,
  current: ReadonlyArray<UpstreamEndpoint> = []
): ReadonlyArray<UpstreamEndpoint> => {
  const seen = new Set<string>()
  return input.flatMap((endpoint, index) => {
    const normalized = normalizedEndpoint(endpoint, index, nowMs, current)
    if (seen.has(normalized.displayUrl)) return []
    seen.add(normalized.displayUrl)
    return [{ ...normalized, order: seen.size - 1 }]
  })
}

const endpointOrder = (endpoints: ReadonlyArray<UpstreamEndpoint>): string =>
  endpoints.map((endpoint) => normalizeUpstreamBaseUrl(endpointUrl(endpoint).href)).join("\0")

const aggregateHealth = (endpoints: ReadonlyArray<UpstreamEndpoint>): UpstreamServer["health"] =>
  endpoints.some(({ health }) => health === "healthy")
    ? "healthy"
    : endpoints.some(({ health, verifiedCatalogId }) => health === "degraded" || verifiedCatalogId !== null)
      ? "degraded"
      : "unknown"

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
      const id = crypto.randomUUID()
      const nowMs = Date.now()
      const endpoints = normalizedEndpoints(input.endpoints, nowMs)
      const saved = yield* repositories.createServer({
        id: id as ServerView["id"],
        catalogNamespace: `catalog:${id}`,
        verifiedCatalogId: null,
        verifiedBaseUrl: null,
        generation: 1,
        name: input.name,
            endpoints,
            baseUrl: endpoints[0]!.displayUrl,
        username: input.username,
        password: input.password._tag === "Set" ? input.password.value : null,
        accessToken: null,
        accessTokenExpiresAtMs: null,
        upstreamUserId: null,
            userAgentPolicy: input.userAgentPolicy,
            userAgent: input.userAgent,
        enabled: input.enabled,
        health: "unknown",
        lastSuccessAtMs: null,
        deletedAtMs: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs
      }, MAX_CONFIGURED_UPSTREAMS)
      if (saved === null) return yield* Effect.fail(new ServerLimitExceeded())
      return toView(saved)
    })

    const update: ServerServiceApi["update"] = (serverId, input) => Effect.gen(function*() {
      const current = yield* getRecord(serverId)
      const nowMs = Date.now()
        const endpoints = normalizedEndpoints(input.endpoints, nowMs, current.endpoints)
      const password = nextPassword(current.password, input.password)
      const authenticationChanged =
          endpointOrder(endpoints) !== endpointOrder(current.endpoints) ||
        input.username !== current.username || password !== current.password
      const generationChanged = authenticationChanged || input.enabled !== current.enabled ||
          input.userAgentPolicy !== current.userAgentPolicy ||
          input.userAgent !== current.userAgent
        const saved = yield* repositories.saveServerConfiguration({
        ...current,
        generation: generationChanged ? current.generation + 1 : current.generation,
        name: input.name,
            endpoints,
            baseUrl: endpoints[0]!.displayUrl,
        username: input.username,
        password,
        accessToken: generationChanged ? null : current.accessToken,
        accessTokenExpiresAtMs: generationChanged ? null : current.accessTokenExpiresAtMs,
        upstreamUserId: generationChanged ? null : current.upstreamUserId,
            userAgentPolicy: input.userAgentPolicy,
            userAgent: input.userAgent,
        enabled: input.enabled,
        health: generationChanged ? "unknown" : current.health,
        lastSuccessAtMs: generationChanged ? null : current.lastSuccessAtMs,
        updatedAtMs: nowMs
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
        ...(result.upstreamUserId === undefined ? {} : { upstreamUserId: result.upstreamUserId }),
        ...(result.verifiedCatalogId === undefined ? {} : { verifiedCatalogId: result.verifiedCatalogId }),
        ...(result.verifiedBaseUrl === undefined ? {} : { verifiedBaseUrl: result.verifiedBaseUrl }),
        ...(result.health === undefined ? {} : { health: result.health }),
        ...(result.lastSuccessAtMs === undefined ? {} : { lastSuccessAtMs: result.lastSuccessAtMs })
      }
      return repositories.saveServerResult(command).pipe(Effect.flatMap((saved) => saved === null
        ? Effect.fail(new ObsoleteGeneration({ serverId: request.serverId }))
        : Effect.succeed(saved)))
    }

    const testConnection: ServerServiceApi["testConnection"] = (serverId, includeDiagnostic = false) => Effect.gen(function*() {
      const server = yield* getRecord(serverId)
      const fence = { serverId, generation: server.generation }
        let catalogId = server.verifiedCatalogId
        let verifiedBaseUrl = server.verifiedBaseUrl
        let rejection: UpstreamFailure | undefined
        const nowMs = Date.now()
        const results: Array<ConnectionTestView["endpoints"][number]> = []
        const endpoints: Array<UpstreamEndpoint> = []
        for (const endpoint of server.endpoints) {
          const attempted = yield* upstream.getServerIdentity(serverId, includeDiagnostic, endpoint.id)
            .pipe(Effect.result)
          if (attempted._tag === "Failure") {
            const previouslyVerified =
              endpoint.verifiedCatalogId !== null ||
              (server.verifiedCatalogId === null && server.verifiedBaseUrl === endpoint.displayUrl)
            const health = previouslyVerified ? ("degraded" as const) : ("unknown" as const)
            endpoints.push({ ...endpoint, health, updatedAtMs: nowMs })
            results.push({ endpointId: endpoint.id, reachable: false, catalogId: null, health })
            if (
              attempted.failure._tag !== "UpstreamUnavailable" &&
              attempted.failure._tag !== "UpstreamTimeout" &&
              !(
                attempted.failure._tag === "UpstreamRejected" && [500, 502, 503, 504].includes(attempted.failure.status)
              )
            ) {
              rejection ??= attempted.failure
            }
            continue
          }
          const identity = attempted.success
          if (catalogId === null && identity !== null) catalogId = identity
          const sameCatalog =
            identity !== null
              ? identity === catalogId
              : catalogId === null && (verifiedBaseUrl === null || verifiedBaseUrl === endpoint.displayUrl)
          if (!sameCatalog) {
            endpoints.push({
              ...endpoint,
              verifiedCatalogId: null, health: "degraded",
              lastSuccessAtMs: null,
              updatedAtMs: nowMs
            })
            results.push({
              endpointId: endpoint.id,
              reachable: true,
              catalogId: identity,
              health: "degraded"
            })
            rejection ??=
              identity === null
          ? new CatalogIdentityUnverifiable({ serverId })
          : new CatalogIdentityMismatch({ serverId })
            continue
          }
          verifiedBaseUrl ??= endpoint.displayUrl
          endpoints.push({
            ...endpoint,
            verifiedCatalogId: identity,
            health: "healthy",
            lastSuccessAtMs: nowMs,
            updatedAtMs: nowMs
          })
          results.push({
            endpointId: endpoint.id,
            reachable: true,
            catalogId: identity,
            health: "healthy"
          })
        }
        const health = aggregateHealth(endpoints)
        const latest = yield* getRecord(serverId)
        if (latest.generation !== fence.generation) {
          return yield* Effect.fail(new ObsoleteGeneration({ serverId }))
      }
        const saved = yield* repositories.saveServerConfiguration(
          {
            ...latest,
            endpoints,
            baseUrl: endpoints[0]!.displayUrl,
            verifiedCatalogId: catalogId,
        verifiedBaseUrl,
            accessToken: rejection === undefined ? latest.accessToken : null,
            accessTokenExpiresAtMs: rejection === undefined ? latest.accessTokenExpiresAtMs : null,
            upstreamUserId: rejection === undefined ? latest.upstreamUserId : null,
            health,
            lastSuccessAtMs: health === "healthy" ? nowMs : latest.lastSuccessAtMs,
            updatedAtMs: nowMs
          },
          fence.generation
        )
        if (saved === null) return yield* Effect.fail(new ObsoleteGeneration({ serverId }))
        if (rejection !== undefined) return yield* Effect.fail(rejection)
        return { reachable: results.some(({ reachable }) => reachable), catalogId,
          endpoints: results
        }
    })

    const listSourceLibraries: ServerServiceApi["listSourceLibraries"] = (serverId) => Effect.gen(function*() {
      const server = yield* getRecord(serverId)
      if (!server.enabled || server.health !== "healthy" ||
          !server.endpoints.some(
            ({ health, verifiedCatalogId }) => health === "healthy" && verifiedCatalogId === server.verifiedCatalogId
          )
        ) {
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
