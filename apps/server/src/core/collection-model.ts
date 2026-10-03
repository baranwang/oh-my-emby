import type { Effect } from "effect";
import type { RepositoryError } from "./errors.js";
import type { JsonValue } from "./model.js";
import type { SortTerm } from "./federation.js";
import type { ExternalMetadataPayload } from "./metadata-providers.js";

export interface CollectionScope {
  readonly virtualLibraryId: string | null;
}
export interface CollectionSource {
  readonly serverId: string;
  readonly catalogNamespace: string;
  readonly serverGeneration: number;
  readonly upstreamBoxSetId: string;
  readonly metadata?: JsonValue;
}
export interface CollectionRecord {
  readonly id: string;
  readonly tmdbCollectionId: string | null;
  readonly displayMetadata: JsonValue;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
export interface CollectionView {
  readonly id: string;
  readonly displayMetadata: JsonValue;
  readonly childCount: number;
  readonly incompleteSourceIds: ReadonlyArray<string>;
}
export interface CollectionMovieRef {
  readonly canonicalId: string;
  readonly sourceItemId: string;
}
export interface CollectionSnapshot {
  readonly source: CollectionSource;
  readonly collectionId: string;
  readonly members: ReadonlyArray<CollectionMovieRef>;
  readonly complete: boolean;
  readonly observedAtMs: number;
}
export interface TmdbCollectionPayload {
  readonly id: string;
  readonly Name: string;
  readonly Overview?: string;
  readonly ExternalImages?: ExternalMetadataPayload["ExternalImages"];
  readonly movieIds: ReadonlyArray<string>;
  readonly ExternalArtworkRevision?: number;
  readonly ExternalArtworkLanguage?: string;
}
export interface CollectionQuery {
  readonly scope: CollectionScope;
  readonly startIndex: number;
  readonly limit: number;
  readonly sort: ReadonlyArray<SortTerm>;
  readonly searchTerm?: string;
  readonly clientUserAgent?: string;
}
export interface CollectionPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly totalRecordCount: number;
  readonly exhausted: boolean;
  readonly incompleteSourceIds: ReadonlyArray<string>;
}
export interface CollectionRepositories {
  readonly upsertCollection: (input: {
    tmdbCollectionId: string | null;
    source?: CollectionSource;
    metadata: JsonValue;
    observedAtMs: number;
  }) => Effect.Effect<CollectionRecord | null, RepositoryError>;
  readonly replaceTmdbCollectionMembership: (input: {
    sourceItemId: string;
    tmdbCollectionId: string | null;
    expectedGeneration: number;
    observedAtMs: number;
  }) => Effect.Effect<boolean, RepositoryError>;
  readonly writeCollectionSnapshot: (
    input: CollectionSnapshot,
  ) => Effect.Effect<boolean, RepositoryError>;
  readonly readCollection: (
    id: string,
    scope: CollectionScope,
  ) => Effect.Effect<CollectionRecord | null, RepositoryError>;
  readonly readCollectionMovies: (
    id: string,
    scope: CollectionScope,
  ) => Effect.Effect<ReadonlyArray<CollectionMovieRef>, RepositoryError>;
  readonly listVisibleCollections: (
    scope: CollectionScope,
  ) => Effect.Effect<ReadonlyArray<CollectionRecord>, RepositoryError>;
  readonly readCollectionSources: (
    id: string,
    scope: CollectionScope,
  ) => Effect.Effect<ReadonlyArray<CollectionSource>, RepositoryError>;
  readonly readCollectionRevision: () => Effect.Effect<number, RepositoryError>;
}
