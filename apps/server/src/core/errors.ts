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

export class IdentityConflict extends Schema.TaggedError<IdentityConflict>()("IdentityConflict", {
  message: Schema.String
}) {}

export type ClaimError = AlreadyInitialized | RepositoryError
export type AuthError = AuthenticationChanged | RepositoryError
export type LoginError = AuthenticationChanged | InvalidCredentials | RateLimited | RepositoryError
export type IdentityFailure = IdentityConflict | RepositoryError
