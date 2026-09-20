import { Context, Effect, Schema } from "effect"

export interface CountedResource {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: Uint8Array
}

export interface CachedResource extends CountedResource {
  readonly expiresAtMs: number
}

export class ResourceCacheError extends Schema.TaggedError<ResourceCacheError>()(
  "ResourceCacheError",
  { message: Schema.String }
) {}

export interface ResourceCacheService {
  readonly get: (key: string) => Effect.Effect<CachedResource | null, ResourceCacheError>
  readonly put: (
    key: string,
    response: CountedResource,
    expiresAtMs: number
  ) => Effect.Effect<void, ResourceCacheError>
  readonly prune: (nowMs: number) => Effect.Effect<void, ResourceCacheError>
}

export class ResourceCache extends Context.Service<ResourceCache, ResourceCacheService>()(
  "oh-my-emby/ResourceCache"
) {}
