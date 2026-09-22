import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { UpstreamInvalidResponse, UpstreamRejected, UpstreamTimeout } from "../src/core/errors.js"
import { UNCERTAINTY_REAPPLY_MS } from "../src/core/limits.js"
import { ResourceCache, runMaintenance } from "../src/core/maintenance.js"
import { Outbox, makeOutboxLayer } from "../src/core/outbox.js"
import { Repositories } from "../src/core/repositories.js"
import type { UpstreamRequest } from "../src/core/upstream-client.js"
import { UserState, makeUserStateLayer } from "../src/core/user-state.js"
import { makeStateHarness, makeUpstreamLayer, type StateHarness } from "./state-test-harness.js"

describe("revisioned outbox", () => {
  let harness: StateHarness
  let nowMs: number
  let owner: string
  let requests: Array<UpstreamRequest>
  let requestEffect: () => Effect.Effect<unknown, any>
  let layer: Layer.Layer<Outbox | Repositories | ResourceCache | UserState>

  beforeEach(async () => {
    harness = await makeStateHarness()
    harness.seed()
    nowMs = 2_000
    owner = "worker-1"
    requests = []
    requestEffect = () => Effect.succeed({})
    const upstream = makeUpstreamLayer((request) => {
      requests.push(request)
      return requestEffect()
    })
    const state = makeUserStateLayer({ now: () => nowMs }).pipe(Layer.provide(harness.repositories))
    const outboxDependencies = Layer.merge(harness.repositories, upstream)
    const outbox = makeOutboxLayer({ now: () => nowMs, owner: () => owner }).pipe(
      Layer.provide(outboxDependencies)
    )
    const cache = Layer.succeed(ResourceCache, ResourceCache.of({ prune: () => Effect.succeed(0) }))
    layer = Layer.mergeAll(harness.repositories, state, outbox, cache)
  })

  afterEach(async () => harness.dispose())

  const write = (favorite = false) => Effect.gen(function*() {
    const state = yield* UserState
    return yield* state.write("canonical-1", { favorite, positionTicks: favorite ? 20 : 10 })
  })

  it("uses Emby's absolute user-data setter for the authenticated upstream user", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* write(true)
      const outbox = yield* Outbox
      const [claim] = yield* outbox.claimDue()
      expect(claim?.upstreamUserId).toBe("upstream-user-id")
      expect(yield* outbox.deliverClaimed(claim!)).toBe("delivered")
    }).pipe(Effect.provide(layer)))

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/Users/upstream-user-id/Items/upstream-1/UserData"
    })
    expect(requests[0]).not.toHaveProperty("clientUserAgent")
    expect(JSON.parse(new TextDecoder().decode(requests[0]!.body!))).toEqual({
      Played: false,
      IsFavorite: true,
      PlayCount: 0,
      PlaybackPositionTicks: 20
    })
  })

  it("does not make a new revision uncertain after the previous revision was acknowledged", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const [first] = yield* outbox.claimDue()
      expect(yield* outbox.deliverClaimed(first!)).toBe("delivered")

      nowMs += 1
      yield* write(true)
      expect(harness.database((database) => database.query<{
        dispatched_at_ms: number | null
        uncertain_since_ms: number | null
      }, []>("SELECT dispatched_at_ms, uncertain_since_ms FROM state_outbox").get())).toEqual({
        dispatched_at_ms: null,
        uncertain_since_ms: null
      })

      const [second] = yield* outbox.claimDue()
      expect(yield* outbox.deliverClaimed(second!)).toBe("delivered")
      nowMs += UNCERTAINTY_REAPPLY_MS
      expect(yield* outbox.claimDue()).toEqual([])
    }).pipe(Effect.provide(layer)))
    expect(requests).toHaveLength(2)
  })

  it("guards acknowledgement by owner, revision, and an unexpired lease", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const repositories = yield* Repositories
      const [claim] = yield* outbox.claimDue()
      expect(claim).toBeDefined()
      expect(yield* repositories.acknowledgeOutboxTarget({
        targetId: claim!.targetId,
        desiredRevision: claim!.desiredRevision,
        serverGeneration: claim!.serverGeneration,
        leaseOwner: "wrong-owner",
        acknowledgedAtMs: nowMs
      })).toBe(false)
      expect(yield* repositories.acknowledgeOutboxTarget({
        targetId: claim!.targetId,
        desiredRevision: claim!.desiredRevision,
        serverGeneration: claim!.serverGeneration,
        leaseOwner: claim!.leaseOwner,
        acknowledgedAtMs: claim!.leaseExpiresAtMs
      })).toBe(false)
      harness.database((database) => database.run(
        "UPDATE upstream_servers SET generation = 2 WHERE id = 'server-1'"
      ))
      expect(yield* repositories.acknowledgeOutboxTarget({
        targetId: claim!.targetId,
        desiredRevision: claim!.desiredRevision,
        serverGeneration: claim!.serverGeneration,
        leaseOwner: claim!.leaseOwner,
        acknowledgedAtMs: nowMs
      })).toBe(false)
    }).pipe(Effect.provide(layer)))
  })

  it("caps each claim at fifty targets with sixty-second leases", async () => {
    harness.database((database) => {
      for (let index = 2; index <= 51; index += 1) {
        database.run(`
          INSERT INTO source_items (
            id, server_id, catalog_namespace, server_generation, source_library_id,
            upstream_item_id, item_type, canonical_id, quarantine_reason, created_at_ms, updated_at_ms
          ) VALUES (?, 'server-1', 'catalog:server-1', 1, 'movies-1', ?, 'Movie',
            'canonical-1', NULL, 1000, 1000)
        `, [`source-${index}`, `upstream-${index}`])
      }
    })
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const claims = yield* outbox.claimDue()
      expect(claims).toHaveLength(50)
      expect(claims.every((claim) => claim.leaseExpiresAtMs === nowMs + 60_000)).toBe(true)
    }).pipe(Effect.provide(layer)))
  })

  it("persists uncertainty for an expired dispatched lease and never clears it on a newer acknowledgement", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const repositories = yield* Repositories
      const [old] = yield* outbox.claimDue()
      expect(old).toBeDefined()
      expect(yield* repositories.markOutboxDispatched({ ...old!, dispatchedAtMs: nowMs })).toBe(true)
      nowMs = old!.leaseExpiresAtMs
      owner = "worker-2"
      const [newer] = yield* outbox.claimDue()
      expect(newer).toBeDefined()
      expect(yield* outbox.deliverClaimed(newer!)).toBe("delivered")
    }).pipe(Effect.provide(layer)))
    const row = harness.database((database) => database.query<{
      uncertain_since_ms: number | null
      delivered_revision: number
      desired_revision: number
    }, []>("SELECT uncertain_since_ms, delivered_revision, desired_revision FROM state_outbox").get())
    expect(row?.uncertain_since_ms).toBe(nowMs)
    expect(row?.delivered_revision).toBe(row?.desired_revision)
  })

  it("turns a timeout after dispatch into durable uncertainty", async () => {
    requestEffect = () => Effect.fail(new UpstreamTimeout({ serverId: "server-1" }))
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const [claim] = yield* outbox.claimDue()
      expect(yield* outbox.deliverClaimed(claim!)).toBe("uncertain")
    }).pipe(Effect.provide(layer)))
    const row = harness.database((database) => database.query<{
      uncertain_since_ms: number | null
      last_failure_code: string | null
    }, []>("SELECT uncertain_since_ms, last_failure_code FROM state_outbox").get())
    expect(row).toEqual({ uncertain_since_ms: nowMs, last_failure_code: "upstream_timeout" })
  })

  it("treats an invalid response after dispatch as ambiguous rather than permanent", async () => {
    requestEffect = () => Effect.fail(new UpstreamInvalidResponse({ serverId: "server-1" }))
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const [claim] = yield* outbox.claimDue()
      expect(yield* outbox.deliverClaimed(claim!)).toBe("uncertain")
    }).pipe(Effect.provide(layer)))
    const row = harness.database((database) => database.query<{
      uncertain_since_ms: number | null
      permanent_failure_code: string | null
    }, []>("SELECT uncertain_since_ms, permanent_failure_code FROM state_outbox").get())
    expect(row).toEqual({ uncertain_since_ms: nowMs, permanent_failure_code: null })
  })

  it("persists uncertainty when lease ownership is lost after a successful dispatch", async () => {
    requestEffect = () => Effect.sync(() => {
      nowMs += 60_000
      return {}
    })
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const [claim] = yield* outbox.claimDue()
      expect(yield* outbox.deliverClaimed(claim!)).toBe("uncertain")
    }).pipe(Effect.provide(layer)))
    expect(harness.database((database) => database.query<{
      uncertain_since_ms: number | null
    }, []>("SELECT uncertain_since_ms FROM state_outbox").get()?.uncertain_since_ms)).toBe(nowMs)
  })

  it("retains permanent failures and schedules transient failures with capped backoff", async () => {
    requestEffect = () => Effect.fail(new UpstreamRejected({ serverId: "server-1", status: 400 }))
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const [claim] = yield* outbox.claimDue()
      expect(yield* outbox.deliverClaimed(claim!)).toBe("permanent-failure")
    }).pipe(Effect.provide(layer)))
    let row = harness.database((database) => database.query<{
      permanent_failure_code: string | null
      last_failure_code: string | null
    }, []>("SELECT permanent_failure_code, last_failure_code FROM state_outbox").get())
    expect(row).toEqual({ permanent_failure_code: "upstream_rejected_400", last_failure_code: "upstream_rejected_400" })

    nowMs += 1
    await Effect.runPromise(write(true).pipe(Effect.provide(layer)))
    harness.database((database) => database.run("UPDATE state_outbox SET attempt_count = 99"))
    requestEffect = () => Effect.fail(new UpstreamRejected({ serverId: "server-1", status: 503 }))
    await Effect.runPromise(Effect.gen(function*() {
      const outbox = yield* Outbox
      const [claim] = yield* outbox.claimDue()
      expect(yield* outbox.deliverClaimed(claim!)).toBe("transient-failure")
    }).pipe(Effect.provide(layer)))
    row = harness.database((database) => database.query<any, []>("SELECT * FROM state_outbox").get())
    expect(row.last_failure_code).toBe("upstream_rejected_503")
    expect(row.next_attempt_at_ms).toBe(nowMs + 6 * 60 * 60_000)
  })

  it("rejects a stale acknowledgement after a newer local revision", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const repositories = yield* Repositories
      const [old] = yield* outbox.claimDue()
      nowMs += 1
      yield* write(true)
      expect(yield* repositories.acknowledgeOutboxTarget({
        targetId: old!.targetId,
        desiredRevision: old!.desiredRevision,
        serverGeneration: old!.serverGeneration,
        leaseOwner: old!.leaseOwner,
        acknowledgedAtMs: nowMs
      })).toBe(false)
    }).pipe(Effect.provide(layer)))
  })

  it("reapplies latest state after an unobserved old write completes late", async () => {
    const remote: Array<Record<string, unknown>> = []
    await Effect.runPromise(Effect.gen(function*() {
      yield* write()
      const outbox = yield* Outbox
      const repositories = yield* Repositories
      const [old] = yield* outbox.claimDue()
      expect(yield* repositories.markOutboxDispatched({ ...old!, dispatchedAtMs: nowMs })).toBe(true)

      nowMs += 1
      yield* write(true)
      owner = "worker-2"
      const [latest] = yield* outbox.claimDue()
      expect(yield* outbox.deliverClaimed(latest!)).toBe("delivered")
      remote.push(latest!.payload as unknown as Record<string, unknown>)
      remote.push(old!.payload as unknown as Record<string, unknown>)

      nowMs += UNCERTAINTY_REAPPLY_MS
      owner = "worker-3"
      const maintenance = yield* runMaintenance(nowMs)
      expect(maintenance.claimedOutboxTargets).toBe(1)
      remote.push(JSON.parse(new TextDecoder().decode(requests.at(-1)!.body!)))
    }).pipe(Effect.provide(layer)))
    expect(remote.at(-1)).toMatchObject({ IsFavorite: true, PlaybackPositionTicks: 20 })
    expect(requests).toHaveLength(2)
  })
})
