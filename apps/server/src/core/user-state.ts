import { Context, Effect, Layer } from "effect"

import type { PlaybackEvent, UserStatePatch, UserStateRecord } from "./model.js"
import { Repositories } from "./repositories.js"

export interface UserStateService {
  readonly write: (
    canonicalId: string,
    patch: UserStatePatch
  ) => Effect.Effect<UserStateRecord, import("./errors.js").RepositoryError>
  readonly recordPlaybackEvent: (
    event: PlaybackEvent
  ) => Effect.Effect<UserStateRecord | null, import("./errors.js").RepositoryError>
}

export class UserState extends Context.Service<UserState, UserStateService>()(
  "oh-my-emby/UserState"
) {}

export interface UserStateLayerConfig {
  readonly now?: () => number
}

export const makeUserStateLayer = (
  config: UserStateLayerConfig = {}
): Layer.Layer<UserState, never, Repositories> => Layer.effect(UserState, Effect.gen(function*() {
  const repositories = yield* Repositories
  const now = config.now ?? Date.now
  const invalidateAfterCommit = <A>(effect: Effect.Effect<A, import("./errors.js").RepositoryError>) =>
    effect.pipe(Effect.tap(() => repositories.invalidateStateDependentQueryGenerations()))

  return UserState.of({
    write: (canonicalId, patch) => invalidateAfterCommit(repositories.writeUserStateAndTargets({
      canonicalId,
      patch,
      updatedAtMs: now()
    })),
    recordPlaybackEvent: (event) => repositories.recordPlaybackEventAndTargets(event).pipe(
      Effect.tap((state) => state === null
        ? Effect.void
        : repositories.invalidateStateDependentQueryGenerations())
    )
  })
}))
