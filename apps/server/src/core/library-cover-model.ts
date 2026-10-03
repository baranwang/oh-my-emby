import { Schema, type Effect } from "effect";
import type { RepositoryError } from "./errors.js";
import type { ServerEligibilityFence, VirtualLibrary } from "./model.js";
export const COVER_WIDTH = 1920,
  COVER_HEIGHT = 1080,
  MAX_COVER_BYTES = 512000,
  COVER_TEMPLATE_VERSION = "rotated-posters-v1";
export class LibraryCoverValidationFailed extends Schema.TaggedError<LibraryCoverValidationFailed>()(
  "LibraryCoverValidationFailed",
  { message: Schema.String },
) {}
export class LibraryCoverConflict extends Schema.TaggedError<LibraryCoverConflict>()(
  "LibraryCoverConflict",
  {},
) {}
export interface CoverCandidate {
  readonly canonicalId: string;
  readonly serverId: string;
  readonly sourceLibraryId: string;
  readonly serverGeneration: number;
  readonly upstreamItemId: string;
  readonly imageTag: string | null;
}
export interface LibraryCoverRecord {
  readonly libraryId: string;
  readonly body: Uint8Array;
  readonly revision: string;
  readonly templateVersion: string;
  readonly configDigest: string;
  readonly width: 1920;
  readonly height: 1080;
  readonly updatedAtMs: number;
}
export type LibraryCoverStoredSummary = Omit<LibraryCoverRecord, "body">;
export interface LibraryCoverManifest {
  readonly token: string;
  readonly libraryId: string;
  readonly configDigest: string;
  readonly serverFences: ReadonlyArray<ServerEligibilityFence>;
  readonly candidates: ReadonlyArray<CoverCandidate>;
  readonly expectedRevision: string | null;
  readonly expiresAtMs: number;
}
export interface LibraryCoverRepositories {
  readonly getLibraryCover: (
    id: string,
  ) => Effect.Effect<LibraryCoverRecord | null, RepositoryError>;
  readonly listLibraryCoverSummaries: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<LibraryCoverStoredSummary>, RepositoryError>;
  readonly saveLibraryCoverManifest: (
    m: LibraryCoverManifest,
  ) => Effect.Effect<void, RepositoryError>;
  readonly getLibraryCoverManifest: (
    token: string,
  ) => Effect.Effect<LibraryCoverManifest | null, RepositoryError>;
  readonly commitLibraryCover: (input: {
    token: string;
    cover: LibraryCoverRecord;
    nowMs: number;
  }) => Effect.Effect<boolean, RepositoryError>;
  readonly listLibraryCoverCandidateIds: (
    id: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<string>, RepositoryError>;
}
export const libraryCoverConfigDigest = (l: VirtualLibrary): string =>
  JSON.stringify({
    name: l.name,
    mediaType: l.mediaType,
    enabled: l.enabled,
    sources: l.sources
      .map((s) => ({
        serverId: s.serverId,
        sourceLibraryId: s.sourceLibraryId,
        enabled: s.enabled,
        sourceOrder: s.sourceOrder,
      }))
      .sort(
        (a, b) =>
          a.sourceOrder - b.sourceOrder ||
          a.serverId.localeCompare(b.serverId) ||
          a.sourceLibraryId.localeCompare(b.sourceLibraryId),
      ),
  });
