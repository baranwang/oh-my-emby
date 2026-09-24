import { Effect } from "effect"

import type { MaintenanceResult } from "./model.js"
import { Outbox } from "./outbox.js"
import { Repositories } from "./repositories.js"
import { ResourceCache, type ResourceCacheError } from "./resource-cache.js"

export { ResourceCache } from "./resource-cache.js"

export interface MaintenanceRunResult extends MaintenanceResult {
  readonly prunedResources: number
  readonly claimedOutboxTargets: number
}

export const runMaintenance = (
  nowMs: number
): Effect.Effect<
  MaintenanceRunResult,
  import("./errors.js").RepositoryError | ResourceCacheError,
  Repositories | Outbox | ResourceCache
> => Effect.gen(function*() {
  const repositories = yield* Repositories
  const outbox = yield* Outbox
  const cache = yield* ResourceCache
  const cleaned = yield* repositories.runMaintenanceBatch(nowMs)
  const pruned = yield* cache.prune(nowMs)
  const prunedResources = typeof pruned === "number" ? pruned : 0
  const claims = yield* outbox.claimDue()
  yield* Effect.forEach(claims, outbox.deliverClaimed, { concurrency: 4, discard: true })
  return { ...cleaned, prunedResources, claimedOutboxTargets: claims.length }
})
