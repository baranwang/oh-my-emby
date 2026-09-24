import { Context, Effect, Layer } from "effect"

import type { IdentityFailure, RepositoryError } from "./errors.js"
import type { IdentityResolution, JsonValue, SourceMediaVersion } from "./model.js"
import { Repositories } from "./repositories.js"

export type ProviderNamespace = "tmdb:movie" | "tmdb:tv" | "imdb:title"

export interface ExternalClaim {
  readonly namespace: ProviderNamespace
  readonly value: string
}

export interface ClaimSet {
  readonly byNamespace: ReadonlyMap<ProviderNamespace, string>
}

export interface ProviderIds {
  readonly tmdbMovie?: string | null
  readonly tmdbTv?: string | null
  readonly imdbTitle?: string | null
}

export interface SourceMediaVersionCandidate {
  readonly upstreamMediaSourceId: string
  readonly label: string
  readonly capabilities: JsonValue
  readonly streams: JsonValue
}

export interface SourceItemCandidate {
  readonly serverId: string
  readonly catalogNamespace: string
  readonly verifiedCatalogId: string
  readonly serverGeneration: number
  readonly sourceLibraryId: string
  readonly upstreamItemId: string
  readonly itemType: "Movie" | "Series" | "Season" | "Episode"
  readonly providerIds?: ProviderIds
  readonly canonicalSeriesId?: string | null
  readonly seasonNumber?: number | null
  readonly episodeNumber?: number | null
  readonly combinedEpisodeNumbers?: ReadonlyArray<number>
  readonly numberingConflict?: boolean
  readonly displayMetadata: JsonValue
  readonly mediaVersions?: ReadonlyArray<SourceMediaVersionCandidate>
  readonly observedAtMs?: number
}

export interface IdentityFallback {
  readonly kind: "season" | "episode"
  readonly canonicalSeriesId: string
  readonly seasonNumber: number
  readonly episodeNumber: number | null
}

export interface PreparedIdentityCandidate extends Omit<
  SourceItemCandidate,
  "providerIds" | "mediaVersions" | "observedAtMs"
> {
  readonly claims: ReadonlyArray<ExternalClaim>
  readonly fallback: IdentityFallback | null
  readonly sourceItemId: string
  readonly sourceExclusiveCanonicalId: string
  readonly proposedCanonicalId: string | null
  readonly sourceExclusiveReason: string | null
  readonly mediaVersions: ReadonlyArray<SourceMediaVersion>
  readonly observedAtMs: number
}

export const clustersCompatible = (left: ClaimSet, right: ClaimSet): boolean =>
  Array.from(left.byNamespace).every(([namespace, value]) => {
    const other = right.byNamespace.get(namespace)
    return other === undefined || other === value
  })

const claim = (namespace: ProviderNamespace, value: string | null | undefined): ExternalClaim | null => {
  const normalized = value?.trim()
  return normalized ? { namespace, value: normalized } : null
}

export const normalizeExternalClaims = (
  itemType: SourceItemCandidate["itemType"],
  ids: ProviderIds = {}
): ReadonlyArray<ExternalClaim> => {
  const claims = itemType === "Movie"
    ? [claim("tmdb:movie", ids.tmdbMovie), claim("imdb:title", ids.imdbTitle)]
    : itemType === "Series"
      ? [claim("tmdb:tv", ids.tmdbTv), claim("imdb:title", ids.imdbTitle)]
      : itemType === "Episode"
        ? [claim("imdb:title", ids.imdbTitle)]
        : []
  return claims.filter((value): value is ExternalClaim => value !== null).sort((left, right) =>
    left.namespace.localeCompare(right.namespace)
  )
}

export const toClaimSet = (claims: ReadonlyArray<ExternalClaim>): ClaimSet => ({
  byNamespace: new Map(claims.map(({ namespace, value }) => [namespace, value]))
})

const safeNumber = (value: number | null | undefined): value is number =>
  Number.isSafeInteger(value) && value! >= 0

const fallbackFor = (candidate: SourceItemCandidate, hasExactClaims: boolean): IdentityFallback | null => {
  if (candidate.itemType === "Season") {
    return candidate.canonicalSeriesId && safeNumber(candidate.seasonNumber)
      ? {
          kind: "season",
          canonicalSeriesId: candidate.canonicalSeriesId,
          seasonNumber: candidate.seasonNumber,
          episodeNumber: null
        }
      : null
  }
  if (
    candidate.itemType === "Episode" &&
    !hasExactClaims &&
    candidate.canonicalSeriesId &&
    safeNumber(candidate.seasonNumber) &&
    safeNumber(candidate.episodeNumber) &&
    !candidate.numberingConflict &&
    (candidate.combinedEpisodeNumbers?.length ?? 0) <= 1
  ) {
    return {
      kind: "episode",
      canonicalSeriesId: candidate.canonicalSeriesId,
      seasonNumber: candidate.seasonNumber,
      episodeNumber: candidate.episodeNumber
    }
  }
  return null
}

const stableId = async (prefix: string, parts: ReadonlyArray<string | number>): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)))
  return `${prefix}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export const stableCanonicalId = (parts: ReadonlyArray<string | number>) => stableId("canonical", parts)

const prepare = async (candidate: SourceItemCandidate): Promise<PreparedIdentityCandidate> => {
  const claims = normalizeExternalClaims(candidate.itemType, candidate.providerIds)
  const fallback = fallbackFor(candidate, claims.length > 0)
  const observedAtMs = candidate.observedAtMs ?? Date.now()
  const sourceKey = [candidate.verifiedCatalogId, candidate.itemType, candidate.upstreamItemId] as const
  const sourceItemId = await stableId("source", sourceKey)
  const sourceExclusiveCanonicalId = await stableCanonicalId(["source", ...sourceKey])
  const proposedCanonicalId = claims[0] === undefined
    ? null
    : await stableCanonicalId([candidate.itemType, claims[0].namespace, claims[0].value])
  const mediaVersions = await Promise.all((candidate.mediaVersions ?? []).map(async (version) => ({
    id: await stableId("version", [
      candidate.serverId,
      candidate.serverGeneration,
      candidate.upstreamItemId,
      version.upstreamMediaSourceId
    ]),
    sourceItemId,
    serverGeneration: candidate.serverGeneration,
    upstreamMediaSourceId: version.upstreamMediaSourceId,
    label: version.label,
    capabilities: version.capabilities,
    streams: version.streams,
    updatedAtMs: observedAtMs
  })))
  const parentRequired = candidate.itemType === "Season" || candidate.itemType === "Episode"
  return {
    ...candidate,
    claims,
    fallback,
    sourceItemId,
    sourceExclusiveCanonicalId,
    proposedCanonicalId,
    sourceExclusiveReason: parentRequired && candidate.canonicalSeriesId && fallback === null && claims.length === 0
      ? candidate.numberingConflict || (candidate.combinedEpisodeNumbers?.length ?? 0) > 1
        ? null
        : "parent-unresolved"
      : parentRequired && !candidate.canonicalSeriesId ? "parent-unresolved" : null,
    mediaVersions,
    observedAtMs
  }
}

export interface IdentityApi {
  readonly resolve: (
    candidate: SourceItemCandidate
  ) => Effect.Effect<IdentityResolution, IdentityFailure>
  readonly lookupCanonicalId: (
    id: string
  ) => Effect.Effect<string | null, RepositoryError>
}

export class Identity extends Context.Service<Identity, IdentityApi>()("oh-my-emby/Identity") {}

export const makeIdentityLayer: Layer.Layer<Identity, never, Repositories> = Layer.effect(
  Identity,
  Effect.gen(function*() {
    const repositories = yield* Repositories
    return Identity.of({
      resolve: (candidate) => Effect.promise(() => prepare(candidate)).pipe(
        Effect.flatMap(repositories.resolveIdentity)
      ),
      lookupCanonicalId: repositories.lookupCanonicalId
    })
  })
)
