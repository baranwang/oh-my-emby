import { Context, Effect } from "effect"

import type { MaintenanceResult } from "./model.js"
import { Outbox } from "./outbox.js"
import { Repositories } from "./repositories.js"

export interface ResourceCacheService {
  readonly prune: (nowMs: number) => Effect.Effect<number>
}

export class ResourceCache extends Context.Service<ResourceCache, ResourceCacheService>()(
  "oh-my-emby/ResourceCache"
) {}

export interface MaintenanceRunResult extends MaintenanceResult {
  readonly prunedResources: number
  readonly claimedOutboxTargets: number
}

export const runMaintenance = (
  nowMs: number
): Effect.Effect<
  MaintenanceRunResult,
  import("./errors.js").RepositoryError,
  Repositories | Outbox | ResourceCache
> => Effect.gen(function*() {
  const repositories = yield* Repositories
  const outbox = yield* Outbox
  const cache = yield* ResourceCache
  const cleaned = yield* repositories.runMaintenanceBatch(nowMs)
  const prunedResources = yield* cache.prune(nowMs)
  const claims = yield* outbox.claimDue()
  yield* Effect.forEach(claims, outbox.deliverClaimed, { concurrency: 4, discard: true })
  return { ...cleaned, prunedResources, claimedOutboxTargets: claims.length }
})
