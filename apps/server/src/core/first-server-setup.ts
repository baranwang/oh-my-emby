import { Effect, Layer } from "effect"

import {
  Auth,
  type Credentials,
  type DashboardSession,
  type LoginOptions
} from "./auth.js"
import { type ClaimError, type LoginError, type UpstreamFailure } from "./errors.js"
import type { SaveServerCommand } from "./model.js"
import { Repositories } from "./repositories.js"
import { makeServerServiceLayer, ServerService } from "./server-service.js"
import { makeUpstreamClientLayer, type DestinationPolicy } from "./upstream-client.js"

export type PlatformFetch = typeof globalThis.fetch

export const claimAndAttemptFirstServerSetup = (
  credentials: Credentials,
  options: LoginOptions,
  server: SaveServerCommand,
  platformFetch: PlatformFetch,
  destinationPolicy: DestinationPolicy
): Effect.Effect<
  DashboardSession,
  ClaimError | LoginError | UpstreamFailure,
  Auth | Repositories
> => Effect.gen(function*() {
  const auth = yield* Auth
  const repositories = yield* Repositories
  const session = yield* auth.claim(credentials, options)
  yield* repositories.saveServer(server)
  const upstream = makeUpstreamClientLayer({
    fetch: platformFetch,
    destinationPolicy
  })
  const service = makeServerServiceLayer.pipe(Layer.provide(upstream))
  yield* Effect.gen(function*() {
    const servers = yield* ServerService
    yield* servers.testConnection(server.id)
  }).pipe(Effect.provide(service))
  return session
})
