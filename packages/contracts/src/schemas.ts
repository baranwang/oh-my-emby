import { Schema } from "effect"

const decodeUrl = Schema.decodeUnknownSync(Schema.URLFromString)

const isHttpUrl = (value: string): value is string => {
  try {
    const url = decodeUrl(value)
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      !value.includes("?") &&
      !value.includes("#")
  } catch {
    return false
  }
}

export const ServerId = Schema.NonEmptyString.pipe(Schema.brand("ServerId"))
export const SourceLibraryId = Schema.NonEmptyString.pipe(Schema.brand("SourceLibraryId"))
export const VirtualLibraryId = Schema.NonEmptyString.pipe(Schema.brand("VirtualLibraryId"))
export const RequestId = Schema.NonEmptyString.pipe(Schema.brand("RequestId"))
export const HttpUrl = Schema.NonEmptyString.pipe(
  Schema.refine(isHttpUrl, { expected: "an HTTP(S) URL" }),
  Schema.brand("HttpUrl")
)

export const SecretPatch = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Preserve") }),
  Schema.Struct({ _tag: Schema.Literal("Set"), value: Schema.NonEmptyString }),
  Schema.Struct({ _tag: Schema.Literal("Clear") })
])

export const BootstrapView = Schema.Struct({ initialized: Schema.Boolean })
export const SessionView = Schema.Struct({
  authenticated: Schema.Boolean,
  username: Schema.NullOr(Schema.NonEmptyString)
})
export const CredentialsInput = Schema.Struct({
  username: Schema.NonEmptyString,
  password: Schema.NonEmptyString
})
export const PasswordChangeInput = Schema.Struct({
  currentPassword: Schema.NonEmptyString,
  newPassword: Schema.NonEmptyString
})
export const ServerInput = Schema.Struct({
  name: Schema.NonEmptyString,
  baseUrl: HttpUrl,
  username: Schema.NonEmptyString,
  password: SecretPatch,
  userAgent: Schema.NonEmptyString,
  enabled: Schema.Boolean
})
export const ServerView = Schema.Struct({
  id: ServerId,
  name: Schema.NonEmptyString,
  baseUrl: HttpUrl,
  username: Schema.NonEmptyString,
  hasPassword: Schema.Boolean,
  userAgent: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  verifiedCatalogId: Schema.NullOr(Schema.NonEmptyString),
  generation: Schema.Int,
  health: Schema.Literals(["unknown", "healthy", "degraded"])
})
export const SourceLibraryView = Schema.Struct({
  id: SourceLibraryId,
  serverId: ServerId,
  name: Schema.NonEmptyString,
  mediaType: Schema.Literals(["movies", "series"])
})
export const SourceBindingInput = Schema.Struct({
  serverId: ServerId,
  sourceLibraryId: SourceLibraryId,
  enabled: Schema.Boolean
})
export const SourceBindingView = Schema.Struct({
  ...SourceBindingInput.fields,
  sourceLibraryName: Schema.NonEmptyString
})
export const VirtualLibraryInput = Schema.Struct({
  name: Schema.NonEmptyString,
  mediaType: Schema.Literals(["movies", "series"]),
  sources: Schema.Array(SourceBindingInput),
  enabled: Schema.Boolean
})
export const VirtualLibraryView = Schema.Struct({
  id: VirtualLibraryId,
  name: Schema.NonEmptyString,
  mediaType: Schema.Literals(["movies", "series"]),
  sources: Schema.Array(SourceBindingView),
  enabled: Schema.Boolean
})
export const ConnectionTestView = Schema.Struct({
  reachable: Schema.Boolean,
  catalogId: Schema.NullOr(Schema.NonEmptyString)
})
export const ServerHealthView = Schema.Struct({
  serverId: ServerId,
  health: Schema.Literals(["unknown", "healthy", "degraded"]),
  lastSuccessAtMs: Schema.NullOr(Schema.Int)
})
export const SystemStatusView = Schema.Struct({
  database: Schema.Literals(["healthy", "degraded"]),
  cacheEntries: Schema.Int,
  maintenanceLastRunAtMs: Schema.NullOr(Schema.Int),
  outboxPending: Schema.Int,
  outboxFailed: Schema.Int,
  outboxUncertain: Schema.Int,
  upstreamHealthy: Schema.Int,
  upstreamDegraded: Schema.Int,
  upstreamUnknown: Schema.Int
})
export const OutboxFailureView = Schema.Struct({
  serverId: ServerId,
  code: Schema.NonEmptyString,
  failedAtMs: Schema.Int,
  attemptCount: Schema.Int,
  nextAttemptAtMs: Schema.NullOr(Schema.Int),
  uncertainSinceMs: Schema.NullOr(Schema.Int)
})

export type BootstrapView = typeof BootstrapView.Type
export type SessionView = typeof SessionView.Type
export type PasswordChangeInput = typeof PasswordChangeInput.Type
export type SecretPatch = typeof SecretPatch.Type
export type ServerInput = typeof ServerInput.Type
export type ServerView = typeof ServerView.Type
export type ConnectionTestView = typeof ConnectionTestView.Type
export type ServerHealthView = typeof ServerHealthView.Type
export type SourceLibraryView = typeof SourceLibraryView.Type
export type SourceBindingInput = typeof SourceBindingInput.Type
export type VirtualLibraryInput = typeof VirtualLibraryInput.Type
export type VirtualLibraryView = typeof VirtualLibraryView.Type
export type SystemStatusView = typeof SystemStatusView.Type
export type OutboxFailureView = typeof OutboxFailureView.Type
