import { Schema } from "effect"

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  operation: Schema.String,
  message: Schema.String
}) {}

export class AlreadyInitialized extends Schema.TaggedError<AlreadyInitialized>()("AlreadyInitialized", {}) {}

export class IdentityConflict extends Schema.TaggedError<IdentityConflict>()("IdentityConflict", {
  message: Schema.String
}) {}

export type ClaimError = AlreadyInitialized | RepositoryError
export type AuthError = RepositoryError
export type IdentityFailure = IdentityConflict | RepositoryError
