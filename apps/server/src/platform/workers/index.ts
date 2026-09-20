import { DashboardApi } from "@oh-my-emby/contracts"
import { Effect, Layer, Option } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { ApplicationServices, routeApplication } from "../../api/application.js"
import {
  makeDashboardAuthLayers,
  makeDashboardControlPlaneLayers,
  toDashboardWebResponse
} from "../../api/dashboard.js"
import { makeEmbyHandler } from "../../api/emby.js"
import { Auth, makeAuthLayer } from "../../core/auth.js"
import { Federation, makeFederationLayer } from "../../core/federation.js"
import { Identity, makeIdentityLayer } from "../../core/identity.js"
import { LibraryService, makeLibraryServiceLayer } from "../../core/library-service.js"
import { ResourceCache, runMaintenance } from "../../core/maintenance.js"
import { Outbox, makeOutboxLayer } from "../../core/outbox.js"
import { Playback, makePlaybackLayer } from "../../core/playback.js"
import { Repositories } from "../../core/repositories.js"
import { ServerService, makeServerServiceLayer } from "../../core/server-service.js"
import { UpstreamClient, makeUpstreamClientLayer } from "../../core/upstream-client.js"
import { UserState, makeUserStateLayer } from "../../core/user-state.js"
import { serveDashboardAsset } from "./assets.js"
import { makeWorkersResourceCache, type WorkersCacheBinding } from "./cache.js"
import { makeD1RepositoriesLayer } from "./d1-repositories.js"

export const parseTrustedProxyAddresses = (value: string): ReadonlyArray<string> =>
  value.split(",").map((address) => address.trim()).filter((address) => address !== "")

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
const resourceCacheName = "oh-my-emby-resources"

const requestRemoteAddress = (request: Request, publicOrigin: string): Option.Option<string> => {
  const publicHostname = new URL(publicOrigin).hostname.toLowerCase()
  if (loopbackHostnames.has(publicHostname)) return Option.some("127.0.0.1")
  const connectedAddress = request.headers.get("cf-connecting-ip")?.trim()
  return connectedAddress === undefined || connectedAddress === ""
    ? Option.none()
    : Option.some(connectedAddress)
}

export const makeWorkersCoreLayer = (env: Pick<Env, "DB">) => {
  const repositories = makeD1RepositoriesLayer(env.DB)
  const upstream = makeUpstreamClientLayer({
    fetch,
    destinationPolicy: { platform: "workers" }
  }).pipe(Layer.provide(repositories))
  const identity = makeIdentityLayer.pipe(Layer.provide(repositories))
  const foundation = Layer.mergeAll(repositories, upstream, identity)
  const federation = makeFederationLayer().pipe(Layer.provide(foundation))
  const auth = makeAuthLayer().pipe(Layer.provide(repositories))
  const userState = makeUserStateLayer().pipe(Layer.provide(repositories))
  const serverService = makeServerServiceLayer.pipe(Layer.provide(foundation))
  const libraryService = makeLibraryServiceLayer.pipe(Layer.provide(foundation))
  const playback = makePlaybackLayer().pipe(
    Layer.provide(Layer.merge(foundation, federation))
  )
  const outbox = makeOutboxLayer().pipe(Layer.provide(foundation))
  return Layer.mergeAll(
    foundation,
    federation,
    auth,
    userState,
    serverService,
    libraryService,
    playback,
    outbox
  )
}

const makeWorkersRuntimeLayer = (env: Env, workersCache: WorkersCacheBinding) => {
  const core = makeWorkersCoreLayer(env)
  const cache = Layer.succeed(ResourceCache, ResourceCache.of(makeWorkersResourceCache(workersCache)))
  const dashboardConfig = {
    publicOrigin: env.PUBLIC_ORIGIN,
    trustedProxyAddresses: parseTrustedProxyAddresses(env.TRUSTED_PROXIES)
  }
  const dashboard = Layer.merge(
    makeDashboardAuthLayers(dashboardConfig),
    makeDashboardControlPlaneLayers(dashboardConfig)
  ).pipe(Layer.provide(core))
  return Layer.mergeAll(core, cache, dashboard, HttpServer.layerServices)
}

const internalFailure = (error: unknown): Response => {
  console.error(JSON.stringify({
    message: "worker request failed",
    error: error instanceof Error ? error.message : String(error)
  }))
  return Response.json({ error: { code: "Internal", message: "Internal server error" } }, { status: 500 })
}

export const runWorkerRequest = async (
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> => {
  const workersCache = await caches.open(resourceCacheName)
  const program = Effect.scoped(Effect.gen(function*() {
    const dashboardHandler = yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(DashboardApi))
    const auth = yield* Auth
    const federation = yield* Federation
    const userState = yield* UserState
    const libraries = yield* LibraryService
    const playback = yield* Playback
    const resourceCache = yield* ResourceCache
    const dashboardRequest = HttpServerRequest.fromWeb(request).modify({
      remoteAddress: requestRemoteAddress(request, env.PUBLIC_ORIGIN)
    })
    const services = ApplicationServices.of({
      handleDashboard: () => toDashboardWebResponse(dashboardHandler, request, dashboardRequest),
      handleEmby: makeEmbyHandler({
        config: { serverId: "oh-my-emby", serverName: "oh-my-emby", version: "0.0.0" },
        now: Date.now,
        auth,
        federation,
        userState,
        libraries,
        playback,
        resourceCache
      }),
      handleDashboardAsset: (assetRequest) => serveDashboardAsset(assetRequest, env.ASSETS)
    })
    return yield* routeApplication(request).pipe(
      Effect.provideService(ApplicationServices, services)
    )
  })).pipe(Effect.provide(makeWorkersRuntimeLayer(env, workersCache)))
  return Effect.runPromise(program).catch(internalFailure)
}

export const runWorkerMaintenance = async (scheduledTime: number, env: Env): Promise<void> => {
  const workersCache = await caches.open(resourceCacheName)
  const cache = Layer.succeed(ResourceCache, ResourceCache.of(makeWorkersResourceCache(workersCache)))
  const program = runMaintenance(scheduledTime).pipe(
    Effect.asVoid,
    Effect.provide(Layer.merge(makeWorkersCoreLayer(env), cache))
  )
  await Effect.runPromise(program)
}

export default {
  fetch(request, env, ctx) {
    return runWorkerRequest(request, env, ctx)
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runWorkerMaintenance(controller.scheduledTime, env))
  }
} satisfies ExportedHandler<Env>
