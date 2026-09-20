import { Effect } from "effect"

export interface UpstreamLogRecord {
  readonly requestId: string
  readonly route: string
  readonly serverId: string
  readonly durationMs: number
  readonly cacheOutcome: "hit" | "miss" | "bypass"
  readonly retryOutcome: "none" | "retried" | "failed"
  readonly failureCategory: string
}

export interface ObservabilityService {
  readonly upstreamRequest: (record: UpstreamLogRecord) => Effect.Effect<void>
}

export const makeObservability = (
  sink: (record: UpstreamLogRecord) => void = () => undefined
): ObservabilityService => ({
  upstreamRequest: (input) => {
    const record: UpstreamLogRecord = {
      requestId: input.requestId,
      route: input.route,
      serverId: input.serverId,
      durationMs: input.durationMs,
      cacheOutcome: input.cacheOutcome,
      retryOutcome: input.retryOutcome,
      failureCategory: input.failureCategory
    }
    return Effect.logInfo("upstream.request").pipe(
      Effect.annotateLogs({ ...record }),
      Effect.tap(() => Effect.sync(() => sink(record)))
    )
  }
})
