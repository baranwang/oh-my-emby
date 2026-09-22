import type { OutboxFailureView, SystemStatusView } from "@oh-my-emby/contracts"
import { Context, type Effect } from "effect"

import type { AuthError, ClaimError, IdentityFailure, RepositoryError } from "./errors.js"
import type { PreparedIdentityCandidate } from "./identity.js"
import type {
  CanonicalItem,
  ClaimRequest,
  ClaimUserInput,
  AuthAttempt,
  AuthenticatedTokenRecord,
  DashboardSessionLookup,
  DashboardSessionRecord,
  EligibleSource,
  ExternalMetadataCacheEntry,
  IdentityClaim,
  IdentityResolution,
  JsonValue,
  MaintenanceResult,
  MetadataProviderSetting,
  OutboxAcknowledgement,
  OutboxClaim,
  OutboxDispatch,
  OutboxFailureUpdate,
  OutboxUncertainty,
  PasswordReplacement,
  PlaybackEvent,
  QueryGeneration,
  QueryGenerationAppend,
  QueryGenerationItem,
  SaveServerCommand,
  SaveServerResultCommand,
  SaveVirtualLibraryCommand,
  ServerEligibilityFence,
  SessionIssue,
  SessionRecord,
  StateWrite,
  SourceItemRecord,
  SourceMediaVersion,
  TokenIssue,
  TokenLookup,
  TokenRecord,
  UpstreamServer,
  UserRecord,
  UserStateRecord,
  VirtualLibrary
} from "./model.js"

export interface MetadataProjection {
  readonly sourceItemId: string
  readonly projectionKey: string
  readonly payload: JsonValue
  readonly freshUntilMs: number
  readonly staleUntilMs: number
  readonly updatedAtMs: number
}

export interface DetailProjectionSuppression {
  readonly canonicalId: string
  readonly serverId: string
  readonly serverGeneration: number
  readonly sourceLibraryId: string
  readonly observedAtMs: number
}

export interface CatalogItemRecord {
  readonly canonical: CanonicalItem
  readonly claims: ReadonlyArray<IdentityClaim>
  readonly sourceItems: ReadonlyArray<SourceItemRecord>
  readonly mediaVersions: ReadonlyArray<SourceMediaVersion>
  readonly userState: UserStateRecord | null
}

export interface StateMembershipLookup {
  readonly virtualLibraryId: string
  readonly favorite?: boolean
  readonly resume?: boolean
  readonly played?: boolean
  readonly limit: number
}

export interface RepositoriesService {
  readonly claimUser: (input: ClaimUserInput) => Effect.Effect<UserRecord, ClaimError>
  readonly getUser: () => Effect.Effect<UserRecord | null, RepositoryError>
  readonly getUserByName: (username: string) => Effect.Effect<UserRecord | null, RepositoryError>
  readonly issueDashboardSession: (input: SessionIssue) => Effect.Effect<SessionRecord, AuthError>
  readonly issueEmbyToken: (input: TokenIssue) => Effect.Effect<TokenRecord, AuthError>
  readonly lookupDashboardSession: (
    input: DashboardSessionLookup
  ) => Effect.Effect<DashboardSessionRecord | null, RepositoryError>
  readonly lookupEmbyToken: (
    input: TokenLookup
  ) => Effect.Effect<AuthenticatedTokenRecord | null, RepositoryError>
  readonly deleteDashboardSession: (
    id: string,
    authGeneration: number
  ) => Effect.Effect<void, RepositoryError>
  readonly consumeAuthAttempt: (input: AuthAttempt) => Effect.Effect<boolean, RepositoryError>
  readonly clearAuthAttempts: (scopeKey: string) => Effect.Effect<void, RepositoryError>
  readonly revokeAuthentication: (input: PasswordReplacement) => Effect.Effect<void, AuthError>
  readonly listServers: () => Effect.Effect<ReadonlyArray<UpstreamServer>, RepositoryError>
  readonly getServer: (id: string) => Effect.Effect<UpstreamServer | null, RepositoryError>
  readonly createServer: (
    input: SaveServerCommand,
    limit: number
  ) => Effect.Effect<UpstreamServer | null, RepositoryError>
  readonly saveServer: (input: SaveServerCommand) => Effect.Effect<UpstreamServer, RepositoryError>
  readonly saveServerConfiguration: (
    input: SaveServerCommand,
    expectedGeneration: number
  ) => Effect.Effect<UpstreamServer | null, RepositoryError>
  readonly saveServerResult: (
    input: SaveServerResultCommand
  ) => Effect.Effect<UpstreamServer | null, RepositoryError>
  readonly deleteServer: (id: string) => Effect.Effect<void, RepositoryError>
  readonly readMetadataSettings: () => Effect.Effect<
    readonly [MetadataProviderSetting, MetadataProviderSetting],
    RepositoryError
  >
  readonly writeMetadataSettings: (
    settings: readonly [MetadataProviderSetting, MetadataProviderSetting]
  ) => Effect.Effect<readonly [MetadataProviderSetting, MetadataProviderSetting], RepositoryError>
  readonly readExternalMetadata: (
    providerId: ExternalMetadataCacheEntry["providerId"],
    identityNamespace: string,
    identityValue: string
  ) => Effect.Effect<ExternalMetadataCacheEntry | null, RepositoryError>
  readonly writeExternalMetadata: (
    entry: ExternalMetadataCacheEntry
  ) => Effect.Effect<void, RepositoryError>
  readonly listVirtualLibraries: () => Effect.Effect<ReadonlyArray<VirtualLibrary>, RepositoryError>
  readonly saveVirtualLibrary: (
    input: SaveVirtualLibraryCommand,
    serverFences: ReadonlyArray<ServerEligibilityFence>
  ) => Effect.Effect<VirtualLibrary | null, RepositoryError>
  readonly deleteVirtualLibrary: (id: string) => Effect.Effect<void, RepositoryError>
  readonly isSourceEligible: (
    serverId: string,
    sourceLibraryId: string
  ) => Effect.Effect<boolean, RepositoryError>
  readonly resolveEligibleSources: (libraryId: string) => Effect.Effect<ReadonlyArray<EligibleSource>, RepositoryError>
  /**
   * One identity transaction must lock/read every cluster matched by the candidate's typed claims,
   * validate complete-cluster compatibility, persist claims and the source mapping, and recheck the
   * server generation immediately before commit. Compatible consolidation keeps the oldest canonical,
   * retains retired IDs as resolvable aliases, moves every compatible source mapping and dependent
   * canonical reference, and preserves the highest user-state revision. Ambiguous or late-conflicting
   * input is quarantined without splitting an issued canonical or moving its existing state.
   */
  readonly resolveIdentity: (candidate: PreparedIdentityCandidate) => Effect.Effect<IdentityResolution, IdentityFailure>
  /** Resolves an active canonical ID or any permanent retired alias to its active canonical ID. */
  readonly lookupCanonicalId: (id: string) => Effect.Effect<string | null, RepositoryError>
  readonly persistIdentityResult: (result: IdentityResolution) => Effect.Effect<CanonicalItem, IdentityFailure>
  readonly readQueryGeneration: (key: string) => Effect.Effect<QueryGeneration | null, RepositoryError>
  readonly readQueryGenerationItems: (
    generationId: string
  ) => Effect.Effect<ReadonlyArray<QueryGenerationItem>, RepositoryError>
  /** Atomically publishes one bounded item chunk and its matching state when the generation CAS wins. */
  readonly appendQueryGenerationItems: (input: QueryGenerationAppend) => Effect.Effect<boolean, RepositoryError>
  readonly readMetadataProjection: (
    sourceItemId: string,
    projectionKey: string
  ) => Effect.Effect<MetadataProjection | null, RepositoryError>
  readonly writeMetadataProjection: (
    input: MetadataProjection
  ) => Effect.Effect<void, RepositoryError>
  readonly suppressDetailProjections: (
    input: DetailProjectionSuppression
  ) => Effect.Effect<void, RepositoryError>
  readonly mergeCanonicalMetadata: (
    canonicalId: string,
    sourceItemId: string,
    metadata: JsonValue,
    updatedAtMs: number
  ) => Effect.Effect<void, RepositoryError>
  readonly readCatalogItems: (
    canonicalIds: ReadonlyArray<string>,
    usableAtMs?: number
  ) => Effect.Effect<ReadonlyArray<CatalogItemRecord>, RepositoryError>
  readonly resolveEligibleSourcesForCanonical: (
    canonicalId: string
  ) => Effect.Effect<ReadonlyArray<EligibleSource>, RepositoryError>
  readonly listStateMemberCanonicalIds: (
    input: StateMembershipLookup
  ) => Effect.Effect<ReadonlyArray<string>, RepositoryError>
  /** Called by the local-state service after a relevant state write commits. */
  readonly invalidateStateDependentQueryGenerations: () => Effect.Effect<void, RepositoryError>
  readonly writeUserStateAndTargets: (input: StateWrite) => Effect.Effect<UserStateRecord, RepositoryError>
  readonly recordPlaybackEventAndTargets: (
    input: PlaybackEvent
  ) => Effect.Effect<UserStateRecord | null, RepositoryError>
  readonly claimOutboxTargets: (input: ClaimRequest) => Effect.Effect<ReadonlyArray<OutboxClaim>, RepositoryError>
  readonly markOutboxDispatched: (input: OutboxDispatch) => Effect.Effect<boolean, RepositoryError>
  readonly acknowledgeOutboxTarget: (input: OutboxAcknowledgement) => Effect.Effect<boolean, RepositoryError>
  readonly markOutboxUncertain: (input: OutboxUncertainty) => Effect.Effect<void, RepositoryError>
  readonly recordOutboxFailure: (input: OutboxFailureUpdate) => Effect.Effect<boolean, RepositoryError>
  readonly runMaintenanceBatch: (nowMs: number) => Effect.Effect<MaintenanceResult, RepositoryError>
  readonly readSystemStatus: () => Effect.Effect<SystemStatusView, RepositoryError>
  readonly listOutboxFailures: () => Effect.Effect<ReadonlyArray<OutboxFailureView>, RepositoryError>
}

export class Repositories extends Context.Service<Repositories, RepositoriesService>()(
  "oh-my-emby/Repositories"
) {}
