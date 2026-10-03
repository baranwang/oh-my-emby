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
  UPSTREAM_LIST_DEADLINE_MS,
} from "./limits.js";
import { MetadataProviders } from "./metadata-providers.js";
import type { EligibleSource, JsonValue } from "./model.js";
import { Repositories } from "./repositories.js";
import { isCatalogObject, sourceItemCandidate } from "./source-item-candidate.js";
import { UpstreamClient, endpointUrl } from "./upstream-client.js";

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
    imageIndex?: number,
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
      const evidenceScope = (scope: CollectionScope) =>
        Effect.map(tmdbEnabled(), (includeTmdb) => ({ ...scope, includeTmdb }));
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
        cachedOnly = false,
      ): Effect.Effect<CollectionView | null, RepositoryError> =>
        Effect.gen(function* () {
          if (!(yield* allowedRecord(record, scope))) return null;
          const movies = yield* repo.readCollectionMovies(record.id, yield* evidenceScope(scope));
          if (!movies.length) return null;
          const rawSources = yield* repo.readCollectionSources(record.id, scope);
          const external =
            record.tmdbCollectionId && (yield* tmdbEnabled())
              ? yield* metadata.readTmdbCollection(record.tmdbCollectionId, cachedOnly)
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
          const record = yield* repo.readCollection(id, yield* evidenceScope(scope));
          return record ? yield* view(record, scope) : null;
        });
      const scanCache = new Map<string, number>();
      const refreshBoxSet = (
        record: CollectionRecord,
        source: CollectionSource,
        eligible: ReadonlyArray<EligibleSource>,
        incomplete: Set<string>,
        clientUserAgent?: string,
      ) =>
        Effect.gen(function* () {
          const scopes = eligible.filter(
            (s) => s.serverId === source.serverId && s.serverGeneration === source.serverGeneration,
          );
          if (!scopes.length) return;
          const movies = [];
          let start = 0,
            complete = false;
          const observedAtMs = Date.now();
          while (start < MAX_MATERIALIZED_ITEMS) {
            const response = yield* requestItems(
              scopes[0]!,
              {
                ParentId: source.upstreamBoxSetId,
                IncludeItemTypes: "Movie",
                Recursive: "true",
                Fields: "ProviderIds,MediaSources,ParentId",
                StartIndex: String(start),
                Limit: String(MAX_PAGE_SIZE),
              },
              clientUserAgent,
            ).pipe(Effect.result);
            if (Result.isFailure(response)) {
              incomplete.add(source.serverId);
              break;
            }
            for (const raw of response.success.items) {
              if (raw.Type !== "Movie") continue;
              for (const scope of scopes) {
                const proof = yield* requestItems(
                  scope,
                  {
                    ParentId: scope.sourceLibraryId,
                    Ids: String(raw.Id),
                    IncludeItemTypes: "Movie",
                    Recursive: "true",
                    Fields: "ProviderIds,MediaSources,ParentId",
                    StartIndex: "0",
                    Limit: "1",
                  },
                  clientUserAgent,
                ).pipe(Effect.result);
                if (Result.isFailure(proof)) {
                  incomplete.add(source.serverId);
                  continue;
                }
                const matched = proof.success.items.find(
                  (item) => item.Id === raw.Id && item.Type === "Movie",
                );
                if (matched) movies.push(yield* ingest(scope, { ...raw, ...matched }));
              }
            }
            start += response.success.items.length;
            if (start >= response.success.total) {
              complete = true;
              break;
            }
            if (response.success.items.length === 0) {
              incomplete.add(source.serverId);
              break;
            }
          }
          if (!complete) incomplete.add(source.serverId);
          yield* repo.writeCollectionSnapshot({
            collectionId: record.id,
            source,
            members: movies,
            complete: complete && !incomplete.has(source.serverId),
            observedAtMs,
          });
        });
      const discover = (scope: CollectionScope, clientUserAgent?: string) =>
        Effect.gen(function* () {
          const eligible = yield* sources(scope),
            incomplete = new Set<string>();
          const cacheKey = JSON.stringify([
            scope,
            eligible.map((s) => [s.serverId, s.serverGeneration, s.sourceLibraryId]),
          ]);
          if ((scanCache.get(cacheKey) ?? 0) > Date.now()) return [] as string[];
          const servers = [...new Map(eligible.map((s) => [s.serverId, s])).values()];
          const scan = Effect.gen(function* () {
            let scanned = 0;
            for (const representative of servers) {
              const roots: Array<string | undefined> = [undefined];
              for (const root of roots) {
                let start = 0;
                while (scanned < MAX_MATERIALIZED_ITEMS) {
                  const response = yield* requestItems(
                    representative,
                    {
                      ...(root === undefined ? {} : { ParentId: root }),
                      IncludeItemTypes: "BoxSet",
                      Recursive: "true",
                      Fields: "ProviderIds,Overview,ImageTags",
                      StartIndex: String(start),
                      Limit: String(MAX_PAGE_SIZE),
                    },
                    clientUserAgent,
                  ).pipe(Effect.result);
                  if (Result.isFailure(response)) {
                    if (root === undefined && start === 0) {
                      const server = yield* repo.getServer(representative.serverId);
                      const makePath = (id: string) => `/Users/${encodeURIComponent(id)}/Views`;
                      const views = yield* upstream
                        .request(
                          {
                            serverId: representative.serverId,
                            generation: representative.serverGeneration,
                            path: makePath(server?.upstreamUserId ?? ""),
                            replayPath: makePath,
                            method: "GET",
                            replaySafe: true,
                            ...(clientUserAgent ? { clientUserAgent } : {}),
                          },
                          Schema.Unknown,
                        )
                        .pipe(Effect.result);
                      if (
                        Result.isSuccess(views) &&
                        isCatalogObject(views.success) &&
                        Array.isArray(views.success.Items)
                      ) {
                        const found = views.success.Items.filter(
                          (v) =>
                            isCatalogObject(v) &&
                            v.CollectionType === "boxsets" &&
                            typeof v.Id === "string",
                        );
                        roots.push(...found.map((v) => String(object(v).Id)));
                        if (found.length) break;
                      }
                    }
                    incomplete.add(representative.serverId);
                    break;
                  }
                  for (const raw of response.success.items) {
                    if (raw.Type !== "BoxSet") continue;
                    const provider = object(raw.ProviderIds).Tmdb;
                    const collectionSource: CollectionSource = {
                      serverId: representative.serverId,
                      catalogNamespace: representative.catalogNamespace,
                      serverGeneration: representative.serverGeneration,
                      upstreamBoxSetId: String(raw.Id),
                      metadata: raw,
                    };
                    const record = yield* repo.upsertCollection({
                      tmdbCollectionId:
                        typeof provider === "string" && /^[1-9]\d*$/.test(provider)
                          ? provider
                          : null,
                      source: collectionSource,
                      metadata: raw,
                      observedAtMs: Date.now(),
                    });
                    if (record)
                      yield* refreshBoxSet(
                        record,
                        collectionSource,
                        eligible,
                        incomplete,
                        clientUserAgent,
                      );
                  }
                  start += response.success.items.length;
                  scanned += response.success.items.length;
                  if (start >= response.success.total) break;
                  if (response.success.items.length === 0) {
                    incomplete.add(representative.serverId);
                    break;
                  }
                }
              }
              if (scanned >= MAX_MATERIALIZED_ITEMS) incomplete.add(representative.serverId);
            }
          }).pipe(
            Effect.timeout(UPSTREAM_LIST_DEADLINE_MS),
            Effect.catchTag("TimeoutError", () =>
              Effect.sync(() => {
                servers.forEach((s) => incomplete.add(s.serverId));
              }),
            ),
          );
          yield* scan;
          if (incomplete.size === 0) scanCache.set(cacheKey, Date.now() + METADATA_FRESH_MS);
          return [...incomplete];
        });
      const list: CollectionsApi["list"] = (query) =>
        Effect.gen(function* () {
          const incomplete =
            query.limit > 0 && query.discover !== false
              ? yield* discover(query.scope, query.clientUserAgent)
              : [];
          const records = yield* repo.listVisibleCollections(yield* evidenceScope(query.scope));
          const views = (yield* Effect.forEach(records, (record) =>
            view(record, query.scope, true),
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
            exhausted: incomplete.length === 0,
            incompleteSourceIds: incomplete,
          };
        });
      const members: CollectionsApi["members"] = (id, query) =>
        Effect.gen(function* () {
          const record = yield* repo.readCollection(id, yield* evidenceScope(query.scope));
          if (!record || !(yield* allowedRecord(record, query.scope))) return null;
          const incomplete = new Set<string>();
          if (query.limit > 0) {
            const eligible = yield* sources(query.scope),
              rawSources = yield* repo.readCollectionSources(record.id, query.scope);
            yield* Effect.forEach(rawSources, (source) =>
              refreshBoxSet(record, source, eligible, incomplete, query.clientUserAgent),
            ).pipe(
              Effect.timeout(UPSTREAM_DETAIL_DEADLINE_MS),
              Effect.catchTag("TimeoutError", () =>
                Effect.sync(() => {
                  rawSources.forEach((s) => incomplete.add(s.serverId));
                }),
              ),
            );
          }
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
          const movies = yield* repo.readCollectionMovies(
            record.id,
            yield* evidenceScope(query.scope),
          );
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
      const image: CollectionsApi["image"] = (id, scope, imageType, clientUserAgent, imageIndex) =>
        Effect.gen(function* () {
          const current = yield* detail(id, scope, clientUserAgent);
          if (!current) return null;
          const images = object(object(current.displayMetadata).ExternalImages);
          const url =
            imageType === "Backdrop" && Array.isArray(images.Backdrop)
              ? images.Backdrop[imageIndex ?? 0]
              : images[imageType];
          if (typeof url === "string" && (imageType === "Backdrop" || (imageIndex ?? 0) === 0))
            return { url: new URL(url), source: null };
          const eligible = yield* sources(scope);
          for (const registered of yield* repo.readCollectionSources(current.id, scope)) {
            const raw = object(registered.metadata);
            const tags = object(raw.ImageTags);
            const present =
              imageType === "Backdrop"
                ? Array.isArray(raw.BackdropImageTags) &&
                  typeof raw.BackdropImageTags[imageIndex ?? 0] === "string"
                : typeof tags[imageType] === "string" && (imageIndex ?? 0) === 0;
            if (!present) continue;
            const source = eligible.find(
              (s) =>
                s.serverId === registered.serverId &&
                s.serverGeneration === registered.serverGeneration &&
                s.catalogNamespace === registered.catalogNamespace,
            );
            const endpoint = source?.endpoints.find(
              (e) => e.health === "healthy" && e.verifiedCatalogId === source.verifiedCatalogId,
            );
            if (!source || !endpoint) continue;
            const url = endpointUrl(
              endpoint,
              `/Items/${encodeURIComponent(registered.upstreamBoxSetId)}/Images/${encodeURIComponent(imageType)}` +
                (imageIndex === undefined ? "" : `/${imageIndex}`),
            );
            if (source.accessToken !== null) url.searchParams.set("api_key", source.accessToken);
            return { url, source: registered };
          }
          return null;
        });
      return Collections.of({ list, detail, members, image });
    }),
  );
