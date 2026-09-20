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
  IdentityResolution,
  MaintenanceResult,
  OutboxAcknowledgement,
  OutboxClaim,
  OutboxUncertainty,
  PasswordReplacement,
  QueryGeneration,
  QueryGenerationAppend,
  SaveServerCommand,
  SaveServerResultCommand,
  SaveVirtualLibraryCommand,
  ServerEligibilityFence,
  SessionIssue,
  SessionRecord,
  StateWrite,
  TokenIssue,
  TokenLookup,
  TokenRecord,
  UpstreamServer,
  UserRecord,
  UserStateRecord,
  VirtualLibrary
} from "./model.js"

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
  readonly appendQueryGenerationItems: (input: QueryGenerationAppend) => Effect.Effect<void, RepositoryError>
  readonly writeUserStateAndTargets: (input: StateWrite) => Effect.Effect<UserStateRecord, RepositoryError>
  readonly claimOutboxTargets: (input: ClaimRequest) => Effect.Effect<ReadonlyArray<OutboxClaim>, RepositoryError>
  readonly acknowledgeOutboxTarget: (input: OutboxAcknowledgement) => Effect.Effect<boolean, RepositoryError>
  readonly markOutboxUncertain: (input: OutboxUncertainty) => Effect.Effect<void, RepositoryError>
  readonly runMaintenanceBatch: (nowMs: number) => Effect.Effect<MaintenanceResult, RepositoryError>
}

export class Repositories extends Context.Service<Repositories, RepositoriesService>()(
  "oh-my-emby/Repositories"
) {}
