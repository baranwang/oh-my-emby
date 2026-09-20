import { BunRuntime as EffectBunRuntime } from "@effect/platform-bun"
import { dirname, join, resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { DashboardApi } from "@oh-my-emby/contracts"
import { ApplicationServices, routeApplication } from "../../api/application.js"
import {
  makeDashboardAuthLayers,
  makeDashboardControlPlaneLayers,
  toDashboardWebResponse
} from "../../api/dashboard.js"
import { makeEmbyHandler } from "../../api/emby.js"
import { Auth, makeAuthLayer } from "../../core/auth.js"
import { Federation, makeFederationLayer } from "../../core/federation.js"
import { makeIdentityLayer } from "../../core/identity.js"
import { LibraryService, makeLibraryServiceLayer } from "../../core/library-service.js"
import { ResourceCache, runMaintenance } from "../../core/maintenance.js"
import { makeOutboxLayer } from "../../core/outbox.js"
import { Playback, makePlaybackLayer } from "../../core/playback.js"
import { Repositories } from "../../core/repositories.js"
import { makeServerServiceLayer } from "../../core/server-service.js"
import { makeUpstreamClientLayer } from "../../core/upstream-client.js"
import { UserState, makeUserStateLayer } from "../../core/user-state.js"
import { serveDashboardAsset } from "./assets.js"
import { openBunResourceCache } from "./cache.js"
import { applySqliteMigrations, makeSqliteRepositoriesLayer } from "./sqlite-repositories.js"

export const BUN_MAINTENANCE_INTERVAL_MS = 5 * 60_000

export interface BunRuntimeConfig {
  readonly hostname: string
  readonly port: number
  readonly publicOrigin: string
  readonly trustedProxyAddresses: ReadonlyArray<string>
  readonly administratorPrivateHosts: ReadonlyArray<string>
  readonly registeredResourceOrigins: ReadonlyArray<string>
  readonly sqlitePath: string
  readonly cachePath: string
  readonly assetsDir: string
  readonly migrationsDir: string
}

export interface BunRuntime {
  readonly origin: string
  readonly handle: (request: Request, remoteAddress?: string) => Promise<Response>
  readonly close: () => Promise<void>
}

export interface MaintenanceTimer {
  readonly cancel: () => Promise<void>
}

export const scheduleMaintenance = (
  run: () => Promise<void>,
  everyMs = BUN_MAINTENANCE_INTERVAL_MS
): MaintenanceTimer => {
  let current: Promise<void> | null = null
  const timer = setInterval(() => {
    if (current !== null) return
    current = run().catch((error) => {
      console.error(JSON.stringify({
        message: "Bun maintenance failed",
        error: error instanceof Error ? error.message : String(error)
      }))
    }).finally(() => {
      current = null
    })
  }, everyMs)
  timer.unref()
  return {
    cancel: async () => {
      clearInterval(timer)
      await current
    }
  }
}

const makeBunCoreLayer = (config: BunRuntimeConfig) => {
  const repositories = makeSqliteRepositoriesLayer({ filename: config.sqlitePath })
  const upstream = makeUpstreamClientLayer({
    fetch,
    destinationPolicy: {
      platform: "docker",
      administratorPrivateHosts: config.administratorPrivateHosts,
      registeredResourceOrigins: config.registeredResourceOrigins
    }
  }).pipe(Layer.provide(repositories))
  const identity = makeIdentityLayer.pipe(Layer.provide(repositories))
  const foundation = Layer.mergeAll(repositories, upstream, identity)
  const federation = makeFederationLayer().pipe(Layer.provide(foundation))
  const auth = makeAuthLayer().pipe(Layer.provide(repositories))
  const userState = makeUserStateLayer().pipe(Layer.provide(repositories))
  const serverService = makeServerServiceLayer.pipe(Layer.provide(foundation))
  const libraryService = makeLibraryServiceLayer.pipe(Layer.provide(foundation))
  const playback = makePlaybackLayer().pipe(Layer.provide(Layer.merge(foundation, federation)))
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

const makeBunLayer = (config: BunRuntimeConfig) => {
  const core = makeBunCoreLayer(config)
  const cache = Layer.effect(ResourceCache, Effect.acquireRelease(
    Effect.sync(() => openBunResourceCache(config.cachePath)),
    (opened) => Effect.sync(opened.close)
  ).pipe(Effect.map((opened) => ResourceCache.of(opened.service))))
  const dashboardConfig = {
    publicOrigin: config.publicOrigin,
    trustedProxyAddresses: config.trustedProxyAddresses
  }
  const dashboard = Layer.merge(
    makeDashboardAuthLayers(dashboardConfig),
    makeDashboardControlPlaneLayers(dashboardConfig)
  ).pipe(Layer.provide(core))
  return Layer.mergeAll(core, cache, dashboard, HttpServer.layerServices)
}

const internalFailure = (error: unknown): Response => {
  console.error(JSON.stringify({
    message: "Bun request failed",
    error: error instanceof Error ? error.message : String(error)
  }))
  return Response.json({ error: { code: "Internal", message: "Internal server error" } }, { status: 500 })
}

export const startBunRuntime = async (config: BunRuntimeConfig): Promise<BunRuntime> => {
  await mkdir(dirname(config.sqlitePath), { recursive: true })
  await mkdir(dirname(config.cachePath), { recursive: true })
  await applySqliteMigrations(config.sqlitePath, config.migrationsDir)

  const managed = ManagedRuntime.make(makeBunLayer(config))
  try {
    await managed.runPromise(Effect.all([Repositories, ResourceCache], { discard: true }))
  } catch (error) {
    await managed.dispose()
    throw error
  }

  const handle = async (request: Request, remoteAddress?: string): Promise<Response> => {
    const program = Effect.scoped(Effect.gen(function*() {
      const dashboardHandler = yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(DashboardApi))
      const auth = yield* Auth
      const federation = yield* Federation
      const userState = yield* UserState
      const libraries = yield* LibraryService
      const playback = yield* Playback
      const resourceCache = yield* ResourceCache
      const dashboardRequest = HttpServerRequest.fromWeb(request).modify({
        remoteAddress: remoteAddress === undefined ? Option.none() : Option.some(remoteAddress)
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
        handleDashboardAsset: (assetRequest) => serveDashboardAsset(assetRequest, config.assetsDir)
      })
      return yield* routeApplication(request).pipe(
        Effect.provideService(ApplicationServices, services)
      )
    }))
    return managed.runPromise(program).catch(internalFailure)
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: config.hostname,
      port: config.port,
      fetch(request, server) {
        return handle(request, server.requestIP(request)?.address)
      }
    })
  } catch (error) {
    await managed.dispose()
    throw error
  }

  const maintenance = scheduleMaintenance(() => managed.runPromise(
    runMaintenance(Date.now()).pipe(Effect.asVoid)
  ))
  let closing: Promise<void> | null = null
  return {
    origin: server.url.origin,
    handle,
    close: () => closing ??= (async () => {
      await maintenance.cancel()
      await server.stop()
      await managed.dispose()
    })()
  }
}

const commaSeparated = (value: string): ReadonlyArray<string> =>
  value.split(",").map((item) => item.trim()).filter((item) => item !== "")

export const readBunRuntimeConfig = (
  env: Readonly<Record<string, string | undefined>> = Bun.env
): BunRuntimeConfig => {
  if (env.PUBLIC_ORIGIN === undefined || env.PUBLIC_ORIGIN === "") {
    throw new TypeError("PUBLIC_ORIGIN is required")
  }
  if (env.TRUSTED_PROXIES === undefined) throw new TypeError("TRUSTED_PROXIES is required")
  const rawPort = env.PORT ?? "3000"
  if (!/^\d+$/.test(rawPort)) throw new TypeError("PORT must be an integer")
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("PORT is out of range")
  const dataDir = resolve(env.DATA_DIR ?? "data")
  return {
    hostname: env.HOST ?? "0.0.0.0",
    port,
    publicOrigin: env.PUBLIC_ORIGIN,
    trustedProxyAddresses: commaSeparated(env.TRUSTED_PROXIES),
    administratorPrivateHosts: commaSeparated(env.PRIVATE_UPSTREAM_HOSTS ?? ""),
    registeredResourceOrigins: commaSeparated(env.REGISTERED_RESOURCE_ORIGINS ?? ""),
    sqlitePath: join(dataDir, "oh-my-emby.sqlite"),
    cachePath: join(dataDir, "resource-cache.sqlite"),
    assetsDir: resolve(env.ASSETS_DIR ?? "apps/dashboard/dist"),
    migrationsDir: resolve(env.MIGRATIONS_DIR ?? "apps/server/migrations")
  }
}

export const main = Effect.acquireUseRelease(
  Effect.tryPromise({
    try: () => startBunRuntime(readBunRuntimeConfig()),
    catch: (cause) => cause
  }),
  () => Effect.never,
  (runtime) => Effect.promise(runtime.close)
)

if (import.meta.main) EffectBunRuntime.runMain(main)
