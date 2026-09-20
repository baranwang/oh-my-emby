import { Effect } from "effect"

import {
  Auth,
  type Credentials,
  type DashboardSession,
  type LoginOptions
} from "./auth.js"
import {
  type ClaimError,
  type LoginError,
  UpstreamRejected,
  UpstreamUnavailable
} from "./errors.js"
import type { SaveServerCommand } from "./model.js"
import { Repositories } from "./repositories.js"

export type PlatformFetch = (input: URL, init: RequestInit) => Promise<Response>

export const claimAndAttemptFirstServerSetup = (
  credentials: Credentials,
  options: LoginOptions,
  server: SaveServerCommand,
  platformFetch: PlatformFetch
): Effect.Effect<
  DashboardSession,
  ClaimError | LoginError | UpstreamRejected | UpstreamUnavailable,
  Auth | Repositories
> => Effect.gen(function*() {
  const auth = yield* Auth
  const repositories = yield* Repositories
  const session = yield* auth.claim(credentials, options)
  yield* repositories.saveServer(server)

  const baseUrl = server.baseUrl.endsWith("/") ? server.baseUrl : `${server.baseUrl}/`
  const response = yield* Effect.tryPromise({
    try: () => platformFetch(new URL("System/Info/Public", baseUrl), {
      method: "GET",
      redirect: "error"
    }),
    catch: () => new UpstreamUnavailable({ serverId: server.id })
  })
  if (!response.ok) {
    return yield* Effect.fail(new UpstreamRejected({
      serverId: server.id,
      status: response.status
    }))
  }
  return session
})
