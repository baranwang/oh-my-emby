import { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"
import { RequestId, ServerId } from "./schemas.js"

export const Unauthorized = Schema.TaggedStruct("Unauthorized", {}).pipe(HttpApiSchema.status(401))
export const ForbiddenOrigin = Schema.TaggedStruct("ForbiddenOrigin", {}).pipe(HttpApiSchema.status(403))
export const ValidationFailed = Schema.TaggedStruct("ValidationFailed", {
  fieldErrors: Schema.Array(Schema.Struct({
    field: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }))
}).pipe(HttpApiSchema.status(400))
export const NotFound = Schema.TaggedStruct("NotFound", {}).pipe(HttpApiSchema.status(404))
export const Conflict = Schema.TaggedStruct("Conflict", {
  code: Schema.NonEmptyString
}).pipe(HttpApiSchema.status(409))
export const UpstreamUnavailable = Schema.TaggedStruct("UpstreamUnavailable", {
  serverId: ServerId
}).pipe(HttpApiSchema.status(503))
export const UpstreamRejected = Schema.TaggedStruct("UpstreamRejected", {
  serverId: ServerId,
  status: Schema.Int
}).pipe(HttpApiSchema.status(502))
export const Timeout = Schema.TaggedStruct("Timeout", {}).pipe(HttpApiSchema.status(504))
export const MaterializationLimit = Schema.TaggedStruct("MaterializationLimit", {
  limit: Schema.Int
}).pipe(HttpApiSchema.status(422))
export const Internal = Schema.TaggedStruct("Internal", {
  requestId: RequestId
}).pipe(HttpApiSchema.status(500))

export const PublicErrors = [
  Unauthorized,
  ForbiddenOrigin,
  ValidationFailed,
  NotFound,
  Conflict,
  UpstreamUnavailable,
  UpstreamRejected,
  Timeout,
  MaterializationLimit,
  Internal
] as const
export const PublicError = Schema.Union(PublicErrors)
export type PublicError = typeof PublicError.Type
