import { Database } from "bun:sqlite"
import { DashboardApi } from "@oh-my-emby/contracts"
import { Context, Effect, Layer, Result } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Cookies from "effect/unstable/http/Cookies"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runMaintenance, ResourceCache } from "../src/core/maintenance.js"
import { Outbox, makeOutboxLayer } from "../src/core/outbox.js"
import { Repositories } from "../src/core/repositories.js"
import { UserState, makeUserStateLayer } from "../src/core/user-state.js"
import { makeAuthLayer } from "../src/core/auth.js"
import {
  makeDashboardAuthLayers,
  makeDashboardSystemLayer
} from "../src/api/dashboard.js"
import { makeStateHarness, makeUpstreamLayer, type StateHarness } from "./state-test-harness.js"

const publicOrigin = "https://dashboard.example.com"

const placeholderGroups = Layer.effectContext(Effect.gen(function*() {
  const services = yield* Effect.context<any>()
  let context = Context.empty()
  for (const identifier of ["servers", "libraries"] as const) {
    const group = DashboardApi.groups[identifier] as any
    const handlers = new Map<string, any>()
    const routes: Array<any> = []
    for (const endpointIdentifier in group.endpoints) {
      const endpoint = group.endpoints[endpointIdentifier]
      const handler = {
        endpoint,
        handler: () => Effect.die(new Error(`Unhandled endpoint: ${endpointIdentifier}`)),
        isRaw: false,
        uninterruptible: false
      }
      handlers.set(endpointIdentifier, handler)
      routes.push(HttpApiBuilder.handlerToRoute(group, handler, services))
    }
    context = Context.add(context, group, { handlers, routes })
  }
  return context
}))

const makeDashboardClient = (headers: () => Readonly<Record<string, string>>) => Effect.gen(function*() {
  const handler = yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(DashboardApi))
  const localClient = HttpClient.make((request) => {
    const serverRequest = HttpServerRequest.fromClientRequest(request)
    return handler.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.orDie,
      Effect.map((response) => HttpServerResponse.toClientResponse(response, { request }))
    )
  }).pipe(HttpClient.mapRequest((request) => HttpClientRequest.setHeaders(request, headers())))
  return yield* HttpApiClient.makeWith(DashboardApi, { httpClient: localClient, baseUrl: publicOrigin })
})

describe("bounded maintenance", () => {
  let harness: StateHarness
  let nowMs: number
  let requests: number
  let prunes: number
  let layer: Layer.Layer<Outbox | Repositories | ResourceCache | UserState>

  beforeEach(async () => {
    harness = await makeStateHarness()
    harness.seed()
    nowMs = 100_000_000
    requests = 0
    prunes = 0
    const upstream = makeUpstreamLayer(() => {
      requests += 1
      return Effect.succeed({})
    })
    const state = makeUserStateLayer({ now: () => nowMs }).pipe(Layer.provide(harness.repositories))
    const outbox = makeOutboxLayer({ now: () => nowMs, owner: () => "maintenance" }).pipe(
      Layer.provide(Layer.merge(harness.repositories, upstream))
    )
    const cache = Layer.succeed(ResourceCache, ResourceCache.of({
      prune: () => {
        prunes += 1
        return Effect.succeed(3)
      }
    }))
    layer = Layer.mergeAll(harness.repositories, state, outbox, cache)
  })

  afterEach(async () => harness.dispose())

  it("cleans bounded local expiry rows, prunes resources, and never scans upstream catalogs", async () => {
    harness.database((database) => {
      database.run(`
        INSERT INTO users (
          singleton, username, password_hash, password_salt, pbkdf2_iterations,
          auth_generation, created_at_ms, updated_at_ms
        ) VALUES (1, 'owner', X'01', X'02', 310000, 1, 1, 1)
      `)
      database.run(`
        INSERT INTO auth_rate_limits (scope_key, window_started_at_ms, attempt_count, blocked_until_ms)
        VALUES ('old', 1, 1, NULL)
      `)
      database.run(`
        INSERT INTO playback_sessions (
          id, canonical_id, version_id, started_at_ms, last_event_at_ms,
          last_position_ticks, stop_applied, state_revision
        ) VALUES ('expired-playback', 'canonical-1', 'version-1', 1, 1, 0, 1, 1)
      `)
    })
    const result = await Effect.runPromise(runMaintenance(nowMs).pipe(Effect.provide(layer)))
    expect(result.expiredRateLimits).toBe(1)
    expect(result.expiredPlaybackSessions).toBe(1)
    expect(result.prunedResources).toBe(3)
    expect(prunes).toBe(1)
    expect(requests).toBe(0)
  })

  it("rejects a stale playback start after maintenance removes the newer session row", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const state = yield* UserState
      yield* state.recordPlaybackEvent({
        kind: "start",
        localSessionId: "new-session",
        canonicalId: "canonical-1",
        versionId: "new-version",
        positionTicks: 200,
        occurredAtMs: 10_000
      })
      yield* runMaintenance(nowMs)
      expect(harness.database((database) => database.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM playback_sessions"
      ).get()?.count)).toBe(0)

      expect(yield* state.recordPlaybackEvent({
        kind: "start",
        localSessionId: "old-session",
        canonicalId: "canonical-1",
        versionId: "old-version",
        positionTicks: 999,
        occurredAtMs: 9_000
      })).toBeNull()
    }).pipe(Effect.provide(layer)))

    expect(harness.database((database) => database.query<{
      position_ticks: number
      last_played_version_id: string
    }, []>("SELECT position_ticks, last_played_version_id FROM user_state").get())).toEqual({
      position_ticks: 200,
      last_played_version_id: "new-version"
    })
  })

  it("cancels removed targets and safely overlaps workers", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const state = yield* UserState
      yield* state.write("canonical-1", { favorite: true })
    }).pipe(Effect.provide(layer)))
    harness.database((database) => database.run("UPDATE upstream_servers SET deleted_at_ms = ? WHERE id = 'server-1'", [nowMs]))
    await Effect.runPromise(Effect.all([
      runMaintenance(nowMs),
      runMaintenance(nowMs)
    ], { concurrency: "unbounded" }).pipe(Effect.provide(layer)))
    const eligible = harness.database((database) => database.query<{ eligible: number }, []>(
      "SELECT eligible FROM state_outbox"
    ).get()?.eligible)
    expect(eligible).toBe(0)
    expect(requests).toBe(0)
  })

  it("publishes only secret-safe typed status and failure aggregates", async () => {
    harness.database((database: Database) => database.run(`
      INSERT INTO state_outbox (
        target_id, canonical_id, source_item_id, server_id, server_generation,
        desired_revision, delivered_revision, payload_json, attempt_count,
        next_attempt_at_ms, lease_owner, lease_expires_at_ms, dispatched_at_ms,
        uncertain_since_ms, permanent_failure_code, last_failure_code,
        last_failure_at_ms, eligible, updated_at_ms
      ) VALUES ('source-1', 'canonical-1', 'source-1', 'server-1', 1, 1, 0,
        '{"password":"secret","token":"raw-token","url":"https://secret.example"}', 4,
        120000, NULL, NULL, NULL, 90000, 'upstream_rejected_400',
        'upstream_rejected_400', 95000, 1, 95000)
    `))
    await Effect.runPromise(runMaintenance(nowMs).pipe(Effect.provide(layer)))
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const repositories = yield* Repositories
      return {
        status: yield* repositories.readSystemStatus(),
        failures: yield* repositories.listOutboxFailures()
      }
    }).pipe(Effect.provide(layer)))
    expect(snapshot.status).toMatchObject({
      database: "healthy",
      maintenanceLastRunAtMs: nowMs,
      outboxFailed: 1,
      outboxUncertain: 1,
      upstreamHealthy: 1
    })
    expect(snapshot.failures).toEqual([{
      serverId: "server-1",
      code: "upstream_rejected_400",
      failedAtMs: 95_000,
      attemptCount: 4,
      nextAttemptAtMs: null,
      uncertainSinceMs: 90_000
    }])
    const serialized = JSON.stringify(snapshot)
    for (const secret of ["payload", "secret", "raw-token", "secret.example", "password", "token", "url"]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("requires Dashboard authentication for typed secret-safe system routes", async () => {
    harness.database((database) => database.run(`
      INSERT INTO state_outbox (
        target_id, canonical_id, source_item_id, server_id, server_generation,
        desired_revision, delivered_revision, payload_json, attempt_count,
        next_attempt_at_ms, lease_owner, lease_expires_at_ms, dispatched_at_ms,
        uncertain_since_ms, permanent_failure_code, last_failure_code,
        last_failure_at_ms, eligible, updated_at_ms
      ) VALUES ('source-1', 'canonical-1', 'source-1', 'server-1', 1, 1, 0,
        '{"played":false,"favorite":false,"playCount":0,"positionTicks":0,"lastPlayedVersionId":null}',
        2, 120000, NULL, NULL, NULL, NULL, 'upstream_rejected_401',
        'upstream_rejected_401', 95000, 1, 95000)
    `))
    const auth = makeAuthLayer({ now: () => nowMs }).pipe(Layer.provide(harness.repositories))
    const config = { publicOrigin, trustedProxyAddresses: [] }
    const handlers = Layer.merge(
      makeDashboardAuthLayers(config).pipe(Layer.provide(auth)),
      makeDashboardSystemLayer(config).pipe(Layer.provide(Layer.merge(auth, harness.repositories)))
    )
    const apiLayer = Layer.mergeAll(handlers, placeholderGroups, HttpServer.layerServices)
    const requestHeaders: Record<string, string> = { origin: publicOrigin }

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeDashboardClient(() => requestHeaders)
      const unauthorized = yield* client.system.getSystemStatus().pipe(Effect.result)
      expect(Result.isFailure(unauthorized) && unauthorized.failure).toEqual({ _tag: "Unauthorized" })

      const [, response] = yield* client.auth.claim({
        payload: { username: "owner", password: "valid password" },
        responseMode: "decoded-and-response"
      })
      requestHeaders.cookie = Cookies.toCookieHeader(response.cookies)
      const status = yield* client.system.getSystemStatus()
      const failures = yield* client.system.listOutboxFailures()
      expect(status.database).toBe("healthy")
      expect(failures[0]).toEqual({
        serverId: "server-1",
        code: "upstream_rejected_401",
        failedAtMs: 95_000,
        attemptCount: 2,
        nextAttemptAtMs: null,
        uncertainSinceMs: null
      })
      const serialized = JSON.stringify([status, failures])
      for (const forbidden of ["payload", "password", "token", "baseUrl", "raw upstream"]) {
        expect(serialized).not.toContain(forbidden)
      }
    })).pipe(Effect.provide(apiLayer)))
  })
})
