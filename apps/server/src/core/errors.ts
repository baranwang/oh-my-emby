import { Schema } from "effect"

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  operation: Schema.String,
  message: Schema.String
}) {}

export class AlreadyInitialized extends Schema.TaggedError<AlreadyInitialized>()("AlreadyInitialized", {}) {}

export class AuthenticationChanged extends Schema.TaggedError<AuthenticationChanged>()(
  "AuthenticationChanged",
  {}
) {}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()("InvalidCredentials", {}) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {}) {}

export class UpstreamUnavailable extends Schema.TaggedError<UpstreamUnavailable>()("UpstreamUnavailable", {
  serverId: Schema.String
}) {}

export class UpstreamRejected extends Schema.TaggedError<UpstreamRejected>()("UpstreamRejected", {
  serverId: Schema.String,
  status: Schema.Int
}) {}

export class InvalidUpstreamUrl extends Schema.TaggedError<InvalidUpstreamUrl>()("InvalidUpstreamUrl", {}) {}

export class DestinationRejected extends Schema.TaggedError<DestinationRejected>()("DestinationRejected", {
  serverId: Schema.String
}) {}

export class RedirectLimitExceeded extends Schema.TaggedError<RedirectLimitExceeded>()(
  "RedirectLimitExceeded",
  { serverId: Schema.String }
) {}

export class RedirectLoop extends Schema.TaggedError<RedirectLoop>()("RedirectLoop", {
  serverId: Schema.String
}) {}

export class HttpsDowngrade extends Schema.TaggedError<HttpsDowngrade>()("HttpsDowngrade", {
  serverId: Schema.String
}) {}

export class ResponseTooLarge extends Schema.TaggedError<ResponseTooLarge>()("ResponseTooLarge", {
  serverId: Schema.String
}) {}

export class UpstreamTimeout extends Schema.TaggedError<UpstreamTimeout>()("UpstreamTimeout", {
  serverId: Schema.String
}) {}

export class UpstreamNotFound extends Schema.TaggedError<UpstreamNotFound>()("UpstreamNotFound", {
  serverId: Schema.String
}) {}

export class UpstreamInvalidResponse extends Schema.TaggedError<UpstreamInvalidResponse>()(
  "UpstreamInvalidResponse",
  { serverId: Schema.String }
) {}

export class ObsoleteGeneration extends Schema.TaggedError<ObsoleteGeneration>()("ObsoleteGeneration", {
  serverId: Schema.String
}) {}

export class CatalogIdentityMismatch extends Schema.TaggedError<CatalogIdentityMismatch>()(
  "CatalogIdentityMismatch",
  { serverId: Schema.String }
) {}

export class CatalogIdentityUnverifiable extends Schema.TaggedError<CatalogIdentityUnverifiable>()(
  "CatalogIdentityUnverifiable",
  { serverId: Schema.String }
) {}

export class ServerNotFound extends Schema.TaggedError<ServerNotFound>()("ServerNotFound", {
  serverId: Schema.String
}) {}

export class ServerLimitExceeded extends Schema.TaggedError<ServerLimitExceeded>()("ServerLimitExceeded", {}) {}

export class LibraryNotFound extends Schema.TaggedError<LibraryNotFound>()("LibraryNotFound", {
  libraryId: Schema.String
}) {}

export class LibraryValidationFailed extends Schema.TaggedError<LibraryValidationFailed>()(
  "LibraryValidationFailed",
  { field: Schema.String }
) {}

export class IdentityConflict extends Schema.TaggedError<IdentityConflict>()("IdentityConflict", {
  message: Schema.String
}) {}

export type ClaimError = AlreadyInitialized | RepositoryError
export type AuthError = AuthenticationChanged | RepositoryError
export type LoginError = AuthenticationChanged | InvalidCredentials | RateLimited | RepositoryError
export type IdentityFailure = IdentityConflict | RepositoryError
export type UpstreamFailure =
  | CatalogIdentityMismatch
  | CatalogIdentityUnverifiable
  | DestinationRejected
  | HttpsDowngrade
  | InvalidUpstreamUrl
  | ObsoleteGeneration
  | RedirectLimitExceeded
  | RedirectLoop
  | RepositoryError
  | ResponseTooLarge
  | ServerNotFound
  | UpstreamInvalidResponse
  | UpstreamNotFound
  | UpstreamRejected
  | UpstreamTimeout
  | UpstreamUnavailable
