import { Context, Effect, Layer, Result, Schema } from "effect"

import type { RepositoryError, UpstreamFailure } from "./errors.js"
import { OUTBOX_MAX_BACKOFF_MS, UNCERTAINTY_REAPPLY_MS } from "./limits.js"
import type { OutboxClaim } from "./model.js"
import { Repositories } from "./repositories.js"
import { UpstreamClient } from "./upstream-client.js"

export type OutboxDeliveryResult =
  | "delivered"
  | "owner-lost"
  | "uncertain"
  | "transient-failure"
  | "permanent-failure"

export interface OutboxService {
  readonly claimDue: () => Effect.Effect<ReadonlyArray<OutboxClaim>, RepositoryError>
  readonly deliverClaimed: (
    claim: OutboxClaim
  ) => Effect.Effect<OutboxDeliveryResult, RepositoryError>
}

export class Outbox extends Context.Service<Outbox, OutboxService>()("oh-my-emby/Outbox") {}

export interface OutboxLayerConfig {
  readonly now?: () => number
  readonly owner?: () => string
}

const failureDetails = (failure: UpstreamFailure): {
  readonly code: string
  readonly permanent: boolean
  readonly uncertain: boolean
} => {
  if (failure._tag === "UpstreamRejected") {
    const transient = failure.status === 408 || failure.status === 429 || failure.status >= 500
    return { code: `upstream_rejected_${failure.status}`, permanent: !transient, uncertain: false }
  }
  switch (failure._tag) {
    case "UpstreamTimeout": return { code: "upstream_timeout", permanent: false, uncertain: true }
    case "UpstreamUnavailable": return { code: "upstream_unavailable", permanent: false, uncertain: true }
    case "RepositoryError": return { code: "repository_error", permanent: false, uncertain: true }
    case "ObsoleteGeneration": return { code: "obsolete_generation", permanent: false, uncertain: true }
    case "ServerNotFound": return { code: "server_not_found", permanent: true, uncertain: false }
    case "UpstreamNotFound": return { code: "upstream_not_found", permanent: true, uncertain: false }
    case "InvalidUpstreamUrl": return { code: "invalid_upstream_url", permanent: true, uncertain: false }
    case "DestinationRejected": return { code: "destination_rejected", permanent: true, uncertain: false }
    case "RedirectLimitExceeded": return { code: "redirect_limit", permanent: true, uncertain: false }
    case "RedirectLoop": return { code: "redirect_loop", permanent: true, uncertain: false }
    case "HttpsDowngrade": return { code: "https_downgrade", permanent: true, uncertain: false }
    case "ResponseTooLarge": return { code: "response_too_large", permanent: false, uncertain: true }
    case "UpstreamInvalidResponse": return { code: "invalid_response", permanent: false, uncertain: true }
    case "CatalogIdentityMismatch": return { code: "catalog_identity_mismatch", permanent: true, uncertain: false }
    case "CatalogIdentityUnverifiable": return { code: "catalog_identity_unverifiable", permanent: true, uncertain: false }
  }
}

const backoffMs = (attempt: number): number =>
  Math.min(OUTBOX_MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 20)))

export const makeOutboxLayer = (
  config: OutboxLayerConfig = {}
): Layer.Layer<Outbox, never, Repositories | UpstreamClient> => Layer.effect(Outbox, Effect.gen(function*() {
  const repositories = yield* Repositories
  const upstream = yield* UpstreamClient
  const now = config.now ?? Date.now
  const owner = config.owner ?? (() => crypto.randomUUID())

  const markUncertain = (claim: OutboxClaim, code: string, atMs: number, nextAttemptAtMs: number) =>
    repositories.markOutboxUncertain({
      targetId: claim.targetId,
      desiredRevision: claim.desiredRevision,
      code,
      uncertainAtMs: atMs,
      nextAttemptAtMs
    })

  return Outbox.of({
    claimDue: () => repositories.claimOutboxTargets({ nowMs: now(), leaseOwner: owner() }),
    deliverClaimed: (claim) => Effect.gen(function*() {
      const dispatchedAtMs = now()
      const dispatched = yield* repositories.markOutboxDispatched({
        targetId: claim.targetId,
        desiredRevision: claim.desiredRevision,
        serverGeneration: claim.serverGeneration,
        leaseOwner: claim.leaseOwner,
        dispatchedAtMs
      })
      if (!dispatched) return "owner-lost" as const

      const result = yield* upstream.request({
        serverId: claim.serverId,
        generation: claim.serverGeneration,
        path: `/Users/${encodeURIComponent(claim.upstreamUserId)}/Items/${encodeURIComponent(claim.upstreamItemId)}/UserData`,
        method: "POST",
        replaySafe: true,
        body: new TextEncoder().encode(JSON.stringify({
          Played: claim.payload.played,
          IsFavorite: claim.payload.favorite,
          PlayCount: claim.payload.playCount,
          PlaybackPositionTicks: claim.payload.positionTicks
        }))
      }, Schema.Void).pipe(Effect.result)
      const completedAtMs = now()

      if (Result.isSuccess(result)) {
        const acknowledged = yield* repositories.acknowledgeOutboxTarget({
          targetId: claim.targetId,
          desiredRevision: claim.desiredRevision,
          serverGeneration: claim.serverGeneration,
          leaseOwner: claim.leaseOwner,
          acknowledgedAtMs: completedAtMs
        })
        if (acknowledged) return "delivered" as const
        yield* markUncertain(
          claim,
          "owner_lost_after_dispatch",
          completedAtMs,
          completedAtMs + UNCERTAINTY_REAPPLY_MS
        )
        return "uncertain" as const
      }

      const details = failureDetails(result.failure)
      const retryAtMs = completedAtMs + (details.uncertain
        ? Math.max(backoffMs(claim.attemptCount), UNCERTAINTY_REAPPLY_MS)
        : backoffMs(claim.attemptCount))
      if (details.uncertain) yield* markUncertain(claim, details.code, completedAtMs, retryAtMs)
      const recorded = yield* repositories.recordOutboxFailure({
        targetId: claim.targetId,
        desiredRevision: claim.desiredRevision,
        serverGeneration: claim.serverGeneration,
        leaseOwner: claim.leaseOwner,
        code: details.code,
        failedAtMs: completedAtMs,
        nextAttemptAtMs: retryAtMs,
        permanent: details.permanent
      })
      if (!recorded && details.uncertain) return "uncertain" as const
      return details.permanent ? "permanent-failure" as const : details.uncertain
        ? "uncertain" as const
        : "transient-failure" as const
    })
  })
}))
