import { Context, Effect, Layer, Result, Schema } from "effect";
import type {
  CollectionPage,
  CollectionQuery,
  CollectionRecord,
  CollectionScope,
  CollectionSource,
  CollectionView,
} from "./collection-model.js";
import {
  UpstreamInvalidResponse,
  type IdentityFailure,
  type RepositoryError,
  type UpstreamFailure,
} from "./errors.js";
import { Identity } from "./identity.js";
import {
  MAX_MATERIALIZED_ITEMS,
  MAX_PAGE_SIZE,
  METADATA_FRESH_MS,
  METADATA_STALE_MS,
  UPSTREAM_DETAIL_DEADLINE_MS,
} from "./limits.js";
import { MetadataProviders } from "./metadata-providers.js";
import type { EligibleSource, JsonValue } from "./model.js";
import { Repositories } from "./repositories.js";
import { isCatalogObject, sourceItemCandidate } from "./source-item-candidate.js";
import { UpstreamClient } from "./upstream-client.js";

export type CollectionFailure = RepositoryError | IdentityFailure | UpstreamFailure;
export interface CollectionsApi {
  readonly list: (
    query: CollectionQuery,
  ) => Effect.Effect<CollectionPage<CollectionView>, CollectionFailure>;
  readonly detail: (
    id: string,
    scope: CollectionScope,
    clientUserAgent?: string,
  ) => Effect.Effect<CollectionView | null, CollectionFailure>;
  readonly members: (
    id: string,
    query: CollectionQuery,
  ) => Effect.Effect<CollectionPage<string> | null, CollectionFailure>;
  readonly image: (
    id: string,
    scope: CollectionScope,
    imageType: string,
    clientUserAgent?: string,
  ) => Effect.Effect<{ url: URL; source: CollectionSource | null } | null, CollectionFailure>;
}
export class Collections extends Context.Service<Collections, CollectionsApi>()(
  "oh-my-emby/Collections",
) {}
const object = (value: JsonValue | undefined) => (isCatalogObject(value) ? value : {});
const emptyPage = <A>(): CollectionPage<A> => ({
  items: [],
  totalRecordCount: 0,
  exhausted: true,
  incompleteSourceIds: [],
});

export const makeCollectionsLayer = (): Layer.Layer<
  Collections,
  never,
  Repositories | Identity | UpstreamClient | MetadataProviders
> =>
  Layer.effect(
    Collections,
    Effect.gen(function* () {
      const repo = yield* Repositories,
        identity = yield* Identity,
        upstream = yield* UpstreamClient,
        metadata = yield* MetadataProviders;
      const sources = (scope: CollectionScope) =>
        Effect.gen(function* () {
          const libraries = (yield* repo.listVirtualLibraries()).filter(
            (lib) =>
              lib.enabled &&
              lib.mediaType === "movies" &&
              (scope.virtualLibraryId === null || scope.virtualLibraryId === lib.id),
          );
          const all = (yield* Effect.forEach(libraries, (lib) =>
            repo.resolveEligibleSources(lib.id),
          )).flat();
          return [
            ...new Map(
              all.map((source) => [`${source.serverId}:${source.sourceLibraryId}`, source]),
            ).values(),
          ];
        });
      const tmdbEnabled = () =>
        Effect.map(repo.readMetadataSettings(), (settings) =>
          settings.some((s) => s.id === "tmdb" && s.enabled && s.credential !== null),
        );
      const requestItems = (
        source: EligibleSource,
        params: Record<string, string>,
        clientUserAgent?: string,
      ) =>
        Effect.gen(function* () {
          const server = yield* repo.getServer(source.serverId);
          const makePath = (userId: string) =>
            `/Users/${encodeURIComponent(userId)}/Items?${new URLSearchParams(params)}`;
          const value = yield* upstream.request(
            {
              serverId: source.serverId,
              generation: source.serverGeneration,
              path: makePath(server?.upstreamUserId ?? ""),
              replayPath: makePath,
              method: "GET",
              replaySafe: true,
              ...(clientUserAgent ? { clientUserAgent } : {}),
            },
            Schema.Unknown,
          );
          if (
            !isCatalogObject(value) ||
            !Array.isArray(value.Items) ||
            typeof value.TotalRecordCount !== "number" ||
            value.TotalRecordCount < 0
          )
            return yield* Effect.fail(new UpstreamInvalidResponse({ serverId: source.serverId }));
          const items = value.Items.filter(
            (raw): raw is Record<string, JsonValue> =>
              isCatalogObject(raw) && typeof raw.Id === "string" && typeof raw.Type === "string",
          );
          return { items, total: value.TotalRecordCount };
        });
      const ingest = (source: EligibleSource, raw: Record<string, JsonValue>) =>
        Effect.gen(function* () {
          const now = Date.now(),
            resolution = yield* identity.resolve(sourceItemCandidate(source, raw, now));
          yield* repo.writeMetadataProjection({
            sourceItemId: resolution.sourceItem.id,
            projectionKey: "detail",
            payload: raw,
            freshUntilMs: now + METADATA_FRESH_MS,
            staleUntilMs: now + METADATA_STALE_MS,
            updatedAtMs: now,
          });
          yield* repo.mergeCanonicalMetadata(
            resolution.canonical.id,
            resolution.sourceItem.id,
            raw,
            now,
          );
          return { canonicalId: resolution.canonical.id, sourceItemId: resolution.sourceItem.id };
        });
      const allowedRecord = (record: CollectionRecord, scope: CollectionScope) =>
        Effect.gen(function* () {
          if (yield* tmdbEnabled()) return true;
          return (yield* repo.readCollectionSources(record.id, scope)).length > 0;
        });
      const view = (
        record: CollectionRecord,
        scope: CollectionScope,
      ): Effect.Effect<CollectionView | null, RepositoryError> =>
        Effect.gen(function* () {
          if (!(yield* allowedRecord(record, scope))) return null;
          const movies = yield* repo.readCollectionMovies(record.id, scope);
          if (!movies.length) return null;
          const rawSources = yield* repo.readCollectionSources(record.id, scope);
          const external =
            record.tmdbCollectionId && (yield* tmdbEnabled())
              ? yield* metadata.readTmdbCollection(record.tmdbCollectionId)
              : null;
          const fallback = object(rawSources[0]?.metadata ?? record.displayMetadata);
          return {
            id: record.id,
            displayMetadata: {
              ...fallback,
              ...external,
              Name: external?.Name ?? fallback.Name ?? "Collection",
            },
            childCount: movies.length,
            incompleteSourceIds: [],
          };
        });
      const detail: CollectionsApi["detail"] = (id, scope) =>
        Effect.gen(function* () {
          const record = yield* repo.readCollection(id, scope);
          return record ? yield* view(record, scope) : null;
        });
      const list: CollectionsApi["list"] = (query) =>
        Effect.gen(function* () {
          const records = yield* repo.listVisibleCollections(query.scope);
          const views = (yield* Effect.forEach(records, (record) =>
            view(record, query.scope),
          )).filter((v): v is CollectionView => v !== null);
          const filtered = views.filter(
            (v) =>
              !query.searchTerm ||
              String(object(v.displayMetadata).Name ?? "")
                .toLocaleLowerCase()
                .includes(query.searchTerm.toLocaleLowerCase()),
          );
          for (const sort of [...query.sort].reverse())
            filtered.sort(
              (a, b) =>
                String(object(a.displayMetadata)[sort.field] ?? "").localeCompare(
                  String(object(b.displayMetadata)[sort.field] ?? ""),
                ) * (sort.direction === "Descending" ? -1 : 1),
            );
          return {
            ...emptyPage<CollectionView>(),
            items: filtered.slice(
              query.startIndex,
              query.startIndex + Math.min(MAX_PAGE_SIZE, Math.max(0, query.limit)),
            ),
            totalRecordCount: filtered.length,
          };
        });
      const members: CollectionsApi["members"] = (id, query) =>
        Effect.gen(function* () {
          const record = yield* repo.readCollection(id, query.scope);
          if (!record || !(yield* allowedRecord(record, query.scope))) return null;
          const incomplete = new Set<string>();
          if (query.limit > 0 && record.tmdbCollectionId && (yield* tmdbEnabled())) {
            const collection = yield* metadata.readTmdbCollection(record.tmdbCollectionId);
            if (collection) {
              const eligible = yield* sources(query.scope);
              const discovery = Effect.gen(function* () {
                let scanned = 0;
                for (const source of eligible) {
                  for (const movieId of collection.movieIds) {
                    if (++scanned > MAX_MATERIALIZED_ITEMS) {
                      incomplete.add(source.serverId);
                      break;
                    }
                    const result = yield* requestItems(
                      source,
                      {
                        ParentId: source.sourceLibraryId,
                        IncludeItemTypes: "Movie",
                        Recursive: "true",
                        AnyProviderIdEquals: `tmdb.${movieId}`,
                        Fields: "ProviderIds,MediaSources",
                        Limit: "100",
                        StartIndex: "0",
                      },
                      query.clientUserAgent,
                    ).pipe(Effect.result);
                    if (Result.isFailure(result)) {
                      incomplete.add(source.serverId);
                      continue;
                    }
                    if (result.success.total > result.success.items.length)
                      incomplete.add(source.serverId);
                    for (const raw of result.success.items) {
                      if (raw.Type !== "Movie" || object(raw.ProviderIds).Tmdb !== movieId)
                        continue;
                      const member = yield* ingest(source, raw);
                      yield* repo.replaceTmdbCollectionMembership({
                        sourceItemId: member.sourceItemId,
                        tmdbCollectionId: record.tmdbCollectionId,
                        expectedGeneration: source.serverGeneration,
                        observedAtMs: Date.now(),
                      });
                    }
                  }
                }
              }).pipe(
                Effect.timeout(UPSTREAM_DETAIL_DEADLINE_MS),
                Effect.catchTag("TimeoutError", () =>
                  Effect.sync(() => {
                    eligible.forEach((s) => incomplete.add(s.serverId));
                  }),
                ),
              );
              yield* discovery;
            }
          }
          const movies = yield* repo.readCollectionMovies(record.id, query.scope);
          return {
            items: movies
              .slice(
                query.startIndex,
                query.startIndex + Math.min(MAX_PAGE_SIZE, Math.max(0, query.limit)),
              )
              .map((m) => m.canonicalId),
            totalRecordCount: movies.length,
            exhausted: incomplete.size === 0,
            incompleteSourceIds: [...incomplete],
          };
        });
      const image: CollectionsApi["image"] = (id, scope, imageType) =>
        Effect.gen(function* () {
          const current = yield* detail(id, scope);
          if (!current) return null;
          const images = object(object(current.displayMetadata).ExternalImages);
          const url =
            imageType === "Backdrop" && Array.isArray(images.Backdrop)
              ? images.Backdrop[0]
              : images[imageType];
          return typeof url === "string" ? { url: new URL(url), source: null } : null;
        });
      return Collections.of({ list, detail, members, image });
    }),
  );
