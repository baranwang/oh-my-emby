import { Context, Effect, Layer, Result, Schema } from "effect";

import {
  RepositoryError,
  UpstreamInvalidResponse,
  UpstreamNotFound,
  UpstreamTimeout,
  UpstreamUnavailable,
  type IdentityFailure,
  type UpstreamFailure,
} from "./errors.js";
import {
  Identity,
  type ProviderIds,
  type ProviderNamespace,
  type SourceItemCandidate,
} from "./identity.js";
import {
  DB_BATCH_SIZE,
  MAX_FANOUT_CONCURRENCY,
  MAX_MATERIALIZED_ITEMS,
  MAX_PAGE_SIZE,
  METADATA_FRESH_MS,
  METADATA_STALE_MS,
  QUERY_GENERATION_TTL_MS,
  UPSTREAM_DETAIL_DEADLINE_MS,
  UPSTREAM_LIST_DEADLINE_MS,
} from "./limits.js";
import type {
  EligibleSource,
  IdentityResolution,
  JsonValue,
  QueryGeneration,
  QueryGenerationItem,
  SourceMediaVersion,
  UserStateRecord,
} from "./model.js";
import { MetadataProviders } from "./metadata-providers.js";
import { Repositories, type CatalogItemRecord } from "./repositories.js";
import { UpstreamClient } from "./upstream-client.js";

export interface SortTerm {
  readonly field: string;
  readonly direction: "Ascending" | "Descending";
}

export interface CatalogFilter {
  readonly field: string;
  readonly value: JsonValue;
}

export interface FederatedQuery {
  readonly userId: string;
  readonly deviceId: string;
  readonly virtualLibraryId: string;
  readonly startIndex: number;
  readonly limit: number;
  readonly sort: ReadonlyArray<SortTerm>;
  readonly filters: ReadonlyArray<CatalogFilter>;
  readonly itemTypes: ReadonlyArray<string>;
  readonly fields?: ReadonlyArray<string>;
  readonly clientUserAgent?: string;
}

export interface SearchQuery extends FederatedQuery {
  readonly searchTerm: string;
}

export interface CanonicalItemView {
  readonly id: string;
  readonly itemType: string;
  readonly displayMetadata: JsonValue;
  readonly mediaVersions: ReadonlyArray<SourceMediaVersion>;
  readonly userState: UserStateRecord | null;
  readonly incompleteSourceIds: ReadonlyArray<string>;
}

export interface FederatedPage {
  readonly items: ReadonlyArray<CanonicalItemView>;
  readonly totalRecordCount: number;
  readonly exhausted: boolean;
  readonly incompleteSourceIds: ReadonlyArray<string>;
}

export interface CatalogMembership {
  readonly item: CanonicalItemView;
  readonly version: SourceMediaVersion | null;
}

export class FederationLimitExceeded extends Schema.TaggedError<FederationLimitExceeded>()(
  "FederationLimitExceeded",
  { requestedEnd: Schema.Int, maximum: Schema.Int },
) {}

export class FederationUnavailable extends Schema.TaggedError<FederationUnavailable>()(
  "FederationUnavailable",
  { sourceIds: Schema.Array(Schema.String) },
) {}

export type FederationFailure =
  | FederationLimitExceeded
  | FederationUnavailable
  | IdentityFailure
  | RepositoryError;

export interface FederationService {
  readonly list: (query: FederatedQuery) => Effect.Effect<FederatedPage, FederationFailure>;
  readonly search: (query: SearchQuery) => Effect.Effect<FederatedPage, FederationFailure>;
  readonly detail: (
    canonicalId: string,
    clientUserAgent?: string,
  ) => Effect.Effect<CanonicalItemView | null, FederationFailure>;
  readonly lookupMembership: (
    canonicalId: string,
    versionId?: string,
  ) => Effect.Effect<CatalogMembership | null, FederationFailure>;
  readonly enrichVersions: (
    canonicalId: string,
    clientUserAgent?: string,
  ) => Effect.Effect<CanonicalItemView | null, FederationFailure>;
  readonly invalidateStateDependentGenerations: () => Effect.Effect<void, RepositoryError>;
}

export class Federation extends Context.Service<Federation, FederationService>()(
  "oh-my-emby/Federation",
) {}

export interface FederationConfig {
  readonly now?: () => number;
  readonly listDeadlineMs?: number;
  readonly detailDeadlineMs?: number;
}

interface BufferedItem {
  readonly canonicalId: string;
  readonly sortValues: ReadonlyArray<JsonValue>;
}

interface SourceCursor {
  readonly serverId: string;
  readonly serverGeneration: number;
  readonly sourceLibraryId: string;
  readonly sourceOrder: number;
  continuation: number;
  scanned: number;
  exhausted: boolean;
  incomplete: boolean;
  reportedTotal: number | null;
  buffer: Array<BufferedItem>;
}

interface GenerationState {
  sources: Array<SourceCursor>;
  localBuffer: Array<BufferedItem>;
  scanned: number;
}

interface UpstreamPage {
  readonly items: ReadonlyArray<Record<string, JsonValue>>;
  readonly totalRecordCount: number | null;
}

const jsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toJson = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) =>
        entry === undefined ? [] : [[key, toJson(entry)]],
      ),
    );
  }
  throw new TypeError("upstream value is not JSON");
};

const parsePage = (value: unknown): UpstreamPage => {
  const page = toJson(value);
  if (!jsonObject(page) || !Array.isArray(page.Items))
    throw new TypeError("upstream page must contain Items");
  const items = page.Items.map((entry) => {
    if (!jsonObject(entry) || typeof entry.Id !== "string" || typeof entry.Type !== "string") {
      throw new TypeError("upstream item must contain Id and Type");
    }
    return entry;
  });
  return {
    items,
    totalRecordCount:
      typeof page.TotalRecordCount === "number" && Number.isSafeInteger(page.TotalRecordCount)
        ? page.TotalRecordCount
        : null,
  };
};

const canonicalJson = (value: JsonValue): string =>
  JSON.stringify(value, (_key, entry) => {
    if (entry === null || Array.isArray(entry) || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((key) => [key, entry[key]]),
    );
  });

const normalizedQuery = (query: FederatedQuery, searchTerm?: string): JsonValue => ({
  fields: [...new Set(query.fields ?? [])].sort(),
  filters: [...query.filters].sort((left, right) =>
    canonicalJson(left as unknown as JsonValue).localeCompare(
      canonicalJson(right as unknown as JsonValue),
    ),
  ) as unknown as JsonValue,
  itemTypes: [...new Set(query.itemTypes)].sort(),
  searchTerm: searchTerm?.trim() ?? "",
  sort: query.sort as unknown as JsonValue,
});

const queryKey = (query: FederatedQuery, normalized: JsonValue): string =>
  canonicalJson({
    deviceId: query.deviceId,
    normalized,
    userId: query.userId,
    virtualLibraryId: query.virtualLibraryId,
  });

const sourceKey = (source: {
  readonly serverId: string;
  readonly serverGeneration: number;
  readonly sourceLibraryId: string;
}) => JSON.stringify([source.serverId, source.serverGeneration, source.sourceLibraryId]);

const newState = (sources: ReadonlyArray<EligibleSource>): GenerationState => ({
  sources: sources.map((source) => ({
    serverId: source.serverId,
    serverGeneration: source.serverGeneration,
    sourceLibraryId: source.sourceLibraryId,
    sourceOrder: source.sourceOrder,
    continuation: 0,
    scanned: 0,
    exhausted: false,
    incomplete: false,
    reportedTotal: null,
    buffer: [],
  })),
  localBuffer: [],
  scanned: 0,
});

const decodeState = (value: JsonValue, sources: ReadonlyArray<EligibleSource>): GenerationState => {
  if (!jsonObject(value) || !Array.isArray(value.sources) || !Array.isArray(value.localBuffer)) {
    return newState(sources);
  }
  return value as unknown as GenerationState;
};

const sameParticipation = (
  state: GenerationState,
  sources: ReadonlyArray<EligibleSource>,
): boolean =>
  state.sources.length === sources.length &&
  state.sources.every(
    (cursor, index) =>
      sourceKey(cursor) === sourceKey(sources[index]!) &&
      cursor.sourceOrder === sources[index]!.sourceOrder,
  );

const projectionKey = (query: FederatedQuery): string =>
  `list:${[...new Set(query.fields ?? [])].sort().join(",")}`;

const providerIds = (item: Record<string, JsonValue>): ProviderIds => {
  const raw = item.ProviderIds;
  const ids: { readonly [key: string]: JsonValue } =
    raw !== undefined && jsonObject(raw) ? raw : {};
  const read = (name: string) => (typeof ids[name] === "string" ? ids[name] : null);
  return { tmdbMovie: read("Tmdb"), tmdbTv: read("Tmdb"), imdbTitle: read("Imdb") };
};

const mediaVersions = (item: Record<string, JsonValue>, provider: string) =>
  Array.isArray(item.MediaSources)
    ? item.MediaSources.flatMap((entry) => {
        if (!jsonObject(entry) || typeof entry.Id !== "string") return [];
        const name = typeof entry.Name === "string" ? entry.Name : entry.Id;
        return [
          {
            upstreamMediaSourceId: entry.Id,
            label: `[${provider}] ${name}`,
            capabilities: entry,
            streams: Array.isArray(entry.MediaStreams) ? entry.MediaStreams : [],
          },
        ];
      })
    : [];

const candidate = (
  source: EligibleSource,
  item: Record<string, JsonValue>,
  observedAtMs: number,
): SourceItemCandidate => ({
  serverId: source.serverId,
  catalogNamespace: source.catalogNamespace,
  verifiedCatalogId: source.verifiedCatalogId,
  serverGeneration: source.serverGeneration,
  sourceLibraryId: source.sourceLibraryId,
  upstreamItemId: item.Id as string,
  itemType: item.Type as SourceItemCandidate["itemType"],
  providerIds: providerIds(item),
  displayMetadata: item,
  mediaVersions: mediaVersions(item, source.name),
  observedAtMs,
});

const stateDependent = (query: FederatedQuery) =>
  query.filters.some(
    ({ field }) => field === "favorite" || field === "resume" || field === "played",
  );

const localMembershipOnly = (query: FederatedQuery) =>
  query.filters.length > 0 &&
  query.filters.every(
    ({ field, value }) => (field === "favorite" || field === "resume") && value === true,
  );

const stateMatches = (state: UserStateRecord | null, field: string, value: JsonValue): boolean => {
  if (field === "favorite") return (state?.favorite ?? false) === value;
  if (field === "played") return (state?.played ?? false) === value;
  if (field === "resume")
    return ((state?.positionTicks ?? 0) > 0 && !(state?.played ?? false)) === value;
  return true;
};

const matchesFilters = (
  record: CatalogItemRecord,
  filters: ReadonlyArray<CatalogFilter>,
): boolean =>
  filters.every(({ field, value }) => {
    if (field === "favorite" || field === "played" || field === "resume") {
      return stateMatches(record.userState, field, value);
    }
    if (field === "itemType") return record.canonical.itemType === value;
    const metadata = record.canonical.displayMetadata;
    if (!jsonObject(metadata)) return false;
    const actual = metadata[field];
    return Array.isArray(actual) ? actual.some((entry) => entry === value) : actual === value;
  });

const matchesItemTypes = (record: CatalogItemRecord, itemTypes: ReadonlyArray<string>): boolean =>
  itemTypes.length === 0 || itemTypes.includes(record.canonical.itemType);

const sortValues = (
  record: CatalogItemRecord,
  sort: ReadonlyArray<SortTerm>,
): ReadonlyArray<JsonValue> => {
  const metadata = record.canonical.displayMetadata;
  return sort.map(({ field }) => (jsonObject(metadata) ? (metadata[field] ?? null) : null));
};

const compareValue = (left: JsonValue, right: JsonValue): number => {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
};

const compareBuffered = (
  left: BufferedItem,
  right: BufferedItem,
  sort: ReadonlyArray<SortTerm>,
): number => {
  for (let index = 0; index < sort.length; index++) {
    const compared = compareValue(left.sortValues[index] ?? null, right.sortValues[index] ?? null);
    if (compared !== 0) return sort[index]!.direction === "Descending" ? -compared : compared;
  }
  return left.canonicalId.localeCompare(right.canonicalId);
};

const transient = (error: UpstreamFailure): boolean =>
  error instanceof UpstreamUnavailable || error instanceof UpstreamTimeout;

const deadline = <A, E>(effect: Effect.Effect<A, E>, serverId: string, durationMs: number) =>
  effect.pipe(
    Effect.timeout(durationMs),
    Effect.catchTag("TimeoutError", () => Effect.fail(new UpstreamTimeout({ serverId }))),
  );

const listPath = (
  source: EligibleSource,
  query: FederatedQuery,
  startIndex: number,
  limit: number,
  searchTerm?: string,
) => {
  const parameters = new URLSearchParams({
    ParentId: source.sourceLibraryId,
    Recursive: "true",
    StartIndex: String(startIndex),
    Limit: String(limit),
    Fields: [...new Set([...(query.fields ?? []), "ProviderIds"])].join(","),
  });
  if (query.sort.length > 0) {
    parameters.set("SortBy", query.sort.map(({ field }) => field).join(","));
    parameters.set("SortOrder", query.sort.map(({ direction }) => direction).join(","));
  }
  if (searchTerm?.trim()) parameters.set("SearchTerm", searchTerm.trim());
  if (query.itemTypes.length > 0) {
    parameters.set("IncludeItemTypes", [...new Set(query.itemTypes)].join(","));
  }
  return `/Items?${parameters}`;
};

const directItemPath = (upstreamUserId: string, upstreamItemId: string): string => {
  const parameters = new URLSearchParams({ Fields: "ProviderIds,MediaSources" });
  return `/Users/${encodeURIComponent(upstreamUserId)}/Items/${encodeURIComponent(upstreamItemId)}?${parameters}`;
};

const parseItem = (value: unknown): Record<string, JsonValue> => {
  const item = parsePage({ Items: [value] }).items[0];
  if (item === undefined) throw new TypeError("upstream item is missing");
  return item;
};

const exactClaim = (
  record: CatalogItemRecord,
): { namespace: ProviderNamespace; value: string } | null => {
  const priority =
    record.canonical.itemType === "Movie"
      ? ["tmdb:movie", "imdb:title"]
      : record.canonical.itemType === "Series"
        ? ["tmdb:tv", "imdb:title"]
        : ["imdb:title"];
  for (const namespace of priority) {
    const claim = record.claims.find(
      (entry) => entry.namespace === namespace && entry.state === "exact",
    );
    if (claim) return { namespace: namespace as ProviderNamespace, value: claim.value };
  }
  return null;
};

const embyProvider = (namespace: ProviderNamespace) =>
  namespace.startsWith("tmdb:") ? "tmdb" : "imdb";

const matchesClaim = (
  item: Record<string, JsonValue>,
  claim: { namespace: ProviderNamespace; value: string },
) => {
  const ids = providerIds(item);
  return claim.namespace === "tmdb:movie"
    ? ids.tmdbMovie === claim.value && item.Type === "Movie"
    : claim.namespace === "tmdb:tv"
      ? ids.tmdbTv === claim.value && item.Type === "Series"
      : ids.imdbTitle === claim.value;
};

const view = (
  record: CatalogItemRecord,
  incompleteSourceIds: ReadonlyArray<string>,
): CanonicalItemView => ({
  id: record.canonical.id,
  itemType: record.canonical.itemType,
  displayMetadata: record.canonical.displayMetadata,
  mediaVersions: record.mediaVersions,
  userState: record.userState,
  incompleteSourceIds,
});

export const makeFederationLayer = (
  config: FederationConfig = {},
): Layer.Layer<Federation, never, Repositories | Identity | MetadataProviders | UpstreamClient> =>
  Layer.effect(
    Federation,
    Effect.gen(function* () {
      const repositories = yield* Repositories;
      const identity = yield* Identity;
      const metadataProviders = yield* MetadataProviders;
      const upstream = yield* UpstreamClient;
      const now = config.now ?? Date.now;
      const listDeadlineMs = config.listDeadlineMs ?? UPSTREAM_LIST_DEADLINE_MS;
      const detailDeadlineMs = config.detailDeadlineMs ?? UPSTREAM_DETAIL_DEADLINE_MS;

      const readCatalog = (ids: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const records: Array<CatalogItemRecord> = [];
          for (let index = 0; index < ids.length; index += DB_BATCH_SIZE) {
            records.push(
              ...(yield* repositories.readCatalogItems(
                ids.slice(index, index + DB_BATCH_SIZE),
                now(),
              )),
            );
          }
          return records;
        });

      const persist = (
        generation: QueryGeneration,
        state: GenerationState,
        items: ReadonlyArray<QueryGenerationItem>,
        exhausted: boolean,
        expected: { readonly id: string; readonly revision: number } | null,
      ) =>
        Effect.gen(function* () {
          const revision = expected?.id === generation.id ? expected.revision + 1 : 0;
          const saved = {
            ...generation,
            revision,
            sourceState: state as unknown as JsonValue,
            allSourcesExhausted: exhausted,
          };
          const applied = yield* repositories.appendQueryGenerationItems({
            generation: saved,
            items,
            expected,
          });
          return applied ? saved : null;
        });

      const cacheItem = (
        resolution: IdentityResolution,
        projection: string,
        payload: Record<string, JsonValue>,
        observedAtMs: number,
      ) =>
        Effect.gen(function* () {
          yield* repositories.writeMetadataProjection({
            sourceItemId: resolution.sourceItem.id,
            projectionKey: projection,
            payload,
            freshUntilMs: observedAtMs + METADATA_FRESH_MS,
            staleUntilMs: observedAtMs + METADATA_STALE_MS,
            updatedAtMs: observedAtMs,
          });
          yield* repositories.mergeCanonicalMetadata(
            resolution.canonical.id,
            resolution.sourceItem.id,
            payload,
            observedAtMs,
          );
        });

      const resolvePageItems = (
        source: EligibleSource,
        items: ReadonlyArray<Record<string, JsonValue>>,
        query: FederatedQuery,
        projection: string,
        observedAtMs: number,
        writeCache: boolean,
      ) =>
        Effect.gen(function* () {
          const resolved: Array<BufferedItem> = [];
          for (const raw of items) {
            if (!["Movie", "Series", "Season", "Episode"].includes(raw.Type as string)) continue;
            const result = yield* identity.resolve(candidate(source, raw, observedAtMs));
            if (writeCache) yield* cacheItem(result, projection, raw, observedAtMs);
            const records = yield* repositories.readCatalogItems([result.canonical.id], now());
            const record = records[0];
            if (
              record &&
              matchesFilters(record, query.filters) &&
              matchesItemTypes(record, query.itemTypes)
            ) {
              resolved.push({
                canonicalId: record.canonical.id,
                sortValues: sortValues(record, query.sort),
              });
            }
          }
          return resolved;
        });

      const runList = (
        query: FederatedQuery,
        searchTerm?: string,
      ): Effect.Effect<FederatedPage, FederationFailure> =>
        Effect.gen(function* () {
          const startIndex = Number.isSafeInteger(query.startIndex)
            ? Math.max(0, query.startIndex)
            : 0;
          const limit = Number.isSafeInteger(query.limit)
            ? Math.max(0, Math.min(MAX_PAGE_SIZE, query.limit))
            : MAX_PAGE_SIZE;
          const requestedEnd = startIndex + limit;
          if (requestedEnd > MAX_MATERIALIZED_ITEMS) {
            return yield* Effect.fail(
              new FederationLimitExceeded({
                requestedEnd,
                maximum: MAX_MATERIALIZED_ITEMS,
              }),
            );
          }

          const sources = yield* repositories.resolveEligibleSources(query.virtualLibraryId);
          const normalized = normalizedQuery(query, searchTerm);
          const key = queryKey(query, normalized);
          const projection = projectionKey(query);

          const openGeneration = Effect.gen(function* () {
            while (true) {
              const currentTime = now();
              const current = yield* repositories.readQueryGeneration(key);
              const currentState =
                current === null ? newState(sources) : decodeState(current.sourceState, sources);
              if (
                current !== null &&
                current.expiresAtMs > currentTime &&
                sameParticipation(currentState, sources)
              )
                return current;

              const state = newState(sources);
              const replacement: QueryGeneration = {
                id: crypto.randomUUID(),
                queryKey: key,
                revision: 0,
                userKey: query.userId,
                deviceId: query.deviceId,
                virtualLibraryId: query.virtualLibraryId,
                normalizedQuery: normalized,
                sourceState: state as unknown as JsonValue,
                allSourcesExhausted: false,
                stateDependent: stateDependent(query),
                createdAtMs: currentTime,
                expiresAtMs: currentTime + QUERY_GENERATION_TTL_MS,
              };
              const saved = yield* persist(
                replacement,
                state,
                [],
                false,
                current === null ? null : { id: current.id, revision: current.revision },
              );
              if (saved !== null) return saved;
            }
          });

          retryPublication: while (true) {
            let generation = yield* openGeneration;
            const state = decodeState(generation.sourceState, sources);
            const published = [...(yield* repositories.readQueryGenerationItems(generation.id))];
            const publishedIds = new Set(published.map(({ canonicalId }) => canonicalId));
            const blocked = new Set<string>();
            let exhausted = generation.allSourcesExhausted;

            while (
              published.length < requestedEnd &&
              state.scanned < MAX_MATERIALIZED_ITEMS &&
              !exhausted
            ) {
              const additions: Array<QueryGenerationItem> = [];
              let dirty = false;

              if (
                localMembershipOnly(query) &&
                state.localBuffer.length === 0 &&
                !state.sources.every((cursor) => cursor.exhausted)
              ) {
                const favorite = query.filters.find(({ field }) => field === "favorite")?.value;
                const resume = query.filters.find(({ field }) => field === "resume")?.value;
                const ids = yield* repositories.listStateMemberCanonicalIds({
                  virtualLibraryId: query.virtualLibraryId,
                  ...(typeof favorite === "boolean" ? { favorite } : {}),
                  ...(typeof resume === "boolean" ? { resume } : {}),
                  limit: MAX_MATERIALIZED_ITEMS,
                });
                const records = yield* readCatalog(ids);
                state.localBuffer = records
                  .filter(
                    (record) =>
                      matchesFilters(record, query.filters) &&
                      matchesItemTypes(record, query.itemTypes),
                  )
                  .map((record) => ({
                    canonicalId: record.canonical.id,
                    sortValues: sortValues(record, query.sort),
                  }))
                  .sort((left, right) => compareBuffered(left, right, query.sort));
                for (const cursor of state.sources) cursor.exhausted = true;
                dirty = true;
              }

              while (
                published.length + additions.length < requestedEnd &&
                additions.length < DB_BATCH_SIZE &&
                state.scanned < MAX_MATERIALIZED_ITEMS
              ) {
                if (state.localBuffer.length > 0) {
                  const next = state.localBuffer.shift()!;
                  dirty = true;
                  if (!publishedIds.has(next.canonicalId)) {
                    const entry = { ...next, ordinal: published.length + additions.length };
                    additions.push(entry);
                    publishedIds.add(entry.canonicalId);
                  }
                  continue;
                }

                const pending = state.sources.filter(
                  (cursor) =>
                    !cursor.exhausted &&
                    cursor.buffer.length === 0 &&
                    !blocked.has(sourceKey(cursor)),
                );
                if (pending.length > 0) {
                  let remainingScanBudget = MAX_MATERIALIZED_ITEMS - state.scanned;
                  const fetches = pending.flatMap((cursor, index) => {
                    if (remainingScanBudget <= 0) return [];
                    const pageLimit = Math.min(
                      DB_BATCH_SIZE,
                      Math.max(1, Math.floor(remainingScanBudget / (pending.length - index))),
                    );
                    remainingScanBudget -= pageLimit;
                    return [{ cursor, pageLimit }];
                  });
                  yield* Effect.forEach(
                    fetches,
                    ({ cursor, pageLimit }) =>
                      Effect.gen(function* () {
                        const source = sources.find(
                          (candidate) => sourceKey(candidate) === sourceKey(cursor),
                        )!;
                        const path = listPath(
                          source,
                          query,
                          cursor.continuation,
                          pageLimit,
                          searchTerm,
                        );
                        const attempted = yield* deadline(
                          upstream.request(
                            {
                              serverId: source.serverId,
                              generation: source.serverGeneration,
                              path,
                              method: "GET",
                              ...(query.clientUserAgent === undefined
                                ? {}
                                : { clientUserAgent: query.clientUserAgent }),
                            },
                            Schema.Unknown,
                          ),
                          source.serverId,
                          listDeadlineMs,
                        ).pipe(Effect.result);
                        dirty = true;
                        if (Result.isSuccess(attempted)) {
                          const processed = yield* Effect.gen(function* () {
                            const received = yield* Effect.try({
                              try: () => parsePage(attempted.success),
                              catch: () =>
                                new UpstreamInvalidResponse({ serverId: source.serverId }),
                            });
                            const page = { ...received, items: received.items.slice(0, pageLimit) };
                            const observedAtMs = now();
                            const items = yield* resolvePageItems(
                              source,
                              page.items,
                              query,
                              projection,
                              observedAtMs,
                              true,
                            );
                            return { page, items };
                          }).pipe(Effect.result);
                          if (Result.isSuccess(processed)) {
                            const { page, items } = processed.success;
                            cursor.continuation += page.items.length;
                            cursor.scanned += page.items.length;
                            state.scanned += page.items.length;
                            cursor.reportedTotal = page.totalRecordCount;
                            cursor.exhausted =
                              page.items.length === 0 ||
                              (page.totalRecordCount !== null &&
                                cursor.continuation >= page.totalRecordCount);
                            cursor.incomplete = false;
                            cursor.buffer.push(
                              ...items.sort((left, right) =>
                                compareBuffered(left, right, query.sort),
                              ),
                            );
                            return;
                          }
                          if (processed.failure instanceof RepositoryError)
                            return yield* Effect.fail(processed.failure);
                        }
                        cursor.incomplete = true;
                        blocked.add(sourceKey(cursor));
                      }),
                    { concurrency: MAX_FANOUT_CONCURRENCY, discard: true },
                  );

                  const bufferedIds = [
                    ...new Set(
                      state.sources.flatMap((cursor) =>
                        cursor.buffer.map(({ canonicalId }) => canonicalId),
                      ),
                    ),
                  ];
                  const refreshed = new Map(
                    (yield* readCatalog(bufferedIds)).map((record) => [
                      record.canonical.id,
                      record,
                    ]),
                  );
                  for (const cursor of state.sources) {
                    cursor.buffer = cursor.buffer
                      .flatMap(({ canonicalId }) => {
                        const record = refreshed.get(canonicalId);
                        return record && matchesFilters(record, query.filters)
                          ? [{ canonicalId, sortValues: sortValues(record, query.sort) }]
                          : [];
                      })
                      .sort((left, right) => compareBuffered(left, right, query.sort));
                  }
                }

                const heads = state.sources.flatMap((cursor) =>
                  cursor.buffer[0] ? [{ cursor, item: cursor.buffer[0] }] : [],
                );
                if (heads.length === 0) {
                  if (
                    state.sources.some(
                      (cursor) => !cursor.exhausted && !blocked.has(sourceKey(cursor)),
                    )
                  )
                    continue;
                  break;
                }
                heads.sort((left, right) => compareBuffered(left.item, right.item, query.sort));
                const selected = heads[0]!;
                selected.cursor.buffer.shift();
                dirty = true;
                if (publishedIds.has(selected.item.canonicalId)) continue;
                const entry = {
                  ...selected.item,
                  ordinal: published.length + additions.length,
                };
                additions.push(entry);
                publishedIds.add(entry.canonicalId);
              }

              const nextExhausted =
                state.localBuffer.length === 0 &&
                (state.scanned >= MAX_MATERIALIZED_ITEMS ||
                  state.sources.every((cursor) => cursor.exhausted && cursor.buffer.length === 0));
              dirty ||= nextExhausted !== exhausted;
              exhausted = nextExhausted;
              if (!dirty) break;
              const saved = yield* persist(generation, state, additions, exhausted, {
                id: generation.id,
                revision: generation.revision,
              });
              if (saved === null) continue retryPublication;
              generation = saved;
              published.push(...additions);
              if (additions.length === 0) break;
            }

            if (
              published.length === 0 &&
              sources.length > 0 &&
              state.sources.every((cursor) => cursor.incomplete)
            ) {
              return yield* Effect.fail(
                new FederationUnavailable({
                  sourceIds: [...new Set(state.sources.map(({ serverId }) => serverId))].sort(),
                }),
              );
            }

            const pageIds = published
              .slice(startIndex, requestedEnd)
              .map(({ canonicalId }) => canonicalId);
            const records = yield* repositories.readCatalogItems(pageIds, now());
            const incompleteSourceIds = [
              ...new Set(
                state.sources
                  .filter(({ incomplete }) => incomplete)
                  .map(({ serverId }) => serverId),
              ),
            ].sort();
            const totalRecordCount = exhausted
              ? published.length
              : Math.max(published.length, requestedEnd + 1);
            const overlaid = yield* Effect.forEach(records, metadataProviders.overlayCached);
            return {
              items: overlaid.map((record) => view(record, incompleteSourceIds)),
              totalRecordCount,
              exhausted,
              incompleteSourceIds,
            };
          }
        });

      const enrichVersions = (
        canonicalId: string,
        clientUserAgent?: string,
      ): Effect.Effect<CanonicalItemView | null, FederationFailure> =>
        Effect.gen(function* () {
          const activeId = yield* identity.lookupCanonicalId(canonicalId);
          if (activeId === null) return null;
          let record = (yield* repositories.readCatalogItems([activeId], now()))[0];
          if (!record) return null;
          const claim = exactClaim(record);
          if (claim === null || record.sourceItems.length === 0) {
            return view(yield* metadataProviders.refresh(record), []);
          }

          const currentRecord = record;
          const sources = yield* repositories.resolveEligibleSourcesForCanonical(activeId);
          const anchor = currentRecord.sourceItems[0]!;
          const incomplete = new Set<string>();
          yield* Effect.forEach(
            sources,
            (source) =>
              Effect.gen(function* () {
                const negativeKey = `exact:${sourceKey(source)}:${claim.namespace}:${claim.value}`;
                const knownSourceItems = currentRecord.sourceItems.filter(
                  (item) =>
                    item.serverId === source.serverId &&
                    item.serverGeneration === source.serverGeneration &&
                    item.sourceLibraryId === source.sourceLibraryId,
                );
                const suppressStaleVersions = (observedAtMs: number) =>
                  repositories.suppressDetailProjections({
                    canonicalId: activeId,
                    serverId: source.serverId,
                    serverGeneration: source.serverGeneration,
                    sourceLibraryId: source.sourceLibraryId,
                    observedAtMs,
                  });
                const suppressKnownDetail = (sourceItemId: string, observedAtMs: number) =>
                  repositories.writeMetadataProjection({
                    sourceItemId,
                    projectionKey: "detail",
                    payload: { suppressed: true },
                    freshUntilMs: observedAtMs,
                    staleUntilMs: observedAtMs,
                    updatedAtMs: observedAtMs,
                  });
                const cacheExactResult = (found: boolean, observedAtMs: number) =>
                  repositories.writeMetadataProjection({
                    sourceItemId: anchor.id,
                    projectionKey: negativeKey,
                    payload: { found },
                    freshUntilMs: observedAtMs + METADATA_FRESH_MS,
                    staleUntilMs: observedAtMs + (found ? METADATA_STALE_MS : METADATA_FRESH_MS),
                    updatedAtMs: observedAtMs,
                  });
                const cacheMatchingItems = (
                  items: ReadonlyArray<Record<string, JsonValue>>,
                  observedAtMs: number,
                ) =>
                  Effect.gen(function* () {
                    let compatible = false;
                    for (const raw of items) {
                      if (!matchesClaim(raw, claim)) continue;
                      const result = yield* identity.resolve(candidate(source, raw, observedAtMs));
                      yield* cacheItem(result, "detail", raw, observedAtMs);
                      compatible ||=
                        (yield* identity.lookupCanonicalId(result.canonical.id)) === activeId;
                    }
                    return compatible;
                  });
                const cached = yield* repositories.readMetadataProjection(anchor.id, negativeKey);
                const cachedResult =
                  cached && cached.freshUntilMs > now() && jsonObject(cached.payload)
                    ? cached.payload.found
                    : undefined;
                if (cachedResult === true) return;
                const refreshKnownItems = () =>
                  Effect.gen(function* () {
                    if (knownSourceItems.length === 0) return "missing" as const;
                    const server = yield* repositories.getServer(source.serverId);
                    const upstreamUserId =
                      server?.generation === source.serverGeneration ? server.upstreamUserId : null;
                    if (upstreamUserId === null) return "invalid" as const;
                    const refreshed = yield* deadline(
                      Effect.forEach(
                        knownSourceItems,
                        (known) =>
                          Effect.gen(function* () {
                            const direct = yield* upstream
                              .request(
                                {
                                  serverId: source.serverId,
                                  generation: source.serverGeneration,
                                  path: directItemPath(upstreamUserId, known.upstreamItemId),
                                  replayPath: (refreshedUserId) =>
                                    directItemPath(refreshedUserId, known.upstreamItemId),
                                  method: "GET",
                                },
                                Schema.Unknown,
                              )
                              .pipe(Effect.result);
                            if (Result.isFailure(direct)) {
                              if (direct.failure instanceof RepositoryError)
                                return yield* Effect.fail(direct.failure);
                              if (transient(direct.failure)) return "transient" as const;
                              if (direct.failure instanceof UpstreamNotFound) {
                                yield* suppressKnownDetail(known.id, now());
                                return "missing" as const;
                              }
                              return "invalid" as const;
                            }
                            const observedAtMs = now();
                            const processed = yield* Effect.gen(function* () {
                              const item = yield* Effect.try({
                                try: () => parseItem(direct.success),
                                catch: () =>
                                  new UpstreamInvalidResponse({ serverId: source.serverId }),
                              });
                              return yield* cacheMatchingItems([item], observedAtMs);
                            }).pipe(Effect.result);
                            if (Result.isFailure(processed)) {
                              if (processed.failure instanceof RepositoryError)
                                return yield* Effect.fail(processed.failure);
                              return "invalid" as const;
                            }
                            if (!processed.success)
                              yield* suppressKnownDetail(known.id, observedAtMs);
                            return processed.success ? ("found" as const) : ("missing" as const);
                          }),
                        { concurrency: 1 },
                      ),
                      source.serverId,
                      detailDeadlineMs,
                    ).pipe(Effect.result);
                    if (Result.isFailure(refreshed)) {
                      if (refreshed.failure instanceof RepositoryError)
                        return yield* Effect.fail(refreshed.failure);
                      return transient(refreshed.failure)
                        ? ("transient" as const)
                        : ("invalid" as const);
                    }
                    return refreshed.success.includes("transient")
                      ? ("transient" as const)
                      : refreshed.success.includes("found") &&
                          (refreshed.success.includes("invalid") ||
                            refreshed.success.includes("missing"))
                        ? ("partial" as const)
                        : refreshed.success.includes("invalid")
                          ? ("invalid" as const)
                          : refreshed.success.includes("found")
                            ? ("found" as const)
                            : ("missing" as const);
                  });
                if (cachedResult === false) {
                  const refreshed = yield* refreshKnownItems();
                  if (refreshed === "found") yield* cacheExactResult(true, now());
                  if (refreshed === "transient" || refreshed === "partial")
                    incomplete.add(source.serverId);
                  if (refreshed === "invalid") {
                    yield* suppressStaleVersions(now());
                    incomplete.add(source.serverId);
                  }
                  return;
                }

                const parameters = new URLSearchParams({
                  ParentId: source.sourceLibraryId,
                  Recursive: "true",
                  AnyProviderIdEquals: `${embyProvider(claim.namespace)}.${claim.value}`,
                  Fields: "ProviderIds,MediaSources",
                  Limit: String(DB_BATCH_SIZE),
                });
                const attempted = yield* deadline(
                  upstream.request(
                    {
                      serverId: source.serverId,
                      generation: source.serverGeneration,
                      path: `/Items?${parameters}`,
                      method: "GET",
                      ...(clientUserAgent === undefined ? {} : { clientUserAgent }),
                    },
                    Schema.Unknown,
                  ),
                  source.serverId,
                  detailDeadlineMs,
                ).pipe(Effect.result);
                const observedAtMs = now();
                if (Result.isFailure(attempted)) {
                  if (attempted.failure instanceof RepositoryError)
                    return yield* Effect.fail(attempted.failure);
                  if (transient(attempted.failure)) {
                    incomplete.add(source.serverId);
                    return;
                  }
                  yield* suppressStaleVersions(observedAtMs);
                  if (attempted.failure instanceof UpstreamNotFound) {
                    yield* cacheExactResult(false, observedAtMs);
                    return;
                  }
                  incomplete.add(source.serverId);
                  return;
                }
                const processed = yield* Effect.gen(function* () {
                  const page = yield* Effect.try({
                    try: () => parsePage(attempted.success),
                    catch: () => new UpstreamInvalidResponse({ serverId: source.serverId }),
                  });
                  return yield* cacheMatchingItems(page.items, observedAtMs);
                }).pipe(Effect.result);
                if (Result.isFailure(processed)) {
                  if (processed.failure instanceof RepositoryError)
                    return yield* Effect.fail(processed.failure);
                  yield* suppressStaleVersions(observedAtMs);
                  incomplete.add(source.serverId);
                  return;
                }
                let foundCompatible = processed.success;
                const refreshed = foundCompatible ? "missing" : yield* refreshKnownItems();
                if (refreshed === "found") foundCompatible = true;
                if (refreshed === "transient" || refreshed === "partial") {
                  incomplete.add(source.serverId);
                  return;
                }
                if (refreshed === "invalid") {
                  yield* suppressStaleVersions(observedAtMs);
                  incomplete.add(source.serverId);
                  return;
                }
                yield* cacheExactResult(foundCompatible, observedAtMs);
                if (!foundCompatible) yield* suppressStaleVersions(observedAtMs);
              }),
            { concurrency: MAX_FANOUT_CONCURRENCY },
          );
          record = (yield* repositories.readCatalogItems([activeId], now()))[0];
          return record
            ? view(yield* metadataProviders.refresh(record), [...incomplete].sort())
            : null;
        });

      const lookupMembership = (
        canonicalId: string,
        versionId?: string,
      ): Effect.Effect<CatalogMembership | null, FederationFailure> =>
        Effect.gen(function* () {
          const activeId = yield* identity.lookupCanonicalId(canonicalId);
          if (activeId === null) return null;
          const record = (yield* repositories.readCatalogItems([activeId]))[0];
          if (!record) return null;
          const version =
            versionId === undefined
              ? null
              : (record.mediaVersions.find(({ id }) => id === versionId) ?? null);
          if (versionId !== undefined && version === null) return null;
          return { item: view(yield* metadataProviders.overlayCached(record), []), version };
        });

      return Federation.of({
        list: (query) => runList(query),
        search: (query) => runList(query, query.searchTerm),
        detail: enrichVersions,
        lookupMembership,
        enrichVersions,
        invalidateStateDependentGenerations: repositories.invalidateStateDependentQueryGenerations,
      });
    }),
  );
