import type { ServerView, SourceLibraryView, VirtualLibraryView } from "@oh-my-emby/contracts"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export interface PasswordRecord {
  readonly hash: Uint8Array
  readonly salt: Uint8Array
  readonly iterations: number
}

export interface ClaimUserInput {
  readonly username: string
  readonly password: PasswordRecord
  readonly nowMs?: number
}

export interface UserRecord {
  readonly username: string
  readonly password: PasswordRecord
  readonly authGeneration: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface SessionIssue {
  readonly id: string
  readonly tokenHash: Uint8Array
  readonly expectedAuthGeneration: number
  readonly createdAtMs: number
  readonly lastSeenAtMs: number
  readonly expiresAtMs: number
}

export interface SessionRecord extends Omit<SessionIssue, "expectedAuthGeneration"> {
  readonly authGeneration: number
}

export interface DashboardSessionLookup {
  readonly tokenHash: Uint8Array
  readonly nowMs: number
  readonly idleMs: number
  readonly refreshAfterMs: number
}

export interface DashboardSessionRecord extends SessionRecord {
  readonly username: string
}

export interface TokenIssue {
  readonly id: string
  readonly tokenHash: Uint8Array
  readonly expectedAuthGeneration: number
  readonly deviceId: string
  readonly deviceName: string
  readonly createdAtMs: number
  readonly lastUsedAtMs: number
  readonly expiresAtMs: number
}

export interface TokenRecord extends Omit<TokenIssue, "expectedAuthGeneration"> {
  readonly authGeneration: number
}

export interface TokenLookup {
  readonly tokenHash: Uint8Array
  readonly nowMs: number
}

export interface AuthenticatedTokenRecord extends TokenRecord {
  readonly username: string
}

export interface PasswordReplacement {
  readonly password: PasswordRecord
  readonly expectedAuthGeneration: number
  readonly updatedAtMs: number
}

export interface AuthAttempt {
  readonly scopeKey: string
  readonly nowMs: number
  readonly windowMs: number
  readonly maxAttempts: number
  readonly blockMs: number
}

export type ServerHealth = ServerView["health"]

export interface UpstreamServer extends Omit<ServerView, "hasPassword"> {
  readonly catalogNamespace: string
  readonly verifiedBaseUrl: string | null
  readonly password: string | null
  readonly accessToken: string | null
  readonly accessTokenExpiresAtMs: number | null
  readonly upstreamUserId: string | null
  readonly lastSuccessAtMs: number | null
  readonly deletedAtMs: number | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export type SaveServerCommand = UpstreamServer

export interface ServerEligibilityFence {
  readonly serverId: UpstreamServer["id"]
  readonly generation: number
}

export interface SaveServerResultCommand {
  readonly serverId: string
  readonly expectedGeneration: number
  readonly accessToken?: string | null
  readonly accessTokenExpiresAtMs?: number | null
  readonly upstreamUserId?: string | null
  readonly verifiedCatalogId?: string | null
  readonly verifiedBaseUrl?: string | null
  readonly health?: ServerHealth
  readonly lastSuccessAtMs?: number | null
  readonly updatedAtMs: number
}
export type MediaType = SourceLibraryView["mediaType"]
type ContractLibrarySource = VirtualLibraryView["sources"][number]

export interface LibrarySource extends ContractLibrarySource {
  readonly mediaType: MediaType
  readonly sourceOrder: number
}

export interface VirtualLibrary extends Omit<VirtualLibraryView, "sources"> {
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly sources: ReadonlyArray<LibrarySource>
}

export type SaveVirtualLibraryCommand = VirtualLibrary

export interface EligibleSource extends LibrarySource, Pick<ServerView, "baseUrl" | "username" | "userAgent"> {
  readonly virtualLibraryId: VirtualLibraryView["id"]
  readonly catalogNamespace: string
  readonly verifiedCatalogId: NonNullable<ServerView["verifiedCatalogId"]>
  readonly serverGeneration: ServerView["generation"]
  readonly password: string | null
  readonly accessToken: string | null
  readonly accessTokenExpiresAtMs: number | null
}

export interface CanonicalItem {
  readonly id: string
  readonly itemType: string
  readonly identityState: string
  readonly displayMetadata: JsonValue
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export type CanonicalFixture = CanonicalItem

export interface CanonicalAlias {
  readonly aliasId: string
  readonly canonicalId: string
  readonly retiredAtMs: number
}

export interface IdentityClaim {
  readonly namespace: string
  readonly value: string
  readonly state: string
  readonly sourceItemId: string
  readonly createdAtMs: number
}

export interface SourceItemRecord {
  readonly id: string
  readonly serverId: string
  readonly catalogNamespace: string
  readonly serverGeneration: number
  readonly sourceLibraryId: string
  readonly upstreamItemId: string
  readonly itemType: string
  readonly canonicalId: string | null
  readonly quarantineReason: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface SourceMediaVersion {
  readonly id: string
  readonly sourceItemId: string
  readonly serverGeneration: number
  readonly upstreamMediaSourceId: string
  readonly label: string
  readonly capabilities: JsonValue
  readonly streams: JsonValue
  readonly updatedAtMs: number
}

export interface IdentityResolution {
  readonly canonical: CanonicalItem
  readonly aliases: ReadonlyArray<CanonicalAlias>
  readonly claims: ReadonlyArray<IdentityClaim>
  readonly sourceItem: SourceItemRecord
  readonly mediaVersions: ReadonlyArray<SourceMediaVersion>
}

export interface QueryGeneration {
  readonly id: string
  readonly queryKey: string
  readonly revision: number
  readonly userKey: string
  readonly deviceId: string
  readonly virtualLibraryId: string
  readonly normalizedQuery: JsonValue
  readonly sourceState: JsonValue
  readonly allSourcesExhausted: boolean
  readonly stateDependent: boolean
  readonly createdAtMs: number
  readonly expiresAtMs: number
}

export interface QueryGenerationItem {
  readonly ordinal: number
  readonly canonicalId: string
  readonly sortValues: JsonValue
}

export interface QueryGenerationAppend {
  readonly generation: QueryGeneration
  readonly items: ReadonlyArray<QueryGenerationItem>
  readonly expected: {
    readonly id: string
    readonly revision: number
  } | null
}

export interface DesiredUserState {
  readonly played: boolean
  readonly favorite: boolean
  readonly playCount: number
  readonly positionTicks: number
  readonly lastPlayedVersionId: string | null
}

export interface UserStatePatch {
  readonly played?: boolean
  readonly favorite?: boolean
  readonly playCount?: number
  readonly positionTicks?: number
  readonly lastPlayedVersionId?: string | null
}

export interface StateWrite {
  readonly canonicalId: string
  readonly patch: UserStatePatch
  readonly updatedAtMs: number
}

export interface UserStateRecord extends DesiredUserState {
  readonly canonicalId: string
  readonly revision: number
  readonly updatedAtMs: number
}

interface PlaybackEventBase {
  readonly localSessionId: string
  readonly canonicalId: string
  readonly versionId: string
  readonly positionTicks: number
  readonly occurredAtMs: number
}

export type PlaybackEvent = PlaybackEventBase & (
  | { readonly kind: "start" | "progress"; readonly played?: never }
  | { readonly kind: "stop"; readonly played: boolean }
)

export interface ClaimRequest {
  readonly nowMs: number
  readonly leaseOwner: string
}

export interface OutboxClaim {
  readonly targetId: string
  readonly canonicalId: string
  readonly sourceItemId: string
  readonly upstreamItemId: string
  readonly upstreamUserId: string
  readonly serverId: string
  readonly serverGeneration: number
  readonly desiredRevision: number
  readonly payload: DesiredUserState
  readonly attemptCount: number
  readonly leaseOwner: string
  readonly leaseExpiresAtMs: number
}

export interface OutboxAcknowledgement {
  readonly targetId: string
  readonly desiredRevision: number
  readonly serverGeneration: number
  readonly leaseOwner: string
  readonly acknowledgedAtMs: number
}

export interface OutboxUncertainty {
  readonly targetId: string
  readonly desiredRevision: number
  readonly code: string
  readonly uncertainAtMs: number
  readonly nextAttemptAtMs: number
}

export interface OutboxDispatch {
  readonly targetId: string
  readonly desiredRevision: number
  readonly serverGeneration: number
  readonly leaseOwner: string
  readonly dispatchedAtMs: number
}

export interface OutboxFailureUpdate {
  readonly targetId: string
  readonly desiredRevision: number
  readonly serverGeneration: number
  readonly leaseOwner: string
  readonly code: string
  readonly failedAtMs: number
  readonly nextAttemptAtMs: number
  readonly permanent: boolean
}

export interface MaintenanceResult {
  readonly expiredDashboardSessions: number
  readonly expiredEmbyTokens: number
  readonly expiredRateLimits: number
  readonly expiredPlaybackSessions: number
  readonly expiredQueryGenerations: number
  readonly expiredMetadataCacheRows: number
  readonly releasedOutboxLeases: number
  readonly cancelledOutboxTargets: number
  readonly createdOutboxTargets: number
}
